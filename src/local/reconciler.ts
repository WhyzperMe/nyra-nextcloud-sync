import { randomId } from "../state/durable/ids";
import type { DurableState, FileReplicaRecord, LocalReplicaState } from "../state/durable/model";
import type { DurableStateStore, DurableTransaction } from "../state/durable/store";
import { deriveFileSyncStatus } from "../sync/derived-status";
import type { LocalPathPolicy } from "./path-policy";
import type {
  LocalFullScanResult,
  LocalInventoryEntry,
  LocalReconcileStats,
  LocalRenameHint,
  LocalTargetedScanResult
} from "./types";

export interface LocalReconcileOptions {
  exactRenames: readonly LocalRenameHint[];
  allowNewRecords: boolean;
}

/** Converts verified observations to replica facts without changing remote paths. */
export class LocalInventoryReconciler {
  constructor(private readonly state: DurableStateStore, private readonly policy?: LocalPathPolicy) {}

  async applyFullScan(scan: LocalFullScanResult, options: LocalReconcileOptions): Promise<LocalReconcileStats> {
    const stats = emptyStats();
    const before = this.state.getState();
    const localByPath = indexRecords(before, before.pathIndex);
    const remoteByPath = indexRecords(before, before.remotePathIndex);
    const observed = new Map(scan.entries.map((entry) => [entry.path, entry]));
    const renames = acceptedExactRenames(options.exactRenames, localByPath, observed);
    const mayCreate = options.allowNewRecords && scan.complete;

    await this.state.transact("local-full-inventory", (tx, base) => {
      const handledOld = new Set<string>();
      const handledNew = new Set<string>();
      applyRenames(tx, renames, localByPath, observed, base, handledOld, handledNew, stats);

      for (const entry of scan.entries) {
        if (handledNew.has(entry.path)) continue;
        const existing = localByPath.get(entry.path) ?? attachableRemoteOnly(remoteByPath.get(entry.path));
        if (existing) {
          clearLocalTombstones(tx, base, existing.entryId, stats);
          if (!sameLocal(existing.local, entry)) {
            putObserved(tx, existing, entry);
            stats.updated += 1;
          }
        } else if (mayCreate) {
          tx.putFile(newLocalOnlyRecord(entry));
          stats.created += 1;
        } else {
          stats.deferredCreates += 1;
        }
      }

      if (scan.complete) {
        for (const existing of Object.values(before.files)) {
          const localPath = existing.local?.path;
          if (!localPath || handledOld.has(localPath) || observed.has(localPath)) continue;
          // A path intentionally outside the current sync scope is not a
          // deletion. Keep its durable facts dormant so toggling the scope cannot
          // manufacture destructive work.
          if (this.policy && !this.policy.isIncluded(localPath)) continue;
          observeMissing(tx, base, existing, stats);
        }
      }
    });
    return stats;
  }

  async applyTargetedScan(scan: LocalTargetedScanResult, options: LocalReconcileOptions): Promise<LocalReconcileStats> {
    const stats = emptyStats();
    const before = this.state.getState();
    const localByPath = indexRecords(before, before.pathIndex);
    const remoteByPath = indexRecords(before, before.remotePathIndex);
    const observed = new Map<string, LocalInventoryEntry | null>();
    for (const path of scan.requestedPaths) {
      if (Object.hasOwn(scan.observations, path)) observed.set(path, scan.observations[path] ?? null);
    }
    const present = new Map([...observed].filter((pair): pair is [string, LocalInventoryEntry] => pair[1] !== null));
    const renames = acceptedExactRenames(options.exactRenames, localByPath, present);
    const mayCreate = options.allowNewRecords && scan.complete;

    await this.state.transact("local-targeted-inventory", (tx, base) => {
      const handledOld = new Set<string>();
      const handledNew = new Set<string>();
      applyRenames(tx, renames, localByPath, present, base, handledOld, handledNew, stats);

      for (const [path, entry] of observed) {
        if (handledOld.has(path) || handledNew.has(path)) continue;
        const existing = localByPath.get(path) ?? attachableRemoteOnly(remoteByPath.get(path));
        if (entry) {
          if (existing) {
            clearLocalTombstones(tx, base, existing.entryId, stats);
            if (!sameLocal(existing.local, entry)) {
              putObserved(tx, existing, entry);
              stats.updated += 1;
            }
          } else if (mayCreate) {
            tx.putFile(newLocalOnlyRecord(entry));
            stats.created += 1;
          } else {
            stats.deferredCreates += 1;
          }
        } else if (existing?.local && scan.complete) {
          observeMissing(tx, base, existing, stats);
        }
      }
    });
    return stats;
  }
}

function indexRecords(state: DurableState, index: Record<string, string>): Map<string, FileReplicaRecord> {
  const result = new Map<string, FileReplicaRecord>();
  for (const [path, entryId] of Object.entries(index)) {
    const record = state.files[entryId];
    if (record) result.set(path, record);
  }
  return result;
}

function attachableRemoteOnly(record: FileReplicaRecord | undefined): FileReplicaRecord | undefined {
  return record && record.local === null ? record : undefined;
}

function applyRenames(
  tx: DurableTransaction,
  renames: ReadonlyMap<string, string>,
  localByPath: ReadonlyMap<string, FileReplicaRecord>,
  observed: ReadonlyMap<string, LocalInventoryEntry>,
  base: DurableState,
  handledOld: Set<string>,
  handledNew: Set<string>,
  stats: LocalReconcileStats
): void {
  for (const [oldPath, newPath] of renames) {
    const existing = localByPath.get(oldPath);
    const entry = observed.get(newPath);
    if (!existing || !entry) continue;
    clearLocalTombstones(tx, base, existing.entryId, stats);
    putObserved(tx, existing, entry);
    handledOld.add(oldPath);
    handledNew.add(newPath);
    stats.renamed += 1;
    if (!sameLocal(existing.local, entry)) stats.updated += 1;
  }
}

function acceptedExactRenames(
  hints: readonly LocalRenameHint[],
  existingByPath: ReadonlyMap<string, FileReplicaRecord>,
  currentByPath: ReadonlyMap<string, LocalInventoryEntry>
): Map<string, string> {
  const accepted = new Map<string, string>();
  const claimedTargets = new Set<string>();

  for (const hint of hints) {
    if (hint.confidence !== "exact" || hint.source !== "vault-event") continue;
    if (hint.kind === "file") {
      acceptPair(hint.oldPath, hint.newPath);
      continue;
    }
    const oldPrefix = `${hint.oldPath}/`;
    const newPrefix = `${hint.newPath}/`;
    const descendants = [...existingByPath.keys()].filter((path) => path.startsWith(oldPrefix)).sort();
    for (const oldPath of descendants) acceptPair(oldPath, `${newPrefix}${oldPath.slice(oldPrefix.length)}`);
  }
  return accepted;

  function acceptPair(oldPath: string, newPath: string): void {
    const existing = existingByPath.get(oldPath);
    const target = currentByPath.get(newPath);
    if (!existing || !target) return;
    const targetOwner = existingByPath.get(newPath);
    if (targetOwner && targetOwner.entryId !== existing.entryId) return;
    if (claimedTargets.has(newPath) || accepted.has(oldPath)) return;
    accepted.set(oldPath, newPath);
    claimedTargets.add(newPath);
  }
}

function putObserved(tx: DurableTransaction, existing: FileReplicaRecord, entry: LocalInventoryEntry): void {
  const local = toLocal(entry);
  const next = {
    entryId: existing.entryId,
    path: local.path,
    baseline: existing.baseline,
    local,
    remote: existing.remote,
    status: existing.status
  };
  next.status = deriveFileSyncStatus(next);
  tx.putFile(next);
}

function observeMissing(tx: DurableTransaction, base: DurableState, existing: FileReplicaRecord, stats: LocalReconcileStats): void {
  if (!existing.local) return;
  if (existing.baseline === null && existing.remote === null) {
    tx.removeFile(existing.entryId);
    clearLocalTombstones(tx, base, existing.entryId, stats);
    stats.removed += 1;
    return;
  }
  ensureLocalTombstone(tx, base, existing, stats);
  const next = {
    entryId: existing.entryId,
    path: existing.remote?.path ?? existing.baseline?.path ?? existing.path,
    baseline: existing.baseline,
    local: null,
    remote: existing.remote,
    status: existing.status
  };
  next.status = deriveFileSyncStatus(next);
  tx.putFile(next);
  stats.pendingDeletes += 1;
}

function ensureLocalTombstone(tx: DurableTransaction, base: DurableState, existing: FileReplicaRecord, stats: LocalReconcileStats): void {
  const already = Object.values(base.tombstones).some((item) => item.entryId === existing.entryId && (item.deletedSide === "local" || item.deletedSide === "both"));
  if (already) return;
  tx.putTombstone({
    tombstoneId: randomId("tomb"),
    entryId: existing.entryId,
    previousPath: existing.local?.path ?? existing.path,
    deletedSide: "local",
    previousBlobHash: existing.baseline?.blobHash ?? existing.local?.contentHash ?? null,
    previousRemoteFileId: existing.remote?.fileId ?? null,
    createdAt: new Date().toISOString()
  });
  stats.tombstonesCreated = (stats.tombstonesCreated ?? 0) + 1;
}

function clearLocalTombstones(tx: DurableTransaction, base: DurableState, entryId: string, stats: LocalReconcileStats): void {
  for (const tombstone of Object.values(base.tombstones)) {
    if (tombstone.entryId === entryId && (tombstone.deletedSide === "local" || tombstone.deletedSide === "both")) {
      tx.removeTombstone(tombstone.tombstoneId);
      stats.tombstonesCleared = (stats.tombstonesCleared ?? 0) + 1;
    }
  }
}

function newLocalOnlyRecord(entry: LocalInventoryEntry) {
  const local = toLocal(entry);
  return { entryId: randomId("file"), path: local.path, baseline: null, local, remote: null, status: "local-dirty" as const };
}

function toLocal(entry: LocalInventoryEntry): LocalReplicaState {
  return { path: entry.path, contentHash: entry.contentHash, size: entry.size, mtimeMs: entry.mtimeMs };
}

function sameLocal(local: LocalReplicaState | null, entry: LocalInventoryEntry): boolean {
  return !!local && local.path === entry.path && local.contentHash === entry.contentHash && local.size === entry.size && local.mtimeMs === entry.mtimeMs;
}

function emptyStats(): LocalReconcileStats {
  return { created: 0, updated: 0, removed: 0, pendingDeletes: 0, renamed: 0, deferredCreates: 0, tombstonesCreated: 0, tombstonesCleared: 0 };
}
