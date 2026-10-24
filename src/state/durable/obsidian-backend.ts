import type { App, DataAdapter } from "obsidian";
import {
  assertSafeStatePath,
  type StateBackend,
  type StateDirectoryListing
} from "./backend";
import { getPluginDeviceRuntimeRoot } from "../../platform/device-scope";

/**
 * Vault-relative backend rooted in the plugin directory.
 *
 * No Node.js filesystem API is used, preserving desktop + mobile compatibility.
 */
export class ObsidianStateBackend implements StateBackend {
  private readonly adapter: DataAdapter;
  private readonly root: string;

  constructor(app: App, pluginId: string, deviceScope: string) {
    this.adapter = app.vault.adapter;
    this.root = `${getPluginDeviceRuntimeRoot(app.vault.configDir, pluginId, deviceScope)}/state-v2`;
  }

  async exists(path: string): Promise<boolean> {
    return await this.adapter.exists(this.resolve(path));
  }

  async readText(path: string): Promise<string> {
    return await this.adapter.read(this.resolve(path));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return await this.adapter.readBinary(this.resolve(path));
  }

  async statSize(path: string): Promise<number | null> {
    const stat = await this.adapter.stat(this.resolve(path));
    if (!stat || stat.type !== "file") return null;
    return stat.size;
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.ensureParent(path);
    await this.adapter.write(this.resolve(path), data);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.ensureParent(path);
    await this.adapter.writeBinary(this.resolve(path), data);
  }

  async appendBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.ensureParent(path);
    await this.adapter.appendBinary(this.resolve(path), data);
  }

  async mkdirp(path: string): Promise<void> {
    const safe = assertSafeStatePath(path);
    const rootParts = this.root.split("/").filter(Boolean);
    const relativeParts = safe ? safe.split("/") : [];
    const allParts = [...rootParts, ...relativeParts];

    let current = "";
    for (const part of allParts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.adapter.exists(current))) {
        try {
          await this.adapter.mkdir(current);
        } catch (error) {
          // A second creator can win the race between exists() and mkdir().
          if (!(await this.adapter.exists(current))) {
            throw error;
          }
        }
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await this.ensureParent(to);
    await this.adapter.rename(this.resolve(from), this.resolve(to));
  }

  async remove(path: string): Promise<void> {
    const resolved = this.resolve(path);
    if (await this.adapter.exists(resolved)) {
      await this.adapter.remove(resolved);
    }
  }

  async list(path: string): Promise<StateDirectoryListing> {
    const resolved = this.resolve(path);
    if (!(await this.adapter.exists(resolved))) {
      return { files: [], folders: [] };
    }

    const listing = await this.adapter.list(resolved);
    return {
      files: listing.files.map((entry) => relativeChildName(resolved, entry)),
      folders: listing.folders.map((entry) => relativeChildName(resolved, entry))
    };
  }

  private resolve(path: string): string {
    const safe = assertSafeStatePath(path);
    return safe ? `${this.root}/${safe}` : this.root;
  }

  private async ensureParent(path: string): Promise<void> {
    const safe = assertSafeStatePath(path);
    const slash = safe.lastIndexOf("/");
    const parent = slash < 0 ? "" : safe.slice(0, slash);
    await this.mkdirp(parent);
  }
}

function relativeChildName(parent: string, child: string): string {
  const normalizedParent = parent.replace(/\/+$/, "");
  const prefix = `${normalizedParent}/`;
  if (!child.startsWith(prefix)) {
    throw new Error(`Storage adapter returned a path outside the requested directory: ${child}`);
  }
  const relative = child.slice(prefix.length);
  if (!relative || relative.includes("/")) {
    throw new Error(`Storage adapter returned a non-child entry: ${child}`);
  }
  return relative;
}
