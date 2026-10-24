import type { ActivityLog } from "../activity/activity-log";
import type { DeletedFileRecord, DeletionLedger } from "./deletion-ledger";
import type { NextcloudTrash, TrashedItem } from "./nextcloud-trash";

export interface RecoveryDeps {
  ledger: DeletionLedger;
  activity: ActivityLog;
  /** Retained BASE bytes for a content hash. */
  getBlob(hash: string): Promise<ArrayBuffer>;
  exists(path: string): Promise<boolean>;
  /** Creates a new local file; must fail if the target exists. */
  createFile(path: string, bytes: ArrayBuffer): Promise<void>;
  isInScope(path: string): boolean;
  trash(): NextcloudTrash | null;
  remoteRoot(): string;
  now?(): Date;
}

/** Restores deleted files, either from bytes retained locally or from the Nextcloud trash bin. */
export class RecoveryService {
  constructor(private readonly deps: RecoveryDeps) {}

  recentlyDeleted(): Promise<DeletedFileRecord[]> { return this.deps.ledger.recent(); }

  recordDeletions(entries: readonly DeletedFileRecord[]): Promise<void> { return this.deps.ledger.record(entries); }

  /** Restores a file deleted by sync. If its path is taken, a dated sibling name is used. Returns the path written. */
  async restoreDeleted(entry: DeletedFileRecord): Promise<string> {
    const path = await this.restoreFromBase(entry.path, entry.blobHash, true);
    await this.deps.ledger.forget(entry);
    await this.deps.activity.add([{ at: this.now().toISOString(), kind: "downloaded", path, detail: "Restored from retained copy" }]);
    return path;
  }

  /** Writes retained bytes back to `path`. Without `renameIfTaken` an occupied path is an error. */
  async restoreFromBase(path: string, blobHash: string, renameIfTaken: boolean): Promise<string> {
    if (!this.deps.isInScope(path)) throw new Error(`'${path}' is outside the current sync scope and cannot be restored here.`);
    const bytes = await this.deps.getBlob(blobHash);
    let target = path;
    if (await this.deps.exists(target)) {
      if (!renameIfTaken) throw new Error(`'${path}' already exists.`);
      target = await this.freeSibling(path);
    }
    await this.deps.createFile(target, bytes);
    return target;
  }

  async listTrash(): Promise<TrashedItem[]> {
    const trash = this.deps.trash();
    return trash ? await trash.list(this.deps.remoteRoot()) : [];
  }

  async restoreTrash(item: TrashedItem): Promise<void> {
    const trash = this.deps.trash();
    if (!trash) throw new Error("Connect to Nextcloud to restore from its trash bin.");
    await trash.restore(item);
    await this.deps.activity.add([{ at: this.now().toISOString(), kind: "downloaded", path: item.originalLocation, detail: "Restored from the Nextcloud trash bin; it will sync down shortly" }]);
  }

  private async freeSibling(path: string): Promise<string> {
    const slash = path.lastIndexOf("/");
    const directory = slash < 0 ? "" : path.slice(0, slash + 1);
    const name = path.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    const date = this.now().toISOString().slice(0, 10);
    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? `restored ${date}` : `restored ${date} ${index + 1}`;
      const candidate = `${directory}${stem} (${suffix})${extension}`;
      if (!await this.deps.exists(candidate)) return candidate;
    }
    throw new Error(`Could not find a free name to restore '${path}'.`);
  }

  private now(): Date { return this.deps.now?.() ?? new Date(); }
}
