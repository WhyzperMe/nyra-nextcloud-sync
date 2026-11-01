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

/** Splits a file name into stem and extension; `.excalidraw.md` stays together so the copy is still a drawing. */
function splitName(name: string): { stem: string; extension: string } {
  const drawing = /^(.+?)(.excalidraw.md)$/i.exec(name);
  if (drawing) return { stem: drawing[1]!, extension: drawing[2]! };
  const dot = name.lastIndexOf(".");
  return { stem: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot) : "" };
}

export function conflictCopyPath(sourcePath: string, side: "LOCAL" | "REMOTE", hash: string): string {
  const slash = sourcePath.lastIndexOf("/");
  const directory = slash < 0 ? "" : sourcePath.slice(0, slash + 1);
  const { stem, extension } = splitName(sourcePath.slice(slash + 1));
  return canonicalVaultRelativePath(`${directory}${stem} (Nyra conflict ${side} ${hash.slice(0, 12)})${extension}`);
}

export function addConflictSuffix(path: string, suffix: number): string {
  const slash = path.lastIndexOf("/");
  const directory = slash < 0 ? "" : path.slice(0, slash + 1);
  const { stem, extension } = splitName(path.slice(slash + 1));
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
