import { describe, expect, it } from "vitest";
import { LocalPathPolicy } from "../src/local/path-policy";
import { UserScopeRules } from "../src/local/user-rules";

const rules = (excludePatterns: string[] = [], includeFolders: string[] = []): UserScopeRules => new UserScopeRules({ excludePatterns, includeFolders });

describe("user exclusion patterns", () => {
  it("matches names at any depth, extensions and anchored paths", () => {
    const r = rules(["*.tmp", "node_modules", "/Root Only.md", "Projects/cache", "# comment", ""]);
    expect(r.isExcluded("a/b/scratch.tmp", "file")).toBe(true);
    expect(r.isExcluded("scratch.tmp", "file")).toBe(true);
    expect(r.isExcluded("x/node_modules/pkg/index.js", "file")).toBe(true);
    expect(r.isExcluded("Root Only.md", "file")).toBe(true);
    expect(r.isExcluded("Sub/Root Only.md", "file")).toBe(false);
    expect(r.isExcluded("Projects/cache/blob", "file")).toBe(true);
    expect(r.isExcluded("Other/Projects/cache/blob", "file")).toBe(false);
    expect(r.isExcluded("notes.md", "file")).toBe(false);
  });

  it("applies directory-only patterns to folders and their contents but never to a same-named file", () => {
    const r = rules(["Private/", "build/"]);
    expect(r.isExcluded("Private", "folder")).toBe(true);
    expect(r.isExcluded("Private/secret.md", "file")).toBe(true);
    expect(r.isExcluded("a/build/out.js", "file")).toBe(true);
    expect(r.isExcluded("Private", "file")).toBe(false);
    expect(r.isExcluded("build", "file")).toBe(false);
  });

  it("supports ** and ? and treats regex metacharacters literally", () => {
    const r = rules(["Attachments/**/raw", "a?c.md", "report (1).md", "v1.0+beta"]);
    expect(r.isExcluded("Attachments/x/y/raw", "folder")).toBe(true);
    expect(r.isExcluded("Attachments/raw/file", "file")).toBe(true);
    expect(r.isExcluded("abc.md", "file")).toBe(true);
    expect(r.isExcluded("abbc.md", "file")).toBe(false);
    expect(r.isExcluded("report (1).md", "file")).toBe(true);
    expect(r.isExcluded("report 1.md", "file")).toBe(false);
    expect(r.isExcluded("v1.0+beta", "file")).toBe(true);
    expect(r.isExcluded("v1x0+beta", "file")).toBe(false);
  });

  it("restricts to include folders while keeping their ancestors traversable", () => {
    const r = rules([], ["Projects/NYRA", "Schule"]);
    expect(r.isExcluded("Projects/NYRA/a.md", "file")).toBe(false);
    expect(r.isExcluded("Schule/Mathe/b.md", "file")).toBe(false);
    expect(r.isExcluded("Projects", "folder")).toBe(false);
    expect(r.isExcluded("Projects", "file")).toBe(true);
    expect(r.isExcluded("Projects/Other/c.md", "file")).toBe(true);
    expect(r.isExcluded("Welcome.md", "file")).toBe(true);
    expect(r.isExcluded("Projects/NYRAX/c.md", "file")).toBe(true);
  });

  it("combines include folders and exclusions, and ignores unsafe entries", () => {
    const r = rules(["*.tmp"], ["Work", "../outside", "  "]);
    expect(r.isExcluded("Work/a.tmp", "file")).toBe(true);
    expect(r.isExcluded("Work/a.md", "file")).toBe(false);
    expect(r.isExcluded("outside/a.md", "file")).toBe(true);
  });

  it("ignores patterns with excessive wildcards, collapses repeated ones and answers from a cache", () => {
    const r = rules(["a/**/**/b"]);
    expect(rules(["**/a/**/b/**/c/**/d/**/e/x"]).isExcluded("a/b/c/d/e/x", "file")).toBe(false); // five separate ** make the first rule invalid
    expect(rules(["**/**/**/**/**/**/x"]).isExcluded("p/q/x", "file")).toBe(true); // repeated ** collapse to one
    expect(r.isExcluded("a/1/2/3/b", "file")).toBe(true);          // second collapsed to a/**/b
    const started = Date.now();
    const slow = rules(["**/**/**/**/needle"]);
    const longPath = `${"segment/".repeat(60)}haystack`;
    for (let i = 0; i < 2000; i += 1) slow.isExcluded(longPath, "file");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(slow.isExcluded(longPath, "file")).toBe(false);
  });

  it("is wired into the path policy for files and folders", () => {
    let current = rules(["Private/"], []);
    const policy = new LocalPathPolicy({ reservedRoots: [".trash"], userRules: () => current });
    expect(policy.isInScope("Private/a.md")).toBe(false);
    expect(policy.isFolderInScope("Private")).toBe(false);
    expect(policy.isIncluded("Public/a.md")).toBe(true);
    current = rules([], ["Public"]); // settings changes apply immediately
    expect(policy.isInScope("Private/a.md")).toBe(false);
    expect(policy.isFolderInScope("Public")).toBe(true);
    expect(policy.isInScope("Public/a.md")).toBe(true);
  });
});
