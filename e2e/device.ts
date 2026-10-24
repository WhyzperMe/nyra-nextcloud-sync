import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TFile as TFileType, TFolder as TFolderType, Platform } from "obsidian";
import Plugin from "../src/main";

const CONFIG_DIR = ".obsidian";
// The runner aliases "obsidian" to e2e/obsidian-mock.ts, whose classes take the path.
const TFile = TFileType as unknown as new (path: string) => TFileType;
const TFolder = TFolderType as unknown as new (path: string) => TFolderType;

/** Browser globals the plugin expects from an Obsidian renderer. */
function installBrowserGlobals(): void {
  const storage = new Map<string, string>();
  const define = (name: string, value: unknown): void => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  define("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } });
  // Each simulated device has its own vault directory, so lock contention between them is irrelevant here.
  define("navigator", { locks: { request: async (name: string, _o: unknown, cb: (lock: { name: string } | null) => unknown) => await cb({ name }) } });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  define("document", doc);
  define("window", new EventTarget());
}
installBrowserGlobals();
type Listener = (...args: any[]) => unknown;

/** A real directory driven through an Obsidian-shaped App (adapter, vault events, secret storage). */
export class Device {
  readonly root: string;
  plugin: any = null;
  private watcher: fs.FSWatcher | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly known = new Map<string, "file" | "folder">();
  private readonly secrets = new Map<string, string>();
  private readonly pluginFiles = new Map<string, unknown>();

  constructor(readonly name: string, parent: string, private readonly manifest: any, private readonly options: { mobile: boolean }) {
    this.root = path.join(parent, name);
    fs.mkdirSync(path.join(this.root, CONFIG_DIR, "plugins", manifest.id), { recursive: true });
  }

  private abs(p: string): string { return path.join(this.root, ...p.split("/").filter(Boolean)); }
  private isHidden(p: string): boolean { return p.split("/").some((segment) => segment.startsWith(".")); }

  readonly adapter = {
    getName: () => this.name,
    exists: async (p: string) => fs.existsSync(this.abs(p)),
    read: async (p: string) => await fsp.readFile(this.abs(p), "utf8"),
    readBinary: async (p: string) => { const b = await fsp.readFile(this.abs(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    write: async (p: string, data: string) => await fsp.writeFile(this.abs(p), data, "utf8"),
    writeBinary: async (p: string, data: ArrayBuffer) => await fsp.writeFile(this.abs(p), new Uint8Array(data)),
    append: async (p: string, data: string) => await fsp.appendFile(this.abs(p), data, "utf8"),
    appendBinary: async (p: string, data: ArrayBuffer) => await fsp.appendFile(this.abs(p), new Uint8Array(data)),
    process: async (p: string, fn: (d: string) => string) => { const out = fn(await fsp.readFile(this.abs(p), "utf8")); await fsp.writeFile(this.abs(p), out, "utf8"); return out; },
    getResourcePath: (p: string) => p,
    mkdir: async (p: string) => { await fsp.mkdir(this.abs(p), { recursive: true }); },
    rename: async (from: string, to: string) => await fsp.rename(this.abs(from), this.abs(to)),
    copy: async (from: string, to: string) => await fsp.copyFile(this.abs(from), this.abs(to)),
    trashSystem: async (p: string) => { await fsp.rm(this.abs(p), { recursive: true, force: true }); return true; },
    trashLocal: async (p: string) => { await fsp.rm(this.abs(p), { recursive: true, force: true }); },
    rmdir: async (p: string, recursive: boolean) => { if (recursive) await fsp.rm(this.abs(p), { recursive: true }); else await fsp.rmdir(this.abs(p)); },
    remove: async (p: string) => await fsp.unlink(this.abs(p)),
    list: async (p: string) => {
      const entries = await fsp.readdir(this.abs(p), { withFileTypes: true });
      const base = p.replace(/\/+$/, "");
      const files: string[] = []; const folders: string[] = [];
      for (const entry of entries) (entry.isDirectory() ? folders : files).push(base ? `${base}/${entry.name}` : entry.name);
      return { files, folders };
    },
    stat: async (p: string) => {
      try {
        const s = await fsp.stat(this.abs(p));
        return { type: s.isDirectory() ? "folder" as const : "file" as const, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
      } catch { return null; }
    }
  };

  readonly vault = {
    adapter: this.adapter,
    configDir: CONFIG_DIR,
    getFiles: () => this.walk("").files.map((p) => { const f = new TFile(p); const s = fs.statSync(this.abs(p)); f.stat = { ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }; return f; }),
    on: (name: string, cb: Listener) => {
      let set = this.listeners.get(name);
      if (!set) this.listeners.set(name, set = new Set());
      set.add(cb);
      return { off: () => set!.delete(cb) };
    }
  };

  readonly app = {
    vault: this.vault,
    secretStorage: {
      getSecret: (key: string) => this.secrets.get(key) ?? null,
      setSecret: (key: string, value: string) => { this.secrets.set(key, value); }
    },
    workspace: {},
    __loadPluginData: async (id: string) => this.pluginFiles.get(id) ?? null,
    __savePluginData: async (id: string, data: unknown) => { this.pluginFiles.set(id, structuredClone(data)); }
  };

  seedAccount(settings: { serverUrl: string; userId: string; appPassword: string; remoteRootPath: string }): void {
    const secretId = `nyra-nextcloud-${"ab".repeat(16)}`;
    this.secrets.set(secretId, settings.appPassword);
    this.pluginFiles.set(this.manifest.id, {
      schemaVersion: 8, serverUrl: settings.serverUrl, remoteRootPath: settings.remoteRootPath,
      syncObsidianConfig: false, autoSyncEnabled: true, autoSyncQuietSeconds: 1, autoSyncRemotePollSeconds: 15, autoSyncAllowDeletes: true,
      autoMergeText: true, connectionState: "verified",
      account: {
        serverUrl: settings.serverUrl, loginName: settings.userId, userId: settings.userId, displayName: settings.userId,
        webdavRootUrl: `${settings.serverUrl}/remote.php/dav/files/${settings.userId}/`, serverVersion: "33.0.9.1", serverVersionString: "33.0.9", verifiedAt: new Date().toISOString()
      },
      credentialBinding: { serverUrl: settings.serverUrl, loginName: settings.userId, secretId }
    });
  }

  async start(): Promise<void> {
    (Platform as any).isMobileApp = this.options.mobile;
    (Platform as any).isDesktopApp = !this.options.mobile;
    const initial = this.walk("");
    for (const p of initial.files) this.known.set(p, "file");
    for (const p of initial.folders) this.known.set(p, "folder");
    this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => { if (filename) void this.onFsEvent(filename.toString().split(path.sep).join("/")); });
    this.plugin = new (Plugin as any)(this.app, { ...this.manifest, dir: `${CONFIG_DIR}/plugins/${this.manifest.id}` });
    if (process.env.NYRA_E2E_RAW_LOG) {
      // The production logger redacts error text; tests want the raw diagnostics.
      for (const level of ["debug", "warn", "error"] as const) this.plugin.logger[level] = (event: string, context?: unknown) => { if (level !== "debug" || event.startsWith("folders.")) console.log(`[${this.name}] ${level} ${event}`, JSON.stringify(context)); };
    }
    await this.plugin.onload();
    await (this.plugin as any).runtimeInitializationDone;
    if (this.plugin.stateInitializationError) throw new Error(`${this.name}: ${this.plugin.stateInitializationError}`);
  }

  async stop(): Promise<void> {
    this.plugin?.unload();
    this.plugin?.onunload();
    await (this.plugin as any)?.finishRuntimeShutdown?.();
    this.watcher?.close(); this.watcher = null;
    this.plugin = null;
    this.known.clear();
  }

  private emit(name: string, ...args: unknown[]): void { for (const cb of [...(this.listeners.get(name) ?? [])]) void cb(...args); }

  private async onFsEvent(p: string): Promise<void> {
    if (!p || this.isHidden(p)) return;
    let stat: fs.Stats | null = null;
    try { stat = await fsp.stat(this.abs(p)); } catch { /* deleted */ }
    if (!stat) {
      const kind = this.known.get(p);
      if (!kind) return;
      this.known.delete(p);
      this.emit("delete", kind === "folder" ? new TFolder(p) : new TFile(p));
      return;
    }
    const kind = stat.isDirectory() ? "folder" : "file";
    const wasKnown = this.known.has(p);
    this.known.set(p, kind);
    if (kind === "folder") { if (!wasKnown) this.emit("create", new TFolder(p)); return; }
    const file = new TFile(p);
    file.stat = { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
    this.emit(wasKnown ? "modify" : "create", file);
  }

  walk(dir: string): { files: string[]; folders: string[] } {
    const files: string[] = []; const folders: string[] = [];
    const visit = (d: string): void => {
      for (const entry of fs.readdirSync(this.abs(d), { withFileTypes: true })) {
        const p = d ? `${d}/${entry.name}` : entry.name;
        if (this.isHidden(p)) continue;
        if (entry.isDirectory()) { folders.push(p); visit(p); } else files.push(p);
      }
    };
    visit(dir);
    return { files: files.sort(), folders: folders.sort() };
  }

  // ---- user actions -------------------------------------------------------
  async write(p: string, content: string | Uint8Array): Promise<void> {
    await fsp.mkdir(path.dirname(this.abs(p)), { recursive: true });
    await fsp.writeFile(this.abs(p), content);
  }
  async mkdir(p: string): Promise<void> { await fsp.mkdir(this.abs(p), { recursive: true }); }
  async removeRecursive(p: string): Promise<void> {
    await fsp.rm(this.abs(p), { recursive: true });
  }
  async rename(from: string, to: string): Promise<void> {
    await fsp.mkdir(path.dirname(this.abs(to)), { recursive: true });
    await fsp.rename(this.abs(from), this.abs(to));
  }
  read(p: string): Buffer { return fs.readFileSync(this.abs(p)); }
  exists(p: string): boolean { return fs.existsSync(this.abs(p)); }
  async runSyncNow(): Promise<unknown> { return await this.plugin.runAutoSyncNow(); }
}
