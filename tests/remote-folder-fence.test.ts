import { describe, expect, it } from "vitest";
import { RemoteTransactionalMutator } from "../src/execution/remote-mutator";
import type { HttpRequest, HttpResponse } from "../src/network/http-client";
import { TransferJournalStore } from "../src/transfer/journal";
import { makeMemoryVault } from "./helpers/memory-vault";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const server = "https://cloud.example", root = `${server}/remote.php/dav/files/u/`;
const tuning = { chunkUploadThresholdBytes: 1024, uploadChunkBytes: 1024, downloadRangeChunkBytes: 1024, maxWholeDownloadBytes: 1024 };

/** Minimal WebDAV collection server. `conditional` decides whether it enforces If-Match on collection DELETE. */
class CollectionServer {
  collections = new Map<string, { etag: string; children: Set<string> }>();
  requests: HttpRequest[] = [];
  private counter = 1;
  /** "enforce": correct ETag works, wrong gives 412. "always412": the quirk seen on Nextcloud with CIFS storage. "ignore": condition ignored. */
  constructor(public mode: "enforce" | "always412" | "ignore", public weakTags = false) {}
  add(path: string, children: string[] = []): void { this.collections.set(path, { etag: this.tag(), children: new Set(children) }); }
  addChild(path: string, name: string): void { const c = this.collections.get(path)!; c.children.add(name); c.etag = this.tag(); }
  private tag(): string { const value = `"c${this.counter++}"`; return this.weakTags ? `W/${value}` : value; }
  private key(url: string): string { return decodeURIComponent(url.slice(root.length)).replace(/\/$/, ""); }
  private reply(status: number, text = ""): HttpResponse {
    return { status, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer, json: () => ({}) };
  }
  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const key = this.key(request.url);
    const folder = this.collections.get(key);
    switch (request.method) {
      case "MKCOL":
        if (folder) return this.reply(405);
        this.add(key); return this.reply(201);
      case "PROPFIND": {
        if (!folder) return this.reply(404);
        const row = (href: string, tag: string | null, collection: boolean) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${collection ? "<d:collection/>" : ""}</d:resourcetype>${tag ? `<d:getetag>${tag}</d:getetag>` : ""}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
        const depth = request.headers?.Depth;
        const kids = depth === "1" ? [...folder.children].map((name) => row(`/${key}/${name}`, '"f"', false)).join("") : "";
        return this.reply(207, `<d:multistatus xmlns:d="DAV:">${row(`/${key}/`, folder.etag, true)}${kids}</d:multistatus>`);
      }
      case "DELETE": {
        if (!folder) return this.reply(404);
        const match = request.headers?.["If-Match"];
        if (match && this.mode === "always412") return this.reply(412);
        if (match && this.mode === "enforce" && match !== folder.etag) return this.reply(412);
        this.collections.delete(key);
        return this.reply(204);
      }
      default: return this.reply(500);
    }
  }
}

function mutator(dav: CollectionServer, sleeps: number[] = []): RemoteTransactionalMutator {
  const journal = new TransferJournalStore(makeMemoryVault(), "nyra-nextcloud-sync", logger, "a".repeat(32));
  return new RemoteTransactionalMutator(dav, { serverUrl: server, loginName: "u", appPassword: "test" }, logger,
    { serverUrl: server, userId: "u", webdavUserRoot: root, tuning, journal, maxAttempts: 1, sleep: async (ms) => { sleeps.push(ms); } });
}
const folderUrl = `${root}Vault/Folder/`;
const deletes = (dav: CollectionServer) => dav.requests.filter((r) => r.method === "DELETE" && !r.url.includes("etag-probe-dir"));
const probeLeftovers = (dav: CollectionServer) => [...dav.collections.keys()].filter((k) => k.includes("etag-probe-dir"));

describe("remote empty-folder deletion across server behaviours", () => {
  it("uses a conditional DELETE with the listing ETag on a server that enforces it, and defers when the tag went stale", async () => {
    const dav = new CollectionServer("enforce"); dav.add("Vault"); dav.add("Vault/Folder");
    const remote = mutator(dav);
    expect(await remote.removeEmptyDirectory(folderUrl, "Folder")).toBe(true);
    expect(deletes(dav)).toHaveLength(1);
    expect(deletes(dav)[0]!.headers?.["If-Match"]).toMatch(/^"c\d+"$/);
    expect(dav.collections.has("Vault/Folder")).toBe(false);
    expect(probeLeftovers(dav)).toEqual([]);

    // A stale tag (child appeared between listing and delete) must never delete.
    dav.add("Vault/Late");
    const racing = mutator(dav);
    const original = dav.request.bind(dav);
    let injected = false;
    dav.request = async (request) => {
      if (request.method === "DELETE" && request.url.endsWith("/Vault/Late/") && !injected) { injected = true; dav.addChild("Vault/Late", "new.md"); }
      return await original(request);
    };
    expect(await racing.removeEmptyDirectory(`${root}Vault/Late/`, "Late")).toBe(false);
    expect(dav.collections.has("Vault/Late")).toBe(true);
  });

  it("still deletes on a server that answers 412 for every collection If-Match (observed live), after a settle pause and two empty listings", async () => {
    const dav = new CollectionServer("always412"); dav.add("Vault"); dav.add("Vault/Folder");
    const sleeps: number[] = [];
    const remote = mutator(dav, sleeps);
    expect(await remote.removeEmptyDirectory(folderUrl, "Folder")).toBe(true);
    expect(dav.collections.has("Vault/Folder")).toBe(false);
    expect(sleeps).toContain(300);
    expect(deletes(dav)[0]!.headers?.["If-Match"]).toBeUndefined();
    expect(dav.requests.filter((r) => r.method === "PROPFIND" && r.url === folderUrl && r.headers?.Depth === "1")).toHaveLength(2);
    expect(probeLeftovers(dav)).toEqual([]);
  });

  it("does not trust a server that ignores If-Match, and the fallback keeps a folder that gained a child during the settle pause", async () => {
    const dav = new CollectionServer("ignore"); dav.add("Vault"); dav.add("Vault/Folder");
    const remote = mutator(dav);
    const original = dav.request.bind(dav);
    let listings = 0;
    dav.request = async (request) => {
      if (request.method === "PROPFIND" && request.url === folderUrl && request.headers?.Depth === "1" && ++listings === 2) dav.addChild("Vault/Folder", "arrived.md");
      return await original(request);
    };
    expect(await remote.removeEmptyDirectory(folderUrl, "Folder")).toBe(false);
    expect(dav.collections.has("Vault/Folder")).toBe(true);
    expect(deletes(dav)).toHaveLength(0);
    expect(probeLeftovers(dav)).toEqual([]);
  });

  it("defers when the collection ETag changed between the two listings, and never deletes an occupied folder", async () => {
    const dav = new CollectionServer("always412"); dav.add("Vault"); dav.add("Vault/Folder");
    const remote = mutator(dav);
    const original = dav.request.bind(dav);
    let listings = 0;
    dav.request = async (request) => {
      if (request.method === "PROPFIND" && request.url === folderUrl && request.headers?.Depth === "1" && ++listings === 2) dav.collections.get("Vault/Folder")!.etag = '"restamped"';
      return await original(request);
    };
    expect(await remote.removeEmptyDirectory(folderUrl, "Folder")).toBe(false);
    dav.add("Vault/Full", ["a.md"]);
    expect(await mutator(dav).removeEmptyDirectory(`${root}Vault/Full/`, "Full")).toBe(false);
    expect(dav.collections.has("Vault/Full")).toBe(true);
  });

  it("treats weak or missing tags as not conditionable and falls back to the double check", async () => {
    const dav = new CollectionServer("enforce", true); dav.add("Vault"); dav.add("Vault/Folder");
    expect(await mutator(dav).removeEmptyDirectory(folderUrl, "Folder")).toBe(true);
    expect(deletes(dav)[0]!.headers?.["If-Match"]).toBeUndefined();
  });

  it("probes the server only once per mutator and reports an already missing folder as removed", async () => {
    const dav = new CollectionServer("enforce"); dav.add("Vault"); dav.add("Vault/A"); dav.add("Vault/B");
    const remote = mutator(dav);
    await remote.removeEmptyDirectory(`${root}Vault/A/`, "A");
    await remote.removeEmptyDirectory(`${root}Vault/B/`, "B");
    expect(dav.requests.filter((r) => r.method === "MKCOL" && r.url.includes("etag-probe-dir"))).toHaveLength(1);
    expect(await remote.removeEmptyDirectory(`${root}Vault/Gone/`, "Gone")).toBe(true);
  });
});

describe("Nextcloud file locks and concurrent folder creation", () => {
  const response = (status: number, text = ""): HttpResponse => ({ status, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer, json: () => ({}) });

  it("repeats a write that was refused with 423 Locked, because nothing ran, but never blindly repeats other failures", async () => {
    const make = (refusals: number, failure: number) => {
      const dav = new CollectionServer("enforce"); dav.add("Vault");
      let mkcols = 0;
      const original = dav.request.bind(dav);
      dav.request = async (request) => {
        if (request.method === "MKCOL") { mkcols += 1; if (mkcols <= refusals) return response(failure); }
        return await original(request);
      };
      const journal = new TransferJournalStore(makeMemoryVault(), "nyra-nextcloud-sync", logger, "a".repeat(32));
      const remote = new RemoteTransactionalMutator(dav, { serverUrl: server, loginName: "u", appPassword: "test" }, logger,
        { serverUrl: server, userId: "u", webdavUserRoot: root, tuning, journal, maxAttempts: 4, sleep: async () => {} });
      return { dav, remote, mkcols: () => mkcols };
    };
    const locked = make(2, 423);
    await locked.remote.ensureDirectoryPath(`${root}Vault/`, "Fresh");
    expect(locked.mkcols()).toBe(3);
    expect(locked.dav.collections.has("Vault/Fresh")).toBe(true);

    const broken = make(1, 500);
    await expect(broken.remote.ensureDirectoryPath(`${root}Vault/`, "Fresh")).rejects.toThrow();
    expect(broken.mkcols()).toBe(1); // a 500 may have committed: reconciled by looking, never by repeating the write
  });

  it("creates one shared new folder once when several uploads need it at the same time, even if the server locks during MKCOL", async () => {
    const dav = new CollectionServer("enforce"); dav.add("Vault");
    let mkcolInFlight = 0, overlaps = 0;
    const original = dav.request.bind(dav);
    dav.request = async (request) => {
      if (request.method !== "MKCOL") return await original(request);
      mkcolInFlight += 1; if (mkcolInFlight > 1) overlaps += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      try { return await original(request); } finally { mkcolInFlight -= 1; }
    };
    const remote = mutator(dav);
    await Promise.all(Array.from({ length: 6 }, () => remote.ensureDirectoryPath(`${root}Vault/`, "Shared/Deep")));
    expect(overlaps).toBe(0);
    expect(dav.collections.has("Vault/Shared")).toBe(true);
    expect(dav.collections.has("Vault/Shared/Deep")).toBe(true);
    expect(dav.requests.filter((r) => r.method === "MKCOL")).toHaveLength(2);
  });
});
