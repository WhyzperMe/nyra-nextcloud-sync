import type { Logger } from "../diagnostics/logger";
import type { HttpResponse, HttpTransport } from "../network/http-client";
import { appendWebdavPath, NYRA_REMOTE_RUNTIME_ROOT } from "./path";
import { parseDavMultistatus } from "./dav-xml";

const ETAG_BODY = `<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`;
const PROPAGATION_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 300;

/**
 * One-request "has anything changed?" check based on the sync root's collection ETag.
 *
 * Nextcloud propagates a child's change to every parent's ETag, but storage backends differ,
 * so the shortcut is only used after `verifyPropagation` proved on this server that a nested
 * create and delete both change the root ETag. Missing a change is never unsafe: every write
 * still re-checks its own file's fresh ETag, and a periodic full scan is always forced.
 */
export class RemoteRootChangeDetector {
  constructor(
    private readonly http: HttpTransport,
    private readonly authorization: string,
    private readonly rootUrl: string,
    private readonly logger: Logger,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms))
  ) {}

  async currentEtag(): Promise<string | null> {
    const response = await this.request("PROPFIND", this.rootUrl, { Depth: "0" }, ETAG_BODY);
    if (response.status !== 207) return null;
    const etag = parseDavMultistatus(response.text)[0]?.etag?.trim() ?? null;
    return etag && /^"[^"]+"$/.test(etag) ? etag : null;
  }

  /** Creates and removes a nested probe file under the internal runtime folder and watches the root ETag. */
  async verifyPropagation(): Promise<boolean> {
    const runtime = `${appendWebdavPath(this.rootUrl, NYRA_REMOTE_RUNTIME_ROOT)}`;
    const probe = `${runtime}/rootetag-${Math.random().toString(16).slice(2, 14)}`;
    const nested = `${probe}/a`;
    let needsCleanup = false;
    try {
      const before = await this.currentEtag();
      if (!before) return false;
      needsCleanup = true; // the probe folder may exist from here on
      for (const url of [runtime, probe, nested]) {
        const response = await this.request("MKCOL", url, {});
        if (![201, 405].includes(response.status)) return false;
      }
      const put = await this.request("PUT", `${nested}/probe.txt`, { "If-None-Match": "*" }, "nyra root etag probe\n");
      if (![201, 204].includes(put.status)) return false;
      const afterCreate = await this.waitForChange(before);
      if (!afterCreate) return false;
      const removed = await this.request("DELETE", probe, {});
      if (![204, 404].includes(removed.status)) return false;
      needsCleanup = false;
      return (await this.waitForChange(afterCreate)) !== null;
    } catch (error) {
      this.logger.info("remote.root-etag-probe-failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (needsCleanup) await this.request("DELETE", probe, {}).catch(() => undefined);
    }
  }

  private async waitForChange(previous: string): Promise<string | null> {
    for (let waited = 0; waited <= PROPAGATION_TIMEOUT_MS; waited += POLL_INTERVAL_MS) {
      const current = await this.currentEtag();
      if (current && current !== previous) return current;
      await this.sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  private async request(method: string, url: string, headers: Record<string, string>, body?: string): Promise<HttpResponse> {
    const request: Parameters<HttpTransport["request"]>[0] = { url: method === "MKCOL" || method === "PROPFIND" ? ensureSlash(url) : url, method, headers: { Authorization: this.authorization, ...headers } };
    if (body !== undefined) {
      request.body = body;
      request.contentType = method === "PROPFIND" ? "application/xml; charset=utf-8" : "text/plain";
    }
    return await this.http.request(request);
  }
}

function ensureSlash(url: string): string { return url.endsWith("/") ? url : `${url}/`; }
