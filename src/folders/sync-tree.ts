import type { DataAdapter } from "obsidian";
import type { NextcloudDavClient } from "../remote/dav-client";
import { NYRA_REMOTE_RUNTIME_ROOT, appendWebdavPath, relativePathFromDavHref } from "../remote/path";
import { canonicalVaultRelativePath } from "../state/durable/path";

export interface SyncTreeEntry {
  name: string;
  /** Vault-relative path. */
  path: string;
  isFolder: boolean;
  size: number | null;
  onDevice: boolean;
  onServer: boolean;
}

export interface SyncTreeListing {
  entries: SyncTreeEntry[];
  /** False when Nextcloud could not be asked (offline, not connected); only this device's items are shown. */
  serverReachable: boolean;
}

export interface SyncTreeSources {
  adapter: DataAdapter;
  /** The vault's own scope (reserved roots, config tree); the user's exclusions deliberately do not apply. */
  isInBaseScope(path: string): boolean;
  /** Present when connected: lists one remote folder (relative to the synced folder). */
  remote?: { client: NextcloudDavClient; rootUrl: string } | undefined;
}

const MAX_SIZE_LOOKUPS = 250;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Children of one folder, as the union of this device and Nextcloud. Listing is lazy (one folder
 * per call) so the picker stays fast on large vaults, and it shows items the user excluded, so
 * they can be checked again.
 */
export async function listSyncTreeChildren(sources: SyncTreeSources, folderInput: string): Promise<SyncTreeListing> {
  const folder = folderInput === "" ? "" : canonicalVaultRelativePath(folderInput);
  const byPath = new Map<string, SyncTreeEntry>();
  const upsert = (path: string, isFolder: boolean, size: number | null, side: "device" | "server"): void => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!name || path.split("/").includes(NYRA_REMOTE_RUNTIME_ROOT) || !sources.isInBaseScope(path)) return;
    const existing = byPath.get(path) ?? { name, path, isFolder, size: null, onDevice: false, onServer: false };
    if (side === "device") existing.onDevice = true; else existing.onServer = true;
    if (size !== null) existing.size = size;
    byPath.set(path, existing);
  };

  if (folder === "" || await sources.adapter.exists(folder)) {
    const listing = await sources.adapter.list(folder);
    for (const raw of listing.folders) upsert(canonicalVaultRelativePath(raw), true, null, "device");
    let lookups = 0;
    for (const raw of listing.files) {
      const path = canonicalVaultRelativePath(raw);
      let size: number | null = null;
      if (lookups < MAX_SIZE_LOOKUPS && sources.isInBaseScope(path)) {
        lookups += 1;
        size = (await sources.adapter.stat(path))?.size ?? null;
      }
      upsert(path, false, size, "device");
    }
  }

  let serverReachable = false;
  if (sources.remote) {
    try {
      const base = folder === "" ? sources.remote.rootUrl : appendWebdavPath(sources.remote.rootUrl, folder);
      const responses = await sources.remote.client.listDirectory(base);
      serverReachable = true;
      for (const response of responses) {
        const path = relativePathFromDavHref(sources.remote.rootUrl, response.href);
        if (path === null || path === folder || parentOf(path) !== folder) continue;
        upsert(path, response.isCollection, response.isCollection ? null : response.size, "server");
      }
    } catch {
      serverReachable = false; // offline or the folder does not exist remotely yet: show this device only
    }
  }

  const entries = [...byPath.values()].sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || collator.compare(a.name, b.name));
  return { entries, serverReachable };
}

function parentOf(path: string): string { const slash = path.lastIndexOf("/"); return slash < 0 ? "" : path.slice(0, slash); }
