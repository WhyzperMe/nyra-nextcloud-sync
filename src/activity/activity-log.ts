import type { DataAdapter } from "obsidian";
import type { ExecutionReport } from "../execution/types";
import { PersistedList } from "../recovery/persisted-list";

export type ActivityKind =
  | "uploaded" | "downloaded" | "merged" | "moved"
  | "deleted-here" | "deleted-on-server"
  | "folder-created" | "folder-deleted"
  | "needs-review" | "held-deletions" | "skipped" | "error";

export interface ActivityEntry {
  at: string;
  kind: ActivityKind;
  /** Vault-relative path, or empty for events that concern the whole sync. */
  path: string;
  detail?: string;
}

const MAX_ENTRIES = 300;
const KINDS: readonly string[] = ["uploaded", "downloaded", "merged", "moved", "deleted-here", "deleted-on-server", "folder-created", "folder-deleted", "needs-review", "held-deletions", "skipped", "error"];

/** Chronological record of what sync did, kept in memory for the UI and persisted for the next session. */
export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private readonly list: PersistedList<ActivityEntry>;

  constructor(adapter: DataAdapter, path: string, private readonly now: () => Date = () => new Date()) {
    this.list = new PersistedList<ActivityEntry>(adapter, path, { maxEntries: MAX_ENTRIES, parse: parseEntry });
  }

  async load(): Promise<void> {
    this.entries = await this.list.load();
  }

  /** Newest first. */
  recent(limit = 100): ActivityEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  async add(entries: readonly ActivityEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.entries = [...this.entries, ...entries].slice(-MAX_ENTRIES);
    await this.list.append(entries).catch(() => undefined); // history must never fail a sync
  }

  async addReport(report: ExecutionReport): Promise<void> {
    const at = this.now().toISOString();
    const entries: ActivityEntry[] = [];
    for (const result of report.results) {
      const kind = activityKindForStep(result.kind, result.status);
      if (!kind) continue;
      const entry: ActivityEntry = { at, kind, path: result.path };
      if (kind === "needs-review" || kind === "error") entry.detail = result.message;
      entries.push(entry);
    }
    await this.add(entries);
  }

  async addError(message: string): Promise<void> {
    await this.add([{ at: this.now().toISOString(), kind: "error", path: "", detail: message }]);
  }
}

export function activityKindForStep(step: string, status: string): ActivityKind | null {
  if (status === "blocked" || status === "failed") return step === "verify-remote-content" || step === "establish-baseline" || step === "retire-record" ? null : "needs-review";
  if (status !== "completed") return null;
  switch (step) {
    case "upload-create": case "upload-update": return "uploaded";
    case "download-create": case "download-update": return "downloaded";
    case "merge-text": return "merged";
    case "move-local": case "move-remote": return "moved";
    case "delete-local": return "deleted-here";
    case "delete-remote": return "deleted-on-server";
    default: return null;
  }
}

function parseEntry(value: unknown): ActivityEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at)) || typeof v.kind !== "string" || !KINDS.includes(v.kind) || typeof v.path !== "string") return null;
  const entry: ActivityEntry = { at: v.at, kind: v.kind as ActivityKind, path: v.path };
  if (typeof v.detail === "string") entry.detail = v.detail.slice(0, 300);
  return entry;
}
