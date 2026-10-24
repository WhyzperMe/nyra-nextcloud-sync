import type { HttpTransport } from "../network/http-client";
import { parseDavMultistatus } from "../remote/dav-xml";
import { assertSameOrigin } from "../security/url-policy";

export interface FileVersion {
  /** Server-side version identifier (a Unix timestamp). */
  id: string;
  size: number;
  modifiedAt: string;
}

const PROPFIND = `<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>`;
export const MAX_VERSION_BYTES = 32 * 1024 * 1024;

/** Reads a file's older versions from Nextcloud's versions endpoint (the `files_versions` app). */
export class NextcloudVersions {
  private readonly base: string;

  constructor(private readonly http: HttpTransport, private readonly serverUrl: string, userId: string, private readonly authorization: string) {
    this.base = `${serverUrl.replace(/\/+$/, "")}/remote.php/dav/versions/${encodeURIComponent(userId)}/versions`;
  }

  /** Newest first. Empty when the file has no versions or the server has versioning disabled. */
  async list(fileId: string): Promise<FileVersion[]> {
    assertFileId(fileId);
    const response = await this.request(`${this.base}/${fileId}/`, "PROPFIND", { Depth: "1" }, PROPFIND);
    if (response.status === 404) return [];
    if (response.status !== 207) throw new Error(`Nextcloud version listing failed with HTTP ${response.status}.`);
    const versions: FileVersion[] = [];
    for (const row of parseDavMultistatus(response.text)) {
      if (row.isCollection) continue;
      const id = decodeURIComponent(row.href.replace(/\/+$/, "").split("/").pop() ?? "");
      const modified = row.lastModified ? Date.parse(row.lastModified) : Number(id) * 1000;
      if (!/^\d{5,}$/.test(id) || !Number.isFinite(modified) || row.size === null) continue;
      versions.push({ id, size: row.size, modifiedAt: new Date(modified).toISOString() });
    }
    return versions.sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
  }

  async download(fileId: string, version: FileVersion): Promise<ArrayBuffer> {
    assertFileId(fileId);
    if (version.size > MAX_VERSION_BYTES) throw new Error(`This version is larger than ${MAX_VERSION_BYTES / 1024 / 1024} MiB and cannot be restored here.`);
    const response = await this.request(`${this.base}/${fileId}/${encodeURIComponent(version.id)}`, "GET", {});
    if (response.status !== 200) throw new Error(`Nextcloud version download failed with HTTP ${response.status}.`);
    return response.arrayBuffer;
  }

  private async request(url: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }> {
    assertSameOrigin(this.serverUrl, url, "cross-origin-credential-server");
    const request: Parameters<HttpTransport["request"]>[0] = { url, method, headers: { Authorization: this.authorization, ...headers } };
    if (body !== undefined) { request.body = body; request.contentType = "application/xml; charset=utf-8"; }
    const response = await this.http.request(request);
    return { status: response.status, text: method === "GET" ? "" : response.text, arrayBuffer: response.arrayBuffer };
  }
}

function assertFileId(fileId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) throw new Error("Invalid Nextcloud file ID.");
}
