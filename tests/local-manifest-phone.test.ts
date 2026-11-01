import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { LocalTransactionalMutator } from "../src/execution/local-mutator";
import { sha256Hex } from "../src/state/durable/crypto";
import { MemoryVaultAdapter, makeMemoryVault } from "./helpers/memory-vault";

const scope = "b".repeat(32);
const journalPart = `/apply/journal/`;
const enc = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

function logs() {
  const warnings: Array<{ message: string; data: unknown }> = [];
  const errors: string[] = [];
  const logger: Logger = {
    debug() {}, info() {},
    warn: (message: string, data?: unknown) => { warnings.push({ message, data }); },
    error: (message: string) => { errors.push(message); }
  } as unknown as Logger;
  return { logger, warnings, errors };
}

/** Phone-like storage: nothing ever reads back correctly from files whose name matches `broken`. */
class BrokenReadAdapter extends MemoryVaultAdapter {
  constructor(private readonly broken: (path: string) => boolean) { super(); }
  override async read(path: string): Promise<string> { return this.broken(path) ? "" : await super.read(path); }
  override async readBinary(path: string): Promise<ArrayBuffer> { return this.broken(path) ? new ArrayBuffer(0) : await super.readBinary(path); }
}

describe("Apply manifest on unreliable phone storage", () => {
  it("falls back to another write strategy when staged files never read back", async () => {
    // Every temporary file reads back empty; the manifest at its final name reads back fine.
    const adapter = new BrokenReadAdapter((path) => path.endsWith(".tmp"));
    const { logger, warnings } = logs();
    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, scope);
    await mutator.initializeAndRecover();
    const old = enc("old");
    await adapter.writeBinary("Note.md", old);
    const written = await mutator.writeAtomic("Note.md", enc("new content"), await sha256Hex(old));
    expect(written.path).toBe("Note.md");
    expect(new TextDecoder().decode(await adapter.readBinary("Note.md"))).toBe("new content");
    expect(warnings.some((entry) => entry.message === "apply.manifest-needed-fallback")).toBe(true);
    // Nothing is left behind for the next start to trip over.
    const journal = await adapter.list(`.obsidian/plugins/nyra-nextcloud-sync/runtime/${scope}/apply/journal`);
    expect(journal.files).toEqual([]);
  }, 60_000);

  it("creates a file without a manifest when none can be proven, because that rename is atomic by itself", async () => {
    const adapter = new BrokenReadAdapter((path) => path.includes(journalPart));
    const { logger, errors } = logs();
    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, scope);
    await mutator.initializeAndRecover();
    const result = await mutator.writeAtomic("Fresh/New.md", enc("hello"), null);
    expect(result.path).toBe("Fresh/New.md");
    expect(new TextDecoder().decode(await adapter.readBinary("Fresh/New.md"))).toBe("hello");
    expect(errors).toContain("apply.manifest-unverifiable");
    const journal = await adapter.list(`.obsidian/plugins/nyra-nextcloud-sync/runtime/${scope}/apply/journal`);
    expect(journal.files).toEqual([]);

    // Later creates do not pay the full retry cost again straight away.
    const started = Date.now();
    await mutator.writeAtomic("Fresh/Second.md", enc("again"), null);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 60_000);

  it("refuses to replace an existing file without a durable manifest and names what the storage returned", async () => {
    const adapter = new BrokenReadAdapter((path) => path.includes(journalPart));
    const { logger } = logs();
    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, scope);
    await mutator.initializeAndRecover();
    const old = enc("precious");
    await adapter.writeBinary("Keep.md", old);
    const error = await mutator.writeAtomic("Keep.md", enc("replacement"), await sha256Hex(old)).then(() => null, (reason: unknown) => reason as Error);
    expect(error?.message).toMatch(/could not be verified on this device/);
    expect(error?.message).toMatch(/text-staged: exists=true, stat=\d+ of \d+ bytes, text=0 of \d+ chars/);
    expect(new TextDecoder().decode(await adapter.readBinary("Keep.md"))).toBe("precious");
  }, 90_000);
});
