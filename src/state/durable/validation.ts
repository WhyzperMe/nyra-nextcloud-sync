import { isSha256Hex } from "./crypto";
import { assertCounter } from "./ids";
import {
  DURABLE_STATE_SCHEMA_VERSION,
  type BaselineRef,
  type DurableState,
  type FileReplicaRecord,
  type FileSyncStatus,
  type LocalReplicaState,
  type RemoteReplicaState,
  type TombstoneRecord,
  type TombstoneSide,
  preferredRecordPath
} from "./model";
import { canonicalVaultRelativePath } from "./path";

const ID = /^[A-Za-z0-9_-]{8,160}$/;
const FILE_STATUSES = new Set<FileSyncStatus>([
  "clean",
  "local-dirty",
  "remote-dirty",
  "both-dirty",
  "pending-delete",
  "conflict"
]);
const TOMBSTONE_SIDES = new Set<TombstoneSide>(["local", "remote", "both"]);

/**
 * Parse + migrate a durable state. Migration is deliberately in-memory only:
 * immutable older WAL/snapshots keep their original bytes and checksums.
 */
export function parseDurableState(raw: unknown): DurableState {
  const source = record(raw, "durable state");
  if (source.schemaVersion !== DURABLE_STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported durable-state schema version: ${String(source.schemaVersion)}.`);
  }

  const files = parseFiles(source.files);
  const state: DurableState = {
    schemaVersion: DURABLE_STATE_SCHEMA_VERSION,
    storeId: id(source.storeId, "storeId"),
    generation: counter(source.generation, "generation"),
    createdAt: timestamp(source.createdAt, "createdAt"),
    updatedAt: timestamp(source.updatedAt, "updatedAt"),
    lastWalSequence: counter(source.lastWalSequence, "lastWalSequence"),
    lastWalHash: nullableHash(source.lastWalHash, "lastWalHash"),
    files,
    // Older pathIndex meant global path ownership. It is now
    // the local-side path index and deterministically rebuilds all indexes.
    pathIndex: Object.create(null) as Record<string, string>,
    remotePathIndex: Object.create(null) as Record<string, string>,
    remoteFileIdIndex: Object.create(null) as Record<string, string>,
    tombstones: parseTombstones(source.tombstones)
  };
  rebuildIndexes(state);
  assertStateInvariants(state);
  return state;
}

export function assertStateId(value: string, label: string): void {
  if (!ID.test(value)) throw new Error(`${label} has an invalid format.`);
}

export function assertStateInvariants(state: DurableState): void {
  assertCounter(state.generation, "generation");
  assertCounter(state.lastWalSequence, "lastWalSequence");
  if (!ID.test(state.storeId)) throw new Error("Invalid storeId.");
  if (state.lastWalHash !== null && !isSha256Hex(state.lastWalHash)) throw new Error("Invalid lastWalHash.");
  if (state.lastWalSequence === "0" && state.lastWalHash !== null) throw new Error("WAL sequence 0 may not have a hash anchor.");
  if (state.lastWalSequence !== "0" && state.lastWalHash === null) throw new Error("A non-zero WAL sequence requires a hash anchor.");

  const expectedLocal = Object.create(null) as Record<string, string>;
  const expectedRemote = Object.create(null) as Record<string, string>;
  const expectedRemoteIds = Object.create(null) as Record<string, string>;

  for (const [entryId, file] of Object.entries(state.files)) {
    if (entryId !== file.entryId) throw new Error(`File map key mismatch for ${entryId}.`);
    validateFileRecord(file);
    if (BigInt(file.generation) > BigInt(state.generation)) throw new Error(`File ${entryId} belongs to a future generation.`);

    if (file.local) defineUniqueIndex(expectedLocal, file.local.path, entryId, "local path");
    if (file.remote) {
      defineUniqueIndex(expectedRemote, file.remote.path, entryId, "remote path");
      if (file.remote.fileId) defineUniqueIndex(expectedRemoteIds, file.remote.fileId, entryId, "remote file ID");
    }
  }

  assertIndexMatches(state.pathIndex, expectedLocal, "pathIndex/local paths");
  assertIndexMatches(state.remotePathIndex, expectedRemote, "remotePathIndex");
  assertIndexMatches(state.remoteFileIdIndex, expectedRemoteIds, "remoteFileIdIndex");

  for (const [tombstoneId, tombstone] of Object.entries(state.tombstones)) {
    if (tombstoneId !== tombstone.tombstoneId) throw new Error(`Tombstone map key mismatch for ${tombstoneId}.`);
    validateTombstone(tombstone);
    if (BigInt(tombstone.generation) > BigInt(state.generation)) throw new Error(`Tombstone ${tombstoneId} belongs to a future generation.`);
  }
}

export function validateFileRecord(file: FileReplicaRecord): void {
  if (!ID.test(file.entryId)) throw new Error("Invalid file entryId.");
  const canonicalDisplay = canonicalVaultRelativePath(file.path);
  if (canonicalDisplay !== file.path) throw new Error(`File display path is not canonical: ${file.path}.`);
  assertCounter(file.generation, "file generation");
  if (!FILE_STATUSES.has(file.status)) throw new Error(`Invalid file status: ${String(file.status)}.`);
  if (file.baseline !== null) validateBaseline(file.baseline);
  if (file.local !== null) validateLocal(file.local);
  if (file.remote !== null) validateRemote(file.remote);
  if (!file.baseline && !file.local && !file.remote) throw new Error(`File ${file.entryId} has no baseline or replica state.`);
  if (preferredRecordPath(file) !== file.path) {
    throw new Error(`File ${file.entryId} display path is not the deterministic preferred replica path.`);
  }
}

export function validateTombstone(tombstone: TombstoneRecord): void {
  if (!ID.test(tombstone.tombstoneId)) throw new Error("Invalid tombstoneId.");
  if (!ID.test(tombstone.entryId)) throw new Error("Invalid tombstone entryId.");
  const canonical = canonicalVaultRelativePath(tombstone.previousPath);
  if (canonical !== tombstone.previousPath) throw new Error(`Tombstone path is not canonical: ${tombstone.previousPath}.`);
  assertCounter(tombstone.generation, "tombstone generation");
  if (!TOMBSTONE_SIDES.has(tombstone.deletedSide)) throw new Error(`Invalid tombstone side: ${String(tombstone.deletedSide)}.`);
  if (tombstone.previousBlobHash !== null && !isSha256Hex(tombstone.previousBlobHash)) throw new Error("Invalid tombstone previousBlobHash.");
  if (tombstone.previousRemoteFileId !== null && !tombstone.previousRemoteFileId.trim()) throw new Error("Remote file ID may not be empty.");
  timestamp(tombstone.createdAt, "tombstone createdAt");
}

export function rebuildIndexes(state: DurableState): void {
  const local = Object.create(null) as Record<string, string>;
  const remote = Object.create(null) as Record<string, string>;
  const remoteIds = Object.create(null) as Record<string, string>;
  for (const file of Object.values(state.files)) {
    if (file.local) defineUniqueIndex(local, file.local.path, file.entryId, "local path");
    if (file.remote) {
      defineUniqueIndex(remote, file.remote.path, file.entryId, "remote path");
      if (file.remote.fileId) defineUniqueIndex(remoteIds, file.remote.fileId, file.entryId, "remote file ID");
    }
  }
  state.pathIndex = local;
  state.remotePathIndex = remote;
  state.remoteFileIdIndex = remoteIds;
}

function parseFiles(value: unknown): Record<string, FileReplicaRecord> {
  const source = record(value, "files");
  const output = Object.create(null) as Record<string, FileReplicaRecord>;
  for (const [key, raw] of Object.entries(source)) {
    const file = parseFileReplicaRecord(raw);
    if (file.entryId !== key) throw new Error(`File map key mismatch for ${key}.`);
    defineMapValue(output, key, file);
  }
  return output;
}

/** Backwards-compatible parser for older put-file records. */
export function parseFileReplicaRecord(value: unknown): FileReplicaRecord {
  const source = record(value, "file record");
  const legacyPath = canonicalVaultRelativePath(stringValue(source.path, "path"));
  const statusValue = stringValue(source.status, "file status") as FileSyncStatus;
  const local = source.local === null ? null : parseLocal(source.local, legacyPath);
  const remote = source.remote === null ? null : parseRemote(source.remote, legacyPath);
  const baseline = source.baseline === null ? null : parseBaseline(source.baseline, legacyPath, remote);
  const displayPath = local?.path ?? remote?.path ?? baseline?.path ?? legacyPath;
  const file: FileReplicaRecord = {
    entryId: id(source.entryId, "entryId"),
    path: displayPath,
    generation: counter(source.generation, "file generation"),
    baseline,
    local,
    remote,
    status: statusValue
  };
  validateFileRecord(file);
  return file;
}

function parseBaseline(value: unknown, fallbackPath: string, _currentRemote: RemoteReplicaState | null): BaselineRef {
  const source = record(value, "baseline");
  return {
    blobHash: hash(source.blobHash, "baseline blobHash"),
    size: nonNegativeSafeInteger(source.size, "baseline size"),
    createdAt: timestamp(source.createdAt, "baseline createdAt"),
    path: source.path === undefined ? fallbackPath : canonicalVaultRelativePath(stringValue(source.path, "baseline path")),
    remoteFileId: source.remoteFileId === undefined ? null : nullableNonEmptyString(source.remoteFileId, "baseline remoteFileId"),
    remoteEtag: source.remoteEtag === undefined ? null : nullableNonEmptyString(source.remoteEtag, "baseline remoteEtag")
  };
}

function parseLocal(value: unknown, fallbackPath: string): LocalReplicaState {
  const source = record(value, "local replica");
  return {
    path: source.path === undefined ? fallbackPath : canonicalVaultRelativePath(stringValue(source.path, "local path")),
    contentHash: hash(source.contentHash, "local contentHash"),
    size: nonNegativeSafeInteger(source.size, "local size"),
    mtimeMs: nonNegativeFiniteNumber(source.mtimeMs, "local mtimeMs")
  };
}

function parseRemote(value: unknown, fallbackPath: string): RemoteReplicaState {
  const source = record(value, "remote replica");
  return {
    path: source.path === undefined ? fallbackPath : canonicalVaultRelativePath(stringValue(source.path, "remote path")),
    contentHash: source.contentHash === null ? null : hash(source.contentHash, "remote contentHash"),
    reportedSha256: source.reportedSha256 === undefined || source.reportedSha256 === null ? null : hash(source.reportedSha256, "remote reportedSha256"),
    etag: nullableNonEmptyString(source.etag, "remote etag"),
    fileId: nullableNonEmptyString(source.fileId, "remote fileId"),
    size: nonNegativeSafeInteger(source.size, "remote size"),
    mtimeMs: source.mtimeMs === null ? null : nonNegativeFiniteNumber(source.mtimeMs, "remote mtimeMs")
  };
}

function parseTombstones(value: unknown): Record<string, TombstoneRecord> {
  const source = record(value, "tombstones");
  const output = Object.create(null) as Record<string, TombstoneRecord>;
  for (const [key, raw] of Object.entries(source)) {
    const tombstone = parseTombstoneRecord(raw);
    if (tombstone.tombstoneId !== key) throw new Error(`Tombstone map key mismatch for ${key}.`);
    defineMapValue(output, key, tombstone);
  }
  return output;
}

export function parseTombstoneRecord(value: unknown): TombstoneRecord {
  const item = record(value, "tombstone");
  const tombstone: TombstoneRecord = {
    tombstoneId: id(item.tombstoneId, "tombstoneId"),
    entryId: id(item.entryId, "tombstone entryId"),
    previousPath: stringValue(item.previousPath, "previousPath"),
    generation: counter(item.generation, "tombstone generation"),
    deletedSide: stringValue(item.deletedSide, "deletedSide") as TombstoneSide,
    previousBlobHash: item.previousBlobHash === null ? null : hash(item.previousBlobHash, "previousBlobHash"),
    previousRemoteFileId: nullableNonEmptyString(item.previousRemoteFileId, "previousRemoteFileId"),
    createdAt: timestamp(item.createdAt, "tombstone createdAt")
  };
  validateTombstone(tombstone);
  return tombstone;
}

function validateBaseline(value: BaselineRef): void {
  if (!isSha256Hex(value.blobHash)) throw new Error("Invalid baseline blob hash.");
  nonNegativeSafeInteger(value.size, "baseline size");
  timestamp(value.createdAt, "baseline createdAt");
  if (canonicalVaultRelativePath(value.path) !== value.path) throw new Error("Invalid baseline path.");
  if (value.remoteFileId !== null && !value.remoteFileId.trim()) throw new Error("Invalid baseline remote file ID.");
  if (value.remoteEtag !== null && !value.remoteEtag.trim()) throw new Error("Invalid baseline remote ETag.");
}

function validateLocal(value: LocalReplicaState): void {
  if (canonicalVaultRelativePath(value.path) !== value.path) throw new Error("Invalid local replica path.");
  if (!isSha256Hex(value.contentHash)) throw new Error("Invalid local content hash.");
  nonNegativeSafeInteger(value.size, "local size");
  nonNegativeFiniteNumber(value.mtimeMs, "local mtimeMs");
}

function validateRemote(value: RemoteReplicaState): void {
  if (canonicalVaultRelativePath(value.path) !== value.path) throw new Error("Invalid remote replica path.");
  if (value.contentHash !== null && !isSha256Hex(value.contentHash)) throw new Error("Invalid remote content hash.");
  if (value.reportedSha256 !== null && !isSha256Hex(value.reportedSha256)) throw new Error("Invalid remote reported SHA-256.");
  if (value.etag !== null && !value.etag.trim()) throw new Error("Remote etag may not be empty.");
  if (value.fileId !== null && !value.fileId.trim()) throw new Error("Remote file ID may not be empty.");
  nonNegativeSafeInteger(value.size, "remote size");
  if (value.mtimeMs !== null) nonNegativeFiniteNumber(value.mtimeMs, "remote mtimeMs");
}

function assertIndexMatches(actual: Record<string, string>, expected: Record<string, string>, label: string): void {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (expectedKeys.length !== actualKeys.length) throw new Error(`${label} does not match the files table.`);
  for (let i = 0; i < expectedKeys.length; i += 1) {
    const key = expectedKeys[i];
    if (key === undefined || actualKeys[i] !== key || actual[key] !== expected[key]) throw new Error(`${label} does not match the files table.`);
  }
}

function defineUniqueIndex(target: Record<string, string>, key: string, entryId: string, label: string): void {
  const owner = Object.hasOwn(target, key) ? target[key] : undefined;
  if (owner && owner !== entryId) throw new Error(`Duplicate ${label} '${key}' owned by ${owner} and ${entryId}.`);
  defineMapValue(target, key, entryId);
}

function defineMapValue<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}
function id(value: unknown, label: string): string { const result = stringValue(value, label); assertStateId(result, label); return result; }
function counter(value: unknown, label: string): string { const result = stringValue(value, label); assertCounter(result, label); return result; }
function hash(value: unknown, label: string): string { if (!isSha256Hex(value)) throw new Error(`${label} must be a SHA-256 digest.`); return value; }
function nullableHash(value: unknown, label: string): string | null { return value === null ? null : hash(value, label); }
function nullableNonEmptyString(value: unknown, label: string): string | null { if (value === null) return null; return stringValue(value, label); }
function timestamp(value: unknown, label: string): string { const result = stringValue(value, label); if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be an ISO-compatible timestamp.`); return result; }
function nonNegativeSafeInteger(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`); return value; }
function nonNegativeFiniteNumber(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number.`); return value; }
