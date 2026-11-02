import { expect, it } from "vitest";
import { TransactionalSyncExecutor } from "../src/execution/executor";
import type { RemoteTransactionalMutator } from "../src/execution/remote-mutator";
import { SyncPlanner } from "../src/planner/planner";
import { DurableStateStore, type DurableTransaction } from "../src/state/durable/store";
import { sha256Hex } from "../src/state/durable/crypto";
import { MemoryStateBackend } from "./helpers/memory-backend";
import { LocalTransactionalMutator } from "../src/execution/local-mutator";
import { RemoteTransactionalMutator as RealRemoteMutator } from "../src/execution/remote-mutator";
import { TransferJournalStore } from "../src/transfer/journal";
import { FakeNextcloudDav } from "./helpers/fake-nextcloud";
import { MemoryVaultAdapter, makeMemoryVault } from "./helpers/memory-vault";

it("measures serial and parallel transfer scheduling with synthetic network latency", async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const data = new TextEncoder().encode("benchmark").buffer;
  const hash = await sha256Hex(data);
  const tuning = { chunkUploadThresholdBytes: 1024, uploadChunkBytes: 1024, downloadRangeChunkBytes: 1024, maxWholeDownloadBytes: 1024 };
  async function run(workers: number, files: number, latencyMs: number) {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    await store.transact("benchmark-seed", (tx) => {
      for (let i = 0; i < files; i++) tx.putFile({ entryId: `file_bench${i}`, path: `${i}.md`, baseline: null,
        local: { path: `${i}.md`, contentHash: hash, size: data.byteLength, mtimeMs: 1 }, remote: null, status: "local-dirty" });
    });
    const local = { async prepareSnapshot(path: string) { return { snapshotId: path, path, contentHash: hash,
      size: data.byteLength, mtimeMs: 1, chunkSize: data.byteLength, chunkCount: 1, async readChunk() { return data.slice(0); },
      async *chunks() { yield data.slice(0); }, async assertSourceUnchanged() {}, async cleanup() {} }; } } as unknown as LocalTransactionalMutator;
    let active = 0, peak = 0;
    const remote = { async ensureParentDirectories() {}, async uploadCreateFromSnapshot(_url: string, path: string) {
      active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, latencyMs)); active--;
      return { contentHash: hash, chunked: false, resumed: false, remote: { path, contentHash: hash, reportedSha256: null,
        etag: `etag-${path}`, fileId: `id-${path}`, size: data.byteLength, mtimeMs: 1 } };
    } } as unknown as RemoteTransactionalMutator;
    const executor = new TransactionalSyncExecutor(store, local, remote, "https://cloud.example/", "Vault", tuning, logger);
    const plan = await new SyncPlanner().build(store.getState());
    const started = performance.now();
    await executor.execute(plan, { allowDestructive: false, allowMerge: false, maxOperations: 200, transferConcurrency: workers, transferMemoryBytes: 4096 });
    return { elapsedMs: Math.round(performance.now() - started), peak };
  }
  const rows: string[] = [];
  for (const latencyMs of [30]) {
    const results = new Map<number, { elapsedMs: number; peak: number }>();
    for (const workers of [1, 2, 4, 8]) results.set(workers, await run(workers, 24, latencyMs));
    for (const [workers, result] of results) expect(result.peak).toBe(Math.min(workers, 24));
    // Scheduling must really overlap the waits: with four workers the 24 delayed uploads take well under the serial time.
    expect(results.get(4)!.elapsedMs).toBeLessThan(results.get(1)!.elapsedMs * 0.7);
    rows.push(`latency ${latencyMs} ms: ` + [...results].map(([workers, result]) => `${workers}w=${result.elapsedMs} ms`).join(", "));
  }
  console.info(`Synthetic benchmark, 24 tiny files, artificial delay per upload (scheduling only, no real network/Android/Nextcloud): ${rows.join(" | ")}`);
});

it("compares serial and parallel runs of the real mutators against an offline DAV server with per-request latency", async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const tuning = { chunkUploadThresholdBytes: 1024, uploadChunkBytes: 1024, downloadRangeChunkBytes: 1024, maxWholeDownloadBytes: 1024 };
  const server = "https://cloud.example", base = `${server}/remote.php/dav/files/u/`;
  async function run(workers: number, latencyMs: number) {
    const adapter = new MemoryVaultAdapter();
    const vault = makeMemoryVault(adapter);
    const scope = "e".repeat(32);
    const local = new LocalTransactionalMutator(vault, "nyra-nextcloud-sync", logger, scope);
    await local.initializeAndRecover();
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const records: Array<Parameters<DurableTransaction["putFile"]>[0]> = [];
    // Twelve small direct uploads and four multi-chunk uploads, all in separate folders.
    for (let i = 0; i < 16; i += 1) {
      const path = `Folder${i % 4}/note-${i}.md`;
      await adapter.write(path, i < 12 ? `small note ${i}` : `${"x".repeat(2500)}-${i}`);
      const verified = await local.readVerified(path);
      records.push({ entryId: `file_perf${i}`, path, baseline: null, remote: null, status: "local-dirty" as const,
        local: { path, contentHash: verified.contentHash, size: verified.size, mtimeMs: verified.mtimeMs } });
    }
    await store.transact("seed", (tx) => { for (const record of records) tx.putFile(record); });
    const dav = new FakeNextcloudDav(server, "u");
    let requests = 0;
    const mkcol: number[] = [];
    const methods = new Map<string, number>();
    const transport = { async request(request: Parameters<typeof dav.request>[0]) {
      requests += 1;
      methods.set(request.method ?? "GET", (methods.get(request.method ?? "GET") ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      const response = await dav.request(request);
      if (request.method === "MKCOL") mkcol.push(response.status);
      return response;
    } };
    const journal = new TransferJournalStore(vault, "nyra-nextcloud-sync", logger, scope);
    const remote = new RealRemoteMutator(transport, { serverUrl: server, loginName: "u", appPassword: "test" }, logger,
      { serverUrl: server, userId: "u", webdavUserRoot: base, tuning, journal, maxAttempts: 1 });
    const executor = new TransactionalSyncExecutor(store, local, remote, base, "Obsidian", tuning, logger);
    const plan = await new SyncPlanner().build(store.getState());
    const started = performance.now();
    const report = await executor.execute(plan, { allowDestructive: false, allowMerge: false, maxOperations: 500, transferConcurrency: workers, transferMemoryBytes: 1024 * 1024 });
    const elapsedMs = Math.round(performance.now() - started);
    expect(report.failed).toBe(0);
    for (const record of records) {
      expect(dav.getFile(`${base}Obsidian/${record.path}`), record.path).toBeDefined();
      expect(store.getState().files[record.entryId]?.baseline, record.path).not.toBeNull();
    }
    return { elapsedMs, requests, mkcol, methods };
  }
  const serial = await run(1, 8), two = await run(2, 8), four = await run(4, 8);
  // Same protocol: directory creation is serialized, so there are no lost MKCOL races, every write-type request count
  // is identical, and the only extra traffic is the re-check PROPFIND of a worker that waited for a folder another created.
  expect(four.mkcol.filter((status) => status !== 201)).toEqual([]);
  for (const method of new Set([...serial.methods.keys(), ...four.methods.keys()])) {
    if (method !== "PROPFIND") expect(four.methods.get(method) ?? 0, method).toBe(serial.methods.get(method) ?? 0);
  }
  expect(four.requests).toBeGreaterThanOrEqual(serial.requests);
  expect(four.elapsedMs).toBeLessThan(serial.elapsedMs * 0.8);
  console.info(`Real mutators, offline DAV, nominal 8 ms timer per request (host timers are coarser), 12 small + 4 chunked uploads: 1w=${serial.elapsedMs} ms, 2w=${two.elapsedMs} ms, 4w=${four.elapsedMs} ms (${serial.requests}/${two.requests}/${four.requests} requests)`);
});
