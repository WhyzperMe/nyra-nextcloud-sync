import { randomId } from "../state/durable/ids";

const DEVICE_SCOPE = /^[a-f0-9]{32}$/;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

export interface LocalKeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Returns a stable opaque ID for this Obsidian app profile. It deliberately
 * lives outside plugin data.json, which vault-sync tools commonly replicate.
 */
export function getOrCreateDeviceScope(
  pluginId: string,
  storage: LocalKeyValueStorage
): string {
  if (!PLUGIN_ID.test(pluginId)) throw new Error("Invalid plugin ID for local runtime storage.");

  const key = `nyra:${pluginId}:device-scope:v1`;
  let stored: string | null;
  try {
    stored = storage.getItem(key);
  } catch {
    throw new Error("Nyra cannot access persistent app-local storage; sync is disabled to avoid sharing runtime state between devices.");
  }
  if (stored && DEVICE_SCOPE.test(stored)) return stored;

  const scope = randomId("device").slice("device_".length);
  try {
    storage.setItem(key, scope);
    if (storage.getItem(key) !== scope) {
      throw new Error("Persistent app-local storage did not retain the device scope.");
    }
  } catch {
    throw new Error("Nyra could not persist its app-local device scope; sync is disabled to avoid sharing runtime state between devices.");
  }
  return scope;
}

export function getPluginDeviceRuntimeRoot(
  configDir: string,
  pluginId: string,
  deviceScope: string
): string {
  if (!PLUGIN_ID.test(pluginId)) throw new Error("Invalid plugin ID for runtime storage.");
  if (!DEVICE_SCOPE.test(deviceScope)) throw new Error("Invalid app-local device scope.");
  const safeConfigDir = configDir.split("/").filter(Boolean);
  if (
    configDir.includes("\\") || configDir.startsWith("/") || /^[A-Za-z]:/.test(configDir) ||
    safeConfigDir.some((part) => part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))
  ) {
    throw new Error("Invalid Obsidian config directory for runtime storage.");
  }
  return [...safeConfigDir, "plugins", pluginId, "runtime", deviceScope].join("/");
}

/** Uses the standard Web Storage API supported by Obsidian desktop and mobile. */
export function createAppLocalDeviceScope(pluginId: string): string {
  try {
    return getOrCreateDeviceScope(pluginId, globalThis.localStorage);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Nyra ")) throw error;
    throw new Error("Nyra's app-local storage is unavailable; sync is disabled to avoid sharing runtime state between devices.");
  }
}
