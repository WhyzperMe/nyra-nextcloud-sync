import type { DataAdapter } from "obsidian";

type AdapterStat = Awaited<ReturnType<DataAdapter["stat"]>>;
type AdapterListing = Awaited<ReturnType<DataAdapter["list"]>>;

export type AdapterOperation = "write" | "writeBinary" | "appendBinary" | "mkdir" | "rename" | "remove";
export type AdapterFaultPhase = "before" | "after";

export interface AdapterFaultRule {
  id: string;
  operation: AdapterOperation;
  phase: AdapterFaultPhase;
  occurrence?: number;
  times?: number;
  pathIncludes?: string;
  message?: string;
}

/** Deterministic crash/error injector for local transactional-apply tests. */
export class FaultInjectingDataAdapter implements DataAdapter {
  private readonly seen = new Map<string, number>();
  private readonly fired = new Map<string, number>();

  constructor(private readonly delegate: DataAdapter, private readonly rules: readonly AdapterFaultRule[]) {}
  hitCount(id: string): number { return this.fired.get(id) ?? 0; }

  getName(): string { return this.delegate.getName(); }
  async exists(path: string): Promise<boolean> { return await this.delegate.exists(path); }
  async read(path: string): Promise<string> { return await this.delegate.read(path); }
  async readBinary(path: string): Promise<ArrayBuffer> { return await this.delegate.readBinary(path); }
  async list(path: string): Promise<AdapterListing> { return await this.delegate.list(path); }
  async stat(path: string): Promise<AdapterStat> { return await this.delegate.stat(path); }
  getResourcePath(path: string): string { return this.delegate.getResourcePath(path); }
  async append(path: string, data: string): Promise<void> { await this.delegate.append(path, data); }
  async process(path: string, fn: (data: string) => string): Promise<string> { return await this.delegate.process(path, fn); }
  async trashSystem(path: string): Promise<boolean> { return await this.delegate.trashSystem(path); }
  async trashLocal(path: string): Promise<void> { await this.delegate.trashLocal(path); }
  async rmdir(path: string, recursive: boolean): Promise<void> { await this.delegate.rmdir(path, recursive); }

  async write(path: string, data: string): Promise<void> {
    await this.mutate("write", path, () => this.delegate.write(path, data));
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.mutate("writeBinary", path, () => this.delegate.writeBinary(path, data));
  }
  async appendBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.mutate("appendBinary", path, () => this.delegate.appendBinary(path, data));
  }
  async mkdir(path: string): Promise<void> {
    await this.mutate("mkdir", path, () => this.delegate.mkdir(path));
  }
  async rename(from: string, to: string): Promise<void> {
    await this.mutate("rename", `${from} -> ${to}`, () => this.delegate.rename(from, to));
  }
  async copy(from: string, to: string): Promise<void> { await this.delegate.copy(from, to); }
  async remove(path: string): Promise<void> {
    await this.mutate("remove", path, () => this.delegate.remove(path));
  }

  private async mutate(operation: AdapterOperation, path: string, fn: () => Promise<void>): Promise<void> {
    this.maybeThrow(operation, "before", path);
    await fn();
    this.maybeThrow(operation, "after", path);
  }

  private maybeThrow(operation: AdapterOperation, phase: AdapterFaultPhase, path: string): void {
    for (const rule of this.rules) {
      if (rule.operation !== operation || rule.phase !== phase) continue;
      if (rule.pathIncludes && !path.includes(rule.pathIncludes)) continue;
      const key = `${rule.id}:${phase}`;
      const seen = (this.seen.get(key) ?? 0) + 1;
      this.seen.set(key, seen);
      const occurrence = rule.occurrence ?? 1;
      const maxFires = rule.times ?? 1;
      const fired = this.fired.get(rule.id) ?? 0;
      if (seen < occurrence || fired >= maxFires) continue;
      this.fired.set(rule.id, fired + 1);
      throw new Error(rule.message ?? `Injected adapter fault '${rule.id}' during ${operation} ${phase}.`);
    }
  }
}
