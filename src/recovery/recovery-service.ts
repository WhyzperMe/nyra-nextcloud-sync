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
  /** Creates these folders (relative to the synchronized root, parents first) on Nextcloud if they are missing. */
  ensureRemoteFolders?(folders: readonly string[]): Promise<void>;
  now?(): Date;
}

export interface RestoreSinceReport {
  since: string;
  /** Items brought back from the Nextcloud trash bin. */
  trashRestored: number;
  /** Items that already exist again on Nextcloud (nothing to do). */
  trashPresent: number;
  trashFailed: number;
  /** Files written back from the copies this device retained. */
  localRestored: number;
  localSkipped: number;
  localFailed: number;
  errors: string[];
}

export interface RestorePreview { since: string; trashItems: number; localCopies: number }

const MAX_RESTORE_TRASH_ITEMS = 5000;

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

  /** Counts what a restore since `since` would bring back, without changing anything. */
  async previewSince(since: Date): Promise<RestorePreview> {
    const trashItems = await this.trashSince(since);
    const covered = coveredPaths(trashItems.map((item) => this.relativeToRoot(item.originalLocation)), trashItems);
    const localCopies = (await this.deps.ledger.recent()).filter((entry) => Date.parse(entry.deletedAt) >= since.getTime() && !isCovered(entry.path, covered)).length;
    return { since: since.toISOString(), trashItems: trashItems.length, localCopies };
  }

  /**
   * One-click restore: brings back everything that was deleted at or after `since`. Items in the Nextcloud
   * trash bin return to their original place (folders first, missing parent folders are created); files the
   * trash bin no longer has are written back from the copies this device retained. Nothing existing is
   * overwritten, and one failing item never stops the rest.
   */
  async restoreSince(since: Date): Promise<RestoreSinceReport> {
    const report: RestoreSinceReport = { since: since.toISOString(), trashRestored: 0, trashPresent: 0, trashFailed: 0, localRestored: 0, localSkipped: 0, localFailed: 0, errors: [] };
    const note = (message: string): void => { if (report.errors.length < 20) report.errors.push(message); };
    const trash = this.deps.trash();
    const items = trash ? await this.trashSince(since) : [];
    const relatives = new Map(items.map((item) => [item, this.relativeToRoot(item.originalLocation)] as const));
    const covered = coveredPaths([...relatives.values()], items);

    if (trash && items.length > 0) {
      const folders = new Set<string>();
      for (const rel of relatives.values()) {
        const slash = rel.lastIndexOf("/");
        if (slash <= 0) continue;
        const parts = rel.slice(0, slash).split("/");
        for (let end = 1; end <= parts.length; end += 1) folders.add(parts.slice(0, end).join("/"));
      }
      try { await this.deps.ensureRemoteFolders?.([...folders].sort(byDepth)); }
      catch (error) { note(`Could not prepare folders on Nextcloud: ${messageOf(error)}`); }
      const ordered = [...items].sort((a, b) => depthOf(relatives.get(a) ?? "") - depthOf(relatives.get(b) ?? "") || (a.isFolder === b.isFolder ? 0 : a.isFolder ? -1 : 1));
      for (const item of ordered) {
        try {
          await trash.restore(item);
          report.trashRestored += 1;
        } catch (error) {
          if (/already exists/i.test(messageOf(error))) report.trashPresent += 1;
          else { report.trashFailed += 1; note(`${item.originalLocation}: ${messageOf(error)}`); }
        }
      }
    }

    for (const entry of (await this.deps.ledger.recent()).reverse()) {
      if (Date.parse(entry.deletedAt) < since.getTime()) continue;
      if (isCovered(entry.path, covered) || await this.deps.exists(entry.path)) { report.localSkipped += 1; continue; }
      try {
        await this.restoreFromBase(entry.path, entry.blobHash, false);
        await this.deps.ledger.forget(entry);
        report.localRestored += 1;
      } catch (error) {
        report.localFailed += 1;
        note(`${entry.path}: ${messageOf(error)}`);
      }
    }

    const restored = report.trashRestored + report.localRestored;
    await this.deps.activity.add([{
      at: this.now().toISOString(), kind: "downloaded", path: "",
      detail: `Restored ${restored} deleted item${restored === 1 ? "" : "s"} since ${report.since} (${report.trashRestored} from the Nextcloud trash, ${report.localRestored} from retained copies)`
    }]);
    return report;
  }

  private async trashSince(since: Date): Promise<TrashedItem[]> {
    const trash = this.deps.trash();
    if (!trash) return [];
    return (await trash.list(this.deps.remoteRoot(), MAX_RESTORE_TRASH_ITEMS)).filter((item) => Date.parse(item.deletedAt) >= since.getTime());
  }

  private relativeToRoot(originalLocation: string): string {
    const root = this.deps.remoteRoot().replace(/^\/+|\/+$/g, "");
    const original = originalLocation.replace(/^\/+/, "");
    return root && original.startsWith(`${root}/`) ? original.slice(root.length + 1) : original;
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

function depthOf(path: string): number { return path.split("/").length; }
function byDepth(a: string, b: string): number { return depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Relative paths (and folder prefixes) that the trash restore already covers. */
function coveredPaths(relatives: readonly string[], items: readonly TrashedItem[]): { files: Set<string>; folders: string[] } {
  const files = new Set<string>();
  const folders: string[] = [];
  relatives.forEach((rel, index) => { if (items[index]?.isFolder) folders.push(rel); else files.add(rel); });
  return { files, folders };
}
function isCovered(path: string, covered: { files: Set<string>; folders: string[] }): boolean {
  return covered.files.has(path) || covered.folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
}
