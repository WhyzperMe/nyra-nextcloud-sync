import { describe, expect, it } from "vitest";
import { resolveRuntimeScope, runtimeScopeIdentity } from "../src/platform/runtime-scope-binding";
import { getPluginDeviceRuntimeRoot } from "../src/platform/device-scope";
import { MemoryVaultAdapter } from "./helpers/memory-vault";

const pluginId = "nyra-nextcloud-sync";
const baseScope = "a".repeat(32);
const account = { serverUrl: "https://cloud.example", userId: "alice", webdavRootUrl: "https://cloud.example/remote.php/dav/files/alice/" };

describe("runtime binding across remote roots", () => {
  it("preserves an existing profile store and separates a corrected remote folder", async () => {
    const adapter = new MemoryVaultAdapter();
    const oldIdentity = runtimeScopeIdentity(account, "Obsidian");
    const newIdentity = runtimeScopeIdentity(account, "Obsidian/Nyra");
    expect(oldIdentity).not.toBeNull();
    expect(newIdentity).not.toBeNull();
    const original = await resolveRuntimeScope(adapter, ".obsidian", pluginId, baseScope, oldIdentity);
    const oldRoot = getPluginDeviceRuntimeRoot(".obsidian", pluginId, original);
    await adapter.write(`${oldRoot}/evidence.bin`, "keep old state");

    const corrected = await resolveRuntimeScope(adapter, ".obsidian", pluginId, baseScope, newIdentity);
    expect(corrected).toMatch(/^[a-f0-9]{32}$/);
    expect(corrected).not.toBe(original);
    expect(await adapter.read(`${oldRoot}/evidence.bin`)).toBe("keep old state");
    expect(await resolveRuntimeScope(adapter, ".obsidian", pluginId, baseScope, newIdentity)).toBe(corrected);
    expect(await resolveRuntimeScope(adapter, ".obsidian", pluginId, baseScope, oldIdentity)).toBe(original);
  });

  it("does not bind an unauthenticated empty profile prematurely", async () => {
    const adapter = new MemoryVaultAdapter();
    expect(await resolveRuntimeScope(adapter, ".obsidian", pluginId, baseScope, null)).toBe(baseScope);
    expect(await resolveRuntimeScope(adapter, ".obsidian", pluginId, baseScope, runtimeScopeIdentity(account, "Obsidian/Nyra"))).toBe(baseScope);
  });

  it("fails closed on corrupt bindings and retains their bytes", async () => {
    const adapter = new MemoryVaultAdapter();
    const root = getPluginDeviceRuntimeRoot(".obsidian", pluginId, baseScope);
    await adapter.write(`${root}/scope-binding.json`, "{broken");
    await expect(resolveRuntimeScope(adapter, ".obsidian", pluginId, baseScope, runtimeScopeIdentity(account, "Obsidian")))
      .rejects.toThrow(/unreadable/);
    expect(await adapter.read(`${root}/scope-binding.json`)).toBe("{broken");
  });

  it("recovers an exactly matching staged binding after an interrupted write", async () => {
    const adapter = new MemoryVaultAdapter();
    const identity = runtimeScopeIdentity(account, "Obsidian");
    expect(identity).not.toBeNull();
    const root = getPluginDeviceRuntimeRoot(".obsidian", pluginId, baseScope);
    const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity ?? ""));
    const identityHash = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await adapter.write(`${root}/scope-binding.json.tmp`, JSON.stringify({ version: 1, identityHash }));
    expect(await resolveRuntimeScope(adapter, ".obsidian", pluginId, baseScope, identity)).toBe(baseScope);
    expect(await adapter.exists(`${root}/scope-binding.json.tmp`)).toBe(false);
  });
});
