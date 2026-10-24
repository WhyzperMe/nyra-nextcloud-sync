import { Notice } from "obsidian";
import { errorMessage } from "../core/errors";
import type NyraNextcloudSyncPlugin from "../main";
import type { ActivityEntry, ActivityKind } from "../activity/activity-log";
import { plural, relativePast } from "./format";
import { createIcon, type IconName } from "./icons";
import { appendErrorDetail } from "./settings-dom";

const LABELS: Record<ActivityKind, string> = {
  uploaded: "Uploaded", downloaded: "Downloaded", merged: "Merged", moved: "Moved",
  "deleted-here": "Deleted here", "deleted-on-server": "Deleted on Nextcloud",
  "folder-created": "Folder created", "folder-deleted": "Folder deleted",
  "needs-review": "Needs review", "held-deletions": "Deletions held", skipped: "Skipped", error: "Error", "auto-resolved": "Conflict resolved"
};

const ICONS: Record<ActivityKind, IconName> = {
  uploaded: "arrow-up", downloaded: "arrow-down", merged: "merge", moved: "arrow-right",
  "deleted-here": "trash", "deleted-on-server": "trash", "folder-created": "folder-plus", "folder-deleted": "trash",
  "needs-review": "alert", "held-deletions": "shield", skipped: "info", error: "x-circle", "auto-resolved": "merge"
};

const TONES: Partial<Record<ActivityKind, "warn" | "error" | "danger">> = {
  "needs-review": "warn", "held-deletions": "warn", error: "error", "deleted-here": "danger", "deleted-on-server": "danger", "folder-deleted": "danger"
};

/** Deletions waiting for approval, with the two ways out. Renders nothing when nothing is held. */
export function renderPendingDeletions(container: HTMLElement, owner: NyraNextcloudSyncPlugin, refresh: () => void): void {
  const pending = owner.pendingDeletions();
  if (!pending) return;
  const box = container.createDiv({ cls: "nyra-nc-alert nyra-nc-alert--warn" });
  box.appendChild(createIcon("shield", 16));
  const body = box.createDiv({ cls: "nyra-nc-alert__text" });
  body.createEl("strong", { text: `${plural(pending.total, "deletion")} waiting for your approval` });
  const parts: string[] = [];
  if (pending.pendingRemoteDeletes > 0) parts.push(`${plural(pending.pendingRemoteDeletes, "file")} deleted on this device would be removed from Nextcloud`);
  if (pending.pendingLocalDeletes > 0) parts.push(`${plural(pending.pendingLocalDeletes, "file")} deleted on Nextcloud would be removed from this device`);
  if (pending.folders > 0) parts.push(plural(pending.folders, "folder"));
  body.createSpan({ text: `${parts.join("; ")}.${pending.sample.length ? ` For example: ${pending.sample.slice(0, 3).join(", ")}.` : ""}` });
  const actions = body.createDiv({ cls: "nyra-nc-alert__actions" });
  actions.createEl("button", { cls: "mod-cta", text: "Approve deletions" }).addEventListener("click", () => {
    owner.approvePendingDeletions();
    void owner.runAutoSyncNow().catch((error: unknown) => new Notice(`Sync failed: ${errorMessage(error)}`, 10_000)).finally(refresh);
  });
  if (pending.pendingRemoteDeletes > 0) {
    actions.createEl("button", { text: "Undo: restore files here" }).addEventListener("click", () => {
      owner.undoPendingLocalDeletions().then((count) => new Notice(`Restored ${plural(count, "file")}.`)).catch((error: unknown) => new Notice(`Undo failed: ${errorMessage(error)}`, 10_000)).finally(refresh);
    });
  }
}

/** Skipped large files and the chronological feed of what sync did. */
export function renderActivityFeed(section: HTMLElement, owner: NyraNextcloudSyncPlugin): void {
  const skipped = owner.skippedLargeFiles();
  const names = [...new Set([...skipped.local, ...skipped.remote])];
  if (names.length > 0) {
    const note = section.createDiv({ cls: "nyra-nc-alert nyra-nc-alert--info" });
    note.appendChild(createIcon("info", 16));
    const text = note.createDiv({ cls: "nyra-nc-alert__text" });
    text.createEl("strong", { text: `${plural(names.length, "large file")} skipped on this device` });
    text.createSpan({ text: `Above ${skipped.limitMiB} MiB: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""}. They stay untouched and everything else keeps syncing.` });
  }

  const entries = owner.activityEntries(60);
  const list = section.createDiv({ cls: "nyra-nc-feed" });
  if (entries.length === 0) {
    const empty = list.createDiv({ cls: "nyra-nc-feed__empty" });
    empty.appendChild(createIcon("activity", 22));
    empty.createSpan({ text: "Nothing has synced yet. Changes will show up here." });
    return;
  }
  for (const entry of entries) renderRow(list, entry);
}

function renderRow(list: HTMLElement, entry: ActivityEntry): void {
  const tone = TONES[entry.kind];
  const row = list.createDiv({ cls: `nyra-nc-feed__row${tone ? ` nyra-nc-feed__row--${tone}` : ""}` });
  row.createDiv({ cls: "nyra-nc-feed__icon" }).appendChild(createIcon(ICONS[entry.kind], 14));
  const path = row.createDiv({ cls: "nyra-nc-feed__path" });
  path.title = entry.detail ? `${entry.path}\n${entry.detail}` : entry.path;
  renderPath(path, entry.path || entry.detail || LABELS[entry.kind]);
  const label = entry.path && entry.detail ? `${LABELS[entry.kind]} · ${entry.detail}` : LABELS[entry.kind];
  row.createDiv({ cls: "nyra-nc-feed__meta", text: `${label} · ${relativePast(entry.at)}` });
  if (!entry.detail) return;
  // Tapping a row opens the full text (no hover tooltips on touch devices); errors start open.
  const full = entry.path ? `${entry.path}
${entry.detail}` : entry.detail;
  row.tabIndex = 0; row.setAttribute("role", "button");
  let detail: HTMLElement | null = null;
  const toggle = (open: boolean): void => {
    row.setAttribute("aria-expanded", String(open));
    row.classList.toggle("is-open", open);
    if (open && !detail) detail = appendErrorDetail(row, full);
    if (detail) detail.hidden = !open;
  };
  row.addEventListener("click", (event) => { if ((event.target as HTMLElement).closest(".nyra-nc-detail")) return; toggle(!row.classList.contains("is-open")); });
  row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(!row.classList.contains("is-open")); } });
  toggle(entry.kind === "error");
}

/** Folder part shrinks first; the file name stays readable, since names differ at the end. */
function renderPath(container: HTMLElement, path: string): void {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) { container.createSpan({ cls: "nyra-nc-path__name", text: path }); return; }
  container.createSpan({ cls: "nyra-nc-path__dir", text: path.slice(0, slash + 1) });
  container.createSpan({ cls: "nyra-nc-path__name", text: path.slice(slash + 1) });
}
