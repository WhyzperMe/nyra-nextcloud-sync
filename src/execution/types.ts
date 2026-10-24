import type { SyncPlanStep } from "../planner/types";
import type { TextMergeLimits } from "../merge/types";

export type ExecutionStatus = "idle" | "preparing" | "running" | "completed" | "blocked" | "failed" | "closed";
export type ExecutionStepStatus = "pending" | "running" | "completed" | "skipped" | "blocked" | "failed";

export type ExecutionMode = "bidirectional" | "bootstrap-push" | "bootstrap-pull";

export interface ExecutionPolicy {
  allowDestructive: boolean;
  allowMerge: boolean;
  /** Bounded merge limits. Required only when allowMerge is true; safe defaults exist for tests. */
  mergeLimits?: TextMergeLimits;
  maxOperations: number;
  /** Bootstrap modes deliberately permit only one non-destructive transfer direction. */
  mode?: ExecutionMode;
}

export interface ExecutionStepResult {
  entryId: string;
  kind: SyncPlanStep["kind"];
  status: ExecutionStepStatus;
  message: string;
  /** Display path of the affected file (the new path for moves). */
  path: string;
  /** For delete steps: SHA-256 and size of the retained BASE bytes that allow restoring the file. */
  deleted?: { blobHash: string; size: number };
}

export interface ExecutionReport {
  planFingerprint: string;
  startedAt: string;
  finishedAt: string;
  completed: number;
  skipped: number;
  blocked: number;
  failed: number;
  /** Logical bytes that were cryptographically processed by transfer steps. */
  bytesProcessed: number;
  chunkedTransfers: number;
  resumedTransfers: number;
  rangedDownloads: number;
  mergedFiles: number;
  mergeConflicts: number;
  results: ExecutionStepResult[];
}

export interface ExecutionRuntimeSummary {
  status: ExecutionStatus;
  activePlanFingerprint: string | null;
  activeAction: "upload" | "download" | "verify" | "merge" | null;
  activePath: string | null;
  startedAt: string | null;
  lastCompletedAt: string | null;
  completedSteps: number;
  totalSteps: number;
  bytesProcessed: number;
  /** Byte-level activity for the current transfer; network APIs may report in chunks. */
  activeTransferBytes: number;
  activeTransferTotalBytes: number | null;
  chunkedTransfers: number;
  resumedTransfers: number;
  rangedDownloads: number;
  mergedFiles: number;
  mergeConflicts: number;
  lastError: string | null;
}
