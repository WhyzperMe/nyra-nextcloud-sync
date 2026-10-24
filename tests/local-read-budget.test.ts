import type { Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import { LocalTransactionalMutator } from "../src/execution/local-mutator";
import { isWithinLocalReadBudget } from "../src/local/read-budget";
import type { Logger } from "../src/diagnostics/logger";
import { MemoryVaultAdapter } from "./helpers/memory-vault";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DEVICE_SCOPE = "c".repeat(32);

class CountingAdapter extends MemoryVaultAdapter {
  reads = 0;
  override async readBinary(path: string): Promise<ArrayBuffer> {
    this.reads += 1;
    return await super.readBinary(path);
  }
}

describe("bounded local whole-file reads", () => {
  it("checks mobile and desktop policy boundaries without allocating large buffers", () => {
    const mib = 1024 * 1024;
    for (const [limit, below] of [[32 * mib, 31 * mib], [128 * mib, 127 * mib]] as const) {
      expect(isWithinLocalReadBudget(below, limit)).toBe(true);
      expect(isWithinLocalReadBudget(limit, limit)).toBe(true);
      expect(isWithinLocalReadBudget(limit + 1, limit)).toBe(false);
    }
    expect(isWithinLocalReadBudget(-1, 32 * mib)).toBe(false);
    expect(isWithinLocalReadBudget(Number.NaN, 32 * mib)).toBe(false);
  });

  it("refuses an oversized local source before allocating through readBinary", async () => {
    const adapter = new CountingAdapter();
    await adapter.writeBinary("Large.bin", new TextEncoder().encode("12345").buffer);
    adapter.reads = 0;
    const mutator = new LocalTransactionalMutator({ adapter, configDir: ".obsidian" } as unknown as Vault, "nyra-nextcloud-sync", logger, DEVICE_SCOPE, 4);
    await expect(mutator.readVerified("Large.bin")).rejects.toThrow(/local memory limit/i);
    expect(adapter.reads).toBe(0);
  });

  it("rejects a streamed target above the local budget before creating staging state", async () => {
    const adapter = new CountingAdapter();
    const mutator = new LocalTransactionalMutator({ adapter, configDir: ".obsidian" } as unknown as Vault, "nyra-nextcloud-sync", logger, DEVICE_SCOPE, 4);
    async function* chunks(): AsyncIterable<ArrayBuffer> { yield new TextEncoder().encode("12345").buffer; }
    await expect(mutator.writeAtomicFromChunks("Large.bin", chunks(), null, null, 5)).rejects.toThrow(/local memory limit/i);
    expect(await adapter.exists("Large.bin")).toBe(false);
  });
});
