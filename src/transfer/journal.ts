import type { DataAdapter, Vault } from "obsidian";
import type { Logger } from "../diagnostics/logger";
import { canonicalStringify } from "../state/durable/canonical-json";
import { sha256Hex } from "../state/durable/crypto";
import type { TransferJournalPayload, TransferJournalRecord } from "./types";
import { randomId } from "../state/durable/ids";
import { getPluginDeviceRuntimeRoot } from "../platform/device-scope";
import { NEXTCLOUD_MAX_CHUNKS } from "./chunking";

const RECORD_FILE = /^(\d{8})\.json$/;
const TRANSFER_PHASES = new Set(["prepared","upload-created","uploading","assembling","temp-ready","backup-moving","backup-ready","installing","installed","verified","complete"]);
const MAX_TRANSFER_OPERATIONS = 10_000;
const MAX_RECORDS_PER_OPERATION = NEXTCLOUD_MAX_CHUNKS + 20;
const MAX_FILES_PER_OPERATION = MAX_RECORDS_PER_OPERATION + 128;

export class TransferJournalStore {
  private readonly adapter: DataAdapter;
  private readonly root: string;

  constructor(vault: Vault, pluginId: string, private readonly logger: Logger, deviceScope: string) {
    this.adapter = vault.adapter;
    this.root = `${getPluginDeviceRuntimeRoot(vault.configDir, pluginId, deviceScope)}/transfer/journal`;
  }

  async ensure(): Promise<void> {
    await this.mkdirp(this.root);
  }

  async load(operationKey: string): Promise<TransferJournalRecord | null> {
    assertKey(operationKey);
    await this.ensure();
    const dir = `${this.root}/${operationKey}`;
    if (!(await this.adapter.exists(dir))) return null;
    const listing = await this.adapter.list(dir);
    if (listing.files.length > MAX_FILES_PER_OPERATION) {
      throw new Error(`Transfer journal ${operationKey} exceeds the ${MAX_FILES_PER_OPERATION}-file safety limit.`);
    }
    const names = listing.files
      .map((path) => directChildName(dir, path))
      .filter((name): name is string => name !== null && RECORD_FILE.test(name))
      .sort();
    if (names.length > MAX_RECORDS_PER_OPERATION) {
      throw new Error(`Transfer journal ${operationKey} exceeds the ${MAX_RECORDS_PER_OPERATION}-record safety limit.`);
    }
    let previousHash: string | null = null;
    let previousSequence = 0;
    let latest: TransferJournalRecord | null = null;
    for (const name of names) {
      const match = RECORD_FILE.exec(name);
      if (!match) continue;
      const sequence = Number(match[1]);
      if (sequence !== previousSequence + 1) throw new Error(`Transfer journal ${operationKey} has a sequence gap at ${sequence}.`);
      const raw = await this.adapter.read(`${dir}/${name}`);
      const record = JSON.parse(raw) as TransferJournalRecord;
      validateRecordShape(record, operationKey, sequence, previousHash);
      const actualHash = await recordHash(record);
      if (actualHash !== record.recordHash) throw new Error(`Transfer journal ${operationKey} record ${sequence} failed hash verification.`);
      previousHash = record.recordHash;
      previousSequence = sequence;
      latest = record;
    }
    return latest;
  }

  async listLatest(): Promise<TransferJournalRecord[]> {
    await this.ensure();
    const listing = await this.adapter.list(this.root);
    const output: TransferJournalRecord[] = [];
    if (listing.folders.length > MAX_TRANSFER_OPERATIONS) {
      throw new Error(`Transfer journal inventory exceeds the ${MAX_TRANSFER_OPERATIONS}-operation safety limit.`);
    }
    const folders = listing.folders
      .map((folderPath) => directChildName(this.root, folderPath))
      .filter((name): name is string => name !== null)
      .sort();
    for (const key of folders) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      const record = await this.load(key);
      if (record) output.push(record);
    }
    return output;
  }

  async create(payload: TransferJournalPayload): Promise<TransferJournalRecord> {
    const existing = await this.load(payload.operationKey);
    if (existing) return existing;
    const record = await this.buildRecord(payload, 1, null);
    await this.writeImmutable(record);
    return record;
  }

  async append(current: TransferJournalRecord, patch: Partial<TransferJournalPayload>): Promise<TransferJournalRecord> {
    const latest = await this.load(current.operationKey);
    if (!latest || latest.sequence !== current.sequence || latest.recordHash !== current.recordHash) {
      throw new Error(`Transfer journal ${current.operationKey} advanced concurrently.`);
    }
    const payload = stripRecord({ ...current, ...patch, updatedAt: new Date().toISOString() });
    const record = await this.buildRecord(payload, current.sequence + 1, current.recordHash);
    await this.writeImmutable(record);
    return record;
  }

  async remove(operationKey: string): Promise<void> {
    assertKey(operationKey);
    const dir = `${this.root}/${operationKey}`;
    if (!(await this.adapter.exists(dir))) return;
    const listing = await this.adapter.list(dir);
    if (listing.files.length > MAX_FILES_PER_OPERATION) {
      this.logger.warn("transfer.journal-cleanup-deferred-size-limit", { operationKey, files: listing.files.length });
      return;
    }
    const names = listing.files.map((path) => directChildName(dir, path));
    const recognized = names.filter((name): name is string => name !== null && RECORD_FILE.test(name)).sort();
    const unknownFileCount = names.length - recognized.length;
    if (unknownFileCount > 0 || listing.folders.length > 0) {
      this.logger.warn("transfer.journal-cleanup-deferred-unknown-evidence", {
        operationKey,
        unknownFiles: unknownFileCount,
        unknownFolders: listing.folders.length
      });
      return;
    }
    if (recognized.length > MAX_RECORDS_PER_OPERATION) {
      throw new Error(`Transfer journal ${operationKey} exceeds the ${MAX_RECORDS_PER_OPERATION}-record cleanup limit.`);
    }

    // Validate the full chain before removing anything. Descending removal
    // keeps any crash-interrupted remainder as a valid sequence-1 prefix.
    await this.load(operationKey);
    for (const name of recognized.reverse()) await this.adapter.remove(`${dir}/${name}`);

    const remaining = await this.adapter.list(dir);
    if (remaining.files.length > 0 || remaining.folders.length > 0) {
      this.logger.warn("transfer.journal-cleanup-deferred-after-remove", {
        operationKey,
        remainingFiles: remaining.files.length,
        remainingFolders: remaining.folders.length
      });
      return;
    }
    try {
      await this.adapter.rmdir(dir, false);
    } catch (error) {
      this.logger.warn("transfer.journal-empty-directory-cleanup-deferred", { operationKey, error: asMessage(error) });
    }
  }

  private async buildRecord(payload: TransferJournalPayload, sequence: number, previousHash: string | null): Promise<TransferJournalRecord> {
    const base = { ...structuredClone(payload), sequence, previousHash, recordHash: "" } satisfies TransferJournalRecord;
    base.recordHash = await recordHash(base);
    return base;
  }

  private async writeImmutable(record: TransferJournalRecord): Promise<void> {
    const dir = `${this.root}/${record.operationKey}`;
    await this.mkdirp(dir);
    const path = `${dir}/${String(record.sequence).padStart(8, "0")}.json`;
    const data = canonicalStringify(record);
    if (await this.adapter.exists(path)) {
      if ((await this.adapter.read(path)) !== data) throw new Error(`Immutable transfer journal collision at ${path}.`);
      return;
    }
    const temp = `${dir}/.${String(record.sequence).padStart(8, "0")}.${randomId("tmp")}.tmp`;
    try {
      await this.adapter.write(temp, data);
      if ((await this.adapter.read(temp)) !== data) throw new Error("Transfer journal staging read-back failed.");
      try {
        await this.adapter.rename(temp, path);
      } catch (error) {
        if (!(await this.adapter.exists(path)) || (await this.adapter.read(path)) !== data) throw error;
      }
      if ((await this.adapter.read(path)) !== data) throw new Error("Transfer journal committed read-back failed.");
    } finally {
      if (await this.adapter.exists(temp)) await this.adapter.remove(temp);
    }
  }

  private async mkdirp(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.adapter.exists(current))) {
        try { await this.adapter.mkdir(current); }
        catch (error) { if (!(await this.adapter.exists(current))) throw error; }
      }
    }
  }
}

export async function makeTransferOperationKey(parts: readonly (string | number | null)[]): Promise<string> {
  return await sha256Hex(canonicalStringify(parts));
}

async function recordHash(record: TransferJournalRecord): Promise<string> {
  const clone = { ...record, recordHash: "" };
  return await sha256Hex(canonicalStringify(clone));
}

function stripRecord(record: TransferJournalRecord): TransferJournalPayload {
  const { sequence: _sequence, previousHash: _previousHash, recordHash: _recordHash, ...payload } = record;
  return payload;
}

function validateRecordShape(record: TransferJournalRecord, operationKey: string, sequence: number, previousHash: string | null): void {
  if (record.version !== 1 || record.operationKey !== operationKey || record.sequence !== sequence || record.previousHash !== previousHash) {
    throw new Error(`Transfer journal ${operationKey} contains an invalid record envelope.`);
  }
  if (!/^[a-f0-9]{64}$/.test(record.recordHash) || !/^[a-f0-9]{64}$/.test(record.sourceHash)) throw new Error("Transfer journal contains an invalid SHA-256 value.");
  if (!Number.isSafeInteger(record.sourceSize) || record.sourceSize < 0 || !Number.isSafeInteger(record.chunkSize) || record.chunkSize <= 0 || !Number.isSafeInteger(record.chunkCount) || record.chunkCount < 1 || record.chunkCount > NEXTCLOUD_MAX_CHUNKS) {
    throw new Error("Transfer journal contains invalid size metadata.");
  }
  if (!Array.isArray(record.uploadedChunks) || record.uploadedChunks.some((value) => !Number.isSafeInteger(value) || value < 0 || value >= record.chunkCount)) {
    throw new Error("Transfer journal contains invalid chunk progress.");
  }
  if (new Set(record.uploadedChunks).size !== record.uploadedChunks.length) throw new Error("Transfer journal contains duplicate uploaded chunk indexes.");
  if (!record.uploadedChunks.every((value, index, all) => index === 0 || all[index - 1]! < value)) throw new Error("Transfer journal chunk indexes must be strictly sorted.");
  if (!TRANSFER_PHASES.has(record.phase) || (record.kind !== "chunked-create" && record.kind !== "chunked-update")) throw new Error("Transfer journal contains an invalid kind/phase.");
  if (!/^nyra-[a-f0-9]{24}$/.test(record.uploadId) || !/^[a-f0-9]{24}$/.test(record.operationId)) throw new Error("Transfer journal contains an invalid operation/upload ID.");
  for (const value of [record.targetUrl, record.tempUrl, record.uploadUrl]) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error("Transfer journal contains an invalid URL."); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Transfer journal contains a non-HTTP URL.");
  }
}

function assertKey(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid transfer operation key.");
}
function asMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function directChildName(parent: string, path: string): string | null {
  const prefix = `${parent}/`;
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  return name && !name.includes("/") ? name : null;
}
