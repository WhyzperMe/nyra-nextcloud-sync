import type { StateBackend } from "./backend";
import { parentStatePath, stateBaseName } from "./backend";
import { equalBytes, sha256Hex } from "./crypto";
import { randomId } from "./ids";

/**
 * Writes a unique immutable file via same-directory staging and read-back.
 *
 * The read-back is intentional: DataAdapter does not expose fsync. Future
 * destructive work may proceed only after the adapter can read the exact bytes
 * that were committed under the immutable final name.
 */
export async function writeImmutableText(
  backend: StateBackend,
  finalPath: string,
  data: string
): Promise<void> {
  await backend.mkdirp(parentStatePath(finalPath));
  if (await backend.exists(finalPath)) {
    const existing = await backend.readText(finalPath);
    if (existing !== data) throw new Error(`Immutable file collision at ${finalPath}.`);
    return;
  }

  const tempPath = siblingTempPath(finalPath);
  try {
    try {
      await backend.writeText(tempPath, data);
      const staged = await backend.readText(tempPath);
      if (staged !== data) throw new Error(`Staged text verification failed for ${finalPath}.`);

      if (await backend.exists(finalPath)) {
        const existing = await backend.readText(finalPath);
        if (existing !== data) throw new Error(`Immutable file collision at ${finalPath}.`);
        return;
      }

      await backend.rename(tempPath, finalPath);
      const committed = await backend.readText(finalPath);
      if (committed !== data) throw new Error(`Committed text verification failed for ${finalPath}.`);
    } catch (error) {
      // Another writer may have won the final-name race, or the adapter may
      // have thrown after a successful rename. Treat that as success only if
      // the immutable final bytes can be read back and match exactly.
      if (!(await finalTextMatches(backend, finalPath, data))) throw error;
    }
  } finally {
    await bestEffortRemove(backend, tempPath);
  }
}

export async function writeImmutableBinary(
  backend: StateBackend,
  finalPath: string,
  data: ArrayBuffer
): Promise<void> {
  await backend.mkdirp(parentStatePath(finalPath));
  const expectedHash = await sha256Hex(data);

  if (await backend.exists(finalPath)) {
    const existing = await backend.readBinary(finalPath);
    if (existing.byteLength !== data.byteLength || (await sha256Hex(existing)) !== expectedHash) {
      throw new Error(`Immutable binary collision at ${finalPath}.`);
    }
    return;
  }

  const tempPath = siblingTempPath(finalPath);
  try {
    try {
      await backend.writeBinary(tempPath, data);
      const staged = await backend.readBinary(tempPath);
      if (!equalBytes(staged, data)) throw new Error(`Staged binary verification failed for ${finalPath}.`);

      if (await backend.exists(finalPath)) {
        const existing = await backend.readBinary(finalPath);
        if (existing.byteLength !== data.byteLength || (await sha256Hex(existing)) !== expectedHash) {
          throw new Error(`Immutable binary collision at ${finalPath}.`);
        }
        return;
      }

      await backend.rename(tempPath, finalPath);
      const committed = await backend.readBinary(finalPath);
      if (!equalBytes(committed, data)) throw new Error(`Committed binary verification failed for ${finalPath}.`);
    } catch (error) {
      if (!(await finalBinaryMatches(backend, finalPath, data, expectedHash))) throw error;
    }
  } finally {
    await bestEffortRemove(backend, tempPath);
  }
}

async function finalTextMatches(backend: StateBackend, path: string, expected: string): Promise<boolean> {
  try {
    return (await backend.exists(path)) && (await backend.readText(path)) === expected;
  } catch {
    return false;
  }
}

async function finalBinaryMatches(
  backend: StateBackend,
  path: string,
  expected: ArrayBuffer,
  expectedHash: string
): Promise<boolean> {
  try {
    if (!(await backend.exists(path))) return false;
    const actual = await backend.readBinary(path);
    return actual.byteLength === expected.byteLength && (await sha256Hex(actual)) === expectedHash;
  } catch {
    return false;
  }
}

export async function bestEffortRemove(backend: StateBackend, path: string): Promise<void> {
  try {
    await backend.remove(path);
  } catch {
    // Temporary files are ignored by readers; cleanup can be retried later.
  }
}

function siblingTempPath(finalPath: string): string {
  const parent = parentStatePath(finalPath);
  const name = stateBaseName(finalPath);
  const temp = `.${name}.${randomId("tmp")}.tmp`;
  return parent ? `${parent}/${temp}` : temp;
}
