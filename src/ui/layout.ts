import type NyraNextcloudSyncPlugin from "../main";
import { relativeFuture, relativePast } from "./format";
import { createIcon, createLogo } from "./icons";
import type { SyncPresentation } from "./settings-text";

export type TabId = "overview" | "account" | "files" | "sync" | "safety" | "advanced";

export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "account", label: "Account" },
  { id: "files", label: "Files" },
  { id: "sync", label: "Sync" },
  { id: "safety", label: "Safety" },
  { id: "advanced", label: "Advanced" }
];

export type HeroVariant = "ok" | "busy" | "warn" | "error" | "offline" | "idle";

/** The visual state of the status block, derived from what the user needs to know first. */
export function heroVariant(owner: NyraNextcloudSyncPlugin, presentation: SyncPresentation): HeroVariant {
  if (owner.settings.connectionState !== "verified") return "idle";
  if (owner.stateInitializationError ?? owner.remoteWriteSafetyError) return "error";
  if (presentation.state === "Syncing") return "busy";
  if (presentation.state === "Offline") return "offline";
  if (presentation.state === "Needs attention") return "warn";
  return owner.settings.syncPaused ? "idle" : "ok";
}

export function heroTitle(owner: NyraNextcloudSyncPlugin, presentation: SyncPresentation): string {
  if (owner.settings.connectionState !== "verified") return "Not connected";
  if (owner.settings.syncPaused && presentation.state === "Synced") return "Paused";
  return presentation.state;
}

export function heroDetail(owner: NyraNextcloudSyncPlugin, presentation: SyncPresentation): string {
  if (owner.settings.connectionState !== "verified") return "Sign in to your Nextcloud to start syncing this vault.";
  if (owner.settings.syncPaused && presentation.state === "Synced") return "Auto-sync is paused. Sync now still works.";
  return presentation.detail;
}

export function renderHeader(container: HTMLElement, version: string, owner: NyraNextcloudSyncPlugin): void {
  const header = container.createEl("header", { cls: "nyra-nc-header" });
  header.appendChild(createLogo(32));
  const text = header.createDiv({ cls: "nyra-nc-header__text" });
  text.createEl("h2", { text: "Nyra Nextcloud Sync" });
  const account = owner.settings.account;
  text.createDiv({ cls: "nyra-nc-header__meta", text: account ? `${account.displayName} · ${hostOf(account.serverUrl)}` : "Vault sync for Obsidian" });
  header.createSpan({ cls: "nyra-nc-header__version", text: `v${version}` });
}

export interface HeroActions {
  onSyncNow(): void;
  onTogglePause(): void;
  onConnect(): void;
  syncing: boolean;
  disabled: boolean;
}

export interface HeroStat { label: string; value: string; tone?: "warn" }

/** Status block: what is happening, the primary actions and the numbers that matter. */
export function renderHero(container: HTMLElement, owner: NyraNextcloudSyncPlugin, presentation: SyncPresentation, actions: HeroActions, stats: HeroStat[]): void {
  const variant = heroVariant(owner, presentation);
  const hero = container.createEl("section", { cls: `nyra-nc-hero nyra-nc-hero--${variant}` });
  hero.dataset.nyraLiveStatus = "true";
  const main = hero.createDiv({ cls: "nyra-nc-hero__main" });
  main.createSpan({ cls: "nyra-nc-hero__dot" }).setAttribute("aria-hidden", "true");
  const text = main.createDiv({ cls: "nyra-nc-hero__text" });
  text.createDiv({ cls: "nyra-nc-hero__title", text: heroTitle(owner, presentation) });
  text.createDiv({ cls: "nyra-nc-hero__detail", text: heroDetail(owner, presentation) });
  const buttons = main.createDiv({ cls: "nyra-nc-hero__actions" });
  if (owner.settings.connectionState !== "verified") {
    buttons.createEl("button", { cls: "mod-cta", text: "Connect Nextcloud" }).addEventListener("click", actions.onConnect);
  } else {
    const sync = buttons.createEl("button", { cls: "mod-cta nyra-nc-btn-icon" });
    sync.appendChild(createIcon("refresh", 14));
    sync.createSpan({ text: actions.syncing ? "Syncing…" : "Sync now" });
    sync.disabled = actions.disabled || actions.syncing;
    sync.dataset.nyraFocusKey = "hero-sync-now";
    sync.addEventListener("click", actions.onSyncNow);
    const pause = buttons.createEl("button", { cls: "nyra-nc-btn-icon" });
    pause.appendChild(createIcon(owner.settings.syncPaused ? "play" : "pause", 14));
    pause.createSpan({ text: owner.settings.syncPaused ? "Resume" : "Pause" });
    pause.dataset.nyraFocusKey = "hero-pause";
    pause.addEventListener("click", actions.onTogglePause);
  }
  const progress = hero.createDiv({ cls: "nyra-nc-live-progress" });
  progress.hidden = true;
  progress.createDiv({ cls: "nyra-nc-live-progress__label" });
  const track = progress.createDiv({ cls: "nyra-nc-progress" });
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.createSpan();
  if (stats.length > 0) {
    const row = hero.createDiv({ cls: "nyra-nc-stats" });
    for (const stat of stats) {
      const item = row.createDiv({ cls: `nyra-nc-stat${stat.tone ? ` nyra-nc-stat--${stat.tone}` : ""}` });
      item.createDiv({ cls: "nyra-nc-stat__label", text: stat.label });
      item.createDiv({ cls: "nyra-nc-stat__value", text: stat.value });
    }
  }
}

const NUMBER = new Intl.NumberFormat();

export function heroStats(owner: NyraNextcloudSyncPlugin): HeroStat[] {
  if (owner.settings.connectionState !== "verified") return [];
  const auto = owner.autoSyncSummary();
  const health = owner.serverHealthSummary();
  const plan = owner.currentSyncPlan();
  const execution = owner.executionSummary();
  const conflicts = Math.max(plan?.summary.blocked ?? 0, owner.syncConflictReviews().length);
  const last = auto?.lastSuccessAt ?? execution?.lastCompletedAt ?? null;
  return [
    { label: "Last sync", value: last ? relativePast(last) : "Not yet" },
    { label: "To upload", value: NUMBER.format(plan?.items.filter((item) => item.localChanged === true).length ?? auto?.pendingLocalChanges ?? 0) },
    { label: "To download", value: NUMBER.format(plan?.items.filter((item) => item.remoteChanged === true).length ?? 0) },
    { label: "Conflicts", value: NUMBER.format(conflicts), ...(conflicts > 0 ? { tone: "warn" as const } : {}) },
    { label: "Next check", value: owner.settings.syncPaused ? "Paused" : relativeFuture(auto?.nextRemotePollAt ?? health?.nextCheckAt ?? null) }
  ];
}

export function renderTabs(container: HTMLElement, active: TabId, badges: Partial<Record<TabId, number>>, onSelect: (tab: TabId) => void): void {
  const nav = container.createEl("nav", { cls: "nyra-nc-tabs" });
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "Nyra settings sections");
  const buttons: HTMLButtonElement[] = [];
  for (const tab of TABS) {
    const button = nav.createEl("button", { cls: `nyra-nc-tab${tab.id === active ? " is-active" : ""}` });
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(tab.id === active));
    button.tabIndex = tab.id === active ? 0 : -1;
    button.dataset.nyraFocusKey = `tab-${tab.id}`;
    button.createSpan({ text: tab.label });
    const badge = badges[tab.id] ?? 0;
    if (badge > 0) button.createSpan({ cls: "nyra-nc-tab__badge", text: String(badge) });
    button.addEventListener("click", () => onSelect(tab.id));
    button.addEventListener("keydown", (event) => {
      const index = buttons.indexOf(button);
      const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      const target = TABS[(next + buttons.length) % buttons.length];
      if (target) onSelect(target.id);
    });
    buttons.push(button);
  }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
