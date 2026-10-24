export interface StateDirectoryListing {
  files: string[];
  folders: string[];
}

/**
 * Minimal storage surface used by the durable-state engine.
 *
 * All paths are relative to a backend-owned root and use forward slashes.
 * Implementations MUST reject traversal outside that root.
 */
export interface StateBackend {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  statSize(path: string): Promise<number | null>;
  writeText(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  appendBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<StateDirectoryListing>;
}

export function assertSafeStatePath(path: string): string {
  if (path.includes("\\")) {
    throw new Error(`State path must use forward slashes: ${path}`);
  }
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    throw new Error(`Absolute state paths are not allowed: ${path}`);
  }

  const parts = path.split("/").filter((part) => part.length > 0);
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new Error(`State path traversal is not allowed: ${path}`);
    }
    if (/\0|[\u0001-\u001f\u007f]/.test(part)) {
      throw new Error("State paths may not contain control characters.");
    }
  }
  return parts.join("/");
}

export function parentStatePath(path: string): string {
  const safe = assertSafeStatePath(path);
  const slash = safe.lastIndexOf("/");
  return slash < 0 ? "" : safe.slice(0, slash);
}

export function stateBaseName(path: string): string {
  const safe = assertSafeStatePath(path);
  const slash = safe.lastIndexOf("/");
  return slash < 0 ? safe : safe.slice(slash + 1);
}
