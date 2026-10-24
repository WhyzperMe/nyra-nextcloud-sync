import type { DataAdapter, Vault } from "obsidian";
import { canonicalVaultRelativePath } from "../state/durable/path";
import type { LocalPathPolicy } from "./path-policy";
import type { LocalFileSource } from "./source";
import type { LocalFileMetadata } from "./types";

/**
 * Adapter-backed inventory source. Unlike Vault.getFiles(), this can enumerate
 * hidden/config files as well. Reserved subtrees are pruned before traversal so
 * the plugin never recursively scans its own WAL/snapshots/build output.
 */
export class ObsidianVaultFileSource implements LocalFileSource {
  private readonly adapter: DataAdapter;

  constructor(vault: Vault, private readonly policy?: LocalPathPolicy) {
    this.adapter = vault.adapter;
  }

  async listFiles(): Promise<LocalFileMetadata[]> {
    const pending = [""];
    const output: LocalFileMetadata[] = [];

    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) break;
      const listing = await this.adapter.list(directory);

      for (const folderInput of [...listing.folders].sort().reverse()) {
        const folder = canonicalVaultRelativePath(folderInput);
        if (this.policy && !this.policy.isFolderInScope(folder)) continue;
        pending.push(folder);
      }

      for (const fileInput of [...listing.files].sort()) {
        const path = canonicalVaultRelativePath(fileInput);
        if (this.policy && !this.policy.isInScope(path)) continue;
        const stat = await this.adapter.stat(path);
        if (!stat || stat.type !== "file") continue;
        output.push({ path, size: stat.size, mtimeMs: stat.mtime, ctimeMs: stat.ctime });
      }
    }

    return output.sort((left, right) => left.path.localeCompare(right.path));
  }

  async stat(pathInput: string): Promise<LocalFileMetadata | null> {
    const path = canonicalVaultRelativePath(pathInput);
    if (this.policy && !this.policy.isInScope(path)) return null;
    const stat = await this.adapter.stat(path);
    if (!stat || stat.type !== "file") return null;
    return { path, size: stat.size, mtimeMs: stat.mtime, ctimeMs: stat.ctime };
  }

  async readBinary(pathInput: string): Promise<ArrayBuffer> {
    const path = canonicalVaultRelativePath(pathInput);
    if (this.policy && !this.policy.isInScope(path)) throw new Error(`Refusing to read excluded local path: ${path}`);
    return await this.adapter.readBinary(path);
  }
}
