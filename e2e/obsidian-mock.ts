/**
 * Minimal runtime stand-in for the `obsidian` module, bundled in only by the
 * opt-in live end-to-end runner. It implements exactly the surface Nyra uses.
 */
export const Platform = { isDesktopApp: true, isMobileApp: false };

export class Notice {
  constructor(message: string) { if (process.env.NYRA_E2E_VERBOSE) console.log(`[notice] ${message}`); }
}

export async function requestUrl(params: { url: string; method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer; contentType?: string }) {
  const headers: Record<string, string> = { ...(params.headers ?? {}) };
  if (params.contentType) headers["Content-Type"] = params.contentType;
  const init: RequestInit = { method: params.method ?? "GET", headers, redirect: "manual" };
  if (params.body !== undefined) init.body = typeof params.body === "string" ? params.body : new Uint8Array(params.body);
  const response = await fetch(params.url, init);
  const arrayBuffer = await response.arrayBuffer();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => { responseHeaders[key] = value; });
  const text = new TextDecoder().decode(arrayBuffer);
  return { status: response.status, headers: responseHeaders, arrayBuffer, text, get json() { return JSON.parse(text) as unknown; } };
}

export class TAbstractFile { constructor(public path: string) {} }
export class TFile extends TAbstractFile { stat = { ctime: 0, mtime: 0, size: 0 }; }
export class TFolder extends TAbstractFile {}

export class Component {
  private children: Component[] = [];
  private cleanups: Array<() => void> = [];
  private loaded = false;
  load(): void { if (this.loaded) return; this.loaded = true; this.onload(); }
  onload(): void | Promise<void> {}
  unload(): void {
    for (const child of this.children.splice(0)) child.unload();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.loaded = false;
    this.onunload();
  }
  onunload(): void {}
  addChild<T extends Component>(child: T): T { this.children.push(child); child.load(); return child; }
  registerEvent(ref: { off: () => void }): void { this.cleanups.push(() => ref.off()); }
  registerInterval(id: number): number { this.cleanups.push(() => clearInterval(id)); return id; }
  registerDomEvent(target: EventTarget, type: string, callback: (event: Event) => unknown): void {
    target.addEventListener(type, callback);
    this.cleanups.push(() => target.removeEventListener(type, callback));
  }
}

export class Plugin extends Component {
  constructor(public app: any, public manifest: any) { super(); }
  async loadData(): Promise<unknown> { return await this.app.__loadPluginData(this.manifest.id); }
  async saveData(data: unknown): Promise<void> { await this.app.__savePluginData(this.manifest.id, data); }
  addSettingTab(): void {}
  addCommand(command: unknown): unknown { return command; }
  addStatusBarItem(): unknown { return { classList: { add() {} }, textContent: "", title: "" }; }
}

export class PluginSettingTab { constructor(public app: unknown, public plugin: unknown) {} }
export class Setting {}
export class Modal { constructor(public app: unknown) {} open(): void {} close(): void {} }
