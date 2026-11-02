import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { LocalTransactionalMutator } from "../src/execution/local-mutator";
import { sha256Hex } from "../src/state/durable/crypto";
import { MemoryVaultAdapter, makeMemoryVault } from "./helpers/memory-vault";

const scope = "c".repeat(32);
const enc = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const dec = (bytes: ArrayBuffer): string => new TextDecoder().decode(bytes);
const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

async function* slowChunks(parts: string[], during: () => Promise<void>): AsyncIterable<ArrayBuffer> {
  let first = true;
  for (const part of parts) {
    yield enc(part);
    if (first) { first = false; await during(); }
  }
}

describe("local create while the user creates the same path", () => {
  it("keeps the user's file, leaves nothing that blocks the next start, and cleans staging", async () => {
    const adapter = new MemoryVaultAdapter();
    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, scope);
    await mutator.initializeAndRecover();
    const incoming = "downloaded-from-remote";
    const hash = await sha256Hex(enc(incoming));

    await expect(mutator.writeAtomicFromChunks(
      "Inbox/New.md",
      slowChunks(["downloaded-", "from-remote"], async () => { await adapter.writeBinary("Inbox/New.md", enc("typed by the user meanwhile")); }),
      null, hash, incoming.length
    )).rejects.toThrow(/appeared during the transfer/);

    expect(dec(await adapter.readBinary("Inbox/New.md"))).toBe("typed by the user meanwhile");

    // A restart must neither throw nor touch the user's file.
    const restarted = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, scope);
    await expect(restarted.initializeAndRecover()).resolves.toBeUndefined();
    expect(dec(await adapter.readBinary("Inbox/New.md"))).toBe("typed by the user meanwhile");
    // No staging bytes and no manifest remain.
    const files = [...(adapter as unknown as { files: Map<string, Uint8Array> }).files.keys()];
    expect(files.filter((path) => path.includes("/apply/staging/") || path.includes("/apply/journal/"))).toEqual([]);
  }, 30_000);

  it("recovers on restart when the rename failed after the user's file appeared and the manifest survived", async () => {
    // Simulates the process dying between manifest publication and rename while a different file now owns the path.
    const adapter = new MemoryVaultAdapter();
    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, scope);
    await mutator.initializeAndRecover();
    const original = adapter.rename.bind(adapter);
    let crashed = false;
    adapter.rename = async (from: string, to: string) => {
      if (!crashed && to === "Crash/Target.md") {
        crashed = true;
        await adapter.writeBinary("Crash/Target.md", enc("user data"));
        throw new Error("process killed");
      }
      return await original(from, to);
    };
    // The process dies: no cleanup of staging bytes or the manifest can happen.
    const originalRemove = adapter.remove.bind(adapter);
    adapter.remove = async (path: string) => {
      if (path.includes("/apply/")) throw new Error("process killed");
      return await originalRemove(path);
    };
    const bytes = enc("remote data");
    await expect(mutator.writeAtomic("Crash/Target.md", bytes, null)).rejects.toThrow();
    adapter.rename = original;
    adapter.remove = originalRemove;
    const survivors = [...(adapter as unknown as { files: Map<string, Uint8Array> }).files.keys()];
    expect(survivors.some((path) => path.includes("/apply/journal/") && path.endsWith(".json"))).toBe(true);
    expect(dec(await adapter.readBinary("Crash/Target.md"))).toBe("user data");
    const restarted = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, scope);
    await expect(restarted.initializeAndRecover()).resolves.toBeUndefined();
    expect(dec(await adapter.readBinary("Crash/Target.md"))).toBe("user data");
  }, 30_000);
});
