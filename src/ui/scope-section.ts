import { Notice, Setting, type TextAreaComponent, type TextComponent } from "obsidian";
import { MAX_RULES } from "../local/user-rules";
import type { PluginSettings } from "../state/settings";
import type NyraNextcloudSyncPlugin from "../main";
import { RecoveryModal } from "./recovery-modal";

type Mutator = (settings: PluginSettings) => void;

/** Which files and folders take part in sync, and how large a file may be on this device. */
export function renderScopeSection(section: HTMLElement, owner: NyraNextcloudSyncPlugin, save: (mutator: Mutator) => void): void {
  const busy = owner.isSyncBusy();

  new Setting(section)
    .setName("Excluded files and folders")
    .setDesc("One pattern per line. “*.tmp” matches files by extension, “node_modules” any item with that name, “Private/” a folder and everything in it, “/Inbox” only at the vault root, “Attachments/**/raw” across levels. Excluded items stay where they are on both sides and are never deleted.")
    .setClass("nyra-nc-setting--wide")
    .addTextArea((area) => bindLines(area, owner.settings.excludePatterns, "*.tmp\nPrivate/\n.git/", busy, (lines) => save((settings) => { settings.excludePatterns = lines; })));

  // Superseded by the file picker; still shown for installations that already use it.
  if (owner.settings.includeFolders.length > 0) {
    new Setting(section)
      .setName("Only sync these folders")
      .setDesc("Optional, one vault folder per line. When set, everything outside these folders is ignored on this device. Leave empty to sync the whole vault.")
      .setClass("nyra-nc-setting--wide")
      .addTextArea((area) => bindLines(area, owner.settings.includeFolders, "Projects/NYRA\nSchule", busy, (lines) => save((settings) => { settings.includeFolders = lines; })));
  }

  const deviceLimit = owner.deviceFileLimitMiB();
  new Setting(section)
    .setName("Skip files larger than (MiB)")
    .setDesc(`0 uses this device's safe limit (${deviceLimit} MiB). Obsidian can only read whole files into memory, so larger files are skipped on this device; they are never deleted or overwritten and everything else keeps syncing.`)
    .addText((text) => bindNumber(text, owner.settings.maxFileSizeMiB, "0", busy, 0, 4096, (value) => save((settings) => { settings.maxFileSizeMiB = value; })));

  if (owner.settings.excludePatterns.length >= MAX_RULES) {
    const note = document.createElement("div");
    note.className = "nyra-nc-callout nyra-nc-callout--neutral";
    note.textContent = `Only the first ${MAX_RULES} patterns are used.`;
    section.appendChild(note);
  }
}

/** Automatic deletion, the mass-deletion guard and the way back. */
export function renderDeletionSection(section: HTMLElement, owner: NyraNextcloudSyncPlugin, save: (mutator: Mutator) => void): void {
  const busy = owner.isSyncBusy();

  new Setting(section)
    .setName("Automatic deletes")
    .setDesc("Propagate deleted files and folders to the other side. Deletes still require complete inventories, a recoverable baseline and fresh remote preconditions; deleted files remain recoverable from the Nextcloud trash bin.")
    .addToggle((toggle) => toggle.setValue(owner.settings.autoSyncAllowDeletes).setDisabled(busy).onChange((value) => {
      save((settings) => { settings.autoSyncAllowDeletes = value; });
    }));

  new Setting(section)
    .setName("Ask before deleting more than")
    .setDesc("If one sync would delete more than this many files or folders, Nyra waits for your approval instead of deleting. 0 never asks. Protects against accidental mass deletion, for example after a vault was moved or emptied.")
    .addText((text) => bindNumber(text, owner.settings.deleteConfirmThreshold, "20", busy, 0, 100_000, (value) => save((settings) => { settings.deleteConfirmThreshold = value; })));

  new Setting(section)
    .setName("Restore deleted files")
    .setDesc("Bring back files that a sync deleted, from Nyra's retained copies or the Nextcloud trash bin.")
    .addButton((button) => button.setButtonText("Open restore").onClick(() => new RecoveryModal(owner.app, owner).open()));
}

function bindLines(area: TextAreaComponent, current: readonly string[], placeholder: string, disabled: boolean, commit: (lines: string[]) => void): void {
  area.setPlaceholder(placeholder).setValue(current.join("\n")).setDisabled(disabled);
  area.inputEl.rows = 4;
  area.inputEl.classList.add("nyra-nc-textarea");
  area.inputEl.addEventListener("blur", () => {
    const lines = area.getValue().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.join("\n") !== current.join("\n")) commit(lines);
  });
}

function bindNumber(text: TextComponent, current: number, placeholder: string, disabled: boolean, min: number, max: number, commit: (value: number) => void): void {
  text.setPlaceholder(placeholder).setValue(String(current)).setDisabled(disabled);
  text.inputEl.classList.add("nyra-nc-input--narrow");
  const apply = (): void => {
    const parsed = Number.parseInt(text.getValue(), 10);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      new Notice(`Enter a whole number between ${min} and ${max}.`);
      text.setValue(String(current));
      return;
    }
    if (parsed !== current) commit(parsed);
  };
  text.inputEl.addEventListener("blur", apply);
  text.inputEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    text.inputEl.blur();
  });
}
