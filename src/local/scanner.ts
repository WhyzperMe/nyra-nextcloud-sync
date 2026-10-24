import { sha256Hex } from "../state/durable/crypto";
import { canonicalVaultRelativePath } from "../state/durable/path";
import { ByteBudget } from "./byte-budget";
import { isWithinLocalReadBudget } from "./read-budget";
import { LocalPathPolicy } from "./path-policy";
import type { LocalFileSource } from "./source";
import type {
  LocalFileMetadata,
  LocalFileReadBlock,
  LocalFullScanResult,
  LocalInventoryEntry,
  LocalRenameHint,
  LocalScanIssue,
  LocalTargetedScanResult
} from "./types";
import { mapConcurrent } from "./work-pool";

export interface LocalScannerOptions {
  concurrency: number;
  maxInFlightBytes: number;
  /** Obsidian readBinary materializes the whole file in an ArrayBuffer. */
  maxFileBytes: number;
  stableReadAttempts: number;
  fullScanRounds: number;
  retryDelayMs: number;
}

const DEFAULT_OPTIONS: LocalScannerOptions = {
  concurrency: 4,
  maxInFlightBytes: 64 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  stableReadAttempts: 3,
  fullScanRounds: 2,
  retryDelayMs: 20
};

interface HashResult {
  entry: LocalInventoryEntry | null;
  issue: LocalScanIssue | null;
  oversized?: LocalFileReadBlock;
  hashedBytes: number;
}

export interface LocalFullScanOptions {
  /**
   * Reuse the hash of a file whose size and mtime are unchanged and that had been stable for
   * RACY_WINDOW_MS when it was last hashed (the same rule git uses for its index). Without this
   * flag every file is read and hashed again.
   */
  trustMetadata?: boolean;
}

/** A file modified within this window before it was hashed could still change without its mtime changing. */
const RACY_WINDOW_MS = 2_000;

interface CachedHash { size: number; mtimeMs: number; contentHash: string; hashedAt: number }

export class LocalInventoryScanner {
  private readonly hashCache = new Map<string, CachedHash>();
  private readonly options: LocalScannerOptions;
  private readonly budget: ByteBudget;

  constructor(
    private readonly source: LocalFileSource,
    private readonly policy: LocalPathPolicy,
    options: Partial<LocalScannerOptions> = {}
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    validateOptions(this.options);
    this.budget = new ByteBudget(this.options.maxInFlightBytes);
  }

  /** Lowers or restores the whole-file limit at runtime (user setting changes). */
  setMaxFileBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("maxFileBytes must be a positive safe integer.");
    this.options.maxFileBytes = bytes;
  }

  async scanFull(
    previousEntries: readonly LocalInventoryEntry[] = [],
    signal?: AbortSignal,
    scanOptions: LocalFullScanOptions = {}
  ): Promise<LocalFullScanResult> {
    let last: LocalFullScanResult | null = null;
    for (let round = 0; round < this.options.fullScanRounds; round += 1) {
      throwIfAborted(signal);
      last = await this.scanFullRound(previousEntries, signal, scanOptions.trustMetadata === true && round === 0);
      if (last.complete) {
        this.policy.replaceLocalOversized(last.oversized.map((block) => block.path));
        return last;
      }
      if (round + 1 < this.options.fullScanRounds) await delay(this.options.retryDelayMs, signal);
    }
    if (!last) throw new Error("Local full scan produced no result.");
    return last;
  }

  async scanPaths(paths: readonly string[], signal?: AbortSignal): Promise<LocalTargetedScanResult> {
    const startedAt = new Date().toISOString();
    const issues: LocalScanIssue[] = [];
    const requested = new Set<string>();

    for (const input of paths) {
      try {
        const canonical = canonicalVaultRelativePath(input);
        const included = this.policy.canonicalIncludedPath(canonical);
        if (included) requested.add(included);
      } catch (error) {
        issues.push({ path: String(input), code: "invalid-path", message: messageOf(error) });
      }
    }

    const requestedPaths = [...requested].sort();
    const results = await mapConcurrent(requestedPaths, this.options.concurrency, async (path) => {
      throwIfAborted(signal);
      let metadata: LocalFileMetadata | null;
      try {
        metadata = await this.source.stat(path);
      } catch (error) {
        return {
          path,
          hash: { entry: null, issue: issue(path, "stat-failed", error), hashedBytes: 0 },
          absent: false
        };
      }
      throwIfAborted(signal);
      if (metadata === null) {
        return { path, hash: null, absent: true };
      }
      const normalized = normalizeMetadata(metadata, path);
      if (normalized instanceof Error) {
        return {
          path,
          hash: { entry: null, issue: issue(path, "invalid-stat", normalized), hashedBytes: 0 },
          absent: false
        };
      }
      return { path, hash: await this.hashStable(normalized, signal), absent: false };
    });

    const observations: Record<string, LocalInventoryEntry | null> = Object.create(null);
    const oversized: LocalFileReadBlock[] = [];
    let hashedBytes = 0;
    for (const result of results) {
      if (result.absent) {
        this.policy.setLocalOversized(result.path, false);
        defineMapValue(observations, result.path, null);
        continue;
      }
      if (!result.hash) continue;
      hashedBytes += result.hash.hashedBytes;
      if (result.hash.oversized) {
        oversized.push(result.hash.oversized);
        this.policy.setLocalOversized(result.path, true);
        continue; // dormant on this device: neither present nor absent
      }
      if (result.hash.entry) this.policy.setLocalOversized(result.path, false);
      if (result.hash.issue) issues.push(result.hash.issue);
      if (result.hash.entry) defineMapValue(observations, result.path, result.hash.entry);
    }

    return {
      kind: "targeted",
      requestedPaths,
      observations,
      complete: issues.length === 0,
      issues,
      oversized,
      hashedBytes,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }

  private async scanFullRound(
    previousEntries: readonly LocalInventoryEntry[],
    signal: AbortSignal | undefined,
    trustMetadata: boolean
  ): Promise<LocalFullScanResult> {
    const startedAt = new Date().toISOString();
    const issues: LocalScanIssue[] = [];
    let firstListing: LocalFileMetadata[];
    try {
      firstListing = await this.source.listFiles();
    } catch (error) {
      return {
        kind: "full",
        entries: [],
        complete: false,
        issues: [issue("<vault>", "list-failed", error)],
        oversized: [],
        hashedBytes: 0,
        renameCandidates: [],
        startedAt,
        finishedAt: new Date().toISOString()
      };
    }
    throwIfAborted(signal);

    const normalized = normalizeListing(firstListing, this.policy, issues);
    const results = await mapConcurrent(normalized, this.options.concurrency, async (metadata) => {
      throwIfAborted(signal);
      const cached = trustMetadata ? this.cachedEntry(metadata) : null;
      return cached ?? await this.hashStable(metadata, signal);
    });

    const entries: LocalInventoryEntry[] = [];
    const oversized: LocalFileReadBlock[] = [];
    let hashedBytes = 0;
    for (const result of results) {
      hashedBytes += result.hashedBytes;
      if (result.issue) issues.push(result.issue);
      if (result.entry) entries.push(result.entry);
      if (result.oversized) oversized.push(result.oversized);
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const listed = new Set(normalized.map((item) => item.path));
    for (const path of this.hashCache.keys()) if (!listed.has(path)) this.hashCache.delete(path);

    let secondListing: LocalFileMetadata[] = [];
    let listingStable = false;
    try {
      secondListing = normalizeListing(await this.source.listFiles(), this.policy, issues);
      listingStable = inventoryMetadataMatches(normalized, secondListing);
      if (!listingStable) {
        issues.push({
          path: "<vault>",
          code: "concurrent-change",
          message: "Vault metadata changed while the full inventory was being hashed."
        });
      }
    } catch (error) {
      issues.push(issue("<vault>", "list-failed", error));
    }
    throwIfAborted(signal);

    const complete = issues.length === 0 && listingStable && entries.length + oversized.length === normalized.length;
    return {
      kind: "full",
      entries,
      complete,
      issues,
      oversized,
      hashedBytes,
      renameCandidates: findHeuristicRenameCandidates(previousEntries, entries),
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }

  private cachedEntry(metadata: LocalFileMetadata): HashResult | null {
    const cached = this.hashCache.get(metadata.path);
    if (!cached || cached.size !== metadata.size || cached.mtimeMs !== metadata.mtimeMs) return null;
    if (cached.hashedAt - cached.mtimeMs < RACY_WINDOW_MS) return null;
    return { entry: { ...metadata, contentHash: cached.contentHash }, issue: null, hashedBytes: 0 };
  }

  private async hashStable(metadata: LocalFileMetadata, signal?: AbortSignal): Promise<HashResult> {
    let lastMessage = "File changed while it was being read.";
    for (let attempt = 0; attempt < this.options.stableReadAttempts; attempt += 1) {
      throwIfAborted(signal);
      let before: LocalFileMetadata | null;
      try {
        before = await this.source.stat(metadata.path);
      } catch (error) {
        lastMessage = messageOf(error);
        if (attempt + 1 < this.options.stableReadAttempts) {
          await delay(this.options.retryDelayMs, signal);
          continue;
        }
        return { entry: null, issue: { path: metadata.path, code: "stat-failed", message: lastMessage }, hashedBytes: 0 };
      }
      if (before === null) {
        return {
          entry: null,
          issue: { path: metadata.path, code: "concurrent-change", message: "File disappeared before it could be hashed." },
          hashedBytes: 0
        };
      }
      const validBefore = normalizeMetadata(before, metadata.path);
      if (validBefore instanceof Error) {
        return { entry: null, issue: issue(metadata.path, "invalid-stat", validBefore), hashedBytes: 0 };
      }
      if (!isWithinLocalReadBudget(validBefore.size, this.options.maxFileBytes)) {
        return {
          entry: null,
          issue: null,
          oversized: {
            path: metadata.path,
            reasonCode: "LOCAL_FILE_TOO_LARGE_FOR_SAFE_PLATFORM_READ",
            actualSizeBytes: validBefore.size,
            maxSafeReadBytes: this.options.maxFileBytes
          },
          hashedBytes: 0
        };
      }

      const release = await this.budget.acquire(validBefore.size);
      let bytes: ArrayBuffer;
      try {
        throwIfAborted(signal);
        bytes = await this.source.readBinary(metadata.path);
      } catch (error) {
        release();
        lastMessage = messageOf(error);
        if (attempt + 1 < this.options.stableReadAttempts) {
          await delay(this.options.retryDelayMs, signal);
          continue;
        }
        return { entry: null, issue: { path: metadata.path, code: "read-failed", message: lastMessage }, hashedBytes: 0 };
      }

      try {
        throwIfAborted(signal);
        let after: LocalFileMetadata | null;
        try {
          after = await this.source.stat(metadata.path);
        } catch (error) {
          lastMessage = messageOf(error);
          if (attempt + 1 < this.options.stableReadAttempts) {
            await delay(this.options.retryDelayMs, signal);
            continue;
          }
          return { entry: null, issue: { path: metadata.path, code: "stat-failed", message: lastMessage }, hashedBytes: 0 };
        }
        if (after === null) {
          lastMessage = "File disappeared while it was being read.";
        } else {
          const validAfter = normalizeMetadata(after, metadata.path);
          if (validAfter instanceof Error) {
            return { entry: null, issue: issue(metadata.path, "invalid-stat", validAfter), hashedBytes: 0 };
          }
          if (
            sameMetadata(validBefore, validAfter) &&
            bytes.byteLength === validAfter.size
          ) {
            const contentHash = await sha256Hex(bytes);
            throwIfAborted(signal);
            this.hashCache.set(validAfter.path, { size: validAfter.size, mtimeMs: validAfter.mtimeMs, contentHash, hashedAt: Date.now() });
            return {
              entry: { ...validAfter, contentHash },
              issue: null,
              hashedBytes: bytes.byteLength
            };
          }
          lastMessage = "File metadata changed while its content was being read.";
        }
      } finally {
        release();
      }

      if (attempt + 1 < this.options.stableReadAttempts) await delay(this.options.retryDelayMs, signal);
    }

    return {
      entry: null,
      issue: { path: metadata.path, code: "concurrent-change", message: lastMessage },
      hashedBytes: 0
    };
  }
}

function normalizeListing(
  listing: readonly LocalFileMetadata[],
  policy: LocalPathPolicy,
  issues: LocalScanIssue[]
): LocalFileMetadata[] {
  const output = new Map<string, LocalFileMetadata>();
  for (const raw of listing) {
    let path: string;
    try {
      const included = policy.canonicalIncludedPath(raw.path);
      if (included === null) continue;
      path = included;
    } catch (error) {
      issues.push(issue(String(raw.path), "invalid-path", error));
      continue;
    }
    const valid = normalizeMetadata(raw, path);
    if (valid instanceof Error) {
      issues.push(issue(path, "invalid-stat", valid));
      continue;
    }
    if (output.has(path)) {
      issues.push({ path, code: "invalid-stat", message: "Vault listing returned the same canonical file path more than once." });
      continue;
    }
    output.set(path, valid);
  }
  return [...output.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeMetadata(value: LocalFileMetadata, expectedPath: string): LocalFileMetadata | Error {
  let path: string;
  try {
    path = canonicalVaultRelativePath(value.path);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  if (path !== expectedPath) return new Error(`Stat path mismatch: expected '${expectedPath}', got '${path}'.`);
  if (!Number.isSafeInteger(value.size) || value.size < 0) return new Error("File size must be a non-negative safe integer.");
  if (!Number.isFinite(value.mtimeMs) || value.mtimeMs < 0) return new Error("File mtime must be a non-negative finite number.");
  if (!Number.isFinite(value.ctimeMs) || value.ctimeMs < 0) return new Error("File ctime must be a non-negative finite number.");
  return { path, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

export function inventoryMetadataMatches(
  left: readonly LocalFileMetadata[],
  right: readonly LocalFileMetadata[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b || !sameMetadata(a, b)) return false;
  }
  return true;
}

function sameMetadata(left: LocalFileMetadata, right: LocalFileMetadata): boolean {
  return left.path === right.path && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function findHeuristicRenameCandidates(
  previous: readonly LocalInventoryEntry[],
  current: readonly LocalInventoryEntry[]
): LocalRenameHint[] {
  const currentPaths = new Set(current.map((entry) => entry.path));
  const previousPaths = new Set(previous.map((entry) => entry.path));
  const removed = previous.filter((entry) => !currentPaths.has(entry.path));
  const added = current.filter((entry) => !previousPaths.has(entry.path));
  const key = (entry: LocalInventoryEntry) => `${entry.contentHash}:${entry.size}`;
  const removedByKey = groupUnique(removed, key);
  const addedByKey = groupUnique(added, key);
  const hints: LocalRenameHint[] = [];
  for (const [fingerprint, oldEntry] of removedByKey) {
    const newEntry = addedByKey.get(fingerprint);
    if (!oldEntry || !newEntry) continue;
    hints.push({
      oldPath: oldEntry.path,
      newPath: newEntry.path,
      kind: "file",
      source: "heuristic",
      confidence: "heuristic"
    });
  }
  return hints.sort((a, b) => a.oldPath.localeCompare(b.oldPath));
}

function groupUnique(
  values: readonly LocalInventoryEntry[],
  key: (entry: LocalInventoryEntry) => string
): Map<string, LocalInventoryEntry | null> {
  const result = new Map<string, LocalInventoryEntry | null>();
  for (const value of values) {
    const fingerprint = key(value);
    if (result.has(fingerprint)) result.set(fingerprint, null);
    else result.set(fingerprint, value);
  }
  return result;
}

function defineMapValue<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function issue(path: string, code: LocalScanIssue["code"], error: unknown): LocalScanIssue {
  return { path, code, message: messageOf(error) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateOptions(options: LocalScannerOptions): void {
  for (const [name, value] of [
    ["concurrency", options.concurrency],
    ["maxInFlightBytes", options.maxInFlightBytes],
    ["maxFileBytes", options.maxFileBytes],
    ["stableReadAttempts", options.stableReadAttempts],
    ["fullScanRounds", options.fullScanRounds],
    ["retryDelayMs", options.retryDelayMs]
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Local inventory scan aborted.", "AbortError");
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      cleanup();
      reject(new DOMException("Local inventory scan aborted.", "AbortError"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
