import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../state/durable/crypto";
import { getPluginDeviceRuntimeRoot } from "./device-scope";

interface ScopeBindingRecord {
  version: 1;
  identityHash: string;
}

const HASH = /^[a-f0-9]{64}$/;

/**
 * Keep the pre-existing app-profile store for its first known account/root.
 * A different account or remote root receives another runtime directory, so
 * its inventory cannot reinterpret the former store's BASE and tombstones.
 * The old directory is retained intact for a future return or recovery.
 */
export async function resolveRuntimeScope(
  adapter: DataAdapter,
  configDir: string,
  pluginId: string,
  baseScope: string,
  identity: string | null
): Promise<string> {
  const baseRoot = getPluginDeviceRuntimeRoot(configDir, pluginId, baseScope);
  if (identity === null) return baseScope;
  const identityHash = await digest(identity);
  const baseMarker = `${baseRoot}/scope-binding.json`;
  const baseBinding = await readBinding(adapter, baseMarker);
  if (baseBinding === null) {
    await writeBinding(adapter, baseMarker, identityHash);
    return baseScope;
  }
  if (baseBinding === identityHash) return baseScope;

  const derivedScope = (await digest(`${baseScope}:${identityHash}`)).slice(0, 32);
  if (derivedScope === baseScope) throw new Error("Derived Nyra runtime scope collided with its app-profile scope.");
  const derivedRoot = getPluginDeviceRuntimeRoot(configDir, pluginId, derivedScope);
  const derivedMarker = `${derivedRoot}/scope-binding.json`;
  const derivedBinding = await readBinding(adapter, derivedMarker);
  if (derivedBinding === identityHash) return derivedScope;
  if (derivedBinding !== null) throw new Error("Nyra runtime scope is bound to a different account or remote folder.");
  if (await adapter.exists(derivedRoot)) {
    const entries = await adapter.list(derivedRoot);
    if (entries.files.length > 0 || entries.folders.length > 0) {
      throw new Error("Unbound Nyra runtime data occupies the selected sync scope; preserving it for review.");
    }
  }
  await writeBinding(adapter, derivedMarker, identityHash);
  return derivedScope;
}

export function runtimeScopeIdentity(account: { serverUrl: string; userId: string; webdavRootUrl: string } | null, remoteRootPath: string): string | null {
  if (!account) return null;
  return JSON.stringify([account.serverUrl, account.userId, account.webdavRootUrl, remoteRootPath]);
}

async function readBinding(adapter: DataAdapter, path: string): Promise<string | null> {
  if (!(await adapter.exists(path))) return null;
  let raw: unknown;
  try { raw = JSON.parse(await adapter.read(path)) as unknown; }
  catch { throw new Error("Nyra runtime scope binding is unreadable; preserving its state."); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Nyra runtime scope binding is invalid.");
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== 1 || typeof record.identityHash !== "string" || !HASH.test(record.identityHash)) {
    throw new Error("Nyra runtime scope binding is invalid; preserving its state.");
  }
  return record.identityHash;
}

async function writeBinding(adapter: DataAdapter, path: string, identityHash: string): Promise<void> {
  const directory = path.slice(0, path.lastIndexOf("/"));
  await mkdirp(adapter, directory);
  const temp = `${path}.tmp`;
  const content = JSON.stringify({ version: 1, identityHash } satisfies ScopeBindingRecord);
  if (await adapter.exists(temp)) {
    if ((await adapter.read(temp)) !== content) throw new Error("Interrupted Nyra runtime scope binding differs from this account; preserving it for review.");
  } else {
    await adapter.write(temp, content);
  }
  if ((await adapter.read(temp)) !== content) throw new Error("Nyra runtime scope binding failed staging verification.");
  await adapter.rename(temp, path);
  if ((await adapter.read(path)) !== content) throw new Error("Nyra runtime scope binding failed commit verification.");
}

async function mkdirp(adapter: DataAdapter, path: string): Promise<void> {
  let current = "";
  for (const segment of path.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    if (!(await adapter.exists(current))) await adapter.mkdir(current);
  }
}

async function digest(value: string): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(value).buffer);
}
