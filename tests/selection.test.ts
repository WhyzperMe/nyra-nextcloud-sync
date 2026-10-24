import { describe, expect, it } from "vitest";
import { normalizeExcludes, selectionState, setIncluded } from "../src/local/selection";
import { UserScopeRules } from "../src/local/user-rules";

const tree: Record<string, string[]> = {
  "": ["Projects", "Schule", "Welcome.md"],
  Projects: ["Projects/NYRA", "Projects/Ideas", "Projects/todo.md"],
  "Projects/NYRA": ["Projects/NYRA/a.md", "Projects/NYRA/b.md"]
};
const list = async (folder: string): Promise<string[]> => tree[folder] ?? [];

describe("file picker selection model", () => {
  it("derives included, excluded and partial states", () => {
    const excludes = ["Projects/NYRA/b.md", "Schule"];
    expect(selectionState("Schule", excludes)).toBe("excluded");
    expect(selectionState("Schule/Mathe/x.md", excludes)).toBe("excluded");
    expect(selectionState("Projects", excludes)).toBe("partial");
    expect(selectionState("Projects/NYRA", excludes)).toBe("partial");
    expect(selectionState("Projects/NYRA/a.md", excludes)).toBe("included");
    expect(selectionState("Welcome.md", excludes)).toBe("included");
  });

  it("unchecking a folder replaces rules for its descendants and ignores items already excluded", async () => {
    const next = await setIncluded(["Projects/NYRA/b.md", "Projects/Ideas"], "Projects", false, list);
    expect(next).toEqual(["Projects"]);
    expect(await setIncluded(next, "Projects/NYRA/a.md", false, list)).toEqual(["Projects"]);
  });

  it("re-including a folder or file clears its own and its descendants' rules", async () => {
    expect(await setIncluded(["Projects", "Schule"], "Projects", true, list)).toEqual(["Schule"]);
    expect(await setIncluded(["Projects/NYRA/b.md", "Projects/NYRA/a.md"], "Projects/NYRA", true, list)).toEqual([]);
  });

  it("re-including an item below an excluded ancestor keeps the ancestor's other children excluded", async () => {
    const next = await setIncluded(["Projects"], "Projects/NYRA/a.md", true, list);
    expect(next).toEqual(["Projects/Ideas", "Projects/NYRA/b.md", "Projects/todo.md"]);
    const rules = new UserScopeRules({ excludePatterns: [], includeFolders: [], excludePaths: next });
    expect(rules.isExcluded("Projects/NYRA/a.md", "file")).toBe(false);
    expect(rules.isExcluded("Projects/NYRA/b.md", "file")).toBe(true);
    expect(rules.isExcluded("Projects/Ideas/x.md", "file")).toBe(true);
    expect(rules.isExcluded("Projects/todo.md", "file")).toBe(true);
    expect(rules.isExcluded("Schule/y.md", "file")).toBe(false);
  });

  it("normalizes input, drops unsafe entries and redundant descendants", () => {
    expect(normalizeExcludes(["/Projects/", "Projects/NYRA", "../escape", "a//b", "", "Projects"])).toEqual(["Projects", "a/b"]);
  });
});

describe("exact path rules", () => {
  it("match a path and everything below it, with glob characters taken literally", () => {
    const rules = new UserScopeRules({ excludePatterns: [], includeFolders: [], excludePaths: ["Notes/Q3 [draft]*", "Schule"] });
    expect(rules.isExcluded("Notes/Q3 [draft]*", "file")).toBe(true);
    expect(rules.isExcluded("Notes/Q3 [draft]*/inner.md", "file")).toBe(true);
    expect(rules.isExcluded("Notes/Q3 draft", "file")).toBe(false);
    expect(rules.isExcluded("Schule", "folder")).toBe(true);
    expect(rules.isExcluded("Schule2/a.md", "file")).toBe(false);
    expect(rules.isExcluded("Other/Schule/a.md", "file")).toBe(false);
  });
});
