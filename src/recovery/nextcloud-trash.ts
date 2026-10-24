import { NyraError } from "../core/errors";
import type { HttpTransport } from "../network/http-client";
import { parseDavMultistatus } from "../remote/dav-xml";
import { appendWebdavPath, NYRA_REMOTE_RUNTIME_ROOT } from "../remote/path";
import { assertSameOrigin } from "../security/url-policy";

export interface TrashedItem {
  /** Opaque trash-bin name, e.g. `note.md.d1792592759`; the restore handle. */
  trashName: string;
  /** Path relative to the user's files root, e.g. `Obsidian/Vault/note.md`. */
  originalLocation: string;
  isFolder: boolean;
  size: number | null;
  deletedAt: string;
}

const PROPFIND = `<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><nc:trashbin-filename/><nc:trashbin-original-location/><nc:trashbin-deletion-time/><d:getcontentlength/><d:resourcetype/><oc:size/></d:prop></d:propfind>`;
const MAX_ITEMS = 300;
const MAX_PURGE_PER_RUN = 60;

/** Lists and restores items in the user's Nextcloud trash bin (the server-side safety net for deletions). */
export class NextcloudTrash {
  private readonly base: string;

  constructor(
    private readonly http: HttpTransport,
    private readonly serverUrl: string,
    userId: string,
    private readonly authorization: string
  ) {
    this.base = appendWebdavPath(`${serverUrl.replace(/\/+$/, "")}/remote.php/dav/trashbin/${encodeURIComponent(userId)}/`, "trash");
  }

  /** Newest first, only items that were deleted from below `rootPath` (the synchronized folder). */
  async list(rootPath: string): Promise<TrashedItem[]> {
    const response = await this.request(this.base + "/", "PROPFIND", { Depth: "1" }, PROPFIND, "application/xml; charset=utf-8");
    if (response.status === 404) return [];
    if (response.status !== 207) throw new Error(`Nextcloud trash listing failed with HTTP ${response.status}.`);
    const prefix = rootPath.replace(/^\/+|\/+$/g, "");
    const items: TrashedItem[] = [];
    for (const row of parseDavMultistatus(response.text)) {
      const trash = row.trash;
      if (!trash?.filename || !trash.originalLocation || !trash.deletionTime) continue;
      const original = trash.originalLocation.replace(/^\/+/, "");
      if (prefix && original !== prefix && !original.startsWith(`${prefix}/`)) continue;
      if (original.split("/").some((segment) => segment.startsWith(".nyra-nextcloud-sync-runtime"))) continue;
      const trashName = decodeURIComponent(row.href.replace(/\/+$/, "").split("/").pop() ?? "");
      const seconds = Number(trash.deletionTime);
      if (!trashName || !Number.isFinite(seconds)) continue;
      items.push({ trashName, originalLocation: original, isFolder: row.isCollection, size: row.size, deletedAt: new Date(seconds * 1000).toISOString() });
    }
    return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)).slice(0, MAX_ITEMS);
  }

  /**
   * Permanently removes the plugin's own capability-probe leftovers from the trash bin so they do
   * not clutter the user's trash. Only items that were deleted from the internal runtime folder
   * below `rootPath` and whose names are probe files are touched. Returns how many were purged.
   */
  async purgeProbeLeftovers(rootPath: string): Promise<number> {
    const response = await this.request(this.base + "/", "PROPFIND", { Depth: "1" }, PROPFIND, "application/xml; charset=utf-8");
    if (response.status !== 207) return 0;
    const prefix = rootPath.replace(/^\/+|\/+$/g, "");
    let purged = 0;
    for (const row of parseDavMultistatus(response.text)) {
      const original = row.trash?.originalLocation?.replace(/^\/+/, "") ?? "";
      const name = row.trash?.filename ?? "";
      const inRuntime = original.split("/").includes(".nyra-nextcloud-sync-runtime");
      const inRoot = prefix === "" || original.startsWith(`${prefix}/`) || original.startsWith(`${NYRA_REMOTE_RUNTIME_ROOT}/`); // also the account-level staging folder
      const isProbe = /^(etag-probe|rootetag-|probe\.txt$)/.test(name) || /\/(etag-probe|rootetag-)[^/]*/.test(original);
      if (!inRuntime || !inRoot || !isProbe) continue;
      const trashName = decodeURIComponent(row.href.replace(/\/+$/, "").split("/").pop() ?? "");
      if (!trashName || purged >= MAX_PURGE_PER_RUN) continue;
      const removed = await this.request(`${this.base}/${encodeURIComponent(trashName)}`, "DELETE", {});
      if ([200, 204, 404].includes(removed.status)) purged += 1;
    }
    return purged;
  }

  /** Restores one item to its original location (Nextcloud refuses if the target exists). */
  async restore(item: TrashedItem): Promise<void> {
    const source = `${this.base}/${encodeURIComponent(item.trashName)}`;
    const destination = this.base.replace(/\/trash$/, "/restore") + `/${encodeURIComponent(item.trashName)}`;
    const response = await this.request(source, "MOVE", { Destination: destination });
    if (response.status === 401 || response.status === 403) throw new NyraError("authentication-rejected", "Nextcloud rejected the restore request.");
    if (response.status === 412 || response.status === 409) throw new Error("Nextcloud cannot restore this item because something already exists at its original location.");
    if (![200, 201, 204].includes(response.status)) throw new Error(`Nextcloud restore failed with HTTP ${response.status}.`);
  }

  private async request(url: string, method: string, headers: Record<string, string>, body?: string, contentType?: string): Promise<{ status: number; text: string }> {
    assertSameOrigin(this.serverUrl, url, "cross-origin-credential-server");
    const request: Parameters<HttpTransport["request"]>[0] = { url, method, headers: { Authorization: this.authorization, ...headers } };
    if (body !== undefined) request.body = body;
    if (contentType !== undefined) request.contentType = contentType;
    const response = await this.http.request(request);
    return { status: response.status, text: response.text };
  }
}
