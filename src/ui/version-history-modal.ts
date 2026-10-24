import { Modal, Notice, type App } from "obsidian";
import { errorMessage } from "../core/errors";
import type NyraNextcloudSyncPlugin from "../main";
import type { FileVersion } from "../recovery/file-versions";
import { renderDiff } from "./diff-view";
import { formatBytes, relativePast } from "./format";

/** Browse a note's previous versions stored by Nextcloud, compare them with the current text and restore one. */
export class VersionHistoryModal extends Modal {
  constructor(app: App, private readonly owner: NyraNextcloudSyncPlugin, private readonly path: string) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("nyra-nc-recovery");
    contentEl.createEl("h2", { text: "Previous versions" });
    contentEl.createEl("p", { cls: "nyra-nc-recovery__hint", text: this.path });
    const list = contentEl.createDiv({ cls: "nyra-nc-recovery__list" });
    const preview = contentEl.createDiv({ cls: "nyra-nc-diffpane" });
    list.createEl("p", { text: "Loading…" });
    this.owner.fileVersions(this.path).then((versions) => {
      list.empty();
      if (versions.length === 0) {
        list.createEl("p", { text: "Nextcloud has no earlier versions of this file yet. Versions appear after the file was changed and synced." });
        return;
      }
      for (const version of versions) this.renderRow(list, preview, version);
    }).catch((error: unknown) => {
      list.empty();
      list.createEl("p", { text: `Could not load versions: ${errorMessage(error)}` });
    });
  }

  onClose(): void { this.contentEl.empty(); }

  private renderRow(list: HTMLElement, preview: HTMLElement, version: FileVersion): void {
    const row = list.createDiv({ cls: "nyra-nc-recovery__row" });
    const text = row.createDiv({ cls: "nyra-nc-recovery__text" });
    text.createDiv({ cls: "nyra-nc-recovery__path", text: new Date(version.modifiedAt).toLocaleString() });
    text.createDiv({ cls: "nyra-nc-recovery__meta", text: `${formatBytes(version.size)} · ${relativePast(version.modifiedAt)}` });
    const actions = row.createDiv({ cls: "nyra-nc-callout__actions" });
    const compare = actions.createEl("button", { text: "Compare" });
    const copy = actions.createEl("button", { text: "Restore as copy" });
    const replace = actions.createEl("button", { text: "Replace note" });
    compare.addEventListener("click", () => {
      this.owner.compareFileVersion(this.path, version).then((pair) => {
        if (pair === null) { preview.empty(); preview.createEl("p", { text: "This version is not plain text, so it cannot be compared line by line." }); return; }
        preview.empty();
        preview.createEl("h4", { text: "Current text → selected version" });
        renderDiff(preview.createDiv(), pair.current, pair.version);
      }).catch((error: unknown) => new Notice(`Compare failed: ${errorMessage(error)}`, 10_000));
    });
    const restore = (mode: "copy" | "replace", button: HTMLButtonElement): void => {
      button.disabled = true;
      this.owner.restoreFileVersion(this.path, version, mode).then((target) => {
        new Notice(mode === "copy" ? `Saved as ${target}` : "Note replaced. The previous text stays available as an earlier version on Nextcloud.");
        this.close();
      }).catch((error: unknown) => {
        new Notice(`Restore failed: ${errorMessage(error)}`, 12_000);
        button.disabled = false;
      });
    };
    copy.addEventListener("click", () => restore("copy", copy));
    replace.addEventListener("click", () => restore("replace", replace));
  }
}
