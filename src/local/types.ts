export interface LocalFileMetadata {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface LocalInventoryEntry extends LocalFileMetadata {
  contentHash: string;
}

export type LocalScanIssueCode =
  | "list-failed"
  | "invalid-path"
  | "invalid-stat"
  | "stat-failed"
  | "read-failed"
  | "concurrent-change";

export interface LocalFileReadBlock {
  path: string;
  reasonCode: "LOCAL_FILE_TOO_LARGE_FOR_SAFE_PLATFORM_READ";
  actualSizeBytes: number;
  maxSafeReadBytes: number;
}

export interface LocalScanIssue {
  path: string;
  code: LocalScanIssueCode;
  message: string;
}

export type RenameKind = "file" | "folder";
export type RenameSource = "vault-event" | "heuristic";
export type RenameConfidence = "exact" | "heuristic";

export interface LocalRenameHint {
  oldPath: string;
  newPath: string;
  kind: RenameKind;
  source: RenameSource;
  confidence: RenameConfidence;
}

export interface LocalFullScanResult {
  kind: "full";
  entries: LocalInventoryEntry[];
  complete: boolean;
  issues: LocalScanIssue[];
  /** Files skipped because they exceed this device's whole-file read limit. They never make a scan incomplete. */
  oversized: LocalFileReadBlock[];
  hashedBytes: number;
  renameCandidates: LocalRenameHint[];
  startedAt: string;
  finishedAt: string;
}

export interface LocalTargetedScanResult {
  kind: "targeted";
  requestedPaths: string[];
  observations: Record<string, LocalInventoryEntry | null>;
  complete: boolean;
  issues: LocalScanIssue[];
  oversized: LocalFileReadBlock[];
  hashedBytes: number;
  startedAt: string;
  finishedAt: string;
}

export interface LocalChangeBatch {
  sequence: number;
  paths: string[];
  renames: LocalRenameHint[];
  requiresFullScan: boolean;
}

export interface LocalReconcileStats {
  created: number;
  updated: number;
  removed: number;
  pendingDeletes: number;
  renamed: number;
  deferredCreates: number;
  tombstonesCreated: number;
  tombstonesCleared: number;
}

export interface LocalInventoryRuntimeSummary {
  status: "idle" | "scanning" | "ready" | "degraded" | "closed";
  trackedFiles: number;
  hashedBytes: number;
  issueCount: number;
  /** Bounded local-only details; support reports intentionally omit paths. */
  readBlocks: LocalFileReadBlock[];
  lastScanComplete: boolean | null;
  lastCompletedAt: string | null;
  lastReason: string | null;
  lastError: string | null;
}

export interface LocalReconcileOutcome {
  scan: LocalFullScanResult | LocalTargetedScanResult;
  stats: LocalReconcileStats;
}
