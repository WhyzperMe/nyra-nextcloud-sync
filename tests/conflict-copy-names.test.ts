import { describe, expect, it } from "vitest";
import { addConflictSuffix, conflictCopyPath } from "../src/plugin/conflict-copies";

describe("Conflict copy names", () => {
  it("keep a drawing's double extension so the copy is still a drawing", () => {
    expect(conflictCopyPath("Schule/Drawing 2026-10-19 10.03.34.excalidraw.md", "REMOTE", "39ab2c220f19aaaa"))
      .toBe("Schule/Drawing 2026-10-19 10.03.34 (Nyra conflict REMOTE 39ab2c220f19).excalidraw.md");
    expect(addConflictSuffix("A/B.excalidraw.md", 2)).toBe("A/B (2).excalidraw.md");
  });

  it("treat ordinary files as before", () => {
    expect(conflictCopyPath("Notes/A.md", "LOCAL", "abcdefabcdefabcd")).toBe("Notes/A (Nyra conflict LOCAL abcdefabcdef).md");
    expect(conflictCopyPath("README", "LOCAL", "abcdefabcdefabcd")).toBe("README (Nyra conflict LOCAL abcdefabcdef)");
    expect(addConflictSuffix("a.tar.gz", 3)).toBe("a.tar (3).gz");
  });
});
