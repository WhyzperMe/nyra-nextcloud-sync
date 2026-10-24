import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { TransactionalSyncExecutor } from "../src/execution/executor";
import type { LocalTransactionalMutator, PreparedLocalSnapshot } from "../src/execution/local-mutator";
import type { RemoteDownloadStream, RemoteTransactionalMutator } from "../src/execution/remote-mutator";
import { AUTO_RESOLUTION_TIME_TOLERANCE_MS, decideAutoResolution, makeAutoResolutionPlan } from "../src/planner/auto-resolution";
import { applyCollisionRepair, planCollisionRepair } from "../src/planner/collision-repair";
import { SyncPlanner } from "../src/planner/planner";
import type { SyncPlan } from "../src/planner/types";
import { SyncCycleRunner, type SyncCyclePort } from "../src/sync/cycle-runner";
import { sha256Hex } from "../src/state/durable/crypto";
import type { FileReplicaInput, LocalReplicaState, RemoteReplicaState } from "../src/state/durable/model";
import { DurableStateStore } from "../src/state/durable/store";
import type { TransferTuning } from "../src/transfer/types";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const tuning: TransferTuning = { chunkUploadThresholdBytes: 5 * 1024 * 1024, uploadChunkBytes: 5 * 1024 * 1024, downloadRangeChunkBytes: 1024 * 1024, maxWholeDownloadBytes: 5 * 1024 * 1024 };
const enc = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const now = new Date().toISOString();
const H1 = "1".repeat(64), H2 = "2".repeat(64), H9 = "9".repeat(64), HA = "a".repeat(64), HB = "b".repeat(64), HO = "c".repeat(64), HD = "d".repeat(64), HE = "e".repeat(64);

const local = (path: string, hash: string, mtimeMs = 1_000): LocalReplicaState => ({ path, contentHash: hash, size: 4, mtimeMs });
const remote = (path: string, hash: string | null, fileId: string, mtimeMs: number | null = 1_000): RemoteReplicaState =>
  ({ path, contentHash: hash, reportedSha256: null, etag: `"e-${fileId}"`, fileId, size: 4, mtimeMs });

async function openStore(): Promise<DurableStateStore> {
  return await DurableStateStore.open(new MemoryStateBackend(), logger);
}
async function seed(store: DurableStateStore, records: FileReplicaInput[]): Promise<void> {
  await store.transact("seed", (tx) => { for (const record of records) tx.putFile(record); });
}
async function repairAll(store: DurableStateStore): Promise<ReturnType<typeof planCollisionRepair>> {
  const repair = planCollisionRepair(store.getState());
  if (repair && repair.groups > 0) await store.transact("repair", (tx, base) => applyCollisionRepair(tx, base, repair));
  return repair;
}
const baselineOf = (path: string, hash: string, fileId: string) => ({ blobHash: hash, size: 4, createdAt: now, path, remoteFileId: fileId, remoteEtag: `"e-${fileId}"` });

describe("path collision repair", () => {
  it("re-pairs a local-only and a remote-only record that claim the same path", async () => {
    const store = await openStore();
    await seed(store, [
      { entryId: "file_AAAA", path: "Cartoon.png", baseline: null, local: local("Cartoon.png", H1), remote: null, status: "local-dirty" },
      { entryId: "file_BBBB", path: "Cartoon.png", baseline: null, local: null, remote: remote("Cartoon.png", H1, "7"), status: "remote-dirty" }
    ]);
    const before = await new SyncPlanner().build(store.getState());
    expect(before.items.map((item) => item.classification)).toEqual(["path-identity-collision", "path-identity-collision"]);

    const repair = await repairAll(store);
    expect(repair?.groups).toBe(1);
    const files = Object.values(store.getState().files);
    expect(files.length).toBe(1);
    expect(files[0]?.local?.contentHash).toBe(H1);
    expect(files[0]?.remote?.fileId).toBe("7");
    const after = await new SyncPlanner().build(store.getState());
    expect(after.items.map((item) => item.classification)).toEqual(["converged-unbaselined"]);
    expect(planCollisionRepair(store.getState())).toBeNull();
  });

  it("untangles a moved file whose old and new identities overlap (the screenshot case)", async () => {
    const store = await openStore();
    const baseBytes = enc("base");
    const baseHash = await sha256Hex(baseBytes);
    await store.putBlob(baseBytes);
    await seed(store, [
      { entryId: "file_XXXX", path: "Schule/Cartoon.png", baseline: baselineOf("Cartoon.png", baseHash, "5"), local: local("Schule/Cartoon.png", baseHash), remote: remote("Cartoon.png", baseHash, "5"), status: "local-dirty" },
      { entryId: "file_YYYY", path: "Schule/Cartoon.png", baseline: null, local: null, remote: remote("Schule/Cartoon.png", baseHash, "9"), status: "remote-dirty" },
      { entryId: "file_ZZZZ", path: "Cartoon.png", baseline: null, local: local("Cartoon.png", HO), remote: null, status: "local-dirty" }
    ]);
    const before = await new SyncPlanner().build(store.getState());
    expect(before.items.every((item) => item.classification === "path-identity-collision")).toBe(true);

    await repairAll(store);
    const files = Object.values(store.getState().files);
    expect(files.length).toBe(2);
    const schule = files.find((file) => file.local?.path === "Schule/Cartoon.png");
    const root = files.find((file) => file.local?.path === "Cartoon.png");
    expect(schule?.remote?.fileId).toBe("9");
    expect(root?.remote?.fileId).toBe("5");
    // The baseline only survives where its own path is paired again.
    expect(root?.baseline?.path).toBe("Cartoon.png");
    expect(schule?.baseline).toBeNull();
    const after = await new SyncPlanner().build(store.getState());
    expect(after.items.some((item) => item.classification === "path-identity-collision")).toBe(false);
    expect(after.items.every((item) => item.steps.every((step) => !step.destructive))).toBe(true);
  });

  it("clears stale tombstones of re-paired entries and keeps every replica", async () => {
    const store = await openStore();
    await seed(store, [
      { entryId: "file_AAAA", path: "N.md", baseline: null, local: local("N.md", H1), remote: null, status: "local-dirty" },
      { entryId: "file_BBBB", path: "N.md", baseline: null, local: null, remote: remote("N.md", H2, "3"), status: "remote-dirty" }
    ]);
    await store.transact("tomb", (tx) => tx.putTombstone({ tombstoneId: "tomb_0001", entryId: "file_BBBB", previousPath: "N.md", deletedSide: "remote", previousBlobHash: null, previousRemoteFileId: "1", createdAt: now }));
    await repairAll(store);
    expect(Object.keys(store.getState().tombstones)).toEqual([]);
    const [record] = Object.values(store.getState().files);
    expect(record?.local?.contentHash).toBe(H1);
    expect(record?.remote?.contentHash).toBe(H2);
  });

  it("leaves genuine letter-case aliases of two different files alone", async () => {
    const store = await openStore();
    await seed(store, [
      { entryId: "file_AAAA", path: "a.md", baseline: null, local: local("a.md", H1), remote: null, status: "local-dirty" },
      { entryId: "file_BBBB", path: "A.md", baseline: null, local: null, remote: remote("A.md", H2, "3"), status: "remote-dirty" }
    ]);
    const repair = planCollisionRepair(store.getState());
    expect(repair?.groups).toBe(0);
    expect(repair?.unrepairable).toBe(1);
    expect(repair?.puts).toEqual([]);
    expect(Object.keys(store.getState().files).sort()).toEqual(["file_AAAA", "file_BBBB"]);
  });

  it("does nothing when no two records collide", async () => {
    const store = await openStore();
    await seed(store, [
      { entryId: "file_AAAA", path: "a.md", baseline: null, local: local("a.md", H1), remote: null, status: "local-dirty" },
      { entryId: "file_BBBB", path: "b.md", baseline: null, local: null, remote: remote("b.md", H2, "3"), status: "remote-dirty" }
    ]);
    expect(planCollisionRepair(store.getState())).toBeNull();
  });
});

async function conflictItem(options: { path?: string; localHash?: string; remoteHash?: string | null; localTime?: number; remoteTime?: number | null }): Promise<{ item: SyncPlan["items"][number]; record: ReturnType<DurableStateStore["getState"]>["files"][string] }> {
  const store = await openStore();
  const path = options.path ?? "Notes/Image.png";
  const baseBytes = enc("base");
  const baseHash = await sha256Hex(baseBytes);
  await store.putBlob(baseBytes);
  await seed(store, [{
    entryId: "file_CCCC", path, status: "conflict",
    baseline: baselineOf(path, baseHash, "5"),
    local: local(path, options.localHash ?? HA, options.localTime ?? 10_000),
    remote: remote(path, options.remoteHash === undefined ? HB : options.remoteHash, "5", options.remoteTime === undefined ? 20_000 : options.remoteTime)
  }]);
  const plan = await new SyncPlanner().build(store.getState());
  return { item: plan.items[0]!, record: store.getState().files.file_CCCC! };
}

describe("autonomous conflict policy", () => {
  it("keeps the newer remote version and the newer local version, preserving the other", async () => {
    const remoteNewer = await conflictItem({ localTime: 10_000, remoteTime: 60_000 });
    expect(remoteNewer.item.classification).toBe("both-change");
    expect(decideAutoResolution(remoteNewer.item, remoteNewer.record)?.kind).toBe("keep-remote");
    const localNewer = await conflictItem({ localTime: 90_000, remoteTime: 20_000 });
    expect(decideAutoResolution(localNewer.item, localNewer.record)?.kind).toBe("keep-local");
  });

  it("breaks ties and unknown times by content hash, identically on every device", async () => {
    const delta = AUTO_RESOLUTION_TIME_TOLERANCE_MS;
    const closeA = await conflictItem({ localHash: H9, remoteHash: H1, localTime: 50_000, remoteTime: 50_000 + delta });
    expect(decideAutoResolution(closeA.item, closeA.record)?.kind).toBe("keep-local");
    // The same two contents seen from another device (roles swapped) pick the same winner content.
    const closeB = await conflictItem({ localHash: H1, remoteHash: H9, localTime: 50_000 + delta, remoteTime: 50_000 });
    expect(decideAutoResolution(closeB.item, closeB.record)?.kind).toBe("keep-remote");
    const unknown = await conflictItem({ localHash: H1, remoteHash: H9, remoteTime: null });
    expect(decideAutoResolution(unknown.item, unknown.record)?.kind).toBe("keep-remote");
  });

  it("also settles text conflicts that the merge engine had to give up on, and concurrent creates", async () => {
    const overlapping = await conflictItem({ path: "Notes/Doc.md", localTime: 70_000, remoteTime: 10_000 });
    expect(overlapping.item.disposition).toBe("merge-candidate");
    expect(decideAutoResolution(overlapping.item, overlapping.record)?.kind).toBe("keep-local");

    const store = await openStore();
    await seed(store, [{ entryId: "file_NNNN", path: "New.png", baseline: null, local: local("New.png", HA, 5_000), remote: remote("New.png", HB, "8", 9_000), status: "both-dirty" }]);
    const plan = await new SyncPlanner().build(store.getState());
    expect(plan.items[0]?.classification).toBe("concurrent-create");
    expect(decideAutoResolution(plan.items[0]!, store.getState().files.file_NNNN!)?.kind).toBe("keep-remote");
  });

  it("never decides without a verified remote hash or when the content already matches", async () => {
    const unverified = await conflictItem({ remoteHash: null });
    expect(decideAutoResolution(unverified.item, unverified.record)).toBeNull();
    const converged = await conflictItem({ localHash: HD, remoteHash: HD });
    expect(decideAutoResolution(converged.item, converged.record)).toBeNull();
  });

  it("lets a change win over a deletion in both directions, and the Nextcloud name win a rename clash", async () => {
    const store = await openStore();
    const baseBytes = enc("base");
    const baseHash = await sha256Hex(baseBytes);
    await store.putBlob(baseBytes);
    await seed(store, [
      { entryId: "file_D001", path: "d1.md", baseline: baselineOf("d1.md", baseHash, "1"), local: null, remote: remote("d1.md", HE, "1"), status: "conflict" },
      { entryId: "file_D002", path: "d2.md", baseline: baselineOf("d2.md", baseHash, "2"), local: local("d2.md", HE), remote: null, status: "conflict" },
      { entryId: "file_R001", path: "old.md", baseline: baselineOf("old.md", baseHash, "3"), local: local("mine.md", baseHash), remote: remote("theirs.md", baseHash, "3"), status: "conflict" }
    ]);
    const plan = await new SyncPlanner().build(store.getState());
    const kinds = Object.fromEntries(plan.items.map((item) => [item.entryId, [item.classification, decideAutoResolution(item, store.getState().files[item.entryId]!)?.kind]]));
    expect(kinds).toEqual({
      file_D001: ["delete-vs-change", "restore-local"],
      file_D002: ["delete-vs-change", "restore-remote"],
      file_R001: ["rename-conflict", "adopt-remote-path"]
    });
  });

  it("builds restore and rename plans that bind to the current state and never delete", async () => {
    const store = await openStore();
    const baseBytes = enc("base");
    const baseHash = await sha256Hex(baseBytes);
    await store.putBlob(baseBytes);
    await seed(store, [
      { entryId: "file_D001", path: "d1.md", baseline: baselineOf("d1.md", baseHash, "1"), local: null, remote: remote("d1.md", HE, "1"), status: "conflict" },
      { entryId: "file_D002", path: "d2.md", baseline: baselineOf("d2.md", baseHash, "2"), local: local("d2.md", HE), remote: null, status: "conflict" },
      { entryId: "file_R001", path: "old.md", baseline: baselineOf("old.md", baseHash, "3"), local: local("mine.md", baseHash), remote: remote("theirs.md", baseHash, "3"), status: "conflict" }
    ]);
    const plan = await new SyncPlanner().build(store.getState());
    const steps = async (id: string, kind: "restore-local" | "restore-remote" | "adopt-remote-path"): Promise<string[]> => {
      const built = await makeAutoResolutionPlan(plan, id, { kind, reason: "test" });
      expect(built.summary.destructiveSteps).toBe(0);
      expect(built.items[0]?.disposition).toBe("ready");
      return built.items[0]!.steps.map((step) => `${step.kind}:${step.sourcePath ?? ""}>${step.targetPath ?? ""}`);
    };
    expect(await steps("file_D001", "restore-local")).toEqual(["download-create:d1.md>d1.md", "establish-baseline:d1.md>"]);
    expect(await steps("file_D002", "restore-remote")).toEqual(["upload-create:d2.md>d2.md", "establish-baseline:d2.md>"]);
    expect(await steps("file_R001", "adopt-remote-path")).toEqual(["move-local:mine.md>theirs.md"]);
  });

  it("executes a restore: a file deleted here comes back with a verified baseline", async () => {
    const store = await openStore();
    const baseBytes = enc("base");
    const baseHash = await sha256Hex(baseBytes);
    await store.putBlob(baseBytes);
    const newBytes = enc("new!");
    const newHash = await sha256Hex(newBytes);
    await seed(store, [{ entryId: "file_D001", path: "d1.md", baseline: baselineOf("d1.md", baseHash, "1"), local: null, remote: remote("d1.md", newHash, "1"), status: "conflict" }]);
    const plan = await new SyncPlanner().build(store.getState());
    expect(plan.items[0]?.classification).toBe("delete-vs-change");
    const restorePlan = await makeAutoResolutionPlan(plan, "file_D001", decideAutoResolution(plan.items[0]!, store.getState().files.file_D001!)!);

    const written: string[] = [];
    const snapshot = (path: string): PreparedLocalSnapshot => ({
      snapshotId: "s", path, contentHash: newHash, size: newBytes.byteLength, mtimeMs: 5, chunkSize: newBytes.byteLength, chunkCount: 1,
      async readChunk() { return newBytes.slice(0); }, async *chunks() { yield newBytes.slice(0); }, async assertSourceUnchanged() {}, async cleanup() {}
    });
    const localMutator = {
      async writeAtomicFromChunks(path: string, chunks: AsyncIterable<ArrayBuffer>, expectedHash: string | null) {
        expect(expectedHash).toBeNull(); // the path must still be free
        for await (const chunk of chunks) expect(chunk.byteLength).toBe(newBytes.byteLength);
        written.push(path);
        return { path, contentHash: newHash, size: newBytes.byteLength, mtimeMs: 5 };
      },
      async prepareSnapshot(path: string) { return snapshot(path); }
    } as unknown as LocalTransactionalMutator;
    const remoteMutator = {
      async openDownload(_url: string, path: string, fileId: string | null, etag: string | null): Promise<RemoteDownloadStream> {
        const state: RemoteReplicaState = { path, contentHash: newHash, reportedSha256: null, etag, fileId, size: newBytes.byteLength, mtimeMs: 5 };
        return { chunks: (async function* () { yield newBytes.slice(0); })(), completed: Promise.resolve({ contentHash: newHash, remote: state, bytesTransferred: newBytes.byteLength, ranged: false }) };
      }
    } as unknown as RemoteTransactionalMutator;
    const executor = new TransactionalSyncExecutor(store, localMutator, remoteMutator, "https://cloud.example.test/remote.php/dav/files/u/", "Obsidian", tuning, logger);
    const report = await executor.execute(restorePlan, { allowDestructive: false, allowMerge: false, maxOperations: 20 });
    expect(report.failed).toBe(0);
    expect(report.blocked).toBe(0);
    expect(written).toEqual(["d1.md"]);
    const record = store.getState().files.file_D001;
    expect(record?.local?.contentHash).toBe(newHash);
    expect(record?.baseline?.blobHash).toBe(newHash);
    expect(record?.status).toBe("clean");
  });
});

describe("sync cycle", () => {
  function port(overrides: Partial<SyncCyclePort>): SyncCyclePort {
    const plan = { summary: { total: 1, noop: 0, ready: 0, needsVerification: 0, mergeCandidates: 0, blocked: 2, destructiveSteps: 0, remoteVerifications: 0 } } as SyncPlan;
    return {
      localFactsComplete: () => true, remoteFactsComplete: () => true, lastFullLocalScanAt: () => 0, now: () => 1,
      flushLocalHints: async () => {}, waitForLocalInventory: async () => {}, scanLocalFull: async () => true, scanRemoteFull: async () => true,
      buildPlan: async () => plan, autoMergeEnabled: () => true, applyPlan: async () => { throw new Error("nothing is executable"); },
      syncFolders: async () => 0, ...overrides
    };
  }

  it("settles blocked conflicts through the autonomous resolver and reports what remains", async () => {
    let calls = 0;
    const result = await new SyncCycleRunner(port({ autoResolveConflicts: async () => { calls += 1; return 2; } })).run("manual", false);
    expect(calls).toBe(1);
    expect(result.reviewItems).toBe(0);
    expect(result.executed).toBe(true);
    expect(result.completedSteps).toBe(2);
  });

  it("keeps unresolved conflicts visible and works without a resolver", async () => {
    const partial = await new SyncCycleRunner(port({ autoResolveConflicts: async () => 1 })).run("manual", false);
    expect(partial.reviewItems).toBe(1);
    const none = await new SyncCycleRunner(port({})).run("manual", false);
    expect(none.reviewItems).toBe(2);
    expect(none.executed).toBe(false);
  });
});
