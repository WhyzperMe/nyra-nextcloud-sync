import { NyraError } from "../core/errors";
import type { Logger } from "../diagnostics/logger";
import type { LocalPathPolicy } from "../local/path-policy";
import { mapConcurrent } from "../local/work-pool";
import type { DavPropertyResponse } from "./dav-xml";
import { DavDirectoryRequestError, type NextcloudDavClient } from "./dav-client";
import { appendWebdavPath, normalizeRemoteRootPath, NYRA_REMOTE_RUNTIME_ROOT, relativePathFromDavHref } from "./path";
import type { RemoteFullScanResult, RemoteInventoryEntry, RemoteScanIssue, RemoteScanMetrics, RemoteScanProgress } from "./types";

export interface RemoteScannerOptions {
  directoryConcurrency?: number;
  maxEntries?: number;
  maxDirectories?: number;
  /** Files larger than this cannot be safely materialized on this device and are skipped. */
  maxFileBytes?: number;
  pathPolicy?: LocalPathPolicy | undefined;
}

export class RemoteInventoryScanner {
  private readonly concurrency: number;
  private readonly maxEntries: number;
  private readonly maxDirectories: number;
  private maxFileBytes: number;
  private readonly pathPolicy: LocalPathPolicy | undefined;
  private scanProgress: RemoteScanProgress = { directoriesCompleted: 0, filesFound: 0 };

  constructor(
    private readonly client: NextcloudDavClient,
    private readonly webdavUserRoot: string,
    private readonly logger: Logger,
    options: RemoteScannerOptions = {}
  ) {
    this.concurrency = clampInteger(options.directoryConcurrency ?? 6, 1, 16);
    this.maxEntries = clampInteger(options.maxEntries ?? 250_000, 1_000, 1_000_000);
    this.maxDirectories = clampInteger(options.maxDirectories ?? 250_000, 1, 1_000_000);
    this.maxFileBytes = options.maxFileBytes ?? Number.MAX_SAFE_INTEGER;
    this.pathPolicy = options.pathPolicy;
  }

  setMaxFileBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("maxFileBytes must be a positive safe integer.");
    this.maxFileBytes = bytes;
  }

  progress(): RemoteScanProgress { return { ...this.scanProgress }; }

  async scanFull(remoteRootPath: string): Promise<RemoteFullScanResult> {
    const startedClock = monotonicNow();
    const startedAt = new Date().toISOString();
    this.scanProgress = { directoriesCompleted: 0, filesFound: 0 };
    const rootPath = normalizeRemoteRootPath(remoteRootPath);
    const scanRootUrl = appendWebdavPath(this.webdavUserRoot, rootPath);
    const files = new Map<string, RemoteInventoryEntry>();
    const fileIds = new Map<string, string>();
    const issues: RemoteScanIssue[] = [];
    const oversized: string[] = [];
    let rootEtag: string | null = null;
    const visitedDirectories = new Set<string>();
    let frontier = [""];
    const queuedDirectories = new Set<string>([""]);
    let complete = true;
    const metrics = emptyMetrics();
    let activeRequests = 0;
    let completedRequests = 0;
    let fileResponses = 0;

    while (frontier.length > 0 && complete) {
      const batch = frontier.splice(0, Math.max(this.concurrency * 8, 32));
      for (const directory of batch) queuedDirectories.delete(directory);
      const results = await mapConcurrent(batch, this.concurrency, async (relativeDirectory) => {
        const url = appendWebdavPath(scanRootUrl, relativeDirectory);
        const requestStarted = monotonicNow();
        activeRequests += 1;
        metrics.peakConcurrency = Math.max(metrics.peakConcurrency, activeRequests);
        try {
          const measured = this.client.listDirectoryMeasured
            ? await this.client.listDirectoryMeasured(url)
            : null;
          const responses = measured?.responses ?? await this.client.listDirectory(url);
          completedRequests += 1;
          fileResponses += responses.reduce((count, response) => count + Number(!response.isCollection), 0);
          this.scanProgress = { directoriesCompleted: completedRequests, filesFound: fileResponses };
          return {
            relativeDirectory,
            responses,
            measured: measured?.metrics ?? null,
            elapsedMs: elapsedSince(requestStarted),
            error: null as Error | null
          };
        } catch (error) {
          completedRequests += 1;
          this.scanProgress = { directoriesCompleted: completedRequests, filesFound: fileResponses };
          const measured = error instanceof DavDirectoryRequestError ? error.metrics : null;
          return {
            relativeDirectory,
            responses: [] as DavPropertyResponse[],
            measured,
            elapsedMs: elapsedSince(requestStarted),
            error: asError(error)
          };
        } finally {
          activeRequests -= 1;
        }
      });

      for (const result of results) {
        visitedDirectories.add(result.relativeDirectory);
        addMetrics(metrics, result.measured, result.elapsedMs, result.responses.length);
        if (result.error) {
          const rootMissing = result.relativeDirectory === "" && result.error instanceof NyraError && result.error.code === "webdav-not-found";
          issues.push({ path: result.relativeDirectory, code: rootMissing ? "root-missing" : "request-failed", message: result.error.message });
          complete = false;
          continue;
        }
        for (const response of result.responses) {
          let path: string | null;
          try { path = relativePathFromDavHref(scanRootUrl, response.href); }
          catch (error) {
            issues.push({ path: result.relativeDirectory, code: "invalid-path", message: asError(error).message });
            complete = false;
            continue;
          }
          if (path === null) {
            // The scan root's own ETag lets later polls detect "nothing changed" with one request.
            if (result.relativeDirectory === "" && response.isCollection) rootEtag = normalizeEtag(response.etag);
            continue; // directory itself
          }
          // The same scope policy applies to both replicas. In particular,
          // content-only mobile devices never download .obsidian config files, and
          // device-local workspace/plugin runtime paths cannot become remote writes.
          if (this.pathPolicy && !(response.isCollection ? this.pathPolicy.isFolderInScope(path) : this.pathPolicy.isInScope(path))) continue;
          // Staging/probes can exist at the user root, selected root or a nested
          // mount. Internal evidence must never enter a replica inventory.
          if (path.split("/").includes(NYRA_REMOTE_RUNTIME_ROOT)) continue;
          if (response.isCollection) {
            if (!visitedDirectories.has(path) && !queuedDirectories.has(path)) {
              if (visitedDirectories.size + queuedDirectories.size >= this.maxDirectories) {
                issues.push({ path, code: "directory-limit", message: `Remote inventory exceeded the safety limit of ${this.maxDirectories} directories.` });
                complete = false;
                continue;
              }
              frontier.push(path);
              queuedDirectories.add(path);
            }
            continue;
          }
          if (!isSafeFileId(response.fileId)) {
            issues.push({ path, code: "invalid-response", message: "Remote file is missing the required Nextcloud file ID." });
            complete = false;
            continue;
          }
          const existingPath = fileIds.get(response.fileId);
          if (existingPath && existingPath !== path) {
            issues.push({ path, code: "duplicate-file-id", message: `File ID ${response.fileId} also appeared at '${existingPath}'.` });
            complete = false;
            continue;
          }
          if (files.has(path)) {
            issues.push({ path, code: "duplicate-path", message: "Remote path appeared more than once in the inventory." });
            complete = false;
            continue;
          }
          const size = response.size;
          if (size === null) {
            issues.push({ path, code: "invalid-response", message: "Remote file is missing a valid size." });
            complete = false;
            continue;
          }
          if (size > this.maxFileBytes) {
            oversized.push(path);
            continue;
          }
          const etag = normalizeEtag(response.etag);
          if (response.etag !== null && etag === null) {
            issues.push({ path, code: "invalid-response", message: "Remote file returned a malformed or weak ETag; write preconditions cannot be trusted." });
            complete = false;
            continue;
          }
          const entry: RemoteInventoryEntry = {
            path,
            fileId: response.fileId,
            etag,
            size,
            mtimeMs: parseHttpDate(response.lastModified),
            contentType: response.contentType,
            checksums: [...response.checksums],
            sha256Hint: selectSha256(response.checksums)
          };
          files.set(path, entry);
          fileIds.set(response.fileId, path);
          if (files.size > this.maxEntries) {
            issues.push({ path, code: "entry-limit", message: `Remote inventory exceeded the safety limit of ${this.maxEntries} files.` });
            complete = false;
            break;
          }
        }
      }
    }

    const entries = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    metrics.elapsedMs = elapsedSince(startedClock);
    metrics.entriesPerSecond = metrics.elapsedMs > 0 ? entries.length * 1000 / metrics.elapsedMs : 0;
    this.logger.info("remote.scan-complete", { rootPath, files: entries.length, directories: visitedDirectories.size, complete, issues: issues.length });
    const fields = {
      kind: "full" as const,
      rootPath,
      entries,
      directories: [...visitedDirectories].filter((directory) => directory !== "").sort(),
      oversized: oversized.sort(),
      rootEtag,
      directoriesVisited: visitedDirectories.size,
      metrics,
      startedAt,
      finishedAt: new Date().toISOString()
    };
    if (complete) this.pathPolicy?.replaceRemoteOversized(oversized);
    return complete
      ? { ...fields, trust: "authoritative", complete: true, issues: [] }
      : { ...fields, trust: "incomplete", complete: false, issues };
  }
}

function selectSha256(checksums: readonly string[]): string | null {
  for (const checksum of checksums) {
    const match = /^sha256:([a-f0-9]{64})$/i.exec(checksum.trim());
    if (match?.[1]) return match[1].toLowerCase();
  }
  return null;
}
function normalizeEtag(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(trimmed) ? trimmed : null;
}
function isSafeFileId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function parseHttpDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value)) return min;
  return Math.max(min, Math.min(max, value));
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function emptyMetrics(): RemoteScanMetrics {
  return { requestCount: 0, responseBytes: 0, responseEntries: 0, networkDurationMs: 0, parseDurationMs: 0, elapsedMs: 0, entriesPerSecond: 0, peakConcurrency: 0, retryCount: 0 };
}

function addMetrics(metrics: RemoteScanMetrics, measured: {
  requestCount: number;
  responseBytes: number;
  networkDurationMs: number;
  parseDurationMs: number;
  retryCount: number;
} | null, fallbackElapsedMs: number, responseEntries: number): void {
  metrics.requestCount += measured?.requestCount ?? 1;
  metrics.responseBytes += measured?.responseBytes ?? 0;
  metrics.responseEntries += responseEntries;
  metrics.networkDurationMs += measured?.networkDurationMs ?? fallbackElapsedMs;
  metrics.parseDurationMs += measured?.parseDurationMs ?? 0;
  metrics.retryCount += measured?.retryCount ?? 0;
}

function monotonicNow(): number { return globalThis.performance?.now() ?? Date.now(); }
function elapsedSince(start: number): number { return Math.max(0, monotonicNow() - start); }
