import { describe, expect, it } from "vitest";
import { TransactionalSyncExecutor } from "../src/execution/executor";
import { LocalTransactionalMutator } from "../src/execution/local-mutator";
import { SyncPlanner } from "../src/planner/planner";
import { DurableStateStore } from "../src/state/durable/store";
import { sha256Hex } from "../src/state/durable/crypto";
import { MemoryStateBackend } from "./helpers/memory-backend";
import { MemoryVaultAdapter, makeMemoryVault } from "./helpers/memory-vault";
import { FakeNextcloudDav } from "./helpers/fake-nextcloud";
import { TransferJournalStore } from "../src/transfer/journal";
import { RemoteTransactionalMutator } from "../src/execution/remote-mutator";
import { FaultInjectingTransport } from "./helpers/fault-injecting-transport";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const tuning = { chunkUploadThresholdBytes: 1024, uploadChunkBytes: 1024, downloadRangeChunkBytes: 1024, maxWholeDownloadBytes: 1024 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(failFirst = false, injectCommitRace = false) {
  const backend = new MemoryStateBackend();
  const store = await DurableStateStore.open(backend, logger);
  const bytes = new TextEncoder().encode("content").buffer;
  const hash = await sha256Hex(bytes);
  await store.transact("seed", (tx) => {
    for (const name of ["A", "B"]) tx.putFile({ entryId: `file_test${name}`, path: `${name}.md`, baseline: null,
      local: { path: `${name}.md`, contentHash: hash, size: bytes.byteLength, mtimeMs: 1 }, remote: null, status: "local-dirty" });
  });
  const plan = await new SyncPlanner().build(store.getState());
  const local = { async prepareSnapshot(path: string) { return {
    snapshotId: path, path, contentHash: hash, size: bytes.byteLength, mtimeMs: 1, chunkSize: bytes.byteLength, chunkCount: 1,
    async readChunk() { return bytes.slice(0); }, async *chunks() { yield bytes.slice(0); }, async assertSourceUnchanged() {}, async cleanup() {}
  }; } } as unknown as LocalTransactionalMutator;
  const release = deferred(), bothStarted = deferred();
  let active = 0, peak = 0, started = 0, finished = 0;
  const remote = { async ensureParentDirectories() {}, async uploadCreateFromSnapshot(_url: string, path: string) {
    active++; peak = Math.max(peak, active); started++; if (started === 2) bothStarted.resolve();
    try {
      if (failFirst && path === "A.md") { await bothStarted.promise; throw new Error("injected transfer failure"); }
      await release.promise;
      return { contentHash: hash, chunked: false, resumed: false, remote: { path, contentHash: hash, reportedSha256: null, etag: `etag-${path}`, fileId: `id-${path}`, size: bytes.byteLength, mtimeMs: 1 } };
    } finally { active--; finished++; }
  } } as unknown as RemoteTransactionalMutator;
  const executor = new TransactionalSyncExecutor(store, local, remote, "https://cloud.example/", "Vault", tuning, logger);
  if (injectCommitRace) {
    const original = store.transact.bind(store);
    store.transact = async (reason, build) => {
      if (reason === "convergent-apply") {
        await original("concurrent-change", (tx) => tx.putTombstone({ tombstoneId: "tomb_race01", entryId: "file_race01",
          previousPath: "changed.md", deletedSide: "local", previousBlobHash: null, previousRemoteFileId: null, createdAt: new Date().toISOString() }));
      }
      return await original(reason, build);
    };
  }
  const running = executor.execute(plan, { allowDestructive: false, allowMerge: false, maxOperations: 20, transferConcurrency: 2, transferMemoryBytes: 4096 });
  return { backend, store, executor, running, bothStarted, release, stats: () => ({ active, peak, finished }) };
}

describe("parallel executor", () => {
  it("overlaps real local and remote mutators against an offline DAV server", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const adapter = new MemoryVaultAdapter();
    const vault = makeMemoryVault(adapter);
    const scope = "d".repeat(32);
    const local = new LocalTransactionalMutator(vault, "nyra-nextcloud-sync", logger, scope);
    await local.initializeAndRecover();
    for (const name of ["A", "B"]) await adapter.write(`${name}.md`, `content-${name}`);
    const seeded = new Map();
    for (const name of ["A", "B"]) {
      const verified = await local.readVerified(`${name}.md`);
      seeded.set(name, { entryId: `file_real${name}`, path: verified.path, baseline: null,
        local: { path: verified.path, contentHash: verified.contentHash, size: verified.size, mtimeMs: verified.mtimeMs }, remote: null, status: "local-dirty" as const });
    }
    await store.transact("seed-real-uploads", (tx) => {
      for (const name of ["A", "B"]) {
        tx.putFile(seeded.get(name)!);
      }
    });
    const server = "https://cloud.example";
    const base = `${server}/remote.php/dav/files/u/`;
    const dav = new FakeNextcloudDav(server, "u");
    const fault = new FaultInjectingTransport(dav, [{ id: "lost-response", method: "PUT", urlIncludes: "A.md", phase: "after", action: { kind: "throw", message: "response lost after commit" } }]);
    const bothStarted = deferred(), release = deferred();
    let active = 0, peak = 0;
    const transport = { async request(request: Parameters<typeof dav.request>[0]) {
      if (request.method === "PUT" && /\/(A|B)\.md(?:\?|$)/.test(request.url)) {
        active++; peak = Math.max(peak, active); if (active === 2) bothStarted.resolve();
        try { await release.promise; return await fault.request(request); } finally { active--; }
      }
      return await fault.request(request);
    } };
    const journal = new TransferJournalStore(vault, "nyra-nextcloud-sync", logger, scope);
    const remote = new RemoteTransactionalMutator(transport, { serverUrl: server, loginName: "u", appPassword: "test" }, logger,
      { serverUrl: server, userId: "u", webdavUserRoot: base, tuning, journal, maxAttempts: 1 });
    const executor = new TransactionalSyncExecutor(store, local, remote, base, "Obsidian", tuning, logger);
    const plan = await new SyncPlanner().build(store.getState());
    const running = executor.execute(plan, { allowDestructive: false, allowMerge: false, maxOperations: 20, transferConcurrency: 2, transferMemoryBytes: 4096 });
    await bothStarted.promise;
    expect(peak).toBe(2);
    release.resolve();
    expect((await running).completed).toBe(4);
    expect(fault.hitCount("lost-response")).toBe(1);
    expect(new TextDecoder().decode(dav.getFile(`${base}Obsidian/A.md`)!)).toBe("content-A");
    expect(new TextDecoder().decode(dav.getFile(`${base}Obsidian/B.md`)!)).toBe("content-B");
    expect(store.getState().files.file_realA?.baseline).not.toBeNull();
    expect(store.getState().files.file_realB?.baseline).not.toBeNull();
  });
  it("downloads independent files concurrently through the real local staging implementation", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const adapter = new MemoryVaultAdapter();
    const local = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, "c".repeat(32));
    await local.initializeAndRecover();
    const bytes = new TextEncoder().encode("remote data").buffer;
    const hash = await sha256Hex(bytes);
    await store.transact("seed-remotes", (tx) => {
      for (const name of ["A", "B"]) tx.putFile({ entryId: `file_test${name}`, path: `${name}.md`, baseline: null, local: null,
        remote: { path: `${name}.md`, contentHash: hash, reportedSha256: null, etag: `etag-${name}`, fileId: `id-${name}`, size: bytes.byteLength, mtimeMs: 1 }, status: "remote-dirty" });
    });
    const bothStarted = deferred(), release = deferred();
    let active = 0, peak = 0;
    const remote = { async openDownload(_url: string, path: string) {
      active++; peak = Math.max(peak, active); if (active === 2) bothStarted.resolve();
      await release.promise;
      const remoteRecord = { path, contentHash: hash, reportedSha256: null, etag: `etag-${path[0]}`, fileId: `id-${path[0]}`, size: bytes.byteLength, mtimeMs: 1 };
      return { chunks: (async function* () { try { yield bytes.slice(0); } finally { active--; } })(),
        completed: Promise.resolve({ contentHash: hash, remote: remoteRecord, bytesTransferred: bytes.byteLength, ranged: false }) };
    } } as unknown as RemoteTransactionalMutator;
    const executor = new TransactionalSyncExecutor(store, local, remote, "https://cloud.example/", "Vault", tuning, logger);
    const plan = await new SyncPlanner().build(store.getState());
    const running = executor.execute(plan, { allowDestructive: false, allowMerge: false, maxOperations: 20, transferConcurrency: 2, transferMemoryBytes: 4096 });
    await bothStarted.promise;
    expect(peak).toBe(2);
    expect(store.getState().files.file_testA?.baseline).toBeNull();
    release.resolve();
    expect((await running).completed).toBe(4);
    expect(await adapter.read("A.md")).toBe("remote data");
    expect(await adapter.read("B.md")).toBe("remote data");
    expect(store.getState().files.file_testA?.baseline?.blobHash).toBe(hash);
    expect(store.getState().files.file_testB?.baseline?.blobHash).toBe(hash);
  });

  it("preserves a local file created while parallel downloads are waiting", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const adapter = new MemoryVaultAdapter();
    const local = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, "f".repeat(32));
    await local.initializeAndRecover();
    const bytes = new TextEncoder().encode("remote").buffer, hash = await sha256Hex(bytes);
    await store.transact("seed-download-race", (tx) => {
      for (const name of ["A", "B"]) tx.putFile({ entryId: `file_race${name}`, path: `${name}.md`, baseline: null, local: null,
        remote: { path: `${name}.md`, contentHash: hash, reportedSha256: null, etag: `etag-${name}`, fileId: `id-${name}`, size: bytes.byteLength, mtimeMs: 1 }, status: "remote-dirty" });
    });
    const bothStarted = deferred(), release = deferred();
    let started = 0;
    const remote = { async openDownload(_url: string, path: string) {
      if (++started === 2) bothStarted.resolve();
      await release.promise;
      const remoteRecord = { path, contentHash: hash, reportedSha256: null, etag: `etag-${path[0]}`, fileId: `id-${path[0]}`, size: bytes.byteLength, mtimeMs: 1 };
      return { chunks: (async function* () { yield bytes.slice(0); })(), completed: Promise.resolve({ contentHash: hash, remote: remoteRecord, bytesTransferred: bytes.byteLength, ranged: false }) };
    } } as unknown as RemoteTransactionalMutator;
    const executor = new TransactionalSyncExecutor(store, local, remote, "https://cloud.example/", "Vault", tuning, logger);
    const plan = await new SyncPlanner().build(store.getState());
    const outcome = executor.execute(plan, { allowDestructive: false, allowMerge: false, maxOperations: 20, transferConcurrency: 2, transferMemoryBytes: 4096 }).then(() => null, (error: Error) => error);
    await bothStarted.promise;
    await adapter.write("A.md", "user edit");
    release.resolve();
    expect((await outcome)?.message).toMatch(/already exists/);
    expect(await adapter.read("A.md")).toBe("user edit");
    expect(await adapter.read("B.md")).toBe("remote");
    // The failed entry stays unrecorded; the sibling that finished and was verified is kept.
    expect(store.getState().files.file_raceA?.baseline).toBeNull();
    expect(store.getState().files.file_raceB?.baseline?.blobHash).toBe(hash);
  });

  it("overlaps independent uploads and publishes baseline only after both complete", async () => {
    const f = await fixture();
    await f.bothStarted.promise;
    expect(f.stats()).toMatchObject({ active: 2, peak: 2 });
    expect(f.executor.summary().activeOperations).toBe(2);
    expect(f.store.getState().files.file_testA?.baseline).toBeNull();
    f.release.resolve();
    expect((await f.running).completed).toBe(4);
    expect(f.executor.summary().activeOperations).toBe(0);
    expect(f.store.getState().files.file_testA?.baseline).not.toBeNull();
    expect(f.store.getState().files.file_testB?.baseline).not.toBeNull();
  });

  it("drains an already started worker after another fails, then records only the sibling that completed", async () => {
    const f = await fixture(true);
    let settled = false;
    const outcome = f.running.then(() => null, (error: Error) => error).then((value) => { settled = true; return value; });
    await f.bothStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(f.stats().active).toBe(1);
    f.release.resolve();
    expect((await outcome)?.message).toContain("injected transfer failure");
    expect(f.stats().finished).toBe(2);
    // A (failed) is not recorded; B uploaded and was verified before the failure surfaced, so it is.
    expect(f.store.getState().files.file_testA?.baseline).toBeNull();
    expect(f.store.getState().files.file_testB?.baseline).not.toBeNull();
    await f.store.close();
    const reopened = await DurableStateStore.open(f.backend, logger);
    expect(reopened.getState().files.file_testA?.baseline).toBeNull();
    expect(reopened.getState().files.file_testB?.baseline).not.toBeNull();
    expect((await new SyncPlanner().build(reopened.getState())).summary.ready).toBe(1);
  });

  it("does not record partial progress when the plan anchor moved, and still reports the original failure", async () => {
    const f = await fixture(true, true);
    const outcome = f.running.then(() => null, (error: Error) => error);
    await f.bothStarted.promise;
    f.release.resolve();
    expect((await outcome)?.message).toContain("injected transfer failure");
    expect(f.store.getState().files.file_testA?.baseline).toBeNull();
    expect(f.store.getState().files.file_testB?.baseline).toBeNull();
  });

  it("rejects durable publication when the store changes after the outer plan check", async () => {
    const f = await fixture(false, true);
    const outcome = f.running.then(() => null, (error: Error) => error);
    await f.bothStarted.promise;
    f.release.resolve();
    expect((await outcome)?.message).toMatch(/changed before durable publication/);
    expect(f.store.getState().files.file_testA?.baseline).toBeNull();
    expect(f.store.getState().files.file_testB?.baseline).toBeNull();
  });

  it("drains transfers on close and refuses to start their baseline steps", async () => {
    const f = await fixture();
    const outcome = f.running.then(() => null, (error: Error) => error);
    await f.bothStarted.promise;
    f.executor.close();
    f.release.resolve();
    expect((await outcome)?.message).toMatch(/closed/i);
    expect(f.stats().finished).toBe(2);
    expect(f.store.getState().files.file_testA?.baseline).toBeNull();
    expect(f.store.getState().files.file_testB?.baseline).toBeNull();
  });
});
