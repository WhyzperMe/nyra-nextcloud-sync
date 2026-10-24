/**
 * Browser stand-in for the parts of the `obsidian` module that the settings UI uses. It reproduces
 * Obsidian's DOM structure (setting-item, checkbox-container, mod-cta) so the plugin's stylesheet can
 * be reviewed in a normal browser. Used only by the UI preview tool.
 */
declare global {
  interface HTMLElement {
    empty(): void;
    addClass(...classes: string[]): void;
    createDiv(options?: { cls?: string; text?: string }): HTMLDivElement;
    createSpan(options?: { cls?: string; text?: string }): HTMLSpanElement;
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, options?: { cls?: string; text?: string }): HTMLElementTagNameMap[K];
    setText(text: string): void;
  }
}

function install(): void {
  const proto = HTMLElement.prototype;
  proto.empty = function (this: HTMLElement) { while (this.firstChild) this.removeChild(this.firstChild); };
  proto.addClass = function (this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); };
  proto.setText = function (this: HTMLElement, text: string) { this.textContent = text; };
  proto.createEl = function <K extends keyof HTMLElementTagNameMap>(this: HTMLElement, tag: K, options: { cls?: string; text?: string } = {}) {
    const element = document.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    this.appendChild(element);
    return element;
  };
  proto.createDiv = function (this: HTMLElement, options) { return this.createEl("div", options); };
  proto.createSpan = function (this: HTMLElement, options) { return this.createEl("span", options); };
}
install();

export const Platform = { isDesktopApp: true, isMobileApp: false };
export class Notice { constructor(message: string) { console.log(`[notice] ${message}`); } }
export class Modal { contentEl = document.createElement("div"); constructor(public app: unknown) {} open(): void {} close(): void {} }

export class ToggleComponent {
  toggleEl: HTMLElement;
  private input: HTMLInputElement;
  private handler: ((value: boolean) => unknown) | null = null;
  constructor(parent: HTMLElement) {
    this.toggleEl = parent.createDiv({ cls: "checkbox-container" });
    this.input = this.toggleEl.createEl("input");
    this.input.type = "checkbox";
    this.toggleEl.addEventListener("click", () => {
      if (this.toggleEl.classList.contains("is-disabled")) return;
      this.setValue(!this.toggleEl.classList.contains("is-enabled"));
      void this.handler?.(this.toggleEl.classList.contains("is-enabled"));
    });
  }
  setValue(value: boolean): this { this.toggleEl.classList.toggle("is-enabled", value); this.input.checked = value; return this; }
  setDisabled(value: boolean): this { this.toggleEl.classList.toggle("is-disabled", value); return this; }
  onChange(callback: (value: boolean) => unknown): this { this.handler = callback; return this; }
}

export class ButtonComponent {
  buttonEl: HTMLButtonElement;
  constructor(parent: HTMLElement) { this.buttonEl = parent.createEl("button"); }
  setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
  setCta(): this { this.buttonEl.classList.add("mod-cta"); return this; }
  setWarning(): this { this.buttonEl.classList.add("mod-warning"); return this; }
  setDisabled(value: boolean): this { this.buttonEl.disabled = value; return this; }
  onClick(callback: (event: MouseEvent) => unknown): this { this.buttonEl.addEventListener("click", callback); return this; }
}

export class TextComponent {
  inputEl: HTMLInputElement;
  constructor(parent: HTMLElement) { this.inputEl = parent.createEl("input"); this.inputEl.type = "text"; }
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  setDisabled(value: boolean): this { this.inputEl.disabled = value; return this; }
  onChange(callback: (value: string) => unknown): this { this.inputEl.addEventListener("input", () => callback(this.inputEl.value)); return this; }
}

export class TextAreaComponent {
  inputEl: HTMLTextAreaElement;
  constructor(parent: HTMLElement) { this.inputEl = parent.createEl("textarea"); }
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  setDisabled(value: boolean): this { this.inputEl.disabled = value; return this; }
  onChange(callback: (value: string) => unknown): this { this.inputEl.addEventListener("input", () => callback(this.inputEl.value)); return this; }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(name: string): this { this.nameEl.textContent = name; return this; }
  setDesc(desc: string): this { this.descEl.textContent = desc; return this; }
  setClass(cls: string): this { this.settingEl.classList.add(cls); return this; }
  addToggle(cb: (c: ToggleComponent) => unknown): this { cb(new ToggleComponent(this.controlEl)); return this; }
  addButton(cb: (c: ButtonComponent) => unknown): this { cb(new ButtonComponent(this.controlEl)); return this; }
  addText(cb: (c: TextComponent) => unknown): this { cb(new TextComponent(this.controlEl)); return this; }
  addTextArea(cb: (c: TextAreaComponent) => unknown): this { cb(new TextAreaComponent(this.controlEl)); return this; }
}

export class PluginSettingTab {
  containerEl = document.createElement("div");
  constructor(public app: unknown, public plugin: unknown) {}
  hide(): void {}
}
export const requestUrl = async (): Promise<never> => { throw new Error("offline preview"); };
export class Plugin {}
export class Component {}
export class TFile {}
export class TFolder {}
