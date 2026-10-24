import { NyraError, type NyraErrorCode } from "../core/errors";
import type { NextcloudCredentials } from "../core/types";
import type { Logger } from "../diagnostics/logger";
import type { HttpTransport, HttpResponse } from "../network/http-client";
import { basicAuthorization } from "../security/base64";
import { safeUrlForLog } from "../security/redaction";
import { parseDavMultistatus, type DavPropertyResponse } from "./dav-xml";
import { assertSameOrigin } from "../security/url-policy";

const PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>\n<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:getlastmodified/><d:getetag/><d:getcontenttype/><d:getcontentlength/><d:resourcetype/><oc:fileid/><oc:size/><oc:checksums/></d:prop></d:propfind>`;
const RETRYABLE_STATUS = new Set([408, 423, 425, 429, 500, 502, 503, 504]);
export const MAX_DAV_RESPONSE_BYTES = 64 * 1024 * 1024;

export interface DavRequestMetrics {
  requestCount: number;
  responseBytes: number;
  networkDurationMs: number;
  parseDurationMs: number;
  retryCount: number;
}

export interface MeasuredDavDirectory {
  responses: DavPropertyResponse[];
  metrics: DavRequestMetrics;
}

export class DavDirectoryRequestError extends NyraError {
  constructor(message: string, readonly metrics: DavRequestMetrics, code: NyraErrorCode, cause?: unknown) {
    super(code, message, cause);
    this.name = "DavDirectoryRequestError";
  }
}

export class NextcloudDavClient {
  private readonly authorization: string;
  private readonly trustedServerUrl: string;

  constructor(
    private readonly http: HttpTransport,
    credentials: NextcloudCredentials,
    private readonly logger: Logger,
    private readonly maxAttempts = 4
  ) {
    this.authorization = basicAuthorization(credentials.loginName, credentials.appPassword);
    this.trustedServerUrl = credentials.serverUrl;
  }

  async listDirectory(url: string): Promise<DavPropertyResponse[]> {
    return (await this.listDirectoryMeasured(url)).responses;
  }

  async listDirectoryMeasured(url: string): Promise<MeasuredDavDirectory> {
    const metrics: DavRequestMetrics = { requestCount: 0, responseBytes: 0, networkDurationMs: 0, parseDurationMs: 0, retryCount: 0 };
    try {
      const response = await this.requestWithRetry(url, metrics);
      if (response.status === 401 || response.status === 403) {
        throw new NyraError("authentication-rejected", "Nextcloud rejected credentials while reading the remote inventory.");
      }
      if (response.status === 404) throw new NyraError("webdav-not-found", "The configured remote folder does not exist.");
      if (response.status !== 207) {
        throw new NyraError("webdav-inventory-failed", `Remote inventory PROPFIND failed (HTTP ${response.status}).`);
      }
      if (response.arrayBuffer.byteLength > MAX_DAV_RESPONSE_BYTES) {
        throw new NyraError("webdav-response-too-large", `WebDAV directory response exceeds the ${MAX_DAV_RESPONSE_BYTES}-byte safety limit.`);
      }
      const parseStarted = monotonicNow();
      const responses = parseDavMultistatus(response.text);
      metrics.parseDurationMs += elapsedSince(parseStarted);
      return { responses, metrics };
    } catch (error) {
      const cause = error instanceof DavDirectoryRequestError ? error.causeValue : error;
      if (cause instanceof Error && cause.message.includes("XML")) {
        this.logger.warn("remote.invalid-multistatus", { url: safeUrlForLog(url), error: cause.message });
      }
      const code = cause instanceof NyraError ? cause.code : "webdav-invalid-response";
      throw new DavDirectoryRequestError(
        error instanceof Error ? error.message : "Remote directory request failed.",
        metrics,
        code,
        error
      );
    }
  }

  private async requestWithRetry(url: string, metrics: DavRequestMetrics): Promise<HttpResponse> {
    assertSameOrigin(this.trustedServerUrl, url, "cross-origin-credential-server");
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const requestStarted = monotonicNow();
      metrics.requestCount += 1;
      try {
        const response = await this.http.request({
          url,
          method: "PROPFIND",
          contentType: "application/xml; charset=utf-8",
          headers: {
            Authorization: this.authorization,
            Depth: "1",
            Accept: "application/xml, text/xml;q=0.9"
          },
          body: PROPFIND_BODY
        });
        metrics.networkDurationMs += elapsedSince(requestStarted);
        metrics.responseBytes += response.arrayBuffer.byteLength;
        if (!RETRYABLE_STATUS.has(response.status) || attempt === this.maxAttempts) return response;
        metrics.retryCount += 1;
        const delayMs = retryDelayMs(response, attempt);
        this.logger.warn("remote.propfind-retry", { url: safeUrlForLog(url), status: response.status, attempt, delayMs });
        await sleep(delayMs);
      } catch (error) {
        // Count and time network failures too; a thrown request has no body.
        metrics.networkDurationMs += elapsedSince(requestStarted);
        lastError = error;
        if (attempt === this.maxAttempts) throw error;
        metrics.retryCount += 1;
        const delayMs = exponentialDelayMs(attempt);
        this.logger.warn("remote.propfind-network-retry", { url: safeUrlForLog(url), attempt, delayMs, error: error instanceof Error ? error.message : String(error) });
        await sleep(delayMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Remote WebDAV request failed.");
  }
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
function elapsedSince(start: number): number {
  return Math.max(0, monotonicNow() - start);
}

function retryDelayMs(response: HttpResponse, attempt: number): number {
  const retryAfter = headerValue(response.headers, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.max(250, seconds * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(250, date - Date.now()));
  }
  return exponentialDelayMs(attempt);
}
function exponentialDelayMs(attempt: number): number {
  const base = Math.min(8_000, 400 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
function headerValue(headers: Record<string, string>, name: string): string | null {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === expected) return value;
  return null;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
