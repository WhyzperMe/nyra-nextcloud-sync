import { canonicalVaultRelativePath } from "../state/durable/path";
import type { FileReplicaRecord } from "../state/durable/model";

export interface SyncConflictReview {
  entryId: string;
  path: string;
  classification: string;
  reasons: string[];
  local: { path: string; sha256: string; size: number; mtimeMs: number } | null;
  base: { path: string; sha256: string; size: number; createdAt: string } | null;
  remote: { path: string; sha256: string | null; size: number; mtimeMs: number | null; fileId: string | null; etag: string | null } | null;
}

export function conflictCopyPath(sourcePath: string, side: "LOCAL" | "REMOTE", hash: string): string {
  const slash = sourcePath.lastIndexOf("/");
  const directory = slash < 0 ? "" : sourcePath.slice(0, slash + 1);
  const name = sourcePath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return canonicalVaultRelativePath(`${directory}${stem} (Nyra conflict ${side} ${hash.slice(0, 12)})${extension}`);
}

export function addConflictSuffix(path: string, suffix: number): string {
  const slash = path.lastIndexOf("/");
  const directory = slash < 0 ? "" : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${directory}${stem} (${suffix})${extension}`;
}

export function sameConflictSource(before: FileReplicaRecord, current: FileReplicaRecord | undefined): boolean {
  if (!current || !before.local || !current.local || !before.remote || !current.remote) return false;
  return before.local.path === current.local.path && before.local.contentHash === current.local.contentHash && before.local.size === current.local.size &&
    before.remote.path === current.remote.path && before.remote.contentHash === current.remote.contentHash && before.remote.fileId === current.remote.fileId &&
    before.remote.etag === current.remote.etag && before.remote.size === current.remote.size &&
    before.baseline?.blobHash === current.baseline?.blobHash && before.baseline?.path === current.baseline?.path &&
    before.baseline?.size === current.baseline?.size && before.baseline?.remoteFileId === current.baseline?.remoteFileId &&
    before.baseline?.remoteEtag === current.baseline?.remoteEtag;
}

export function mergeReviewFingerprint(record: FileReplicaRecord): string {
  return JSON.stringify({
    base: record.baseline ? [record.baseline.path, record.baseline.blobHash, record.baseline.size, record.baseline.remoteFileId, record.baseline.remoteEtag] : null,
    local: record.local ? [record.local.path, record.local.contentHash, record.local.size] : null,
    remote: record.remote ? [record.remote.path, record.remote.contentHash, record.remote.size, record.remote.fileId, record.remote.etag] : null
  });
}
