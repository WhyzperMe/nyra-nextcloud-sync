import { Modal, Notice, type App } from "obsidian";
import { errorMessage } from "../core/errors";
import type NyraNextcloudSyncPlugin from "../main";
import type { DeletedFileRecord } from "../recovery/deletion-ledger";
import type { TrashedItem } from "../recovery/nextcloud-trash";
import { formatBytes, relativePast } from "./format";

type Tab = "local" | "trash";

/** Restore files removed by sync, either from the copies Nyra retained or from the Nextcloud trash bin. */
export class RecoveryModal extends Modal {
  private tab: Tab = "local";
  private listEl: HTMLElement | null = null;
  private revision = 0;

  constructor(app: App, private readonly owner: NyraNextcloudSyncPlugin) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("nyra-nc-recovery");
    contentEl.createEl("h2", { text: "Restore deleted files" });
    contentEl.createEl("p", {
      cls: "nyra-nc-recovery__hint",
      text: "Files that a sync deleted can be brought back here. Restored files are synced again like any new file."
    });
    this.renderRestoreAll(contentEl);
    const tabs = contentEl.createDiv({ cls: "nyra-nc-recovery__tabs" });
    const local = tabs.createEl("button", { text: "Deleted by sync" });
    const trash = tabs.createEl("button", { text: "Nextcloud trash bin" });
    local.addEventListener("click", () => this.show("local"));
    trash.addEventListener("click", () => this.show("trash"));
    this.listEl = contentEl.createDiv({ cls: "nyra-nc-recovery__list" });
    this.show("local");
  }

  onClose(): void {
    this.revision += 1;
    this.contentEl.empty();
  }

  /** Time picker plus one button that restores everything deleted since then. */
  private renderRestoreAll(parent: HTMLElement): void {
    const panel = parent.createDiv({ cls: "nyra-nc-recovery__all" });
    panel.createEl("h3", { text: "Restore everything deleted since…" });
    const presets: Array<[string, string, number | null]> = [
      ["hour", "the last hour", 3_600_000], ["six", "the last 6 hours", 6 * 3_600_000], ["day", "the last 24 hours", 24 * 3_600_000],
      ["week", "the last 7 days", 7 * 24 * 3_600_000], ["month", "the last 30 days", 30 * 24 * 3_600_000], ["custom", "a date and time I choose", null]
    ];
    const select = panel.createEl("select", { cls: "dropdown" });
    for (const [value, label] of presets) { const option = select.createEl("option", { text: label }); option.value = value; }
    select.value = "day";
    const custom = panel.createEl("input");
    custom.type = "datetime-local";
    custom.addClass("nyra-nc-recovery__when");
    custom.style.display = "none";
    const summary = panel.createDiv({ cls: "nyra-nc-recovery__meta", text: "" });
    const button = panel.createEl("button", { text: "Restore everything", cls: "mod-cta" });
    let revision = 0;
    let since: Date | null = null;

    const pickSince = (): Date | null => {
      const preset = presets.find(([value]) => value === select.value);
      if (preset && preset[2] !== null) return new Date(Date.now() - preset[2]);
      const parsed = custom.value ? new Date(custom.value) : null;
      return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
    };
    const refresh = (): void => {
      custom.style.display = select.value === "custom" ? "" : "none";
      since = pickSince();
      const mine = ++revision;
      button.disabled = true;
      if (!since) { summary.setText("Choose a date and time."); return; }
      summary.setText("Counting…");
      this.owner.previewRestoreSince(since).then((preview) => {
        if (mine !== revision) return;
        const total = preview.trashItems + preview.localCopies;
        summary.setText(total === 0
          ? "Nothing to restore for this time."
          : `${preview.trashItems} in the Nextcloud trash bin · ${preview.localCopies} kept on this device`);
        button.disabled = total === 0;
      }).catch((error: unknown) => {
        if (mine !== revision) return;
        summary.setText(`Could not count: ${errorMessage(error)}`);
        button.disabled = false;
      });
    };
    select.addEventListener("change", refresh);
    custom.addEventListener("change", refresh);
    button.addEventListener("click", () => {
      if (!since) return;
      const chosen = since;
      button.disabled = true;
      button.setText("Restoring…");
      this.owner.restoreDeletedSince(chosen).then((report) => {
        const restored = report.trashRestored + report.localRestored;
        const failed = report.trashFailed + report.localFailed;
        new Notice(`Restored ${restored} item${restored === 1 ? "" : "s"}${failed > 0 ? ` · ${failed} failed (${report.errors[0] ?? "see the log"})` : ""}. They sync back to this device now.`, 15_000);
        button.setText("Restore everything");
        refresh();
        this.show(this.tab);
      }).catch((error: unknown) => {
        new Notice(`Restore failed: ${errorMessage(error)}`, 12_000);
        button.setText("Restore everything");
        refresh();
      });
    });
    refresh();
  }

  private show(tab: Tab): void {
    this.tab = tab;
    const revision = ++this.revision;
    const list = this.listEl;
    if (!list) return;
    list.empty();
    list.createEl("p", { text: "Loading…" });
    const load = tab === "local" ? this.owner.recentlyDeleted() : this.owner.listNextcloudTrash();
    void load.then((items) => {
      if (revision !== this.revision) return;
      list.empty();
      if (items.length === 0) {
        list.createEl("p", { text: tab === "local" ? "Nothing deleted by sync in the last 90 days." : "The Nextcloud trash bin holds nothing from this vault." });
        return;
      }
      for (const item of items) {
        if (tab === "local") this.renderLocalRow(list, item as DeletedFileRecord);
        else this.renderTrashRow(list, item as TrashedItem);
      }
    }).catch((error: unknown) => {
      if (revision !== this.revision) return;
      list.empty();
      list.createEl("p", { text: `Could not load: ${errorMessage(error)}` });
    });
  }

  private renderLocalRow(list: HTMLElement, entry: DeletedFileRecord): void {
    const row = list.createDiv({ cls: "nyra-nc-recovery__row" });
    const text = row.createDiv({ cls: "nyra-nc-recovery__text" });
    text.createDiv({ cls: "nyra-nc-recovery__path", text: entry.path });
    text.createDiv({ cls: "nyra-nc-recovery__meta", text: `${formatBytes(entry.size)} · deleted ${relativePast(entry.deletedAt)} · ${entry.removed === "local" ? "removed from this device" : "removed from Nextcloud"}` });
    const button = row.createEl("button", { text: "Restore" });
    button.addEventListener("click", () => {
      button.disabled = true;
      this.owner.restoreDeletedFile(entry).then((path) => {
        new Notice(`Restored ${path}`);
        this.show(this.tab);
      }).catch((error: unknown) => {
        new Notice(`Restore failed: ${errorMessage(error)}`, 10_000);
        button.disabled = false;
      });
    });
  }

  private renderTrashRow(list: HTMLElement, item: TrashedItem): void {
    const row = list.createDiv({ cls: "nyra-nc-recovery__row" });
    const text = row.createDiv({ cls: "nyra-nc-recovery__text" });
    text.createDiv({ cls: "nyra-nc-recovery__path", text: item.originalLocation });
    text.createDiv({ cls: "nyra-nc-recovery__meta", text: `${item.isFolder ? "Folder" : formatBytes(item.size ?? 0)} · deleted ${relativePast(item.deletedAt)}` });
    const button = row.createEl("button", { text: "Restore" });
    button.addEventListener("click", () => {
      button.disabled = true;
      this.owner.restoreFromNextcloudTrash(item).then(() => {
        new Notice("Restored on Nextcloud. It will appear here after the next sync.");
        this.show(this.tab);
      }).catch((error: unknown) => {
        new Notice(`Restore failed: ${errorMessage(error)}`, 10_000);
        button.disabled = false;
      });
    });
  }
}
