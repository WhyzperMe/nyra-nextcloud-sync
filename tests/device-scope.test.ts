import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { LocalTransactionalMutator } from "../src/execution/local-mutator";
import { getOrCreateDeviceScope, getPluginDeviceRuntimeRoot } from "../src/platform/device-scope";
import { ObsidianStateBackend } from "../src/state/durable/obsidian-backend";
import { randomId } from "../src/state/durable/ids";
import { DurableStateStore } from "../src/state/durable/store";
import { TransferJournalStore } from "../src/transfer/journal";
import { MemoryVaultAdapter, makeMemoryVault } from "./helpers/memory-vault";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const pluginId = "nyra-nextcloud-sync";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("device-local runtime storage", () => {
  it("persists an opaque scope in app-local storage and separates profiles", () => {
    const profileA = new MemoryStorage();
    const profileB = new MemoryStorage();
    const scopeA = getOrCreateDeviceScope(pluginId, profileA);
    const scopeB = getOrCreateDeviceScope(pluginId, profileB);

    expect(scopeA).toMatch(/^[a-f0-9]{32}$/);
    expect(getOrCreateDeviceScope(pluginId, profileA)).toBe(scopeA);
    expect(scopeB).not.toBe(scopeA);
    expect(getPluginDeviceRuntimeRoot(".obsidian", pluginId, scopeA))
      .toBe(`.obsidian/plugins/${pluginId}/runtime/${scopeA}`);
  });

  it("rejects unsafe plugin IDs, scopes and config paths", () => {
    expect(() => getPluginDeviceRuntimeRoot(".obsidian", pluginId, "../../shared"))
      .toThrow(/device scope/i);
    expect(() => getPluginDeviceRuntimeRoot("../.obsidian", pluginId, "a".repeat(32)))
      .toThrow(/config directory/i);
    expect(() => getPluginDeviceRuntimeRoot(".obsidian", "../other-plugin", "a".repeat(32)))
      .toThrow(/plugin ID/i);
  });

  it("keeps duplicate legacy WAL files untouched while new device stores recover independently", async () => {
    const adapter = new MemoryVaultAdapter();
    const legacyWal = `.obsidian/plugins/${pluginId}/state-v2/wal`;
    await adapter.mkdir(legacyWal);
    const duplicateA = `${legacyWal}/000000000000000000000001-wal_${"1".repeat(32)}.wal.json`;
    const duplicateB = `${legacyWal}/000000000000000000000001-wal_${"2".repeat(32)}.wal.json`;
    await adapter.write(duplicateA, "preserved legacy branch A");
    await adapter.write(duplicateB, "preserved legacy branch B");

    const vault = makeMemoryVault(adapter);
    const app = { vault } as App;
    const scopeA = "a".repeat(32);
    const scopeB = "b".repeat(32);
    const storeA = await DurableStateStore.open(new ObsidianStateBackend(app, pluginId, scopeA), logger);
    const storeB = await DurableStateStore.open(new ObsidianStateBackend(app, pluginId, scopeB), logger);

    await storeA.transact("scope-a-write", (tx) => tx.putFile({
      entryId: randomId("entry"), path: "A.md", baseline: null,
      local: { path: "A.md", contentHash: "a".repeat(64), size: 1, mtimeMs: 1 }, remote: null, status: "local-dirty"
    }));
    await storeB.transact("scope-b-write", (tx) => tx.putFile({
      entryId: randomId("entry"), path: "B.md", baseline: null,
      local: { path: "B.md", contentHash: "b".repeat(64), size: 1, mtimeMs: 1 }, remote: null, status: "local-dirty"
    }));
    await storeA.close();
    await storeB.close();

    const reopenedA = await DurableStateStore.open(new ObsidianStateBackend(app, pluginId, scopeA), logger);
    const reopenedB = await DurableStateStore.open(new ObsidianStateBackend(app, pluginId, scopeB), logger);
    expect(Object.values(reopenedA.getState().files).map((file) => file.path)).toEqual(["A.md"]);
    expect(Object.values(reopenedB.getState().files).map((file) => file.path)).toEqual(["B.md"]);
    expect(await adapter.read(duplicateA)).toBe("preserved legacy branch A");
    expect(await adapter.read(duplicateB)).toBe("preserved legacy branch B");
  });

  it("scopes apply recovery and resumable transfer journals to the same device profile", async () => {
    const adapter = new MemoryVaultAdapter();
    const vault = makeMemoryVault(adapter);
    const scope = "c".repeat(32);
    const root = getPluginDeviceRuntimeRoot(".obsidian", pluginId, scope);
    const mutator = new LocalTransactionalMutator(vault, pluginId, logger, scope);
    await mutator.initializeAndRecover();
    const transfer = new TransferJournalStore(vault, pluginId, logger, scope);
    await transfer.ensure();

    expect(await adapter.exists(`${root}/apply/journal`)).toBe(true);
    expect(await adapter.exists(`${root}/apply/staging`)).toBe(true);
    expect(await adapter.exists(`${root}/transfer/local-snapshots`)).toBe(true);
    expect(await adapter.exists(`${root}/transfer/journal`)).toBe(true);
    expect(await adapter.exists(`.obsidian/plugins/${pluginId}/runtime-apply`)).toBe(false);
    expect(await adapter.exists(`.obsidian/plugins/${pluginId}/runtime-transfer`)).toBe(false);
  });

  it("refuses to replay an unscoped legacy local transaction and preserves its recovery record", async () => {
    const adapter = new MemoryVaultAdapter();
    const legacyDir = `.obsidian/plugins/${pluginId}/runtime-apply/journal`;
    const legacyManifest = `${legacyDir}/operation.json`;
    await adapter.mkdir(legacyDir);
    await adapter.write(legacyManifest, "legacy transaction evidence");

    const deviceScope = "d".repeat(32);
    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), pluginId, logger, deviceScope);
    await expect(mutator.initializeAndRecover()).rejects.toThrow(/legacy shared local-recovery record/i);
    expect(await adapter.read(legacyManifest)).toBe("legacy transaction evidence");
    expect(await adapter.exists(`${getPluginDeviceRuntimeRoot(".obsidian", pluginId, deviceScope)}/apply/journal`)).toBe(false);
  });
});
