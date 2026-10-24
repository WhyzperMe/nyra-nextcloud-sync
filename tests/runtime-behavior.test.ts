import { describe, it } from "vitest";
import { ConvergenceAuditor } from "../src/convergence/auditor";
import { runConvergenceSoak } from "./helpers/convergence-soak";
import { AutoSyncScheduler } from "../src/autosync/scheduler";
import { assessBootstrapPlan } from "../src/bootstrap/assessment";
import { mergeTextThreeWay } from "../src/merge/text-merge";
import { LocalPathPolicy } from "../src/local/path-policy";
import { SyncPlanner } from "../src/planner/planner";
import { createEmptyState, type FileReplicaRecord } from "../src/state/durable/model";
import { normalizeSettings } from "../src/state/settings";
import type { Logger } from "../src/diagnostics/logger";
import { ServerHealthMonitor } from "../src/health/monitor";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/network/http-client";
import type { PreparedLocalSnapshot } from "../src/execution/local-mutator";
import { LocalTransactionalMutator } from "../src/execution/local-mutator";
import { RemoteTransactionalMutator, type RemoteDownloadStream } from "../src/execution/remote-mutator";
import { TransactionalSyncExecutor } from "../src/execution/executor";
import type { LocalWriteResult } from "../src/execution/local-mutator";
import type { RemoteReplicaState } from "../src/state/durable/model";
import { DurableStateStore } from "../src/state/durable/store";
import { MemoryStateBackend } from "./helpers/memory-backend";
import { sha256Hex } from "../src/state/durable/crypto";
import { chunkBounds, planNextcloudChunks } from "../src/transfer/chunking";
import { TransferJournalStore } from "../src/transfer/journal";
import type { TransferTuning } from "../src/transfer/types";
import { FaultInjectingDataAdapter } from "./helpers/fault-injecting-adapter";
import { FakeNextcloudDav } from "./helpers/fake-nextcloud";
import { FaultInjectingTransport } from "./helpers/fault-injecting-transport";
import { MemoryVaultAdapter, makeMemoryVault } from "./helpers/memory-vault";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DEVICE_SCOPE = "1".repeat(32);
const MIB = 1024 * 1024;
const server = "https://cloud.stage12-runtime.test";
const userId = "stage12";
const root = `${server}/remote.php/dav/files/${userId}/Obsidian/`;
const credentials = { serverUrl: server, loginName: userId, appPassword: "runtime-secret" };
const tuning: TransferTuning = {
  chunkUploadThresholdBytes: 5 * MIB,
  uploadChunkBytes: 5 * MIB,
  downloadRangeChunkBytes: 1 * MIB,
  maxWholeDownloadBytes: 1 * MIB
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function makeRemote(http: FakeNextcloudDav | FaultInjectingTransport, sleeps: number[] = [], journal?: TransferJournalStore): Promise<RemoteTransactionalMutator> {
  const store = journal ?? new TransferJournalStore(makeMemoryVault(), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
  await store.ensure();
  return new RemoteTransactionalMutator(http, credentials, logger, {
    serverUrl: server,
    userId,
    webdavUserRoot: `${server}/remote.php/dav/files/${userId}/`,
    tuning,
    journal: store,
    maxAttempts: 3,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5
  });
}

async function testAmbiguousDirectMutations(): Promise<void> {
  const dav = new FakeNextcloudDav(server, userId);
  const createUrl = `${root}Direct.md`;
  const createFault = new FaultInjectingTransport(dav, [{
    id: "direct-create-after-commit", method: "PUT", urlIncludes: "Direct.md", phase: "after",
    action: { kind: "throw", message: "lost create response" }
  }]);
  const createdBytes = new TextEncoder().encode("stage12 create").buffer;
  const created = await (await makeRemote(createFault)).uploadCreate(createUrl, "Direct.md", createdBytes);
  assert(created.contentHash === await sha256Hex(createdBytes), "Ambiguous direct create was not reconciled.");

  const updateFault = new FaultInjectingTransport(dav, [{
    id: "direct-update-after-commit", method: "PUT", urlIncludes: "Direct.md", phase: "after",
    action: { kind: "throw", message: "lost update response" }
  }]);
  const updateBytes = new TextEncoder().encode("stage12 update").buffer;
  const updated = await (await makeRemote(updateFault)).uploadUpdate(createUrl, "Direct.md", updateBytes, created.remote.fileId, created.remote.etag);
  assert(updated.contentHash === await sha256Hex(updateBytes), "Ambiguous direct update was not reconciled.");

  const movedUrl = `${root}Moved.md`;
  const moveFault = new FaultInjectingTransport(dav, [{
    id: "move-after-commit", method: "MOVE", urlIncludes: "Direct.md", phase: "after",
    action: { kind: "throw", message: "lost move response" }
  }]);
  const moved = await (await makeRemote(moveFault)).move(createUrl, "Direct.md", movedUrl, "Moved.md", updated.remote.fileId, updated.remote.etag);
  assert(moved.fileId === updated.remote.fileId && dav.getFile(createUrl) === null && dav.getFile(movedUrl) !== null, "Ambiguous MOVE reconciliation failed.");

  const deleteFault = new FaultInjectingTransport(dav, [{
    id: "delete-after-commit", method: "DELETE", urlIncludes: "Moved.md", phase: "after",
    action: { kind: "throw", message: "lost delete response" }
  }]);
  await (await makeRemote(deleteFault)).remove(movedUrl, "Moved.md", moved.fileId, moved.etag);
  assert(dav.getFile(movedUrl) === null, "Ambiguous DELETE reconciliation failed.");
}

async function testRetryAndRangeFences(): Promise<void> {
  const dav = new FakeNextcloudDav(server, userId);
  const target = `${root}Retry.md`;
  await (await makeRemote(dav)).uploadCreate(target, "Retry.md", new TextEncoder().encode("retry").buffer);
  const sleeps: number[] = [];
  const retryFault = new FaultInjectingTransport(dav, [{
    id: "423-once", method: "PROPFIND", urlIncludes: "Retry.md", phase: "before",
    action: { kind: "status", status: 423, headers: { "Retry-After": "0" } }
  }]);
  const stat = await (await makeRemote(retryFault, sleeps)).stat(target, "Retry.md");
  assert(stat.size === 5 && sleeps.length === 1 && (sleeps[0] ?? 0) >= 250, "423 Retry-After handling failed.");

  const rangeBytes = patterned(2 * MIB + 9);
  const rangeUrl = `${root}Range.bin`;
  await dav.request({ url: rangeUrl, method: "PUT", body: rangeBytes.buffer });
  const truncateFault = new FaultInjectingTransport(dav, [{
    id: "truncate-range", method: "GET", urlIncludes: "Range.bin", phase: "after",
    action: { kind: "truncate-body", bytes: 1 }
  }]);
  let rejected = false;
  try { await (await makeRemote(truncateFault)).verifyRemoteContent(rangeUrl, "Range.bin", null, null); }
  catch (error) { rejected = /Ranged download returned/.test(error instanceof Error ? error.message : String(error)); }
  assert(rejected, "Truncated range response was not rejected.");
}

async function testAmbiguousChunkPut(): Promise<void> {
  const dav = new FakeNextcloudDav(server, userId);
  const journal = new TransferJournalStore(makeMemoryVault(), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
  await journal.ensure();
  const bytes = patterned(6 * MIB + 31);
  const hash = await sha256Hex(bytes.buffer);
  const geometry = planNextcloudChunks(bytes.byteLength, tuning.uploadChunkBytes);
  const snapshot = makeSnapshot(bytes, hash, geometry.chunkSize);
  const fault = new FaultInjectingTransport(dav, [{
    id: "chunk-put-after-commit", method: "PUT", urlIncludes: "/00001", phase: "after",
    action: { kind: "throw", message: "lost first chunk response" }
  }]);
  const result = await (await makeRemote(fault, [], journal)).uploadCreateFromSnapshot(`${root}Chunked.bin`, "Chunked.bin", snapshot);
  assert(result.chunked && result.contentHash === hash, "Chunk PUT after-commit ambiguity was not reconciled.");
  assert(fault.hitCount("chunk-put-after-commit") === 1, "Chunk fault did not fire exactly once.");
  assert((await journal.listLatest()).length === 0, "Completed chunk journal was not cleaned.");
}

async function testLocalAmbiguousCompletion(): Promise<void> {
  const base = new MemoryVaultAdapter();
  const source = new TextEncoder().encode("local source").buffer;
  await base.writeBinary("A.txt", source);
  const hash = await sha256Hex(source);
  const moveFault = new FaultInjectingDataAdapter(base, [{
    id: "local-move-after-commit", operation: "rename", phase: "after", pathIncludes: "A.txt -> B.txt"
  }]);
  const moveMutator = new LocalTransactionalMutator(makeMemoryVault(moveFault), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
  await moveMutator.initializeAndRecover();
  const moved = await moveMutator.moveAtomic("A.txt", "B.txt", hash);
  assert(moved.contentHash === hash && !(await base.exists("A.txt")) && await base.exists("B.txt"), "Local ambiguous move reconciliation failed.");

  const newBytes = new TextEncoder().encode("replacement").buffer;
  const newHash = await sha256Hex(newBytes);
  const replaceFault = new FaultInjectingDataAdapter(base, [{
    id: "local-replace-after-commit", operation: "rename", phase: "after", pathIncludes: `runtime/${DEVICE_SCOPE}/apply/staging/`
  }]);
  const replaceMutator = new LocalTransactionalMutator(makeMemoryVault(replaceFault), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
  await replaceMutator.initializeAndRecover();
  const replaced = await replaceMutator.writeAtomic("B.txt", newBytes, hash);
  assert(replaced.contentHash === newHash && await sha256Hex(await base.readBinary("B.txt")) === newHash, "Local ambiguous replace reconciliation failed.");
}


class RuntimeTransport implements HttpTransport {
  constructor(private readonly handler: (request: HttpRequest) => Promise<HttpResponse>) {}
  async request(request: HttpRequest): Promise<HttpResponse> { return await this.handler(request); }
}

function healthResponse(status: number, payload: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(text);
  return { status, headers, text, arrayBuffer: bytes.buffer, json: () => payload };
}

function healthyStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { installed: true, maintenance: false, needsDbUpgrade: false, version: "35.0.0.0", versionstring: "35.0.0", productname: "Nextcloud", ...overrides };
}

async function testHealthAndQuietAutosync(): Promise<void> {
  let now = 20_000_000;
  const health = new ServerHealthMonitor(
    new RuntimeTransport(async () => healthResponse(200, healthyStatus())),
    logger,
    { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, now: () => now, random: () => 0.5 }
  );
  const online = await health.checkNow(true);
  assert(online.state === "online", "Health monitor did not classify a healthy Nextcloud server as online.");

  const maintenance = new ServerHealthMonitor(
    new RuntimeTransport(async () => healthResponse(200, healthyStatus({ maintenance: true }))),
    logger,
    { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, now: () => now, random: () => 0.5 }
  );
  assert((await maintenance.checkNow(true)).state === "maintenance", "Maintenance mode was not classified safely.");

  let timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const setTimer = (callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
    timerId += 1;
    timers.set(timerId, { at: now + ms, callback });
    return timerId as unknown as ReturnType<typeof globalThis.setTimeout>;
  };
  const clearTimer = (id: ReturnType<typeof globalThis.setTimeout>): void => { timers.delete(id as unknown as number); };
  const counter = { runs: 0 };
  const scheduler = new AutoSyncScheduler({
    getPolicy: () => ({ enabled: true, quietPeriodMs: 5_000, remotePollMs: 60_000, startupDelayMs: 1_000, allowDeletes: false }),
    canRun: () => true,
    isExecutionActive: () => false,
    runCycle: async () => { counter.runs += 1; return { changed: true, executed: true, completedSteps: 1, blockedSteps: 0, reviewItems: 0, bytesProcessed: 1 }; },
    health,
    logger,
    now: () => now,
    setTimer,
    clearTimer
  });
  scheduler.start();
  scheduler.noteLocalActivity();
  await fireEarliestRuntimeTimer(timers, (value) => { now = value; });
  assert(Number(counter.runs) === 0, "Startup/remote polling bypassed the local quiet period.");
  await fireEarliestRuntimeTimer(timers, (value) => { now = value; });
  assert(Number(counter.runs) === 1, "Auto-sync did not run after the quiet period elapsed.");
  assert(scheduler.summary().pendingLocalChanges === 0, "Successful quiet-period sync did not clear the stable activity batch.");
  scheduler.close();
}

async function fireEarliestRuntimeTimer(
  timers: Map<number, { at: number; callback: () => void }>,
  setNow: (value: number) => void
): Promise<void> {
  const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
  if (!next) throw new Error("Runtime autosync test expected a timer.");
  timers.delete(next[0]);
  setNow(next[1].at);
  next[1].callback();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

async function testCrossDeviceBootstrap(): Promise<void> {
  const fresh = normalizeSettings(null);
  assert(fresh.syncObsidianConfig === false, "Fresh Stage 12 settings must default to content-only config scope.");
  const migrated = normalizeSettings({ schemaVersion: 5, remoteRootPath: "Obsidian", connectionState: "disconnected" });
  assert(migrated.syncObsidianConfig === true, "Migration must preserve legacy config-sync behavior.");

  let syncConfig = false;
  const policy = new LocalPathPolicy({
    reservedRoots: [".trash", ".obsidian/plugins/nyra-nextcloud-sync"],
    reservedFiles: [".obsidian/workspace.json", ".obsidian/workspace-mobile.json"],
    configDir: ".obsidian",
    syncObsidianConfig: () => syncConfig
  });
  assert(policy.isIncluded("Notes/A.md"), "Content file was unexpectedly excluded.");
  assert(!policy.isIncluded(".obsidian/app.json"), "Fresh mobile-friendly scope must exclude .obsidian.");
  syncConfig = true;
  assert(policy.isIncluded(".obsidian/app.json"), "Explicit config sync did not include .obsidian/app.json.");
  assert(!policy.isIncluded(".obsidian/workspace-mobile.json"), "Mobile workspace state must remain device-local.");
  assert(!policy.isIncluded(".obsidian/plugins/nyra-nextcloud-sync/main.js"), "Plugin must never synchronize itself.");

  const pushState = createEmptyState("stage12-push");
  const push: FileReplicaRecord = {
    entryId: "push-file", path: "Notes/A.md", generation: "0", baseline: null,
    local: { path: "Notes/A.md", contentHash: "a".repeat(64), size: 1, mtimeMs: 1 }, remote: null, status: "local-dirty"
  };
  pushState.files[push.entryId] = push;
  pushState.pathIndex[push.local!.path] = push.entryId;
  const pushPlan = await new SyncPlanner().build(pushState);
  assert(assessBootstrapPlan(pushPlan, 1, 0).canPublish, "Local-first bootstrap publish was not accepted.");

  const pullState = createEmptyState("stage12-pull");
  const pull: FileReplicaRecord = {
    entryId: "pull-file", path: "Notes/A.md", generation: "0", baseline: null, local: null,
    remote: { path: "Notes/A.md", contentHash: null, reportedSha256: null, etag: '"e1"', fileId: "71", size: 1, mtimeMs: 1 }, status: "remote-dirty"
  };
  pullState.files[pull.entryId] = pull;
  pullState.remotePathIndex[pull.remote!.path] = pull.entryId;
  pullState.remoteFileIdIndex[pull.remote!.fileId!] = pull.entryId;
  const pullPlan = await new SyncPlanner().build(pullState);
  assert(assessBootstrapPlan(pullPlan, 0, 1).canDownload, "Remote-first bootstrap download was not accepted.");
}




function testMergePropertyMatrix(): void {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const limits = { maxInputBytes: 2 * MIB, maxLines: 12_000, maxDiffCells: 8_000_000 };
  for (let round = 0; round < 200; round += 1) {
    const count = 24 + (round % 17);
    const baseLines = Array.from({ length: count }, (_, index) => `L${round}-${index}`);
    const leftIndex = round % count;
    let rightIndex = (round * 7 + 3) % count;
    if (rightIndex === leftIndex) rightIndex = (rightIndex + 1) % count;
    const localLines = [...baseLines];
    const remoteLines = [...baseLines];
    localLines[leftIndex] = `LOCAL-${round}`;
    remoteLines[rightIndex] = `REMOTE-${round}`;
    const base = encoder.encode(`${baseLines.join("\n")}\n`).buffer;
    const local = encoder.encode(`${localLines.join("\n")}\n`).buffer;
    const remote = encoder.encode(`${remoteLines.join("\n")}\n`).buffer;
    const merged = mergeTextThreeWay(base, local, remote, limits);
    assert(merged.status === "merged", `Independent merge property failed in round ${round}.`);
    const expected = [...baseLines]; expected[leftIndex] = `LOCAL-${round}`; expected[rightIndex] = `REMOTE-${round}`;
    assert(decoder.decode(merged.bytes) === `${expected.join("\n")}\n`, `Independent merge property lost content in round ${round}.`);

    const collisionLines = [...baseLines]; collisionLines[leftIndex] = `REMOTE-CONFLICT-${round}`;
    const collision = mergeTextThreeWay(base, local, encoder.encode(`${collisionLines.join("\n")}\n`).buffer, limits);
    assert(collision.status === "blocked", `Overlapping merge property did not fail closed in round ${round}.`);
  }
}


async function testExecutorOverlapFailsClosed(): Promise<void> {
  const encoder = new TextEncoder();
  const base = encoder.encode("A\nB\n").buffer;
  let localBytes = encoder.encode("A\nLOCAL\n").buffer;
  let remoteBytes = encoder.encode("A\nREMOTE\n").buffer;
  const baseHash = await sha256Hex(base);
  const localHash = await sha256Hex(localBytes);
  const remoteHash = await sha256Hex(remoteBytes);
  const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
  await store.putBlob(base);
  await store.transact("stage12-conflict-seed", (tx) => tx.putFile({
    entryId: "stage12-conflict", path: "Notes/Conflict.md", status: "conflict",
    baseline: { blobHash: baseHash, size: base.byteLength, createdAt: new Date().toISOString(), path: "Notes/Conflict.md", remoteFileId: "601", remoteEtag: '"base"' },
    local: { path: "Notes/Conflict.md", contentHash: localHash, size: localBytes.byteLength, mtimeMs: 10 },
    remote: { path: "Notes/Conflict.md", contentHash: remoteHash, reportedSha256: null, etag: '"remote"', fileId: "601", size: remoteBytes.byteLength, mtimeMs: 11 }
  }));
  const plan = await new SyncPlanner().build(store.getState());
  let mutations = 0;
  const local = {
    async readVerified(path: string, expectedHash: string) {
      assert(await sha256Hex(localBytes) === expectedHash, "Conflict local fence failed.");
      return { path, bytes: localBytes.slice(0), contentHash: expectedHash, size: localBytes.byteLength, mtimeMs: 10 };
    },
    async writeAtomic(): Promise<LocalWriteResult> { mutations += 1; throw new Error("Overlapping merge must not write local bytes."); },
    async prepareSnapshot(): Promise<PreparedLocalSnapshot> { throw new Error("Blocked merge must not establish a new baseline."); }
  } as unknown as LocalTransactionalMutator;
  const remote = {
    async openDownload(_url: string, path: string, fileId: string | null, etag: string | null): Promise<RemoteDownloadStream> {
      const bytes = remoteBytes.slice(0); const hash = await sha256Hex(bytes);
      const state: RemoteReplicaState = { path, contentHash: hash, reportedSha256: null, etag, fileId, size: bytes.byteLength, mtimeMs: 11 };
      return { chunks: (async function* () { yield bytes; })(), completed: Promise.resolve({ contentHash: hash, remote: state, bytesTransferred: bytes.byteLength, ranged: false }) };
    },
    async uploadUpdate() { mutations += 1; throw new Error("Overlapping merge must not write remote bytes."); }
  } as unknown as RemoteTransactionalMutator;
  const executor = new TransactionalSyncExecutor(store, local, remote, `${server}/remote.php/dav/files/${userId}/`, "Obsidian", tuning, logger);
  const beforeGeneration = store.getState().generation;
  const report = await executor.execute(plan, { allowDestructive: false, allowMerge: true, maxOperations: 20 });
  assert(report.mergeConflicts === 1 && report.blocked >= 1 && mutations === 0, "Overlapping merge did not fail closed without writes.");
  assert(store.getState().generation === beforeGeneration, "Blocked merge must not advance durable state generation.");
}

async function testBlockedMergeKeepsVerifiedRemoteHash(): Promise<void> {
  const encoder = new TextEncoder();
  const base = encoder.encode("A\nB\n").buffer;
  const localBytes = encoder.encode("A\nLOCAL\n").buffer;
  const remoteBytes = encoder.encode("A\nREMOTE\n").buffer;
  const baseHash = await sha256Hex(base);
  const localHash = await sha256Hex(localBytes);
  const remoteHash = await sha256Hex(remoteBytes);
  const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
  await store.putBlob(base);
  await store.transact("conflict-seed", (tx) => tx.putFile({
    entryId: "conflict-unverified", path: "Notes/Conflict.md", status: "conflict",
    baseline: { blobHash: baseHash, size: base.byteLength, createdAt: new Date().toISOString(), path: "Notes/Conflict.md", remoteFileId: "602", remoteEtag: '"base"' },
    local: { path: "Notes/Conflict.md", contentHash: localHash, size: localBytes.byteLength, mtimeMs: 10 },
    remote: { path: "Notes/Conflict.md", contentHash: null, reportedSha256: null, etag: '"remote"', fileId: "602", size: remoteBytes.byteLength, mtimeMs: 11 }
  }));
  const plan = await new SyncPlanner().build(store.getState());
  const local = {
    async readVerified(path: string, expectedHash: string) { return { path, bytes: localBytes.slice(0), contentHash: expectedHash, size: localBytes.byteLength, mtimeMs: 10 }; },
    async writeAtomic(): Promise<LocalWriteResult> { throw new Error("Overlapping merge must not write local bytes."); }
  } as unknown as LocalTransactionalMutator;
  const remote = {
    async openDownload(_url: string, path: string, fileId: string | null, etag: string | null): Promise<RemoteDownloadStream> {
      const state: RemoteReplicaState = { path, contentHash: remoteHash, reportedSha256: null, etag, fileId, size: remoteBytes.byteLength, mtimeMs: 11 };
      return { chunks: (async function* () { yield remoteBytes.slice(0); })(), completed: Promise.resolve({ contentHash: remoteHash, remote: state, bytesTransferred: remoteBytes.byteLength, ranged: false }) };
    },
    async uploadUpdate() { throw new Error("Overlapping merge must not write remote bytes."); }
  } as unknown as RemoteTransactionalMutator;
  const executor = new TransactionalSyncExecutor(store, local, remote, `${server}/remote.php/dav/files/${userId}/`, "Obsidian", tuning, logger);
  const report = await executor.execute(plan, { allowDestructive: false, allowMerge: true, maxOperations: 20 });
  assert(report.mergeConflicts === 1, "The overlapping merge should have been blocked.");
  assert(store.getState().files["conflict-unverified"]?.remote?.contentHash === remoteHash, "A blocked merge must keep the remote hash it verified, so an explicit choice is possible.");
}

async function testExecutorThreeWayConvergence(): Promise<void> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const base = encoder.encode("A\nB\nC\nD\n").buffer;
  let localBytes = encoder.encode("A\nLOCAL\nC\nD\n").buffer;
  let remoteBytes = encoder.encode("A\nB\nC\nREMOTE\n").buffer;
  const baseHash = await sha256Hex(base);
  const localHash = await sha256Hex(localBytes);
  const remoteHash = await sha256Hex(remoteBytes);
  const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
  await store.putBlob(base);
  await store.transact("stage12-merge-seed", (tx) => tx.putFile({
    entryId: "stage12-merge", path: "Notes/Merge.md", status: "conflict",
    baseline: { blobHash: baseHash, size: base.byteLength, createdAt: new Date().toISOString(), path: "Notes/Merge.md", remoteFileId: "501", remoteEtag: '"base"' },
    local: { path: "Notes/Merge.md", contentHash: localHash, size: localBytes.byteLength, mtimeMs: 10 },
    remote: { path: "Notes/Merge.md", contentHash: remoteHash, reportedSha256: null, etag: '"remote"', fileId: "501", size: remoteBytes.byteLength, mtimeMs: 11 }
  }));
  const plan = await new SyncPlanner().build(store.getState());
  assert(plan.items[0]?.disposition === "merge-candidate", "Planner did not produce a Stage 12 merge candidate.");

  const local = {
    async readVerified(path: string, expectedHash: string) {
      const actual = await sha256Hex(localBytes);
      assert(actual === expectedHash, "Runtime local merge fence failed.");
      return { path, bytes: localBytes.slice(0), contentHash: actual, size: localBytes.byteLength, mtimeMs: 10 };
    },
    async writeAtomic(path: string, bytes: ArrayBuffer, expectedHash: string | null): Promise<LocalWriteResult> {
      if (expectedHash) assert(await sha256Hex(localBytes) === expectedHash, "Runtime local write precondition failed.");
      localBytes = bytes.slice(0);
      return { path, contentHash: await sha256Hex(localBytes), size: localBytes.byteLength, mtimeMs: 12 };
    },
    async prepareSnapshot(path: string, expectedHash: string): Promise<PreparedLocalSnapshot> {
      assert(await sha256Hex(localBytes) === expectedHash, "Runtime baseline snapshot fence failed.");
      return makeTextSnapshot(path, localBytes, expectedHash);
    }
  } as unknown as LocalTransactionalMutator;

  const remote = {
    async openDownload(_url: string, path: string, fileId: string | null, etag: string | null): Promise<RemoteDownloadStream> {
      const bytes = remoteBytes.slice(0);
      const hash = await sha256Hex(bytes);
      const remoteState: RemoteReplicaState = { path, contentHash: hash, reportedSha256: null, etag, fileId, size: bytes.byteLength, mtimeMs: 11 };
      return { chunks: (async function* () { yield bytes; })(), completed: Promise.resolve({ contentHash: hash, remote: remoteState, bytesTransferred: bytes.byteLength, ranged: false }) };
    },
    async uploadUpdate(_url: string, path: string, bytes: ArrayBuffer, fileId: string | null, _etag: string | null) {
      remoteBytes = bytes.slice(0);
      const hash = await sha256Hex(remoteBytes);
      return { bytes: remoteBytes.slice(0), contentHash: hash, remote: { path, contentHash: hash, reportedSha256: null, etag: '"merged"', fileId, size: remoteBytes.byteLength, mtimeMs: 12 } };
    }
  } as unknown as RemoteTransactionalMutator;

  const executor = new TransactionalSyncExecutor(store, local, remote, `${server}/remote.php/dav/files/${userId}/`, "Obsidian", tuning, logger);
  const report = await executor.execute(plan, { allowDestructive: false, allowMerge: true, mergeLimits: { maxInputBytes: 2 * MIB, maxLines: 12_000, maxDiffCells: 8_000_000 }, maxOperations: 20 });
  assert(report.mergedFiles === 1 && report.blocked === 0 && report.failed === 0, "Executor did not commit the safe merge.");
  assert(decoder.decode(localBytes) === "A\nLOCAL\nC\nREMOTE\n", "Local replica did not converge to the merged bytes.");
  assert(decoder.decode(remoteBytes) === "A\nLOCAL\nC\nREMOTE\n", "Remote replica did not converge to the merged bytes.");
  const record = store.getState().files["stage12-merge"];
  assert(record?.status === "clean" && record.baseline?.blobHash === record.local?.contentHash && record.remote?.contentHash === record.local?.contentHash, "BASE did not advance only after replica convergence.");
}

function makeTextSnapshot(path: string, bytesInput: ArrayBuffer, hash: string): PreparedLocalSnapshot {
  const bytes = bytesInput.slice(0);
  return {
    snapshotId: "stage12-text-snapshot", path, contentHash: hash, size: bytes.byteLength, mtimeMs: 12,
    chunkSize: Math.max(1, bytes.byteLength), chunkCount: 1,
    async readChunk(index: number) { if (index !== 0) throw new Error("Invalid text snapshot chunk index."); return bytes.slice(0); },
    async *chunks() { yield bytes.slice(0); },
    async assertSourceUnchanged() { assert(await sha256Hex(bytes) === hash, "Text snapshot changed unexpectedly."); },
    async cleanup() {}
  };
}

async function testConflictFreeThreeWayMerge(): Promise<void> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const limits = { maxInputBytes: 2 * MIB, maxLines: 12_000, maxDiffCells: 8_000_000 };
  const base = encoder.encode("A\nB\nC\nD\n").buffer;
  const local = encoder.encode("A\nLOCAL\nC\nD\n").buffer;
  const remote = encoder.encode("A\nB\nC\nREMOTE\n").buffer;
  const merged = mergeTextThreeWay(base, local, remote, limits);
  assert(merged.status === "merged", "Independent Stage 12 edits were not merged.");
  assert(decoder.decode(merged.bytes) === "A\nLOCAL\nC\nREMOTE\n", "Three-way merge output lost an independent edit.");

  const conflict = mergeTextThreeWay(
    encoder.encode("A\nB\n").buffer,
    encoder.encode("A\nLOCAL\n").buffer,
    encoder.encode("A\nREMOTE\n").buffer,
    limits
  );
  assert(conflict.status === "blocked", "Overlapping Stage 12 edits must fail closed.");
  if (conflict.status === "blocked") assert(conflict.reason === "overlapping-edits", "Overlap was blocked for the wrong reason.");

  const fresh = normalizeSettings(null);
  assert(fresh.autoMergeText === true && fresh.autoMergeMaxMiB === 2, "Fresh installs must enable bounded safe text merge defaults.");
  const upgraded = normalizeSettings({ schemaVersion: 6, remoteRootPath: "Obsidian", connectionState: "disconnected" });
  assert(upgraded.autoMergeText === true, "Legacy installs without an explicit merge opt-out must enable bounded safe merge.");
  const optedOut = normalizeSettings({ schemaVersion: 8, autonomyDefaultsVersion: 1, remoteRootPath: "Obsidian", connectionState: "disconnected", autoMergeText: false });
  assert(optedOut.autoMergeText === false, "A merge opt-out made after the autonomous defaults upgrade must survive settings migration.");
}


async function testConvergenceAudit(): Promise<void> {
  const bytes = new TextEncoder().encode("stage12-clean\n").buffer;
  const hash = await sha256Hex(bytes);
  const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
  await store.putBlob(bytes);
  await store.transact("stage12-audit-seed", (tx) => tx.putFile({
    entryId: "file_stage12_audit", path: "Notes/Audit.md", status: "clean",
    baseline: { blobHash: hash, size: bytes.byteLength, createdAt: new Date().toISOString(), path: "Notes/Audit.md", remoteFileId: "audit-71", remoteEtag: '"audit-e1"' },
    local: { path: "Notes/Audit.md", contentHash: hash, size: bytes.byteLength, mtimeMs: 1 },
    remote: { path: "Notes/Audit.md", contentHash: hash, reportedSha256: null, etag: '"audit-e1"', fileId: "audit-71", size: bytes.byteLength, mtimeMs: 1 }
  }));
  const report = await new ConvergenceAuditor(store).audit({ mode: "deep" });
  assert(report.status === "healthy" && report.errors === 0 && report.verifiedCleanRecords === 1, "Convergence audit rejected a valid clean record.");

  const soak = await runConvergenceSoak(0x12c0ffee, 750);
  assert(soak.rounds === 750 && soak.deterministicPlans === 750, "Deterministic soak did not complete all rounds.");
}

function makeSnapshot(data: Uint8Array, hash: string, chunkSize: number): PreparedLocalSnapshot {
  const chunkCount = Math.max(1, Math.ceil(data.byteLength / chunkSize));
  return {
    snapshotId: "stage12-runtime-snapshot",
    path: "Chunked.bin",
    contentHash: hash,
    size: data.byteLength,
    mtimeMs: 1,
    chunkSize,
    chunkCount,
    async readChunk(index: number) {
      const bounds = chunkBounds(index, data.byteLength, chunkSize);
      const out = new Uint8Array(bounds.size);
      out.set(data.subarray(bounds.start, bounds.endExclusive));
      return out.buffer;
    },
    async *chunks() { for (let i = 0; i < chunkCount; i += 1) yield await this.readChunk(i); },
    async assertSourceUnchanged() {},
    async cleanup() {}
  };
}

function patterned(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 29 + 11) & 0xff;
  return out;
}


describe("runtime behaviour self-test", () => {
  it("fails closed on ambiguous direct mutations", async () => { await testAmbiguousDirectMutations(); });
  it("fences retries and ranged reads", async () => { await testRetryAndRangeFences(); });
  it("reconciles an ambiguous chunk PUT", async () => { await testAmbiguousChunkPut(); });
  it("recovers local ambiguous completion", async () => { await testLocalAmbiguousCompletion(); });
  it("health checks and quiet-period auto-sync", async () => { await testHealthAndQuietAutosync(); });
  it("cross-device bootstrap", async () => { await testCrossDeviceBootstrap(); });
  it("conflict-free three-way merge", async () => { await testConflictFreeThreeWayMerge(); });
  it("merge property matrix", () => { testMergePropertyMatrix(); });
  it("a blocked merge keeps the remote hash it verified", async () => { await testBlockedMergeKeepsVerifiedRemoteHash(); });
  it("executor three-way convergence", async () => { await testExecutorThreeWayConvergence(); });
  it("executor fails closed on overlap", async () => { await testExecutorOverlapFailsClosed(); });
  it("convergence audit", async () => { await testConvergenceAudit(); });
});
