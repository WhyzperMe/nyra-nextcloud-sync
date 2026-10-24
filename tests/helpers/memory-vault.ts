import type { DataAdapter, Vault } from "obsidian";

type AdapterStat = Awaited<ReturnType<DataAdapter["stat"]>>;
type AdapterListing = Awaited<ReturnType<DataAdapter["list"]>>;

/** Minimal Obsidian DataAdapter/Vault used by portable Stage-7 transfer tests. */
export class MemoryVaultAdapter implements DataAdapter {
  private readonly files = new Map<string, Uint8Array>();
  private readonly folders = new Set<string>([""]);
  private clock: number;
  private readonly mtimes = new Map<string, number>();

  constructor(initialClock = 1) {
    if (!Number.isSafeInteger(initialClock) || initialClock <= 0) throw new Error("Initial fixture clock must be a positive safe integer.");
    this.clock = initialClock;
  }

  getName(): string { return "memory-vault"; }
  async exists(path: string): Promise<boolean> { const safe = norm(path); return this.files.has(safe) || this.folders.has(safe); }
  async read(path: string): Promise<string> { return new TextDecoder().decode(this.requireFile(path)); }
  async readBinary(path: string): Promise<ArrayBuffer> { return copyBuffer(this.requireFile(path)); }
  async write(path: string, data: string): Promise<void> { await this.writeBinary(path, new TextEncoder().encode(data).buffer); }
  async append(path: string, data: string): Promise<void> { await this.appendBinary(path, new TextEncoder().encode(data).buffer); }
  async process(path: string, fn: (data: string) => string): Promise<string> {
    const updated = fn(await this.read(path));
    await this.write(path, updated);
    return updated;
  }
  getResourcePath(path: string): string { return `memory-vault://${encodeURIComponent(norm(path))}`; }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const safe = norm(path); await this.mkdirParents(safe); this.files.set(safe, new Uint8Array(data.slice(0))); this.mtimes.set(safe, this.clock++);
  }
  async appendBinary(path: string, data: ArrayBuffer): Promise<void> {
    const safe = norm(path); await this.mkdirParents(safe);
    const old = this.files.get(safe) ?? new Uint8Array(0); const add = new Uint8Array(data);
    const next = new Uint8Array(old.byteLength + add.byteLength); next.set(old); next.set(add, old.byteLength);
    this.files.set(safe, next); this.mtimes.set(safe, this.clock++);
  }
  async mkdir(path: string): Promise<void> {
    const safe = norm(path); if (!safe) return; await this.mkdirParents(`${safe}/x`); this.folders.add(safe);
  }
  async rename(from: string, to: string): Promise<void> {
    const source = norm(from); const target = norm(to);
    if (this.files.has(source)) {
      if (this.files.has(target) || this.folders.has(target)) throw new Error(`Target exists: ${target}`);
      await this.mkdirParents(target); this.files.set(target, this.files.get(source)!); this.files.delete(source);
      this.mtimes.set(target, this.clock++); this.mtimes.delete(source); return;
    }
    if (this.folders.has(source)) {
      if (this.files.has(target) || this.folders.has(target)) throw new Error(`Target exists: ${target}`);
      await this.mkdirParents(`${target}/x`);
      const fileMoves = [...this.files.keys()].filter((p) => p === source || p.startsWith(`${source}/`));
      const folderMoves = [...this.folders].filter((p) => p === source || p.startsWith(`${source}/`)).sort((a,b)=>a.length-b.length);
      for (const folder of folderMoves) this.folders.add(target + folder.slice(source.length));
      for (const file of fileMoves) { const dest=target+file.slice(source.length); this.files.set(dest,this.files.get(file)!); this.files.delete(file); this.mtimes.set(dest,this.clock++); this.mtimes.delete(file); }
      for (const folder of folderMoves.sort((a,b)=>b.length-a.length)) this.folders.delete(folder);
      return;
    }
    throw new Error(`Missing source: ${source}`);
  }
  async copy(from: string, to: string): Promise<void> {
    const source = this.requireFile(from);
    const target = norm(to);
    if (await this.exists(target)) throw new Error(`Target exists: ${target}`);
    await this.writeBinary(target, copyBuffer(source));
  }
  async remove(path: string): Promise<void> {
    const safe = norm(path); this.files.delete(safe); this.mtimes.delete(safe);
    for (const file of [...this.files.keys()]) if (file.startsWith(`${safe}/`)) { this.files.delete(file); this.mtimes.delete(file); }
    for (const folder of [...this.folders]) if (folder === safe || folder.startsWith(`${safe}/`)) this.folders.delete(folder);
  }
  async trashSystem(path: string): Promise<boolean> { await this.remove(path); return true; }
  async trashLocal(path: string): Promise<void> { await this.remove(path); }
  async rmdir(path: string, recursive: boolean): Promise<void> {
    const safe = norm(path);
    if (!recursive) {
      const listing = await this.list(safe);
      if (listing.files.length || listing.folders.length) throw new Error(`Folder is not empty: ${safe}`);
      this.folders.delete(safe);
      return;
    }
    await this.remove(safe);
  }
  async list(path: string): Promise<AdapterListing> {
    const safe = norm(path); const prefix = safe ? `${safe}/` : ""; const files: string[]=[]; const folders: string[]=[];
    for (const file of this.files.keys()) { const rest=file.slice(prefix.length); if(file.startsWith(prefix)&&rest&&!rest.includes('/')) files.push(file); }
    for (const folder of this.folders) { if(!folder.startsWith(prefix)||folder===safe) continue; const rest=folder.slice(prefix.length); if(rest&&!rest.includes('/')) folders.push(folder); }
    return { files: files.sort(), folders: folders.sort() };
  }
  async stat(path: string): Promise<AdapterStat> {
    const safe=norm(path); const data=this.files.get(safe);
    if(data) return {type:"file",ctime:1,mtime:this.mtimes.get(safe)??1,size:data.byteLength};
    if(this.folders.has(safe)) return {type:"folder",ctime:1,mtime:1,size:0};
    return null;
  }

  private requireFile(path: string): Uint8Array { const safe=norm(path); const value=this.files.get(safe); if(!value) throw new Error(`Missing file: ${safe}`); return value; }
  private async mkdirParents(path: string): Promise<void> {
    const safe=norm(path); const parts=safe.split('/').filter(Boolean); let current="";
    for(const part of parts.slice(0,-1)){current=current?`${current}/${part}`:part;this.folders.add(current);}
  }
}

export function makeMemoryVault(adapter: DataAdapter = new MemoryVaultAdapter()): Vault {
  return { adapter, configDir: ".obsidian" } as unknown as Vault;
}

function norm(path: string): string {
  if(path.includes('\\')||path.startsWith('/')||path.split('/').some((p)=>p==='..'||p==='.'||/\0/.test(p))) throw new Error(`Unsafe path: ${path}`);
  return path.split('/').filter(Boolean).join('/');
}
function copyBuffer(data: Uint8Array): ArrayBuffer { const copy=new Uint8Array(data.byteLength);copy.set(data);return copy.buffer; }
