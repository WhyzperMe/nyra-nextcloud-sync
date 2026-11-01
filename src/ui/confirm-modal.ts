import { Modal, type App } from "obsidian";

/** Small yes/no dialog that works on phones: large buttons, no keyboard needed. */
export class ConfirmModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly lines: readonly string[],
    private readonly confirmLabel: string,
    private readonly onDecision: (confirmed: boolean) => void
  ) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    for (const line of this.lines) contentEl.createEl("p", { text: line });
    const row = contentEl.createDiv({ cls: "nyra-nc-confirm__row" });
    const cancel = row.createEl("button", { text: "Cancel" });
    const confirm = row.createEl("button", { text: this.confirmLabel, cls: "mod-cta" });
    cancel.addEventListener("click", () => this.finish(false));
    confirm.addEventListener("click", () => this.finish(true));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) { this.decided = true; this.onDecision(false); }
  }

  private finish(confirmed: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.onDecision(confirmed);
    this.close();
  }
}
