import type { LocalPathPolicy } from "../local/path-policy";
import { randomId } from "../state/durable/ids";
import type { DurableState, FileReplicaRecord, RemoteReplicaState } from "../state/durable/model";
import type { DurableStateStore, DurableTransaction } from "../state/durable/store";
import { deriveFileSyncStatus } from "../sync/derived-status";
import type { RemoteFullScanResult, RemoteInventoryEntry, RemoteReconcileStats } from "./types";

/**
 * Reconciles verified WebDAV metadata into remote replica facts. Remote
 * path independent from local.path and treats Nextcloud fileId as the
 * authoritative remote rename identity. A complete scan may also prove a safe
 * same-path identity replacement when the previous fileId vanished everywhere
 * and the local side did not rename away from that path. This is required for
 * transactional server-side replacement strategies (including chunked
 * updates) while still distinguishing "rename old + create new at old path".
 */
export class RemoteInventoryReconciler {
  constructor(private readonly state: DurableStateStore, private readonly policy?: LocalPathPolicy) {}

  async applyFullScan(scan: RemoteFullScanResult): Promise<RemoteReconcileStats> {
    const stats = emptyStats();
    const before = this.state.getState();
    const remoteByPath = indexRecords(before, before.remotePathIndex);
    const localByPath = indexRecords(before, before.pathIndex);
    const byRemoteId = indexRecords(before, before.remoteFileIdIndex);
    const observedIds = new Set(scan.entries.map((entry) => entry.fileId));
    const handledEntryIds = new Set<string>();

    await this.state.transact("remote-full-inventory", (tx, base) => {
      for (const entry of scan.entries) {
        const identityMatch = byRemoteId.get(entry.fileId);
        const remotePathMatch = remoteByPath.get(entry.path);
        const localPathMatch = localByPath.get(entry.path);
        let existing: FileReplicaRecord | undefined;

        if (identityMatch) {
          existing = identityMatch;
          if (identityMatch.remote?.path !== entry.path) stats.renamed += 1;
        } else if (remotePathMatch?.remote?.fileId === entry.fileId) {
          existing = remotePathMatch;
        } else if (
          scan.trust === "authoritative" &&
          remotePathMatch?.remote?.fileId &&
          remotePathMatch.remote.fileId !== entry.fileId &&
          !observedIds.has(remotePathMatch.remote.fileId) &&
          (remotePathMatch.local === null || remotePathMatch.local.path === entry.path)
        ) {
          // Safe same-path replacement: the old remote identity disappeared from
          // the *complete* snapshot and no local rename makes the path ambiguous.
          // Keep the durable logical record, but retain the baseline's old
          // remoteFileId so the planner must verify bytes before accepting the
          // identity transition. If the old fileId still exists elsewhere, this is
          // a rename+new-file scenario and MUST stay as two identities.
          existing = remotePathMatch;
          stats.identityReplacements += 1;
        } else if (localPathMatch && localPathMatch.remote === null) {
          // Initial pairing: a local-only identity at the same path may adopt the
          // observed remote replica.
          existing = localPathMatch;
        }

        if (existing) {
          clearRemoteTombstones(tx, base, existing.entryId, stats);
          const remote = toRemote(entry, existing.remote);
          if (!sameRemote(existing.remote, remote)) {
            const next = {
              entryId: existing.entryId,
              path: existing.local?.path ?? remote.path,
              baseline: existing.baseline,
              local: existing.local,
              remote,
              status: existing.status
            };
            next.status = deriveFileSyncStatus(next);
            tx.putFile(next);
            stats.updated += 1;
          }
          handledEntryIds.add(existing.entryId);
          continue;
        }

        // Any remaining different-fileId case is identity-ambiguous (for example
        // the previous fileId still exists after a rename, or local renamed away).
        // Preserve it as a separate record so the planner cannot conflate objects.
        if (scan.trust === "authoritative") {
          const remote = toRemote(entry, null);
          tx.putFile({
            entryId: randomId("file"),
            path: remote.path,
            baseline: null,
            local: null,
            remote,
            status: "remote-dirty"
          });
          stats.created += 1;
        } else {
          stats.deferredCreates += 1;
        }
      }

      if (scan.trust !== "authoritative") return;
      for (const existing of Object.values(before.files)) {
        const previousRemote = existing.remote;
        if (!previousRemote || handledEntryIds.has(existing.entryId)) continue;
        if (this.policy && !this.policy.isIncluded(previousRemote.path)) continue;
        // If the old fileId is still present somewhere in the complete scan it
        // was a rename and should have been identity-matched above.
        if (previousRemote.fileId && observedIds.has(previousRemote.fileId)) continue;
        observeRemoteMissing(tx, base, existing, stats);
      }
    });
    return stats;
  }
}

function indexRecords(state: DurableState, index: Record<string, string>): Map<string, FileReplicaRecord> {
  const result = new Map<string, FileReplicaRecord>();
  for (const [key, entryId] of Object.entries(index)) {
    const record = state.files[entryId];
    if (record) result.set(key, record);
  }
  return result;
}

function observeRemoteMissing(tx: DurableTransaction, base: DurableState, existing: FileReplicaRecord, stats: RemoteReconcileStats): void {
  if (!existing.remote) return;
  if (existing.local === null && existing.baseline === null) {
    tx.removeFile(existing.entryId);
    clearRemoteTombstones(tx, base, existing.entryId, stats);
    stats.removed += 1;
    return;
  }
  ensureRemoteTombstone(tx, base, existing, stats);
  const next = {
    entryId: existing.entryId,
    path: existing.local?.path ?? existing.baseline?.path ?? existing.path,
    baseline: existing.baseline,
    local: existing.local,
    remote: null,
    status: existing.status
  };
  next.status = deriveFileSyncStatus(next);
  tx.putFile(next);
  stats.pendingDeletes += 1;
}

function ensureRemoteTombstone(tx: DurableTransaction, base: DurableState, existing: FileReplicaRecord, stats: RemoteReconcileStats): void {
  const alreadyExists = Object.values(base.tombstones).some((item) => item.entryId === existing.entryId && (item.deletedSide === "remote" || item.deletedSide === "both"));
  if (alreadyExists) return;
  tx.putTombstone({
    tombstoneId: randomId("tomb"),
    entryId: existing.entryId,
    previousPath: existing.remote?.path ?? existing.path,
    deletedSide: "remote",
    previousBlobHash: existing.baseline?.blobHash ?? null,
    previousRemoteFileId: existing.remote?.fileId ?? null,
    createdAt: new Date().toISOString()
  });
  stats.tombstonesCreated += 1;
}

function clearRemoteTombstones(tx: DurableTransaction, base: DurableState, entryId: string, stats: RemoteReconcileStats): void {
  for (const tombstone of Object.values(base.tombstones)) {
    if (tombstone.entryId === entryId && (tombstone.deletedSide === "remote" || tombstone.deletedSide === "both")) {
      tx.removeTombstone(tombstone.tombstoneId);
      stats.tombstonesCleared += 1;
    }
  }
}

function toRemote(entry: RemoteInventoryEntry, previous: RemoteReplicaState | null): RemoteReplicaState {
  // A trusted content hash survives metadata-only rescans only when the same
  // Nextcloud object has the exact same non-null ETag and size. This keeps a
  // successful verification useful across inventory reconciliation without ever
  // promoting server-reported checksums to trusted proof.
  const preserveTrustedHash = previous !== null && previous.contentHash !== null &&
    previous.fileId === entry.fileId && previous.etag !== null && entry.etag !== null &&
    previous.etag === entry.etag && previous.size === entry.size;
  return {
    path: entry.path,
    contentHash: preserveTrustedHash ? previous.contentHash : null,
    reportedSha256: entry.sha256Hint,
    etag: entry.etag,
    fileId: entry.fileId,
    size: entry.size,
    mtimeMs: entry.mtimeMs
  };
}

function sameRemote(left: RemoteReplicaState | null, right: RemoteReplicaState): boolean {
  return !!left && left.path === right.path && left.contentHash === right.contentHash && left.reportedSha256 === right.reportedSha256 &&
    left.etag === right.etag && left.fileId === right.fileId && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function emptyStats(): RemoteReconcileStats {
  return { created: 0, updated: 0, removed: 0, pendingDeletes: 0, renamed: 0, identityReplacements: 0, tombstonesCreated: 0, tombstonesCleared: 0, deferredCreates: 0 };
}
