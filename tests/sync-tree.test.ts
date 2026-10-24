import { describe, expect, it } from "vitest";
import { listSyncTreeChildren, type SyncTreeSources } from "../src/folders/sync-tree";

const ROOT = "https://cloud.example/remote.php/dav/files/alice/Obsidian/Vault";

function adapter(tree: Record<string, { folders: string[]; files: Record<string, number> }>): SyncTreeSources["adapter"] {
  return {
    exists: async (path: string) => path === "" || path in tree,
    list: async (path: string) => ({ folders: tree[path]?.folders ?? [], files: Object.keys(tree[path]?.files ?? {}) }),
    stat: async (path: string) => { const folder = path.slice(0, Math.max(0, path.lastIndexOf("/"))); const size = tree[folder]?.files[path]; return size === undefined ? null : { type: "file", ctime: 0, mtime: 0, size }; }
  } as unknown as SyncTreeSources["adapter"];
}

const remoteOf = (hrefs: Array<[string, boolean, number | null]>, fail = false): SyncTreeSources["remote"] => ({
  rootUrl: ROOT,
  client: { listDirectory: async () => { if (fail) throw new Error("offline"); return hrefs.map(([href, isCollection, size]) => ({ href: `/remote.php/dav/files/alice/Obsidian/Vault/${href}`, status: 200, isCollection, etag: null, fileId: null, size, lastModified: null, contentType: null, checksums: [] })); } } as never
});

describe("sync tree listing", () => {
  const device = adapter({
    "": { folders: ["Projects", ".obsidian", "Local only"], files: { "Welcome.md": 10, "z-last.md": 5 } },
    Projects: { folders: [], files: { "Projects/a.md": 3 } }
  });
  const inScope = (path: string): boolean => !path.startsWith(".obsidian");

  it("merges both sides, marks where items live and orders folders first with natural sorting", async () => {
    const remote = remoteOf([["", true, null], ["Projects/", true, null], ["Server only/", true, null], ["Welcome.md", false, 10], ["file 10.md", false, 1], ["file 2.md", false, 1]]);
    const result = await listSyncTreeChildren({ adapter: device, isInBaseScope: inScope, remote }, "");
    expect(result.serverReachable).toBe(true);
    expect(result.entries.map((e) => `${e.isFolder ? "D" : "F"}:${e.name}:${e.onDevice ? "d" : ""}${e.onServer ? "s" : ""}`)).toEqual([
      "D:Local only:d", "D:Projects:ds", "D:Server only:s", "F:file 2.md:s", "F:file 10.md:s", "F:Welcome.md:ds", "F:z-last.md:d"
    ]);
    expect(result.entries.find((e) => e.name === "Welcome.md")?.size).toBe(10);
  });

  it("lists a sub folder and ignores the folder entry itself and deeper items", async () => {
    const remote = remoteOf([["Projects/", true, null], ["Projects/a.md", false, 3], ["Projects/deep/x.md", false, 1]]);
    const result = await listSyncTreeChildren({ adapter: device, isInBaseScope: inScope, remote }, "Projects");
    expect(result.entries.map((e) => e.path)).toEqual(["Projects/a.md"]);
  });

  it("falls back to this device when Nextcloud cannot be reached and hides the vault's reserved paths", async () => {
    const result = await listSyncTreeChildren({ adapter: device, isInBaseScope: inScope, remote: remoteOf([], true) }, "");
    expect(result.serverReachable).toBe(false);
    expect(result.entries.map((e) => e.name)).toEqual(["Local only", "Projects", "Welcome.md", "z-last.md"]);
    const reserved = await listSyncTreeChildren({ adapter: device, isInBaseScope: inScope, remote: remoteOf([[".nyra-nextcloud-sync-runtime/", true, null]]) }, "");
    expect(reserved.entries.some((e) => e.name.startsWith(".nyra-nextcloud"))).toBe(false);
  });

  it("works without any remote (not connected yet)", async () => {
    const result = await listSyncTreeChildren({ adapter: device, isInBaseScope: inScope }, "Projects");
    expect(result).toMatchObject({ serverReachable: false, entries: [{ path: "Projects/a.md", onDevice: true, onServer: false }] });
  });
});
