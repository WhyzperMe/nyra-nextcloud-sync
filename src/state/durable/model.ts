import { randomId } from "./ids";

/**
 * Schema 1 remains intentionally stable. Later revisions add backwards-compatible
 * fields that are migrated at parse time so older WAL/snapshots remain
 * replayable without rewriting immutable history.
 */
export const DURABLE_STATE_SCHEMA_VERSION = 1 as const;

export type FileSyncStatus =
  | "clean"
  | "local-dirty"
  | "remote-dirty"
  | "both-dirty"
  | "pending-delete"
  | "conflict";

/** Last common ancestor known to both replicas. */
export interface BaselineRef {
  blobHash: string;
  size: number;
  createdAt: string;
  /** Common-ancestor path. Added later; migrated from the legacy record path. */
  path: string;
  /** Remote identity/version anchors captured when the baseline was established. */
  remoteFileId: string | null;
  remoteEtag: string | null;
}

export interface LocalReplicaState {
  /** Local path is replica-specific. A remote rename must never overwrite it. */
  path: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
}

export interface RemoteReplicaState {
  /** Remote path is replica-specific. A local rename must never overwrite it. */
  path: string;
  /** Only a hash computed from downloaded bytes is trusted here. */
  contentHash: string | null;
  /** Server-reported SHA-256 is metadata/hint only and never proof of content. */
  reportedSha256: string | null;
  etag: string | null;
  fileId: string | null;
  size: number;
  mtimeMs: number | null;
}

export interface FileReplicaRecord {
  entryId: string;
  /**
   * Compatibility/display path. It is NOT an identity key and is not required
   * to be globally unique. Prefer local.path, then remote.path, then baseline.path.
   */
  path: string;
  generation: string;
  baseline: BaselineRef | null;
  local: LocalReplicaState | null;
  remote: RemoteReplicaState | null;
  /** Cached UI projection; planning derives current facts again. */
  status: FileSyncStatus;
}

export type TombstoneSide = "local" | "remote" | "both";

export interface TombstoneRecord {
  tombstoneId: string;
  entryId: string;
  previousPath: string;
  generation: string;
  deletedSide: TombstoneSide;
  previousBlobHash: string | null;
  previousRemoteFileId: string | null;
  createdAt: string;
}

export interface DurableState {
  schemaVersion: typeof DURABLE_STATE_SCHEMA_VERSION;
  storeId: string;
  generation: string;
  createdAt: string;
  updatedAt: string;
  lastWalSequence: string;
  lastWalHash: string | null;
  files: Record<string, FileReplicaRecord>;
  /** Local replica path -> entryId. Kept as pathIndex for backwards compatibility. */
  pathIndex: Record<string, string>;
  /** Remote replica path -> entryId. Cross-side path collisions are intentionally allowed. */
  remotePathIndex: Record<string, string>;
  /** Nextcloud fileId -> entryId; authoritative remote rename identity. */
  remoteFileIdIndex: Record<string, string>;
  tombstones: Record<string, TombstoneRecord>;
}

export type DurableMutation =
  | { kind: "put-file"; record: FileReplicaRecord }
  | { kind: "remove-file"; entryId: string }
  | { kind: "put-tombstone"; record: TombstoneRecord }
  | { kind: "remove-tombstone"; tombstoneId: string };

export type FileReplicaInput = Omit<FileReplicaRecord, "generation">;
export type TombstoneInput = Omit<TombstoneRecord, "generation">;

export function createEmptyState(storeId = randomId("store"), now = new Date().toISOString()): DurableState {
  return {
    schemaVersion: DURABLE_STATE_SCHEMA_VERSION,
    storeId,
    generation: "0",
    createdAt: now,
    updatedAt: now,
    lastWalSequence: "0",
    lastWalHash: null,
    files: Object.create(null) as Record<string, FileReplicaRecord>,
    pathIndex: Object.create(null) as Record<string, string>,
    remotePathIndex: Object.create(null) as Record<string, string>,
    remoteFileIdIndex: Object.create(null) as Record<string, string>,
    tombstones: Object.create(null) as Record<string, TombstoneRecord>
  };
}

export function preferredRecordPath(record: Pick<FileReplicaRecord, "path" | "local" | "remote" | "baseline">): string {
  return record.local?.path ?? record.remote?.path ?? record.baseline?.path ?? record.path;
}
