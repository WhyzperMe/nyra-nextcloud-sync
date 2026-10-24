import type { StateBackend } from "./backend";
import { canonicalStringify } from "./canonical-json";
import { isSha256Hex, sha256Hex } from "./crypto";
import { compareCounters, incrementCounter, padCounter, randomId } from "./ids";
import { writeImmutableText } from "./immutable-write";
import type { DurableMutation } from "./model";
import { assertStateId, parseFileReplicaRecord, parseTombstoneRecord } from "./validation";

export const WAL_FORMAT_VERSION = 1 as const;
const WAL_DIR = "wal";
const WAL_FILE = /^(\d{24})-([A-Za-z0-9_-]+)\.wal\.json$/;

export type WalEvent =
  | { kind: "store-created"; createdAt: string }
  | { kind: "transaction-begin"; transactionId: string; baseGeneration: string; reason: string }
  | {
      kind: "transaction-commit";
      transactionId: string;
      baseGeneration: string;
      newGeneration: string;
      mutations: DurableMutation[];
    }
  | {
      kind: "transaction-abort";
      transactionId: string;
      baseGeneration: string;
      reason: "crash-recovery";
    };

export interface WalRecordCore {
  formatVersion: typeof WAL_FORMAT_VERSION;
  recordId: string;
  storeId: string;
  sequence: string;
  previousRecordHash: string | null;
  writtenAt: string;
  event: WalEvent;
}

export interface WalRecord extends WalRecordCore {
  recordHash: string;
}

export interface WalFileIndexEntry {
  fileName: string;
  sequence: string;
  recordId: string;
}

export class WalJournal {
  private storeId: string | null = null;
  private headSequence = "0";
  private headHash: string | null = null;
  private writeFailure: string | null = null;

  constructor(private readonly backend: StateBackend) {}

  async ensureDirectory(): Promise<void> {
    await this.backend.mkdirp(WAL_DIR);
  }

  initialize(storeId: string, sequence: string, hash: string | null): void {
    assertStateId(storeId, "WAL storeId");
    this.storeId = storeId;
    this.headSequence = sequence;
    this.headHash = hash;
    this.writeFailure = null;
  }

  getHead(): { sequence: string; hash: string | null } {
    return { sequence: this.headSequence, hash: this.headHash };
  }

  isWritePoisoned(): boolean {
    return this.writeFailure !== null;
  }

  async append(event: WalEvent): Promise<WalRecord> {
    if (!this.storeId) throw new Error("WAL journal has not been initialized.");
    if (this.writeFailure) {
      throw new Error(`WAL writes are disabled until recovery: ${this.writeFailure}`);
    }
    const sequence = incrementCounter(this.headSequence);
    const core: WalRecordCore = {
      formatVersion: WAL_FORMAT_VERSION,
      recordId: randomId("wal"),
      storeId: this.storeId,
      sequence,
      previousRecordHash: this.headHash,
      writtenAt: new Date().toISOString(),
      event: structuredClone(event)
    };
    validateWalCore(core);
    const recordHash = await sha256Hex(canonicalStringify(core));
    const record: WalRecord = { ...core, recordHash };
    const fileName = `${padCounter(sequence)}-${core.recordId}.wal.json`;
    const finalPath = `${WAL_DIR}/${fileName}`;
    const serialized = canonicalStringify(record);
    try {
      await writeImmutableText(this.backend, finalPath, serialized);
    } catch (error) {
      // A storage adapter can report an error after the rename reached stable
      // storage. Resolve that ambiguity once. If the exact record cannot be
      // proven present, poison this journal instance and require startup replay
      // before any later write. Retrying with the same in-memory head could
      // otherwise fork a sequence number.
      if (!(await this.isExactCommittedRecord(finalPath, record))) {
        this.writeFailure = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }

    this.headSequence = sequence;
    this.headHash = recordHash;
    return record;
  }

  private async isExactCommittedRecord(path: string, expected: WalRecord): Promise<boolean> {
    try {
      if (!(await this.backend.exists(path))) return false;
      const text = await this.backend.readText(path);
      const parsed = await parseWalRecord(JSON.parse(text) as unknown);
      return parsed.sequence === expected.sequence && parsed.recordHash === expected.recordHash;
    } catch {
      return false;
    }
  }

  async index(): Promise<WalFileIndexEntry[]> {
    await this.ensureDirectory();
    const listing = await this.backend.list(WAL_DIR);
    const entries: WalFileIndexEntry[] = [];
    const seen = new Set<string>();

    for (const fileName of listing.files) {
      if (fileName.endsWith(".tmp")) continue;
      if (!fileName.endsWith(".wal.json")) continue;
      const match = WAL_FILE.exec(fileName);
      if (!match || !match[1]) throw new Error(`Malformed WAL filename: ${fileName}.`);
      const sequence = BigInt(match[1]).toString();
      const recordId = match[2];
      if (!recordId) throw new Error(`Malformed WAL record ID in filename: ${fileName}.`);
      if (seen.has(sequence)) throw new Error(`Duplicate WAL sequence ${sequence}.`);
      seen.add(sequence);
      entries.push({ fileName, sequence, recordId });
    }

    entries.sort((a, b) => compareCounters(a.sequence, b.sequence));
    return entries;
  }

  async read(entry: WalFileIndexEntry): Promise<WalRecord> {
    const text = await this.backend.readText(`${WAL_DIR}/${entry.fileName}`);
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`WAL record ${entry.fileName} is not valid JSON: ${String(error)}`);
    }
    const record = await parseWalRecord(raw);
    if (record.sequence !== entry.sequence || record.recordId !== entry.recordId) {
      throw new Error(`WAL filename/record identity mismatch in ${entry.fileName}.`);
    }
    return record;
  }

  async measureBytes(entries: readonly WalFileIndexEntry[]): Promise<number | null> {
    let total = 0;
    for (const entry of entries) {
      const size = await this.backend.statSize(`${WAL_DIR}/${entry.fileName}`);
      if (size === null || !Number.isSafeInteger(size) || size < 0) return null;
      total += size;
      if (!Number.isSafeInteger(total)) return null;
    }
    return total;
  }
}

export async function parseWalRecord(raw: unknown): Promise<WalRecord> {
  if (!isRecord(raw)) throw new Error("WAL record must be an object.");
  const recordHash = raw.recordHash;
  if (!isSha256Hex(recordHash)) throw new Error("WAL recordHash is invalid.");

  const formatVersion = raw.formatVersion === WAL_FORMAT_VERSION ? WAL_FORMAT_VERSION : invalidFormat();
  const recordId = requiredString(raw.recordId, "recordId");
  const storeId = requiredString(raw.storeId, "storeId");
  const sequence = requiredCounter(raw.sequence, "sequence");
  const previousRecordHash = raw.previousRecordHash === null ? null : requiredHash(raw.previousRecordHash, "previousRecordHash");
  const writtenAt = requiredTimestamp(raw.writtenAt, "writtenAt");

  // Checksum the exact immutable event bytes before parser-level migration.
  // Newer revisions enrich legacy put-file records with replica-specific paths; doing
  // that before hashing would falsely invalidate valid older journals.
  const rawCore = { formatVersion, recordId, storeId, sequence, previousRecordHash, writtenAt, event: raw.event };
  const expected = await sha256Hex(canonicalStringify(rawCore));
  if (expected !== recordHash) throw new Error(`WAL checksum mismatch at sequence ${sequence}.`);

  const core: WalRecordCore = {
    formatVersion, recordId, storeId, sequence, previousRecordHash, writtenAt, event: parseWalEvent(raw.event)
  };
  validateWalCore(core);
  return { ...core, recordHash };
}

export function validateWalChainRecord(
  record: WalRecord,
  expectedStoreId: string,
  previousSequence: string,
  previousHash: string | null
): void {
  if (record.storeId !== expectedStoreId) throw new Error(`WAL storeId mismatch at sequence ${record.sequence}.`);
  if (record.sequence !== incrementCounter(previousSequence)) {
    throw new Error(`WAL sequence gap: expected ${incrementCounter(previousSequence)}, got ${record.sequence}.`);
  }
  if (record.previousRecordHash !== previousHash) {
    throw new Error(`WAL hash-chain mismatch at sequence ${record.sequence}.`);
  }
}

function validateWalCore(core: WalRecordCore): void {
  assertStateId(core.recordId, "WAL recordId");
  assertStateId(core.storeId, "WAL storeId");
  requiredCounter(core.sequence, "WAL sequence");
  if (core.previousRecordHash !== null && !isSha256Hex(core.previousRecordHash)) {
    throw new Error("WAL previousRecordHash is invalid.");
  }
  requiredTimestamp(core.writtenAt, "WAL writtenAt");
  validateEvent(core.event);
}

function parseWalEvent(value: unknown): WalEvent {
  if (!isRecord(value)) throw new Error("WAL event must be an object.");
  const kind = requiredString(value.kind, "WAL event kind");
  switch (kind) {
    case "store-created":
      return { kind, createdAt: requiredTimestamp(value.createdAt, "store-created.createdAt") };
    case "transaction-begin":
      return {
        kind,
        transactionId: requiredStateId(value.transactionId, "transactionId"),
        baseGeneration: requiredCounter(value.baseGeneration, "baseGeneration"),
        reason: validateReason(requiredString(value.reason, "transaction reason"))
      };
    case "transaction-commit":
      return {
        kind,
        transactionId: requiredStateId(value.transactionId, "transactionId"),
        baseGeneration: requiredCounter(value.baseGeneration, "baseGeneration"),
        newGeneration: requiredCounter(value.newGeneration, "newGeneration"),
        mutations: parseMutations(value.mutations)
      };
    case "transaction-abort": {
      const reason = requiredString(value.reason, "abort reason");
      if (reason !== "crash-recovery") {
        throw new Error(`Invalid transaction abort reason: ${reason}.`);
      }
      return {
        kind,
        transactionId: requiredStateId(value.transactionId, "transactionId"),
        baseGeneration: requiredCounter(value.baseGeneration, "baseGeneration"),
        reason
      };
    }
    default:
      throw new Error(`Unknown WAL event kind: ${kind}.`);
  }
}

function validateEvent(event: WalEvent): void {
  // Round-trip through the parser to keep append-time and read-time validation identical.
  parseWalEvent(event);
}

function parseMutations(value: unknown): DurableMutation[] {
  if (!Array.isArray(value)) throw new Error("transaction-commit.mutations must be an array.");
  return value.map((raw, index) => parseMutation(raw, index));
}

function parseMutation(value: unknown, index: number): DurableMutation {
  if (!isRecord(value)) throw new Error(`Mutation ${index} must be an object.`);
  const kind = requiredString(value.kind, `mutation ${index} kind`);
  switch (kind) {
    case "put-file": {
      const record = parseFileReplicaRecord(value.record);
      return { kind, record };
    }
    case "remove-file":
      return { kind, entryId: requiredStateId(value.entryId, `mutation ${index} entryId`) };
    case "put-tombstone": {
      const record = parseTombstoneRecord(value.record);
      return { kind, record };
    }
    case "remove-tombstone":
      return { kind, tombstoneId: requiredStateId(value.tombstoneId, `mutation ${index} tombstoneId`) };
    default:
      throw new Error(`Unknown durable mutation kind: ${kind}.`);
  }
}

export function validateReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 128 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error("Transaction reason must be 1-128 printable characters.");
  }
  return trimmed;
}

function requiredStateId(value: unknown, label: string): string {
  const result = requiredString(value, label);
  assertStateId(result, label);
  return result;
}

function requiredCounter(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new Error(`${label} must be a decimal counter string.`);
  return result;
}

function requiredHash(value: unknown, label: string): string {
  if (!isSha256Hex(value)) throw new Error(`${label} must be a SHA-256 hex digest.`);
  return value;
}

function requiredTimestamp(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be a timestamp.`);
  return result;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidFormat(): never {
  throw new Error("Unsupported WAL format version.");
}
