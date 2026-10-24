import type { Logger } from "../diagnostics/logger";
import { mergeTextThreeWay } from "../merge/text-merge";
import type { TextMergeBlockedReason, TextMergeLimits } from "../merge/types";
import type { SyncPlan, SyncPlanItem, SyncPlanStep } from "../planner/types";
import { appendWebdavPath } from "../remote/path";
import type { DurableState, FileReplicaRecord, LocalReplicaState, RemoteReplicaState } from "../state/durable/model";
import type { DurableStateStore, DurableTransaction } from "../state/durable/store";
import { AsyncMutex } from "../state/durable/mutex";
import { deriveFileSyncStatus } from "../sync/derived-status";
import { planNextcloudChunks } from "../transfer/chunking";
import type { TransferTuning } from "../transfer/types";
import { assertPlanMatchesState } from "./preconditions";
import type { ExecutionMode, ExecutionPolicy, ExecutionReport, ExecutionRuntimeSummary, ExecutionStepResult } from "./types";
import type { LocalTransactionalMutator, LocalWriteResult, PreparedLocalSnapshot } from "./local-mutator";
import type { RemoteTransactionalMutator, TransferProgressCallback } from "./remote-mutator";

/**
 * Executes one immutable planner result against exact preconditions.
 *
 * Important ownership rule: this class is the only logical apply writer. Network
 * reads/writes may be chunked, but durable publication remains one serialized WAL
 * transaction after all physical postconditions have been proven.
 */
export class TransactionalSyncExecutor {
  private readonly mutex = new AsyncMutex();
  private closed = false;
  private runtime: ExecutionRuntimeSummary = emptyRuntime();

  constructor(
    private readonly store: DurableStateStore,
    private readonly local: LocalTransactionalMutator,
    private readonly remote: RemoteTransactionalMutator,
    private readonly webdavRootUrl: string,
    private readonly remoteRootPath: string,
    private readonly tuning: TransferTuning,
    private readonly logger: Logger,
    private readonly onRuntimeChange?: () => void
  ) {}

  summary(): ExecutionRuntimeSummary { return structuredClone(this.runtime); }
  close(): void { this.closed = true; this.runtime.status = "closed"; }

  async execute(plan: SyncPlan, policy: ExecutionPolicy): Promise<ExecutionReport> {
    return await this.mutex.runExclusive(async () => {
      this.assertOpen();
      const startedAt = new Date().toISOString();
      const state = this.store.getState();
      await assertPlanMatchesState(plan, state);
      const executable = plan.items.filter((item) =>
        item.disposition === "ready" ||
        item.disposition === "needs-verification" ||
        (policy.allowMerge && item.disposition === "merge-candidate")
      );
      const totalSteps = executable.reduce((sum, item) => sum + item.steps.length, 0);
      if (totalSteps > policy.maxOperations) throw new Error(`Plan has ${totalSteps} executable steps, exceeding the safety limit of ${policy.maxOperations}.`);

      this.runtime = {
        status: "preparing", activePlanFingerprint: plan.fingerprint, startedAt,
        lastCompletedAt: this.runtime.lastCompletedAt, completedSteps: 0, totalSteps,
        bytesProcessed: 0, activeTransferBytes: 0, activeTransferTotalBytes: null,
        chunkedTransfers: 0, resumedTransfers: 0, rangedDownloads: 0,
        mergedFiles: 0, mergeConflicts: 0, lastError: null,
        activeAction: null, activePath: null
      };

      const shadow = new Map<string, FileReplicaRecord>();
      for (const [id, record] of Object.entries(state.files)) shadow.set(id, structuredClone(record));
      const retired = new Set<string>();
      const results: ExecutionStepResult[] = [];

      try {
        this.runtime.status = "running";
        for (const item of executable) {
          const record = shadow.get(item.entryId);
          if (!record) throw new Error(`Planned entry '${item.entryId}' no longer exists in the execution snapshot.`);
          let itemBlocked = false;
          for (const step of item.steps) {
            if (itemBlocked) {
              results.push(result(item, step, "skipped", "Skipped because an earlier step for this entry was blocked."));
              continue;
            }
            const mode = policy.mode ?? "bidirectional";
            if (!stepAllowedInMode(step.kind, mode)) {
              results.push(result(item, step, "blocked", `Step is outside the ${mode} execution boundary.`));
              itemBlocked = true;
              continue;
            }
            if (step.kind === "manual-resolution") {
              results.push(result(item, step, "blocked", "This item requires explicit conflict resolution."));
              itemBlocked = true;
              continue;
            }
            if (step.kind === "merge-text" && !policy.allowMerge) {
              results.push(result(item, step, "blocked", "Safe automatic text merge is disabled in settings."));
              itemBlocked = true;
              continue;
            }
            if (step.destructive && !policy.allowDestructive) {
              results.push(result(item, step, "blocked", "Destructive execution is disabled by the execution policy."));
              itemBlocked = true;
              continue;
            }
            if (step.requiresFreshRemoteEtag && record.remote && !record.remote.etag) {
              throw new Error(`Remote mutation/verification for '${item.displayPath}' requires an ETag, but Nextcloud did not provide one.`);
            }
            this.runtime.activeAction = actionForStep(step.kind);
            this.runtime.activePath = step.targetPath ?? step.sourcePath ?? item.displayPath;
            this.runtime.activeTransferBytes = 0;
            this.runtime.activeTransferTotalBytes = expectedTransferSize(record, step);
            this.onRuntimeChange?.();
            try {
              await this.executeStep(record, step, item, retired, policy);
              results.push(result(item, step, "completed", step.kind === "merge-text"
                ? "Conflict-free three-way text merge committed and verified on both replicas."
                : "Completed with fresh preconditions and verified postconditions.", record));
              this.runtime.completedSteps += 1;
            } catch (error) {
              if (error instanceof AutomaticMergeBlockedError) {
                this.runtime.mergeConflicts += 1;
                results.push(result(item, step, "blocked", error.message));
                itemBlocked = true;
                continue;
              }
              throw error;
            } finally {
              this.runtime.activeAction = null;
              this.runtime.activePath = null;
              this.runtime.activeTransferBytes = 0;
              this.runtime.activeTransferTotalBytes = null;
              this.onRuntimeChange?.();
            }
          }
        }

        // A watcher or other actor may have advanced durable inventory while the
        // physical plan was running. Never publish observations against a new base.
        await assertPlanMatchesState(plan, this.store.getState());
        await this.store.transact("convergent-apply", (tx, base) => {
          for (const [entryId, record] of shadow) {
            if (retired.has(entryId)) {
              tx.removeFile(entryId);
              clearTombstones(tx, base, entryId);
              continue;
            }
            const before = base.files[entryId];
            if (!before) continue;
            if (JSON.stringify(before) !== JSON.stringify(record)) {
              tx.putFile({
                entryId: record.entryId, path: record.path, baseline: record.baseline,
                local: record.local, remote: record.remote, status: deriveFileSyncStatus(record)
              });
              clearTombstones(tx, base, entryId);
            }
          }
        });

        const finishedAt = new Date().toISOString();
        const report = summarize(plan, startedAt, finishedAt, results, this.runtime);
        this.runtime.status = report.failed > 0 ? "failed" : report.blocked > 0 ? "blocked" : "completed";
        this.runtime.lastCompletedAt = finishedAt;
        this.runtime.activePlanFingerprint = null;
        this.logger.info("apply.completed", {
          fingerprint: plan.fingerprint, completed: report.completed, blocked: report.blocked, failed: report.failed,
          bytesProcessed: report.bytesProcessed, chunkedTransfers: report.chunkedTransfers,
          resumedTransfers: report.resumedTransfers, rangedDownloads: report.rangedDownloads,
          mergedFiles: report.mergedFiles, mergeConflicts: report.mergeConflicts
        });
        return report;
      } catch (error) {
        this.runtime.status = "failed";
        this.runtime.lastError = error instanceof Error ? error.message : String(error);
        this.runtime.activePlanFingerprint = null;
        this.logger.error("apply.failed", { fingerprint: plan.fingerprint, error: this.runtime.lastError });
        throw error;
      }
    });
  }

  private async executeStep(
    record: FileReplicaRecord,
    step: SyncPlanStep,
    item: SyncPlanItem,
    retired: Set<string>,
    policy: ExecutionPolicy
  ): Promise<void> {
    switch (step.kind) {
      case "verify-remote-content": {
        const remote = requireRemote(record);
        const verified = await this.remote.verifyRemoteContent(this.remoteUrl(remote.path), remote.path, remote.fileId, remote.etag, this.transferProgress());
        record.remote = verified.remote;
        this.runtime.bytesProcessed += verified.bytesTransferred;
        if (verified.ranged) this.runtime.rangedDownloads += 1;
        record.status = deriveFileSyncStatus(record);
        return;
      }
      case "upload-create": {
        const local = requireLocal(record);
        const targetPath = step.targetPath ?? local.path;
        const snapshot = await this.prepareUploadSnapshot(local.path, local.contentHash, local.size);
        try {
          // A stale local create must not recreate remote folders before its source is verified.
          await this.remote.ensureParentDirectories(this.remoteBaseUrl(), targetPath);
          await snapshot.assertSourceUnchanged();
          const uploaded = await this.remote.uploadCreateFromSnapshot(this.remoteUrl(targetPath), targetPath, snapshot, this.transferProgress());
          record.remote = uploaded.remote;
          record.local = snapshotToLocal(snapshot);
          this.accountUpload(snapshot.size, uploaded.chunked, uploaded.resumed);
          record.status = deriveFileSyncStatus(record);
        } finally {
          await snapshot.cleanup();
        }
        return;
      }
      case "upload-update": {
        const local = requireLocal(record);
        const remote = requireRemote(record);
        const sourcePath = step.sourcePath ?? local.path;
        const targetPath = step.targetPath ?? remote.path;
        const snapshot = await this.prepareUploadSnapshot(sourcePath, local.contentHash, local.size);
        try {
          const uploaded = await this.remote.uploadUpdateFromSnapshot(this.remoteUrl(targetPath), targetPath, snapshot, remote.fileId, remote.etag, this.transferProgress());
          record.remote = uploaded.remote;
          record.local = snapshotToLocal(snapshot);
          this.accountUpload(snapshot.size, uploaded.chunked, uploaded.resumed);
          record.status = deriveFileSyncStatus(record);
        } finally {
          await snapshot.cleanup();
        }
        return;
      }
      case "download-create": {
        const remote = requireRemote(record);
        const targetPath = step.targetPath ?? remote.path;
        const streamed = await this.downloadIntoLocal(record, remote, targetPath, null);
        record.local = toLocal(streamed.written);
        record.remote = streamed.remote;
        record.status = deriveFileSyncStatus(record);
        return;
      }
      case "download-update": {
        const remote = requireRemote(record);
        const currentLocal = requireLocal(record);
        const targetPath = step.targetPath ?? currentLocal.path;
        const expectedTargetHash = targetPath === currentLocal.path ? currentLocal.contentHash : null;
        const streamed = await this.downloadIntoLocal(record, remote, targetPath, expectedTargetHash);
        record.local = toLocal(streamed.written);
        record.remote = streamed.remote;
        record.status = deriveFileSyncStatus(record);
        return;
      }
      case "move-local": {
        const local = requireLocal(record);
        const targetPath = step.targetPath;
        if (!targetPath) throw new Error("Local move has no target path.");
        const moved = await this.local.moveAtomic(local.path, targetPath, local.contentHash);
        record.local = toLocal(moved);
        record.path = moved.path;
        record.status = deriveFileSyncStatus(record);
        return;
      }
      case "move-remote": {
        const remote = requireRemote(record);
        const targetPath = step.targetPath;
        if (!targetPath) throw new Error("Remote move has no target path.");
        await this.remote.ensureParentDirectories(this.remoteBaseUrl(), targetPath);
        const moved = await this.remote.move(this.remoteUrl(remote.path), remote.path, this.remoteUrl(targetPath), targetPath, remote.fileId, remote.etag);
        record.remote = { ...moved, contentHash: remote.contentHash };
        record.status = deriveFileSyncStatus(record);
        return;
      }
      case "delete-local": {
        const local = requireLocal(record);
        if (!record.baseline || local.contentHash !== record.baseline.blobHash) throw new Error("Refusing local delete without an unchanged baseline-backed local replica.");
        await this.store.getBlob(record.baseline.blobHash); // proves immutable recovery bytes exist before delete
        await this.local.deleteVerified(local.path, local.contentHash);
        record.local = null;
        record.status = deriveFileSyncStatus(record);
        return;
      }
      case "delete-remote": {
        const remote = requireRemote(record);
        if (!record.baseline) throw new Error("Refusing remote delete without a baseline.");
        await this.store.getBlob(record.baseline.blobHash);
        await this.remote.remove(this.remoteUrl(remote.path), remote.path, remote.fileId, remote.etag);
        record.remote = null;
        record.status = deriveFileSyncStatus(record);
        return;
      }
      case "establish-baseline": {
        const local = requireLocal(record);
        const remote = requireRemote(record);
        if (!remote.contentHash || remote.contentHash !== local.contentHash) {
          throw new Error(`Cannot establish baseline for '${item.displayPath}': replicas do not have the same trusted hash.`);
        }

        // Re-read/fence the *current* local path now, rather than reusing an older
        // upload snapshot. This closes the edit-after-upload / before-baseline gap.
        const snapshot = await this.prepareBaselineSnapshot(local);
        try {
          const stored = await this.store.putBlobChunks(snapshot.chunks(), snapshot.contentHash, snapshot.size);
          if (stored.hash !== local.contentHash || stored.size !== local.size) throw new Error("Baseline object differs from the converged replica.");
          await snapshot.assertSourceUnchanged();
          record.local = snapshotToLocal(snapshot);
          record.baseline = {
            blobHash: stored.hash, size: stored.size, createdAt: new Date().toISOString(), path: record.local.path,
            remoteFileId: remote.fileId, remoteEtag: remote.etag
          };
          record.path = record.local.path;
          record.status = "clean";
        } finally {
          await snapshot.cleanup();
        }
        return;
      }
      case "retire-record": {
        if (record.local || record.remote) throw new Error("Refusing to retire a record while a replica still exists.");
        retired.add(record.entryId);
        return;
      }
      case "merge-text": {
        await this.mergeTextRecord(record, item, policy.mergeLimits ?? DEFAULT_MERGE_LIMITS);
        return;
      }
      case "manual-resolution":
        return;
      default:
        assertNever(step.kind);
    }
  }

  private async mergeTextRecord(record: FileReplicaRecord, item: SyncPlanItem, limits: TextMergeLimits): Promise<void> {
    const baseline = record.baseline;
    const local = requireLocal(record);
    const remote = requireRemote(record);
    if (!baseline) throw new AutomaticMergeBlockedError("overlapping-edits", "Automatic three-way merge requires a verified common ancestor.");
    if (baseline.size > limits.maxInputBytes || local.size > limits.maxInputBytes || remote.size > limits.maxInputBytes) {
      throw new AutomaticMergeBlockedError("input-too-large", `Automatic merge is limited to ${limits.maxInputBytes} bytes per version.`);
    }

    const [baseBytes, localVerified] = await Promise.all([
      this.store.getBlob(baseline.blobHash),
      this.local.readVerified(local.path, local.contentHash)
    ]);
    if (baseBytes.byteLength !== baseline.size) throw new Error(`Baseline size mismatch for '${item.displayPath}'.`);

    const stream = await this.remote.openDownload(this.remoteUrl(remote.path), remote.path, remote.fileId, remote.etag, this.transferProgress());
    void stream.completed.catch(() => undefined);
    const remoteBytes = await collectBounded(stream.chunks, limits.maxInputBytes, item.displayPath);
    const remoteCompleted = await stream.completed;
    if (remote.contentHash !== null && remoteCompleted.contentHash !== remote.contentHash) {
      throw new Error(`Remote content hash for '${item.displayPath}' changed despite the planned ETag fence.`);
    }
    this.runtime.bytesProcessed += remoteCompleted.bytesTransferred;
    if (remoteCompleted.ranged) this.runtime.rangedDownloads += 1;
    // The download was fenced by the planned ETag, so its hash is now verified fact. Keep it even if
    // the merge is blocked: the conflict then offers an explicit choice instead of waiting for a re-verify.
    if (remote.contentHash === null) record.remote = { ...remote, contentHash: remoteCompleted.contentHash };

    const merged = mergeTextThreeWay(baseBytes, localVerified.bytes, remoteBytes, limits);
    if (merged.status === "blocked") throw new AutomaticMergeBlockedError(merged.reason, merged.message);

    // Re-fence local immediately before the first mutation. The remote upload is
    // guarded by fileId+ETag; the local write below is guarded by content hash.
    await this.local.readVerified(local.path, local.contentHash);
    const uploaded = await this.remote.uploadUpdate(
      this.remoteUrl(remote.path), remote.path, merged.bytes, remote.fileId, remote.etag, null, this.transferProgress()
    );
    this.runtime.bytesProcessed += merged.bytes.byteLength;

    const written = await this.local.writeAtomic(local.path, merged.bytes, local.contentHash);
    if (written.contentHash !== uploaded.contentHash || uploaded.remote.contentHash !== written.contentHash) {
      throw new Error(`Merged replicas for '${item.displayPath}' failed post-commit hash equality.`);
    }
    record.local = toLocal(written);
    record.remote = uploaded.remote;
    record.status = deriveFileSyncStatus(record);
    this.runtime.mergedFiles += 1;
    this.logger.info("apply.text-merge-completed", {
      entryId: record.entryId, path: item.displayPath, outputBytes: merged.stats.outputBytes,
      localHunks: merged.stats.localHunks, remoteHunks: merged.stats.remoteHunks
    });
  }

  private async downloadIntoLocal(
    _record: FileReplicaRecord,
    remote: RemoteReplicaState,
    targetPath: string,
    expectedTargetHash: string | null
  ): Promise<{ written: LocalWriteResult; remote: RemoteReplicaState }> {
    const stream = await this.remote.openDownload(this.remoteUrl(remote.path), remote.path, remote.fileId, remote.etag, this.transferProgress());
    // Prevent an unhandled rejection if the async generator fails while the local
    // staging consumer is unwinding. The authoritative await still happens below.
    void stream.completed.catch(() => undefined);
    const written = await this.local.writeAtomicFromChunks(targetPath, stream.chunks, expectedTargetHash, remote.contentHash, remote.size);
    const completed = await stream.completed;
    if (written.contentHash !== completed.contentHash) throw new Error(`Downloaded bytes for '${remote.path}' changed between remote hashing and local staging.`);
    this.runtime.bytesProcessed += completed.bytesTransferred;
    if (completed.ranged) this.runtime.rangedDownloads += 1;
    return { written, remote: completed.remote };
  }

  private async prepareUploadSnapshot(path: string, hash: string, size: number): Promise<PreparedLocalSnapshot> {
    const chunkSize = size >= this.tuning.chunkUploadThresholdBytes
      ? planNextcloudChunks(size, this.tuning.uploadChunkBytes).chunkSize
      : Math.max(1, size);
    return await this.local.prepareSnapshot(path, hash, chunkSize);
  }

  private async prepareBaselineSnapshot(local: LocalReplicaState): Promise<PreparedLocalSnapshot> {
    const chunkSize = local.size >= this.tuning.chunkUploadThresholdBytes
      ? planNextcloudChunks(local.size, this.tuning.uploadChunkBytes).chunkSize
      : Math.max(1, local.size);
    return await this.local.prepareSnapshot(local.path, local.contentHash, chunkSize);
  }

  private accountUpload(size: number, chunked: boolean, resumed: boolean): void {
    this.runtime.bytesProcessed += size;
    if (chunked) this.runtime.chunkedTransfers += 1;
    if (resumed) this.runtime.resumedTransfers += 1;
  }

  private transferProgress(): TransferProgressCallback {
    return (transferredBytes, totalBytes) => {
      this.runtime.activeTransferBytes = transferredBytes;
      this.runtime.activeTransferTotalBytes = totalBytes;
      this.onRuntimeChange?.();
    };
  }

  private remoteBaseUrl(): string { return appendWebdavPath(this.webdavRootUrl, this.remoteRootPath); }
  private remoteUrl(path: string): string { return appendWebdavPath(this.remoteBaseUrl(), path); }
  private assertOpen(): void { if (this.closed) throw new Error("Sync executor is closed."); }
}

function stepAllowedInMode(kind: SyncPlanStep["kind"], mode: ExecutionMode): boolean {
  if (mode === "bidirectional") return true;
  if (kind === "verify-remote-content" || kind === "establish-baseline") return true;
  if (mode === "bootstrap-push") return kind === "upload-create";
  if (mode === "bootstrap-pull") return kind === "download-create";
  return false;
}

function emptyRuntime(): ExecutionRuntimeSummary {
  return {
    status: "idle", activePlanFingerprint: null, startedAt: null, lastCompletedAt: null,
    activeAction: null, activePath: null,
    completedSteps: 0, totalSteps: 0, bytesProcessed: 0, activeTransferBytes: 0, activeTransferTotalBytes: null, chunkedTransfers: 0,
    resumedTransfers: 0, rangedDownloads: 0, mergedFiles: 0, mergeConflicts: 0, lastError: null
  };
}
function actionForStep(kind: SyncPlanStep["kind"]): ExecutionRuntimeSummary["activeAction"] {
  if (kind === "upload-create" || kind === "upload-update") return "upload";
  if (kind === "download-create" || kind === "download-update") return "download";
  if (kind === "verify-remote-content") return "verify";
  if (kind === "merge-text") return "merge";
  return null;
}
function expectedTransferSize(record: FileReplicaRecord, step: SyncPlanStep): number | null {
  switch (step.kind) {
    case "upload-create":
    case "upload-update":
      return record.local?.size ?? null;
    case "download-create":
    case "download-update":
    case "verify-remote-content":
    case "merge-text":
      return record.remote?.size ?? null;
    default:
      return null;
  }
}
function toLocal(value: LocalWriteResult): LocalReplicaState {
  return { path: value.path, contentHash: value.contentHash, size: value.size, mtimeMs: value.mtimeMs };
}
function snapshotToLocal(value: PreparedLocalSnapshot): LocalReplicaState {
  return { path: value.path, contentHash: value.contentHash, size: value.size, mtimeMs: value.mtimeMs };
}
function requireLocal(record: FileReplicaRecord): LocalReplicaState {
  if (!record.local) throw new Error(`Entry '${record.entryId}' has no local replica.`);
  return record.local;
}
function requireRemote(record: FileReplicaRecord): RemoteReplicaState {
  if (!record.remote) throw new Error(`Entry '${record.entryId}' has no remote replica.`);
  return record.remote;
}
function clearTombstones(tx: DurableTransaction, base: DurableState, entryId: string): void {
  for (const tombstone of Object.values(base.tombstones)) if (tombstone.entryId === entryId) tx.removeTombstone(tombstone.tombstoneId);
}
function result(item: SyncPlanItem, step: SyncPlanStep, status: ExecutionStepResult["status"], message: string, record?: FileReplicaRecord): ExecutionStepResult {
  const base: ExecutionStepResult = { entryId: item.entryId, kind: step.kind, status, message, path: step.targetPath ?? step.sourcePath ?? item.displayPath };
  if (status === "completed" && record?.baseline && (step.kind === "delete-local" || step.kind === "delete-remote")) {
    base.deleted = { blobHash: record.baseline.blobHash, size: record.baseline.size };
  }
  return base;
}
function summarize(
  plan: SyncPlan, startedAt: string, finishedAt: string, results: ExecutionStepResult[], runtime: ExecutionRuntimeSummary
): ExecutionReport {
  return {
    planFingerprint: plan.fingerprint, startedAt, finishedAt,
    completed: results.filter((r) => r.status === "completed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    blocked: results.filter((r) => r.status === "blocked").length,
    failed: results.filter((r) => r.status === "failed").length,
    bytesProcessed: runtime.bytesProcessed, chunkedTransfers: runtime.chunkedTransfers,
    resumedTransfers: runtime.resumedTransfers, rangedDownloads: runtime.rangedDownloads,
    mergedFiles: runtime.mergedFiles, mergeConflicts: runtime.mergeConflicts,
    results
  };
}
const DEFAULT_MERGE_LIMITS: TextMergeLimits = { maxInputBytes: 2 * 1024 * 1024, maxLines: 12_000, maxDiffCells: 8_000_000 };

class AutomaticMergeBlockedError extends Error {
  constructor(readonly reason: TextMergeBlockedReason, message: string) {
    super(message);
    this.name = "AutomaticMergeBlockedError";
  }
}

async function collectBounded(chunks: AsyncIterable<ArrayBuffer>, maxBytes: number, path: string): Promise<ArrayBuffer> {
  const pieces: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.byteLength;
    if (!Number.isSafeInteger(total) || total > maxBytes) {
      throw new AutomaticMergeBlockedError("input-too-large", `Remote text '${path}' exceeds the automatic merge byte limit.`);
    }
    pieces.push(new Uint8Array(chunk));
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) { joined.set(piece, offset); offset += piece.byteLength; }
  return joined.buffer;
}

function assertNever(value: never): never { throw new Error(`Unsupported execution step: ${String(value)}`); }
