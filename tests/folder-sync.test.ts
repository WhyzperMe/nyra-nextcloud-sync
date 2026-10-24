import { describe, expect, it } from "vitest";
import { occupiedDirectories, planFolderSync } from "../src/folders/folder-plan";
import { FolderSyncService, type FolderSyncPorts, type LocalTree } from "../src/folders/folder-sync";
import { FolderBaselineStore } from "../src/folders/folder-baseline";
import { MemoryVaultAdapter } from "./helpers/memory-vault";

const set = (...values: string[]): Set<string> => new Set(values);
const none = set();
const logger = { debug() {}, info() {}, warn() {}, error() {} };

function plan(overrides: Partial<Parameters<typeof planFolderSync>[0]>) {
  return planFolderSync({ local: none, remote: none, baseline: none, allowDeletes: true, localOccupied: none, remoteOccupied: none, ...overrides });
}

describe("folder plan", () => {
  it("mirrors never-confirmed folders in both directions and never deletes them", () => {
    const result = plan({ local: set("A", "A/B"), remote: set("R") });
    expect(result.createRemote).toEqual(["A", "A/B"]);
    expect(result.createLocal).toEqual(["R"]);
    expect(result.deleteLocal).toEqual([]);
    expect(result.deleteRemote).toEqual([]);
    expect([...result.nextBaseline].sort()).toEqual(["A", "A/B", "R"]);
  });

  it("deletes a confirmed folder on the remote after a local deletion, deepest first", () => {
    const result = plan({ remote: set("A", "A/B"), baseline: set("A", "A/B") });
    expect(result.deleteRemote).toEqual(["A/B", "A"]);
    expect(result.nextBaseline.size).toBe(0);
  });

  it("deletes a confirmed folder locally after a remote deletion", () => {
    const result = plan({ local: set("A"), baseline: set("A") });
    expect(result.deleteLocal).toEqual(["A"]);
  });

  it("keeps a confirmed folder while the other side still holds files, and when deletes are off", () => {
    expect(plan({ remote: set("A"), baseline: set("A"), remoteOccupied: set("A") }).deleteRemote).toEqual([]);
    expect(plan({ local: set("A"), baseline: set("A"), localOccupied: set("A") }).deleteLocal).toEqual([]);
    const off = plan({ remote: set("A"), baseline: set("A"), allowDeletes: false });
    expect(off.deleteRemote).toEqual([]);
    expect(off.createLocal).toEqual([]);
    expect(off.nextBaseline.has("A")).toBe(true);
  });

  it("forgets folders that vanished on both sides", () => {
    expect(plan({ baseline: set("A") }).nextBaseline.size).toBe(0);
  });

  it("derives occupied ancestors from file paths", () => {
    expect([...occupiedDirectories(["a/b/c.md", "d.md", "a/e.md"])].sort()).toEqual(["a", "a/b"]);
  });
});

class FakeWorld {
  readonly local = new Set<string>();
  readonly remote = new Set<string>();
  localFiles: string[] = [];
  remoteFiles: string[] = [];
  readonly ports: FolderSyncPorts = {
    listLocalTree: async (): Promise<LocalTree> => ({ folders: new Set(this.local), files: new Set(this.localFiles) }),
    createLocalFolder: async (path) => { this.local.add(path); },
    removeLocalFolderIfEmpty: async (path) => { if (this.localFiles.some((f) => f.startsWith(`${path}/`))) return false; this.local.delete(path); return true; },
    createRemoteFolder: async (path) => { this.remote.add(path); },
    removeRemoteFolderIfEmpty: async (path) => { if (this.remoteFiles.some((f) => f.startsWith(`${path}/`))) return false; this.remote.delete(path); return true; }
  };
}

describe("folder sync service", () => {
  async function setup() {
    const adapter = new MemoryVaultAdapter();
    const world = new FakeWorld();
    const service = new FolderSyncService(world.ports, new FolderBaselineStore(adapter, "folders.json"), logger);
    const run = async (allowDeletes = true) => await service.run({ remoteFolders: [...world.remote], remoteFiles: world.remoteFiles, allowDeletes });
    return { world, run };
  }

  it("creates an empty local folder remotely, then deletes it remotely when removed locally", async () => {
    const { world, run } = await setup();
    world.local.add("Empty");
    expect((await run()).created).toBe(1);
    expect(world.remote.has("Empty")).toBe(true);
    world.local.delete("Empty");
    expect((await run()).deleted).toBe(1);
    expect(world.remote.has("Empty")).toBe(false);
    expect(await run()).toMatchObject({ created: 0, deleted: 0, failed: 0, held: 0 });
    expect(world.local.has("Empty")).toBe(false); // does not reappear
  });

  it("propagates a remote deletion to the local folder and a remote creation to the device", async () => {
    const { world, run } = await setup();
    world.remote.add("FromServer");
    await run();
    expect(world.local.has("FromServer")).toBe(true);
    world.remote.delete("FromServer");
    await run();
    expect(world.local.has("FromServer")).toBe(false);
  });

  it("does not delete anything when deletes are disabled, then catches up when enabled", async () => {
    const { world, run } = await setup();
    world.local.add("X");
    await run();
    world.local.delete("X");
    await run(false);
    expect(world.remote.has("X")).toBe(true);
    expect(world.local.has("X")).toBe(false);
    await run(true);
    expect(world.remote.has("X")).toBe(false);
  });

  it("retries later when a folder is no longer empty at delete time", async () => {
    const { world, run } = await setup();
    world.local.add("Busy");
    await run();
    world.local.delete("Busy");
    world.remoteFiles = ["Busy/new.md"]; // not visible to the plan snapshot, only to the guarded removal
    const racing = { ...world.ports, removeRemoteFolderIfEmpty: async () => false };
    const adapter = new MemoryVaultAdapter();
    const store = new FolderBaselineStore(adapter, "f.json");
    await store.save(new Set(["Busy"]));
    const service = new FolderSyncService(racing, store, logger);
    const result = await service.run({ remoteFolders: ["Busy"], remoteFiles: [], allowDeletes: true });
    expect(result.deleted).toBe(0);
    expect((await store.load()).has("Busy")).toBe(true);
  });

  it("holds back folder deletions beyond the limit and reports them", async () => {
    const world = new FakeWorld();
    for (const name of ["A", "B", "C", "D"]) world.remote.add(name); // deleted locally, still confirmed in the baseline
    const store = new FolderBaselineStore(new MemoryVaultAdapter(), "f.json");
    await store.save(new Set(["A", "B", "C", "D"]));
    const result = await new FolderSyncService(world.ports, store, logger).run({ remoteFolders: [...world.remote], remoteFiles: [], allowDeletes: true, maxDeletes: 3 });
    expect(result).toMatchObject({ held: 4, deleted: 0 });
    expect(world.remote.size).toBe(4);
    const allowed = await new FolderSyncService(world.ports, store, logger).run({ remoteFolders: [...world.remote], remoteFiles: [], allowDeletes: true });
    expect(allowed).toMatchObject({ held: 0, deleted: 4 });
    expect(world.remote.size).toBe(0);
  });

  it("treats a damaged baseline as empty so nothing is deleted", async () => {
    const adapter = new MemoryVaultAdapter();
    await adapter.write("f.json", "{not json");
    expect((await new FolderBaselineStore(adapter, "f.json").load()).size).toBe(0);
  });
});
