export const SYNC_PLAN_VERSION = 2 as const;

export type SyncClassification =
  | "in-sync"
  | "local-create"
  | "remote-create"
  | "converged-unbaselined"
  | "concurrent-create"
  | "local-change"
  | "remote-change"
  | "both-change"
  | "local-delete"
  | "remote-delete"
  | "both-delete"
  | "delete-vs-change"
  | "rename-conflict"
  | "orthogonal-rename-content"
  | "same-content-converged"
  | "path-identity-collision"
  | "needs-remote-verification"
  | "invalid-state";

export type SyncPlanDisposition = "noop" | "ready" | "needs-verification" | "merge-candidate" | "blocked";

export type SyncPlanStepKind =
  | "verify-remote-content"
  | "upload-create"
  | "upload-update"
  | "download-create"
  | "download-update"
  | "move-local"
  | "move-remote"
  | "delete-local"
  | "delete-remote"
  | "merge-text"
  | "establish-baseline"
  | "retire-record"
  | "manual-resolution";

export interface SyncPlanStep {
  kind: SyncPlanStepKind;
  sourcePath: string | null;
  targetPath: string | null;
  destructive: boolean;
  requiresFreshRemoteEtag: boolean;
  description: string;
}

export interface SyncPlanItem {
  entryId: string;
  displayPath: string;
  baselinePath: string | null;
  localPath: string | null;
  remotePath: string | null;
  classification: SyncClassification;
  disposition: SyncPlanDisposition;
  reasons: string[];
  steps: SyncPlanStep[];
  localChanged: boolean | null;
  remoteChanged: boolean | null;
  localPathChanged: boolean | null;
  remotePathChanged: boolean | null;
  remoteIdentityChanged: boolean | null;
  remoteContentKnown: boolean;
}

export interface SyncPlanSummary {
  total: number;
  noop: number;
  ready: number;
  needsVerification: number;
  mergeCandidates: number;
  blocked: number;
  destructiveSteps: number;
  remoteVerifications: number;
}

export interface SyncPlan {
  version: typeof SYNC_PLAN_VERSION;
  createdAt: string;
  storeId: string;
  stateGeneration: string;
  walSequence: string;
  walHash: string | null;
  fingerprint: string;
  items: SyncPlanItem[];
  summary: SyncPlanSummary;
}

export interface SyncPlannerRuntimeSummary {
  status: "idle" | "planning" | "ready" | "blocked" | "stale" | "closed";
  lastCompletedAt: string | null;
  lastFingerprint: string | null;
  stateGeneration: string | null;
  summary: SyncPlanSummary | null;
  lastError: string | null;
}
