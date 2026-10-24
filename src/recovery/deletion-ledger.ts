import type { DataAdapter } from "obsidian";
import { PersistedList } from "./persisted-list";

export interface DeletedFileRecord {
  /** Vault-relative path of the deleted file. */
  path: string;
  /** SHA-256 of the last synchronized content; the bytes are retained in the durable BASE object store. */
  blobHash: string;
  size: number;
  deletedAt: string;
  /** Which replica was removed by this sync: this device's copy or the Nextcloud copy. */
  removed: "local" | "remote";
}

const MAX_ENTRIES = 500;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Bounded history of deletions performed by sync, so each can be restored from retained BASE bytes. */
export class DeletionLedger {
  private readonly list: PersistedList<DeletedFileRecord>;

  constructor(adapter: DataAdapter, path: string, private readonly now: () => number = Date.now) {
    this.list = new PersistedList<DeletedFileRecord>(adapter, path, { maxEntries: MAX_ENTRIES, parse: parseRecord });
  }

  async record(entries: readonly DeletedFileRecord[]): Promise<void> {
    await this.list.append(entries);
  }

  /** Newest first, expired entries dropped. */
  async recent(): Promise<DeletedFileRecord[]> {
    const cutoff = this.now() - MAX_AGE_MS;
    const all = await this.list.load();
    const fresh = all.filter((entry) => Date.parse(entry.deletedAt) >= cutoff);
    if (fresh.length !== all.length) await this.list.replace(fresh);
    return fresh.reverse();
  }

  async forget(entry: DeletedFileRecord): Promise<void> {
    const all = await this.list.load();
    await this.list.replace(all.filter((candidate) => !(candidate.path === entry.path && candidate.blobHash === entry.blobHash && candidate.deletedAt === entry.deletedAt)));
  }
}

function parseRecord(value: unknown): DeletedFileRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.path !== "string" || !v.path || typeof v.blobHash !== "string" || !/^[a-f0-9]{64}$/.test(v.blobHash)) return null;
  if (typeof v.size !== "number" || !Number.isSafeInteger(v.size) || v.size < 0) return null;
  if (typeof v.deletedAt !== "string" || !Number.isFinite(Date.parse(v.deletedAt))) return null;
  if (v.removed !== "local" && v.removed !== "remote") return null;
  return { path: v.path, blobHash: v.blobHash, size: v.size, deletedAt: v.deletedAt, removed: v.removed };
}
