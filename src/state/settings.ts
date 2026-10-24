import type { ConnectionState, VerifiedAccount } from "../core/types";
import { normalizeRemoteRootPath, NYRA_REMOTE_RUNTIME_ROOT } from "../remote/path";
import type { TransferTuning } from "../transfer/types";
import type { TextMergeLimits } from "../merge/types";
import { normalizeExcludes } from "../local/selection";
import { MAX_RULES, MAX_RULE_LENGTH } from "../local/user-rules";

export const MAX_SELECTIVE_EXCLUDES = 5_000;

/**
 * Version of the "everything on" defaults. Installations that predate it are upgraded once (auto-sync,
 * deletion propagation with the approval guard, fast polling, text merge); later changes by the user stick.
 */
export const AUTONOMY_DEFAULTS_VERSION = 1;

export const SETTINGS_SCHEMA_VERSION = 8 as const;
const SECRET_ID = /^nyra-nextcloud-[a-f0-9]{32}$/;
const MIB = 1024 * 1024;

export interface CredentialBinding {
  serverUrl: string;
  loginName: string;
  secretId: string;
}

export interface PluginSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  serverUrl: string;
  remoteRootPath: string;
  remoteDirectoryConcurrency: number;
  transferChunkUploadThresholdMiB: number;
  transferUploadChunkMiB: number;
  transferDownloadRangeMiB: number;
  transferMaxWholeDownloadMiB: number;
  /** Sync the .obsidian configuration tree. Notes/attachments always remain in scope. */
  syncObsidianConfig: boolean;
  autoSyncEnabled: boolean;
  autoSyncQuietSeconds: number;
  autoSyncRemotePollSeconds: number;
  autoSyncAllowDeletes: boolean;
  /** Ask before one sync deletes more than this many items; 0 disables the confirmation. */
  deleteConfirmThreshold: number;
  /** Which generation of the autonomous defaults this installation has received. */
  autonomyDefaultsVersion: number;
  /** Auto-sync is paused (manual "Sync now" still works). Persisted across restarts. */
  syncPaused: boolean;
  /** gitignore-style patterns for files and folders that are never synchronized. */
  excludePatterns: string[];
  /** When non-empty, only these vault folders are synchronized. */
  includeFolders: string[];
  /** Exact vault paths (files and folders) the user unchecked in the file picker. */
  selectiveExcludes: string[];
  /** Skip files larger than this many MiB on this vault; 0 uses the device's safe limit. */
  maxFileSizeMiB: number;
  /** Recognize an unchanged remote with one request instead of a full scan on background polls. */
  fastRemoteCheck: boolean;
  /** Attempt only conflict-free bounded BASE/LOCAL/REMOTE merges for Markdown/plain text. */
  autoMergeText: boolean;
  /** Resolve conflicts on their own (newer wins, the other version is kept as a conflict copy; changes beat deletions). */
  autoResolveConflicts: boolean;
  /** Maximum bytes per BASE/LOCAL/REMOTE version considered for automatic text merge. */
  autoMergeMaxMiB: number;
  serverHealthCheckSeconds: number;
  connectionState: ConnectionState;
  account: VerifiedAccount | null;
  pendingLoginName: string | null;
  credentialBinding: CredentialBinding | null;
  lastError: string | null;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  serverUrl: "",
  remoteRootPath: "Obsidian",
  remoteDirectoryConcurrency: 6,
  transferChunkUploadThresholdMiB: 16,
  transferUploadChunkMiB: 16,
  transferDownloadRangeMiB: 8,
  transferMaxWholeDownloadMiB: 16,
  syncObsidianConfig: false,
  autoSyncEnabled: true,
  autoSyncQuietSeconds: 1,
  autoSyncRemotePollSeconds: 15,
  autoSyncAllowDeletes: true,
  deleteConfirmThreshold: 20,
  autonomyDefaultsVersion: AUTONOMY_DEFAULTS_VERSION,
  syncPaused: false,
  excludePatterns: [],
  includeFolders: [],
  selectiveExcludes: [],
  maxFileSizeMiB: 0,
  fastRemoteCheck: true,
  autoMergeText: true,
  autoResolveConflicts: true,
  autoMergeMaxMiB: 2,
  serverHealthCheckSeconds: 60,
  connectionState: "disconnected",
  account: null,
  pendingLoginName: null,
  credentialBinding: null,
  lastError: null
};

/** Normalizes data.json. Authentication secrets never appear in this object. */
export function normalizeSettings(raw: unknown): PluginSettings {
  if (!isRecord(raw)) return { ...DEFAULT_SETTINGS };
  const threshold = safeInteger(raw.transferChunkUploadThresholdMiB, 5, 512, DEFAULT_SETTINGS.transferChunkUploadThresholdMiB);
  const uploadChunk = safeInteger(raw.transferUploadChunkMiB, 5, 512, DEFAULT_SETTINGS.transferUploadChunkMiB);
  const rangeChunk = safeInteger(raw.transferDownloadRangeMiB, 1, 64, DEFAULT_SETTINGS.transferDownloadRangeMiB);
  const wholeDownload = Math.max(
    threshold,
    safeInteger(raw.transferMaxWholeDownloadMiB, 1, 512, DEFAULT_SETTINGS.transferMaxWholeDownloadMiB)
  );
  const upgrade = !(Number.isSafeInteger(raw.autonomyDefaultsVersion) && Number(raw.autonomyDefaultsVersion) >= AUTONOMY_DEFAULTS_VERSION);
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    serverUrl: typeof raw.serverUrl === "string" ? raw.serverUrl : "",
    remoteRootPath: safeRemoteRoot(raw.remoteRootPath),
    remoteDirectoryConcurrency: safeInteger(raw.remoteDirectoryConcurrency, 1, 16, DEFAULT_SETTINGS.remoteDirectoryConcurrency),
    transferChunkUploadThresholdMiB: threshold,
    transferUploadChunkMiB: uploadChunk,
    transferDownloadRangeMiB: rangeChunk,
    transferMaxWholeDownloadMiB: wholeDownload,
    // New installations default to content-only synchronization so a
    // fresh iPad vault can be linked without treating its device-local Obsidian
    // settings as concurrent creations. Existing early installations keep
    // their previous effective behavior unless the user changes this explicitly.
    syncObsidianConfig: typeof raw.syncObsidianConfig === "boolean"
      ? raw.syncObsidianConfig
      : inferLegacyConfigSyncDefault(raw),
    autoSyncEnabled: upgrade || typeof raw.autoSyncEnabled !== "boolean" ? DEFAULT_SETTINGS.autoSyncEnabled : raw.autoSyncEnabled,
    autoSyncQuietSeconds: safeInteger(migrateQuietPeriod(raw), 1, 600, DEFAULT_SETTINGS.autoSyncQuietSeconds),
    autoSyncRemotePollSeconds: safeInteger(migrateRemotePoll(raw), 15, 3600, DEFAULT_SETTINGS.autoSyncRemotePollSeconds),
    deleteConfirmThreshold: safeInteger(raw.deleteConfirmThreshold, 0, 100_000, DEFAULT_SETTINGS.deleteConfirmThreshold),
    syncPaused: raw.syncPaused === true,
    excludePatterns: safeLines(raw.excludePatterns),
    includeFolders: safeLines(raw.includeFolders),
    selectiveExcludes: normalizeExcludes(Array.isArray(raw.selectiveExcludes) ? raw.selectiveExcludes.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_SELECTIVE_EXCLUDES) : []),
    fastRemoteCheck: upgrade || raw.fastRemoteCheck !== false,
    autonomyDefaultsVersion: AUTONOMY_DEFAULTS_VERSION,
    maxFileSizeMiB: safeInteger(raw.maxFileSizeMiB, 0, 4096, DEFAULT_SETTINGS.maxFileSizeMiB),
    // Deletions propagate by default: local files stay recoverable, Nextcloud keeps its trash bin,
    // and the deletion guard asks before a large batch.
    autoSyncAllowDeletes: upgrade || typeof raw.autoSyncAllowDeletes !== "boolean" ? DEFAULT_SETTINGS.autoSyncAllowDeletes : raw.autoSyncAllowDeletes,
    // The bounded conflict-free merge is on by default. Any saved
    // boolean remains authoritative, including an explicit legacy opt-out.
    autoMergeText: upgrade || typeof raw.autoMergeText !== "boolean" ? inferLegacyAutoMergeDefault() : raw.autoMergeText,
    autoResolveConflicts: typeof raw.autoResolveConflicts === "boolean" ? raw.autoResolveConflicts : DEFAULT_SETTINGS.autoResolveConflicts,
    autoMergeMaxMiB: safeInteger(raw.autoMergeMaxMiB, 1, 4, DEFAULT_SETTINGS.autoMergeMaxMiB),
    serverHealthCheckSeconds: safeInteger(raw.serverHealthCheckSeconds, 30, 900, DEFAULT_SETTINGS.serverHealthCheckSeconds),
    connectionState: validConnectionState(raw.connectionState) ? raw.connectionState : DEFAULT_SETTINGS.connectionState,
    account: isVerifiedAccount(raw.account) ? raw.account : null,
    pendingLoginName: typeof raw.pendingLoginName === "string" ? raw.pendingLoginName : null,
    credentialBinding: isCredentialBinding(raw.credentialBinding) ? raw.credentialBinding : null,
    lastError: typeof raw.lastError === "string" ? raw.lastError : null
  };
}

export function transferTuningFromSettings(settings: PluginSettings): TransferTuning {
  return {
    chunkUploadThresholdBytes: settings.transferChunkUploadThresholdMiB * MIB,
    uploadChunkBytes: settings.transferUploadChunkMiB * MIB,
    downloadRangeChunkBytes: settings.transferDownloadRangeMiB * MIB,
    maxWholeDownloadBytes: settings.transferMaxWholeDownloadMiB * MIB
  };
}


export function mergeLimitsFromSettings(settings: PluginSettings): TextMergeLimits {
  return {
    maxInputBytes: settings.autoMergeMaxMiB * MIB,
    maxLines: 12_000,
    maxDiffCells: 8_000_000
  };
}

export function inferLegacyCredentialIdentity(raw: unknown): { serverUrl: string; loginName: string } | null {
  if (!isRecord(raw)) return null;
  const account = isVerifiedAccount(raw.account) ? raw.account : null;
  if (account) return { serverUrl: account.serverUrl, loginName: account.loginName };
  const serverUrl = typeof raw.serverUrl === "string" ? raw.serverUrl : "";
  const loginName = typeof raw.pendingLoginName === "string" ? raw.pendingLoginName : "";
  return serverUrl && loginName ? { serverUrl, loginName } : null;
}


function inferLegacyAutoMergeDefault(): boolean {
  // The merge engine is fail-closed for overlap, binary data, invalid UTF-8,
  // missing BASE and all limit failures, so opting legacy settings in is safe.
  return DEFAULT_SETTINGS.autoMergeText;
}

function migrateQuietPeriod(raw: Record<string, unknown>): unknown {
  return isLegacySettings(raw) && raw.autoSyncQuietSeconds === 30
    ? DEFAULT_SETTINGS.autoSyncQuietSeconds
    : raw.autoSyncQuietSeconds;
}

function migrateRemotePoll(raw: Record<string, unknown>): unknown {
  return isLegacySettings(raw) && raw.autoSyncRemotePollSeconds === 300
    ? DEFAULT_SETTINGS.autoSyncRemotePollSeconds
    : raw.autoSyncRemotePollSeconds;
}

function isLegacySettings(raw: Record<string, unknown>): boolean {
  return typeof raw.schemaVersion !== "number" || raw.schemaVersion < SETTINGS_SCHEMA_VERSION;
}

function inferLegacyConfigSyncDefault(raw: Record<string, unknown>): boolean {
  const version = typeof raw.schemaVersion === "number" ? raw.schemaVersion : null;
  if (version !== null) return version <= 5;
  // Old persisted settings from early versions may not carry a schema field.
  // Presence of established sync fields means preserve legacy all-vault scope.
  return Object.hasOwn(raw, "remoteRootPath") || Object.hasOwn(raw, "connectionState") || Object.hasOwn(raw, "account");
}

function safeRemoteRoot(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SETTINGS.remoteRootPath;
  try {
    const normalized = normalizeRemoteRootPath(value);
    if (normalized === NYRA_REMOTE_RUNTIME_ROOT || normalized.startsWith(`${NYRA_REMOTE_RUNTIME_ROOT}/`)) return DEFAULT_SETTINGS.remoteRootPath;
    return normalized;
  } catch { return DEFAULT_SETTINGS.remoteRootPath; }
}
function safeLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const line = entry.trim();
    if (line && line.length <= MAX_RULE_LENGTH && !lines.includes(line)) lines.push(line);
    if (lines.length >= MAX_RULES) break;
  }
  return lines;
}
function safeInteger(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isSafeInteger(value) ? Math.max(min, Math.min(max, Number(value))) : fallback;
}
function validConnectionState(value: unknown): value is ConnectionState {
  return value === "disconnected" || value === "authenticating" || value === "pending-verification" || value === "verified" || value === "error";
}
function isCredentialBinding(value: unknown): value is CredentialBinding {
  return isRecord(value) && typeof value.serverUrl === "string" && value.serverUrl.length > 0 && typeof value.loginName === "string" && value.loginName.length > 0 && typeof value.secretId === "string" && SECRET_ID.test(value.secretId);
}
function isVerifiedAccount(value: unknown): value is VerifiedAccount {
  if (!isRecord(value)) return false;
  return ["serverUrl","loginName","userId","displayName","webdavRootUrl","serverVersion","serverVersionString","verifiedAt"].every((key) => typeof value[key] === "string");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remote folder suggested for a vault that has never been connected: one folder per vault under
 * "Obsidian", so two vaults on the same Nextcloud never mix.
 */
export function defaultRemoteFolder(vaultName: string): string {
  const name = vaultName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64).trim();
  return `${DEFAULT_SETTINGS.remoteRootPath}/${name || "Vault"}`;
}
