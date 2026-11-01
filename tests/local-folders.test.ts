import { describe, expect, it } from "vitest";
import { isSystemJunk, LocalFolderAccess } from "../src/folders/local-folders";
import { LocalPathPolicy } from "../src/local/path-policy";
import { MemoryVaultAdapter } from "./helpers/memory-vault";

const bytes = (): ArrayBuffer => new Uint8Array([1]).buffer;

describe("Local folder removal", () => {
  it("recognizes operating-system metadata files only", () => {
    for (const name of [".DS_Store", "a/Thumbs.db", "a/b/desktop.ini", "x/.nomedia", "._resource", "n/.directory"]) expect(isSystemJunk(name), name).toBe(true);
    for (const name of ["note.md", "a/.obsidian", "Thumbs.db.md", "._", "a/photo.jpg"]) expect(isSystemJunk(name), name).toBe(false);
  });

  it("removes a folder that only holds system metadata, as file managers leave on phones", async () => {
    const adapter = new MemoryVaultAdapter();
    await adapter.mkdir("Old");
    await adapter.writeBinary("Old/.nomedia", bytes());
    await adapter.writeBinary("Old/Thumbs.db", bytes());
    const access = new LocalFolderAccess(adapter, new LocalPathPolicy());
    expect(await access.removeIfEmpty("Old")).toBe(true);
    expect(await adapter.exists("Old")).toBe(false);
  });

  it("keeps a folder with a real file, a subfolder, or nothing to remove", async () => {
    const adapter = new MemoryVaultAdapter();
    await adapter.mkdir("Keep");
    await adapter.writeBinary("Keep/.nomedia", bytes());
    await adapter.writeBinary("Keep/note.md", bytes());
    await adapter.mkdir("Nest");
    await adapter.mkdir("Nest/Child");
    const access = new LocalFolderAccess(adapter, new LocalPathPolicy());
    expect(await access.removeIfEmpty("Keep")).toBe(false);
    expect(await adapter.exists("Keep/.nomedia")).toBe(true);
    expect(await access.removeIfEmpty("Nest")).toBe(false);
    expect(await access.removeIfEmpty("Missing")).toBe(true);
  });
});
