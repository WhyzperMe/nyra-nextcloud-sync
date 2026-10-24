import { canonicalVaultRelativePath } from "../state/durable/path";
import { NYRA_REMOTE_RUNTIME_ROOT } from "../remote/path";
import { UserScopeRules, type PathKind } from "./user-rules";

export interface VaultPathPolicyOptions {
  /** Roots that are never synchronized. */
  reservedRoots?: readonly string[];
  /** Exact files that remain device-local even when their parent tree is synced. */
  reservedFiles?: readonly string[];
  /** Vault configuration directory, normally obtained from Vault.configDir. */
  configDir?: string;
  /** Dynamic scope switch so settings changes do not require rebuilding watchers. */
  syncObsidianConfig?: () => boolean;
  /** User exclusion patterns and include-only folders; read on every check so settings apply immediately. */
  userRules?: () => UserScopeRules;
}

/**
 * Shared vault-relative inclusion policy used by both local and remote inventory.
 *
 * Intentionally keeps device-local workspace state and this plugin's own
 * runtime outside the sync set. New installations also default the entire Obsidian
 * config directory to device-local unless the user explicitly enables config sync.
 */
export class LocalPathPolicy {
  private readonly reservedRoots: string[];
  private readonly reservedRootSegments: string[][];
  private readonly reservedFileSegments: string[][];
  private readonly configDir: string | null;
  private readonly configDirSegments: string[] | null;
  private readonly syncObsidianConfig: () => boolean;
  private readonly userRules: () => UserScopeRules;
  /** Files this device cannot safely materialize in memory; dormant, never deleted or overwritten. */
  private oversizedLocal = new Set<string>();
  private oversizedRemote = new Set<string>();

  constructor(reservedRoots?: readonly string[]);
  constructor(options?: VaultPathPolicyOptions);
  constructor(input: readonly string[] | VaultPathPolicyOptions = [".trash"]) {
    const options: VaultPathPolicyOptions = Array.isArray(input)
      ? { reservedRoots: input as readonly string[] }
      : input as VaultPathPolicyOptions;
    const roots = new Set<string>([NYRA_REMOTE_RUNTIME_ROOT]);
    for (const candidate of options.reservedRoots ?? [".trash"]) {
      const normalized = normalizeCandidate(candidate);
      if (normalized) roots.add(normalized);
    }
    this.reservedRoots = [...roots].sort();
    this.reservedRootSegments = this.reservedRoots.map((root) => root.split("/"));

    const files = new Set<string>();
    for (const candidate of options.reservedFiles ?? []) {
      const normalized = normalizeCandidate(candidate);
      if (normalized) files.add(normalized);
    }
    this.reservedFileSegments = [...files].map((file) => file.split("/"));
    this.configDir = options.configDir ? normalizeCandidate(options.configDir) : null;
    this.configDirSegments = this.configDir?.split("/") ?? null;
    this.syncObsidianConfig = options.syncObsidianConfig ?? (() => true);
    this.userRules = options.userRules ?? (() => UserScopeRules.NONE);
  }

  /** Replaces the set of local files above this device's whole-file read limit (from a complete scan). */
  replaceLocalOversized(paths: Iterable<string>): void { this.oversizedLocal = new Set(paths); }
  /** Adds or removes one locally observed oversized file (from a targeted scan). */
  setLocalOversized(path: string, oversized: boolean): void { if (oversized) this.oversizedLocal.add(path); else this.oversizedLocal.delete(path); }
  /** Replaces the set of remote files above this device's whole-file read limit (from a complete scan). */
  replaceRemoteOversized(paths: Iterable<string>): void { this.oversizedRemote = new Set(paths); }

  /** Paths currently skipped on this device because they exceed its whole-file limit. */
  oversizedPaths(): { local: string[]; remote: string[] } {
    return { local: [...this.oversizedLocal].sort(), remote: [...this.oversizedRemote].sort() };
  }

  /**
   * Static scope only (reserved roots, config tree). Inventory listings use this so
   * oversized files are re-evaluated on every scan instead of staying excluded forever.
   */
  canonicalIncludedPath(input: string, kind: PathKind = "file"): string | null {
    const path = canonicalVaultRelativePath(input);
    // A remote root can itself contain nested vault directories. Reserved roots
    // therefore match at any segment depth, not only at the current vault root.
    const pathSegments = path.split("/");
    for (const fileSegments of this.reservedFileSegments) {
      if (endsWithPathAtAnyDepth(pathSegments, fileSegments)) return null;
    }
    for (const rootSegments of this.reservedRootSegments) {
      if (containsPathRoot(pathSegments, rootSegments)) return null;
    }
    if (this.configDirSegments && !this.syncObsidianConfig() && containsPathRoot(pathSegments, this.configDirSegments)) {
      return null;
    }
    if (this.userRules().isExcluded(path, kind)) return null;
    return path;
  }

  /** Whether the vault itself (reserved roots, config tree) allows this path, ignoring the user's own exclusions. */
  isInBaseScope(input: string): boolean {
    try {
      const path = canonicalVaultRelativePath(input);
      const segments = path.split("/");
      if (this.reservedFileSegments.some((file) => endsWithPathAtAnyDepth(segments, file))) return false;
      if (this.reservedRootSegments.some((root) => containsPathRoot(segments, root))) return false;
      return !(this.configDirSegments && !this.syncObsidianConfig() && containsPathRoot(segments, this.configDirSegments));
    } catch {
      return false;
    }
  }

  /** Static scope check for a file, independent of device-specific oversized files. */
  isInScope(input: string): boolean {
    try {
      return this.canonicalIncludedPath(input) !== null;
    } catch {
      return false;
    }
  }

  /** Static scope check for a folder: ancestors of include-only folders stay traversable. */
  isFolderInScope(input: string): boolean {
    try {
      return this.canonicalIncludedPath(input, "folder") !== null;
    } catch {
      return false;
    }
  }

  /** Full sync scope: static scope minus files too large for this device. */
  isIncluded(input: string): boolean {
    try {
      const path = this.canonicalIncludedPath(input);
      return path !== null && !this.oversizedLocal.has(path) && !this.oversizedRemote.has(path);
    } catch {
      return false;
    }
  }

  /** Returns whether a durable record path is currently part of the configured sync scope. */
  isRecordPathIncluded(input: string | null | undefined): boolean {
    return typeof input === "string" && input.length > 0 && this.isIncluded(input);
  }
}

function containsPathRoot(pathSegments: readonly string[], rootSegments: readonly string[]): boolean {
  for (let start = 0; start <= pathSegments.length - rootSegments.length; start += 1) {
    if (rootSegments.every((segment, offset) => pathSegments[start + offset] === segment)) return true;
  }
  return false;
}

function endsWithPathAtAnyDepth(pathSegments: readonly string[], targetSegments: readonly string[]): boolean {
  const start = pathSegments.length - targetSegments.length;
  return start >= 0 && targetSegments.every((segment, offset) => pathSegments[start + offset] === segment);
}

function normalizeCandidate(candidate: string): string | null {
  const trimmed = candidate.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  return canonicalVaultRelativePath(trimmed);
}
