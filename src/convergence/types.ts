export type ConvergenceIssueSeverity = "error" | "warning";

export type ConvergenceIssueCode =
  | "status-projection-mismatch"
  | "clean-missing-baseline"
  | "clean-missing-local"
  | "clean-missing-remote"
  | "clean-local-path-mismatch"
  | "clean-local-hash-mismatch"
  | "clean-local-size-mismatch"
  | "clean-remote-path-mismatch"
  | "clean-remote-size-mismatch"
  | "clean-remote-content-unproven"
  | "clean-remote-identity-unanchored"
  | "baseline-object-missing"
  | "baseline-object-size-mismatch"
  | "baseline-object-hash-mismatch";

export interface ConvergenceIssue {
  severity: ConvergenceIssueSeverity;
  code: ConvergenceIssueCode;
  entryId: string;
  path: string;
  message: string;
}

export interface ConvergenceAuditReport {
  status: "healthy" | "attention";
  mode: "quick" | "deep";
  checkedAt: string;
  generation: string;
  files: number;
  cleanRecords: number;
  verifiedCleanRecords: number;
  errors: number;
  warnings: number;
  issues: ConvergenceIssue[];
}
