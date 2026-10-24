import type { DataAdapter } from "obsidian";

const MAX_FOLDERS = 250_000;

/** Atomic JSON persistence of the folders confirmed on both replicas at the last sync. */
export class FolderBaselineStore {
  constructor(private readonly adapter: DataAdapter, private readonly path: string) {}

  /** A missing or damaged baseline is empty: folders are then only ever created, never deleted. */
  async load(): Promise<Set<string>> {
    try {
      if (!await this.adapter.exists(this.path)) return new Set();
      const parsed: unknown = JSON.parse(await this.adapter.read(this.path));
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.folders)) return new Set();
      return new Set(parsed.folders.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, MAX_FOLDERS));
    } catch {
      return new Set();
    }
  }

  async save(folders: ReadonlySet<string>): Promise<void> {
    const body = JSON.stringify({ version: 1, folders: [...folders].sort() });
    const temp = `${this.path}.tmp`;
    await this.adapter.write(temp, body);
    if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
    await this.adapter.rename(temp, this.path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
