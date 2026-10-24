import type { AutoSyncRuntimeSummary } from "../autosync/types";
import type { ExecutionRuntimeSummary } from "../execution/types";
import type { ServerHealthSnapshot } from "../health/types";
import type { LocalInventoryRuntimeSummary } from "../local/types";
import type { SyncPlannerRuntimeSummary } from "../planner/types";
import type { RemoteInventoryRuntimeSummary } from "../remote/types";
import type { DurableStateSummary, IntegrityReport } from "../state/durable/store";
import type { PluginSettings } from "../state/settings";

export interface TransferJournalDiagnostic {
  status: "available" | "unavailable";
  records: number;
  byPhase: Record<string, number>;
}

export interface RedactedSupportReportInput {
  generatedAt?: string;
  pluginVersion: string;
  platform: "mobile" | "desktop";
  settings: PluginSettings;
  hasStoredCredentials: boolean;
  health: ServerHealthSnapshot | null;
  autoSync: AutoSyncRuntimeSummary | null;
  local: LocalInventoryRuntimeSummary | null;
  remote: RemoteInventoryRuntimeSummary | null;
  planner: SyncPlannerRuntimeSummary | null;
  execution: ExecutionRuntimeSummary | null;
  durable: DurableStateSummary | null;
  integrity: IntegrityReport | null;
  transfers: TransferJournalDiagnostic;
}

/** Serializes an allowlist only. User paths, note text, hashes, credentials and raw error messages are intentionally omitted. */
export function createRedactedSupportReport(input: RedactedSupportReportInput): string {
  const plannerItems = input.planner?.summary;
  const failures = [input.autoSync?.lastError, input.local?.lastError, input.remote?.lastError, input.planner?.lastError, input.settings.lastError];
  const memoryLimitBlocked = (input.local?.readBlocks.length ?? 0) > 0 ||
    (input.local?.lastError ? /whole.file read|local memory limit|local read limit/i.test(input.local.lastError) : false);
  const report = {
    format: "nyra-redacted-support-report",
    formatVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    product: { pluginVersion: input.pluginVersion, obsidianVersion: null, platform: input.platform },
    account: {
      serverOrigin: safeOrigin(input.settings.serverUrl),
      connectionState: input.settings.connectionState,
      credentialsStored: input.hasStoredCredentials
    },
    settings: {
      autoSyncEnabled: input.settings.autoSyncEnabled,
      quietPeriodMs: input.settings.autoSyncQuietSeconds * 1000,
      remotePollBaseMs: input.settings.autoSyncRemotePollSeconds * 1000,
      automaticDeletionEnabled: input.settings.autoSyncAllowDeletes,
      safeTextMergeEnabled: input.settings.autoMergeText,
      autoResolveConflicts: input.settings.autoResolveConflicts,
      safeTextMergeMaxMiB: input.settings.autoMergeMaxMiB,
      syncObsidianConfig: input.settings.syncObsidianConfig,
      remoteRootSegmentCount: pathSegmentCount(input.settings.remoteRootPath),
      remoteDirectoryConcurrency: input.settings.remoteDirectoryConcurrency
    },
    health: input.health ? {
      state: input.health.state,
      checkedAt: input.health.checkedAt,
      lastOnlineAt: input.health.lastOnlineAt,
      nextCheckAt: input.health.nextCheckAt,
      consecutiveFailures: input.health.consecutiveFailures
    } : null,
    sync: input.autoSync ? {
      status: input.autoSync.status,
      lastRunAt: input.autoSync.lastRunAt,
      lastSuccessAt: input.autoSync.lastSuccessAt,
      nextRunAt: input.autoSync.nextRunAt,
      nextRemotePollAt: input.autoSync.nextRemotePollAt,
      pendingLocalEvents: input.autoSync.pendingLocalChanges,
      lastResult: input.autoSync.lastResult
    } : null,
    inventories: {
      local: input.local ? {
        status: input.local.status,
        trackedFiles: input.local.trackedFiles,
        hashedBytes: input.local.hashedBytes,
        issueCount: input.local.issueCount,
        complete: input.local.lastScanComplete,
        lastCompletedAt: input.local.lastCompletedAt,
        memoryLimitBlockPresent: memoryLimitBlocked
      } : null,
      remote: input.remote ? {
        status: input.remote.status,
        trackedFiles: input.remote.trackedRemoteFiles,
        directoriesVisited: input.remote.directoriesVisited,
        issueCount: input.remote.issueCount,
        complete: input.remote.lastScanComplete,
        lastCompletedAt: input.remote.lastCompletedAt,
        metrics: input.remote.lastMetrics
      } : null,
      plan: plannerItems ? {
        status: input.planner?.status,
        lastCompletedAt: input.planner?.lastCompletedAt,
        total: plannerItems.total,
        ready: plannerItems.ready,
        needsVerification: plannerItems.needsVerification,
        mergeCandidates: plannerItems.mergeCandidates,
        blocked: plannerItems.blocked,
        destructiveSteps: plannerItems.destructiveSteps
      } : null,
      execution: input.execution ? {
        status: input.execution.status,
        active: input.execution.activeAction !== null && input.execution.activePath !== null,
        activeAction: input.execution.activeAction,
        completedSteps: input.execution.completedSteps,
        bytesProcessed: input.execution.bytesProcessed,
        lastCompletedAt: input.execution.lastCompletedAt
      } : null
    },
    durableState: input.durable ? {
      status: input.durable.status,
      generation: input.durable.generation,
      walSequence: input.durable.walSequence,
      files: input.durable.files,
      tombstones: input.durable.tombstones,
      integrity: input.integrity ? {
        ok: input.integrity.ok,
        verifiedBaselineObjects: input.integrity.verifiedBaselineObjects,
        validSnapshotCount: input.integrity.validSnapshotCount,
        latestSnapshotSequence: input.integrity.latestSnapshotSequence,
        invalidSnapshotCount: input.integrity.snapshotInvalidCount,
        verifiedRecoveryGenerationCount: input.integrity.storage.verifiedRecoveryGenerationCount,
        invalidRecoveryGenerationCount: input.integrity.storage.invalidRecoveryGenerationCount,
        currentRecoverySequence: input.integrity.storage.currentRecoverySequence,
        previousRecoverySequence: input.integrity.storage.previousRecoverySequence,
        errorCount: input.integrity.errors.length,
        storage: {
          auditCompletedAt: input.integrity.storage.auditCompletedAt,
          lastSuccessfulAuditAt: input.integrity.storage.lastSuccessfulAuditAt,
          walRecordCount: input.integrity.storage.walRecordCount,
          walTransactionCount: input.integrity.storage.walTransactionCount,
          walBytes: input.integrity.storage.walBytes,
          currentSnapshotSequence: input.integrity.storage.currentSnapshotSequence,
          previousSnapshotSequence: input.integrity.storage.previousSnapshotSequence,
          currentSnapshotAgeMs: input.integrity.storage.currentSnapshotAgeMs,
          verifiedRecoveryGenerationCount: input.integrity.storage.verifiedRecoveryGenerationCount,
          invalidRecoveryGenerationCount: input.integrity.storage.invalidRecoveryGenerationCount,
          currentRecoverySequence: input.integrity.storage.currentRecoverySequence,
          previousRecoverySequence: input.integrity.storage.previousRecoverySequence,
          referencedObjectCount: input.integrity.storage.referencedObjectCount,
          presentReferencedObjectNames: input.integrity.storage.presentReferencedObjectNames,
          missingReferencedObjectNames: input.integrity.storage.missingReferencedObjectNames,
          unreferencedObjectNames: input.integrity.storage.unreferencedObjectNames,
          unreferencedObjectBytes: input.integrity.storage.unreferencedObjectBytes,
          objectCount: input.integrity.storage.objectCount,
          objectBytes: input.integrity.storage.objectBytes,
          unknownObjectSizeCount: input.integrity.storage.unknownObjectSizeCount,
          malformedObjectNameCount: input.integrity.storage.malformedObjectNameCount,
          unknownObjectEntryCount: input.integrity.storage.unknownObjectEntryCount,
          stagingFileCount: input.integrity.storage.stagingFileCount,
          estimatedReclaimableBytes: input.integrity.storage.estimatedReclaimableBytes,
          garbageCollectionEnabled: input.integrity.storage.garbageCollectionEnabled,
          lastSuccessfulGcAt: input.integrity.storage.lastSuccessfulGcAt
        }
      } : null
    } : null,
    transfers: input.transfers,
    lastFailureCategory: firstCategory(failures)
  };
  return JSON.stringify(report, null, 2);
}

function safeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

function pathSegmentCount(raw: string): number {
  return raw.trim().replace(/\\/g, "/").split("/").filter(Boolean).length;
}

function firstCategory(messages: readonly (string | null | undefined)[]): string | null {
  const message = messages.find((candidate) => Boolean(candidate));
  if (!message) return null;
  if (/auth|credential|password|unauthorized|\b401\b|\b403\b/i.test(message)) return "authentication";
  if (/etag|stale|precondition/i.test(message)) return "concurrency-precondition";
  if (/timeout|network|offline|fetch|connection/i.test(message)) return "network";
  if (/memory limit|read limit|too large|oversized/i.test(message)) return "resource-limit";
  if (/incomplete|inventory|scan/i.test(message)) return "incomplete-inventory";
  if (/conflict|merge/i.test(message)) return "conflict-review";
  return "other";
}
