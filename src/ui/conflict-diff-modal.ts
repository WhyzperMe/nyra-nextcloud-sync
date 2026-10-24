import { Modal, type App } from "obsidian";
import { errorMessage } from "../core/errors";
import type NyraNextcloudSyncPlugin from "../main";
import { renderDiff } from "./diff-view";

type Mode = "local-remote" | "base-local" | "base-remote";

export interface ConflictAction { label: string; run: () => void }

/** Side-by-side understanding of a conflict: what changed locally and remotely relative to the common ancestor. */
export class ConflictDiffModal extends Modal {
  constructor(app: App, private readonly owner: NyraNextcloudSyncPlugin, private readonly entryId: string, private readonly path: string, private readonly actions: ConflictAction[]) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("nyra-nc-recovery");
    contentEl.createEl("h2", { text: "Compare versions" });
    contentEl.createEl("p", { cls: "nyra-nc-recovery__hint", text: this.path });
    const body = contentEl.createDiv();
    body.createEl("p", { text: "Loading both versions…" });
    this.owner.conflictPreview(this.entryId).then((preview) => {
      body.empty();
      if (preview.unavailable) { body.createEl("p", { text: preview.unavailable }); this.renderActions(contentEl); return; }
      const modes: Array<[Mode, string, string | null, string | null]> = [
        ["local-remote", "This device → Nextcloud", preview.local, preview.remote],
        ["base-local", "Common ancestor → this device", preview.base, preview.local],
        ["base-remote", "Common ancestor → Nextcloud", preview.base, preview.remote]
      ];
      const tabs = body.createDiv({ cls: "nyra-nc-recovery__tabs" });
      const pane = body.createDiv({ cls: "nyra-nc-diffpane" });
      const show = (index: number): void => {
        const [, , before, after] = modes[index]!;
        if (before === null || after === null) { pane.empty(); pane.createEl("p", { text: "This comparison is not available because one side is missing." }); return; }
        renderDiff(pane, before, after);
      };
      modes.forEach(([, label], index) => tabs.createEl("button", { text: label }).addEventListener("click", () => show(index)));
      show(0);
      this.renderActions(contentEl);
    }).catch((error: unknown) => {
      body.empty();
      body.createEl("p", { text: `Could not load the versions: ${errorMessage(error)}` });
    });
  }

  onClose(): void { this.contentEl.empty(); }

  private renderActions(contentEl: HTMLElement): void {
    if (this.actions.length === 0) return;
    const row = contentEl.createDiv({ cls: "nyra-nc-callout__actions" });
    for (const action of this.actions) {
      row.createEl("button", { text: action.label }).addEventListener("click", () => { this.close(); action.run(); });
    }
  }
}
