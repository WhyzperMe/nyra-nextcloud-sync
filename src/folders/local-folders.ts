import type { DataAdapter } from "obsidian";
import type { LocalPathPolicy } from "../local/path-policy";
import { canonicalVaultRelativePath } from "../state/durable/path";
import type { LocalTree } from "./folder-sync";

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
    if (listing.files.length > 0 || listing.folders.length > 0) return false;
    await this.adapter.rmdir(path, false);
    return true;
  }

  private includedPath(input: string): string {
    const path = canonicalVaultRelativePath(input);
    if (!this.policy.isFolderInScope(path)) throw new Error(`Refusing to modify excluded local folder: ${path}`);
    return path;
  }
}
