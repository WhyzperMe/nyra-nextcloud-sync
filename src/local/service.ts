import type { Logger } from "../diagnostics/logger";
import { AsyncMutex } from "../state/durable/mutex";
import type { DurableStateStore } from "../state/durable/store";
import { coalesceExactRenames } from "./rename-hints";
import { LocalInventoryReconciler } from "./reconciler";
import type { LocalPathPolicy } from "./path-policy";
import type { LocalFullScanOptions, LocalInventoryScanner } from "./scanner";
import type { LocalMutationLedger, MutationDelta } from "./mutation-ledger";
import type {
  LocalChangeBatch,
  LocalFullScanResult,
  LocalInventoryEntry,
  LocalInventoryRuntimeSummary,
  LocalReconcileOutcome,
  LocalRenameHint
} from "./types";

export class LocalInventoryService {
  private readonly mutex = new AsyncMutex();
  private trustMetadataNext = false;
  private readonly reconciler: LocalInventoryReconciler;
  private readonly abortController = new AbortController();
  private closed = false;
  private runtime: LocalInventoryRuntimeSummary = {
    status: "idle",
    trackedFiles: 0,
    hashedBytes: 0,
    issueCount: 0,
    readBlocks: [],
    lastScanComplete: null,
    lastCompletedAt: null,
    lastReason: null,
    lastError: null
  };

  constructor(
    private readonly scanner: LocalInventoryScanner,
    private readonly store: DurableStateStore,
    private readonly ledger: LocalMutationLedger,
    private readonly logger: Logger,
    private readonly policy?: LocalPathPolicy
  ) {
    this.reconciler = new LocalInventoryReconciler(store, policy);
    this.refreshTrackedFiles();
  }

  summary(): LocalInventoryRuntimeSummary {
    return structuredClone(this.runtime);
  }

  async scanFull(reason = "manual", options: LocalFullScanOptions = {}): Promise<LocalReconcileOutcome> {
    return await this.mutex.runExclusive(async () => {
      this.assertOpen();
      this.trustMetadataNext = options.trustMetadata === true;
      try { return await this.runFullScan(reason, []); }
      finally { this.trustMetadataNext = false; }
    });
  }

  /** Wait for queued watcher observations to finish without forcing a full scan. */
  async whenIdle(): Promise<void> {
    await this.mutex.runExclusive(async () => { this.assertOpen(); });
  }

  async applyChangeBatch(batch: LocalChangeBatch): Promise<LocalReconcileOutcome> {
    return await this.mutex.runExclusive(async () => {
      this.assertOpen();
      this.beginScan(`event-batch-${batch.sequence}`);
      try {
        if (batch.requiresFullScan) {
          return await this.runFullScanInsideActiveStatus(
            `event-batch-${batch.sequence}-tree`,
            batch.renames
          );
        }

        const eventFence = this.ledger.currentSequence();
        const targeted = await this.scanner.scanPaths(batch.paths, this.abortController.signal);
        const raced = this.ledger.changesSince(eventFence);

        // A later live event can invalidate a targeted observation (especially a
        // rename where the old/new path relationship matters). Escalate before
        // committing rather than letting two independently valid snapshots create
        // a false identity split.
        if (raced.changed) {
          this.logger.debug("local.inventory-event-race-escalated", {
            batchSequence: batch.sequence,
            from: raced.fromSequence,
            to: raced.toSequence,
            ledgerComplete: raced.complete
          });
          const mergedRenames = coalesceExactRenames([
            ...batch.renames,
            ...(raced.complete ? raced.renames : [])
          ]);
          return await this.runFullScanInsideActiveStatus(
            `event-batch-${batch.sequence}-race`,
            mergedRenames,
            raced.complete
          );
        }

        const stats = await this.reconciler.applyTargetedScan(targeted, {
          exactRenames: batch.renames,
          allowNewRecords: true
        });
        return this.complete(targeted, stats, `event-batch-${batch.sequence}`);
      } catch (error) {
        this.fail(error);
        throw error;
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    this.runtime.status = "closed";
  }

  private async runFullScan(reason: string, seedRenames: readonly LocalRenameHint[]): Promise<LocalReconcileOutcome> {
    this.beginScan(reason);
    try {
      return await this.runFullScanInsideActiveStatus(reason, seedRenames);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private async runFullScanInsideActiveStatus(
    reason: string,
    seedRenames: readonly LocalRenameHint[],
    seedLedgerComplete = true
  ): Promise<LocalReconcileOutcome> {
    this.assertOpen();
    let lastScan: LocalFullScanResult | null = null;
    let lastChanges: MutationDelta | null = null;
    let accumulatedRenames = coalesceExactRenames(seedRenames);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fence = this.ledger.currentSequence();
      const previous = this.currentLocalEntries();
      const scan = await this.scanner.scanFull(previous, this.abortController.signal, { trustMetadata: this.trustMetadataNext && attempt === 0 });
      const changes = this.ledger.changesSince(fence);
      lastScan = scan;
      lastChanges = changes;
      if (changes.complete && changes.renames.length > 0) {
        accumulatedRenames = coalesceExactRenames([...accumulatedRenames, ...changes.renames]);
      }

      if (scan.complete && !changes.changed && changes.complete && seedLedgerComplete) {
        const stats = await this.reconciler.applyFullScan(scan, {
          exactRenames: accumulatedRenames,
          allowNewRecords: true
        });
        return this.complete(scan, stats, reason);
      }

      if (attempt < 2 && changes.complete && seedLedgerComplete) {
        this.logger.debug("local.inventory-full-retry", {
          reason,
          attempt: attempt + 1,
          scanComplete: scan.complete,
          overlappingEvents: changes.changed
        });
        continue;
      }
      break;
    }

    if (!lastScan || !lastChanges) throw new Error("Local full scan retry invariant failed.");

    const exactRenames = accumulatedRenames;
    const allowNewRecords = lastChanges.complete && seedLedgerComplete;
    let conservative = lastScan;
    if (lastChanges.changed) conservative = conservativeForOverlappingEvents(conservative, lastChanges);
    if (!lastChanges.complete || !seedLedgerComplete) conservative = conservativeForLedgerOverflow(conservative);

    const stats = await this.reconciler.applyFullScan(conservative, {
      exactRenames,
      allowNewRecords
    });
    return this.complete(conservative, stats, reason);
  }

  private currentLocalEntries(): LocalInventoryEntry[] {
    const entries: LocalInventoryEntry[] = [];
    for (const record of Object.values(this.store.getState().files)) {
      if (!record.local) continue;
      if (this.policy && !this.policy.isIncluded(record.local.path)) continue;
      entries.push({
        path: record.local.path,
        contentHash: record.local.contentHash,
        size: record.local.size,
        mtimeMs: record.local.mtimeMs,
        ctimeMs: record.local.mtimeMs
      });
    }
    return entries;
  }

  private complete(
    scan: LocalReconcileOutcome["scan"],
    stats: LocalReconcileOutcome["stats"],
    reason: string
  ): LocalReconcileOutcome {
    this.runtime = {
      status: scan.complete ? "ready" : "degraded",
      trackedFiles: countTracked(this.store, this.policy),
      hashedBytes: scan.hashedBytes,
      issueCount: scan.issues.length,
      readBlocks: scan.oversized.slice(0, 5),
      lastScanComplete: scan.complete,
      lastCompletedAt: scan.finishedAt,
      lastReason: reason,
      lastError: null
    };
    this.logger.info("local.inventory-completed", {
      reason,
      complete: scan.complete,
      issues: scan.issues.length,
      hashedBytes: scan.hashedBytes,
      ...stats
    });
    return { scan, stats };
  }

  private beginScan(reason: string): void {
    this.assertOpen();
    this.runtime.status = "scanning";
    this.runtime.lastReason = reason;
    this.runtime.lastError = null;
  }

  private fail(error: unknown): void {
    this.runtime.lastScanComplete = false;
    if (this.closed || isAbortError(error)) {
      this.runtime.status = this.closed ? "closed" : "degraded";
      return;
    }
    this.runtime.status = "degraded";
    this.runtime.lastError = error instanceof Error ? error.message : String(error);
    this.logger.error("local.inventory-failed", { error: this.runtime.lastError });
  }

  private refreshTrackedFiles(): void {
    this.runtime.trackedFiles = countTracked(this.store, this.policy);
  }

  private assertOpen(): void {
    if (this.closed) throw new DOMException("Local inventory service is closed.", "AbortError");
  }
}

export function conservativeForOverlappingEvents(
  scan: LocalFullScanResult,
  changes: MutationDelta
): LocalFullScanResult {
  if (!changes.changed) return scan;
  return {
    ...scan,
    complete: false,
    issues: [
      ...scan.issues,
      {
        path: "<vault>",
        code: "concurrent-change",
        message: `Vault events advanced from mutation sequence ${changes.fromSequence} to ${changes.toSequence} during the full scan.`
      }
    ]
  };
}

function conservativeForLedgerOverflow(scan: LocalFullScanResult): LocalFullScanResult {
  if (scan.issues.some((issue) => issue.message.includes("mutation ledger history"))) return { ...scan, complete: false };
  return {
    ...scan,
    complete: false,
    issues: [
      ...scan.issues,
      {
        path: "<vault>",
        code: "concurrent-change",
        message: "The bounded mutation ledger history was exceeded; new identity creation and absence inference were deferred."
      }
    ]
  };
}

function countTracked(store: DurableStateStore, policy?: LocalPathPolicy): number {
  return Object.values(store.getState().files).filter((record) =>
    record.local !== null && (!policy || policy.isIncluded(record.local.path))
  ).length;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
