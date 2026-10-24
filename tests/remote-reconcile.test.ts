import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { parseDavMultistatus } from "../src/remote/dav-xml";
import { appendWebdavPath, normalizeRemoteRootPath, relativePathFromDavHref } from "../src/remote/path";
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

describe("DAV parsing and paths", () => {
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

  it("keeps DAV hrefs inside the configured root and decodes path segments", () => {
    const root = "https://cloud.example/remote.php/dav/files/alice/Obsidian/";
    expect(relativePathFromDavHref(root, "/remote.php/dav/files/alice/Obsidian/Notes/Hello%20World.md")).toBe("Notes/Hello World.md");
    expect(() => relativePathFromDavHref(root, "/remote.php/dav/files/alice/Other/file.md")).toThrow(/outside/i);
  });

  it("encodes each configured remote path segment independently", () => {
    expect(normalizeRemoteRootPath(" /Notes/My Vault/ ")).toBe("Notes/My Vault");
    expect(appendWebdavPath("https://cloud.example/remote.php/dav/files/alice/", "Notes/My Vault")).toContain("Notes/My%20Vault");
  });
});

describe("Remote reconciliation", () => {
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
});
