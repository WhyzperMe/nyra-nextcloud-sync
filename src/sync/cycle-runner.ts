import type { AutoSyncCycleResult, AutoSyncTrigger } from "../autosync/types";
import { NyraError } from "../core/errors";
import type { ExecutionReport } from "../execution/types";
import type { SyncPlan } from "../planner/types";

const FULL_LOCAL_RECONCILIATION_MS = 5 * 60_000;
/**
 * Some storage backends restamp a file's ETag a moment after a committed write.
 * A cycle that observes that drift between inventory and execution re-inventories
 * and replans instead of replaying the stale physical plan.
 */
const DEFAULT_REPLAN_DELAYS_MS: readonly number[] = [1_500, 3_000];

export interface SyncCyclePort {
  localFactsComplete(): boolean;
  remoteFactsComplete(): boolean;
  lastFullLocalScanAt(): number;
  now(): number;
  flushLocalHints(): Promise<void>;
  waitForLocalInventory(): Promise<void>;
  /**
   * `trustMetadata` lets the scan reuse hashes of files whose size and mtime are unchanged; it is
   * only requested between the periodic fully verified scans.
   */
  scanLocalFull(reason: string, options?: { trustMetadata: boolean }): Promise<boolean>;
  /** `allowCached` lets an unchanged remote be recognized with a single cheap request instead of a full scan. */
  scanRemoteFull(options: { allowCached: boolean }): Promise<boolean>;
  /** Called before a replan so the next attempt performs a genuine full remote scan. */
  invalidateRemoteFacts?(): void;
  buildPlan(): Promise<SyncPlan>;
  autoMergeEnabled(): boolean;
  applyPlan(allowDeletes: boolean): Promise<ExecutionReport>;
  /** Mirrors folders (including empty ones) from fresh inventories; returns the operations performed. */
  syncFolders(allowDeletes: boolean): Promise<number>;
}

/**
 * Owns the fresh-facts → plan → guarded-execution cycle. Local events only
 * request exact-path inventory refreshes; startup, resume, delete-enabled runs,
 * and the periodic fence still perform a complete local traversal.
 */
export class SyncCycleRunner {
  constructor(
    private readonly port: SyncCyclePort,
    private readonly replanDelaysMs: readonly number[] = DEFAULT_REPLAN_DELAYS_MS
  ) {}

  async run(trigger: AutoSyncTrigger, allowDeletes: boolean): Promise<AutoSyncCycleResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.runOnce(trigger, allowDeletes);
      } catch (error) {
        const delay = this.replanDelaysMs[attempt];
        if (delay === undefined || !(error instanceof NyraError) || error.code !== "sync-precondition-changed") throw error;
        this.port.invalidateRemoteFacts?.();
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delay));
      }
    }
  }

  private async runOnce(trigger: AutoSyncTrigger, allowDeletes: boolean): Promise<AutoSyncCycleResult> {
    // Startup, resume, manual runs, incomplete facts and the periodic fence read and hash every file.
    const verifiedScanDue = trigger === "startup" || trigger === "foreground-resume" || trigger === "manual" ||
      !this.port.localFactsComplete() ||
      this.port.now() - this.port.lastFullLocalScanAt() >= FULL_LOCAL_RECONCILIATION_MS;
    // Deletion needs a complete listing to prove absence, but not a re-read of unchanged files.
    const fullScanDue = verifiedScanDue || allowDeletes;
    if (fullScanDue) {
      if (!await this.port.scanLocalFull(`autosync-${trigger}`, { trustMetadata: !verifiedScanDue })) {
        throw new Error("Local inventory is incomplete; automatic writes are paused until a complete scan succeeds.");
      }
    } else {
      await this.port.flushLocalHints();
      await this.port.waitForLocalInventory();
      if (!this.port.localFactsComplete()) {
        if (!await this.port.scanLocalFull("autosync-incomplete-local-fallback")) {
          throw new Error("Local inventory is incomplete; automatic writes are paused until a complete scan succeeds.");
        }
      }
    }

    if (!this.port.localFactsComplete()) {
      throw new Error("Local inventory is incomplete; automatic writes are paused until a complete scan succeeds.");
    }
    if (!await this.port.scanRemoteFull({ allowCached: trigger === "remote-poll" })) {
      throw new Error("Remote inventory is incomplete; automatic writes are paused until a complete WebDAV scan succeeds.");
    }
    if (!this.port.remoteFactsComplete()) {
      throw new Error("Remote inventory is incomplete; automatic writes are paused until a complete WebDAV scan succeeds.");
    }

    const plan = await this.port.buildPlan();
    const mergeAutomation = this.port.autoMergeEnabled();
    const reviewItems = plan.summary.blocked + (mergeAutomation ? 0 : plan.summary.mergeCandidates);
    const executable = plan.summary.ready + plan.summary.needsVerification + (mergeAutomation ? plan.summary.mergeCandidates : 0);

    let completedSteps = 0;
    let blockedSteps = 0;
    let bytesProcessed = 0;
    let reviewCount = reviewItems;
    if (executable > 0) {
      const report = await this.port.applyPlan(allowDeletes);
      completedSteps = report.completed;
      blockedSteps = report.blocked;
      bytesProcessed = report.bytesProcessed;
      reviewCount = Math.max(reviewItems, report.blocked);
    }
    const folderOperations = await this.port.syncFolders(allowDeletes);
    const executed = completedSteps + folderOperations > 0;
    return {
      changed: executed || (executable === 0 && plan.summary.noop !== plan.summary.total),
      executed,
      completedSteps: completedSteps + folderOperations,
      blockedSteps,
      reviewItems: reviewCount,
      bytesProcessed
    };
  }
}
