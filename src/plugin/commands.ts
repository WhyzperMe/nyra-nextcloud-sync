import { Notice } from "obsidian";
import { errorMessage } from "../core/errors";
import type NyraNextcloudSyncPlugin from "../main";
import { RecoveryModal } from "../ui/recovery-modal";
import { VersionHistoryModal } from "../ui/version-history-modal";
import { needs, plural } from "../core/plural";

/** Registers every command-palette entry. Each one delegates to a public plugin operation. */
export function registerCommands(plugin: NyraNextcloudSyncPlugin): void {
  plugin.addCommand({ id: "sync-now", name: "Sync now", callback: () => {
    void plugin.runAutoSyncNow().then((result) => {
      if (!result) new Notice("Sync deferred until Nextcloud is available.");
      else if (result.reviewItems > 0 || result.blockedSteps > 0) new Notice(`${plural(result.completedSteps, "safe step")} completed · ${plural(Math.max(result.reviewItems, result.blockedSteps), "item")} ${needs(Math.max(result.reviewItems, result.blockedSteps))} review.`);
      else new Notice(result.executed ? `Sync complete: ${plural(result.completedSteps, "step")}.` : "Already up to date.");
    }).catch((error: unknown) => new Notice(`Sync failed: ${errorMessage(error)}`, 12_000));
  }});
  plugin.addCommand({ id: "toggle-pause-auto-sync", name: "Pause or resume auto-sync", callback: () => {
    const paused = !plugin.settings.syncPaused;
    void plugin.updateSettings((settings) => { settings.syncPaused = paused; }).then(() => new Notice(paused ? "Auto-sync paused." : "Auto-sync resumed."))
      .catch((error: unknown) => new Notice(`Setting could not be saved: ${errorMessage(error)}`, 10_000));
  }});
  plugin.addCommand({ id: "restore-deleted-files", name: "Restore deleted files…", callback: () => { new RecoveryModal(plugin.app, plugin).open(); } });
  plugin.addCommand({ id: "show-note-versions", name: "Show previous versions of the current note", checkCallback: (checking) => {
    const file = plugin.app.workspace.getActiveFile();
    if (!file) return false;
    if (!checking) new VersionHistoryModal(plugin.app, plugin, file.path).open();
    return true;
  }});
  plugin.addCommand({ id: "approve-pending-deletions", name: "Approve pending deletions", callback: () => {
    if (!plugin.approvePendingDeletions()) { new Notice("No deletions are waiting for approval."); return; }
    void plugin.runAutoSyncNow().then(() => new Notice("Approved deletions were synced.")).catch((error: unknown) => new Notice(`Sync failed: ${errorMessage(error)}`, 12_000));
  }});
  plugin.addCommand({ id: "publish-vault-to-nextcloud", name: "Publish this vault to Nextcloud", callback: () => {
    void plugin.publishVaultToNextcloud().then((report) => new Notice(`Vault published: ${plural(report.completed, "step")}.`)).catch((error: unknown) => new Notice(`Publish blocked: ${errorMessage(error)}`, 12_000));
  }});
  plugin.addCommand({ id: "download-vault-from-nextcloud", name: "Download vault from Nextcloud to this device", callback: () => {
    void plugin.downloadVaultToThisDevice().then((report) => new Notice(`Vault downloaded: ${plural(report.completed, "step")}.`)).catch((error: unknown) => new Notice(`Download blocked: ${errorMessage(error)}`, 12_000));
  }});
  plugin.addCommand({ id: "scan-local-vault", name: "Scan local vault inventory", callback: () => {
    void plugin.scanLocalVault().then((outcome) => new Notice(`Local inventory complete: ${plural(outcome.scan.kind === "full" ? outcome.scan.entries.length : outcome.scan.requestedPaths.length, "path")}.`)).catch((error: unknown) => new Notice(`Local inventory failed: ${errorMessage(error)}`, 12_000));
  }});
  plugin.addCommand({ id: "scan-nextcloud-inventory", name: "Scan Nextcloud remote inventory", callback: () => {
    void plugin.scanRemoteVault().then((outcome) => new Notice(`Remote inventory complete: ${plural(outcome.scan.entries.length, "file")}.`)).catch((error: unknown) => new Notice(`Remote inventory failed: ${errorMessage(error)}`, 12_000));
  }});
  plugin.addCommand({ id: "build-sync-plan", name: "Build read-only sync plan", callback: () => {
    void plugin.buildSyncPlan().then((plan) => new Notice(`Plan: ${plan.summary.ready} ready, ${plan.summary.needsVerification} verify, ${plan.summary.mergeCandidates + plan.summary.blocked} review.`)).catch((error: unknown) => new Notice(`Planning failed: ${errorMessage(error)}`, 12_000));
  }});
  plugin.addCommand({ id: "apply-sync-plan-safe", name: "Apply current sync plan (safe, no deletes)", callback: () => {
    void plugin.applyCurrentSyncPlan(false).then((report) => new Notice(`Sync complete: ${report.completed} completed${report.mergedFiles > 0 ? `, ${report.mergedFiles} merged` : ""}, ${report.blocked} blocked.`)).catch((error: unknown) => new Notice(`Sync failed: ${errorMessage(error)}`, 12_000));
  }});
  plugin.addCommand({ id: "check-nextcloud-health", name: "Check Nextcloud server status", callback: () => {
    void plugin.checkServerHealth().then((health) => new Notice(`Nextcloud: ${health.state}. ${health.message}`)).catch((error: unknown) => new Notice(`Status check failed: ${errorMessage(error)}`, 10_000));
  }});
  plugin.addCommand({ id: "verify-nextcloud-connection", name: "Verify Nextcloud connection", callback: () => {
    void plugin.auth.verifyStoredCredentials().then(() => new Notice("Nextcloud connection verified.")).catch((error: unknown) => new Notice(`Verification failed: ${errorMessage(error)}`, 10_000));
  }});
  plugin.addCommand({ id: "audit-sync-convergence", name: "Audit sync convergence state", callback: () => {
    void plugin.auditConvergence(true).then((report) => report.errors === 0
      ? new Notice(`Consistency verified: ${report.verifiedCleanRecords}/${plural(report.cleanRecords, "clean record")}.`)
      : new Notice(`Consistency audit found ${plural(report.errors, "error")}. Open plugin settings for details.`, 12_000)
    ).catch((error: unknown) => new Notice(`Consistency audit failed: ${errorMessage(error)}`, 12_000));
  }});
  plugin.addCommand({ id: "verify-durable-state", name: "Verify durable state integrity", callback: () => {
    void plugin.verifyDurableState().then((report) => report.ok ? new Notice(`Durable state verified at generation ${report.generation}.`) : new Notice(`State verification failed: ${report.errors.join("; ")}`, 12_000)).catch((error: unknown) => new Notice(`State verification failed: ${errorMessage(error)}`, 12_000));
  }});
  plugin.addCommand({ id: "disconnect-nextcloud-account", name: "Disconnect Nextcloud account", callback: () => { void plugin.auth.disconnect().then(() => new Notice("Nextcloud account disconnected.")); }});
}
