import { NyraError } from "../core/errors";
import type { NextcloudCredentials } from "../core/types";
import type { Logger } from "../diagnostics/logger";
import { isInjectedIfNoneMatch, withCacheBuster } from "../network/cache-buster";
import type { HttpRequest, HttpResponse, HttpTransport } from "../network/http-client";
import { nextcloudEndpoints } from "../nextcloud/endpoints";
import { parseDavMultistatus } from "../remote/dav-xml";
import { appendWebdavPath, normalizeRemoteRootPath, NYRA_REMOTE_RUNTIME_ROOT } from "../remote/path";
import type { RemoteReplicaState } from "../state/durable/model";
import { sha256Hex } from "../state/durable/crypto";
import { randomId } from "../state/durable/ids";
import { basicAuthorization } from "../security/base64";
import { assertSameOrigin } from "../security/url-policy";
import { chunkBounds, nextcloudChunkName } from "../transfer/chunking";
import { IncrementalSha256 } from "../transfer/incremental-sha256";
import { makeTransferOperationKey, TransferJournalStore } from "../transfer/journal";
import type { TransferJournalPayload, TransferJournalRecord, TransferRecoveryReport, TransferTuning } from "../transfer/types";
import type { PreparedLocalSnapshot } from "./local-mutator";

const PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>\n<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:getlastmodified/><d:getetag/><d:getcontentlength/><d:resourcetype/><oc:fileid/><oc:size/><oc:checksums/></d:prop></d:propfind>`;
const RETRYABLE = new Set([408, 423, 425, 429, 500, 502, 503, 504]);
const INTERNAL_RUNTIME_ROOT = NYRA_REMOTE_RUNTIME_ROOT;
const TRANSFER_IO_TIMEOUT_MS = 120_000;

export interface RemoteDownloadResult {
  bytes: ArrayBuffer;
  contentHash: string;
  remote: RemoteReplicaState;
}

export interface RemoteStreamResult {
  contentHash: string;
  remote: RemoteReplicaState;
  bytesTransferred: number;
  ranged: boolean;
}

export interface RemoteDownloadStream {
  chunks: AsyncIterable<ArrayBuffer>;
  completed: Promise<RemoteStreamResult>;
}

export type TransferProgressCallback = (transferredBytes: number, totalBytes: number) => void;

export interface RemoteTransferResult {
  contentHash: string;
  remote: RemoteReplicaState;
  chunked: boolean;
  resumed: boolean;
}

export interface RemoteMutatorOptions {
  serverUrl: string;
  userId: string;
  webdavUserRoot: string;
  tuning: TransferTuning;
  journal: TransferJournalStore;
  maxAttempts?: number;
  /** Testability hook; production defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Testability hook for retry jitter; production defaults to Math.random. */
  random?: () => number;
}

export class RemoteTransactionalMutator {
  private readonly authorization: string;
  private readonly uploadsRoot: string;
  private readonly maxAttempts: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;

  constructor(
    private readonly http: HttpTransport,
    credentials: NextcloudCredentials,
    private readonly logger: Logger,
    private readonly options: RemoteMutatorOptions
  ) {
    this.authorization = basicAuthorization(credentials.loginName, credentials.appPassword);
    this.uploadsRoot = nextcloudEndpoints.webdavUploadsRoot(options.serverUrl, options.userId);
    this.maxAttempts = options.maxAttempts ?? 4;
    this.sleepFn = options.sleep ?? sleep;
    this.randomFn = options.random ?? Math.random;
  }

  /**
   * Probe the server's real conditional-write behavior on a unique internal
   * file before mutating user notes. Some storage backends reuse an ETag for
   * rapid writes, making an apparently guarded stale PUT destructive.
   */
  async verifyConditionalWrites(syncRootPath = ""): Promise<void> {
    const rootPath = normalizeRemoteRootPath(syncRootPath);
    // Transfer staging and the selected folder may reside on different storage mounts.
    await this.verifyConditionalWritesAtRoot("");
    if (rootPath) await this.verifyConditionalWritesAtRoot(rootPath);
  }

  private async verifyConditionalWritesAtRoot(rootPath: string): Promise<void> {
    const runtimePath = rootPath ? `${rootPath}/${INTERNAL_RUNTIME_ROOT}` : INTERNAL_RUNTIME_ROOT;
    await this.ensureDirectoryPath(this.options.webdavUserRoot, runtimePath);
    await this.sweepStaleProbes(runtimePath);
    const probePath = `${runtimePath}/${randomId("etag-probe")}.txt`;
    const probeUrl = appendWebdavPath(this.options.webdavUserRoot, probePath);
    // Probe names are plain ASCII on purpose: the checks are about preconditions, not file names
    // (those are covered by the path-policy tests), and special characters only upset other
    // sync clients that watch the same folder.
    const movedPath = `${runtimePath}/${randomId("etag-probe-moved")}.txt`;
    const movedUrl = appendWebdavPath(this.options.webdavUserRoot, movedPath);
    const first = new TextEncoder().encode("nyra-conditional-probe-1\n");
    const forbidden = new TextEncoder().encode("nyra-conditional-probe-forbidden\n");
    // Real uploads preserve the source mtime. Hold it fixed across changed probe
    // bodies, which also exercises rapid-edit safety on a slow DAV connection.
    const probeMtimeMs = Date.now();
    const probeMtime = mtimeHeader(probeMtimeMs);
    const ownBodies: Uint8Array[] = [first, forbidden];
    let initialFileId: string | null = null;
    let failure: unknown = null;
    try {
      if (await this.statMaybe(probeUrl, probePath) || await this.statMaybe(movedUrl, movedPath)) throw new Error("Generated conditional-write probe path is occupied.");
      const created = await this.requestWithRetry({ url: probeUrl, method: "PUT", headers: this.headers({ "If-None-Match": "*", ...probeMtime }), body: first.buffer }, false);
      this.assertSuccess(created, [201], "create conditional-write probe");
      const initial = await this.stat(probeUrl, probePath);
      initialFileId = initial.fileId;
      if (!initial.etag) throw new NyraError("remote-precondition-unreliable", "Nextcloud did not provide an ETag for conditional-write verification.");
      const duplicate = await this.requestWithRetry({ url: probeUrl, method: "PUT", headers: this.headers({ "If-None-Match": "*", ...probeMtime }), body: forbidden.buffer }, false);
      if (duplicate.status !== 412) throw new NyraError("remote-precondition-unreliable", "Nextcloud did not reject a duplicate create-only PUT; remote writes are paused.");
      let previous = initial;
      let finalBody = first;
      let rejectedEtag = initial.etag;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const body = new TextEncoder().encode(`nyra-conditional-probe-${attempt + 2}\n`);
        ownBodies.push(body);
        const updated = await this.requestWithRetry({ url: probeUrl, method: "PUT", headers: this.headers({ "If-Match": previous.etag!, ...mtimeHeader(distinctUploadMtimeMs(probeMtimeMs, previous.mtimeMs)) }), body: body.buffer }, false);
        this.assertSuccess(updated, [200, 204], "update conditional-write probe");
        const after = await this.stat(probeUrl, probePath);
        if (after.fileId !== initialFileId || !after.etag || after.etag === previous.etag) {
          const reason = after.fileId !== initialFileId ? "file id changed" : !after.etag ? "no ETag returned" : "ETag unchanged";
          const detail = `${reason}; update ${attempt + 1} at ${rootPath || "account root"}; etag ${previous.etag} -> ${after.etag ?? "none"}; file id ${initialFileId ?? "none"} -> ${after.fileId ?? "none"}`;
          throw new NyraError("remote-precondition-unreliable", `Nextcloud did not advance the ETag after an immediate update; remote writes are paused to avoid overwriting concurrent edits. (${detail})`);
        }
        const stale = await this.requestWithRetry({ url: probeUrl, method: "PUT", headers: this.headers({ "If-Match": previous.etag!, ...probeMtime }), body: forbidden.buffer }, false);
        if (stale.status !== 412) throw new NyraError("remote-precondition-unreliable", "Nextcloud accepted a stale If-Match PUT; remote writes are paused to avoid overwriting concurrent edits.");
        rejectedEtag = previous.etag!;
        previous = after;
        finalBody = body;
      }
      const verified = await this.verifyRemoteContent(probeUrl, probePath, initialFileId, previous.etag);
      if (verified.contentHash !== await sha256Hex(finalBody)) throw new Error("Nextcloud conditional-write probe content changed unexpectedly.");
      const staleDelete = await this.requestWithRetry({ url: probeUrl, method: "DELETE", headers: this.headers({ "If-Match": rejectedEtag }) }, false);
      if (staleDelete.status !== 412) throw new NyraError("remote-precondition-unreliable", "Nextcloud accepted a stale If-Match DELETE; remote writes are paused to protect concurrent edits.");
      const staleMove = await this.requestWithRetry({ url: probeUrl, method: "MOVE", headers: this.headers({ Destination: movedUrl, Overwrite: "F", "If-Match": rejectedEtag }) }, false);
      if (staleMove.status !== 412) throw new NyraError("remote-precondition-unreliable", "Nextcloud accepted a stale If-Match MOVE; remote writes are paused to protect concurrent edits.");
      await this.moveProbeFile(probeUrl, probePath, movedUrl, movedPath, initialFileId, previous.etag!);
      const afterMove = await this.verifyRemoteContent(movedUrl, movedPath, initialFileId, null);
      if (afterMove.contentHash !== verified.contentHash || await this.statMaybe(probeUrl, probePath)) {
        throw new NyraError("remote-precondition-unreliable", "Nextcloud did not preserve identity and content during a guarded MOVE; remote writes are paused.");
      }
    } catch (error) {
      failure = error;
    } finally {
      for (const location of [{ url: probeUrl, path: probePath }, { url: movedUrl, path: movedPath }]) {
        const current = await this.statMaybe(location.url, location.path).catch(() => null);
        if (current && initialFileId && current.fileId === initialFileId) {
          try {
            if (current.size > 1024) throw new Error("Conditional-write probe grew unexpectedly; preserving it for review.");
            if (!current.etag) throw new Error("Conditional-write probe has no ETag; preserving it for review.");
            const reply = await this.requestWithRetry({ url: location.url, method: "GET", headers: this.headers({ "If-Match": current.etag }) });
            this.assertSuccess(reply, [200], "read conditional-write probe for cleanup");
            const contentHash = await sha256Hex(reply.arrayBuffer);
            const ownHashes = await Promise.all(ownBodies.map((bytes) => sha256Hex(bytes)));
            if (!ownHashes.includes(contentHash)) throw new Error("Conditional-write probe was changed by another client; preserving it for review.");
            const removed = await this.requestWithRetry({ url: location.url, method: "DELETE", headers: this.headers({ "If-Match": current.etag }) }, false);
            this.assertSuccess(removed, [204, 404], "remove conditional-write probe");
          } catch (cleanupError) {
            if (failure === null) failure = cleanupError;
            this.logger.warn("remote.conditional-probe-cleanup-deferred", { error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
          }
        }
      }
    }
    if (failure !== null) throw failure;
  }

  async hasCriticalRecovery(): Promise<boolean> {
    return (await this.options.journal.listLatest()).some((record) => record.phase !== "complete" && requiresCriticalRecovery(record));
  }

  async recoverIncompleteTransfers(): Promise<TransferRecoveryReport> {
    const records = (await this.options.journal.listLatest()).filter((record) => record.phase !== "complete");
    const report: TransferRecoveryReport = { inspected: records.length, recovered: 0, remoteChanged: false, messages: [] };
    for (const record of records) {
      // Upload/session phases are intentionally left intact: they are safe to resume
      // from the immutable source snapshot on the next matching execution. Only a
      // journal that may have crossed the user-visible target swap boundary needs
      // startup reconciliation before any new plan can run.
      if (!requiresCriticalRecovery(record)) {
        report.messages.push(`${record.kind}:${record.targetPath}:resumable-pending`);
        continue;
      }
      const changed = await this.recoverRecord(record);
      report.recovered += 1;
      report.remoteChanged ||= changed;
      report.messages.push(`${record.kind}:${record.targetPath}:${changed ? "remote-restored-or-committed" : "internal-cleanup"}`);
    }
    return report;
  }

  async openDownload(url: string, path: string, expectedFileId: string | null, expectedEtag: string | null, onProgress?: TransferProgressCallback): Promise<RemoteDownloadStream> {
    const before = await this.stat(url, path);
    this.assertIdentity(before, expectedFileId, expectedEtag, path);
    if (!before.etag) throw new Error(`Remote download for '${path}' requires an ETag to fence ranged reads.`);

    let resolve!: (value: RemoteStreamResult) => void;
    let reject!: (reason: unknown) => void;
    const completed = new Promise<RemoteStreamResult>((res, rej) => { resolve = res; reject = rej; });
    // A consumer can fail while iterating `chunks` before it reaches an explicit
    // await of `completed`. Attach a no-op rejection observer so that the paired
    // completion promise never becomes an unhandled rejection; callers that do
    // await `completed` still receive the original rejection.
    void completed.catch(() => undefined);
    const chunks = this.downloadGenerator(url, path, before, resolve, reject, onProgress);
    return { chunks, completed };
  }

  async download(url: string, path: string, expectedFileId: string | null, expectedEtag: string | null): Promise<RemoteDownloadResult> {
    const stream = await this.openDownload(url, path, expectedFileId, expectedEtag);
    const pieces: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream.chunks) {
      total += chunk.byteLength;
      if (total > this.options.tuning.maxWholeDownloadBytes) {
        throw new Error(`Refusing to materialize '${path}' as one buffer above the configured ${this.options.tuning.maxWholeDownloadBytes}-byte limit. Use the streaming download path.`);
      }
      pieces.push(new Uint8Array(chunk));
    }
    const result = await stream.completed;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
    return { bytes: bytes.buffer, contentHash: result.contentHash, remote: result.remote };
  }

  async verifyRemoteContent(url: string, path: string, expectedFileId: string | null, expectedEtag: string | null, onProgress?: TransferProgressCallback): Promise<RemoteStreamResult> {
    const stream = await this.openDownload(url, path, expectedFileId, expectedEtag, onProgress);
    for await (const _chunk of stream.chunks) { /* hash-only consumption */ }
    return await stream.completed;
  }

  async ensureParentDirectories(rootUrl: string, targetPath: string): Promise<void> {
    const segments = targetPath.split("/").filter(Boolean);
    if (segments.length <= 1) return;
    await this.ensureDirectoryPath(rootUrl, segments.slice(0, -1).join("/"));
  }

  /**
   * Creates a directory path component-by-component and verifies every collection.
   * Used by the explicit publish workflow so a PC can safely create a new
   * Nextcloud vault root without making ordinary inventory scans mutating.
   */
  async ensureDirectoryPath(rootUrl: string, directoryPath: string): Promise<void> {
    const segments = directoryPath.split("/").filter(Boolean);
    if (segments.length === 0) return;
    let current = ensureTrailingSlash(rootUrl);
    for (const segment of segments) {
      current = `${ensureTrailingSlash(current)}${encodeURIComponent(segment)}/`;
      const probe = await this.requestWithRetry({
        url: current, method: "PROPFIND", contentType: "application/xml; charset=utf-8",
        headers: this.headers({ Depth: "0", Accept: "application/xml, text/xml;q=0.9" }), body: PROPFIND_BODY
      });
      if (probe.status === 207) {
        const row = parseDavMultistatus(probe.text)[0];
        if (!row?.isCollection) throw new Error(`Remote path '${directoryPath}' contains a non-directory component '${segment}'.`);
        continue;
      }
      if (probe.status !== 404) this.assertSuccess(probe, [207, 404], `probe directory '${segment}'`);
      try {
        const created = await this.requestWithRetry({ url: current, method: "MKCOL", headers: this.headers({ "If-None-Match": "*" }) }, false);
        if (![201, 405].includes(created.status)) this.assertSuccess(created, [201, 405], `create directory '${segment}'`);
      } catch (error) {
        // MKCOL can succeed server-side and lose its response. Reconcile the
        // observable collection state before deciding the publish setup failed.
        const afterAmbiguous = await this.requestWithRetry({
          url: current, method: "PROPFIND", contentType: "application/xml; charset=utf-8",
          headers: this.headers({ Depth: "0", Accept: "application/xml, text/xml;q=0.9" }), body: PROPFIND_BODY
        }).catch(() => null);
        if (!afterAmbiguous || afterAmbiguous.status !== 207 || !parseDavMultistatus(afterAmbiguous.text)[0]?.isCollection) throw error;
        this.logger.warn("apply.remote-mkcol-ambiguous-commit-reconciled", { directoryPath, segment });
      }
      const verify = await this.requestWithRetry({
        url: current, method: "PROPFIND", contentType: "application/xml; charset=utf-8",
        headers: this.headers({ Depth: "0", Accept: "application/xml, text/xml;q=0.9" }), body: PROPFIND_BODY
      });
      this.assertSuccess(verify, [207], `verify directory '${segment}'`);
      const row = parseDavMultistatus(verify.text)[0];
      if (!row?.isCollection) throw new Error(`Remote directory '${directoryPath}' could not be verified.`);
    }
  }

  /**
   * Deletes a collection only when a fresh Depth-1 listing shows no children.
   * WebDAV has no non-recursive rmdir, so this narrow check is the guard: a
   * child that appears in the milliseconds before the DELETE is recoverable from
   * the Nextcloud trash bin. Collection ETags are not used as a precondition
   * because Nextcloud propagates them from children and some storage backends
   * restamp them after the listing.
   */
  async removeEmptyDirectory(url: string, path: string): Promise<boolean> {
    const collectionUrl = ensureTrailingSlash(url);
    const listing = await this.requestWithRetry({
      url: collectionUrl, method: "PROPFIND", contentType: "application/xml; charset=utf-8",
      headers: this.headers({ Depth: "1", Accept: "application/xml, text/xml;q=0.9" }), body: PROPFIND_BODY
    });
    if (listing.status === 404) return true;
    this.assertSuccess(listing, [207], `list directory '${path}'`);
    const rows = parseDavMultistatus(listing.text);
    if (!rows[0]?.isCollection) throw new Error(`Remote path '${path}' is not a directory.`);
    if (rows.length > 1) return false;
    const response = await this.requestWithRetry({ url: collectionUrl, method: "DELETE", headers: this.headers() }, false);
    this.assertSuccess(response, [204, 404], `delete directory '${path}'`);
    return true;
  }

  async uploadCreateFromSnapshot(url: string, path: string, snapshot: PreparedLocalSnapshot, onProgress?: TransferProgressCallback): Promise<RemoteTransferResult> {
    if (snapshot.size < this.options.tuning.chunkUploadThresholdBytes && snapshot.chunkCount === 1) {
      const bytes = await snapshot.readChunk(0);
      await snapshot.assertSourceUnchanged();
      const result = await this.uploadCreate(url, path, bytes, snapshot.mtimeMs, onProgress);
      return { contentHash: result.contentHash, remote: result.remote, chunked: false, resumed: false };
    }
    return await this.uploadChunked("chunked-create", url, path, snapshot, null, null, onProgress);
  }

  async uploadUpdateFromSnapshot(
    url: string,
    path: string,
    snapshot: PreparedLocalSnapshot,
    expectedFileId: string | null,
    expectedEtag: string | null,
    onProgress?: TransferProgressCallback
  ): Promise<RemoteTransferResult> {
    if (snapshot.size < this.options.tuning.chunkUploadThresholdBytes && snapshot.chunkCount === 1) {
      const bytes = await snapshot.readChunk(0);
      await snapshot.assertSourceUnchanged();
      const result = await this.uploadUpdate(url, path, bytes, expectedFileId, expectedEtag, snapshot.mtimeMs, onProgress);
      return { contentHash: result.contentHash, remote: result.remote, chunked: false, resumed: false };
    }
    return await this.uploadChunked("chunked-update", url, path, snapshot, expectedFileId, expectedEtag, onProgress);
  }

  async uploadCreate(url: string, path: string, bytes: ArrayBuffer, mtimeMs: number | null = null, onProgress?: TransferProgressCallback): Promise<RemoteDownloadResult> {
    const expectedHash = await sha256Hex(bytes);
    try {
      const response = await this.requestWithRetry({
        url, method: "PUT", headers: this.headers({ "If-None-Match": "*", "Content-Type": "application/octet-stream", "X-Hash": "sha256", ...mtimeHeader(mtimeMs) }), body: bytes
      }, false);
      if (response.status === 412) throw new NyraError("sync-precondition-changed", `Remote create precondition failed: '${path}' already exists.`);
      this.assertSuccess(response, [201, 204], `create '${path}'`);
    } catch (error) {
      const reconciled = await this.reconcileAmbiguousPut(url, path, bytes.byteLength, expectedHash, null, null).catch(() => null);
      if (reconciled) {
        onProgress?.(bytes.byteLength, bytes.byteLength);
        this.logger.warn("apply.remote-create-ambiguous-commit-reconciled", { path, fileId: reconciled.remote.fileId });
        return reconciled;
      }
      throw error;
    }
    onProgress?.(bytes.byteLength, bytes.byteLength);
    return await this.verifyDirectWrite(url, path, bytes.byteLength, expectedHash, null);
  }

  async uploadUpdate(url: string, path: string, bytes: ArrayBuffer, expectedFileId: string | null, expectedEtag: string | null, mtimeMs: number | null = null, onProgress?: TransferProgressCallback): Promise<RemoteDownloadResult> {
    if (!expectedEtag) throw new Error(`Remote update for '${path}' requires a fresh ETag.`);
    const before = await this.stat(url, path);
    this.assertIdentity(before, expectedFileId, expectedEtag, path);
    const expectedHash = await sha256Hex(bytes);
    try {
      const response = await this.requestWithRetry({
        url, method: "PUT", headers: this.headers({ "If-Match": expectedEtag, "Content-Type": "application/octet-stream", "X-Hash": "sha256", ...mtimeHeader(distinctUploadMtimeMs(mtimeMs, before.mtimeMs)) }), body: bytes
      }, false);
      if (response.status === 412) throw new NyraError("sync-precondition-changed", `Remote update precondition failed for '${path}': ETag changed.`);
      this.assertSuccess(response, [200, 201, 204], `update '${path}'`);
    } catch (error) {
      const reconciled = await this.reconcileAmbiguousPut(url, path, bytes.byteLength, expectedHash, expectedFileId, expectedEtag).catch(() => null);
      if (reconciled) {
        onProgress?.(bytes.byteLength, bytes.byteLength);
        this.logger.warn("apply.remote-update-ambiguous-commit-reconciled", { path, fileId: reconciled.remote.fileId });
        return reconciled;
      }
      throw error;
    }
    onProgress?.(bytes.byteLength, bytes.byteLength);
    const verified = await this.verifyDirectWrite(url, path, bytes.byteLength, expectedHash, expectedFileId);
    if (verified.remote.etag === expectedEtag) throw new NyraError("remote-precondition-unreliable", `Nextcloud kept the old ETag after updating '${path}'; BASE advancement is blocked.`);
    return verified;
  }

  async move(sourceUrl: string, sourcePath: string, targetUrl: string, targetPath: string, expectedFileId: string | null, expectedEtag: string | null): Promise<RemoteReplicaState> {
    if (!expectedEtag) throw new Error(`Remote move for '${sourcePath}' requires a fresh ETag.`);
    const before = await this.stat(sourceUrl, sourcePath);
    this.assertIdentity(before, expectedFileId, expectedEtag, sourcePath);
    const headers: Record<string, string> = { Destination: targetUrl, Overwrite: "F" };
    if (expectedEtag) headers["If-Match"] = expectedEtag;
    try {
      const response = await this.requestWithRetry({ url: sourceUrl, method: "MOVE", headers: this.headers(headers) }, false);
      if (response.status === 412 && await this.sourceStillMatches(sourceUrl, sourcePath, targetUrl, targetPath, expectedFileId, expectedEtag)) {
        // Some servers answer 412 although the source still carries the expected ETag. A rename with
        // Overwrite: F cannot overwrite anything, so repeat it once without If-Match.
        this.logger.warn("apply.remote-move-if-match-rejected-although-current", { sourcePath });
        const retry = await this.requestWithRetry({ url: sourceUrl, method: "MOVE", headers: this.headers({ Destination: targetUrl, Overwrite: "F" }) }, false);
        this.assertSuccess(retry, [201, 204], `move '${sourcePath}' -> '${targetPath}'`);
      } else {
        if (response.status === 412) throw new NyraError("sync-precondition-changed", `Remote move precondition failed for '${sourcePath}'.`);
        this.assertSuccess(response, [201, 204], `move '${sourcePath}' -> '${targetPath}'`);
      }
    } catch (error) {
      const reconciled = await this.reconcileAmbiguousMove(sourceUrl, sourcePath, targetUrl, targetPath, expectedFileId, before.contentHash).catch(() => null);
      if (reconciled) {
        this.logger.warn("apply.remote-move-ambiguous-commit-reconciled", { sourcePath, targetPath, fileId: reconciled.fileId });
        return reconciled;
      }
      throw error;
    }
    const after = await this.stat(targetUrl, targetPath);
    if (expectedFileId && after.fileId !== expectedFileId) throw new Error(`Remote file identity changed while moving '${sourcePath}'.`);
    return { ...after, contentHash: before.contentHash };
  }

  async remove(url: string, path: string, expectedFileId: string | null, expectedEtag: string | null): Promise<void> {
    if (!expectedEtag) throw new Error(`Remote delete for '${path}' requires a fresh ETag.`);
    const before = await this.stat(url, path);
    this.assertIdentity(before, expectedFileId, expectedEtag, path);
    try {
      const response = await this.requestWithRetry({ url, method: "DELETE", headers: this.headers({ "If-Match": expectedEtag }) }, false);
      if (response.status === 412) throw new NyraError("sync-precondition-changed", `Remote delete precondition failed for '${path}'.`);
      this.assertSuccess(response, [204, 404], `delete '${path}'`);
    } catch (error) {
      const after = await this.statMaybe(url, path);
      if (!after) {
        this.logger.warn("apply.remote-delete-ambiguous-commit-reconciled", { path, fileId: before.fileId });
        return;
      }
      throw error;
    }
  }

  async stat(url: string, path: string): Promise<RemoteReplicaState> {
    const response = await this.requestWithRetry({
      url, method: "PROPFIND", contentType: "application/xml; charset=utf-8",
      headers: this.headers({ Depth: "0", Accept: "application/xml, text/xml;q=0.9" }), body: PROPFIND_BODY
    });
    if (response.status === 404) throw new Error(`Remote path '${path}' does not exist.`);
    this.assertSuccess(response, [207], `stat '${path}'`);
    const rows = parseDavMultistatus(response.text);
    const row = rows.find((item) => !item.isCollection) ?? rows[0];
    if (!row || row.isCollection) throw new Error(`Remote path '${path}' is not a file.`);
    if (!row.fileId) throw new Error(`Nextcloud did not return a fileId for '${path}'.`);
    if (row.size === null) throw new Error(`Nextcloud did not return a size for '${path}'.`);
    return {
      path,
      contentHash: null,
      reportedSha256: checksumHint(row.checksums),
      etag: row.etag,
      fileId: row.fileId,
      size: row.size,
      mtimeMs: row.lastModified ? Date.parse(row.lastModified) : null
    };
  }

  private async uploadChunked(
    kind: "chunked-create" | "chunked-update",
    targetUrl: string,
    targetPath: string,
    snapshot: PreparedLocalSnapshot,
    expectedFileId: string | null,
    expectedEtag: string | null,
    onProgress?: TransferProgressCallback
  ): Promise<RemoteTransferResult> {
    if (kind === "chunked-update" && !expectedEtag) throw new Error(`Chunked remote update for '${targetPath}' requires a fresh ETag.`);
    const operationKey = await makeTransferOperationKey([
      kind, targetUrl, snapshot.contentHash, snapshot.size, snapshot.chunkSize, snapshot.chunkCount, expectedFileId, expectedEtag
    ]);
    await this.cleanupSupersededPrecommitTransfers(kind, targetUrl, operationKey);
    let journal = await this.options.journal.load(operationKey);
    const resumed = journal !== null;
    if (!journal) {
      const operationId = operationKey.slice(0, 24);
      const tempPath = `${INTERNAL_RUNTIME_ROOT}/${operationId}.payload`;
      const backupPath = kind === "chunked-update" ? `${INTERNAL_RUNTIME_ROOT}/${operationId}.backup` : null;
      const uploadId = `nyra-${operationId}`;
      const now = new Date().toISOString();
      const payload: TransferJournalPayload = {
        version: 1, operationKey, operationId, kind, phase: "prepared", targetPath, targetUrl,
        tempPath, tempUrl: appendWebdavPath(this.options.webdavUserRoot, tempPath),
        backupPath, backupUrl: backupPath ? appendWebdavPath(this.options.webdavUserRoot, backupPath) : null,
        uploadId, uploadUrl: appendWebdavPath(this.uploadsRoot, uploadId), sourceHash: snapshot.contentHash,
        sourceSize: snapshot.size, chunkSize: snapshot.chunkSize, chunkCount: snapshot.chunkCount,
        uploadedChunks: [], expectedTargetFileId: expectedFileId, expectedTargetEtag: expectedEtag,
        tempFileId: null, tempEtag: null, backupFileId: null, backupEtag: null, createdAt: now, updatedAt: now
      };
      journal = await this.options.journal.create(payload);
    } else {
      this.assertJournalMatchesSnapshot(journal, snapshot, targetUrl, expectedFileId, expectedEtag);
    }

    journal = await this.rewindExpiredPrecommit(journal);
    await this.ensureParentDirectories(this.options.webdavUserRoot, journal.tempPath);
    if (phaseBefore(journal.phase, "assembling")) {
      journal = await this.ensureUploadSession(journal);
      journal = await this.reconcileUploadedChunks(journal, snapshot);
      journal = await this.uploadMissingChunks(journal, snapshot, onProgress);
    } else onProgress?.(snapshot.size, snapshot.size);

    // The execution source must still match the planned hash immediately before
    // the server-side assembly becomes eligible for publication.
    await snapshot.assertSourceUnchanged();

    if (phaseBefore(journal.phase, "temp-ready")) {
      journal = await this.options.journal.append(journal, { phase: "assembling" });
      const assembled = await this.assembleUploadToTemp(journal, snapshot.mtimeMs);
      const verified = await this.verifyRemoteContent(journal.tempUrl, journal.tempPath, assembled.fileId, assembled.etag);
      if (verified.contentHash !== snapshot.contentHash || verified.remote.size !== snapshot.size) {
        throw new Error(`Chunked upload staging verification failed for '${targetPath}'.`);
      }
      journal = await this.options.journal.append(journal, {
        phase: "temp-ready", tempFileId: verified.remote.fileId, tempEtag: verified.remote.etag
      });
    }

    await snapshot.assertSourceUnchanged();
    let finalRemote: RemoteReplicaState;
    if (kind === "chunked-create") {
      finalRemote = await this.installCreate(journal, snapshot.contentHash);
      journal = (await this.options.journal.load(operationKey)) ?? journal;
    } else {
      finalRemote = await this.installUpdate(journal, snapshot.contentHash);
      journal = (await this.options.journal.load(operationKey)) ?? journal;
    }

    const verified = await this.verifyRemoteContent(targetUrl, targetPath, finalRemote.fileId, finalRemote.etag);
    if (verified.contentHash !== snapshot.contentHash || verified.remote.size !== snapshot.size) {
      throw new Error(`Final chunked upload verification failed for '${targetPath}'.`);
    }
    journal = await this.options.journal.append(journal, { phase: "verified" });
    await this.cleanupCompletedTransfer(journal);
    return { contentHash: verified.contentHash, remote: verified.remote, chunked: true, resumed };
  }

  private async rewindExpiredPrecommit(journal: TransferJournalRecord): Promise<TransferJournalRecord> {
    if (requiresCriticalRecovery(journal) || journal.phase === "prepared") return journal;
    if (phaseBefore(journal.phase, "assembling")) return journal;

    const temp = await this.statMaybe(journal.tempUrl, journal.tempPath);
    if (temp) return journal;
    const uploadExists = await this.probeCollection(journal.uploadUrl);
    if (uploadExists) return journal;

    // Nextcloud expires inactive upload folders after a server-defined period
    // (normally 24h). Before the target swap boundary it is safe to restart the
    // transport while retaining the immutable journal history.
    this.logger.warn("transfer.precommit-session-expired", { operationId: journal.operationId, targetPath: journal.targetPath, phase: journal.phase });
    return await this.options.journal.append(journal, {
      phase: "prepared", uploadedChunks: [], tempFileId: null, tempEtag: null
    });
  }

  private async ensureUploadSession(journal: TransferJournalRecord): Promise<TransferJournalRecord> {
    if (!phaseBefore(journal.phase, "assembling")) return journal;
    const existing = await this.probeCollection(journal.uploadUrl);
    if (!existing) {
      const response = await this.http.request({
        url: journal.uploadUrl,
        method: "MKCOL",
        headers: this.headers({ Destination: journal.tempUrl }),
        timeoutMs: null
      });
      if (![201, 405].includes(response.status)) this.assertSuccess(response, [201, 405], `create chunk upload session '${journal.operationId}'`);
      if (!(await this.probeCollection(journal.uploadUrl))) throw new Error("Chunk upload session could not be verified after creation.");
      // Nextcloud expires inactive upload collections. Re-creating one is safe
      // before assembly, but every previously reported chunk must be re-probed.
      return await this.options.journal.append(journal, { phase: "upload-created", uploadedChunks: [] });
    }
    return journal.phase === "prepared"
      ? await this.options.journal.append(journal, { phase: "upload-created" })
      : journal;
  }

  private async reconcileUploadedChunks(journal: TransferJournalRecord, snapshot: PreparedLocalSnapshot): Promise<TransferJournalRecord> {
    if (!phaseBefore(journal.phase, "assembling")) return journal;
    const serverChunks = await this.listUploadChunks(journal.uploadUrl);
    const uploaded = new Set<number>();
    for (let index = 0; index < snapshot.chunkCount; index += 1) {
      const expectedSize = (await snapshot.readChunk(index)).byteLength;
      const actual = serverChunks.get(nextcloudChunkName(index));
      if (actual === expectedSize) uploaded.add(index);
    }
    const current = [...uploaded].sort((a, b) => a - b);
    if (sameNumbers(current, journal.uploadedChunks) && journal.phase === "uploading") return journal;
    return await this.options.journal.append(journal, { phase: "uploading", uploadedChunks: current });
  }

  private async uploadMissingChunks(journalInput: TransferJournalRecord, snapshot: PreparedLocalSnapshot, onProgress?: TransferProgressCallback): Promise<TransferJournalRecord> {
    if (!phaseBefore(journalInput.phase, "assembling")) return journalInput;
    let journal = journalInput;
    const uploaded = new Set(journal.uploadedChunks);
    let transferred = [...uploaded].reduce((sum, index) => sum + chunkBounds(index, snapshot.size, snapshot.chunkSize).size, 0);
    onProgress?.(transferred, snapshot.size);
    for (let index = 0; index < snapshot.chunkCount; index += 1) {
      if (uploaded.has(index)) continue;
      const chunk = await snapshot.readChunk(index);
      const chunkUrl = `${ensureTrailingSlash(journal.uploadUrl)}${nextcloudChunkName(index)}`;
      await this.putChunkIdempotently(chunkUrl, chunk, journal);
      uploaded.add(index);
      transferred += chunk.byteLength;
      onProgress?.(transferred, snapshot.size);
      journal = await this.options.journal.append(journal, { uploadedChunks: [...uploaded].sort((a, b) => a - b), phase: "uploading" });
    }
    return journal;
  }

  private async putChunkIdempotently(chunkUrl: string, chunk: ArrayBuffer, journal: TransferJournalRecord): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.http.request({
          url: chunkUrl, method: "PUT", body: chunk,
          headers: this.headers({ Destination: journal.tempUrl, "OC-Total-Length": String(journal.sourceSize), "Content-Type": "application/octet-stream", "If-None-Match": "*" }),
          timeoutMs: null
        });
        if ([200, 201, 204].includes(response.status)) return;
        if (response.status === 412 || response.status === 405) {
          const size = await this.probeFileSize(chunkUrl);
          if (size === chunk.byteLength) return;
        }
        if (!RETRYABLE.has(response.status) || attempt === this.maxAttempts) this.assertSuccess(response, [200, 201, 204], `upload chunk for '${journal.targetPath}'`);
        await this.sleepFn(retryDelayMs(response, attempt, this.randomFn));
      } catch (error) {
        lastError = error;
        const size = await this.probeFileSize(chunkUrl).catch(() => null);
        if (size === chunk.byteLength) return;
        if (attempt === this.maxAttempts) throw error;
        await this.sleepFn(exponentialDelayMs(attempt, this.randomFn));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Chunk upload failed.");
  }

  private async assembleUploadToTemp(journal: TransferJournalRecord, mtimeMs: number | null): Promise<RemoteReplicaState> {
    const source = `${ensureTrailingSlash(journal.uploadUrl)}.file`;
    try {
      const response = await this.http.request({
        url: source, method: "MOVE",
        headers: this.headers({ Destination: journal.tempUrl, Overwrite: "F", "OC-Total-Length": String(journal.sourceSize), ...mtimeHeader(mtimeMs) }),
        timeoutMs: null
      });
      if (![201, 204].includes(response.status)) this.assertSuccess(response, [201, 204], `assemble chunked upload for '${journal.targetPath}'`);
    } catch (error) {
      const recovered = await this.statMaybe(journal.tempUrl, journal.tempPath);
      if (!recovered || recovered.size !== journal.sourceSize) throw error;
    }
    const temp = await this.stat(journal.tempUrl, journal.tempPath);
    if (temp.size !== journal.sourceSize) throw new Error("Assembled remote staging file has an unexpected size.");
    return temp;
  }

  private async installCreate(journalInput: TransferJournalRecord, sourceHash: string): Promise<RemoteReplicaState> {
    let journal = journalInput;
    if (journal.phase === "verified" || journal.phase === "installed") {
      const existing = await this.stat(journal.targetUrl, journal.targetPath);
      return existing;
    }
    const target = await this.statMaybe(journal.targetUrl, journal.targetPath);
    if (target) {
      const verified = await this.verifyRemoteContent(journal.targetUrl, journal.targetPath, target.fileId, target.etag);
      if (journal.phase === "installing" && verified.contentHash === sourceHash && journal.tempFileId && target.fileId === journal.tempFileId) {
        journal = await this.options.journal.append(journal, { phase: "installed" });
        return verified.remote;
      }
      throw new Error(`Remote create target '${journal.targetPath}' is no longer absent.`);
    }
    journal = await this.options.journal.append(journal, { phase: "installing" });
    try {
      const response = await this.http.request({
        url: journal.tempUrl, method: "MOVE", headers: this.headers({ Destination: journal.targetUrl, Overwrite: "F" })
      });
      if (![201, 204].includes(response.status)) this.assertSuccess(response, [201, 204], `install chunked create '${journal.targetPath}'`);
    } catch (error) {
      const targetAfter = await this.statMaybe(journal.targetUrl, journal.targetPath);
      const tempAfter = await this.statMaybe(journal.tempUrl, journal.tempPath);
      if (!targetAfter || tempAfter || !journal.tempFileId || targetAfter.fileId !== journal.tempFileId) throw error;
    }
    const installed = await this.stat(journal.targetUrl, journal.targetPath);
    if (journal.tempFileId && installed.fileId !== journal.tempFileId) throw new Error("Installed create has an unexpected Nextcloud file identity.");
    await this.options.journal.append(journal, { phase: "installed" });
    return installed;
  }

  private async installUpdate(journalInput: TransferJournalRecord, sourceHash: string): Promise<RemoteReplicaState> {
    let journal = journalInput;
    if (!journal.expectedTargetEtag) throw new Error("Chunked update journal lacks the required target ETag.");

    if (phaseBefore(journal.phase, "backup-ready")) {
      const target = await this.stat(journal.targetUrl, journal.targetPath);
      this.assertIdentity(target, journal.expectedTargetFileId, journal.expectedTargetEtag, journal.targetPath);
      if (!journal.backupUrl || !journal.backupPath) throw new Error("Chunked update lacks a backup path.");
      const backupUrl = journal.backupUrl;
      const backupPath = journal.backupPath;
      const expectedTargetEtag = journal.expectedTargetEtag;
      if (await this.statMaybe(backupUrl, backupPath)) throw new Error("Remote transactional backup path is unexpectedly occupied.");
      journal = await this.options.journal.append(journal, { phase: "backup-moving" });
      try {
        const response = await this.http.request({
          url: journal.targetUrl, method: "MOVE",
          headers: this.headers({ Destination: backupUrl, Overwrite: "F", "If-Match": expectedTargetEtag })
        });
        if (response.status === 412) throw new NyraError("sync-precondition-changed", `Remote update precondition failed for '${journal.targetPath}': ETag changed.`);
        if (![201, 204].includes(response.status)) this.assertSuccess(response, [201, 204], `reserve original '${journal.targetPath}'`);
      } catch (error) {
        const targetAfter = await this.statMaybe(journal.targetUrl, journal.targetPath);
        const backupAfter = await this.statMaybe(backupUrl, backupPath);
        if (!(backupAfter && !targetAfter && (!journal.expectedTargetFileId || backupAfter.fileId === journal.expectedTargetFileId))) throw error;
      }
      const backup = await this.stat(backupUrl, backupPath);
      if (journal.expectedTargetFileId && backup.fileId !== journal.expectedTargetFileId) throw new Error("Remote backup does not preserve the expected file identity.");
      journal = await this.options.journal.append(journal, { phase: "backup-ready", backupFileId: backup.fileId, backupEtag: backup.etag });
    }

    await this.assertTempStillValid(journal, sourceHash);
    if (journal.phase !== "installed" && journal.phase !== "verified") {
      journal = await this.options.journal.append(journal, { phase: "installing" });
      const target = await this.statMaybe(journal.targetUrl, journal.targetPath);
      if (target) {
        if (!journal.tempFileId || target.fileId !== journal.tempFileId) throw new Error(`Remote update target '${journal.targetPath}' was occupied during the transactional swap.`);
      } else {
        try {
          const response = await this.http.request({
            url: journal.tempUrl, method: "MOVE", headers: this.headers({ Destination: journal.targetUrl, Overwrite: "F" })
          });
          if (![201, 204].includes(response.status)) this.assertSuccess(response, [201, 204], `install chunked update '${journal.targetPath}'`);
        } catch (error) {
          const targetAfter = await this.statMaybe(journal.targetUrl, journal.targetPath);
          const tempAfter = await this.statMaybe(journal.tempUrl, journal.tempPath);
          if (!targetAfter || tempAfter || !journal.tempFileId || targetAfter.fileId !== journal.tempFileId) throw error;
        }
      }
      const installed = await this.stat(journal.targetUrl, journal.targetPath);
      if (journal.tempFileId && installed.fileId !== journal.tempFileId) throw new Error("Installed update has an unexpected file identity.");
      journal = await this.options.journal.append(journal, { phase: "installed" });
    }
    return await this.stat(journal.targetUrl, journal.targetPath);
  }

  private async assertTempStillValid(journal: TransferJournalRecord, sourceHash: string): Promise<void> {
    const temp = await this.stat(journal.tempUrl, journal.tempPath);
    if (journal.tempFileId && temp.fileId !== journal.tempFileId) throw new Error("Remote staging identity changed before commit.");
    const verified = await this.verifyRemoteContent(journal.tempUrl, journal.tempPath, temp.fileId, temp.etag);
    if (verified.contentHash !== sourceHash) throw new Error("Remote staging content changed before commit.");
  }

  private async cleanupCompletedTransfer(journalInput: TransferJournalRecord): Promise<void> {
    let journal = journalInput;
    if (journal.kind === "chunked-update" && journal.backupUrl && journal.backupPath) {
      const backup = await this.statMaybe(journal.backupUrl, journal.backupPath);
      if (backup) {
        if (journal.backupFileId && backup.fileId !== journal.backupFileId) throw new Error("Refusing to delete an unexpected file from the remote transactional backup path.");
        try {
          const response = await this.http.request({ url: journal.backupUrl, method: "DELETE", headers: this.headers(backup.etag ? { "If-Match": backup.etag } : undefined) });
          if (![204, 404].includes(response.status)) this.assertSuccess(response, [204, 404], "clean remote transactional backup");
        } catch (error) {
          if (await this.statMaybe(journal.backupUrl, journal.backupPath)) {
            this.logger.warn("transfer.backup-cleanup-deferred", { operationId: journal.operationId, error: error instanceof Error ? error.message : String(error) });
            return; // keep journal so a future recovery can retry cleanup
          }
        }
      }
    }
    await this.abortUploadSession(journal.uploadUrl);
    const temp = await this.statMaybe(journal.tempUrl, journal.tempPath);
    if (temp) await this.deleteInternal(journal.tempUrl, journal.tempPath, temp);
    journal = await this.options.journal.append(journal, { phase: "complete" });
    await this.options.journal.remove(journal.operationKey);
  }

  private async cleanupSupersededPrecommitTransfers(
    kind: "chunked-create" | "chunked-update",
    targetUrl: string,
    keepOperationKey: string
  ): Promise<void> {
    for (const record of await this.options.journal.listLatest()) {
      if (record.operationKey === keepOperationKey || record.kind !== kind || record.targetUrl !== targetUrl) continue;
      if (requiresCriticalRecovery(record)) {
        throw new Error(`A previous transfer for '${record.targetPath}' crossed the commit boundary and must be recovered before a new transfer can start.`);
      }
      const temp = await this.statMaybe(record.tempUrl, record.tempPath);
      if (temp) await this.deleteInternal(record.tempUrl, record.tempPath, temp);
      await this.abortUploadSession(record.uploadUrl);
      await this.options.journal.remove(record.operationKey);
      this.logger.info("transfer.superseded-precommit-cleaned", { operationId: record.operationId, targetPath: record.targetPath });
    }
  }

  private async recoverRecord(record: TransferJournalRecord): Promise<boolean> {
    if (record.kind === "chunked-create") return await this.recoverCreate(record);
    return await this.recoverUpdate(record);
  }

  private async recoverCreate(record: TransferJournalRecord): Promise<boolean> {
    const target = await this.statMaybe(record.targetUrl, record.targetPath);
    const temp = await this.statMaybe(record.tempUrl, record.tempPath);
    if (target) {
      const verified = await this.verifyRemoteContent(record.targetUrl, record.targetPath, target.fileId, target.etag);
      if (verified.contentHash !== record.sourceHash || (record.tempFileId && target.fileId !== record.tempFileId)) {
        throw new Error(`Cannot safely recover chunked create '${record.targetPath}': target is occupied by different content.`);
      }
      if (temp) throw new Error(`Cannot safely recover chunked create '${record.targetPath}': both target and staging file exist.`);
      await this.abortUploadSession(record.uploadUrl);
      await this.options.journal.remove(record.operationKey);
      return true;
    }
    if (temp) await this.deleteInternal(record.tempUrl, record.tempPath, temp);
    await this.abortUploadSession(record.uploadUrl);
    await this.options.journal.remove(record.operationKey);
    return false;
  }

  private async recoverUpdate(record: TransferJournalRecord): Promise<boolean> {
    const target = await this.statMaybe(record.targetUrl, record.targetPath);
    const temp = await this.statMaybe(record.tempUrl, record.tempPath);
    const backup = record.backupUrl && record.backupPath ? await this.statMaybe(record.backupUrl, record.backupPath) : null;

    if (target) {
      if (record.tempFileId && target.fileId === record.tempFileId) {
        const verified = await this.verifyRemoteContent(record.targetUrl, record.targetPath, target.fileId, target.etag);
        if (verified.contentHash !== record.sourceHash) throw new Error(`Recovered update target '${record.targetPath}' failed content verification.`);
        if (backup) await this.deleteInternal(record.backupUrl!, record.backupPath!, backup);
        if (temp) throw new Error("Transactional update recovery found both the installed target and its staging identity.");
        await this.abortUploadSession(record.uploadUrl);
        await this.options.journal.remove(record.operationKey);
        return true;
      }
      if ((!record.expectedTargetFileId || target.fileId === record.expectedTargetFileId) && (!record.expectedTargetEtag || target.etag === record.expectedTargetEtag) && !backup) {
        if (temp) await this.deleteInternal(record.tempUrl, record.tempPath, temp);
        await this.abortUploadSession(record.uploadUrl);
        await this.options.journal.remove(record.operationKey);
        return false;
      }
      throw new Error(`Cannot safely recover update '${record.targetPath}': target identity is ambiguous.`);
    }

    if (backup) {
      if (record.expectedTargetFileId && backup.fileId !== record.expectedTargetFileId) throw new Error("Transactional backup identity does not match the original target.");
      try {
        const response = await this.http.request({
          url: record.backupUrl!, method: "MOVE", headers: this.headers({ Destination: record.targetUrl, Overwrite: "F", ...(backup.etag ? { "If-Match": backup.etag } : {}) })
        });
        if (![201, 204].includes(response.status)) this.assertSuccess(response, [201, 204], `restore interrupted update '${record.targetPath}'`);
      } catch (error) {
        const restored = await this.statMaybe(record.targetUrl, record.targetPath);
        const backupAfter = await this.statMaybe(record.backupUrl!, record.backupPath!);
        if (!restored || backupAfter || (record.expectedTargetFileId && restored.fileId !== record.expectedTargetFileId)) throw error;
      }
      if (temp) await this.deleteInternal(record.tempUrl, record.tempPath, temp);
      await this.abortUploadSession(record.uploadUrl);
      await this.options.journal.remove(record.operationKey);
      return true;
    }

    // No user target and no backup means we cannot prove where the original went.
    throw new Error(`Cannot safely recover interrupted update '${record.targetPath}': original target and backup are both missing.`);
  }

  private async abortUploadSession(uploadUrl: string): Promise<void> {
    if (!(await this.probeCollection(uploadUrl))) return;
    try {
      const response = await this.http.request({ url: ensureTrailingSlash(uploadUrl), method: "DELETE", headers: this.headers() });
      if (![204, 404].includes(response.status)) this.assertSuccess(response, [204, 404], "abort chunk upload session");
    } catch (error) {
      if (await this.probeCollection(uploadUrl)) throw error;
    }
  }

  private async deleteInternal(url: string, path: string, expected: RemoteReplicaState): Promise<void> {
    const response = await this.http.request({ url, method: "DELETE", headers: this.headers(expected.etag ? { "If-Match": expected.etag } : undefined) });
    if (![204, 404].includes(response.status)) this.assertSuccess(response, [204, 404], `delete internal transfer file '${path}'`);
  }

  private async listUploadChunks(uploadUrl: string): Promise<Map<string, number>> {
    const response = await this.requestWithRetry({
      url: ensureTrailingSlash(uploadUrl), method: "PROPFIND", contentType: "application/xml; charset=utf-8",
      headers: this.headers({ Depth: "1", Accept: "application/xml, text/xml;q=0.9" }), body: PROPFIND_BODY
    });
    if (response.status === 404) return new Map();
    this.assertSuccess(response, [207], "list chunk upload session");
    const map = new Map<string, number>();
    for (const row of parseDavMultistatus(response.text)) {
      if (row.isCollection || row.size === null) continue;
      const name = hrefBaseName(row.href);
      if (/^\d{5}$/.test(name)) map.set(name, row.size);
    }
    return map;
  }

  private async probeCollection(url: string): Promise<boolean> {
    const response = await this.http.request({
      url: ensureTrailingSlash(url), method: "PROPFIND", contentType: "application/xml; charset=utf-8",
      headers: this.headers({ Depth: "0", Accept: "application/xml, text/xml;q=0.9" }), body: PROPFIND_BODY
    });
    if (response.status === 404) return false;
    this.assertSuccess(response, [207], "probe transfer collection");
    return parseDavMultistatus(response.text).some((row) => row.isCollection);
  }

  private async probeFileSize(url: string): Promise<number | null> {
    const response = await this.http.request({
      url, method: "PROPFIND", contentType: "application/xml; charset=utf-8",
      headers: this.headers({ Depth: "0", Accept: "application/xml, text/xml;q=0.9" }), body: PROPFIND_BODY
    });
    if (response.status === 404) return null;
    this.assertSuccess(response, [207], "probe transfer chunk");
    const row = parseDavMultistatus(response.text).find((value) => !value.isCollection);
    return row?.size ?? null;
  }

  private async statMaybe(url: string, path: string): Promise<RemoteReplicaState | null> {
    const response = await this.requestWithRetry({
      url, method: "PROPFIND", contentType: "application/xml; charset=utf-8",
      headers: this.headers({ Depth: "0", Accept: "application/xml, text/xml;q=0.9" }), body: PROPFIND_BODY
    });
    if (response.status === 404) return null;
    this.assertSuccess(response, [207], `stat '${path}'`);
    return this.parseStatResponse(response, path);
  }

  private parseStatResponse(response: HttpResponse, path: string): RemoteReplicaState {
    const rows = parseDavMultistatus(response.text);
    const row = rows.find((item) => !item.isCollection) ?? rows[0];
    if (!row || row.isCollection) throw new Error(`Remote path '${path}' is not a file.`);
    if (!row.fileId) throw new Error(`Nextcloud did not return a fileId for '${path}'.`);
    if (row.size === null) throw new Error(`Nextcloud did not return a size for '${path}'.`);
    return { path, contentHash: null, reportedSha256: checksumHint(row.checksums), etag: row.etag, fileId: row.fileId, size: row.size, mtimeMs: row.lastModified ? Date.parse(row.lastModified) : null };
  }

  private async *downloadGenerator(
    url: string,
    path: string,
    before: RemoteReplicaState,
    resolve: (value: RemoteStreamResult) => void,
    reject: (reason: unknown) => void,
    onProgress?: TransferProgressCallback
  ): AsyncIterable<ArrayBuffer> {
    const hasher = new IncrementalSha256();
    let transferred = 0;
    let ranged = false;
    try {
      if (before.size === 0) {
        const response = await this.requestWithRetry({ url, method: "GET", headers: this.headers({ "If-Match": before.etag! }), timeoutMs: TRANSFER_IO_TIMEOUT_MS });
        if (response.status === 412) throw new NyraError("sync-precondition-changed", `Remote precondition failed for '${path}': ETag changed.`);
        this.assertSuccess(response, [200], `download '${path}'`);
        if (response.arrayBuffer.byteLength !== 0) throw new Error(`Remote size changed while downloading '${path}'.`);
        hasher.update(response.arrayBuffer);
        onProgress?.(0, 0);
        yield response.arrayBuffer;
      } else if (before.size <= this.options.tuning.maxWholeDownloadBytes) {
        const response = await this.requestWithRetry({ url, method: "GET", headers: this.headers({ "If-Match": before.etag! }), timeoutMs: TRANSFER_IO_TIMEOUT_MS });
        if (response.status === 412) throw new NyraError("sync-precondition-changed", `Remote precondition failed for '${path}': ETag changed.`);
        this.assertSuccess(response, [200], `download '${path}'`);
        if (response.arrayBuffer.byteLength !== before.size) throw new Error(`Remote size changed while downloading '${path}'.`);
        transferred = response.arrayBuffer.byteLength;
        hasher.update(response.arrayBuffer);
        onProgress?.(transferred, before.size);
        yield response.arrayBuffer;
      } else {
        ranged = true;
        const chunkSize = this.options.tuning.downloadRangeChunkBytes;
        for (let start = 0; start < before.size; start += chunkSize) {
          const end = Math.min(before.size - 1, start + chunkSize - 1);
          const response = await this.requestWithRetry({
            url, method: "GET", headers: this.headers({ "If-Match": before.etag!, Range: `bytes=${start}-${end}` }),
            timeoutMs: TRANSFER_IO_TIMEOUT_MS
          });
          if (response.status === 412) throw new NyraError("sync-precondition-changed", `Remote precondition failed for '${path}': ETag changed during ranged download.`);
          if (response.status !== 206) {
            throw new Error(`Nextcloud/proxy did not honor byte-range download for large file '${path}' (HTTP ${response.status}). Refusing an unbounded whole-file fallback.`);
          }
          const expectedSize = end - start + 1;
          if (response.arrayBuffer.byteLength !== expectedSize) throw new Error(`Ranged download returned ${response.arrayBuffer.byteLength} bytes; expected ${expectedSize}.`);
          assertContentRange(response, start, end, before.size);
          transferred += response.arrayBuffer.byteLength;
          hasher.update(response.arrayBuffer);
          onProgress?.(transferred, before.size);
          yield response.arrayBuffer;
        }
      }
      if (transferred !== before.size) throw new Error(`Remote download size mismatch for '${path}': expected ${before.size}, received ${transferred}.`);
      const after = await this.stat(url, path);
      this.assertIdentity(after, before.fileId, before.etag, path);
      if (after.size !== before.size) throw new Error(`Remote size changed while downloading '${path}'.`);
      const contentHash = hasher.digestHex();
      resolve({ contentHash, remote: { ...after, contentHash }, bytesTransferred: transferred, ranged });
    } catch (error) {
      reject(error);
      throw error;
    }
  }

  private async verifyDirectWrite(
    url: string, path: string, expectedSize: number, expectedHash: string, expectedFileId: string | null
  ): Promise<RemoteDownloadResult> {
    const metadata = await this.stat(url, path);
    if (expectedFileId && metadata.fileId !== expectedFileId) throw new Error(`Remote identity changed while writing '${path}'.`);
    if (metadata.size !== expectedSize) throw new Error(`Remote write verification failed for '${path}': size mismatch.`);
    if (!metadata.etag) throw new Error(`Remote write for '${path}' committed, but Nextcloud returned no ETag for read-back verification.`);
    const verified = await this.download(url, path, metadata.fileId, metadata.etag);
    if (verified.contentHash !== expectedHash) throw new Error(`Remote write verification failed for '${path}': read-back SHA-256 differs from uploaded bytes.`);
    return verified;
  }

  private async reconcileAmbiguousPut(
    url: string, path: string, expectedSize: number, expectedHash: string, expectedFileId: string | null, originalEtag: string | null
  ): Promise<RemoteDownloadResult | null> {
    const metadata = await this.statMaybe(url, path);
    if (!metadata || metadata.size !== expectedSize || !metadata.etag) return null;
    if (expectedFileId && metadata.fileId !== expectedFileId) return null;
    // A backend may change bytes without advancing its ETag. Never treat an
    // ambiguous response with an unchanged ETag as a verified commit.
    if (originalEtag && metadata.etag === originalEtag) return null;
    const verified = await this.download(url, path, metadata.fileId, metadata.etag);
    return verified.contentHash === expectedHash ? verified : null;
  }

  private async sourceStillMatches(sourceUrl: string, sourcePath: string, targetUrl: string, targetPath: string, expectedFileId: string | null, expectedEtag: string): Promise<boolean> {
    const [source, target] = await Promise.all([this.statMaybe(sourceUrl, sourcePath).catch(() => null), this.statMaybe(targetUrl, targetPath).catch(() => null)]);
    return Boolean(source && !target && source.etag === expectedEtag && (!expectedFileId || source.fileId === expectedFileId));
  }

  private async reconcileAmbiguousMove(
    sourceUrl: string, sourcePath: string, targetUrl: string, targetPath: string, expectedFileId: string | null, contentHash: string | null
  ): Promise<RemoteReplicaState | null> {
    const [source, target] = await Promise.all([
      this.statMaybe(sourceUrl, sourcePath),
      this.statMaybe(targetUrl, targetPath)
    ]);
    if (source || !target) return null;
    if (expectedFileId && target.fileId !== expectedFileId) return null;
    return { ...target, contentHash };
  }

  private assertJournalMatchesSnapshot(journal: TransferJournalRecord, snapshot: PreparedLocalSnapshot, targetUrl: string, expectedFileId: string | null, expectedEtag: string | null): void {
    if (journal.targetUrl !== targetUrl || journal.sourceHash !== snapshot.contentHash || journal.sourceSize !== snapshot.size || journal.chunkSize !== snapshot.chunkSize || journal.chunkCount !== snapshot.chunkCount || journal.expectedTargetFileId !== expectedFileId || journal.expectedTargetEtag !== expectedEtag) {
      throw new Error("Existing transfer journal does not match the current execution snapshot/preconditions.");
    }
  }

  private assertIdentity(remote: RemoteReplicaState, expectedFileId: string | null, expectedEtag: string | null, path: string): void {
    if (expectedFileId && remote.fileId !== expectedFileId) throw new NyraError("sync-precondition-changed", `Remote identity precondition failed for '${path}'.`);
    if (expectedEtag && remote.etag !== expectedEtag) throw new NyraError("sync-precondition-changed", `Remote ETag precondition failed for '${path}'.`);
  }

  /**
   * Removes probe files that an earlier, interrupted or failed check left behind (older versions could not
   * clean up on some clients, and other sync clients then showed them as errors). Only small files named
   * `etag-probe*` that have not been touched for ten minutes are deleted, each with its own ETag; anything
   * else, and any failure, is left alone.
   */
  private async sweepStaleProbes(runtimePath: string): Promise<void> {
    try {
      const folderUrl = ensureTrailingSlash(appendWebdavPath(this.options.webdavUserRoot, runtimePath));
      const response = await this.requestWithRetry({
        url: folderUrl, method: "PROPFIND", contentType: "application/xml; charset=utf-8",
        headers: this.headers({ Depth: "1", Accept: "application/xml, text/xml;q=0.9" }), body: PROPFIND_BODY
      });
      if (response.status !== 207) return;
      const now = Date.now();
      let removed = 0;
      for (const row of parseDavMultistatus(response.text)) {
        if (row.isCollection || !row.etag || row.size === null || row.size > 1024 || removed >= 50) continue;
        const name = decodeURIComponent(row.href.split("?")[0]!.replace(/[/]+$/, "").split("/").pop() ?? "");
        if (!name.startsWith("etag-probe")) continue;
        const modified = row.lastModified ? Date.parse(row.lastModified) : NaN;
        if (!Number.isFinite(modified) || now - modified < 10 * 60_000) continue;
        const target = appendWebdavPath(this.options.webdavUserRoot, `${runtimePath}/${name}`);
        const removal = await this.requestWithRetry({ url: target, method: "DELETE", headers: this.headers({ "If-Match": row.etag }) }, false);
        if ([204, 404].includes(removal.status)) removed += 1;
      }
      if (removed > 0) this.logger.info("remote.stale-probes-removed", { removed });
    } catch (error) {
      this.logger.warn("remote.stale-probe-sweep-failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * The guarded MOVE step of the capability probe. A rename with Overwrite: F can never destroy data, so
   * an unexpected answer is reconciled against the real server state instead of being trusted blindly:
   * the move may already have happened (the answer was lost or replayed), or the server may reject a
   * matching If-Match on MOVE although the source is demonstrably unchanged.
   */
  private async moveProbeFile(sourceUrl: string, sourcePath: string, targetUrl: string, targetPath: string, fileId: string | null, etag: string): Promise<void> {
    const send = async (ifMatch: string | null): Promise<HttpResponse | null> => {
      try {
        return await this.requestWithRetry({ url: sourceUrl, method: "MOVE", headers: this.headers({ Destination: targetUrl, Overwrite: "F", ...(ifMatch ? { "If-Match": ifMatch } : {}) }) }, false);
      } catch { return null; }
    };
    const first = await send(etag);
    if (first && [201, 204].includes(first.status)) return;
    const [source, target] = await Promise.all([this.statMaybe(sourceUrl, sourcePath).catch(() => null), this.statMaybe(targetUrl, targetPath).catch(() => null)]);
    if (!source && target && (!fileId || target.fileId === fileId)) {
      this.logger.warn("remote.move-probe-committed-before-error", { status: first?.status ?? null });
      return;
    }
    if (first?.status === 412 && source && !target && source.fileId === fileId && source.etag === etag) {
      this.logger.warn("remote.move-probe-if-match-rejected-although-current", { etag });
      const retry = await send(null);
      if (retry && [201, 204].includes(retry.status)) return;
    }
    const state = `source ${source ? `present, ETag ${source.etag ?? "none"}` : "missing"}; destination ${target ? "present" : "missing"}; expected ETag ${etag}`;
    throw new Error(first
      ? `Nextcloud move conditional-write probe failed with HTTP ${first.status}${serverReason(first)} (${state}).`
      : `Nextcloud move conditional-write probe got no answer (${state}).`);
  }

  private assertSuccess(response: HttpResponse, allowed: readonly number[], operation: string): void {
    if (response.status === 401 || response.status === 403) throw new NyraError("authentication-rejected", `Nextcloud rejected credentials during ${operation}.`);
    if (response.status === 507) throw new Error(`Nextcloud reported insufficient storage during ${operation}.`);
    // Another client holds the file lock; nothing was committed, so a fresh inventory/plan resolves it.
    if (response.status === 423 && !allowed.includes(423)) throw new NyraError("sync-precondition-changed", `Nextcloud ${operation} was refused because the item is locked by another client.`);
    if (!allowed.includes(response.status)) throw new Error(`Nextcloud ${operation} failed with HTTP ${response.status}${serverReason(response)}.`);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: this.authorization, ...(extra ?? {}) };
  }

  private async requestWithRetry(request: HttpRequest, retrySafe = true): Promise<HttpResponse> {
    // Every authenticated WebDAV request is checked at the final transport
    // boundary so malformed persisted state or a bad href cannot redirect the
    // app password to another origin.
    assertSameOrigin(this.options.serverUrl, request.url, "cross-origin-credential-server");
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        let response = await this.http.request(request);
        if (isInjectedIfNoneMatch(request, response)) {
          // This request never carried If-None-Match, so the HTTP stack added it from a cached GET. The write was
          // refused before it ran; repeat it once on a URL the cache has never seen.
          this.logger.warn("remote.client-added-if-none-match", { method: request.method ?? "GET" });
          response = await this.http.request({ ...request, url: withCacheBuster(request.url) });
        }
        const canRetry = retrySafe && RETRYABLE.has(response.status);
        if (!canRetry || attempt === this.maxAttempts) return response;
        const delay = retryDelayMs(response, attempt, this.randomFn);
        this.logger.warn("apply.remote-retry", { method: request.method ?? "GET", status: response.status, attempt, delay });
        await this.sleepFn(delay);
      } catch (error) {
        lastError = error;
        if (!retrySafe || attempt === this.maxAttempts) throw error;
        await this.sleepFn(exponentialDelayMs(attempt, this.randomFn));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Remote request failed.");
  }
}

function checksumHint(values: readonly string[]): string | null {
  for (const value of values) {
    const match = /^SHA256:([a-f0-9]{64})$/i.exec(value.trim());
    if (match) return match[1]!.toLowerCase();
  }
  return null;
}
function retryDelayMs(response: HttpResponse, attempt: number, random: () => number): number {
  const retryAfter = header(response, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.max(250, seconds * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(250, date - Date.now()));
  }
  return exponentialDelayMs(attempt, random);
}
function exponentialDelayMs(attempt: number, random: () => number): number {
  const base = Math.min(8_000, 400 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.85 + random() * 0.3));
}
function ensureTrailingSlash(value: string): string { return value.endsWith("/") ? value : `${value}/`; }
/**
 * Nextcloud derives a file's ETag from its stored mtime: rewriting a file with the same X-OC-MTime keeps the
 * old ETag even though the bytes changed. A conditional update must therefore always carry an mtime whose
 * second differs from the remote file's current one, otherwise a concurrent same-second edit would go unnoticed.
 */
export function distinctUploadMtimeMs(desiredMs: number | null | undefined, remoteMtimeMs: number | null | undefined): number | null {
  const wanted = desiredMs !== null && desiredMs !== undefined && Number.isFinite(desiredMs) && desiredMs >= 0 ? desiredMs : null;
  if (remoteMtimeMs === null || remoteMtimeMs === undefined || !Number.isFinite(remoteMtimeMs)) return wanted;
  const seconds = Math.floor((wanted ?? Date.now()) / 1000);
  return seconds === Math.floor(remoteMtimeMs / 1000) ? (seconds + 1) * 1000 : seconds * 1000;
}

function mtimeHeader(mtimeMs: number | null | undefined): Record<string, string> {
  if (mtimeMs === null || mtimeMs === undefined || !Number.isFinite(mtimeMs) || mtimeMs < 0) return {};
  return { "X-OC-MTime": String(Math.floor(mtimeMs / 1000)) };
}

/** Short Sabre/Nextcloud explanation from an error body (its `<s:message>`), so a bare status code is never all the user sees. */
export function serverReason(response: Pick<HttpResponse, "text">): string {
  const text = typeof response.text === "string" ? response.text : "";
  const raw = /<s:message>([\s\S]*?)<\/s:message>/i.exec(text)?.[1] ?? /<message>([\s\S]*?)<\/message>/i.exec(text)?.[1] ?? "";
  const clean = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return ` (${clean.length > 200 ? `${clean.slice(0, 197)}…` : clean})`;
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => globalThis.setTimeout(resolve, ms)); }
function header(response: HttpResponse, name: string): string | undefined {
  const pair = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return pair?.[1];
}
function assertContentRange(response: HttpResponse, start: number, end: number, total: number): void {
  const value = header(response, "content-range");
  if (!value) throw new Error("Ranged download response is missing Content-Range.");
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== total) {
    throw new Error(`Invalid Content-Range response: '${value}'.`);
  }
}
function hrefBaseName(href: string): string {
  const path = new URL(href, "https://placeholder.invalid").pathname.replace(/\/+$/, "");
  const encoded = path.slice(path.lastIndexOf("/") + 1);
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}
function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function requiresCriticalRecovery(record: TransferJournalRecord): boolean {
  if (record.kind === "chunked-create") return !phaseBefore(record.phase, "installing");
  return !phaseBefore(record.phase, "backup-moving");
}
const PHASE_ORDER = ["prepared","upload-created","uploading","assembling","temp-ready","backup-moving","backup-ready","installing","installed","verified","complete"] as const;
function phaseBefore(left: TransferJournalRecord["phase"], right: TransferJournalRecord["phase"]): boolean {
  return PHASE_ORDER.indexOf(left) < PHASE_ORDER.indexOf(right);
}
