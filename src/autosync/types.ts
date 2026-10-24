export type AutoSyncStatus =
  | "disabled"
  | "idle"
  | "waiting-quiet"
  | "waiting-health"
  | "syncing"
  | "attention"
  | "error"
  | "closed";

export type AutoSyncTrigger = "local-quiet" | "remote-poll" | "startup" | "foreground-resume" | "manual";

export interface AutoSyncPolicy {
  enabled: boolean;
  quietPeriodMs: number;
  remotePollMs: number;
  startupDelayMs: number;
  allowDeletes: boolean;
}

export interface AutoSyncCycleResult {
  changed: boolean;
  executed: boolean;
  completedSteps: number;
  blockedSteps: number;
  reviewItems: number;
  bytesProcessed: number;
}

export interface AutoSyncRuntimeSummary {
  enabled: boolean;
  status: AutoSyncStatus;
  pendingLocalChanges: number;
  lastLocalActivityAt: string | null;
  nextRunAt: string | null;
  nextRemotePollAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastTrigger: AutoSyncTrigger | null;
  lastResult: AutoSyncCycleResult | null;
  consecutiveFailures: number;
  lastError: string | null;
}
