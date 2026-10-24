import type { DataAdapter } from "obsidian";

export interface PersistedListOptions<T> {
  maxEntries: number;
  /** Returns the parsed entry or null when the stored value is not a valid entry. */
  parse(value: unknown): T | null;
}

/**
 * Small bounded list stored as one JSON file. Damaged or unreadable storage is
 * treated as empty: these lists are conveniences (history, recovery hints) and
 * must never block syncing.
 */
export class PersistedList<T> {
  private entries: T[] = [];
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: DataAdapter, private readonly path: string, private readonly options: PersistedListOptions<T>) {}

  async load(): Promise<T[]> {
    if (!this.loaded) {
      this.entries = await this.read();
      this.loaded = true;
    }
    return [...this.entries];
  }

  /** Newest entries last. Persists before resolving. */
  async append(items: readonly T[]): Promise<void> {
    if (items.length === 0) return;
    await this.load();
    this.entries = [...this.entries, ...items].slice(-this.options.maxEntries);
    await this.persist();
  }

  async replace(items: readonly T[]): Promise<void> {
    await this.load();
    this.entries = items.slice(-this.options.maxEntries);
    await this.persist();
  }

  private async read(): Promise<T[]> {
    try {
      if (!await this.adapter.exists(this.path)) return [];
      const parsed: unknown = JSON.parse(await this.adapter.read(this.path));
      if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries)) return [];
      const output: T[] = [];
      for (const raw of (parsed as { entries: unknown[] }).entries) {
        const entry = this.options.parse(raw);
        if (entry !== null) output.push(entry);
      }
      return output.slice(-this.options.maxEntries);
    } catch {
      return [];
    }
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, entries: this.entries });
    const task = this.writing.then(async () => {
      const temp = `${this.path}.tmp`;
      await this.adapter.write(temp, snapshot);
      if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
      await this.adapter.rename(temp, this.path);
    });
    this.writing = task.catch(() => undefined);
    await task;
  }
}
