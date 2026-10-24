import type { ServerHealthSnapshot, ServerHealthState } from "../health/types";
import type { SyncPlan, SyncPlanItem, SyncPlannerRuntimeSummary } from "../planner/types";
import { normalizeRemoteRootPath } from "../remote/path";
import { normalizeServerUrl } from "../security/url-policy";
import type NyraNextcloudSyncPlugin from "../main";
import { deriveOverviewSyncState } from "../sync/derived-status";
import { formatBytes, relativeFuture, relativePast } from "./format";
import { Tone } from "./settings-dom";
import { needs, plural } from "../core/plural";

export interface SyncPresentation {
  state: ReturnType<typeof deriveOverviewSyncState>;
  tone: Tone;
  detail: string;
  progressLabel: string;
  progressFraction: number | null;
}

export function syncPresentation(owner: NyraNextcloudSyncPlugin): SyncPresentation {
  const health = owner.serverHealthSummary();
  const auto = owner.autoSyncSummary();
  const execution = owner.executionSummary();
  const plan = owner.currentSyncPlan();
  const blockedCount = (plan?.summary.blocked ?? 0) + (owner.settings.autoMergeText ? 0 : plan?.summary.mergeCandidates ?? 0);
  const busy = owner.isSyncBusy();
  const waitingForQuiet = auto?.status === "waiting-quiet" || (auto?.pendingLocalChanges ?? 0) > 0;
  const blockingError = owner.stateInitializationError ?? owner.remoteWriteSafetyError;
  const state = deriveOverviewSyncState({
    blocked: Boolean(blockingError), busy: busy || owner.isRuntimeInitializing(),
    offline: health?.state === "offline" || health?.state === "maintenance",
    waiting: waitingForQuiet || health?.state === "checking",
    attention: owner.settings.connectionState !== "verified" || health?.state !== "online" || blockedCount > 0 || auto?.status === "attention" || auto?.status === "error" || owner.hasConvergenceErrors()
  });

  let detail = "Ready";
  let progressLabel = "";
  let progressFraction: number | null = null;
  if (blockingError) {
    detail = blockingError;
  } else if (owner.isRuntimeInitializing()) {
    detail = "Checking local recovery state before sync becomes available…";
    progressLabel = "Verifying Nyra's durable sync history";
  } else if (waitingForQuiet && !busy && state === "Syncing") {
    const count = auto?.pendingLocalChanges ?? 0;
    detail = count > 0 ? `${plural(count, "local change event")} · waiting for edits to settle` : `Waiting for the quiet period · next check ${relativeFuture(auto?.nextRunAt ?? null)}`;
  } else if (busy && execution?.activePath) {
    const action = execution.activeAction === "upload" ? "Uploading"
      : execution.activeAction === "download" ? "Downloading"
        : execution.activeAction === "verify" ? "Verifying remote content"
          : execution.activeAction === "merge" ? "Merging safely"
            : "Applying verified change to";
    detail = `${action} · ${execution.activePath}`;
    const total = execution.activeTransferTotalBytes;
    if (total !== null) {
      const transferred = execution.activeTransferBytes;
      progressFraction = total === 0 ? 1 : Math.max(0, Math.min(1, transferred / total));
      const verb = execution.activeAction === "upload" ? "sent" : execution.activeAction === "download" ? "received" : "checked";
      progressLabel = `${formatBytes(transferred)} of ${formatBytes(total)} ${verb} · ${execution.completedSteps}/${execution.totalSteps} verified steps · ${formatDurationSince(execution.startedAt)}`;
    } else {
      progressLabel = `${execution.completedSteps}/${execution.totalSteps} verified steps · ${formatDurationSince(execution.startedAt)}`;
    }
  } else if (busy && owner.remoteInventoryProgressSummary()?.status === "scanning") {
    const remote = owner.remoteInventoryProgressSummary();
    const scan = remote?.scanProgress;
    detail = scan
      ? `Checking Nextcloud · ${scan.directoriesCompleted} folder requests completed · ${scan.filesFound} file entries seen`
      : "Checking Nextcloud inventory…";
    progressLabel = scan ? `${scan.directoriesCompleted} folder requests completed · ${scan.filesFound} file entries seen` : "";
  } else if (busy && owner.localInventorySummary()?.status === "scanning") {
    const local = owner.localInventorySummary();
    detail = `Checking local vault · ${local?.trackedFiles ?? 0} tracked files · verifying content hashes`;
    progressLabel = `Verifying the local file inventory · ${formatDurationSince(auto?.lastRunAt ?? null)}`;
  } else if (busy && owner.plannerSummary()?.status === "planning") {
    detail = "Building a deterministic plan from the verified inventories…";
    progressLabel = "Checking changes against the last verified baseline";
  } else if (busy && health?.state === "checking") {
    detail = "Checking Nextcloud before starting the safe sync…";
    progressLabel = "Waiting for the server health response";
  } else if (busy && auto?.status === "syncing") {
    detail = "Applying safe changes and verifying both copies…";
    progressLabel = `${execution?.completedSteps ?? 0}/${execution?.totalSteps ?? 0} verified steps · ${formatDurationSince(auto.lastRunAt)}`;
  } else if (busy) {
    detail = "Preparing a safe sync operation…";
    progressLabel = `Working · ${formatDurationSince(auto?.lastRunAt ?? null)}`;
  } else if (state === "Offline") {
    detail = health?.state === "maintenance" ? "Server maintenance · checks resume automatically." : "Nextcloud unavailable · checks retry automatically.";
  } else if (state === "Needs attention") {
    detail = blockedCount > 0 ? `${plural(blockedCount, "item")} ${needs(blockedCount)} review; Nyra has preserved both versions.` : health?.message ?? "Check the connection and diagnostics before syncing.";
  } else if (auto?.lastSuccessAt) {
    detail = auto.enabled ? "Ready for changes" : "Automatic sync is off";
  }

  return { state, tone: state === "Synced" ? "ok" : "warn", detail, progressLabel, progressFraction };
}

export function executionRuntimeText(summary: ReturnType<NyraNextcloudSyncPlugin["executionSummary"]>): string {
  if (!summary) return "No execution has run in this session.";
  const active = summary.activePath ? ` · ${summary.activeAction ?? "Working on"} ${summary.activePath}` : "";
  return `${capitalize(summary.status)} · ${summary.completedSteps}/${summary.totalSteps} steps · ${formatBytes(summary.bytesProcessed)}${active}${summary.lastError ? ` · ${summary.lastError}` : ""}`;
}

export function formatDurationSince(value: string | null): string {
  if (!value) return "just started";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "just started";
  const elapsed = Math.max(0, Date.now() - parsed);
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s elapsed`;
  return `${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1000)}s elapsed`;
}

export function connectionTone(state: string): Tone { return state === "verified" ? "ok" : state === "error" ? "error" : state === "authenticating" || state === "pending-verification" ? "warn" : "neutral"; }

export function healthTone(state?: ServerHealthState): Tone { return state === "online" ? "ok" : state === "auth-required" ? "error" : state === "offline" || state === "maintenance" || state === "degraded" || state === "checking" ? "warn" : "neutral"; }

export function autoTone(status?: string): Tone { return status === "idle" ? "ok" : status === "syncing" || status === "waiting-quiet" || status === "waiting-health" ? "warn" : status === "error" || status === "attention" ? "error" : "neutral"; }

export function inventoryTone(status?: string): Tone { return status === "ready" ? "ok" : status === "degraded" ? "error" : status === "scanning" ? "warn" : "neutral"; }

export function executionTone(status?: string): Tone { return status === "completed" ? "ok" : status === "failed" || status === "blocked" ? "error" : status === "running" || status === "preparing" ? "warn" : "neutral"; }

export function plannerTone(status?: SyncPlannerRuntimeSummary["status"]): Tone { return status === "ready" ? "ok" : status === "blocked" ? "error" : status === "planning" || status === "stale" ? "warn" : "neutral"; }

export function humanState(state: string): string { return ({ verified: "Verified", authenticating: "Authenticating", "pending-verification": "Pending", disconnected: "Disconnected", error: "Attention" } as Record<string,string>)[state] ?? state; }

export function healthHeadline(summary: ServerHealthSnapshot | null): string { if (!summary) return "Unknown"; return ({ unknown:"Unknown", checking:"Checking", online:"Online", offline:"Offline", maintenance:"Maintenance", degraded:"Waiting", "auth-required":"Sign in" } as Record<ServerHealthState,string>)[summary.state]; }

export function healthDetail(summary: ServerHealthSnapshot | null): string { if (!summary) return "Not checked"; if (summary.state === "online") return summary.serverVersionString ? `Nextcloud ${summary.serverVersionString}` : "Reachable"; return summary.message; }

export function autoHeadline(summary: ReturnType<NyraNextcloudSyncPlugin["autoSyncSummary"]>): string { if (!summary) return "Unavailable"; return ({ disabled:"Off", idle:"Ready", "waiting-quiet":"Waiting", "waiting-health":"Paused", syncing:"Syncing", attention:"Review", error:"Attention", closed:"Closed" } as Record<string,string>)[summary.status] ?? capitalize(summary.status); }

export function autoDetail(summary: ReturnType<NyraNextcloudSyncPlugin["autoSyncSummary"]>): string { if (!summary) return "Unavailable"; if (!summary.enabled) return "Manual sync only"; if (summary.status === "waiting-quiet") return `${plural(summary.pendingLocalChanges, "event")} · ${relativeFuture(summary.nextRunAt)}`; if (summary.status === "waiting-health") return "Waiting for server"; if ((summary.status === "error" || summary.status === "attention") && summary.lastError) return summary.lastError; if (summary.lastSuccessAt) return `Last sync ${relativePast(summary.lastSuccessAt)}`; return "Enabled"; }

export function durableHeadline(summary: ReturnType<NyraNextcloudSyncPlugin["durableStateSummary"]>): string { return summary ? summary.status === "ready" ? "Ready" : summary.status : "Unavailable"; }

export function durableDetail(owner: NyraNextcloudSyncPlugin): string { const s=owner.durableStateSummary(); return s ? `Gen ${s.generation} · WAL ${s.walSequence} · ${s.files} records` : owner.stateInitializationError ?? "Not initialized"; }

export function convergenceHeadline(summary: ReturnType<NyraNextcloudSyncPlugin["convergenceAuditSummary"]>): string { return !summary ? "Not checked" : summary.status === "healthy" ? "Verified" : "Attention"; }

export function convergenceTone(summary: ReturnType<NyraNextcloudSyncPlugin["convergenceAuditSummary"]>): Tone { return !summary ? "neutral" : summary.errors > 0 ? "error" : summary.warnings > 0 ? "warn" : "ok"; }

export function convergenceDetail(summary: ReturnType<NyraNextcloudSyncPlugin["convergenceAuditSummary"]>): string { if (!summary) return "Semantic model audit pending"; if (summary.errors > 0) return summary.issues.find((issue) => issue.severity === "error")?.message ?? `${plural(summary.errors, "error")}`; if (summary.warnings > 0) return `${plural(summary.warnings, "cached-state warning")} · gen ${summary.generation}`; return `${summary.verifiedCleanRecords}/${summary.cleanRecords} clean verified · gen ${summary.generation}`; }

export function localHeadline(summary: ReturnType<NyraNextcloudSyncPlugin["localInventorySummary"]>): string { return summary ? capitalize(summary.status) : "Unavailable"; }

export function localDetail(owner: NyraNextcloudSyncPlugin): string {
  const summary = owner.localInventorySummary();
  if (!summary) return "State required";
  const firstBlock = summary.readBlocks[0];
  if (!firstBlock) return `${summary.trackedFiles} files · ${summary.issueCount} issues`;
  const extra = summary.readBlocks.length > 1 ? ` · ${plural(summary.readBlocks.length - 1, "more skipped oversized file")}` : "";
  return `${summary.trackedFiles} files · ${summary.issueCount} issues · ${firstBlock.path} (${formatBytes(firstBlock.actualSizeBytes)}) exceeds this device's safe read limit (${formatBytes(firstBlock.maxSafeReadBytes)}); it is skipped on this device and left unchanged, everything else keeps syncing.${extra}`;
}

export function remoteHeadline(summary: ReturnType<NyraNextcloudSyncPlugin["remoteInventorySummary"]>): string { return summary ? capitalize(summary.status) : "Not scanned"; }

export function remoteDetail(owner: NyraNextcloudSyncPlugin): string { const s=owner.remoteInventorySummary(); return s ? `${s.trackedRemoteFiles} files · ${s.issueCount} issues` : "Account required"; }

export function plannerHeadline(summary: SyncPlannerRuntimeSummary | null): string { if (!summary) return "Unavailable"; return summary.status === "stale" ? "Stale" : capitalize(summary.status); }

export function plannerDetail(summary: SyncPlannerRuntimeSummary | null, autoMerge: boolean): string { if (!summary?.summary) return "No plan"; const s=summary.summary; const review=s.blocked+(autoMerge?0:s.mergeCandidates); return `${s.ready} ready · ${s.needsVerification} verify · ${s.mergeCandidates} merge · ${review} review`; }

export function executionHeadline(summary: ReturnType<NyraNextcloudSyncPlugin["executionSummary"]>): string { return summary ? capitalize(summary.status) : "Idle"; }

export function executionDetail(summary: ReturnType<NyraNextcloudSyncPlugin["executionSummary"]>): string { return summary ? `${summary.completedSteps}/${summary.totalSteps} · ${formatBytes(summary.bytesProcessed)}${summary.mergedFiles ? ` · ${summary.mergedFiles} merged` : ""}` : "No active apply"; }

export function humanDisposition(value: SyncPlanItem["disposition"]): string { return ({ noop:"No-op", ready:"Ready", "needs-verification":"Verify", "merge-candidate":"Merge", blocked:"Blocked" } as const)[value]; }

export function planNotice(plan: SyncPlan): string { const s=plan.summary; return `Plan · ${s.ready} ready · ${s.needsVerification} verify · ${s.mergeCandidates + s.blocked} review.`; }

export function capitalize(value: string): string { return value.length ? value[0]!.toUpperCase() + value.slice(1) : value; }

export function sameCanonicalServer(left: string, right: string): boolean { try { return normalizeServerUrl(left) === normalizeServerUrl(right); } catch { return false; } }

export function encodeRemoteForDisplay(value: string): string { try { const normalized=normalizeRemoteRootPath(value); return normalized ? `${normalized.split("/").map(encodeURIComponent).join("/")}/` : ""; } catch { return value; } }
