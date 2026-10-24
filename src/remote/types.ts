export interface RemoteInventoryEntry {
  path: string;
  fileId: string;
  etag: string | null;
  size: number;
  mtimeMs: number | null;
  contentType: string | null;
  sha256Hint: string | null;
  checksums: readonly string[];
}

export type RemoteScanIssueCode =
  | "request-failed"
  | "root-missing"
  | "invalid-response"
  | "invalid-path"
  | "duplicate-file-id"
  | "duplicate-path"
  | "entry-limit"
  | "directory-limit";

export interface RemoteScanIssue {
  path: string;
  code: RemoteScanIssueCode;
  message: string;
}

export interface RemoteFullScanFields {
  kind: "full";
  rootPath: string;
  entries: RemoteInventoryEntry[];
  /** Every in-scope directory below the root (root excluded), sorted by path. */
  directories: string[];
  /** Remote files above this device's whole-file limit. Skipped, but still occupy their folders. */
  oversized: string[];
  /** ETag of the scan root collection at the start of the scan, when the server reported one. */
  rootEtag: string | null;
  directoriesVisited: number;
  metrics?: RemoteScanMetrics;
  startedAt: string;
  finishedAt: string;
}

/** A partial scan can contain positive observations but never proves absence. */
export type RemoteFullScanResult =
  | (RemoteFullScanFields & { trust: "authoritative"; complete: true; issues: [] })
  | (RemoteFullScanFields & { trust: "incomplete"; complete: false; issues: RemoteScanIssue[] });

/** Measurements from one complete recursive DAV inventory (diagnostic only). */
export interface RemoteScanMetrics {
  requestCount: number;
  responseBytes: number;
  responseEntries: number;
  networkDurationMs: number;
  parseDurationMs: number;
  elapsedMs: number;
  entriesPerSecond: number;
  peakConcurrency: number;
  retryCount: number;
}

export interface RemoteReconcileStats {
  created: number;
  updated: number;
  removed: number;
  pendingDeletes: number;
  renamed: number;
  identityReplacements: number;
  tombstonesCreated: number;
  tombstonesCleared: number;
  deferredCreates: number;
}

export interface RemoteReconcileOutcome {
  scan: RemoteFullScanResult;
  stats: RemoteReconcileStats;
}

export interface RemoteInventoryRuntimeSummary {
  status: "idle" | "scanning" | "ready" | "degraded" | "closed";
  trackedRemoteFiles: number;
  directoriesVisited: number;
  scanProgress: RemoteScanProgress | null;
  issueCount: number;
  lastScanComplete: boolean | null;
  lastCompletedAt: string | null;
  lastRootPath: string;
  lastError: string | null;
  lastMetrics: RemoteScanMetrics | null;
}

export interface RemoteScanProgress {
  directoriesCompleted: number;
  filesFound: number;
}
