import type { DurableState, FileReplicaRecord } from "../state/durable/model";
import type { DurableStateStore } from "../state/durable/store";
import { sha256Hex } from "../state/durable/crypto";
import { deriveFileSyncStatus, remoteContentRelation } from "../sync/derived-status";
import type { ConvergenceAuditReport, ConvergenceIssue } from "./types";

export interface ConvergenceAuditOptions {
  mode?: "quick" | "deep";
  includePath?: (path: string) => boolean;
  maxIssues?: number;
}

/**
 * Semantic consistency audit for the durable LOCAL / BASE / REMOTE model.
 *
 * State validation proves shape/index/WAL correctness. This auditor proves a
 * different property: records that claim to be clean must actually describe a
 * common ancestor shared by both replicas, and cached status projections must
 * agree with the current replica facts. Deep mode additionally verifies every
 * baseline blob used by an in-scope record.
 *
 * It never mutates state or user files.
 */
export class ConvergenceAuditor {
  constructor(private readonly store: DurableStateStore) {}

  async audit(options: ConvergenceAuditOptions = {}): Promise<ConvergenceAuditReport> {
    const mode = options.mode ?? "quick";
    const includePath = options.includePath ?? (() => true);
    const maxIssues = normalizeMaxIssues(options.maxIssues);
    const state = this.store.getState();
    const issues: ConvergenceIssue[] = [];
    let cleanRecords = 0;
    let verifiedCleanRecords = 0;

    for (const record of Object.values(state.files)) {
      const path = record.local?.path ?? record.remote?.path ?? record.baseline?.path ?? record.path;
      if (!includePath(path)) continue;
      const before = issues.length;
      auditRecordFacts(record, issues, maxIssues);
      if (record.status === "clean") {
        cleanRecords += 1;
        if (issues.length === before) verifiedCleanRecords += 1;
      }
      if (mode === "deep" && record.baseline && issues.length < maxIssues) {
        await auditBaselineObject(this.store, record, issues, maxIssues);
      }
      if (issues.length >= maxIssues) break;
    }

    const errors = issues.filter((issue) => issue.severity === "error").length;
    const warnings = issues.length - errors;
    return {
      status: errors > 0 ? "attention" : "healthy",
      mode,
      checkedAt: new Date().toISOString(),
      generation: state.generation,
      files: countIncluded(state, includePath),
      cleanRecords,
      verifiedCleanRecords,
      errors,
      warnings,
      issues
    };
  }
}

/** Dependency-free helper shared by the runtime audit and the soak tests. */
export function auditConvergenceState(
  state: DurableState,
  includePath: (path: string) => boolean = () => true,
  maxIssues = 256
): ConvergenceAuditReport {
  const issues: ConvergenceIssue[] = [];
  let cleanRecords = 0;
  let verifiedCleanRecords = 0;
  for (const record of Object.values(state.files)) {
    const path = record.local?.path ?? record.remote?.path ?? record.baseline?.path ?? record.path;
    if (!includePath(path)) continue;
    const before = issues.length;
    auditRecordFacts(record, issues, normalizeMaxIssues(maxIssues));
    if (record.status === "clean") {
      cleanRecords += 1;
      if (issues.length === before) verifiedCleanRecords += 1;
    }
    if (issues.length >= maxIssues) break;
  }
  const errors = issues.filter((issue) => issue.severity === "error").length;
  return {
    status: errors > 0 ? "attention" : "healthy",
    mode: "quick",
    checkedAt: new Date().toISOString(),
    generation: state.generation,
    files: countIncluded(state, includePath),
    cleanRecords,
    verifiedCleanRecords,
    errors,
    warnings: issues.length - errors,
    issues
  };
}

function auditRecordFacts(record: FileReplicaRecord, issues: ConvergenceIssue[], maxIssues: number): void {
  const path = record.local?.path ?? record.remote?.path ?? record.baseline?.path ?? record.path;
  const derived = deriveFileSyncStatus(record);
  if (derived !== record.status) {
    pushIssue(issues, maxIssues, {
      severity: "warning",
      code: "status-projection-mismatch",
      entryId: record.entryId,
      path,
      message: `Cached status '${record.status}' disagrees with the derived replica state '${derived}'.`
    });
  }

  if (record.status !== "clean") return;
  const baseline = record.baseline;
  const local = record.local;
  const remote = record.remote;

  if (!baseline) {
    pushIssue(issues, maxIssues, issue(record, path, "clean-missing-baseline", "A clean record has no common ancestor."));
    return;
  }
  if (!local) pushIssue(issues, maxIssues, issue(record, path, "clean-missing-local", "A clean record has no local replica."));
  if (!remote) pushIssue(issues, maxIssues, issue(record, path, "clean-missing-remote", "A clean record has no remote replica."));
  if (!local || !remote) return;

  if (local.path !== baseline.path) pushIssue(issues, maxIssues, issue(record, path, "clean-local-path-mismatch", "Clean local path differs from BASE."));
  if (local.contentHash !== baseline.blobHash) pushIssue(issues, maxIssues, issue(record, path, "clean-local-hash-mismatch", "Clean local hash differs from BASE."));
  if (local.size !== baseline.size) pushIssue(issues, maxIssues, issue(record, path, "clean-local-size-mismatch", "Clean local size differs from BASE."));
  if (remote.path !== baseline.path) pushIssue(issues, maxIssues, issue(record, path, "clean-remote-path-mismatch", "Clean remote path differs from BASE."));
  if (remote.size !== baseline.size) pushIssue(issues, maxIssues, issue(record, path, "clean-remote-size-mismatch", "Clean remote size differs from BASE."));
  if (remoteContentRelation(record) !== "same") pushIssue(issues, maxIssues, issue(record, path, "clean-remote-content-unproven", "Clean remote content is not cryptographically or version-anchor proven equal to BASE."));
  if (baseline.remoteFileId !== null && remote.fileId !== baseline.remoteFileId) {
    pushIssue(issues, maxIssues, issue(record, path, "clean-remote-identity-unanchored", "Clean remote file identity differs from the BASE anchor."));
  }
}

async function auditBaselineObject(store: DurableStateStore, record: FileReplicaRecord, issues: ConvergenceIssue[], maxIssues: number): Promise<void> {
  const baseline = record.baseline;
  if (!baseline) return;
  const path = record.local?.path ?? record.remote?.path ?? baseline.path;
  let bytes: ArrayBuffer;
  try {
    bytes = await store.getBlob(baseline.blobHash);
  } catch (error) {
    pushIssue(issues, maxIssues, issue(record, path, "baseline-object-missing", `BASE object cannot be read: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  if (bytes.byteLength !== baseline.size) {
    pushIssue(issues, maxIssues, issue(record, path, "baseline-object-size-mismatch", `BASE object size ${bytes.byteLength} differs from recorded ${baseline.size}.`));
    return;
  }
  const hash = await sha256Hex(bytes);
  if (hash !== baseline.blobHash) {
    pushIssue(issues, maxIssues, issue(record, path, "baseline-object-hash-mismatch", "BASE object SHA-256 differs from its content-addressed key."));
  }
}

function issue(record: FileReplicaRecord, path: string, code: ConvergenceIssue["code"], message: string): ConvergenceIssue {
  return { severity: "error", code, entryId: record.entryId, path, message };
}

function pushIssue(target: ConvergenceIssue[], maxIssues: number, value: ConvergenceIssue): void {
  if (target.length < maxIssues) target.push(value);
}

function normalizeMaxIssues(value: number | undefined): number {
  if (value === undefined) return 256;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error("maxIssues must be a safe integer between 1 and 10000.");
  return value;
}

function countIncluded(state: DurableState, includePath: (path: string) => boolean): number {
  let count = 0;
  for (const record of Object.values(state.files)) {
    const path = record.local?.path ?? record.remote?.path ?? record.baseline?.path ?? record.path;
    if (includePath(path)) count += 1;
  }
  return count;
}
