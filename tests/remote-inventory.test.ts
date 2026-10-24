import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { LocalPathPolicy } from "../src/local/path-policy";
import { MAX_DAV_XML_DEPTH, MAX_DAV_XML_ELEMENTS, parseDavMultistatus } from "../src/remote/dav-xml";
import { NextcloudDavClient } from "../src/remote/dav-client";
import { appendWebdavPath, normalizeRemoteRootPath, relativePathFromDavHref } from "../src/remote/path";
import { RemoteInventoryScanner } from "../src/remote/scanner";
import { RemoteInventoryReconciler } from "../src/remote/reconciler";
import { DurableStateStore } from "../src/state/durable/store";
import { randomId } from "../src/state/durable/ids";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const XML = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
 <d:response><d:href>/remote.php/dav/files/alice/Obsidian/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><oc:fileid>10</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
 <d:response><d:href>/remote.php/dav/files/alice/Obsidian/Notes/Hello%20World.md</d:href><d:propstat><d:prop><d:getetag>&quot;etag1&quot;</d:getetag><d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Wed, 20 Jul 2022 05:12:23 GMT</d:getlastmodified><d:getcontenttype>text/markdown</d:getcontenttype><d:resourcetype/><oc:fileid>42</oc:fileid><oc:checksums><oc:checksum>SHA256:${"a".repeat(64)}</oc:checksum></oc:checksums></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

describe("Remote inventory DAV parsing and paths", () => {
  it("parses namespace-prefixed multistatus properties", () => {
    const parsed = parseDavMultistatus(XML);
    expect(parsed.length).toBe(2);
    expect(parsed[0]?.isCollection).toBe(true);
    expect(parsed[1]?.fileId).toBe("42");
    expect(parsed[1]?.size).toBe(12);
    expect(parsed[1]?.checksums[0]).toMatch(/^SHA256:/);
  });

  it("rejects DTD/entity declarations", () => {
    expect(() => parseDavMultistatus(`<!DOCTYPE x [<!ENTITY boom "x">]><d:multistatus xmlns:d="DAV:"/>`)).toThrow(/forbidden/i);
  });

  it("rejects excessive XML nesting and element counts before building the DAV tree", () => {
    const nested = `${"<x>".repeat(MAX_DAV_XML_DEPTH + 1)}${"</x>".repeat(MAX_DAV_XML_DEPTH + 1)}`;
    expect(() => parseDavMultistatus(nested)).toThrow(/nesting safety limit/i);
    const elements = `<x>${"<y/>".repeat(MAX_DAV_XML_ELEMENTS)}</x>`;
    expect(() => parseDavMultistatus(elements)).toThrow(/element safety limit/i);
  });

  it("keeps DAV hrefs inside the configured root and decodes path segments", () => {
    const root = "https://cloud.example/remote.php/dav/files/alice/Obsidian/";
    expect(relativePathFromDavHref(root, "/remote.php/dav/files/alice/Obsidian/Notes/Hello%20World.md")).toBe("Notes/Hello World.md");
    expect(() => relativePathFromDavHref(root, "/remote.php/dav/files/alice/Other/file.md")).toThrow(/outside/i);
    expect(() => relativePathFromDavHref(root, "https://user@cloud.example/remote.php/dav/files/alice/Obsidian/file.md")).toThrow(/credentials/i);
    expect(() => relativePathFromDavHref(root, "/remote.php/dav/files/alice/Obsidian/file.md?token=x")).toThrow(/query/i);
    expect(() => relativePathFromDavHref(root, "/remote.php/dav/files/alice/Obsidian/%2e%2e/secret.md")).toThrow(/unsafe path segment/i);
    expect(() => relativePathFromDavHref(root, "/remote.php/dav/files/alice/Obsidian/encoded%2fslash.md")).toThrow(/unsafe path segment/i);
    expect(relativePathFromDavHref(root, "/remote.php/dav/files/alice/Obsidian/%252e%252e/literal.md")).toBe("%2e%2e/literal.md");
    expect(() => relativePathFromDavHref(root, "/remote.php/dav/files/alice/Obsidian/bad%zz.md")).toThrow(/invalid percent encoding/i);
  });

  it("encodes each configured remote path segment independently", () => {
    expect(normalizeRemoteRootPath(" /Notes/My Vault/ ")).toBe("Notes/My Vault");
    expect(appendWebdavPath("https://cloud.example/remote.php/dav/files/alice/", "Notes/My Vault")).toContain("Notes/My%20Vault");
  });
});

describe("Remote inventory remote reconciliation", () => {
  it("never traverses nested device-local Obsidian and Nyra runtime directories", async () => {
    const userRoot = "https://nested-scope.example/remote.php/dav/files/alice/";
    const scanRoot = `${userRoot}Obsidian/`;
    const requests: string[] = [];
    const client = {
      async listDirectory(url: string) {
        requests.push(url);
        const suffix = new URL(url).pathname.slice(new URL(scanRoot).pathname.length).replace(/\/$/, "");
        if (!suffix) return [collection(scanRoot), collection(`${scanRoot}Nyra/`)];
        if (suffix === "Nyra") return [
          collection(`${scanRoot}Nyra/`),
          collection(`${scanRoot}Nyra/.obsidian/`),
          file(`${scanRoot}Nyra/Note.md`, "nested-note")
        ];
        throw new Error(`Unexpected traversal into excluded path: ${suffix}`);
      }
    };
    const policy = new LocalPathPolicy({
      reservedRoots: [".trash", ".obsidian/plugins/nyra-nextcloud-sync"],
      reservedFiles: [".obsidian/workspace.json", ".obsidian/workspace-mobile.json"],
      configDir: ".obsidian",
      syncObsidianConfig: () => false
    });
    const result = await new RemoteInventoryScanner(client as never, userRoot, logger, { pathPolicy: policy }).scanFull("Obsidian");
    expect(result.complete).toBe(true);
    expect(result.entries.map((entry) => entry.path)).toEqual(["Nyra/Note.md"]);
    expect(requests.some((url) => new URL(url).pathname.includes(".obsidian"))).toBe(false);
  });

  it("skips remote files above the device limit, keeps the scan authoritative and reports them as folder occupants", async () => {
    const userRoot = "https://oversize.example/remote.php/dav/files/alice/";
    const scanRoot = `${userRoot}Obsidian/`;
    const client = {
      async listDirectory() {
        return [
          collection(scanRoot),
          { ...file(`${scanRoot}Big.mov`, "7"), size: 500 },
          { ...file(`${scanRoot}Small.md`, "8"), size: 4 }
        ];
      }
    };
    const policy = new LocalPathPolicy();
    const result = await new RemoteInventoryScanner(client as never, userRoot, logger, { pathPolicy: policy, maxFileBytes: 100 }).scanFull("Obsidian");
    expect(result.trust).toBe("authoritative");
    expect(result.entries.map((entry) => entry.path)).toEqual(["Small.md"]);
    expect(result.oversized).toEqual(["Big.mov"]);
    expect(policy.isIncluded("Big.mov")).toBe(false);
    expect(policy.isInScope("Big.mov")).toBe(true);
  });

  it("reports a missing scan root as its own issue so a first connection can create it", async () => {
    const { NyraError } = await import("../src/core/errors");
    const client = { async listDirectory(): Promise<never> { throw new NyraError("webdav-not-found", "The configured remote folder does not exist."); } };
    const result = await new RemoteInventoryScanner(client as never, "https://missing.example/remote.php/dav/files/alice/", logger).scanFull("Obsidian/New");
    expect(result.trust).toBe("incomplete");
    expect(result.issues.map((issue) => issue.code)).toEqual(["root-missing"]);
  });

  it("uses Nextcloud fileId as exact rename identity", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const entryId = randomId("entry");
    await store.transact("seed-remote", (tx) => tx.putFile({
      entryId,
      path: "Old.md",
      baseline: null,
      local: null,
      remote: { path: "Old.md", contentHash: null, reportedSha256: null, etag: '"old"', fileId: "99", size: 1, mtimeMs: 1 },
      status: "remote-dirty"
    }));

    const reconciler = new RemoteInventoryReconciler(store);
    const stats = await reconciler.applyFullScan({
      kind: "full",
      rootPath: "Obsidian",
      trust: "authoritative",
      complete: true,
      issues: [],
      directories: [], oversized: [], rootEtag: null, directoriesVisited: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      entries: [{ path: "New.md", fileId: "99", etag: '"new"', size: 2, mtimeMs: 2, contentType: "text/markdown", sha256Hint: null, checksums: [] }]
    });

    expect(stats.renamed).toBe(1);
    expect(store.getState().files[entryId]?.path).toBe("New.md");
    expect(store.getState().remotePathIndex["New.md"]).toBe(entryId);
  });



  it("rebinds a proven same-path fileId replacement without splitting the logical record", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const blob = await store.putTextBlob("base");
    const entryId = randomId("entry");
    await store.transact("seed-replacement", (tx) => tx.putFile({
      entryId, path: "Stable.md",
      baseline: { blobHash: blob.hash, size: blob.size, createdAt: new Date().toISOString(), path: "Stable.md", remoteFileId: "old-id", remoteEtag: '"old-etag"' },
      local: { path: "Stable.md", contentHash: blob.hash, size: blob.size, mtimeMs: 1 },
      remote: { path: "Stable.md", contentHash: blob.hash, reportedSha256: null, etag: '"old-etag"', fileId: "old-id", size: blob.size, mtimeMs: 1 },
      status: "clean"
    }));

    const reconciler = new RemoteInventoryReconciler(store);
    const stats = await reconciler.applyFullScan({
      kind: "full", rootPath: "Obsidian", trust: "authoritative", complete: true, issues: [], directories: [], oversized: [], rootEtag: null, directoriesVisited: 1, startedAt: "x", finishedAt: "y",
      entries: [{ path: "Stable.md", fileId: "new-id", etag: '"new-etag"', size: blob.size, mtimeMs: 2, contentType: "text/markdown", sha256Hint: null, checksums: [] }]
    });

    const state = store.getState();
    expect(stats.identityReplacements).toBe(1);
    expect(Object.keys(state.files).length).toBe(1);
    expect(state.files[entryId]?.remote?.fileId).toBe("new-id");
    expect(state.files[entryId]?.remote?.contentHash).toBeNull();
    expect(state.files[entryId]?.baseline?.remoteFileId).toBe("old-id");
  });

  it("does not conflate rename-old plus create-new-at-old-path", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const entryId = randomId("entry");
    await store.transact("seed-rename-create", (tx) => tx.putFile({
      entryId, path: "Old.md", baseline: null, local: { path: "Old.md", contentHash: "a".repeat(64), size: 1, mtimeMs: 1 },
      remote: { path: "Old.md", contentHash: null, reportedSha256: null, etag: '"old"', fileId: "old-id", size: 1, mtimeMs: 1 }, status: "both-dirty"
    }));
    const reconciler = new RemoteInventoryReconciler(store);
    await reconciler.applyFullScan({
      kind: "full", rootPath: "Obsidian", trust: "authoritative", complete: true, issues: [], directories: [], oversized: [], rootEtag: null, directoriesVisited: 1, startedAt: "x", finishedAt: "y",
      entries: [
        { path: "Renamed.md", fileId: "old-id", etag: '"renamed"', size: 1, mtimeMs: 2, contentType: null, sha256Hint: null, checksums: [] },
        { path: "Old.md", fileId: "new-id", etag: '"new"', size: 1, mtimeMs: 2, contentType: null, sha256Hint: null, checksums: [] }
      ]
    });
    const state = store.getState();
    expect(Object.keys(state.files).length).toBe(2);
    expect(state.files[entryId]?.remote?.path).toBe("Renamed.md");
    expect(state.remoteFileIdIndex["old-id"]).toBe(entryId);
    expect(state.remoteFileIdIndex["new-id"] === entryId).toBe(false);
  });

  it("preserves a trusted remote hash only across an unchanged fileId+ETag+size observation", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const entryId = randomId("entry");
    const hash = "b".repeat(64);
    await store.transact("seed-trusted-hash", (tx) => tx.putFile({
      entryId, path: "Verified.bin", baseline: null, local: null,
      remote: { path: "Verified.bin", contentHash: hash, reportedSha256: null, etag: '"stable"', fileId: "id-1", size: 9, mtimeMs: 1 }, status: "remote-dirty"
    }));
    const reconciler = new RemoteInventoryReconciler(store);
    const baseScan = { kind: "full" as const, rootPath: "Obsidian", trust: "authoritative" as const, complete: true as const, issues: [] as [], directories: [], oversized: [], rootEtag: null, directoriesVisited: 1, startedAt: "x", finishedAt: "y" };
    await reconciler.applyFullScan({ ...baseScan, entries: [{ path: "Verified.bin", fileId: "id-1", etag: '"stable"', size: 9, mtimeMs: 2, contentType: null, sha256Hint: "c".repeat(64), checksums: [] }] });
    expect(store.getState().files[entryId]?.remote?.contentHash).toBe(hash);
    await reconciler.applyFullScan({ ...baseScan, entries: [{ path: "Verified.bin", fileId: "id-1", etag: '"changed"', size: 9, mtimeMs: 3, contentType: null, sha256Hint: hash, checksums: [] }] });
    expect(store.getState().files[entryId]?.remote?.contentHash).toBeNull();
  });

  it("does not infer remote deletions from an incomplete scan", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const entryId = randomId("entry");
    await store.transact("seed-remote", (tx) => tx.putFile({
      entryId,
      path: "Keep.md",
      baseline: null,
      local: null,
      remote: { path: "Keep.md", contentHash: null, reportedSha256: null, etag: '"x"', fileId: "123", size: 5, mtimeMs: 1 },
      status: "remote-dirty"
    }));

    const reconciler = new RemoteInventoryReconciler(store);
    await reconciler.applyFullScan({ kind: "full", rootPath: "Obsidian", entries: [], trust: "incomplete", complete: false, issues: [{ path: "", code: "request-failed", message: "offline" }], directories: [], oversized: [], rootEtag: null, directoriesVisited: 0, startedAt: "x", finishedAt: "y" });
    expect(store.getState().files[entryId]?.remote?.fileId).toBe("123");
  });

  it("applies matched positive facts from an incomplete scan but defers creations and absence", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const knownId = randomId("entry");
    const missingId = randomId("entry");
    await store.transact("seed-partial-remote-observations", (tx) => {
      tx.putFile({
        entryId: knownId, path: "Known.md", baseline: null, local: null,
        remote: { path: "Known.md", contentHash: null, reportedSha256: null, etag: '"old"', fileId: "known-file", size: 4, mtimeMs: 1 },
        status: "remote-dirty"
      });
      tx.putFile({
        entryId: missingId, path: "NotObserved.md", baseline: null, local: null,
        remote: { path: "NotObserved.md", contentHash: null, reportedSha256: null, etag: '"stable"', fileId: "missing-file", size: 4, mtimeMs: 1 },
        status: "remote-dirty"
      });
    });

    const reconciler = new RemoteInventoryReconciler(store);
    const stats = await reconciler.applyFullScan({
      kind: "full", rootPath: "Obsidian", trust: "incomplete", complete: false,
      issues: [{ path: "Folder", code: "request-failed", message: "partial inventory" }],
      directories: [], oversized: [], rootEtag: null, directoriesVisited: 1, startedAt: "x", finishedAt: "y",
      entries: [
        { path: "Known.md", fileId: "known-file", etag: '"new"', size: 5, mtimeMs: 2, contentType: null, sha256Hint: null, checksums: [] },
        { path: "New.md", fileId: "new-file", etag: '"created"', size: 3, mtimeMs: 2, contentType: null, sha256Hint: null, checksums: [] }
      ]
    });

    const state = store.getState();
    expect(stats.updated).toBe(1);
    expect(stats.deferredCreates).toBe(1);
    expect(stats.pendingDeletes).toBe(0);
    expect(state.files[knownId]?.remote).toMatchObject({ etag: '"new"', size: 5 });
    expect(state.files[missingId]?.remote?.fileId).toBe("missing-file");
    expect(state.remotePathIndex["New.md"]).toBe(undefined);
  });

  it("collects request/byte/parse/concurrency metrics and visits duplicate folder hints once", async () => {
    const server = "https://metrics.example";
    const userRoot = `${server}/remote.php/dav/files/alice/`;
    const scanRoot = `${userRoot}Obsidian/`;
    const folderCount = 300;
    let requestCount = 0;
    const client = {
      async listDirectory(url: string) { return (await this.listDirectoryMeasured(url)).responses; },
      async listDirectoryMeasured(url: string) {
        requestCount += 1;
        const relative = decodeURIComponent(new URL(url).pathname.slice(new URL(scanRoot).pathname.length)).replace(/\/$/, "");
        const rows = relative
          ? [collection(`${scanRoot}${relative}/`), file(`${scanRoot}${relative}/Note.md`, `${requestCount}`)]
          : [collection(scanRoot), ...Array.from({ length: folderCount }, (_, index) => collection(`${scanRoot}Folder-${index}/`)), collection(`${scanRoot}Folder-0/`)];
        return {
          responses: rows,
          metrics: { requestCount: 1, responseBytes: 128, networkDurationMs: 0.25, parseDurationMs: 0.1, retryCount: 0 }
        };
      }
    };
    const scanner = new RemoteInventoryScanner(client as never, userRoot, logger, { directoryConcurrency: 8 });
    const result = await scanner.scanFull("Obsidian");
    expect(result.complete).toBe(true);
    expect(result.entries).toHaveLength(folderCount);
    expect(requestCount).toBe(folderCount + 1);
    expect(result.metrics?.requestCount).toBe(folderCount + 1);
    expect(result.metrics?.responseBytes).toBe(128 * (folderCount + 1));
    expect(result.metrics?.peakConcurrency).toBeLessThanOrEqual(8);
    expect(result.metrics?.parseDurationMs).toBeGreaterThan(0);
    expect(result.metrics?.entriesPerSecond).toBeGreaterThan(0);
    expect(scanner.progress()).toEqual({ directoriesCompleted: folderCount + 1, filesFound: folderCount });
  });

  it("reports completed remote directories while slower parallel requests are still in flight", async () => {
    const userRoot = "https://progress.example/remote.php/dav/files/alice/";
    const scanRoot = `${userRoot}Obsidian/`;
    const client = {
      async listDirectory(url: string) {
        if (url === scanRoot) return [collection(scanRoot), collection(`${scanRoot}Fast/`), collection(`${scanRoot}Slow/`)];
        const directoryUrl = url.endsWith("/") ? url : `${url}/`;
        if (new URL(url).pathname.endsWith("/Slow")) await new Promise((resolve) => setTimeout(resolve, 80));
        return [collection(directoryUrl), file(`${directoryUrl}Note.md`, url.includes("Slow") ? "slow-id" : "fast-id")];
      }
    };
    const scanner = new RemoteInventoryScanner(client as never, userRoot, logger, { directoryConcurrency: 2 });
    const scan = scanner.scanFull("Obsidian");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scanner.progress().directoriesCompleted).toBeGreaterThan(1);
    expect(scanner.progress().directoriesCompleted).toBeLessThan(3);
    await expect(scan).resolves.toMatchObject({ complete: true, entries: [{ path: "Fast/Note.md" }, { path: "Slow/Note.md" }] });
    expect(scanner.progress()).toEqual({ directoriesCompleted: 3, filesFound: 2 });
  });

  it("blocks a weak ETag inventory so it cannot supply mutation preconditions", async () => {
    const server = "https://weak-etag.example";
    const userRoot = `${server}/remote.php/dav/files/alice/`;
    const scanRoot = `${userRoot}Obsidian/`;
    const client = {
      async listDirectory() {
        return [
          collection(scanRoot),
          { ...file(`${scanRoot}weak.md`, "77"), etag: 'W/"weak"' }
        ];
      }
    };
    const result = await new RemoteInventoryScanner(client as never, userRoot, logger).scanFull("Obsidian");
    expect(result.complete).toBe(false);
    expect(result.entries).toHaveLength(0);
    expect(result.issues.some((issue) => /weak ETag/i.test(issue.message))).toBe(true);
  });

  it("fails a complete scan closed when Nextcloud reuses one fileId at two paths", async () => {
    const userRoot = "https://duplicate-id.example/remote.php/dav/files/alice/";
    const scanRoot = `${userRoot}Obsidian/`;
    const client = {
      async listDirectory() {
        return [collection(scanRoot), file(`${scanRoot}A.md`, "same-id"), file(`${scanRoot}B.md`, "same-id")];
      }
    };
    const result = await new RemoteInventoryScanner(client as never, userRoot, logger).scanFull("Obsidian");
    expect(result.complete).toBe(false);
    expect(result.issues.some((issue) => issue.code === "duplicate-file-id")).toBe(true);
  });

  it("bounds recursive directory fan-out and keeps the inventory incomplete", async () => {
    const userRoot = "https://dir-limit.example/remote.php/dav/files/alice/";
    const scanRoot = `${userRoot}Obsidian/`;
    const client = {
      async listDirectory() { return [collection(scanRoot), collection(`${scanRoot}Child/`)]; }
    };
    const result = await new RemoteInventoryScanner(client as never, userRoot, logger, { maxDirectories: 1 }).scanFull("Obsidian");
    expect(result.complete).toBe(false);
    expect(result.directoriesVisited).toBe(1);
    expect(result.issues.some((issue) => issue.code === "directory-limit")).toBe(true);
  });

  it("preserves typed authentication failures while attaching scan metrics", async () => {
    const transport = {
      async request() {
        const bytes = new Uint8Array(0);
        return { status: 401, headers: {}, text: "", arrayBuffer: bytes.buffer, json: () => null };
      }
    };
    const client = new NextcloudDavClient(transport, { serverUrl: "https://cloud.example", loginName: "alice", appPassword: "secret" }, logger);
    await expect(client.listDirectoryMeasured("https://cloud.example/remote.php/dav/files/alice/"))
      .rejects.toMatchObject({ code: "authentication-rejected", metrics: { requestCount: 1 } });
  });
});

function collection(href: string) {
  return { href, status: 207, isCollection: true, etag: null, fileId: null, size: null, lastModified: null, contentType: null, checksums: [] };
}
function file(href: string, fileId: string) {
  return { href, status: 207, isCollection: false, etag: '"safe"', fileId, size: 4, lastModified: null, contentType: "text/plain", checksums: [] };
}
