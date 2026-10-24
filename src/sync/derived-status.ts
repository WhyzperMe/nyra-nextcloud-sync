import type { FileReplicaRecord, FileSyncStatus } from "../state/durable/model";

export function deriveOverviewSyncState(facts: {
  blocked: boolean; busy: boolean; offline: boolean; waiting: boolean; attention: boolean;
}): "Synced" | "Syncing" | "Offline" | "Needs attention" {
  if (facts.blocked) return "Needs attention";
  if (facts.busy) return "Syncing";
  if (facts.offline) return "Offline";
  if (facts.waiting) return "Syncing";
  return facts.attention ? "Needs attention" : "Synced";
}

/**
 * Conservative cached status projection. The planner does not trust this
 * field as a decision oracle; it recomputes richer facts from the replicas.
 */
export function deriveFileSyncStatus(record: Omit<FileReplicaRecord, "status" | "generation">): FileSyncStatus {
  const { baseline, local, remote } = record;
  if (!baseline) {
    if (local && remote) return "both-dirty";
    if (local) return "local-dirty";
    if (remote) return "remote-dirty";
    return "conflict";
  }

  const localChanged = local === null || local.path !== baseline.path || local.contentHash !== baseline.blobHash;
  const remoteContent = remoteContentRelation(record as FileReplicaRecord);
  const remoteIdentityChanged = remote !== null && baseline.remoteFileId !== null && remote.fileId !== null && remote.fileId !== baseline.remoteFileId;
  const remoteChanged = remote === null || remote.path !== baseline.path || remoteContent !== "same" || remoteIdentityChanged;

  if ((local === null) !== (remote === null)) {
    if ((local === null && !remoteChanged) || (remote === null && !localChanged)) return "pending-delete";
  }
  if (localChanged && remoteChanged) return "both-dirty";
  if (localChanged) return "local-dirty";
  if (remoteChanged) return "remote-dirty";
  return "clean";
}

export type RemoteContentRelation = "same" | "different" | "unknown";

export function remoteContentRelation(record: Pick<FileReplicaRecord, "baseline" | "remote">): RemoteContentRelation {
  const { baseline, remote } = record;
  if (!baseline || !remote) return "unknown";
  // Even a reused ETag cannot make different byte lengths the same content.
  // In particular, never authorize deletion of a changed surviving replica.
  if (remote.size !== baseline.size) return "different";
  if (remote.contentHash !== null) return remote.contentHash === baseline.blobHash ? "same" : "different";
  if (
    baseline.remoteFileId !== null &&
    baseline.remoteEtag !== null &&
    remote.fileId === baseline.remoteFileId &&
    remote.etag === baseline.remoteEtag
  ) return "same";
  return "unknown";
}
