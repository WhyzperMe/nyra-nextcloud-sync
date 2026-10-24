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
