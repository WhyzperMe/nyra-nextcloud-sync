/**
 * User-defined sync scope: gitignore-style exclusion patterns and an optional
 * list of folders that restricts sync to those subtrees.
 *
 * Pattern syntax (one per line, `#` starts a comment):
 *   `name`        any file or folder called `name` at any depth
 *   `*.tmp`       `*` matches within one path segment, `?` one character
 *   `a/b`         a path anchored at the vault root (any pattern containing `/`)
 *   `/name`       anchored at the vault root
 *   `dir/`        folders only (and therefore everything below them)
 *   `**`          any number of path segments, e.g. `Attachments/**` or `**\/cache`
 * Patterns never negate; a matching ancestor folder excludes everything below it.
 */
export type PathKind = "file" | "folder";

export interface UserScopeInput {
  excludePatterns: readonly string[];
  includeFolders: readonly string[];
  /** Exact vault paths (files or folders) the user unchecked in the file picker; no pattern syntax. */
  excludePaths?: readonly string[];
}

export class UserScopeRules {
  static readonly NONE = new UserScopeRules({ excludePatterns: [], includeFolders: [], excludePaths: [] });

  private readonly excludes: ExcludeRule[];
  private readonly includes: string[];
  private readonly excludedPaths: Set<string>;
  /** Verdicts are pure functions of (path, kind); a scan asks about the same paths repeatedly. */
  private readonly verdicts = new Map<string, boolean>();

  constructor(input: UserScopeInput) {
    this.excludes = input.excludePatterns.flatMap((line) => {
      const rule = compileExclude(line);
      return rule ? [rule] : [];
    });
    this.includes = input.includeFolders.flatMap((entry) => {
      const normalized = normalizeFolder(entry);
      return normalized ? [normalized] : [];
    });
    this.excludedPaths = new Set((input.excludePaths ?? []).flatMap((entry) => {
      const normalized = normalizeFolder(entry);
      return normalized ? [normalized] : [];
    }));
  }

  get isEmpty(): boolean { return this.excludes.length === 0 && this.includes.length === 0 && this.excludedPaths.size === 0; }

  /** Whether the path is outside the user's scope. `path` is vault-relative with `/` separators. */
  isExcluded(path: string, kind: PathKind): boolean {
    if (this.isEmpty) return false;
    const key = `${kind === "file" ? "f" : "d"}${path}`;
    const known = this.verdicts.get(key);
    if (known !== undefined) return known;
    const verdict = this.evaluate(path, kind);
    if (this.verdicts.size >= MAX_CACHED_VERDICTS) this.verdicts.clear();
    this.verdicts.set(key, verdict);
    return verdict;
  }

  private evaluate(path: string, kind: PathKind): boolean {
    if (this.includes.length > 0 && !this.insideIncludedFolder(path, kind)) return true;
    if (this.excludes.length === 0 && this.excludedPaths.size === 0) return false;
    const segments = path.split("/");
    for (let end = 1; end <= segments.length; end += 1) {
      const candidate = segments.slice(0, end).join("/");
      const isSelf = end === segments.length;
      const candidateIsFolder = !isSelf || kind === "folder";
      if (this.excludedPaths.has(candidate)) return true;
      for (const rule of this.excludes) {
        if (rule.directoriesOnly && !candidateIsFolder) continue;
        if (rule.regex.test(candidate)) return true;
      }
    }
    return false;
  }

  private insideIncludedFolder(path: string, kind: PathKind): boolean {
    for (const folder of this.includes) {
      if (path === folder || path.startsWith(`${folder}/`)) return true;
      // Folders above an included folder must stay traversable; files there are out of scope.
      if (kind === "folder" && folder.startsWith(`${path}/`)) return true;
    }
    return false;
  }
}

interface ExcludeRule { regex: RegExp; directoriesOnly: boolean }

const MAX_CACHED_VERDICTS = 100_000;
/** More wildcards than this make a pattern both meaningless and a backtracking risk; it is ignored. */
const MAX_DOUBLE_STARS = 4;
export const MAX_RULES = 200;
export const MAX_RULE_LENGTH = 300;

function compileExclude(line: string): ExcludeRule | null {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith("#") || pattern.length > MAX_RULE_LENGTH) return null;
  pattern = pattern.replace(/\\/g, "/");
  const directoriesOnly = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/, "");
  const anchored = pattern.startsWith("/") || pattern.includes("/");
  pattern = pattern.replace(/^\/+/, "").replace(/(?:\*\*\/)+/g, "**/");
  if (!pattern || (pattern.match(/\*\*/g)?.length ?? 0) > MAX_DOUBLE_STARS) return null;
  const body = globToRegexSource(pattern);
  return { regex: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`), directoriesOnly };
}

function globToRegexSource(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const followedBySlash = glob[index + 2] === "/";
        out += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** Canonical vault-relative path (no leading/trailing slash, no dot segments); null if unusable. */
export function normalizeFolder(entry: string): string | null {
  const parts = entry.replace(/\\/g, "/").split("/").map((part) => part.trim()).filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  return parts.join("/");
}
