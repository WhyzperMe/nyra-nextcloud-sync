import { Notice, PluginSettingTab, Setting, type App, type TextComponent } from "obsidian";
import { errorMessage } from "../core/errors";
import { normalizeServerUrl, parseNextcloudLocation } from "../security/url-policy";
import type NyraNextcloudSyncPlugin from "../main";
import { formatBytes } from "./format";
import { renderActivityFeed, renderPendingDeletions } from "./activity-section";
import { createIcon } from "./icons";
import { type TabId, heroDetail, heroStats, heroTitle, heroVariant, renderHeader, renderHero, renderTabs } from "./layout";
import { renderDeletionSection, renderScopeSection } from "./scope-section";
import { SyncTreeView } from "./sync-tree-view";
import { conflictReview, planRow } from "./conflict-review";
import { appendErrorDetail, captureSettingsView, createSection, metric, restoreDetails, restoreFocus, restoreScroll, statusCard } from "./settings-dom";
import { autoDetail, autoHeadline, autoTone, capitalize, connectionTone, convergenceDetail, convergenceHeadline, convergenceTone, durableDetail, durableHeadline, encodeRemoteForDisplay, executionDetail, executionHeadline, executionRuntimeText, executionTone, healthDetail, healthHeadline, healthTone, humanState, inventoryTone, localDetail, localHeadline, planNotice, plannerDetail, plannerHeadline, plannerTone, remoteDetail, remoteHeadline, sameCanonicalServer, syncPresentation } from "./settings-text";
import { needs, plural } from "../core/plural";

let choiceMenuSequence = 0;

export class NyraNextcloudSyncSettingTab extends PluginSettingTab {
  private readonly busy = new Set<string>();
  private readonly pendingSettingsWrites = new Set<Promise<void>>();
  private destructiveArmedUntil = 0;
  private runtimeRefreshTimer: number | null = null;
  private observedSyncBusy: boolean | null = null;
  private loginCancelRequested = false;
  private browserPreparationPendingServer: string | null = null;
  private browserPreparationFailedServer: string | null = null;
  private browserPreparationError: string | null = null;
  private resolveLoginStartCancel: (() => void) | null = null;
  private supportReportFallback: string | null = null;
  private displayRevision = 0;
  private menuListeners: AbortController | null = null;
  private activeTab: TabId | null = null;
  private scrollToTabsOnce = false;
  private readonly syncTree: SyncTreeView;

  constructor(app: App, private readonly owner: NyraNextcloudSyncPlugin) {
    super(app, owner);
    this.syncTree = new SyncTreeView(owner);
  }

  hide(): void {
    this.menuListeners?.abort();
    this.menuListeners = null;
    super.hide();
  }

  display(): void {
    const { containerEl } = this;
    const snapshot = captureSettingsView(containerEl);
    const revision = ++this.displayRevision;
    this.menuListeners?.abort();
    this.menuListeners = new AbortController();
    containerEl.empty();
    containerEl.classList.add("nyra-nc-settings");
    const layout = document.createElement("div");
    layout.className = "nyra-nc-settings-layout";
    const content = document.createElement("div");
    content.className = "nyra-nc-settings-content";
    layout.appendChild(content);
    containerEl.appendChild(layout);
    const connected = this.owner.settings.connectionState === "verified";
    const tab: TabId = this.activeTab ?? (connected ? "overview" : "account");
    const presentation = syncPresentation(this.owner);
    renderHeader(content, this.owner.manifest.version, this.owner);
    renderHero(content, this.owner, presentation, {
      onSyncNow: () => this.syncNow(),
      onTogglePause: () => { void this.updateAndDisplay((settings) => { settings.syncPaused = !settings.syncPaused; }); },
      onConnect: () => this.selectTab("account"),
      syncing: this.busy.has("sync-now") || this.owner.isSyncBusy(),
      disabled: !connected
    }, heroStats(this.owner));
    const conflicts = this.owner.syncConflictReviews().length;
    const held = this.owner.pendingDeletions() ? 1 : 0;
    renderTabs(content, tab, { overview: conflicts + held, safety: held }, (next) => this.selectTab(next));
    const panel = content.createDiv({ cls: "nyra-nc-panel" });
    panel.setAttribute("role", "tabpanel");
    panel.dataset.nyraTab = tab;
    if (tab === "overview") this.renderOverviewPanel(panel);
    else if (tab === "account") { this.renderConnectionSection(panel); this.renderRemoteSection(panel); }
    else if (tab === "files") this.renderFilesPanel(panel);
    else if (tab === "sync") { this.renderAutoSyncSection(panel); this.renderCrossDeviceSection(panel); }
    else if (tab === "safety") { this.renderDeletionSection(panel); this.renderSafetySection(panel); }
    else { this.renderPlanSection(panel); this.renderExecutionSection(panel); this.renderTransferSection(panel); this.renderIntegritySection(panel); }
    markToggleRows(panel);
    document.addEventListener("pointerdown", (event) => {
      if (event.target instanceof Element && containerEl.contains(event.target) && event.target.closest(".nyra-nc-select")) return;
      containerEl.querySelectorAll<HTMLDetailsElement>(".nyra-nc-select[open]").forEach((menu) => { menu.open = false; });
    }, { signal: this.menuListeners.signal });
    this.observedSyncBusy = this.owner.isSyncBusy();
    this.refreshLiveRuntime();
    this.ensureRuntimeRefresh();
    restoreDetails(content, snapshot.details);
    restoreScroll(snapshot.scroll);
    requestAnimationFrame(() => {
      if (revision !== this.displayRevision) return;
      if (this.scrollToTabsOnce) {
        this.scrollToTabsOnce = false;
        content.querySelector(".nyra-nc-tabs")?.scrollIntoView({ block: "start" });
        return;
      }
      restoreScroll(snapshot.scroll);
      if (!content.querySelector(".nyra-nc-support-report")) restoreFocus(containerEl, snapshot.focus);
      if (snapshot.windowX !== window.scrollX || snapshot.windowY !== window.scrollY) {
        window.scrollTo(snapshot.windowX, snapshot.windowY);
      }
    });
  }

  private ensureRuntimeRefresh(): void {
    if (this.runtimeRefreshTimer !== null) return;
    this.runtimeRefreshTimer = this.owner.registerInterval(window.setInterval(() => {
      if (!this.containerEl.isConnected || this.containerEl.getClientRects().length === 0 || document.visibilityState !== "visible") return;
      const busy = this.owner.isSyncBusy();
      if (this.observedSyncBusy !== busy) {
        this.observedSyncBusy = busy;
        // Refresh controls once at the operation boundary; live progress below
        // updates in place so long syncs do not rebuild the settings DOM.
        this.display();
        return;
      }
      this.refreshLiveRuntime();
    }, 750));
  }

  /** Updates the status block in place; the DOM is only touched when a value actually changed. */
  private refreshLiveRuntime(): void {
    const hero = this.containerEl.querySelector<HTMLElement>('[data-nyra-live-status="true"]');
    if (!hero) return;
    const presentation = syncPresentation(this.owner);
    setTextIfChanged(hero.querySelector<HTMLElement>(".nyra-nc-hero__title"), heroTitle(this.owner, presentation));
    setTextIfChanged(hero.querySelector<HTMLElement>(".nyra-nc-hero__detail"), heroDetail(this.owner, presentation));
    const nextClass = `nyra-nc-hero nyra-nc-hero--${heroVariant(this.owner, presentation)}`;
    if (hero.className !== nextClass) hero.className = nextClass;

    const progress = hero.querySelector<HTMLElement>(".nyra-nc-live-progress");
    const label = progress?.querySelector<HTMLElement>(".nyra-nc-live-progress__label");
    const track = progress?.querySelector<HTMLElement>(".nyra-nc-progress");
    const fill = track?.querySelector<HTMLElement>("span");
    if (progress && progress.hidden === Boolean(presentation.progressLabel)) progress.hidden = !presentation.progressLabel;
    setTextIfChanged(label ?? null, presentation.progressLabel);
    if (track && fill) {
      const fraction = presentation.progressFraction;
      track.classList.toggle("is-indeterminate", fraction === null);
      if (fraction === null) track.removeAttribute("aria-valuenow");
      else {
        track.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
        fill.style.transform = `scaleX(${fraction.toFixed(3)})`;
      }
      track.setAttribute("aria-label", presentation.progressLabel || "Sync progress");
    }
    setTextIfChanged(this.containerEl.querySelector<HTMLElement>(".nyra-nc-execution-note"), executionRuntimeText(this.owner.executionSummary()));
  }

  private selectTab(tab: TabId): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    if (tab === "files") this.syncTree.invalidate();
    this.scrollToTabsOnce = true;
    this.display();
  }

  private syncNow(): void {
    void this.run("sync-now", async () => {
      const result = await this.owner.runAutoSyncNow();
      if (!result) { new Notice("Sync deferred until Nextcloud is available."); return; }
      if (result.executed) new Notice(`Sync complete · ${plural(result.completedSteps, "step")}.`);
      else if (result.reviewItems > 0 || result.blockedSteps > 0) new Notice(`${plural(result.reviewItems || result.blockedSteps, "item")} ${needs(result.reviewItems || result.blockedSteps)} review.`);
      else new Notice("Already up to date.");
    }, "Sync failed");
  }

  private renderOverviewPanel(panel: HTMLElement): void {
    const connected = this.owner.settings.connectionState === "verified";
    if (!connected) {
      this.renderWelcome(panel);
      return;
    }
    this.renderAttention(panel);
    this.renderActivitySection(panel);
    this.renderDiagnostics(panel);
  }

  /** First-run guidance shown instead of an empty dashboard. */
  private renderWelcome(panel: HTMLElement): void {
    const card = panel.createDiv({ cls: "nyra-nc-welcome" });
    card.createEl("h3", { text: "Get your vault in sync in three steps" });
    const steps = card.createEl("ol", { cls: "nyra-nc-steps" });
    for (const [title, text] of [
      ["Connect", "Enter your Nextcloud address and approve access in the browser. Your password never reaches Obsidian."],
      ["Choose a folder", "Pick the Nextcloud folder that holds this vault. Use the same folder on every device."],
      ["Done", "Edits sync after a second of quiet. Deletions, conflicts and large changes always ask first."]
    ] as const) {
      const item = steps.createEl("li");
      item.createEl("strong", { text: title });
      item.createSpan({ text: text });
    }
    const go = card.createEl("button", { cls: "mod-cta", text: "Open account settings" });
    go.addEventListener("click", () => this.selectTab("account"));
  }

  /** Everything that needs a decision, most urgent first. */
  private renderAttention(panel: HTMLElement): void {
    const errors = [this.owner.stateInitializationError, this.owner.remoteWriteSafetyError].filter((message): message is string => Boolean(message));
    for (const message of errors) {
      const box = panel.createDiv({ cls: "nyra-nc-alert nyra-nc-alert--error" });
      box.appendChild(createIcon("x-circle", 18));
      const text = box.createDiv({ cls: "nyra-nc-alert__text" });
      text.createEl("strong", { text: "Sync is paused" });
      appendErrorDetail(text, message);
    }
    const auto = this.owner.autoSyncSummary();
    if (auto?.lastError && (auto.status === "error" || auto.status === "attention")) {
      const box = panel.createDiv({ cls: "nyra-nc-alert nyra-nc-alert--error" });
      box.appendChild(createIcon("x-circle", 18));
      const text = box.createDiv({ cls: "nyra-nc-alert__text" });
      text.createEl("strong", { text: auto.consecutiveFailures > 1 ? `Last sync failed (${auto.consecutiveFailures} times in a row)` : "Last sync failed" });
      appendErrorDetail(text, auto.lastError);
      const actions = text.createDiv({ cls: "nyra-nc-alert__actions" });
      actions.createEl("button", { text: "Try again" }).addEventListener("click", () => {
        void this.owner.runAutoSyncNow().catch((error: unknown) => new Notice(`Sync failed: ${errorMessage(error)}`, 10_000)).finally(() => this.display());
      });
    }
    renderPendingDeletions(panel, this.owner, () => this.display());
    const conflicts = this.owner.syncConflictReviews();
    if (conflicts.length > 0) {
      const section = createSection(panel, "Review both versions", "Nyra has not chosen a winner. Compare this device, the common ancestor and Nextcloud; timestamps are metadata only and never decide which content wins.");
      for (const conflict of conflicts.slice(0, 30)) section.appendChild(conflictReview(conflict, this.owner, () => this.display()));
    }
  }

  private renderDiagnostics(panel: HTMLElement): void {
    const planner = this.owner.plannerSummary();
    const health = this.owner.serverHealthSummary();
    const auto = this.owner.autoSyncSummary();
    const advanced = panel.createEl("details", { cls: "nyra-nc-diagnostics" });
    advanced.dataset.nyraStateKey = "overview-diagnostics";
    const title = advanced.createEl("summary");
    title.dataset.nyraFocusKey = "overview-diagnostics-summary";
    title.appendChild(createIcon("info", 15));
    title.createSpan({ text: "Diagnostics" });
    const grid = advanced.createDiv({ cls: "nyra-nc-diag-grid" });
    grid.append(
      statusCard("Account", humanState(this.owner.settings.connectionState), connectionTone(this.owner.settings.connectionState), this.connectionDetail()),
      statusCard("Server", healthHeadline(health), healthTone(health?.state), healthDetail(health)),
      statusCard("Auto-sync", autoHeadline(auto), autoTone(auto?.status), autoDetail(auto)),
      statusCard("Durable state", durableHeadline(this.owner.durableStateSummary()), this.owner.durableStateSummary()?.status === "ready" ? "ok" : "warn", durableDetail(this.owner)),
      statusCard("Consistency", convergenceHeadline(this.owner.convergenceAuditSummary()), convergenceTone(this.owner.convergenceAuditSummary()), convergenceDetail(this.owner.convergenceAuditSummary())),
      statusCard("Local", localHeadline(this.owner.localInventorySummary()), inventoryTone(this.owner.localInventorySummary()?.status), localDetail(this.owner)),
      statusCard("Remote", remoteHeadline(this.owner.remoteInventorySummary()), inventoryTone(this.owner.remoteInventorySummary()?.status), remoteDetail(this.owner)),
      statusCard("Plan", plannerHeadline(planner), plannerTone(planner?.status), plannerDetail(planner, this.owner.settings.autoMergeText)),
      statusCard("Execution", executionHeadline(this.owner.executionSummary()), executionTone(this.owner.executionSummary()?.status), executionDetail(this.owner.executionSummary()))
    );
  }

  private renderCrossDeviceSection(containerEl: HTMLElement): void {
    const section = createSection(containerEl, "Devices", "Set up another device, or choose a one-way first link when auto-sync is off.");
    const busy = this.owner.isSyncBusy();

    new Setting(section)
      .setName("Sync Obsidian settings")
      .setDesc("Off is recommended for iPad. Notes and attachments still sync; .obsidian stays device-local. Nyra's own plugin folder and workspace files are always local.")
      .addToggle((toggle) => toggle.setValue(this.owner.settings.syncObsidianConfig).setDisabled(busy).onChange((value) => {
        return this.updateAndDisplay((settings) => { settings.syncObsidianConfig = value; });
      }));

    new Setting(section)
      .setName("Publish this vault")
      .setDesc("Optional one-way first-device setup. Disable auto-sync first; Nyra creates the folder if needed and publishes only into an empty remote scope.")
      .addButton((button) => button.setButtonText(this.busy.has("publish") ? "Publishing…" : "Upload to Nextcloud").setCta().setDisabled(busy || this.busy.has("publish") || this.owner.settings.connectionState !== "verified").onClick(() => {
        void this.run("publish", async () => {
          const report = await this.owner.publishVaultToNextcloud();
          new Notice(`Vault published · ${plural(report.completed, "step")}.`);
        }, "Publish blocked");
      }));

    new Setting(section)
      .setName("Download on this device")
      .setDesc("Optional one-way setup for a new device. Disable auto-sync first; files download only into an empty local sync scope and the remote vault stays unchanged.")
      .addButton((button) => button.setButtonText(this.busy.has("download-vault") ? "Downloading…" : "Download from Nextcloud").setDisabled(busy || this.busy.has("download-vault") || this.owner.settings.connectionState !== "verified").onClick(() => {
        void this.run("download-vault", async () => {
          const report = await this.owner.downloadVaultToThisDevice();
          new Notice(`Vault downloaded · ${plural(report.completed, "step")}.`);
        }, "Download blocked");
      }));

    const note = document.createElement("div");
    note.className = "nyra-nc-callout nyra-nc-callout--neutral";
    note.textContent = "Auto-sync starts after login. To choose a one-way first link, turn auto-sync off before connecting. iOS resumes remote discovery when Obsidian returns to the foreground.";
    section.appendChild(note);
  }

  private renderAutoSyncSection(containerEl: HTMLElement): void {
    const section = createSection(containerEl, "Auto-sync", "Waits for edits to settle, then verifies both sides before any write. Expected server downtime stays silent.");
    const busy = this.owner.isSyncBusy();

    new Setting(section)
      .setName("Auto-sync edited files")
      .setDesc("Local activity schedules one safe transactional sync after the quiet period.")
      .addToggle((toggle) => toggle.setValue(this.owner.settings.autoSyncEnabled).setDisabled(busy).onChange((value) => {
        return this.updateAndDisplay((settings) => { settings.autoSyncEnabled = value; });
      }));

    this.addSelectSetting(section, "Quiet period", "After about one second without edits, Nyra reads the changed paths and starts a verified sync cycle.",
      [["1", "1 second"], ["2", "2 seconds"], ["5", "5 seconds"], ["10", "10 seconds"], ["30", "30 seconds"], ["60", "1 minute"], ["120", "2 minutes"]],
      String(this.owner.settings.autoSyncQuietSeconds), busy,
      (value) => this.updateAndDisplay((settings) => { settings.autoSyncQuietSeconds = Number.parseInt(value, 10); }));

    this.addSelectSetting(section, "Check remote changes", "Full WebDAV scans start at this interval and back off gradually while nothing changes. Foreground resume triggers an immediate safe scan.",
      [["15", "Every 15 seconds"], ["30", "Every 30 seconds"], ["60", "Every minute"], ["300", "Every 5 minutes"], ["900", "Every 15 minutes"], ["1800", "Every 30 minutes"]],
      String(this.owner.settings.autoSyncRemotePollSeconds), busy,
      (value) => this.updateAndDisplay((settings) => { settings.autoSyncRemotePollSeconds = Number.parseInt(value, 10); }));

    new Setting(section)
      .setName("Efficient polling")
      .setDesc("Background checks first ask Nextcloud whether anything changed (one small request) and skip the full scan when nothing did. Enabled only after Nyra verified that your server reports changes this way; a full scan still runs at least every 5 minutes.")
      .addToggle((toggle) => toggle.setValue(this.owner.settings.fastRemoteCheck).setDisabled(busy).onChange((value) => {
        return this.updateAndDisplay((settings) => { settings.fastRemoteCheck = value; });
      }));

    new Setting(section)
      .setName("Safe text auto-merge")
      .setDesc("Automatically merges only bounded, non-overlapping BASE/LOCAL/REMOTE edits in Markdown or plain text. Overlaps stay blocked; Nyra never writes conflict markers automatically.")
      .addToggle((toggle) => toggle.setValue(this.owner.settings.autoMergeText).setDisabled(busy).onChange((value) => {
        return this.updateAndDisplay((settings) => { settings.autoMergeText = value; });
      }));

    new Setting(section)
      .setName("Pause auto-sync")
      .setDesc("Stops automatic syncing until you resume. Sync now still works. Useful on metered connections or while reorganizing files.")
      .addToggle((toggle) => toggle.setValue(this.owner.settings.syncPaused).setDisabled(busy).onChange((value) => {
        return this.updateAndDisplay((settings) => { settings.syncPaused = value; });
      }));
  }

  private renderActivitySection(containerEl: HTMLElement): void {
    const section = createSection(containerEl, "Recent activity", "What the last syncs did.");
    renderActivityFeed(section, this.owner);
  }

  private renderDeletionSection(containerEl: HTMLElement): void {
    const section = createSection(containerEl, "Deletions", "Deleted items are synced with a safety net: large deletions wait for you, and everything stays restorable.");
    renderDeletionSection(section, this.owner, (mutator) => this.queueSettingsWrite(mutator));
  }

  private renderFilesPanel(panel: HTMLElement): void {
    const section = createSection(panel, "Files and folders", "Everything is synced by default. Uncheck what should stay out: unchecked items are never uploaded, downloaded or deleted.");
    this.syncTree.render(section);
    const rules = createSection(panel, "Rules and limits", "For patterns such as *.tmp and for very large files.");
    renderScopeSection(rules, this.owner, (mutator) => this.queueSettingsWrite(mutator));
  }

  private renderPlanSection(containerEl: HTMLElement): void {
    const section = createSection(containerEl, "Sync plan", "Deterministic BASE / LOCAL / REMOTE classification. Unknown content is verified, never guessed.");
    new Setting(section)
      .setName("Build plan")
      .setDesc("Read-only. A plan is invalidated automatically when durable inventory changes.")
      .addButton((button) => button.setButtonText(this.busy.has("plan") ? "Planning…" : "Build sync plan").setDisabled(this.owner.durableStateSummary() === null || this.owner.isSyncBusy() || this.busy.has("plan")).onClick(() => {
        void this.run("plan", async () => { const plan = await this.owner.buildSyncPlan(); new Notice(planNotice(plan)); }, "Planning failed");
      }));

    const plan = this.owner.currentSyncPlan();
    const runtime = this.owner.plannerSummary();
    if (!plan) {
      const empty = document.createElement("div");
      empty.className = "nyra-nc-empty";
      empty.textContent = runtime?.status === "stale" ? "Plan is stale. Build a fresh plan." : "No current plan.";
      section.appendChild(empty);
      return;
    }

    const strip = document.createElement("div");
    strip.className = "nyra-nc-plan-summary";
    strip.append(
      metric("Ready", plan.summary.ready, "ok"),
      metric("Verify", plan.summary.needsVerification, "warn"),
      metric(this.owner.settings.autoMergeText ? "Auto-merge" : "Review merge", plan.summary.mergeCandidates, "warn"),
      metric("Blocked", plan.summary.blocked, plan.summary.blocked ? "error" : "neutral"),
      metric("No-op", plan.summary.noop, "neutral")
    );
    section.appendChild(strip);

    const actionable = plan.items.filter((entry) => entry.disposition !== "noop");
    if (actionable.length === 0) {
      const synced = document.createElement("div");
      synced.className = "nyra-nc-empty nyra-nc-empty--ok";
      synced.textContent = "Everything is in sync.";
      section.appendChild(synced);
      return;
    }
    const list = document.createElement("div");
    list.className = "nyra-nc-plan-list";
    for (const entry of actionable.slice(0, 30)) list.appendChild(planRow(entry));
    section.appendChild(list);
    if (actionable.length > 30) {
      const note = document.createElement("div");
      note.className = "nyra-nc-list-note";
      note.textContent = `Showing 30 of ${actionable.length} actionable records.`;
      section.appendChild(note);
    }
  }

  private renderExecutionSection(containerEl: HTMLElement): void {
    const section = createSection(containerEl, "Manual apply", "Optional foreground controls. Auto-sync uses the same executor and safety gates.");
    const plan = this.owner.currentSyncPlan();
    const active = this.owner.isSyncBusy();

    new Setting(section)
      .setName("Apply safe changes")
      .setDesc("Bidirectional uploads, downloads, verification, renames, and enabled conflict-free text merges. Deletes stay blocked.")
      .addButton((button) => button.setButtonText(active ? "Busy…" : "Apply safe changes").setDisabled(!plan || active || this.busy.has("apply-safe")).onClick(() => {
        void this.run("apply-safe", async () => { const report = await this.owner.applyCurrentSyncPlan(false); new Notice(`Apply complete · ${plural(report.completed, "step")}${report.mergedFiles ? ` · ${report.mergedFiles} merged` : ""}.`); }, "Apply failed");
      }));

    const destructiveArmed = Date.now() < this.destructiveArmedUntil;
    new Setting(section)
      .setName("Apply verified deletes")
      .setDesc(destructiveArmed ? "Armed for 15 seconds. Confirm now." : "Two-step confirmation for delete steps.")
      .addButton((button) => button.setButtonText(destructiveArmed ? "Confirm deletes" : "Arm deletes").setWarning().setDisabled(!plan || active || this.busy.has("apply-destructive")).onClick(() => {
        if (!destructiveArmed) { this.destructiveArmedUntil = Date.now() + 15_000; this.display(); return; }
        this.destructiveArmedUntil = 0;
        void this.run("apply-destructive", async () => { const report = await this.owner.applyCurrentSyncPlan(true); new Notice(`Apply complete · ${plural(report.completed, "step")}${report.mergedFiles ? ` · ${report.mergedFiles} merged` : ""}.`); }, "Delete apply failed");
      }));

    const status = this.owner.executionSummary();
    const note = document.createElement("div");
    note.className = "nyra-nc-execution-note";
    note.textContent = status
      ? `${capitalize(status.status)} · ${status.completedSteps}/${status.totalSteps} steps · ${formatBytes(status.bytesProcessed)}${status.lastError ? ` · ${status.lastError}` : ""}`
      : "No execution has run in this session.";
    section.appendChild(note);
  }

  private renderConnectionSection(containerEl: HTMLElement): void {
    const section = createSection(containerEl, "Account & server", "Browser login keeps your primary password out of the plugin. Health checks use status.php and never need your app password.");
    const configuredServer = this.owner.settings.serverUrl;
    const boundServer = this.owner.settings.credentialBinding?.serverUrl ?? null;
    const serverChanged = Boolean(boundServer && configuredServer && !sameCanonicalServer(boundServer, configuredServer));

    let serverUrlDraft = configuredServer;
    const urlSetting = new Setting(section)
      .setName("Nextcloud URL")
      .setDesc("Paste the Nextcloud server or a Files/WebDAV folder link. A folder link also selects the matching sync folder. HTTPS is required except for localhost.")
      .addText((text) => {
        text.setPlaceholder("https://cloud.example.com").setValue(configuredServer).setDisabled(this.owner.isSyncBusy() || this.owner.auth.isLoginActive() || this.busy.has("login"))
          .onChange((value) => { serverUrlDraft = value; });
        this.commitOnBlur(text, (value) => {
          const trimmed = value.trim();
          let serverUrl = trimmed;
          let remoteRootPath: string | null = null;
          try {
            const parsed = parseNextcloudLocation(trimmed);
            serverUrl = parsed.serverUrl;
            remoteRootPath = parsed.remoteRootPath;
          } catch { /* Keep incomplete input editable; login reports the validation error. */ }
          serverUrlDraft = serverUrl;
          this.queueSettingsWrite((settings) => {
            settings.serverUrl = serverUrl;
            if (remoteRootPath !== null) settings.remoteRootPath = remoteRootPath;
          });
        });
      });
    urlSetting.settingEl.classList.add("nyra-nc-setting--wide");

    if (serverChanged) {
      const warning = document.createElement("div");
      warning.className = "nyra-nc-callout nyra-nc-callout--warn";
      warning.textContent = "Server URL changed. Reconnect before sync; existing credentials are never sent to a different origin.";
      section.appendChild(warning);
    }

    const loginActive = this.owner.auth.isLoginActive() || this.busy.has("login");
    const syncBusy = this.owner.isSyncBusy();
    if (!loginActive && !syncBusy) this.ensureBrowserLoginPrepared(configuredServer);
    const preparedLoginUrl = this.owner.auth.getPreparedBrowserLoginUrl(serverUrlDraft);
    const loginSetting = new Setting(section)
      .setName("Browser login")
      .setDesc(syncBusy
        ? "Login is available as soon as the current sync has finished verification."
        : "The sign-in page is prepared securely. Select once to open it in your browser, approve access, then return here. SSO and 2FA are supported.");
    if (loginActive) {
      loginSetting.addButton((button) => button
        .setButtonText(this.loginCancelRequested ? "Cancelling…" : "Cancel login")
        .setWarning()
        .setDisabled(this.loginCancelRequested)
        .onClick(() => {
          this.loginCancelRequested = true;
          this.resolveLoginStartCancel?.();
          this.owner.auth.cancelLogin();
          new Notice("Cancelling browser login…");
          this.display();
        }));
    } else if (syncBusy) {
      loginSetting.addButton((button) => button
        .setButtonText("Available after sync")
        .setDisabled(true));
    } else if (preparedLoginUrl) {
      const link = document.createElement("a");
      link.className = "button mod-cta nyra-nc-browser-login-link";
      link.href = preparedLoginUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      link.textContent = "Log in with browser";
      link.addEventListener("click", (event) => {
        if (!this.startPreparedBrowserLogin(serverUrlDraft)) event.preventDefault();
        else link.textContent = "Waiting for approval…";
      });
      loginSetting.controlEl.appendChild(link);
    } else {
      const failed = this.browserPreparationFailedServer !== null
        && sameCanonicalServer(this.browserPreparationFailedServer, configuredServer);
      loginSetting.addButton((button) => button
        .setButtonText(failed ? "Retry sign-in setup" : configuredServer.trim() ? "Preparing sign-in…" : "Enter server URL")
        .setCta()
        .setDisabled(!failed || this.owner.isSyncBusy())
        .onClick(() => this.ensureBrowserLoginPrepared(configuredServer, true)));
      if (failed && this.browserPreparationError) {
        const hint = document.createElement("p");
        hint.className = "setting-item-description nyra-nc-login-preparation-error";
        hint.textContent = `Could not prepare browser sign-in: ${this.browserPreparationError}`;
        section.appendChild(hint);
      }
    }

    new Setting(section)
      .setName("Server status")
      .setDesc("Manual check. Background checks are quiet and back off automatically while the server is unavailable.")
      .addButton((button) => button.setButtonText(this.busy.has("health") ? "Checking…" : "Check now").setDisabled(!this.owner.settings.serverUrl || this.busy.has("health")).onClick(() => {
        void this.run("health", async () => { const h = await this.owner.checkServerHealth(); new Notice(`${healthHeadline(h)} · ${h.message}`); }, "Status check failed");
      }))
      .addButton((button) => button.setButtonText("Verify account").setDisabled(!this.owner.canVerifyStoredCredentials() || this.busy.has("verify") || this.owner.isSyncBusy()).onClick(() => {
        void this.run("verify", async () => { await this.owner.auth.verifyStoredCredentials(); new Notice("Account verified."); }, "Verification failed");
      }));

    this.addSelectSetting(section, "Health check interval", "Normal online cadence. Offline and maintenance states use a longer automatic backoff.",
      [["30", "30 seconds"], ["60", "1 minute"], ["120", "2 minutes"], ["300", "5 minutes"]],
      String(this.owner.settings.serverHealthCheckSeconds), this.owner.isSyncBusy(),
      (value) => this.updateAndDisplay((settings) => { settings.serverHealthCheckSeconds = Number.parseInt(value, 10); }));

    new Setting(section)
      .setName("Disconnect")
      .setDesc("Removes the credential binding and app password from this vault.")
      .addButton((button) => button.setButtonText("Disconnect").setWarning().setDisabled((!this.owner.hasStoredCredentials() && this.owner.settings.connectionState === "disconnected") || this.owner.isSyncBusy()).onClick(() => {
        void this.run("disconnect", async () => { await this.owner.auth.disconnect(); new Notice("Nextcloud disconnected."); }, "Disconnect failed");
      }));
  }

  private renderRemoteSection(containerEl: HTMLElement): void {
    const section = createSection(containerEl, "Nextcloud folder", "The folder that holds this vault on your server. Use the same folder on every device.");
    const remoteFolderSetting = new Setting(section)
      .setName("Remote folder")
      .setDesc("Relative to your Nextcloud Files root.")
      .addText((text) => {
        text.setPlaceholder("Obsidian").setValue(this.owner.settings.remoteRootPath).setDisabled(this.owner.isSyncBusy());
        this.commitOnBlur(text, (value) => this.queueSettingsWrite((settings) => { settings.remoteRootPath = value; }));
      });
    remoteFolderSetting.settingEl.classList.add("nyra-nc-setting--wide");

    new Setting(section)
      .setName("Directory concurrency")
      .setDesc("Concurrent WebDAV folder listings (1–16).")
      .addText((text) => {
        text.setPlaceholder("6").setValue(String(this.owner.settings.remoteDirectoryConcurrency)).setDisabled(this.owner.isSyncBusy());
        text.inputEl.classList.add("nyra-nc-input--narrow");
        this.commitOnBlur(text, (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed)) this.queueSettingsWrite((settings) => { settings.remoteDirectoryConcurrency = parsed; });
          else { new Notice("Enter a whole number from 1 to 16."); this.display(); }
        });
      });

    const account = this.owner.settings.account;
    const target = document.createElement("div");
    target.className = "nyra-nc-target";
    const targetLabel = document.createElement("span");
    targetLabel.className = "nyra-nc-target__label";
    targetLabel.textContent = "WebDAV target";
    const targetValue = document.createElement("code");
    targetValue.textContent = account ? `${account.webdavRootUrl}${encodeRemoteForDisplay(this.owner.settings.remoteRootPath)}` : "Connect an account first";
    target.append(targetLabel, targetValue);
    section.appendChild(target);

    new Setting(section)
      .setName("Scan remote")
      .setDesc("Read-only inventory scan.")
      .addButton((button) => button.setButtonText(this.busy.has("remote-scan") ? "Scanning…" : "Scan remote").setDisabled(this.owner.settings.connectionState !== "verified" || this.owner.durableStateSummary() === null || this.owner.isSyncBusy() || this.busy.has("remote-scan")).onClick(() => {
        void this.run("remote-scan", async () => { const outcome = await this.owner.scanRemoteVault(); new Notice(`Remote inventory · ${outcome.scan.entries.length} files.`); }, "Remote scan failed");
      }));
  }

  private renderTransferSection(containerEl: HTMLElement): void {
    const details = document.createElement("details");
    details.className = "nyra-nc-advanced";
    details.dataset.nyraStateKey = "advanced-transfer-settings";
    const summary = document.createElement("summary");
    summary.dataset.nyraFocusKey = "advanced-transfer-settings-summary";
    summary.textContent = "Advanced transfer settings";
    details.appendChild(summary);
    const body = document.createElement("div");
    body.className = "nyra-nc-advanced__body";
    details.appendChild(body);
    containerEl.appendChild(details);

    this.renderMiBSetting(body, "Chunked upload threshold", "5–512 MiB.", this.owner.settings.transferChunkUploadThresholdMiB, "16", (settings, value) => { settings.transferChunkUploadThresholdMiB = value; });
    this.renderMiBSetting(body, "Upload chunk size", "5–512 MiB; automatically enlarged when needed.", this.owner.settings.transferUploadChunkMiB, "16", (settings, value) => { settings.transferUploadChunkMiB = value; });
    this.renderMiBSetting(body, "Download range size", "1–64 MiB.", this.owner.settings.transferDownloadRangeMiB, "8", (settings, value) => { settings.transferDownloadRangeMiB = value; });
    this.renderMiBSetting(body, "Whole-download limit", "Larger files require HTTP byte ranges.", this.owner.settings.transferMaxWholeDownloadMiB, "16", (settings, value) => { settings.transferMaxWholeDownloadMiB = value; });
    this.renderMiBSetting(body, "Automatic merge limit", "1–4 MiB per BASE/LOCAL/REMOTE version. Larger conflicts require review.", this.owner.settings.autoMergeMaxMiB, "2", (settings, value) => { settings.autoMergeMaxMiB = value; });
  }

  private addSelectSetting(
    section: HTMLElement,
    name: string,
    description: string,
    options: readonly (readonly [string, string])[],
    value: string,
    disabled: boolean,
    onSelect: (value: string) => Promise<void>
  ): void {
    const setting = new Setting(section).setName(name).setDesc(description);
    const menu = document.createElement("details");
    menu.className = "nyra-nc-select";
    if (disabled) menu.classList.add("nyra-nc-select--disabled");
    const trigger = document.createElement("summary");
    trigger.textContent = options.find(([option]) => option === value)?.[1] ?? value;
    trigger.dataset.nyraFocusKey = `select-${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
    trigger.setAttribute("aria-label", `${name}: ${trigger.textContent}`);
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    if (disabled) {
      trigger.tabIndex = -1;
      trigger.setAttribute("aria-disabled", "true");
      trigger.addEventListener("click", (event) => event.preventDefault());
    }
    const list = document.createElement("div");
    list.className = "nyra-nc-select__list";
    list.setAttribute("aria-label", name);
    list.setAttribute("role", "menu");
    list.id = `nyra-nc-select-menu-${++choiceMenuSequence}`;
    trigger.setAttribute("aria-controls", list.id);
    const buttons: HTMLButtonElement[] = [];
    for (const [option, label] of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nyra-nc-select__option";
      button.textContent = label;
      button.setAttribute("aria-current", String(option === value));
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", String(option === value));
      button.disabled = disabled;
      button.addEventListener("click", () => {
        menu.open = false;
        trigger.focus({ preventScroll: true });
        if (option !== value) void onSelect(option);
      });
      list.appendChild(button);
      buttons.push(button);
    }
    menu.addEventListener("toggle", () => {
      trigger.setAttribute("aria-expanded", String(menu.open));
      if (!menu.open) return;
      if (disabled) { menu.open = false; return; }
      setting.settingEl.closest(".nyra-nc-settings")?.querySelectorAll<HTMLDetailsElement>(".nyra-nc-select[open]").forEach((other) => {
        if (other !== menu) other.open = false;
      });
      requestAnimationFrame(() => {
        if (menu.open) positionChoiceMenu(menu, trigger, list);
      });
    });
    menu.addEventListener("focusout", (event) => {
      if (event.relatedTarget instanceof Node && menu.contains(event.relatedTarget)) return;
      menu.open = false;
    });
    menu.addEventListener("keydown", (event) => {
      if (disabled) { event.preventDefault(); return; }
      if (event.key === "Escape" && menu.open) {
        event.preventDefault();
        menu.open = false;
        trigger.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      menu.open = true;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const selected = Math.max(0, options.findIndex(([option]) => option === value));
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : current < 0 ? selected : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
    menu.append(trigger, list);
    setting.controlEl.appendChild(menu);
  }

  private renderMiBSetting(section: HTMLElement, name: string, description: string, value: number, placeholder: string, apply: (settings: import("../state/settings").PluginSettings, value: number) => void): void {
    new Setting(section).setName(name).setDesc(description).addText((text) => {
      text.setPlaceholder(placeholder).setValue(String(value)).setDisabled(this.owner.isSyncBusy());
      text.inputEl.classList.add("nyra-nc-input--narrow");
      this.commitOnBlur(text, (raw) => {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isSafeInteger(parsed)) this.queueSettingsWrite((settings) => apply(settings, parsed));
        else { new Notice("Enter a whole number for this transfer setting."); this.display(); }
      });
    });
  }

  private renderIntegritySection(containerEl: HTMLElement): void {
    const section = createSection(containerEl, "Integrity", "Manual, read-only diagnostics. Reports omit note contents, credentials, private paths and hashes.");
    new Setting(section).setName("Durable state and storage").setDesc("Verify immutable recovery generations, the retained WAL chain, and current baseline objects; inventory snapshots and object names. Unreferenced objects remain untouched until collection can be proven race-safe.").addButton((button) => button.setButtonText(this.busy.has("integrity") ? "Verifying…" : "Verify state").setDisabled(this.owner.durableStateSummary() === null || this.busy.has("integrity") || this.owner.isSyncBusy()).onClick(() => {
      void this.run("integrity", async () => {
        const report = await this.owner.verifyDurableState();
        if (!report.ok) throw new Error(report.errors.join("; "));
        const bytes = report.storage.walBytes === null ? "WAL size unavailable" : `${formatBytes(report.storage.walBytes)} WAL`;
        new Notice(`State verified · ${plural(report.storage.verifiedRecoveryGenerationCount, "recovery generation")} · ${bytes} · ${report.storage.referencedObjectCount} retained BASE references · collection disabled.`);
      }, "Integrity check failed");
    }));
    new Setting(section).setName("Convergence audit").setDesc("Deep read-only check that clean LOCAL / BASE / REMOTE records and their immutable BASE objects still agree.").addButton((button) => button.setButtonText(this.busy.has("convergence-audit") ? "Checking…" : "Audit consistency").setDisabled(this.owner.durableStateSummary() === null || this.busy.has("convergence-audit") || this.owner.isSyncBusy()).onClick(() => {
      void this.run("convergence-audit", async () => { const report = await this.owner.auditConvergence(true); if (report.errors > 0) throw new Error(`${plural(report.errors, "semantic consistency error")} found.`); new Notice(`Consistency verified · ${report.verifiedCleanRecords}/${plural(report.cleanRecords, "clean record")}.`); }, "Consistency audit failed");
    }));
    new Setting(section).setName("Redacted support report").setDesc("Copy an allowlisted diagnostic summary. Review it before sharing; server origin and sync counts are included.").addButton((button) => button.setButtonText(this.busy.has("support-report") ? "Preparing…" : "Copy report").setDisabled(this.busy.has("support-report") || this.owner.isSyncBusy()).onClick(() => {
      void this.run("support-report", async () => {
        const report = await this.owner.createRedactedSupportReport();
        let copied = false;
        try {
          if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(report); copied = true; }
        } catch { /* Keep an accessible manual-copy fallback below. */ }
        if (copied) {
          this.supportReportFallback = null;
          new Notice("Redacted report copied. Review it before sharing.");
          return;
        }
        this.supportReportFallback = report;
        new Notice("Report prepared below. Select and copy it manually.");
      }, "Support report failed");
    }));
    if (this.supportReportFallback !== null) {
      const output = document.createElement("textarea");
      output.className = "nyra-nc-support-report";
      output.setAttribute("aria-label", "Redacted support report; select and copy manually");
      output.readOnly = true;
      output.value = this.supportReportFallback;
      output.rows = 14;
      section.appendChild(output);
      requestAnimationFrame(() => { output.focus(); output.select(); });
    }
    new Setting(section).setName("Local inventory").setDesc("Full verified SHA-256 scan.").addButton((button) => button.setButtonText(this.busy.has("local-scan") ? "Scanning…" : "Scan local").setDisabled(this.owner.durableStateSummary() === null || this.busy.has("local-scan") || this.owner.isSyncBusy()).onClick(() => {
      void this.run("local-scan", async () => { const outcome = await this.owner.scanLocalVault(); const count = outcome.scan.kind === "full" ? outcome.scan.entries.length : outcome.scan.requestedPaths.length; new Notice(`Local inventory · ${plural(count, "path")}.`); }, "Local scan failed");
    }));

    const audit = this.owner.convergenceAuditSummary();
    if (audit?.issues.length) {
      const details = document.createElement("details");
      details.className = "nyra-nc-advanced";
      details.dataset.nyraStateKey = "consistency-details";
      const summary = document.createElement("summary");
      summary.dataset.nyraFocusKey = "consistency-details-summary";
      summary.textContent = `Consistency details · ${plural(audit.errors, "error")}, ${plural(audit.warnings, "warning")}`;
      details.appendChild(summary);
      const body = document.createElement("div");
      body.className = "nyra-nc-advanced__body";
      const list = document.createElement("ul");
      for (const issue of audit.issues.slice(0, 8)) {
        const li = document.createElement("li");
        li.textContent = `${issue.path}: ${issue.message}`;
        list.appendChild(li);
      }
      body.appendChild(list);
      details.appendChild(body);
      section.appendChild(details);
    }
  }

  private renderSafetySection(containerEl: HTMLElement): void {
    const section = createSection(containerEl, "How Nyra protects your data", "These safeguards are always on.");
    const list = section.createEl("ul", { cls: "nyra-nc-guarantees" });
    for (const [icon, title, text] of [
      ["check-circle", "Verified before writing", "Every upload and download is checked against its SHA-256 and the server's current version."],
      ["git-compare", "Conflicts keep both versions", "Overlapping edits are never merged blindly and never overwritten without a preserved copy."],
      ["trash", "Deletions are recoverable", "Large deletions wait for approval, and deleted files can be restored from Nyra or the Nextcloud trash bin."],
      ["history", "History stays available", "Earlier versions of a note can be compared and restored from Nextcloud."]
    ] as const) {
      const item = list.createEl("li");
      item.createDiv({ cls: "nyra-nc-guarantees__icon" }).appendChild(createIcon(icon, 16));
      const body = item.createDiv();
      body.createEl("strong", { text: title });
      body.createSpan({ text });
    }
  }

  private connectionDetail(): string {
    const account = this.owner.settings.account;
    if (account) return `${account.displayName} · Nextcloud ${account.serverVersionString}`;
    if (this.owner.settings.pendingLoginName) return `Pending · ${this.owner.settings.pendingLoginName}`;
    return this.owner.settings.lastError ?? "Not connected";
  }

  private async run(key: string, action: () => Promise<void>, errorPrefix: string): Promise<void> {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    this.display();
    try {
      await Promise.all([...this.pendingSettingsWrites]);
      await action();
    }
    catch (error) { new Notice(`${errorPrefix}: ${errorMessage(error)}`, 12_000); }
    finally {
      this.busy.delete(key);
      this.display();
    }
  }

  private ensureBrowserLoginPrepared(serverInput: string, retry = false): void {
    let serverUrl: string;
    try { serverUrl = normalizeServerUrl(serverInput); }
    catch { return; }

    if (this.owner.auth.getPreparedBrowserLoginUrl(serverUrl)) {
      this.browserPreparationPendingServer = null;
      this.browserPreparationFailedServer = null;
      this.browserPreparationError = null;
      return;
    }
    if (this.browserPreparationPendingServer && sameCanonicalServer(this.browserPreparationPendingServer, serverUrl)) return;
    if (!retry && this.browserPreparationFailedServer && sameCanonicalServer(this.browserPreparationFailedServer, serverUrl)) return;

    this.browserPreparationPendingServer = serverUrl;
    this.browserPreparationFailedServer = null;
    this.browserPreparationError = null;
    void this.owner.auth.prepareBrowserLogin(serverUrl).then(() => {
      if (!this.browserPreparationPendingServer || !sameCanonicalServer(this.browserPreparationPendingServer, serverUrl)) return;
      this.browserPreparationPendingServer = null;
      this.browserPreparationFailedServer = null;
      this.browserPreparationError = null;
      this.display();
    }).catch((error: unknown) => {
      if (!this.browserPreparationPendingServer || !sameCanonicalServer(this.browserPreparationPendingServer, serverUrl)) return;
      this.browserPreparationPendingServer = null;
      this.browserPreparationFailedServer = serverUrl;
      this.browserPreparationError = errorMessage(error);
      this.display();
    });
  }

  private startPreparedBrowserLogin(serverUrl: string): boolean {
    if (this.busy.has("login") || this.owner.auth.isLoginActive() || this.owner.isSyncBusy()) return false;
    if (!this.owner.auth.getPreparedBrowserLoginUrl(serverUrl)) {
      this.ensureBrowserLoginPrepared(serverUrl, true);
      new Notice("Refreshing the secure sign-in link. Select it when preparation finishes.");
      return false;
    }

    this.busy.add("login");
    this.loginCancelRequested = false;
    let cancelPendingStart!: () => void;
    const pendingStartCancelled = new Promise<void>((resolve) => { cancelPendingStart = resolve; });
    this.resolveLoginStartCancel = cancelPendingStart;
    window.setTimeout(() => this.display(), 0);
    void (async () => {
      try {
        const settingsReady = await Promise.race([
          Promise.all([...this.pendingSettingsWrites]).then(() => true),
          pendingStartCancelled.then(() => false)
        ]);
        this.resolveLoginStartCancel = null;
        if (!settingsReady || this.loginCancelRequested) return;
        await this.owner.auth.loginWithPreparedBrowser(serverUrl);
        new Notice("Nextcloud connected.");
      } catch (error) {
        new Notice(`Login failed: ${errorMessage(error)}`, 12_000);
      } finally {
        this.resolveLoginStartCancel = null;
        this.busy.delete("login");
        this.loginCancelRequested = false;
        this.display();
      }
    })();
    return true;
  }

  private commitOnBlur(component: TextComponent, commit: (value: string) => void): void {
    component.inputEl.addEventListener("blur", () => commit(component.getValue()));
    component.inputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      component.inputEl.blur();
    });
  }

  private queueSettingsWrite(mutator: (settings: import("../state/settings").PluginSettings) => void): void {
    let pending!: Promise<void>;
    pending = this.owner.updateSettings(mutator).finally(() => {
      this.pendingSettingsWrites.delete(pending);
      this.display();
    });
    this.pendingSettingsWrites.add(pending);
    void pending.catch((error: unknown) => new Notice(`Setting could not be saved: ${errorMessage(error)}`, 12_000));
  }

  private async updateAndDisplay(mutator: (settings: import("../state/settings").PluginSettings) => void): Promise<void> {
    try { await this.owner.updateSettings(mutator); }
    catch (error) { new Notice(`Setting could not be saved: ${errorMessage(error)}`, 12_000); }
    this.display();
  }
}

function positionChoiceMenu(menu: HTMLDetailsElement, trigger: HTMLElement, list: HTMLElement): void {
  const triggerRect = trigger.getBoundingClientRect();
  let clipTop = 0;
  let clipBottom = window.innerHeight;
  for (let ancestor = menu.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
    const overflowY = getComputedStyle(ancestor).overflowY;
    if (overflowY !== "visible" && overflowY !== "unset") {
      const bounds = ancestor.getBoundingClientRect();
      clipTop = Math.max(clipTop, bounds.top);
      clipBottom = Math.min(clipBottom, bounds.bottom);
    }
  }

  const availableBelow = Math.max(0, clipBottom - triggerRect.bottom - 12);
  const availableAbove = Math.max(0, triggerRect.top - clipTop - 12);
  const wanted = Math.min(MENU_MAX_HEIGHT, list.scrollHeight);
  const opensAbove = availableBelow < wanted && availableAbove > availableBelow;
  menu.dataset.nyraPlacement = opensAbove ? "above" : "below";
  list.style.maxHeight = `${Math.floor(Math.max(96, Math.min(MENU_MAX_HEIGHT, opensAbove ? availableAbove : availableBelow)))}px`;
}

const MENU_MAX_HEIGHT = 240;

function setTextIfChanged(element: HTMLElement | null, text: string): void {
  if (element && element.textContent !== text) element.textContent = text;
}

/** Rows whose only control is a switch keep it on the right edge even in narrow layouts (no :has() needed). */
function markToggleRows(panel: HTMLElement): void {
  for (const row of Array.from(panel.querySelectorAll<HTMLElement>(".setting-item"))) {
    const control = row.querySelector(":scope > .setting-item-control");
    if (control && control.children.length === 1 && control.firstElementChild?.classList.contains("checkbox-container")) row.classList.add("nyra-nc-setting--toggle");
  }
}
