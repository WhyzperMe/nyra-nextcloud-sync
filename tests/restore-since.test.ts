import { describe, expect, it } from "vitest";
import { RecoveryService, type RecoveryDeps } from "../src/recovery/recovery-service";
import type { DeletedFileRecord } from "../src/recovery/deletion-ledger";
import type { NextcloudTrash, TrashedItem } from "../src/recovery/nextcloud-trash";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const ago = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();
const hash = (char: string): string => char.repeat(64);

function item(original: string, hours: number, isFolder = false): TrashedItem {
  return { trashName: `${original.split("/").pop()}.d${hours}`, originalLocation: original, isFolder, size: isFolder ? null : 5, deletedAt: ago(hours) };
}

function setup(trashItems: TrashedItem[], ledger: DeletedFileRecord[], options: { existing?: string[]; failing?: Set<string>; noTrash?: boolean } = {}) {
  const restored: string[] = [];
  const created: string[] = [];
  const folders: string[][] = [];
  const forgotten: DeletedFileRecord[] = [];
  const existing = new Set(options.existing ?? []);
  const trash = {
    async list(_root: string, _limit?: number) { return trashItems; },
    async restore(entry: TrashedItem) {
      if (options.failing?.has(entry.originalLocation)) throw new Error("Nextcloud cannot restore this item because something already exists at its original location.");
      restored.push(entry.originalLocation);
    }
  } as unknown as NextcloudTrash;
  const deps: RecoveryDeps = {
    ledger: { async recent() { return [...ledger].reverse(); }, async record() {}, async forget(entry: DeletedFileRecord) { forgotten.push(entry); } } as never,
    activity: { async add() {} } as never,
    async getBlob() { return new ArrayBuffer(1); },
    async exists(path) { return existing.has(path) || created.includes(path); },
    async createFile(path) { created.push(path); },
    isInScope: () => true,
    trash: () => (options.noTrash ? null : trash),
    remoteRoot: () => "Obsidian/Nyra",
    async ensureRemoteFolders(list) { folders.push([...list]); },
    now: () => new Date(NOW)
  };
  return { service: new RecoveryService(deps), restored, created, folders, forgotten };
}

describe("Restore everything deleted since a time", () => {
  it("restores trash items since the cutoff, folders first, creating missing parents once", async () => {
    const { service, restored, folders } = setup([
      item("Obsidian/Nyra/Schule/Mathe/Aufgabe.md", 2),
      item("Obsidian/Nyra/Schule", 1, true),
      item("Obsidian/Nyra/Alt.md", 100) // deleted long before the cutoff
    ], []);
    const report = await service.restoreSince(new Date(NOW - 24 * 3_600_000));
    expect(restored).toEqual(["Obsidian/Nyra/Schule", "Obsidian/Nyra/Schule/Mathe/Aufgabe.md"]);
    expect(folders).toEqual([["Schule", "Schule/Mathe"]]);
    expect(report).toMatchObject({ trashRestored: 2, trashFailed: 0, localRestored: 0 });
  });

  it("counts items that already exist, keeps going after a failure and reports it", async () => {
    const { service, restored } = setup([item("Obsidian/Nyra/A.md", 1), item("Obsidian/Nyra/B.md", 1), item("Obsidian/Nyra/C.md", 1)], [],
      { failing: new Set(["Obsidian/Nyra/B.md"]) });
    const report = await service.restoreSince(new Date(NOW - 3_600_000 * 5));
    expect(restored).toEqual(["Obsidian/Nyra/A.md", "Obsidian/Nyra/C.md"]);
    expect(report).toMatchObject({ trashRestored: 2, trashPresent: 1, trashFailed: 0 });
  });

  it("writes back retained copies the trash bin no longer has, without overwriting or duplicating", async () => {
    const entries: DeletedFileRecord[] = [
      { path: "Lost.md", blobHash: hash("a"), size: 1, deletedAt: ago(3), removed: "local" },
      { path: "Here.md", blobHash: hash("b"), size: 1, deletedAt: ago(3), removed: "local" },
      { path: "Covered/Inside.md", blobHash: hash("c"), size: 1, deletedAt: ago(3), removed: "remote" },
      { path: "Older.md", blobHash: hash("d"), size: 1, deletedAt: ago(300), removed: "local" }
    ];
    const { service, created, forgotten } = setup([item("Obsidian/Nyra/Covered", 3, true)], entries, { existing: ["Here.md"] });
    const preview = await service.previewSince(new Date(NOW - 24 * 3_600_000));
    expect(preview).toMatchObject({ trashItems: 1, localCopies: 2 });
    const report = await service.restoreSince(new Date(NOW - 24 * 3_600_000));
    expect(created).toEqual(["Lost.md"]);
    expect(forgotten.map((entry) => entry.path)).toEqual(["Lost.md"]);
    expect(report).toMatchObject({ trashRestored: 1, localRestored: 1, localSkipped: 2, localFailed: 0 });
  });

  it("still restores from retained copies when no trash bin is reachable", async () => {
    const { service, created } = setup([], [{ path: "Only.md", blobHash: hash("e"), size: 1, deletedAt: ago(1), removed: "remote" }], { noTrash: true });
    const report = await service.restoreSince(new Date(NOW - 3_600_000 * 2));
    expect(created).toEqual(["Only.md"]);
    expect(report.localRestored).toBe(1);
  });
});
