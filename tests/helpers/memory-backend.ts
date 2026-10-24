import type { StateBackend, StateDirectoryListing } from "../../src/state/durable/backend";
import { assertSafeStatePath } from "../../src/state/durable/backend";

export class MemoryStateBackend implements StateBackend {
  private readonly files = new Map<string, Uint8Array>();
  private readonly folders = new Set<string>([""]);

  async exists(path: string): Promise<boolean> {
    const safe = assertSafeStatePath(path);
    return this.files.has(safe) || this.folders.has(safe);
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(this.requireFile(path));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.requireFile(path);
    const copy = new Uint8Array(data.length);
    copy.set(data);
    return copy.buffer;
  }

  async statSize(path: string): Promise<number | null> {
    const safe = assertSafeStatePath(path);
    const data = this.files.get(safe);
    return data ? data.byteLength : null;
  }

  async writeText(path: string, data: string): Promise<void> {
    const bytes = new TextEncoder().encode(data);
    await this.writeBinary(path, bytes.buffer);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const safe = assertSafeStatePath(path);
    await this.mkdirp(parent(safe));
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data));
    this.files.set(safe, copy);
  }

  async appendBinary(path: string, data: ArrayBuffer): Promise<void> {
    const safe = assertSafeStatePath(path);
    await this.mkdirp(parent(safe));
    const existing = this.files.get(safe) ?? new Uint8Array(0);
    const appended = new Uint8Array(existing.byteLength + data.byteLength);
    appended.set(existing, 0);
    appended.set(new Uint8Array(data), existing.byteLength);
    this.files.set(safe, appended);
  }

  async mkdirp(path: string): Promise<void> {
    const safe = assertSafeStatePath(path);
    this.folders.add("");
    if (!safe) return;
    const parts = safe.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.folders.add(current);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const source = assertSafeStatePath(from);
    const target = assertSafeStatePath(to);
    const data = this.files.get(source);
    if (!data) throw new Error(`Missing source: ${source}`);
    if (this.files.has(target)) throw new Error(`Target exists: ${target}`);
    await this.mkdirp(parent(target));
    this.files.set(target, data);
    this.files.delete(source);
  }

  async remove(path: string): Promise<void> {
    const safe = assertSafeStatePath(path);
    this.files.delete(safe);
  }

  async list(path: string): Promise<StateDirectoryListing> {
    const safe = assertSafeStatePath(path);
    const prefix = safe ? `${safe}/` : "";
    const files = new Set<string>();
    const folders = new Set<string>();

    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      files.add(rest);
    }
    for (const folder of this.folders) {
      if (!folder.startsWith(prefix) || folder === safe) continue;
      const rest = folder.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      folders.add(rest);
    }
    return { files: [...files].sort(), folders: [...folders].sort() };
  }

  listAllFiles(): string[] {
    return [...this.files.keys()].sort();
  }

  tamperText(path: string, text: string): void {
    const safe = assertSafeStatePath(path);
    if (!this.files.has(safe)) throw new Error(`Cannot tamper missing file ${safe}`);
    this.files.set(safe, new TextEncoder().encode(text));
  }

  tamperBinary(path: string, data: Uint8Array): void {
    const safe = assertSafeStatePath(path);
    if (!this.files.has(safe)) throw new Error(`Cannot tamper missing file ${safe}`);
    const copy = new Uint8Array(data.length);
    copy.set(data);
    this.files.set(safe, copy);
  }

  private requireFile(path: string): Uint8Array {
    const safe = assertSafeStatePath(path);
    const data = this.files.get(safe);
    if (!data) throw new Error(`Missing file: ${safe}`);
    return data;
  }
}

function parent(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
