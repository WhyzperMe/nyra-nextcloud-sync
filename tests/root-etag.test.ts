import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/network/http-client";
import { RemoteRootChangeDetector } from "../src/remote/root-etag";
import { SyncCycleRunner, type SyncCyclePort } from "../src/sync/cycle-runner";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const multistatus = (etag: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/u/Vault/</d:href><d:propstat><d:prop><d:getetag>&quot;${etag}&quot;</d:getetag><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

/** Fake server whose root ETag changes with nested writes unless `propagates` is false. */
function fakeServer(options: { propagates: boolean; failMkcol?: boolean }) {
  let etag = "e0";
  let counter = 0;
  const log: string[] = [];
  const touch = (): void => { if (options.propagates) etag = `e${++counter}`; };
  const http: HttpTransport = {
    async request(request: HttpRequest): Promise<HttpResponse> {
      log.push(`${request.method} ${request.url}`);
      const reply = (status: number, text = ""): HttpResponse => ({ status, headers: {}, text, arrayBuffer: new ArrayBuffer(0), json: () => ({}) });
      if (request.method === "PROPFIND") return reply(207, multistatus(etag));
      if (request.method === "MKCOL") { if (options.failMkcol) return reply(403); touch(); return reply(201); }
      if (request.method === "PUT") { touch(); return reply(201); }
      if (request.method === "DELETE") { touch(); return reply(204); }
      return reply(400);
    }
  };
  return { http, log, change: touch };
}

describe("root ETag change detector", () => {
  const detector = (server: ReturnType<typeof fakeServer>) =>
    new RemoteRootChangeDetector(server.http, "Basic x", "https://c.example/remote.php/dav/files/u/Vault", logger, async () => undefined);

  it("reads the root ETag", async () => {
    expect(await detector(fakeServer({ propagates: true })).currentEtag()).toBe('"e0"');
  });

  it("verifies propagation of nested creates and deletes and removes its probe folder", async () => {
    const server = fakeServer({ propagates: true });
    expect(await detector(server).verifyPropagation()).toBe(true);
    expect(server.log.some((line) => line.startsWith("DELETE") && line.includes(".nyra-nextcloud-sync-runtime/rootetag-"))).toBe(true);
  });

  it("rejects servers whose root ETag does not follow nested changes", async () => {
    const server = fakeServer({ propagates: false });
    expect(await detector(server).verifyPropagation()).toBe(false);
    expect(server.log.some((line) => line.startsWith("DELETE"))).toBe(true); // probe cleaned up anyway
  });

  it("fails closed when the server refuses the probe", async () => {
    expect(await detector(fakeServer({ propagates: true, failMkcol: true })).verifyPropagation()).toBe(false);
  });
});

describe("cycle runner remote shortcut", () => {
  it("allows the cached remote check only for background remote polls and invalidates before a replan", async () => {
    const seen: boolean[] = [];
    let invalidated = 0;
    const base: SyncCyclePort = {
      localFactsComplete: () => true, remoteFactsComplete: () => true, lastFullLocalScanAt: () => 10_000, now: () => 11_000,
      flushLocalHints: async () => undefined, waitForLocalInventory: async () => undefined, scanLocalFull: async () => true,
      scanRemoteFull: async (options) => { seen.push(options.allowCached); return true; },
      invalidateRemoteFacts: () => { invalidated += 1; },
      buildPlan: async () => ({ items: [], summary: { total: 0, noop: 0, ready: 0, needsVerification: 0, mergeCandidates: 0, blocked: 0, destructiveSteps: 0, remoteVerifications: 0 } } as never),
      autoMergeEnabled: () => true, applyPlan: async () => { throw new Error("unused"); }, syncFolders: async () => 0
    };
    const runner = new SyncCycleRunner(base, [0]);
    await runner.run("remote-poll", false);
    await runner.run("local-quiet", false);
    await runner.run("manual", false);
    expect(seen).toEqual([true, false, false]);

    const { NyraError } = await import("../src/core/errors");
    let applies = 0;
    const replanning = new SyncCycleRunner({
      ...base,
      buildPlan: async () => ({ items: [], summary: { total: 1, noop: 0, ready: 1, needsVerification: 0, mergeCandidates: 0, blocked: 0, destructiveSteps: 0, remoteVerifications: 0 } } as never),
      applyPlan: async () => { applies += 1; if (applies === 1) throw new NyraError("sync-precondition-changed", "x"); return { completed: 1, blocked: 0, bytesProcessed: 0 } as never; }
    }, [0]);
    await replanning.run("remote-poll", false);
    expect(invalidated).toBe(1);
  });
});
