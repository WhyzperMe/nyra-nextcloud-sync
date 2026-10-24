import type { DataAdapter, Vault } from "obsidian";
import type { Logger } from "../diagnostics/logger";
import { isSha256Hex, sha256Hex } from "../state/durable/crypto";
import { canonicalVaultRelativePath } from "../state/durable/path";
import { randomId } from "../state/durable/ids";
import { chunkBounds } from "../transfer/chunking";
import { IncrementalSha256 } from "../transfer/incremental-sha256";
import { isWithinLocalReadBudget } from "../local/read-budget";
import { getPluginDeviceRuntimeRoot } from "../platform/device-scope";

interface ApplyManifestV1 {
  version: 1;
  operationId: string;
  kind: "replace" | "move";
  sourcePath: string | null;
  targetPath: string;
  stagingPath: string | null;
  recoveryPath: string | null;
  expectedSourceHash: string | null;
  desiredHash: string;
  createdAt: string;
}

interface ApplyManifestV2 {
  version: 2;
  operationId: string;
  kind: "replace" | "move";
  sourcePath: string | null;
  targetPath: string;
  stagingPath: string | null;
  recoveryPath: string | null;
  expectedSourceHash: string | null;
  desiredHash: string;
  desiredSize: number;
  createdAt: string;
}

interface ApplyManifestV3 {
  version: 3;
  operationId: string;
  kind: "delete";
  sourcePath: null;
  targetPath: string;
  stagingPath: null;
  recoveryPath: string;
  expectedSourceHash: string;
  desiredHash: string;
  desiredSize: number;
  createdAt: string;
}

type ApplyManifest = ApplyManifestV1 | ApplyManifestV2 | ApplyManifestV3;

export interface LocalWriteResult {
  path: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
}

export interface PreparedLocalSnapshot {
  readonly snapshotId: string;
  readonly path: string;
  readonly contentHash: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly chunkSize: number;
  readonly chunkCount: number;
  readChunk(index: number): Promise<ArrayBuffer>;
  chunks(): AsyncIterable<ArrayBuffer>;
  assertSourceUnchanged(): Promise<void>;
  cleanup(): Promise<void>;
}

export class LocalTransactionalMutator {
  private readonly adapter: DataAdapter;
  private readonly root: string;
  private readonly journalDir: string;
  private readonly stagingDir: string;
  private readonly recoveryDir: string;
  private readonly snapshotDir: string;
  private readonly legacyJournalDir: string;
  private readonly pluginDataRoot: string;
  private readonly reservedWorkspaceFiles: ReadonlySet<string>;
  private readonly maxWholeFileBytes: number;

  constructor(
    vault: Vault,
    pluginId: string,
    private readonly logger: Logger,
    deviceScope: string,
    maxWholeFileBytes = 128 * 1024 * 1024
  ) {
    if (!Number.isSafeInteger(maxWholeFileBytes) || maxWholeFileBytes <= 0) throw new Error("Local whole-file read limit must be a positive safe integer.");
    this.adapter = vault.adapter;
    this.maxWholeFileBytes = maxWholeFileBytes;
    this.root = `${getPluginDeviceRuntimeRoot(vault.configDir, pluginId, deviceScope)}/apply`;
    this.legacyJournalDir = `${vault.configDir}/plugins/${pluginId}/runtime-apply/journal`;
    this.pluginDataRoot = `${vault.configDir}/plugins/${pluginId}`;
    this.reservedWorkspaceFiles = new Set([`${vault.configDir}/workspace.json`, `${vault.configDir}/workspace-mobile.json`]);
    this.journalDir = `${this.root}/journal`;
    this.stagingDir = `${this.root}/staging`;
    this.recoveryDir = `${this.root}/recovery`;
    this.snapshotDir = `${getPluginDeviceRuntimeRoot(vault.configDir, pluginId, deviceScope)}/transfer/local-snapshots`;
  }

  async initializeAndRecover(): Promise<void> {
    await this.assertNoUnscopedRecoveryManifest();
    await Promise.all([this.mkdirp(this.journalDir), this.mkdirp(this.stagingDir), this.mkdirp(this.recoveryDir), this.mkdirp(this.snapshotDir)]);
    const listing = await this.adapter.list(this.journalDir);
    for (const path of listing.files.sort()) {
      if (!path.endsWith(".json")) continue;
      try {
        const raw = await this.adapter.read(path);
        const manifest = this.parseApplyManifest(path, JSON.parse(raw) as unknown);
        await this.recoverManifest(path, manifest);
      } catch (error) {
        this.logger.error("apply.local-recovery-failed", { path, error: error instanceof Error ? error.message : String(error) });
        throw new Error(`Local apply recovery failed for ${path}. Refusing further execution.`);
      }
    }
    await this.cleanupOrphanStaging();
    await this.cleanupOrphanSnapshots();
  }

  async readVerified(pathInput: string, expectedHash?: string | null): Promise<LocalWriteResult & { bytes: ArrayBuffer }> {
    const path = canonicalVaultRelativePath(pathInput);
    const first = await this.adapter.stat(path);
    if (!first || first.type !== "file") throw new Error(`Local precondition failed: '${path}' is missing.`);
    this.assertWithinMemoryLimit(path, first.size);
    const bytes = await this.adapter.readBinary(path);
    const second = await this.adapter.stat(path);
    if (!second || second.type !== "file" || second.size !== first.size || second.mtime !== first.mtime || bytes.byteLength !== second.size) {
      throw new Error(`Local precondition failed: '${path}' changed while being read.`);
    }
    const contentHash = await sha256Hex(bytes);
    if (expectedHash && contentHash !== expectedHash) throw new Error(`Local precondition failed: '${path}' content changed since planning.`);
    return { path, bytes, contentHash, size: bytes.byteLength, mtimeMs: second.mtime };
  }

  async prepareSnapshot(pathInput: string, expectedHash: string, chunkSize: number): Promise<PreparedLocalSnapshot> {
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("Snapshot chunk size must be a positive safe integer.");
    const verified = await this.readVerified(pathInput, expectedHash);
    const snapshotId = randomId("snapshot");
    const dir = `${this.snapshotDir}/${snapshotId}`;
    await this.mkdirp(dir);
    const chunkCount = Math.max(1, Math.ceil(verified.size / chunkSize));
    const hasher = new IncrementalSha256();
    try {
      if (verified.size === 0) {
        const empty = new ArrayBuffer(0);
        await this.adapter.writeBinary(`${dir}/00000.bin`, empty);
        hasher.update(empty);
      } else {
        const bytes = new Uint8Array(verified.bytes);
        for (let index = 0; index < chunkCount; index += 1) {
          const bounds = chunkBounds(index, verified.size, chunkSize);
          const copy = new Uint8Array(bounds.size);
          copy.set(bytes.subarray(bounds.start, bounds.endExclusive));
          const chunk = copy.buffer;
          const path = `${dir}/${String(index).padStart(5, "0")}.bin`;
          await this.adapter.writeBinary(path, chunk);
          const readBack = await this.adapter.readBinary(path);
          if (readBack.byteLength !== bounds.size) throw new Error("Local transfer snapshot chunk failed size verification.");
          hasher.update(readBack);
        }
      }
      if (hasher.digestHex() !== expectedHash) throw new Error("Local transfer snapshot failed SHA-256 verification.");
      const after = await this.adapter.stat(verified.path);
      if (!after || after.type !== "file" || after.size !== verified.size || after.mtime !== verified.mtimeMs) {
        throw new Error(`Local source '${verified.path}' changed while the transfer snapshot was being prepared.`);
      }
      return new AdapterPreparedSnapshot(
        this.adapter, dir, snapshotId, verified.path, expectedHash, verified.size, verified.mtimeMs, chunkSize, chunkCount,
        async () => this.assertSourceStillMatches(verified.path, expectedHash, verified.size, verified.mtimeMs),
        async () => this.removeSnapshotDirectory(dir, snapshotId)
      );
    } catch (error) {
      await this.removeSnapshotDirectory(dir, snapshotId);
      throw error;
    }
  }

  async writeAtomic(targetInput: string, bytes: ArrayBuffer, expectedCurrentHash: string | null): Promise<LocalWriteResult> {
    return await this.writeAtomicFromChunks(targetInput, singleChunk(bytes), expectedCurrentHash, await sha256Hex(bytes), bytes.byteLength);
  }

  async writeAtomicFromChunks(
    targetInput: string,
    chunks: AsyncIterable<ArrayBuffer>,
    expectedCurrentHash: string | null,
    desiredHash: string | null,
    desiredSize: number
  ): Promise<LocalWriteResult> {
    const targetPath = this.assertMutableVaultPath(targetInput);
    if (!Number.isSafeInteger(desiredSize) || desiredSize < 0) throw new Error("Desired local size must be a non-negative safe integer.");
    this.assertWithinMemoryLimit(targetPath, desiredSize);
    const existing = await this.adapter.stat(targetPath);
    if (expectedCurrentHash === null) {
      if (existing) throw new Error(`Local create precondition failed: '${targetPath}' already exists.`);
    } else {
      await this.readVerified(targetPath, expectedCurrentHash);
    }

    const operationId = randomId("apply");
    const stagingPath = `${this.stagingDir}/${operationId}.bin`;
    const recoveryPath = existing ? `${this.recoveryDir}/${operationId}.bak` : null;
    await this.ensureParent(targetPath);
    const hasher = new IncrementalSha256();
    let writtenSize = 0;
    const manifestPath = `${this.journalDir}/${operationId}.json`;
    let manifest: ApplyManifestV2;
    let committedHash: string;
    try {
      await this.adapter.writeBinary(stagingPath, new ArrayBuffer(0));
      for await (const chunk of chunks) {
        if (chunk.byteLength === 0) continue;
        writtenSize += chunk.byteLength;
        if (!Number.isSafeInteger(writtenSize) || writtenSize > desiredSize) throw new Error("Local staged stream exceeded the expected size.");
        hasher.update(chunk);
        await this.adapter.appendBinary(stagingPath, chunk);
      }
      const stagedHash = hasher.digestHex();
      if (writtenSize !== desiredSize) throw new Error(`Local staging size mismatch: expected ${desiredSize}, wrote ${writtenSize}.`);
      if (desiredHash !== null && stagedHash !== desiredHash) throw new Error("Local staging SHA-256 verification failed.");
      committedHash = stagedHash;
      const stagedStat = await this.adapter.stat(stagingPath);
      if (!stagedStat || stagedStat.type !== "file" || stagedStat.size !== desiredSize) throw new Error("Local staging postcondition failed.");

      manifest = {
        version: 2, operationId, kind: "replace", sourcePath: null, targetPath, stagingPath, recoveryPath,
        expectedSourceHash: expectedCurrentHash, desiredHash: committedHash, desiredSize, createdAt: new Date().toISOString()
      };
      await this.writeManifest(manifestPath, manifest);
    } catch (error) {
      // If a manifest reached durable storage, startup recovery owns the staged
      // data. Otherwise it is safe to discard this incomplete temporary file.
      const manifestMayExist = await this.adapter.exists(manifestPath).catch(() => true);
      if (!manifestMayExist && await this.adapter.exists(stagingPath).catch(() => false)) {
        try { await this.adapter.remove(stagingPath); }
        catch (cleanupError) {
          this.logger.warn("apply.local-staging-cleanup-failed", { operationId, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
        }
      }
      throw error;
    }

    try {
      if (recoveryPath) {
        await this.adapter.rename(targetPath, recoveryPath);
        if (!expectedCurrentHash || !(await this.pathHasHash(recoveryPath, expectedCurrentHash))) {
          if (!(await this.adapter.exists(targetPath))) {
            const moved = await this.readVerified(recoveryPath);
            await this.adapter.rename(recoveryPath, targetPath);
            const restored = await this.readVerified(targetPath);
            if (restored.contentHash !== moved.contentHash || restored.size !== moved.size) {
              throw new Error(`Local source '${targetPath}' changed during replacement and could not be restored exactly.`);
            }
            await this.removeManifestIfPresent(manifestPath);
          }
          throw new Error(`Local source '${targetPath}' changed before replacement; its current version was preserved.`);
        }
      }
      await this.adapter.rename(stagingPath, targetPath);
      if (!await this.pathHasHash(targetPath, committedHash, desiredSize)) throw new Error(`Local replace hash verification failed for '${targetPath}'.`);
      const finalStat = await this.adapter.stat(targetPath);
      if (!finalStat || finalStat.type !== "file") throw new Error(`Local replace postcondition failed for '${targetPath}'.`);
      await this.removeVerifiedRecovery(manifest);
      await this.adapter.remove(manifestPath);
      return { path: targetPath, contentHash: committedHash, size: desiredSize, mtimeMs: finalStat.mtime };
    } catch (error) {
      // Some adapters can report an error after an atomic rename has already
      // committed. Prove the visible target before attempting rollback so an
      // ambiguous completion never turns a successful replace into data loss.
      if (await this.pathHasHash(targetPath, committedHash, desiredSize).catch(() => false)) {
        await this.removeVerifiedRecovery(manifest);
        await this.removeVerifiedStaging(manifest);
        if (await this.adapter.exists(manifestPath)) await this.adapter.remove(manifestPath);
        const finalStat = await this.adapter.stat(targetPath);
        if (!finalStat || finalStat.type !== "file") throw error;
        this.logger.warn("apply.local-ambiguous-replace-reconciled", { operationId, targetPath });
        return { path: targetPath, contentHash: committedHash, size: desiredSize, mtimeMs: finalStat.mtime };
      }
      let rollbackSucceeded = false;
      if (manifest.recoveryPath) {
        try { await this.rollbackReplace(manifest); rollbackSucceeded = true; }
        catch (rollbackError) {
          this.logger.error("apply.local-rollback-failed", { operationId, error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) });
        }
      }
      if (rollbackSucceeded) {
        await this.removeVerifiedStaging(manifest);
        if (await this.adapter.exists(manifestPath)) await this.adapter.remove(manifestPath);
      }
      throw error;
    }
  }

  async deleteVerified(pathInput: string, expectedHash: string): Promise<void> {
    const path = this.assertMutableVaultPath(pathInput);
    const verified = await this.readVerified(path, expectedHash);
    const operationId = randomId("apply");
    const recoveryPath = `${this.recoveryDir}/${operationId}.bak`;
    const manifestPath = `${this.journalDir}/${operationId}.json`;
    const manifest: ApplyManifestV3 = {
      version: 3, operationId, kind: "delete", sourcePath: null, targetPath: path,
      stagingPath: null, recoveryPath, expectedSourceHash: expectedHash, desiredHash: expectedHash,
      desiredSize: verified.size, createdAt: new Date().toISOString()
    };
    await this.writeManifest(manifestPath, manifest);

    try {
      await this.adapter.rename(path, recoveryPath);
    } catch (error) {
      const [sourceMatches, backupMatches] = await Promise.all([
        this.pathHasHash(path, expectedHash, verified.size).catch(() => false),
        this.pathHasHash(recoveryPath, expectedHash, verified.size).catch(() => false)
      ]);
      if (!backupMatches) {
        if (sourceMatches) await this.removeManifestIfPresent(manifestPath);
        throw error;
      }
      this.logger.warn("apply.local-delete-ambiguous-rename-reconciled", { operationId, path });
    }

    if (!(await this.pathHasHash(recoveryPath, expectedHash, verified.size))) {
      if (!(await this.adapter.exists(path))) {
        const moved = await this.readVerified(recoveryPath);
        await this.adapter.rename(recoveryPath, path);
        const restored = await this.readVerified(path);
        if (restored.contentHash !== moved.contentHash || restored.size !== moved.size) {
          throw new Error(`Local delete for '${path}' changed during the operation; restored bytes need review.`);
        }
        await this.removeManifestIfPresent(manifestPath);
      }
      throw new Error(`Local delete for '${path}' changed during the operation; recovery evidence was preserved.`);
    }

    if (await this.adapter.exists(path)) {
      throw new Error(`Local file '${path}' reappeared during delete; both versions were preserved for review.`);
    }

    // Removing intent first means a crash leaves, at worst, a verified extra
    // recovery copy. The same bytes are also retained in the verified BASE blob.
    await this.removeManifestIfPresent(manifestPath);
    try {
      if (await this.adapter.exists(recoveryPath)) await this.adapter.remove(recoveryPath);
    } catch (error) {
      this.logger.warn("apply.local-delete-recovery-copy-retained", { operationId, error: error instanceof Error ? error.message : String(error) });
    }
    if (await this.adapter.exists(path)) throw new Error(`Local delete for '${path}' raced a new file; the new file was preserved.`);
  }

  async moveAtomic(sourceInput: string, targetInput: string, expectedHash: string): Promise<LocalWriteResult> {
    const sourcePath = this.assertMutableVaultPath(sourceInput);
    const targetPath = this.assertMutableVaultPath(targetInput);
    if (sourcePath === targetPath) {
      const value = await this.readVerified(sourcePath, expectedHash);
      return { path: value.path, contentHash: value.contentHash, size: value.size, mtimeMs: value.mtimeMs };
    }
    if (await this.adapter.exists(targetPath)) throw new Error(`Local move precondition failed: '${targetPath}' already exists.`);
    const source = await this.readVerified(sourcePath, expectedHash);
    await this.ensureParent(targetPath);
    const operationId = randomId("apply");
    const manifest: ApplyManifestV2 = {
      version: 2, operationId, kind: "move", sourcePath, targetPath, stagingPath: null, recoveryPath: null,
      expectedSourceHash: expectedHash, desiredHash: expectedHash, desiredSize: source.size, createdAt: new Date().toISOString()
    };
    const manifestPath = `${this.journalDir}/${operationId}.json`;
    await this.writeManifest(manifestPath, manifest);
    try {
      await this.adapter.rename(sourcePath, targetPath);
    } catch (error) {
      const [sourceExists, targetMatches] = await Promise.all([
        this.adapter.exists(sourcePath),
        this.pathHasHash(targetPath, expectedHash, source.size).catch(() => false)
      ]);
      if (sourceExists || !targetMatches) throw error;
      this.logger.warn("apply.local-ambiguous-move-reconciled", { operationId, sourcePath, targetPath });
    }
    const verified = await this.readVerified(targetPath, expectedHash);
    if (await this.adapter.exists(manifestPath)) await this.adapter.remove(manifestPath);
    return { path: targetPath, contentHash: verified.contentHash, size: verified.size, mtimeMs: verified.mtimeMs };
  }

  private async recoverManifest(manifestPath: string, manifest: ApplyManifest): Promise<void> {
    if (manifest.version === 3) {
      await this.recoverDeleteManifest(manifestPath, manifest);
      return;
    }
    if (manifest.kind === "replace") {
      const desiredSize = manifest.version === 2 ? manifest.desiredSize : undefined;
      const targetMatches = await this.pathHasHash(manifest.targetPath, manifest.desiredHash, desiredSize);
      if (targetMatches) {
        await this.removeVerifiedRecovery(manifest);
        await this.removeVerifiedStaging(manifest);
        await this.adapter.remove(manifestPath);
        this.logger.warn("apply.local-recovered-committed", { operationId: manifest.operationId, targetPath: manifest.targetPath });
        return;
      }
      if (manifest.recoveryPath && await this.adapter.exists(manifest.recoveryPath)) {
        if (!manifest.expectedSourceHash || !(await this.pathHasHash(manifest.recoveryPath, manifest.expectedSourceHash))) {
          throw new Error("Local recovery backup does not match the recorded source hash; preserving all evidence.");
        }
        if (await this.adapter.exists(manifest.targetPath)) {
          if (!(await this.pathHasHash(manifest.targetPath, manifest.expectedSourceHash))) {
            throw new Error("Local target changed to an unrecognized version during recovery; preserving all evidence.");
          }
          await this.removeVerifiedRecovery(manifest);
        } else {
          await this.adapter.rename(manifest.recoveryPath, manifest.targetPath);
          if (!(await this.pathHasHash(manifest.targetPath, manifest.expectedSourceHash))) {
            throw new Error("Restored local recovery backup failed source-hash verification.");
          }
        }
        await this.removeVerifiedStaging(manifest);
        await this.adapter.remove(manifestPath);
        this.logger.warn("apply.local-recovered-rollback", { operationId: manifest.operationId, targetPath: manifest.targetPath });
        return;
      }
      if (manifest.expectedSourceHash !== null && await this.pathHasHash(manifest.targetPath, manifest.expectedSourceHash)) {
        // The process stopped after publishing intent but before moving the old
        // target to recovery. Keep the untouched user file and discard the new
        // staged bytes instead of treating this safe boundary as corruption.
        await this.removeVerifiedStaging(manifest);
        await this.adapter.remove(manifestPath);
        this.logger.warn("apply.local-recovered-before-replace", { operationId: manifest.operationId, targetPath: manifest.targetPath });
        return;
      }
      if (manifest.expectedSourceHash === null && !(await this.adapter.exists(manifest.targetPath)) && manifest.stagingPath && await this.adapter.exists(manifest.stagingPath)) {
        if (!(await this.pathHasHash(manifest.stagingPath, manifest.desiredHash, desiredSize))) {
          throw new Error("Local staging bytes do not match the recorded desired hash; preserving all evidence.");
        }
        await this.adapter.rename(manifest.stagingPath, manifest.targetPath);
        const ok = await this.pathHasHash(manifest.targetPath, manifest.desiredHash, desiredSize);
        if (!ok) throw new Error("Recovered staging bytes failed hash verification.");
        await this.adapter.remove(manifestPath);
        return;
      }
      throw new Error("Cannot prove a safe recovery action for interrupted local replace.");
    }

    if (!manifest.sourcePath) throw new Error("Interrupted move manifest lacks source path.");
    const expectedSize = manifest.version === 2 ? manifest.desiredSize : undefined;
    const sourceMatches = await this.pathHasHash(manifest.sourcePath, manifest.desiredHash, expectedSize);
    const targetMatches = await this.pathHasHash(manifest.targetPath, manifest.desiredHash, expectedSize);
    if (targetMatches && !sourceMatches) {
      await this.adapter.remove(manifestPath);
      this.logger.warn("apply.local-recovered-move", { operationId: manifest.operationId, targetPath: manifest.targetPath });
      return;
    }
    if (sourceMatches && !targetMatches) {
      await this.adapter.remove(manifestPath);
      return;
    }
    throw new Error("Cannot prove a safe recovery action for interrupted local move.");
  }

  private async recoverDeleteManifest(manifestPath: string, manifest: ApplyManifestV3): Promise<void> {
    const recoveryExists = await this.adapter.exists(manifest.recoveryPath);
    const targetExists = await this.adapter.exists(manifest.targetPath);
    if (!recoveryExists) {
      if (targetExists && await this.pathHasHash(manifest.targetPath, manifest.expectedSourceHash, manifest.desiredSize)) {
        await this.adapter.remove(manifestPath);
        return;
      }
      throw new Error("Interrupted local delete has no verified source or recovery copy; preserving its manifest.");
    }

    const backup = await this.readVerified(manifest.recoveryPath);
    const backupMatches = backup.contentHash === manifest.expectedSourceHash && backup.size === manifest.desiredSize;
    if (!backupMatches) {
      if (targetExists) throw new Error("Changed local delete recovery bytes and a new target both exist; preserving both.");
      await this.adapter.rename(manifest.recoveryPath, manifest.targetPath);
      const restored = await this.readVerified(manifest.targetPath);
      if (restored.contentHash !== backup.contentHash || restored.size !== backup.size) {
        throw new Error("Changed local delete bytes failed verification after restoration.");
      }
      await this.adapter.remove(manifestPath);
      this.logger.warn("apply.local-delete-recovery-restored-changed-bytes", { operationId: manifest.operationId, path: manifest.targetPath });
      return;
    }

    if (targetExists) {
      if (!(await this.pathHasHash(manifest.targetPath, manifest.expectedSourceHash, manifest.desiredSize))) {
        throw new Error("Local delete target changed during recovery; preserving the target and recovery copy.");
      }
      await this.removeVerifiedRecovery(manifest);
      await this.adapter.remove(manifestPath);
      return;
    }

    // A restart before durable replica publication rolls an interrupted delete
    // back to the vault. A fresh inventory can then safely plan it again.
    await this.adapter.rename(manifest.recoveryPath, manifest.targetPath);
    if (!(await this.pathHasHash(manifest.targetPath, manifest.expectedSourceHash, manifest.desiredSize))) {
      throw new Error("Local delete rollback failed exact content verification.");
    }
    await this.adapter.remove(manifestPath);
  }

  private async removeManifestIfPresent(manifestPath: string): Promise<void> {
    try {
      if (await this.adapter.exists(manifestPath)) await this.adapter.remove(manifestPath);
    } catch (error) {
      if (await this.adapter.exists(manifestPath).catch(() => true)) throw error;
    }
  }

  private async rollbackReplace(manifest: ApplyManifest): Promise<void> {
    if (manifest.recoveryPath && await this.adapter.exists(manifest.recoveryPath)) {
      if (!manifest.expectedSourceHash || !(await this.pathHasHash(manifest.recoveryPath, manifest.expectedSourceHash))) {
        throw new Error("Local rollback backup does not match the recorded source hash; preserving all evidence.");
      }
      if (await this.adapter.exists(manifest.targetPath)) {
        if (await this.pathHasHash(manifest.targetPath, manifest.expectedSourceHash)) {
          await this.removeVerifiedRecovery(manifest);
          return;
        }
        throw new Error("Local rollback target contains an unrecognized version; preserving all evidence.");
      }
      await this.adapter.rename(manifest.recoveryPath, manifest.targetPath);
      if (!(await this.pathHasHash(manifest.targetPath, manifest.expectedSourceHash))) {
        throw new Error("Local rollback failed source-hash verification.");
      }
    }
  }

  private async removeVerifiedRecovery(manifest: ApplyManifest): Promise<void> {
    if (!manifest.recoveryPath || !(await this.adapter.exists(manifest.recoveryPath))) return;
    const expectedSize = manifest.version === 3 ? manifest.desiredSize : undefined;
    if (!manifest.expectedSourceHash || !(await this.pathHasHash(manifest.recoveryPath, manifest.expectedSourceHash, expectedSize))) {
      throw new Error("Local recovery backup does not match the recorded source hash; preserving it.");
    }
    await this.adapter.remove(manifest.recoveryPath);
  }

  private async removeVerifiedStaging(manifest: ApplyManifest): Promise<void> {
    if (!manifest.stagingPath || !(await this.adapter.exists(manifest.stagingPath))) return;
    const desiredSize = manifest.version === 2 ? manifest.desiredSize : undefined;
    if (!(await this.pathHasHash(manifest.stagingPath, manifest.desiredHash, desiredSize))) {
      throw new Error("Local staging artifact does not match the recorded desired hash; preserving it.");
    }
    await this.adapter.remove(manifest.stagingPath);
  }

  private async pathHasHash(path: string, hash: string, expectedSize?: number): Promise<boolean> {
    const before = await this.adapter.stat(path);
    if (!before || before.type !== "file") return false;
    this.assertWithinMemoryLimit(path, before.size);
    if (expectedSize !== undefined && before.size !== expectedSize) return false;
    const bytes = await this.adapter.readBinary(path);
    const after = await this.adapter.stat(path);
    if (!after || after.type !== "file" || after.size !== before.size || after.mtime !== before.mtime || bytes.byteLength !== after.size) return false;
    return await sha256Hex(bytes) === hash;
  }

  private async assertSourceStillMatches(path: string, hash: string, size: number, mtimeMs: number): Promise<void> {
    const stat = await this.adapter.stat(path);
    if (!stat || stat.type !== "file" || stat.size !== size || stat.mtime !== mtimeMs) throw new Error(`Local source '${path}' changed during transfer.`);
    this.assertWithinMemoryLimit(path, size);
    // Metadata is a fast fence; hash is the authoritative precondition.
    const current = await this.adapter.readBinary(path);
    if (current.byteLength !== size || (await sha256Hex(current)) !== hash) throw new Error(`Local source '${path}' content changed during transfer.`);
  }

  private assertWithinMemoryLimit(path: string, size: number): void {
    if (!isWithinLocalReadBudget(size, this.maxWholeFileBytes)) {
      throw new Error(`Refusing whole-file read for '${path}' above the configured ${this.maxWholeFileBytes}-byte local memory limit.`);
    }
  }

  private async writeManifest(path: string, manifest: ApplyManifest): Promise<void> {
    const data = JSON.stringify(manifest);
    const temp = `${path}.${randomId("tmp")}.tmp`;
    try {
      await this.adapter.write(temp, data);
      if ((await this.adapter.read(temp)) !== data) throw new Error("Local apply manifest staging verification failed.");
      await this.adapter.rename(temp, path);
      if ((await this.adapter.read(path)) !== data) throw new Error("Local apply manifest commit verification failed.");
    } finally {
      if (await this.adapter.exists(temp)) await this.adapter.remove(temp);
    }
  }

  private parseApplyManifest(manifestPath: string, raw: unknown): ApplyManifest {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Local apply manifest must be a JSON object.");
    const value = raw as Record<string, unknown>;
    const version = value.version;
    if (version !== 1 && version !== 2 && version !== 3) throw new Error("Unknown local apply manifest format.");
    const fields = version === 1
      ? ["version", "operationId", "kind", "sourcePath", "targetPath", "stagingPath", "recoveryPath", "expectedSourceHash", "desiredHash", "createdAt"]
      : ["version", "operationId", "kind", "sourcePath", "targetPath", "stagingPath", "recoveryPath", "expectedSourceHash", "desiredHash", "desiredSize", "createdAt"];
    const keys = Object.keys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
      throw new Error("Local apply manifest contains missing or unknown fields.");
    }

    const operationId = value.operationId;
    if (typeof operationId !== "string" || !/^apply_[a-f0-9]{32}$/.test(operationId)) {
      throw new Error("Local apply manifest has an invalid operation ID.");
    }
    if (manifestPath !== `${this.journalDir}/${operationId}.json`) {
      throw new Error("Local apply manifest filename does not match its operation ID.");
    }

    const kind = value.kind;
    if (typeof value.targetPath !== "string") throw new Error("Local apply manifest target path is invalid.");
    const targetPath = this.assertMutableVaultPath(value.targetPath);
    if (targetPath !== value.targetPath) throw new Error("Local apply manifest target path is not canonical.");
    let sourcePath: string | null;
    if (value.sourcePath === null) sourcePath = null;
    else if (typeof value.sourcePath === "string") sourcePath = this.assertMutableVaultPath(value.sourcePath);
    else throw new Error("Local apply manifest source path is invalid.");
    if (sourcePath !== value.sourcePath) throw new Error("Local apply manifest source path is not canonical.");

    const stagingPath = value.stagingPath;
    const recoveryPath = value.recoveryPath;
    const expectedSourceHash = value.expectedSourceHash;
    const desiredHash = value.desiredHash;
    const createdAt = value.createdAt;
    if (stagingPath !== null && stagingPath !== `${this.stagingDir}/${operationId}.bin`) {
      throw new Error("Local apply manifest staging path is outside its generated recovery scope.");
    }
    if (recoveryPath !== null && recoveryPath !== `${this.recoveryDir}/${operationId}.bak`) {
      throw new Error("Local apply manifest backup path is outside its generated recovery scope.");
    }
    if (expectedSourceHash !== null && !isSha256Hex(expectedSourceHash)) throw new Error("Local apply manifest source hash is invalid.");
    if (!isSha256Hex(desiredHash)) throw new Error("Local apply manifest desired hash is invalid.");
    if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) throw new Error("Local apply manifest timestamp is invalid.");

    if (version === 3) {
      if (kind !== "delete") throw new Error("Local delete manifest has an invalid operation kind.");
      const desiredSize = value.desiredSize;
      if (typeof desiredSize !== "number" || !Number.isSafeInteger(desiredSize) || desiredSize < 0) {
        throw new Error("Local delete manifest size is invalid.");
      }
      if (sourcePath !== null || stagingPath !== null || recoveryPath !== `${this.recoveryDir}/${operationId}.bak` ||
        expectedSourceHash === null || expectedSourceHash !== desiredHash) {
        throw new Error("Local delete manifest has inconsistent identity or recovery paths.");
      }
      return {
        version, operationId, kind, sourcePath, targetPath,
        stagingPath: null, recoveryPath, expectedSourceHash, desiredHash, desiredSize, createdAt
      };
    }

    if (kind !== "replace" && kind !== "move") throw new Error("Local apply manifest has an invalid operation kind.");
    if (kind === "replace") {
      if (sourcePath !== null || stagingPath !== `${this.stagingDir}/${operationId}.bin`) {
        throw new Error("Local replace manifest has inconsistent source or staging paths.");
      }
      if ((expectedSourceHash === null) !== (recoveryPath === null)) {
        throw new Error("Local replace manifest has inconsistent source hash and recovery backup.");
      }
    } else {
      if (!sourcePath || sourcePath === targetPath || stagingPath !== null || recoveryPath !== null || expectedSourceHash === null || expectedSourceHash !== desiredHash) {
        throw new Error("Local move manifest has inconsistent source, destination, or content identity.");
      }
    }

    if (version === 1) {
      return {
        version, operationId, kind, sourcePath, targetPath,
        stagingPath: stagingPath as string | null, recoveryPath: recoveryPath as string | null,
        expectedSourceHash: expectedSourceHash as string | null, desiredHash, createdAt
      };
    }
    const desiredSize = value.desiredSize;
    if (typeof desiredSize !== "number" || !Number.isSafeInteger(desiredSize) || desiredSize < 0) {
      throw new Error("Local apply manifest desired size is invalid.");
    }
    return {
      version, operationId, kind, sourcePath, targetPath,
      stagingPath: stagingPath as string | null, recoveryPath: recoveryPath as string | null,
      expectedSourceHash: expectedSourceHash as string | null, desiredHash, desiredSize, createdAt
    };
  }

  private assertMutableVaultPath(pathInput: string): string {
    const path = canonicalVaultRelativePath(pathInput);
    if (path === this.pluginDataRoot || path.startsWith(`${this.pluginDataRoot}/`) || this.reservedWorkspaceFiles.has(path)) {
      throw new Error("Local apply path targets Nyra runtime or device-specific Obsidian workspace data.");
    }
    return path;
  }

  private async cleanupOrphanSnapshots(): Promise<void> {
    if (!(await this.adapter.exists(this.snapshotDir))) return;
    const listing = await this.adapter.list(this.snapshotDir);
    for (const folder of listing.folders) {
      const snapshotId = directChildName(this.snapshotDir, folder);
      if (!snapshotId || !/^snapshot_[a-f0-9]{32}$/.test(snapshotId)) {
        this.logger.warn("apply.local-unknown-snapshot-evidence-preserved", { path: folder });
        continue;
      }
      await this.removeSnapshotDirectory(folder, snapshotId);
    }
    for (const file of listing.files) this.logger.warn("apply.local-unknown-snapshot-evidence-preserved", { path: file });
  }

  private async cleanupOrphanStaging(): Promise<void> {
    if (!(await this.adapter.exists(this.stagingDir))) return;
    const listing = await this.adapter.list(this.stagingDir);
    for (const file of listing.files) {
      const name = directChildName(this.stagingDir, file);
      if (!name || !/^apply_[a-f0-9]{32}\.bin$/.test(name)) {
        this.logger.warn("apply.local-unknown-staging-evidence-preserved", { path: file });
        continue;
      }
      try { await this.adapter.remove(file); }
      catch (error) { this.logger.warn("apply.local-orphan-staging-cleanup-failed", { path: file, error: error instanceof Error ? error.message : String(error) }); }
    }
    for (const folder of listing.folders) this.logger.warn("apply.local-unknown-staging-evidence-preserved", { path: folder });
  }

  private async removeSnapshotDirectory(dir: string, snapshotId: string): Promise<void> {
    if (!/^snapshot_[a-f0-9]{32}$/.test(snapshotId) || directChildName(this.snapshotDir, dir) !== snapshotId) {
      throw new Error("Refusing to clean a snapshot directory outside its generated runtime scope.");
    }
    if (!(await this.adapter.exists(dir))) return;
    const listing = await this.adapter.list(dir);
    const recognizedFiles = listing.files.filter((file) => {
      const name = directChildName(dir, file);
      return name !== null && /^\d{5}\.bin$/.test(name);
    });
    if (recognizedFiles.length !== listing.files.length || listing.folders.length > 0) {
      this.logger.warn("apply.local-unknown-snapshot-evidence-preserved", { path: dir });
      return;
    }
    for (const file of recognizedFiles) if (await this.adapter.exists(file)) await this.adapter.remove(file);
    const after = await this.adapter.list(dir);
    if (after.files.length > 0 || after.folders.length > 0) return;
    try { await this.adapter.rmdir(dir, false); }
    catch (error) { this.logger.warn("apply.local-snapshot-directory-cleanup-failed", { snapshotId, error: error instanceof Error ? error.message : String(error) }); }
  }

  private async ensureParent(path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return;
    await this.mkdirp(path.slice(0, slash));
  }

  private async mkdirp(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.adapter.exists(current))) {
        try { await this.adapter.mkdir(current); }
        catch (error) { if (!(await this.adapter.exists(current))) throw error; }
      }
    }
  }

  private async assertNoUnscopedRecoveryManifest(): Promise<void> {
    if (!(await this.adapter.exists(this.legacyJournalDir))) return;
    const listing = await this.adapter.list(this.legacyJournalDir);
    const manifests = listing.files.filter((path) => path.endsWith(".json"));
    if (manifests.length > 0) {
      throw new Error(
        "A legacy shared local-recovery record is preserved in the previous runtime folder. Nyra paused sync rather than replay a transaction that may belong to another device. Review that recovery record before continuing."
      );
    }
  }
}

function directChildName(directory: string, path: string): string | null {
  const prefix = `${directory.replace(/\/+$/, "")}/`;
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  return name && !name.includes("/") ? name : null;
}

class AdapterPreparedSnapshot implements PreparedLocalSnapshot {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly dir: string,
    readonly snapshotId: string,
    readonly path: string,
    readonly contentHash: string,
    readonly size: number,
    readonly mtimeMs: number,
    readonly chunkSize: number,
    readonly chunkCount: number,
    private readonly verifySource: () => Promise<void>,
    private readonly cleanupImpl: () => Promise<void>
  ) {}

  async readChunk(index: number): Promise<ArrayBuffer> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.chunkCount) throw new Error("Snapshot chunk index is out of range.");
    const path = `${this.dir}/${String(index).padStart(5, "0")}.bin`;
    const bytes = await this.adapter.readBinary(path);
    const expected = this.size === 0 ? 0 : chunkBounds(index, this.size, this.chunkSize).size;
    if (bytes.byteLength !== expected) throw new Error(`Snapshot chunk ${index} has an unexpected size.`);
    return bytes;
  }

  async *chunks(): AsyncIterable<ArrayBuffer> {
    for (let index = 0; index < this.chunkCount; index += 1) yield await this.readChunk(index);
  }

  async assertSourceUnchanged(): Promise<void> { await this.verifySource(); }
  async cleanup(): Promise<void> { await this.cleanupImpl(); }
}

async function* singleChunk(bytes: ArrayBuffer): AsyncIterable<ArrayBuffer> { yield bytes; }
