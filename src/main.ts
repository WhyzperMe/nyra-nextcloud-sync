import { Notice, Platform, Plugin } from "obsidian";
import { ConvergenceAuditor } from "./convergence/auditor";
import type { ConvergenceAuditReport } from "./convergence/types";
import { assessBootstrapPlan } from "./bootstrap/assessment";
import type { BootstrapAssessment } from "./bootstrap/types";
import { AutoSyncScheduler } from "./autosync/scheduler";
import type { AutoSyncCycleResult, AutoSyncRuntimeSummary, AutoSyncTrigger } from "./autosync/types";
import { AuthController, type SettingsPort } from "./auth/auth-controller";
import { CredentialStore } from "./auth/credential-store";
import { LoginFlowV2 } from "./auth/login-flow-v2";
import { NyraError, errorMessage } from "./core/errors";
import { ActivityLog, type ActivityEntry } from "./activity/activity-log";
import { ConsoleLogger } from "./diagnostics/logger";
import { FolderBaselineStore } from "./folders/folder-baseline";
import { FolderSyncService } from "./folders/folder-sync";
import { LocalFolderAccess } from "./folders/local-folders";
import { createRedactedSupportReport } from "./diagnostics/support-report";
import { LocalTransactionalMutator } from "./execution/local-mutator";
import { RemoteTransactionalMutator } from "./execution/remote-mutator";
import { TransactionalSyncExecutor } from "./execution/executor";
import { DeletionHold, type PendingDeletions } from "./execution/deletion-hold";
import type { ExecutionMode, ExecutionReport, ExecutionRuntimeSummary } from "./execution/types";
import { DeletionLedger, type DeletedFileRecord } from "./recovery/deletion-ledger";
import { NextcloudTrash, type TrashedItem } from "./recovery/nextcloud-trash";
import { NextcloudVersions, type FileVersion } from "./recovery/file-versions";
import { HistoryService } from "./recovery/history-service";
import { RecoveryService } from "./recovery/recovery-service";
import { basicAuthorization } from "./security/base64";
import { ServerHealthMonitor } from "./health/monitor";
import type { ServerHealthSnapshot } from "./health/types";
import { LocalMutationLedger } from "./local/mutation-ledger";
import { ObsidianVaultFileSource } from "./local/obsidian-source";
import { LocalPathPolicy } from "./local/path-policy";
import { UserScopeRules } from "./local/user-rules";
import { LocalInventoryScanner } from "./local/scanner";
import { LocalInventoryService } from "./local/service";
import type { LocalInventoryRuntimeSummary, LocalReconcileOutcome } from "./local/types";
import { LocalInventoryWatcher } from "./local/watcher";
import { HttpClient } from "./network/http-client";
import { ConnectionVerifier } from "./nextcloud/verification";
import { SyncPlannerService } from "./planner/service";
import { assertConflictChoiceEligible, makeExplicitChoicePlan, makeSafeMergeRetryPlan, type ConflictChoice } from "./planner/conflict-resolution";
import type { SyncPlan, SyncPlannerRuntimeSummary } from "./planner/types";
import { appendWebdavPath } from "./remote/path";
import { NextcloudDavClient } from "./remote/dav-client";
import { RemoteInventoryReconciler } from "./remote/reconciler";
import { RemoteInventoryScanner } from "./remote/scanner";
import { RemoteRootChangeDetector } from "./remote/root-etag";
import { RemoteInventoryService } from "./remote/service";
import type { RemoteInventoryRuntimeSummary, RemoteReconcileOutcome } from "./remote/types";
import { ObsidianStateBackend } from "./state/durable/obsidian-backend";
import { canonicalVaultRelativePath } from "./state/durable/path";
import { AsyncMutex } from "./state/durable/mutex";
import { DurableStateStore, type DurableStateSummary, type IntegrityReport } from "./state/durable/store";
import type { RemoteReplicaState } from "./state/durable/model";
import { DEFAULT_SETTINGS, defaultRemoteFolder, mergeLimitsFromSettings, normalizeSettings, transferTuningFromSettings, type PluginSettings } from "./state/settings";
import { loadAndMigrateSettings } from "./state/settings-migration";
import { addConflictSuffix, conflictCopyPath, mergeReviewFingerprint, sameConflictSource, type SyncConflictReview } from "./plugin/conflict-copies";
import { registerCommands } from "./plugin/commands";
import { describeStatusBar } from "./plugin/status-bar";
import { SyncCycleRunner } from "./sync/cycle-runner";
import { SyncOperationGuard } from "./sync/operation-guard";
import { TransferJournalStore } from "./transfer/journal";
import { NyraNextcloudSyncSettingTab } from "./ui/settings-tab";
import { platformCapabilities } from "./platform/capabilities";
import { createAppLocalDeviceScope, getPluginDeviceRuntimeRoot } from "./platform/device-scope";
import { acquireRuntimeWriterLease, getRuntimeLockManager, type RuntimeWriterLease } from "./platform/runtime-writer-lease";
import { resolveRuntimeScope, runtimeScopeIdentity } from "./platform/runtime-scope-binding";
import { assertVaultRootMapping } from "./sync/vault-root-guard";
import { isAre, plural } from "./core/plural";
import { recordIsInScope } from "./planner/planner";
import { listSyncTreeChildren, type SyncTreeListing, type SyncTreeSources } from "./folders/sync-tree";
import { setIncluded } from "./local/selection";

const FAST_REMOTE_FENCE_MS = 5 * 60_000;

export default class NyraNextcloudSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  readonly logger = new ConsoleLogger();
  private readonly settingsMutex = new AsyncMutex();
  private readonly operationGuard = new SyncOperationGuard();
  private readonly platform = platformCapabilities(Platform.isMobileApp);
  private readonly failedMergeReviews = new Map<string, { fingerprint: string; message: string }>();

  private credentialStore!: CredentialStore;
  private http!: HttpClient;
  private durableState: DurableStateStore | null = null;
  private convergenceAuditor: ConvergenceAuditor | null = null;
  private lastConvergenceAudit: ConvergenceAuditReport | null = null;
  private localInventory: LocalInventoryService | null = null;
  private pathPolicy: LocalPathPolicy | null = null;
  private remoteInventory: RemoteInventoryService | null = null;
  private planner: SyncPlannerService | null = null;
  private localMutator: LocalTransactionalMutator | null = null;
  private executor: TransactionalSyncExecutor | null = null;
  private healthMonitor: ServerHealthMonitor | null = null;
  private autoSync: AutoSyncScheduler | null = null;
  private syncCycle: SyncCycleRunner | null = null;
  private localWatcher: LocalInventoryWatcher | null = null;
  private transferJournal: TransferJournalStore | null = null;
  private statusBarEl: HTMLElement | null = null;
  private lastExecutionSummary: ExecutionRuntimeSummary | null = null;
  private planScopeKey: string | null = null;
  private executionActive = false;
  private lastLifecycleWakeAt = 0;
  private lastFullLocalScanAtMs = 0;
  private deviceScope: string | null = null;
  private baseDeviceScope: string | null = null;
  private runtimeScopeReloadRequired = false;
  private runtimeInitializing = false;
  private remoteWriteCapabilityScope: string | null = null;
  remoteWriteSafetyError: string | null = null;
  private runtimeWriterLease: RuntimeWriterLease | null = null;
  private shuttingDown = false;
  private runtimeInitializationDone: Promise<void> = Promise.resolve();
  private localFactsComplete = false;
  private remoteFactsComplete = false;
  private lastRemoteTree: { folders: string[]; files: string[] } | null = null;
  private activity: ActivityLog | null = null;
  private recovery: RecoveryService | null = null;
  private readonly deletionHold = new DeletionHold();
  private readonly fastRemote: { etag: string | null; scannedAt: number; capable: boolean | null; scope: string | null; skipped: number; full: number } =
    { etag: null, scannedAt: 0, capable: null, scope: null, skipped: 0, full: 0 };
  private userRules = UserScopeRules.NONE;
  private userRulesSource: PluginSettings | null = null;
  private selectionQueue: Promise<void> = Promise.resolve();
  private localScanner: LocalInventoryScanner | null = null;
  stateInitializationError: string | null = null;
  auth!: AuthController;

  async onload(): Promise<void> {
    this.credentialStore = new CredentialStore(this.app);
    const rawSettings = await this.loadData();
    if (this.shuttingDown) return;
    this.settings = await loadAndMigrateSettings(rawSettings, this.credentialStore, async (settings) => this.saveData(settings), this.logger);
    if (this.shuttingDown) return;
    const isFreshInstall = typeof rawSettings !== "object" || rawSettings === null || !("remoteRootPath" in rawSettings);
    if (isFreshInstall && !this.settings.account) this.settings = { ...this.settings, remoteRootPath: defaultRemoteFolder(this.app.vault.getName()) };
    const receivedAutonomyDefaults = typeof rawSettings === "object" && rawSettings !== null && (rawSettings as { autonomyDefaultsVersion?: unknown }).autonomyDefaultsVersion === this.settings.autonomyDefaultsVersion;
    if (!isFreshInstall && !receivedAutonomyDefaults) await this.saveData(this.settings);

    this.http = new HttpClient(this.logger);
    const settingsPort: SettingsPort = { read: () => this.settings, update: async (mutator) => this.updateSettings(mutator) };
    this.auth = new AuthController(
      new LoginFlowV2(this.http, this.logger, this.manifest.version),
      new ConnectionVerifier(this.http, this.logger),
      this.credentialStore,
      settingsPort,
      this.logger
    );
    this.healthMonitor = new ServerHealthMonitor(this.http, this.logger, {
      getServerUrl: () => this.settings.serverUrl,
      shouldMonitor: () => this.settings.connectionState === "verified" && this.hasStoredCredentials(),
      getHealthyIntervalMs: () => this.settings.serverHealthCheckSeconds * 1000,
      onChange: () => this.refreshStatusBar()
    });
    this.healthMonitor.start();

    // Recovery reads retained WAL/checkpoints/BASE objects and must not hold
    // Obsidian's global plugin loader. All sync entry points remain gated until
    // this promise resolves successfully.
    this.runtimeInitializing = true;
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.classList.add("nyra-nc-statusbar");
    this.addSettingTab(new NyraNextcloudSyncSettingTab(this.app, this));
    registerCommands(this);
    this.refreshStatusBar();
    this.runtimeInitializationDone = this.initializeRuntimeInBackground();
    this.logger.info("plugin.loaded", {
      version: this.manifest.version,
      connectionState: this.settings.connectionState,
      autoSync: this.settings.autoSyncEnabled,
      runtime: "initializing"
    });
  }

  private async initializeRuntimeInBackground(): Promise<void> {
    try {
      const healthMonitor = this.healthMonitor;
      if (!healthMonitor) throw new Error("Nextcloud health monitor was not initialized.");
      const lockManager = getRuntimeLockManager();
      const scopeLease = await acquireRuntimeWriterLease(lockManager, `nyra:${this.manifest.id}:device-scope-init`);
      let deviceScope: string;
      try {
        if (this.shuttingDown) return;
        deviceScope = createAppLocalDeviceScope(this.manifest.id);
      } finally {
        scopeLease.release();
      }
      // Hold the base-profile lease even when the account uses a derived state directory.
      this.runtimeWriterLease = await acquireRuntimeWriterLease(lockManager, `nyra:${this.manifest.id}:runtime-writer:${deviceScope}`);
      if (this.shuttingDown) return;
      this.baseDeviceScope = deviceScope;
      const activeScope = await resolveRuntimeScope(this.app.vault.adapter, this.app.vault.configDir, this.manifest.id, deviceScope,
        runtimeScopeIdentity(this.settings.account, this.settings.remoteRootPath));
      this.deviceScope = activeScope;
      const backend = new ObsidianStateBackend(this.app, this.manifest.id, activeScope);
      this.durableState = await DurableStateStore.open(backend, this.logger, {
        maxBaselineObjectReadBytes: this.platform.maxSafeWholeReadBytes
      });
      if (this.shuttingDown) return;
      const configDir = this.app.vault.configDir;
      const selfRoot = `${configDir}/plugins/${this.manifest.id}`;
      const policy = new LocalPathPolicy({
        reservedRoots: [".trash", selfRoot],
        reservedFiles: [`${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`],
        configDir,
        syncObsidianConfig: () => this.settings.syncObsidianConfig,
        userRules: () => this.currentUserRules()
      });
      this.pathPolicy = policy;
      this.convergenceAuditor = new ConvergenceAuditor(this.durableState);
      this.lastConvergenceAudit = await this.convergenceAuditor.audit({ mode: "quick", includePath: (path) => policy.isIncluded(path) });
      if (this.shuttingDown) return;
      if (this.lastConvergenceAudit.errors > 0) {
        this.logger.error("convergence.startup-audit-failed", { errors: this.lastConvergenceAudit.errors, issues: this.lastConvergenceAudit.issues.slice(0, 8) });
      }
      const ledger = new LocalMutationLedger();
      const localReadLimit = this.platform.maxSafeWholeReadBytes;
      const scanner = new LocalInventoryScanner(new ObsidianVaultFileSource(this.app.vault, policy), policy, {
        concurrency: this.platform.localReadConcurrency,
        maxInFlightBytes: this.platform.maxInFlightWholeReadBytes,
        maxFileBytes: this.effectiveMaxFileBytes()
      });
      this.localScanner = scanner;
      this.localInventory = new LocalInventoryService(scanner, this.durableState, ledger, this.logger, policy);
      this.planner = new SyncPlannerService(this.durableState, this.logger, (path) => policy.isIncluded(path));
      this.localMutator = new LocalTransactionalMutator(this.app.vault, this.manifest.id, this.logger, activeScope, localReadLimit);
      await this.localMutator.initializeAndRecover();
      if (this.shuttingDown) return;
      const runtimeRoot = getPluginDeviceRuntimeRoot(configDir, this.manifest.id, activeScope);
      this.activity = new ActivityLog(this.app.vault.adapter, `${runtimeRoot}/activity-v1.json`);
      await this.activity.load();
      this.recovery = this.createRecoveryService(new DeletionLedger(this.app.vault.adapter, `${runtimeRoot}/deleted-v1.json`), this.activity);

      this.localWatcher = new LocalInventoryWatcher(
        this.app.vault,
        policy,
        ledger,
        async (batch) => {
          if (this.executionActive) {
            this.localFactsComplete = false;
            return;
          }
          if (this.localInventory) {
            try {
              const outcome = await this.localInventory.applyChangeBatch(batch);
              if (!outcome.scan.complete) this.localFactsComplete = false;
              else if (outcome.scan.kind === "full") {
                this.localFactsComplete = true;
                this.lastFullLocalScanAtMs = Date.now();
              }
            } catch (error) {
              this.localFactsComplete = false;
              throw error;
            }
          }
        },
        this.logger,
        () => this.autoSync?.noteLocalActivity()
      );
      this.addChild(this.localWatcher);

      this.syncCycle = new SyncCycleRunner({
        localFactsComplete: () => this.localFactsComplete,
        remoteFactsComplete: () => this.remoteFactsComplete,
        lastFullLocalScanAt: () => this.lastFullLocalScanAtMs,
        now: () => Date.now(),
        flushLocalHints: async () => await this.localWatcher?.flushPending(),
        waitForLocalInventory: async () => await this.localInventory?.whenIdle(),
        scanLocalFull: async (reason, options) => (await this.scanLocalVaultInternal(reason, options)).scan.complete,
        scanRemoteFull: async (options) => await this.scanRemoteForCycle(options.allowCached),
        invalidateRemoteFacts: () => { this.fastRemote.etag = null; },
        buildPlan: async () => await this.buildSyncPlanInternal(),
        autoMergeEnabled: () => this.settings.autoMergeText,
        applyPlan: async (allowDeletes) => await this.applyCurrentSyncPlanInternal(allowDeletes),
        syncFolders: async (allowDeletes) => await this.syncFoldersInternal(allowDeletes)
      });

      this.autoSync = new AutoSyncScheduler({
        getPolicy: () => ({
          enabled: this.settings.autoSyncEnabled && !this.settings.syncPaused,
          quietPeriodMs: this.settings.autoSyncQuietSeconds * 1000,
          remotePollMs: this.settings.autoSyncRemotePollSeconds * 1000,
          startupDelayMs: 5_000,
          allowDeletes: this.settings.autoSyncAllowDeletes
        }),
        canRun: () => this.canAutoSyncRun(),
        isExecutionActive: () => this.runtimeInitializing || this.executionActive || (this.operationGuard.isBusy() && !this.operationGuard.isOwnedBy("autosync")),
        operationGuard: this.operationGuard,
        runCycle: async (trigger, allowDeletes) => await this.runAutoSyncCycle(trigger, allowDeletes),
        health: healthMonitor,
        logger: this.logger,
        onChange: () => this.refreshStatusBar()
      });
      this.registerLifecycleWakeups();
      this.autoSync.start();
      this.stateInitializationError = null;
      this.logger.info("state.initialized", { durableState: this.durableState.summary().status });
    } catch (error) {
      if (!this.shuttingDown) {
        this.stateInitializationError = errorMessage(error);
        this.logger.error("state.initialization-failed", { error: this.stateInitializationError });
        await this.cleanupFailedRuntimeInitialization();
        new Notice("Nyra local recovery could not finish. Sync is paused; open plugin settings for details.", 12_000);
      }
    } finally {
      this.runtimeInitializing = false;
      this.refreshStatusBar();
    }
  }

  onunload(): void {
    this.shuttingDown = true;
    this.autoSync?.close();
    this.healthMonitor?.close();
    this.auth?.close();
    this.localWatcher?.onunload();
    void this.finishRuntimeShutdown();
    this.logger.info("plugin.unloaded");
  }

  hasStoredCredentials(): boolean { return this.auth?.hasStoredCredentials() ?? false; }
  private requireDeviceScope(): string {
    if (!this.deviceScope) throw new Error("Nyra app-local runtime storage is unavailable; sync is disabled.");
    return this.deviceScope;
  }
  canVerifyStoredCredentials(): boolean { return this.auth?.canVerifyStoredCredentials() ?? false; }
  durableStateSummary(): DurableStateSummary | null { return this.durableState?.summary() ?? null; }
  convergenceAuditSummary(): ConvergenceAuditReport | null { return this.lastConvergenceAudit ? structuredClone(this.lastConvergenceAudit) : null; }
  hasConvergenceErrors(): boolean { return (this.lastConvergenceAudit?.errors ?? 0) > 0; }
  localInventorySummary(): LocalInventoryRuntimeSummary | null { return this.localInventory?.summary() ?? null; }
  remoteInventorySummary(): RemoteInventoryRuntimeSummary | null { return this.remoteInventory?.summary() ?? null; }
  remoteInventoryProgressSummary(): Pick<RemoteInventoryRuntimeSummary, "status" | "scanProgress"> | null { return this.remoteInventory?.progressSummary() ?? null; }
  plannerSummary(): SyncPlannerRuntimeSummary | null { return this.planner?.summary() ?? null; }
  executionSummary(): ExecutionRuntimeSummary | null { return this.executor?.summary() ?? this.lastExecutionSummary; }
  serverHealthSummary(): ServerHealthSnapshot | null { return this.healthMonitor?.snapshot() ?? null; }
  autoSyncSummary(): AutoSyncRuntimeSummary | null { return this.autoSync?.summary() ?? null; }
  isExecutionActive(): boolean { return this.executionActive; }
  isSyncBusy(): boolean { return this.runtimeInitializing || this.operationGuard.isBusy() || this.executionActive || this.autoSync?.isBusy() === true; }
  isRuntimeInitializing(): boolean { return this.runtimeInitializing; }
  currentSyncPlan(): SyncPlan | null {
    const plan = this.planner?.currentPlan() ?? null;
    if (!plan || this.planScopeKey !== this.syncScopeKey(this.settings)) return null;
    return plan;
  }

  syncConflictReviews(): SyncConflictReview[] {
    const plan = this.currentSyncPlan();
    const state = this.durableState?.getState();
    if (!plan || !state) return [];
    return plan.items.filter((item) => item.disposition === "blocked" || item.disposition === "merge-candidate").flatMap((item) => {
      const record = state.files[item.entryId];
      if (!record) return [];
      const mergeFailure = this.failedMergeReviews.get(record.entryId);
      if (item.disposition === "merge-candidate" && this.settings.autoMergeText && (!mergeFailure || mergeFailure.fingerprint !== mergeReviewFingerprint(record))) return [];
      return [{
        entryId: record.entryId,
        path: item.displayPath,
        classification: item.classification,
        reasons: item.disposition === "merge-candidate" && !this.settings.autoMergeText
          ? [...item.reasons, "Automatic safe merge is disabled in settings; choose a version or retry a safe merge explicitly."]
          : mergeFailure && item.disposition === "merge-candidate"
          ? [...item.reasons, `Automatic merge needs review: ${mergeFailure.message}`]
          : [...item.reasons],
        local: record.local ? { path: record.local.path, sha256: record.local.contentHash, size: record.local.size, mtimeMs: record.local.mtimeMs } : null,
        base: record.baseline ? { path: record.baseline.path, sha256: record.baseline.blobHash, size: record.baseline.size, createdAt: record.baseline.createdAt } : null,
        remote: record.remote ? { path: record.remote.path, sha256: record.remote.contentHash, size: record.remote.size, mtimeMs: record.remote.mtimeMs, fileId: record.remote.fileId, etag: record.remote.etag } : null
      }];
    });
  }

  async verifyDurableState(): Promise<IntegrityReport> {
    if (!this.durableState) throw new Error(this.stateInitializationError ?? "Durable state is unavailable.");
    return await this.durableState.verifyIntegrity();
  }

  async createRedactedSupportReport(): Promise<string> {
    const integrity = this.durableState ? await this.durableState.verifyIntegrity().catch(() => null) : null;
    const journal = this.transferJournal ?? (this.deviceScope
      ? new TransferJournalStore(this.app.vault, this.manifest.id, this.logger, this.deviceScope)
      : null);
    let transfers: { status: "available" | "unavailable"; records: number; byPhase: Record<string, number> } = {
      status: "unavailable", records: 0, byPhase: Object.create(null) as Record<string, number>
    };
    try {
      if (!journal) throw new Error("App-local runtime scope is unavailable.");
      const records = await journal.listLatest();
      const byPhase: Record<string, number> = Object.create(null) as Record<string, number>;
      for (const record of records) byPhase[record.phase] = (byPhase[record.phase] ?? 0) + 1;
      transfers = { status: "available", records: records.length, byPhase };
    } catch {
      // Raw transfer-journal errors can contain private paths. Report only availability.
    }
    return createRedactedSupportReport({
      pluginVersion: this.manifest.version,
      platform: this.platform.isMobile ? "mobile" : "desktop",
      settings: this.settings,
      hasStoredCredentials: this.hasStoredCredentials(),
      health: this.serverHealthSummary(),
      autoSync: this.autoSyncSummary(),
      local: this.localInventorySummary(),
      remote: this.remoteInventorySummary(),
      planner: this.plannerSummary(),
      execution: this.executionSummary(),
      durable: this.durableStateSummary(),
      integrity,
      transfers
    });
  }

  async auditConvergence(deep = false): Promise<ConvergenceAuditReport> {
    if (!this.convergenceAuditor) throw new Error(this.stateInitializationError ?? "Convergence auditor is unavailable.");
    const report = await this.convergenceAuditor.audit({
      mode: deep ? "deep" : "quick",
      includePath: (path) => this.pathPolicy?.isIncluded(path) ?? true
    });
    this.lastConvergenceAudit = report;
    this.refreshStatusBar();
    return structuredClone(report);
  }

  async checkServerHealth(): Promise<ServerHealthSnapshot> {
    if (!this.healthMonitor) throw new Error("Server health monitor is unavailable.");
    const result = await this.healthMonitor.checkNow(true);
    this.refreshStatusBar();
    return result;
  }

  async scanLocalVault(): Promise<LocalReconcileOutcome> {
    return await this.runManualOperation(async () => await this.scanLocalVaultInternal("manual"));
  }

  async buildSyncPlan(): Promise<SyncPlan> {
    return await this.runManualOperation(async () => await this.buildSyncPlanInternal());
  }

  async scanRemoteVault(): Promise<RemoteReconcileOutcome> {
    return await this.runManualOperation(async () => await this.scanRemoteVaultInternal());
  }

  async runAutoSyncNow(): Promise<AutoSyncCycleResult | null> {
    if (!this.autoSync) throw new Error(this.stateInitializationError ?? "Auto-sync is unavailable.");
    if (this.operationGuard.isBusy() && !this.operationGuard.isOwnedBy("autosync")) {
      throw new Error("Another sync operation is active. Try again after it finishes.");
    }
    if (!this.canAutoSyncRun()) throw new Error("Verify the Nextcloud account before syncing.");
    return await this.autoSync.runNow();
  }

  /** Publish a local-first vault only when the selected remote scope is empty. */
  async publishVaultToNextcloud(): Promise<ExecutionReport> {
    return await this.runManualOperation(async () => {
      const settings = structuredClone(this.settings);
      const account = settings.account;
      if (settings.connectionState !== "verified" || !account) throw new Error("Verify the Nextcloud connection before publishing.");
      const health = await this.checkServerHealth();
      if (health.state !== "online") throw new Error(`Nextcloud is ${health.state}. Publishing is paused until the server is online.`);

      const remote = await this.createRemoteMutator(settings);
      await remote.ensureDirectoryPath(account.webdavRootUrl, settings.remoteRootPath);
      const localOutcome = await this.scanLocalVaultInternal("publish-preflight");
      const remoteOutcome = await this.scanRemoteVaultInternal();
      const plan = await this.buildSyncPlanInternal();
      const localFiles = localOutcome.scan.kind === "full" ? localOutcome.scan.entries.length : 0;
      const assessment = assessBootstrapPlan(plan, localFiles, remoteOutcome.scan.entries.length);
      if (!assessment.canPublish) throw new Error(assessment.publishReason);
      return await this.applyCurrentSyncPlanInternal(false, "bootstrap-push");
    });
  }

  /** Download a remote-first vault only when this device's current sync scope is empty. */
  async downloadVaultToThisDevice(): Promise<ExecutionReport> {
    return await this.runManualOperation(async () => {
      const health = await this.checkServerHealth();
      if (health.state !== "online") throw new Error(`Nextcloud is ${health.state}. Download is paused until the server is online.`);
      const localOutcome = await this.scanLocalVaultInternal("download-preflight");
      const remoteOutcome = await this.scanRemoteVaultInternal();
      const plan = await this.buildSyncPlanInternal();
      const localFiles = localOutcome.scan.kind === "full" ? localOutcome.scan.entries.length : 0;
      const assessment = assessBootstrapPlan(plan, localFiles, remoteOutcome.scan.entries.length);
      if (!assessment.canDownload) throw new Error(assessment.downloadReason);
      return await this.applyCurrentSyncPlanInternal(false, "bootstrap-pull");
    });
  }

  async assessCrossDeviceSetup(): Promise<BootstrapAssessment> {
    return await this.runManualOperation(async () => {
      const localOutcome = await this.scanLocalVaultInternal("setup-assessment");
      const remoteOutcome = await this.scanRemoteVaultInternal();
      const plan = await this.buildSyncPlanInternal();
      const localFiles = localOutcome.scan.kind === "full" ? localOutcome.scan.entries.length : 0;
      return assessBootstrapPlan(plan, localFiles, remoteOutcome.scan.entries.length);
    });
  }

  async applyCurrentSyncPlan(allowDestructive = false): Promise<ExecutionReport> {
    return await this.runManualOperation(async () => await this.applyCurrentSyncPlanInternal(allowDestructive));
  }

  async resolveConflict(entryId: string, choice: ConflictChoice | "keep-both" | "retry-safe-merge"): Promise<ExecutionReport | null> {
    if (choice === "retry-safe-merge") return await this.retrySafeMerge(entryId);
    this.assertManualOperationAvailable();
    if (!this.localMutator || !this.durableState) throw new Error(this.stateInitializationError ?? "Conflict recovery is unavailable.");
    const releaseOperation = this.operationGuard.tryAcquire("conflict-resolution");
    if (!releaseOperation) throw new Error("A sync operation is currently active.");

    this.refreshStatusBar();
    try {
      await this.scanLocalVaultInternal("conflict-review-local");
      const remoteScan = await this.scanRemoteVaultInternal();
      if (remoteScan.scan.trust !== "authoritative" || !this.localFactsComplete) throw new Error("Conflict choices need complete LOCAL and REMOTE inventories.");
      const plan = await this.buildSyncPlanInternal();
      const item = plan.items.find((candidate) => candidate.entryId === entryId);
      assertConflictChoiceEligible(item);
      const state = this.durableState.getState();
      const record = state.files[entryId];
      if (!record?.local || !record.remote || !record.remote.contentHash || !record.remote.fileId || !record.remote.etag) {
        throw new Error("Both conflict versions must have verified hashes, a remote fileId, and a current ETag before choosing a winner.");
      }
      const localBefore = record.local;
      const remoteBefore = record.remote;
      const remoteHash = record.remote.contentHash;
      const before = structuredClone(record);
      const settings = structuredClone(this.settings);
      const remoteMutator = await this.createRemoteMutator(settings);

      if (choice === "keep-both") {
        const targetPath = await this.nextConflictCopyPath(localBefore.path, "LOCAL", localBefore.contentHash);
        await this.preserveLocalConflictVersion(localBefore.path, localBefore.contentHash, targetPath);
      }
      if (choice === "keep-remote") {
        const targetPath = await this.nextConflictCopyPath(localBefore.path, "LOCAL", localBefore.contentHash);
        await this.preserveLocalConflictVersion(localBefore.path, localBefore.contentHash, targetPath);
      }
      if (choice === "keep-local" || choice === "keep-both") {
        const targetPath = await this.nextConflictCopyPath(remoteBefore.path, "REMOTE", remoteHash);
        await this.preserveRemoteConflictVersion(remoteBefore, targetPath, remoteMutator);
      }

      // The copies are durable local notes before any original path can change.
      // Drain their watcher hints and reconcile complete inventories again.
      await this.localWatcher?.flushPending();
      const localAfterCopies = await this.scanLocalVaultInternal("conflict-copies-verified");
      const remoteAfterCopies = await this.scanRemoteVaultInternal();
      if (!localAfterCopies.scan.complete || remoteAfterCopies.scan.trust !== "authoritative") {
        throw new Error("Conflict copies are preserved, but a complete post-copy scan is required before changing the original.");
      }
      const freshPlan = await this.buildSyncPlanInternal();
      const current = this.durableState.getState().files[entryId];
      if (!sameConflictSource(before, current)) {
        throw new Error("A conflict version changed during review. Both copies are preserved; rebuild the plan before choosing again.");
      }
      if (choice === "keep-both") {
        this.autoSync?.noteLocalActivity();
        return null;
      }
      const resolutionPlan = await makeExplicitChoicePlan(freshPlan, entryId, choice);
      const report = await this.applyCurrentSyncPlanInternal(true, "bidirectional", resolutionPlan);
      if (report.completed > 0 && report.blocked === 0 && report.failed === 0) this.failedMergeReviews.delete(entryId);
      this.autoSync?.noteLocalActivity();
      return report;
    } finally {
      releaseOperation();
      this.refreshStatusBar();
    }
  }

  async updateSettings(mutator: (settings: PluginSettings) => void): Promise<void> {
    await this.settingsMutex.runExclusive(async () => {
      if (this.isSyncBusy()) throw new Error("Settings cannot be changed while synchronization is active.");
      const previous = this.settings;
      const next = structuredClone(previous);
      mutator(next);
      const normalized = normalizeSettings(next);
      const requestedIdentity = runtimeScopeIdentity(normalized.account, normalized.remoteRootPath);
      let requiresReload = this.runtimeScopeReloadRequired;
      if (requestedIdentity && this.baseDeviceScope && this.deviceScope) {
        const selectedScope = await resolveRuntimeScope(this.app.vault.adapter, this.app.vault.configDir, this.manifest.id, this.baseDeviceScope, requestedIdentity);
        requiresReload = selectedScope !== this.deviceScope;
      }
      await this.saveData(normalized);
      const scopeChanged = this.syncScopeKey(previous) !== this.syncScopeKey(normalized);
      this.settings = normalized;
      this.localScanner?.setMaxFileBytes(this.effectiveMaxFileBytes());
      this.runtimeScopeReloadRequired = requiresReload;
      if (requiresReload) {
        this.stateInitializationError = "Nextcloud account or remote folder changed. Reload this plugin before syncing; the previous sync history is preserved.";
      } else if (this.durableState) {
        this.stateInitializationError = null;
      }
      if (scopeChanged) {
        this.planScopeKey = null;
        this.planner?.invalidate("Account, remote folder, or vault sync scope changed; rebuild the sync plan.");
        this.remoteWriteCapabilityScope = null;
        this.remoteWriteSafetyError = null;
        this.fastRemote.etag = null;
        if (this.serverIdentity(previous) !== this.serverIdentity(normalized)) this.fastRemote.capable = null;
      }
      const authenticatedVerificationSucceeded = normalized.connectionState === "verified" && (
        previous.connectionState !== "verified" || normalized.account?.verifiedAt !== previous.account?.verifiedAt
      );
      if (authenticatedVerificationSucceeded) this.healthMonitor?.noteOperationSuccess();
      else this.healthMonitor?.poke();
      this.autoSync?.reconfigure();
      if (scopeChanged) {
        await this.forgetOutOfScopeRecords();
        this.autoSync?.noteForegroundResume();
      }
      this.refreshStatusBar();
    });
  }

  private async scanLocalVaultInternal(reason: string, options?: { trustMetadata: boolean }): Promise<LocalReconcileOutcome> {
    if (this.executionActive) throw new Error("A transactional sync execution is currently active.");
    if (!this.localInventory) throw new Error(this.stateInitializationError ?? "Local inventory is unavailable.");
    const trust = options?.trustMetadata === true;
    const outcome = await this.localInventory.scanFull(reason, { trustMetadata: trust });
    this.localFactsComplete = outcome.scan.complete;
    // Only fully hashed scans restart the verification fence.
    if (outcome.scan.complete && !trust) this.lastFullLocalScanAtMs = Date.now();
    await this.auditConvergence(false);
    return outcome;
  }

  /** Statistics for diagnostics and tests: background polls answered by the cheap root-ETag check. */
  remotePollStats(): { skipped: number; full: number; fastCheckVerified: boolean | null } {
    return { skipped: this.fastRemote.skipped, full: this.fastRemote.full, fastCheckVerified: this.fastRemote.capable };
  }

  /**
   * Remote step of a sync cycle. A background poll first asks whether the sync root's ETag changed;
   * if not, the previous authoritative inventory is still exact and the full recursive scan is skipped.
   */
  private async scanRemoteForCycle(allowCached: boolean): Promise<boolean> {
    const account = this.settings.account;
    if (allowCached && this.settings.fastRemoteCheck && account && this.fastRemote.capable === true && this.fastRemote.etag !== null &&
      this.remoteFactsComplete && Date.now() - this.fastRemote.scannedAt < FAST_REMOTE_FENCE_MS) {
      try {
        const detector = this.createRootDetector();
        const current = detector ? await detector.currentEtag() : null;
        if (current !== null && current === this.fastRemote.etag) {
          this.fastRemote.skipped += 1;
          return true;
        }
      } catch (error) {
        this.logger.debug("remote.fast-check-failed", { error: errorMessage(error) });
      }
    }
    const outcome = await this.scanRemoteVaultInternal();
    const complete = outcome.scan.trust === "authoritative";
    if (complete && this.settings.fastRemoteCheck && this.fastRemote.capable === null) await this.probeFastRemoteCheck();
    return complete;
  }

  private async probeFastRemoteCheck(): Promise<void> {
    const detector = this.createRootDetector();
    if (!detector) return;
    const identity = this.serverIdentity(this.settings);
    const verified = await detector.verifyPropagation();
    if (this.serverIdentity(this.settings) !== identity) return;
    this.fastRemote.capable = verified;
    this.fastRemote.etag = null; // the probe itself changed the root ETag; the next scan re-baselines it
    this.logger.info("remote.fast-check", { verified });
    this.purgeProbeTrash();
  }

  /** Best-effort: keeps the plugin's own probe files out of the user's Nextcloud trash bin. */
  private purgeProbeTrash(): void {
    const account = this.settings.account;
    if (!account || this.settings.connectionState !== "verified") return;
    try {
      const credentials = this.auth.getVerifiedCredentials();
      const trash = new NextcloudTrash(this.http, account.serverUrl, account.userId, basicAuthorization(credentials.loginName, credentials.appPassword));
      void trash.purgeProbeLeftovers(this.settings.remoteRootPath)
        .then((count) => { if (count > 0) this.logger.debug("remote.probe-trash-purged", { count }); })
        .catch((error: unknown) => this.logger.debug("remote.probe-trash-purge-failed", { error: errorMessage(error) }));
    } catch { /* credentials unavailable: nothing to clean */ }
  }

  private createRootDetector(): RemoteRootChangeDetector | null {
    const account = this.settings.account;
    if (!account || this.settings.connectionState !== "verified") return null;
    try {
      const credentials = this.auth.getVerifiedCredentials();
      return new RemoteRootChangeDetector(this.http, basicAuthorization(credentials.loginName, credentials.appPassword),
        appendWebdavPath(account.webdavRootUrl, this.settings.remoteRootPath), this.logger);
    } catch { return null; }
  }

  /**
   * Items that leave the sync scope (unchecked in the file picker, new exclusion rule) stop being tracked.
   * Their BASE is dropped on purpose: while excluded, neither side's changes or deletions are observed, so
   * keeping an old BASE would turn "I removed it from this device while it was excluded" into a delete on the
   * server the moment the item is included again. After re-inclusion both sides are compared by content instead.
   */
  private async forgetOutOfScopeRecords(): Promise<void> {
    const store = this.durableState;
    const policy = this.pathPolicy;
    if (!store || !policy) return;
    try {
      const forgotten = { files: 0, tombstones: 0 };
      await store.transact("scope-forget-excluded", (tx, base) => {
        for (const record of Object.values(base.files)) {
          if (recordIsInScope(record, (path) => policy.isInScope(path))) continue;
          tx.removeFile(record.entryId);
          forgotten.files += 1;
        }
        for (const tombstone of Object.values(base.tombstones)) {
          if (policy.isInScope(tombstone.previousPath)) continue;
          tx.removeTombstone(tombstone.tombstoneId);
          forgotten.tombstones += 1;
        }
      });
      if (forgotten.files + forgotten.tombstones > 0) this.logger.info("scope.forgot-excluded", forgotten);
    } catch (error) {
      this.logger.warn("scope.forget-excluded-failed", { error: errorMessage(error) });
    }
  }

  /** True while nothing was ever synchronized with this remote folder, so a missing folder cannot mean "deleted". */
  private hasNoSyncHistory(): boolean {
    const state = this.durableState?.getState();
    return !state || Object.values(state.files).every((record) => record.remote === null && record.baseline === null);
  }

  private async buildSyncPlanInternal(): Promise<SyncPlan> {
    if (this.executionActive) throw new Error("A transactional sync execution is currently active.");
    if (!this.planner) throw new Error(this.stateInitializationError ?? "Sync planner is unavailable.");
    await this.assertConvergenceHealthy("planning");
    const scope = this.syncScopeKey(this.settings);
    const plan = await this.planner.buildPlan();
    this.refreshDeletionHold(plan);
    // Bind the runtime plan to the exact account + remote-root mapping used to
    // interpret the remote inventory. A settings change cannot redirect an old
    // plan at a different WebDAV subtree.
    this.planScopeKey = scope;
    return plan;
  }

  private async scanRemoteVaultInternal(): Promise<RemoteReconcileOutcome> {
    if (this.runtimeScopeReloadRequired) throw new Error(this.stateInitializationError ?? "Reload Nyra before syncing the changed remote folder.");
    if (!this.durableState) throw new Error(this.stateInitializationError ?? "Durable state is unavailable.");
    const account = this.settings.account;
    if (this.settings.connectionState !== "verified" || !account) throw new Error("Verify the Nextcloud connection before scanning remote files.");
    const credentials = this.auth.getVerifiedCredentials();
    const service = new RemoteInventoryService(
      new RemoteInventoryScanner(
        new NextcloudDavClient(this.http, credentials, this.logger),
        account.webdavRootUrl,
        this.logger,
        { directoryConcurrency: this.settings.remoteDirectoryConcurrency, maxFileBytes: this.effectiveMaxFileBytes(), pathPolicy: this.pathPolicy ?? undefined }
      ),
      new RemoteInventoryReconciler(this.durableState, this.pathPolicy ?? undefined),
      this.durableState,
      this.logger,
      this.pathPolicy ?? undefined,
      async (scan) => assertVaultRootMapping(scan, this.app.vault.adapter.getName(),
        this.app.vault.getFiles().filter((file) => this.pathPolicy?.isIncluded(file.path) ?? true)
          .map((file) => ({ path: file.path, size: file.stat.size })), this.settings.remoteRootPath)
    );
    this.remoteInventory?.close();
    this.remoteInventory = service;
    try {
      let outcome = await service.scanFull(this.settings.remoteRootPath);
      if (outcome.scan.trust !== "authoritative" && outcome.scan.issues.some((issue) => issue.code === "root-missing") && this.hasNoSyncHistory()) {
        // First connection to a folder that does not exist yet: create it instead of asking the user to.
        const remote = await this.createRemoteMutator(structuredClone(this.settings));
        await remote.ensureDirectoryPath(account.webdavRootUrl, this.settings.remoteRootPath);
        void this.activity?.add([{ at: new Date().toISOString(), kind: "folder-created", path: this.settings.remoteRootPath, detail: "Nextcloud folder created for this vault" }]);
        outcome = await service.scanFull(this.settings.remoteRootPath);
      }
      this.remoteFactsComplete = outcome.scan.trust === "authoritative";
      this.lastRemoteTree = this.remoteFactsComplete
        ? { folders: outcome.scan.directories, files: [...outcome.scan.entries.map((entry) => entry.path), ...outcome.scan.oversized] }
        : null;
      this.fastRemote.etag = this.remoteFactsComplete ? outcome.scan.rootEtag : null;
      this.fastRemote.scannedAt = Date.now();
      this.fastRemote.full += 1;
      // A successful authenticated WebDAV inventory is stronger health evidence
      // than the unauthenticated status endpoint and may safely clear auth-required.
      this.healthMonitor?.noteOperationSuccess();
      await this.auditConvergence(false);
      return outcome;
    } catch (error) {
      this.remoteFactsComplete = false;
      this.lastRemoteTree = null;
      this.fastRemote.etag = null;
      this.healthMonitor?.noteOperationFailure(error);
      throw error;
    }
  }

  private async runAutoSyncCycle(trigger: AutoSyncTrigger, allowDeletes: boolean): Promise<AutoSyncCycleResult> {
    if (!this.operationGuard.isOwnedBy("autosync") || this.executionActive) throw new Error("The autosync cycle does not own the synchronization reservation.");
    if (!this.syncCycle) throw new Error(this.stateInitializationError ?? "Sync cycle runner is unavailable.");
    try {
      return await this.syncCycle.run(trigger, allowDeletes);
    } catch (error) {
      void this.activity?.addError(errorMessage(error));
      throw error;
    }
  }

  private async applyCurrentSyncPlanInternal(allowDestructive: boolean, mode: ExecutionMode = "bidirectional", planOverride?: SyncPlan, forceSafeMerge = false): Promise<ExecutionReport> {
    if (this.executionActive) throw new Error("A transactional sync execution is already running.");
    if (!this.durableState || !this.localMutator || !this.planner) throw new Error(this.stateInitializationError ?? "Execution state is unavailable.");
    if (!this.localFactsComplete || !this.remoteFactsComplete) {
      throw new Error("A complete local and remote inventory is required before executing this plan. Scan both replicas and rebuild it.");
    }
    await this.assertConvergenceHealthy("execution");
    const currentPlan = this.currentSyncPlan();
    const plan = planOverride ?? currentPlan;
    if (!plan) throw new Error("Build a fresh sync plan for the current account and remote folder before execution.");
    if (planOverride && (!currentPlan || currentPlan.storeId !== planOverride.storeId || currentPlan.stateGeneration !== planOverride.stateGeneration || currentPlan.walSequence !== planOverride.walSequence || currentPlan.walHash !== planOverride.walHash)) {
      throw new Error("Conflict choice plan became stale; rebuild it from fresh replica inventories.");
    }
    const settings = structuredClone(this.settings);
    const account = settings.account;
    if (settings.connectionState !== "verified" || !account) throw new Error("Verify the Nextcloud connection before execution.");
    this.auth.getVerifiedCredentials(); // fail closed before entering execution ownership

    // Explicit conflict choices and bootstrap runs are user-directed; only automatic cycles are guarded.
    let approvalInForce = false;
    if (allowDestructive && !planOverride && mode === "bidirectional") {
      const evaluation = this.deletionHold.evaluate(plan, settings.deleteConfirmThreshold, Object.keys(this.durableState.getState().files).length);
      if (evaluation.decision.held) {
        allowDestructive = false;
        this.announceHeldDeletions(evaluation.newlyHeld);
      } else approvalInForce = evaluation.decision.total > 0 && this.deletionHold.hasApproval();
    }

    this.executionActive = true;
    this.refreshStatusBar();
    try {
      const tuning = transferTuningFromSettings(settings);
      const remoteMutator = await this.createRemoteMutator(settings);
      const remoteMutation = mode !== "bootstrap-pull" && plan.items.some((item) =>
        item.disposition !== "blocked" && item.steps.some((step) =>
          ["upload-create", "upload-update", "move-remote", "delete-remote", "merge-text"].includes(step.kind)));
      if (remoteMutation || await remoteMutator.hasCriticalRecovery()) {
        const capabilityScope = this.syncScopeKey(settings);
        if (this.remoteWriteSafetyError) throw new Error(this.remoteWriteSafetyError);
        if (this.remoteWriteCapabilityScope !== capabilityScope) {
          await remoteMutator.verifyConditionalWrites(settings.remoteRootPath);
          this.remoteWriteCapabilityScope = capabilityScope;
          this.purgeProbeTrash();
        }
      }
      const recovery = await remoteMutator.recoverIncompleteTransfers();
      if (recovery.recovered > 0) {
        this.logger.warn("transfer.critical-recovery-completed", recovery);
        throw new Error("An interrupted transfer was recovered. Fresh inventories are required before another apply.");
      }

      const executor = new TransactionalSyncExecutor(
        this.durableState,
        this.localMutator,
        remoteMutator,
        account.webdavRootUrl,
        settings.remoteRootPath,
        tuning,
        this.logger,
        () => this.refreshStatusBar()
      );
      this.executor?.close();
      this.executor = executor;
      const report = await executor.execute(plan, {
        allowDestructive,
        allowMerge: settings.autoMergeText || forceSafeMerge,
        mergeLimits: mergeLimitsFromSettings(settings),
        maxOperations: 10_000,
        mode
      });
      for (const result of report.results) {
        if (result.kind !== "merge-text") continue;
        const record = this.durableState.getState().files[result.entryId];
        if (result.status === "blocked" && record) {
          this.failedMergeReviews.set(result.entryId, { fingerprint: mergeReviewFingerprint(record), message: result.message });
        } else if (result.status === "completed") {
          this.failedMergeReviews.delete(result.entryId);
        }
      }
      this.lastExecutionSummary = executor.summary();
      if (approvalInForce) this.deletionHold.consumeApproval();
      await this.recordReport(report);
      return report;
    } catch (error) {
      if (error instanceof NyraError && error.code === "remote-precondition-unreliable") {
        this.remoteWriteCapabilityScope = null;
        this.remoteWriteSafetyError = `Remote writes are paused: ${errorMessage(error)} Reload Nyra after the server is fixed to retry the safety check.`;
        throw new Error(this.remoteWriteSafetyError);
      }
      throw error;
    } finally {
      try { await this.scanRemoteVaultInternal(); }
      catch (error) { this.logger.warn("apply.post-remote-rescan-failed", { error: errorMessage(error) }); }
      try { if (this.localInventory) {
        const outcome = await this.localInventory.scanFull("post-execution");
        this.localFactsComplete = outcome.scan.complete;
        if (outcome.scan.complete) this.lastFullLocalScanAtMs = Date.now();
      } }
      catch (error) {
        this.localFactsComplete = false;
        this.logger.warn("apply.post-local-rescan-failed", { error: errorMessage(error) });
      }
      try { await this.auditConvergence(false); }
      catch (error) { this.logger.error("apply.post-convergence-audit-failed", { error: errorMessage(error) }); }
      this.executionActive = false;
      this.refreshStatusBar();
    }
  }

  // ---- activity, deletion hold and recovery ---------------------------------

  activityEntries(limit = 100): ActivityEntry[] { return this.activity?.recent(limit) ?? []; }

  /** Files skipped on this device because they exceed its whole-file memory limit. */
  skippedLargeFiles(): { local: string[]; remote: string[]; limitMiB: number } {
    const paths = this.pathPolicy?.oversizedPaths() ?? { local: [], remote: [] };
    return { ...paths, limitMiB: Math.floor(this.effectiveMaxFileBytes() / (1024 * 1024)) };
  }

  pendingDeletions(): PendingDeletions | null { return this.deletionHold.summary(); }

  /** Approves the deletions currently held back; the next sync performs them. */
  approvePendingDeletions(): boolean {
    const approved = this.deletionHold.approve();
    if (approved) this.autoSync?.noteLocalActivity();
    return approved;
  }

  /**
   * Undo for deletions made on this device that are waiting to be pushed to Nextcloud:
   * writes the retained copies back so nothing is removed on the server.
   */
  async undoPendingLocalDeletions(): Promise<number> {
    const plan = this.currentSyncPlan();
    const state = this.durableState?.getState();
    if (!plan || !state || !this.recovery) throw new Error("Build a fresh sync plan before undoing deletions.");
    let restored = 0;
    for (const item of plan.items) {
      if (item.disposition === "blocked" || !item.steps.some((step) => step.kind === "delete-remote")) continue;
      const baseline = state.files[item.entryId]?.baseline;
      if (!baseline) continue;
      try {
        await this.recovery.restoreFromBase(baseline.path, baseline.blobHash, false);
        restored += 1;
      } catch (error) {
        this.logger.warn("recovery.undo-skipped", { error: errorMessage(error) });
      }
    }
    this.autoSync?.noteLocalActivity();
    return restored;
  }

  recentlyDeleted(): Promise<DeletedFileRecord[]> { return this.recovery?.recentlyDeleted() ?? Promise.resolve([]); }

  async restoreDeletedFile(entry: DeletedFileRecord): Promise<string> {
    if (!this.recovery) throw new Error(this.stateInitializationError ?? "Recovery is unavailable.");
    const path = await this.recovery.restoreDeleted(entry);
    this.autoSync?.noteLocalActivity();
    return path;
  }

  async listNextcloudTrash(): Promise<TrashedItem[]> {
    if (!this.recovery) throw new Error(this.stateInitializationError ?? "Recovery is unavailable.");
    return await this.recovery.listTrash();
  }

  async restoreFromNextcloudTrash(item: TrashedItem): Promise<void> {
    if (!this.recovery) throw new Error(this.stateInitializationError ?? "Recovery is unavailable.");
    await this.recovery.restoreTrash(item);
    this.autoSync?.noteForegroundResume();
  }

  private createRecoveryService(ledger: DeletionLedger, activity: ActivityLog): RecoveryService {
    return new RecoveryService({
      ledger, activity,
      getBlob: async (hash) => {
        if (!this.durableState) throw new Error("Durable state is unavailable.");
        return await this.durableState.getBlob(hash);
      },
      exists: async (path) => await this.app.vault.adapter.exists(path),
      createFile: async (path, bytes) => {
        if (!this.localMutator) throw new Error("Local mutation service is unavailable.");
        await this.localMutator.writeAtomic(path, bytes, null);
      },
      isInScope: (path) => this.pathPolicy?.isInScope(path) ?? false,
      trash: () => {
        const account = this.settings.account;
        if (!account || this.settings.connectionState !== "verified") return null;
        try {
          const credentials = this.auth.getVerifiedCredentials();
          return new NextcloudTrash(this.http, account.serverUrl, account.userId, basicAuthorization(credentials.loginName, credentials.appPassword));
        } catch { return null; }
      },
      remoteRoot: () => this.settings.remoteRootPath
    });
  }

  private refreshDeletionHold(plan: SyncPlan): void {
    if (!this.durableState) return;
    if (!this.settings.autoSyncAllowDeletes) { this.deletionHold.reset(); return; }
    const evaluation = this.deletionHold.evaluate(plan, this.settings.deleteConfirmThreshold, Object.keys(this.durableState.getState().files).length);
    if (evaluation.newlyHeld && this.settings.autoSyncAllowDeletes) this.announceHeldDeletions(true);
  }

  private announceHeldDeletions(notify: boolean): void {
    const pending = this.deletionHold.summary();
    if (!pending) return;
    this.logger.warn("deletions.held", { total: pending.total, files: pending.files, folders: pending.folders });
    void this.activity?.add([{ at: new Date().toISOString(), kind: "held-deletions", path: "", detail: `${plural(pending.total, "deletion")} ${isAre(pending.total)} waiting for your approval` }]);
    if (notify) new Notice(`Nyra is holding ${plural(pending.total, "deletion")} for your approval. Open the Nyra settings to review them.`, 15_000);
    this.refreshStatusBar();
  }

  private async recordReport(report: ExecutionReport): Promise<void> {
    try {
      await this.activity?.addReport(report);
      const at = new Date().toISOString();
      const removed = report.results.flatMap((result): DeletedFileRecord[] =>
        result.status === "completed" && result.deleted
          ? [{ path: result.path, blobHash: result.deleted.blobHash, size: result.deleted.size, deletedAt: at, removed: result.kind === "delete-local" ? "local" : "remote" }]
          : []);
      if (removed.length > 0) await this.recovery?.recordDeletions(removed);
    } catch (error) {
      this.logger.warn("activity.record-failed", { error: errorMessage(error) });
    }
  }

  // ---- conflict comparison and version history (see recovery/history-service.ts) ------

  conflictPreview(entryId: string): ReturnType<HistoryService["conflictPreview"]> { return this.history().conflictPreview(entryId); }
  fileVersions(path: string): Promise<FileVersion[]> { return this.history().listVersions(path); }
  compareFileVersion(path: string, version: FileVersion): ReturnType<HistoryService["compareVersion"]> { return this.history().compareVersion(path, version); }
  restoreFileVersion(path: string, version: FileVersion, mode: "copy" | "replace"): Promise<string> { return this.history().restoreVersion(path, version, mode); }

  private history(): HistoryService {
    if (!this.durableState || !this.localMutator || !this.activity) throw new Error(this.stateInitializationError ?? "History is unavailable.");
    const state = this.durableState;
    const mutator = this.localMutator;
    const activity = this.activity;
    return new HistoryService({
      state: () => state.getState(),
      readLocal: async (path, hash) => (await mutator.readVerified(path, hash)).bytes,
      writeLocal: async (path, bytes, expectedHash) => { await mutator.writeAtomic(path, bytes, expectedHash); },
      exists: async (path) => await this.app.vault.adapter.exists(path),
      getBlob: async (hash) => await state.getBlob(hash),
      downloadRemote: async (remote) => {
        const account = this.settings.account;
        if (!account || !remote.fileId || !remote.etag) throw new Error("Verify the Nextcloud connection first.");
        const remoteMutator = await this.createRemoteMutator(structuredClone(this.settings));
        const url = appendWebdavPath(appendWebdavPath(account.webdavRootUrl, this.settings.remoteRootPath), remote.path);
        const stream = await remoteMutator.openDownload(url, remote.path, remote.fileId, remote.etag);
        void stream.completed.catch(() => undefined);
        const parts: Uint8Array[] = [];
        for await (const chunk of stream.chunks) parts.push(new Uint8Array(chunk));
        await stream.completed;
        const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
        let offset = 0;
        for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
        return joined.buffer;
      },
      versions: () => this.versionsClient(),
      activity,
      noteLocalActivity: () => this.autoSync?.noteLocalActivity()
    });
  }

  private versionsClient(): NextcloudVersions {
    const account = this.settings.account;
    if (!account || this.settings.connectionState !== "verified") throw new Error("Verify the Nextcloud connection first.");
    const credentials = this.auth.getVerifiedCredentials();
    return new NextcloudVersions(this.http, account.serverUrl, account.userId, basicAuthorization(credentials.loginName, credentials.appPassword));
  }

  /** Mirrors folder creation and deletion (including empty folders) after the file engine has converged. */
  private async syncFoldersInternal(allowDeletes: boolean): Promise<number> {
    const tree = this.lastRemoteTree;
    const account = this.settings.account;
    if (!tree || !this.pathPolicy || !this.deviceScope || !account || this.settings.connectionState !== "verified" ||
      !this.localFactsComplete || !this.remoteFactsComplete || this.remoteWriteSafetyError !== null) {
      this.logger.debug("folders.skipped", { remoteTree: tree !== null, localComplete: this.localFactsComplete, remoteComplete: this.remoteFactsComplete });
      return 0;
    }
    const policy = this.pathPolicy;
    const settings = structuredClone(this.settings);
    const remote = await this.createRemoteMutator(settings);
    const remoteBase = appendWebdavPath(account.webdavRootUrl, settings.remoteRootPath);
    const local = new LocalFolderAccess(this.app.vault.adapter, policy);
    const baselinePath = `${getPluginDeviceRuntimeRoot(this.app.vault.configDir, this.manifest.id, this.deviceScope)}/folders-v1.json`;
    const service = new FolderSyncService({
      listLocalTree: async () => await local.listTree(),
      createLocalFolder: async (path) => await local.create(path),
      removeLocalFolderIfEmpty: async (path) => await local.removeIfEmpty(path),
      createRemoteFolder: async (path) => await remote.ensureDirectoryPath(remoteBase, path),
      removeRemoteFolderIfEmpty: async (path) => await remote.removeEmptyDirectory(appendWebdavPath(remoteBase, path), path)
    }, new FolderBaselineStore(this.app.vault.adapter, baselinePath), this.logger);
    const limit = this.deletionHold.folderLimit(settings.deleteConfirmThreshold);
    const input: Parameters<FolderSyncService["run"]>[0] = {
      remoteFolders: tree.folders.filter((folder) => policy.isFolderInScope(folder)),
      remoteFiles: tree.files,
      allowDeletes
    };
    if (limit !== undefined) input.maxDeletes = limit;
    const hadApproval = this.deletionHold.hasApproval();
    const result = await service.run(input);
    this.deletionHold.setHeldFolders(result.held);
    if (result.held > 0) this.announceHeldDeletions(true);
    if (hadApproval && result.held === 0 && this.deletionHold.summary() === null) this.deletionHold.consumeApproval();
    await this.activity?.add(result.operations.map((operation): ActivityEntry => ({
      at: new Date().toISOString(), kind: operation.action === "created" ? "folder-created" : "folder-deleted", path: operation.path,
      detail: operation.side === "remote" ? "on Nextcloud" : "on this device"
    })));
    return result.created + result.deleted;
  }

  private async assertConvergenceHealthy(operation: string): Promise<void> {
    const report = await this.auditConvergence(false);
    if (report.errors === 0) return;
    const first = report.issues.find((issue) => issue.severity === "error");
    throw new Error(`Convergence safety audit blocked ${operation}: ${first?.message ?? `${plural(report.errors, "semantic state error")}.`}`);
  }

  private async retrySafeMerge(entryId: string): Promise<ExecutionReport> {
    return await this.runManualOperation(async () => {
      const local = await this.scanLocalVaultInternal("explicit-merge-review-local");
      const remote = await this.scanRemoteVaultInternal();
      if (!local.scan.complete || remote.scan.trust !== "authoritative" || !this.localFactsComplete || !this.remoteFactsComplete) {
        throw new Error("Retrying a safe merge needs complete LOCAL and REMOTE inventories.");
      }
      const plan = await this.buildSyncPlanInternal();
      const retryPlan = await makeSafeMergeRetryPlan(plan, entryId);
      return await this.applyCurrentSyncPlanInternal(false, "bidirectional", retryPlan, true);
    });
  }

  private async createRemoteMutator(settings: PluginSettings): Promise<RemoteTransactionalMutator> {
    const account = settings.account;
    if (settings.connectionState !== "verified" || !account) throw new Error("Verify the Nextcloud connection first.");
    const credentials = this.auth.getVerifiedCredentials();
    const journal = this.transferJournal ?? new TransferJournalStore(this.app.vault, this.manifest.id, this.logger, this.requireDeviceScope());
    this.transferJournal = journal;
    await journal.ensure();
    return new RemoteTransactionalMutator(this.http, credentials, this.logger, {
      serverUrl: account.serverUrl,
      userId: account.userId,
      webdavUserRoot: account.webdavRootUrl,
      tuning: transferTuningFromSettings(settings),
      journal
    });
  }

  private async nextConflictCopyPath(sourcePath: string, side: "LOCAL" | "REMOTE", hash: string): Promise<string> {
    if (!this.pathPolicy || !this.localMutator) throw new Error("Local path policy is unavailable for conflict preservation.");
    const state = this.durableState?.getState();
    const base = conflictCopyPath(sourcePath, side, hash);
    for (let index = 0; index < 100; index += 1) {
      const candidate = canonicalVaultRelativePath(index === 0 ? base : addConflictSuffix(base, index + 1));
      if (!this.pathPolicy.isIncluded(candidate)) throw new Error("Conflict copy would fall outside the current sync scope.");
      if (state?.remotePathIndex[candidate]) continue;
      if (await this.app.vault.adapter.exists(candidate)) {
        try {
          const existing = await this.localMutator.readVerified(candidate);
          if (existing.contentHash === hash) return candidate;
        } catch { /* An occupied, unverified target is never overwritten. */ }
        continue;
      }
      return candidate;
    }
    throw new Error(`Could not find a free conflict-copy path beside '${sourcePath}'.`);
  }

  private async preserveLocalConflictVersion(sourcePath: string, expectedHash: string, targetPath: string): Promise<void> {
    if (!this.localMutator) throw new Error("Local mutation service is unavailable.");
    if (await this.app.vault.adapter.exists(targetPath)) {
      const existing = await this.localMutator.readVerified(targetPath, expectedHash);
      if (existing.contentHash !== expectedHash) throw new Error(`Conflict copy '${targetPath}' does not match its expected content.`);
      return;
    }
    const source = await this.localMutator.readVerified(sourcePath, expectedHash);
    const copy = await this.localMutator.writeAtomic(targetPath, source.bytes, null);
    if (copy.contentHash !== expectedHash) throw new Error(`Conflict copy '${targetPath}' failed SHA-256 verification.`);
  }

  private async preserveRemoteConflictVersion(
    remote: RemoteReplicaState,
    targetPath: string,
    mutator: RemoteTransactionalMutator
  ): Promise<void> {
    if (!this.localMutator || !remote.contentHash || !remote.fileId || !remote.etag) {
      throw new Error("Remote conflict copy requires a verified content hash, fileId, and ETag.");
    }
    if (await this.app.vault.adapter.exists(targetPath)) {
      const existing = await this.localMutator.readVerified(targetPath, remote.contentHash);
      if (existing.contentHash !== remote.contentHash) throw new Error(`Conflict copy '${targetPath}' does not match its expected content.`);
      return;
    }
    const account = this.settings.account;
    if (!account || this.settings.connectionState !== "verified") throw new Error("Verified Nextcloud connection required to preserve the remote conflict version.");
    const url = appendWebdavPath(appendWebdavPath(account.webdavRootUrl, this.settings.remoteRootPath), remote.path);
    const stream = await mutator.openDownload(url, remote.path, remote.fileId, remote.etag);
    void stream.completed.catch(() => undefined);
    const written = await this.localMutator.writeAtomicFromChunks(targetPath, stream.chunks, null, remote.contentHash, remote.size);
    const completed = await stream.completed;
    if (written.contentHash !== completed.contentHash || completed.contentHash !== remote.contentHash) {
      throw new Error(`Remote conflict copy '${targetPath}' failed SHA-256 verification.`);
    }
  }

  /** Server, account and folder only: what a server capability probe is valid for. */
  private serverIdentity(settings: PluginSettings): string {
    return JSON.stringify([settings.account?.serverUrl ?? settings.serverUrl, settings.account?.userId ?? null, settings.remoteRootPath]);
  }

  private syncScopeKey(settings: PluginSettings): string {
    const account = settings.account;
    return JSON.stringify({
      serverUrl: account?.serverUrl ?? settings.serverUrl,
      userId: account?.userId ?? null,
      webdavRootUrl: account?.webdavRootUrl ?? null,
      remoteRootPath: settings.remoteRootPath,
      syncObsidianConfig: settings.syncObsidianConfig,
      excludePatterns: settings.excludePatterns,
      includeFolders: settings.includeFolders,
      selectiveExcludes: settings.selectiveExcludes,
      maxFileSizeMiB: settings.maxFileSizeMiB
    });
  }

  /** Compiled user scope rules, rebuilt only when the settings object is replaced (not on every path check). */
  private currentUserRules(): UserScopeRules {
    if (this.userRulesSource !== this.settings) {
      this.userRules = new UserScopeRules({
        excludePatterns: this.settings.excludePatterns,
        includeFolders: this.settings.includeFolders,
        excludePaths: this.settings.selectiveExcludes
      });
      this.userRulesSource = this.settings;
    }
    return this.userRules;
  }

  /** One level of the file picker: this device and Nextcloud combined, including items the user excluded. */
  async listSyncTree(folder: string): Promise<SyncTreeListing> {
    const policy = this.pathPolicy;
    if (!policy) throw new Error(this.stateInitializationError ?? "The vault scan is not ready yet.");
    const account = this.settings.account;
    let remote: SyncTreeSources["remote"];
    if (account && this.settings.connectionState === "verified") {
      try {
        remote = { client: new NextcloudDavClient(this.http, this.auth.getVerifiedCredentials(), this.logger, 1), rootUrl: appendWebdavPath(account.webdavRootUrl, this.settings.remoteRootPath) };
      } catch { remote = undefined; }
    }
    return listSyncTreeChildren({ adapter: this.app.vault.adapter, isInBaseScope: (path) => policy.isInBaseScope(path), remote }, folder);
  }

  /** Paths the user unchecked in the file picker. */
  syncSelectionExcludes(): readonly string[] { return this.settings.selectiveExcludes; }

  /**
   * Checks or unchecks one file or folder for synchronization. Changes are applied one after another and wait
   * for a running sync to finish, because the scope must not change under an executing plan.
   */
  setSyncSelection(path: string, included: boolean): Promise<string[]> {
    const task = this.selectionQueue.then(async () => {
      const next = await setIncluded(this.settings.selectiveExcludes, path, included, async (folder) => (await this.listSyncTree(folder)).entries.map((entry) => entry.path));
      await this.applySelectiveExcludes(next);
      return next;
    });
    this.selectionQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  /** Includes everything again. */
  resetSyncSelection(): Promise<void> {
    const task = this.selectionQueue.then(() => this.applySelectiveExcludes([]));
    this.selectionQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async applySelectiveExcludes(next: readonly string[]): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (this.isSyncBusy()) {
      if (this.shuttingDown || Date.now() > deadline) throw new Error("A sync is still running. Try again in a moment.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.updateSettings((settings) => { settings.selectiveExcludes = [...next]; });
  }

  deviceFileLimitMiB(): number { return Math.floor(this.platform.maxSafeWholeReadBytes / (1024 * 1024)); }

  /** The device's safe whole-file limit, optionally lowered by the user. */
  private effectiveMaxFileBytes(): number {
    const device = this.platform.maxSafeWholeReadBytes;
    const userMiB = this.settings.maxFileSizeMiB;
    return userMiB > 0 ? Math.min(device, userMiB * 1024 * 1024) : device;
  }

  private canAutoSyncRun(): boolean {
    if (this.shuttingDown || this.runtimeInitializing || this.stateInitializationError !== null || this.remoteWriteSafetyError !== null || this.runtimeScopeReloadRequired || (this.operationGuard.isBusy() && !this.operationGuard.isOwnedBy("autosync")) || this.settings.connectionState !== "verified" || !this.settings.account || this.auth.isLoginActive()) return false;
    try { this.auth.getVerifiedCredentials(); return true; }
    catch { return false; }
  }

  private assertManualOperationAvailable(): void {
    if (this.runtimeInitializing) throw new Error("Nyra is verifying local recovery state. Sync will be available as soon as this check finishes.");
    if (this.stateInitializationError !== null) throw new Error("Nyra could not verify its local recovery state. Sync is paused; open plugin settings for details.");
    if (this.runtimeScopeReloadRequired) throw new Error(this.stateInitializationError ?? "Reload Nyra before syncing the changed remote folder.");
    if (this.executionActive || this.operationGuard.isBusy()) throw new Error("A sync operation is currently active.");
    if (this.autoSync?.isBusy()) throw new Error("Auto-sync owns the synchronization cycle. Try again after it finishes.");
  }

  private async runManualOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) throw new Error("Nyra is stopping; no new sync operation can start.");
    if (this.runtimeScopeReloadRequired) throw new Error(this.stateInitializationError ?? "Reload Nyra before syncing the changed remote folder.");
    this.assertManualOperationAvailable();
    const releaseOperation = this.operationGuard.tryAcquire("manual");
    if (!releaseOperation) throw new Error("A sync operation is currently active.");
    this.refreshStatusBar();
    try {
      return await operation();
    } finally {
      releaseOperation();
      this.refreshStatusBar();
    }
  }

  private async cleanupFailedRuntimeInitialization(): Promise<void> {
    this.autoSync?.close();
    this.localWatcher?.onunload();
    await this.operationGuard.waitForIdle();
    await this.localInventory?.whenIdle().catch(() => undefined);
    this.localInventory?.close();
    this.remoteInventory?.close();
    this.planner?.close();
    this.executor?.close();
    const state = this.durableState;
    this.durableState = null;
    await state?.close();
    this.runtimeWriterLease?.release();
    this.runtimeWriterLease = null;
  }

  private async finishRuntimeShutdown(): Promise<void> {
    await this.runtimeInitializationDone;
    await this.operationGuard.waitForIdle();
    await this.localInventory?.whenIdle().catch((error: unknown) => {
      this.logger.warn("lifecycle.local-inventory-drain-failed", { error: errorMessage(error) });
    });
    this.localInventory?.close();
    this.remoteInventory?.close();
    this.planner?.close();
    this.executor?.close();
    const state = this.durableState;
    this.durableState = null;
    await state?.close();
    this.runtimeWriterLease?.release();
    this.runtimeWriterLease = null;
  }

  private registerLifecycleWakeups(): void {
    const wake = (): void => {
      const now = Date.now();
      if (now - this.lastLifecycleWakeAt < 750) return;
      this.lastLifecycleWakeAt = now;
      this.healthMonitor?.poke(50);
      this.autoSync?.noteForegroundResume();
      this.refreshStatusBar();
    };
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        wake();
      } else {
        // Best effort only: persist queued local observations before suspension;
        // mobile platforms may stop JavaScript before asynchronous work finishes.
        void this.localWatcher?.flushPending().then(async () => await this.localInventory?.whenIdle()).catch((error: unknown) => {
          this.logger.debug("lifecycle.local-flush-deferred", { error: errorMessage(error) });
        });
      }
    });
    this.registerDomEvent(window, "focus", wake);
    this.registerDomEvent(window, "online", wake);
  }

  private refreshStatusBar(): void {
    if (!this.statusBarEl) return;
    const status = describeStatusBar({
      settings: this.settings,
      health: this.serverHealthSummary(),
      auto: this.autoSyncSummary(),
      execution: this.executionSummary(),
      syncBusy: this.isSyncBusy(),
      convergenceErrors: this.lastConvergenceAudit?.errors ?? 0,
      pendingDeletions: this.deletionHold.summary()?.total ?? 0
    });
    this.statusBarEl.textContent = status.text;
    this.statusBarEl.title = status.detail;
  }
}

export type { SyncConflictReview } from "./plugin/conflict-copies";
