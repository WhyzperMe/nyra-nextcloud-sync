import type { DataAdapter } from "obsidian";
import type { LocalPathPolicy } from "../local/path-policy";
import { canonicalVaultRelativePath } from "../state/durable/path";
import type { LocalTree } from "./folder-sync";

const SYSTEM_JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini", ".nomedia", ".localized", ".directory"]);

/** Metadata files created by the operating system or a file manager, never by the user. */
export function isSystemJunk(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return SYSTEM_JUNK.has(name) || /^\._./.test(name);
}

/** Adapter-backed folder operations. Uses only the portable Obsidian DataAdapter API. */
export class LocalFolderAccess {
  constructor(private readonly adapter: DataAdapter, private readonly policy: LocalPathPolicy) {}

  async listTree(): Promise<LocalTree> {
    const folders = new Set<string>();
    const files = new Set<string>();
    const pending = [""];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) break;
      const listing = await this.adapter.list(directory);
      for (const input of listing.folders) {
        const folder = canonicalVaultRelativePath(input);
        if (!this.policy.isFolderInScope(folder)) continue;
        folders.add(folder);
        pending.push(folder);
      }
      for (const input of listing.files) {
        const file = canonicalVaultRelativePath(input);
        if (this.policy.isInScope(file)) files.add(file);
      }
    }
    return { folders, files };
  }

  async create(pathInput: string): Promise<void> {
    const path = this.includedPath(pathInput);
    let current = "";
    for (const segment of path.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (await this.adapter.exists(current)) continue;
      try { await this.adapter.mkdir(current); }
      catch (error) { if (!await this.adapter.exists(current)) throw error; }
    }
  }

  async removeIfEmpty(pathInput: string): Promise<boolean> {
    const path = this.includedPath(pathInput);
    if (!await this.adapter.exists(path)) return true;
    const listing = await this.adapter.list(path);
    if (listing.folders.length > 0) return false;
    // Operating systems and file managers drop metadata files into folders. They are not notes, never
    // sync, and must not keep an otherwise empty folder alive for ever (Android and desktop file
    // managers create them far more often than iOS does).
    const junk = listing.files.filter(isSystemJunk);
    if (junk.length !== listing.files.length) return false;
    for (const file of junk) {
      try { await this.adapter.remove(file); }
      catch { if (await this.adapter.exists(file)) return false; }
    }
    await this.adapter.rmdir(path, false);
    return true;
  }

  private includedPath(input: string): string {
    const path = canonicalVaultRelativePath(input);
    if (!this.policy.isFolderInScope(path)) throw new Error(`Refusing to modify excluded local folder: ${path}`);
    return path;
  }
}
