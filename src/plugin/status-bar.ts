import type { AutoSyncRuntimeSummary } from "../autosync/types";
import type { ExecutionRuntimeSummary } from "../execution/types";
import type { ServerHealthSnapshot } from "../health/types";
import type { PluginSettings } from "../state/settings";
import { isAre, plural } from "../core/plural";

export interface StatusBarInput {
  settings: PluginSettings;
  health: ServerHealthSnapshot | null;
  auto: AutoSyncRuntimeSummary | null;
  execution: ExecutionRuntimeSummary | null;
  syncBusy: boolean;
  convergenceErrors: number;
  pendingDeletions: number;
}

/** Status-bar label and tooltip, in priority order from "working" to "idle". */
export function describeStatusBar(input: StatusBarInput): { text: string; detail: string } {
  const { settings, health, auto } = input;
  if (input.syncBusy) {
    const active = input.execution;
    if (active?.activePath) {
      const action = active.activeAction === "upload" ? "Uploading"
        : active.activeAction === "download" ? "Downloading"
          : active.activeAction === "verify" ? "Verifying"
            : active.activeAction === "merge" ? "Merging"
              : "Working on";
      const total = active.activeTransferTotalBytes;
      const progress = total === null ? "" : ` · ${total === 0 ? 100 : Math.round(active.activeTransferBytes / total * 100)}% · ${active.completedSteps}/${active.totalSteps} verified steps`;
      return { text: "Nextcloud · syncing", detail: `${action} ${active.activePath}${progress}` };
    }
    return { text: "Nextcloud · syncing", detail: auto?.status === "syncing" ? "Preparing safe changes and verifying both copies." : "Preparing fresh sync facts." };
  }
  if (input.convergenceErrors > 0) return { text: "Nextcloud · check state", detail: "Semantic consistency audit found an internal state error. Sync is fail-closed until reviewed." };
  if (health?.state === "offline") return { text: "Nextcloud · offline", detail: health.message };
  if (health?.state === "maintenance") return { text: "Nextcloud · maintenance", detail: health.message };
  if (health?.state === "auth-required") return { text: "Nextcloud · sign in", detail: health.message };
  if (health?.state === "degraded") return { text: "Nextcloud · waiting", detail: health.message };
  if (input.pendingDeletions > 0) return { text: "Nextcloud · approve deletions", detail: `${plural(input.pendingDeletions, "deletion")} ${isAre(input.pendingDeletions)} waiting for your approval.` };
  if (settings.syncPaused && settings.connectionState === "verified") return { text: "Nextcloud · paused", detail: "Auto-sync is paused. Use Sync now to sync manually." };
  if (auto?.status === "attention") return { text: "Nextcloud · review", detail: "Some conflicts or blocked steps require review." };
  if (settings.autoSyncEnabled && health?.state === "online") {
    return { text: "Nextcloud · auto", detail: auto?.status === "waiting-quiet" ? "Waiting for the quiet period before syncing." : "Auto-sync is ready." };
  }
  if (settings.connectionState === "verified") return { text: "Nextcloud · ready", detail: health?.message ?? "Connected." };
  return { text: "Nextcloud", detail: "Nyra Nextcloud Sync" };
}
