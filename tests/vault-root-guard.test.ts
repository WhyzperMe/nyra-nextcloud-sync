import { describe, expect, it } from "vitest";
import { assertVaultRootMapping } from "../src/sync/vault-root-guard";
import type { RemoteFullScanResult, RemoteInventoryEntry } from "../src/remote/types";

function scan(paths: string[]): RemoteFullScanResult {
  const entries: RemoteInventoryEntry[] = paths.map((path, index) => ({ path, fileId: String(index + 1), etag: `e${index}`, size: 3, mtimeMs: null, contentType: null, sha256Hint: null, checksums: [] }));
  return { kind: "full", rootPath: "Obsidian", entries, trust: "authoritative", complete: true, issues: [], directories: [], oversized: [], rootEtag: null, directoriesVisited: 1, startedAt: "", finishedAt: "" };
}

describe("vault root mapping guard", () => {
  it("blocks a parent root that would copy this vault into itself", async () => {
    const local = [{ path: "one.md", size: 3 }, { path: "two.md", size: 3 }];
    expect(() => assertVaultRootMapping(scan(["Nyra/one.md", "Nyra/two.md"]), "Nyra", local, "Obsidian"))
      .toThrow(/Obsidian\/Nyra/);
  });

  it("allows the matching folder even if an older nested duplicate remains", async () => {
    const local = [{ path: "one.md", size: 3 }, { path: "two.md", size: 3 }, { path: "Nyra/one.md", size: 3 }];
    expect(() => assertVaultRootMapping(scan(["one.md", "two.md", "Nyra/one.md", "Nyra/two.md"]), "Nyra", local, "Obsidian/Nyra"))
      .not.toThrow();
  });

  it("blocks on positive nested evidence even if the remote scan is incomplete", async () => {
    const local = [{ path: "one.md", size: 3 }, { path: "two.md", size: 3 }];
    const partial = { ...scan(["Nyra/one.md", "Nyra/two.md"]), trust: "incomplete" as const, complete: false as const, issues: [{ path: "Nyra", code: "request-failed" as const, message: "offline" }] };
    expect(() => assertVaultRootMapping(partial, "Nyra", local, "Obsidian")).toThrow(/Possible vault folder mismatch/);
  });
});
