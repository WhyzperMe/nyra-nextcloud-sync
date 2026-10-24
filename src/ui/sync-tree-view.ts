import { Notice } from "obsidian";
import type NyraNextcloudSyncPlugin from "../main";
import type { SyncTreeEntry, SyncTreeListing } from "../folders/sync-tree";
import { normalizeExcludes, selectionState, type SelectionState } from "../local/selection";
import { errorMessage } from "../core/errors";
import { formatBytes, plural } from "./format";
import { createIcon } from "./icons";

/** Rows rendered per folder before "Show more"; keeps huge folders responsive. */
const PAGE_SIZE = 200;
const LISTING_TTL_MS = 30_000;

type TreeOwner = Pick<NyraNextcloudSyncPlugin, "listSyncTree" | "syncSelectionExcludes" | "setSyncSelection" | "resetSyncSelection">;

interface Folder {
  listing: SyncTreeListing | null;
  loadedAt: number;
  loading: boolean;
  error: string | null;
  shown: number;
}

/**
 * Visual file picker: the vault as a lazily loaded tree (this device and Nextcloud together) with a
 * checkbox per file and folder. It keeps its state across settings redraws, so expanding a folder or
 * toggling an item never resets the view.
 */
export class SyncTreeView {
  private readonly folders = new Map<string, Folder>();
  private readonly expanded = new Set<string>();
  private excludes: string[] = [];
  private root: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private summary: HTMLElement | null = null;
  private resetButton: HTMLButtonElement | null = null;
  private focusedPath: string | null = null;
  private revision = 0;

  constructor(private readonly owner: TreeOwner) {}

  /** Drops cached listings so the next render asks the device and Nextcloud again. */
  invalidate(): void {
    this.folders.clear();
    this.revision += 1;
  }

  render(container: HTMLElement): void {
    this.excludes = [...this.owner.syncSelectionExcludes()];
    const root = document.createElement("div");
    root.className = "nyra-nc-tree";
    this.root = root;

    const toolbar = document.createElement("div");
    toolbar.className = "nyra-nc-tree__toolbar";
    const summary = document.createElement("span");
    summary.className = "nyra-nc-tree__summary";
    summary.setAttribute("aria-live", "polite");
    this.summary = summary;
    const actions = document.createElement("div");
    actions.className = "nyra-nc-tree__actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Include everything";
    reset.addEventListener("click", () => { void this.resetSelection(); });
    this.resetButton = reset;
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "nyra-nc-btn-icon";
    refresh.setAttribute("aria-label", "Refresh file list");
    refresh.title = "Refresh file list";
    refresh.appendChild(createIcon("refresh", 14));
    refresh.addEventListener("click", () => { this.invalidate(); this.expanded.forEach((path) => void this.ensureLoaded(path)); void this.ensureLoaded(""); this.renderRows(); });
    actions.append(reset, refresh);
    toolbar.append(summary, actions);

    const notice = document.createElement("div");
    notice.className = "nyra-nc-tree__notice";
    notice.hidden = true;
    notice.dataset.role = "server-notice";

    const list = document.createElement("div");
    list.className = "nyra-nc-tree__list";
    list.setAttribute("role", "tree");
    list.setAttribute("aria-label", "Files and folders to synchronize");
    list.setAttribute("aria-multiselectable", "true");
    list.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.list = list;

    root.append(toolbar, notice, list);
    container.appendChild(root);
    this.updateSummary();
    this.renderRows();
    void this.ensureLoaded("");
  }

  // ---- data -------------------------------------------------------------------------------------------------

  private async ensureLoaded(path: string): Promise<void> {
    const state = this.folders.get(path) ?? { listing: null, loadedAt: 0, loading: false, error: null, shown: PAGE_SIZE };
    this.folders.set(path, state);
    if (state.loading || (state.listing && Date.now() - state.loadedAt < LISTING_TTL_MS)) return;
    const revision = this.revision;
    state.loading = true;
    state.error = null;
    this.renderRows();
    try {
      const listing = await this.owner.listSyncTree(path);
      if (revision !== this.revision) return;
      state.listing = listing;
      state.loadedAt = Date.now();
    } catch (error) {
      if (revision !== this.revision) return;
      state.error = errorMessage(error);
    } finally {
      if (revision === this.revision) { state.loading = false; this.renderRows(); }
    }
  }

  // ---- selection --------------------------------------------------------------------------------------------

  private async toggle(entry: SyncTreeEntry): Promise<void> {
    const include = selectionState(entry.path, this.excludes) !== "included";
    const before = this.excludes;
    // Unchecking is a pure list change, so it is shown at once; re-checking below an excluded folder needs a listing first.
    if (!include) { this.excludes = normalizeExcludes([...this.excludes, entry.path]); this.refreshStates(); }
    try {
      this.excludes = [...await this.owner.setSyncSelection(entry.path, include)];
    } catch (error) {
      this.excludes = before;
      new Notice(`Could not change the selection: ${errorMessage(error)}`, 10_000);
    }
    this.refreshStates();
    this.updateSummary();
  }

  private async resetSelection(): Promise<void> {
    const before = this.excludes;
    this.excludes = [];
    this.refreshStates();
    this.updateSummary();
    try { await this.owner.resetSyncSelection(); }
    catch (error) { this.excludes = before; this.refreshStates(); this.updateSummary(); new Notice(`Could not change the selection: ${errorMessage(error)}`, 10_000); }
  }

  private updateSummary(): void {
    if (this.summary) this.summary.textContent = this.excludes.length === 0 ? "Everything is synced" : `${plural(this.excludes.length, "item")} excluded`;
    if (this.resetButton) this.resetButton.hidden = this.excludes.length === 0;
  }

  // ---- rendering --------------------------------------------------------------------------------------------

  private renderRows(): void {
    const list = this.list;
    if (!list?.isConnected) return;
    const restore = this.focusedPath;
    const fragment = document.createDocumentFragment();
    this.appendFolder(fragment, "", 0);
    list.replaceChildren(fragment);
    const rootState = this.folders.get("");
    const notice = this.root?.querySelector<HTMLElement>('[data-role="server-notice"]');
    if (notice) {
      const offline = rootState?.listing && !rootState.listing.serverReachable;
      notice.hidden = !offline;
      if (offline) notice.textContent = "Nextcloud could not be reached, so only the items on this device are shown.";
    }
    if (restore) this.list?.querySelector<HTMLElement>(`[data-path="${CSS.escape(restore)}"]`)?.setAttribute("tabindex", "0");
    this.ensureTabStop();
  }

  private appendFolder(into: DocumentFragment, folder: string, depth: number): void {
    const state = this.folders.get(folder);
    if (!state || (!state.listing && state.loading)) { into.appendChild(this.statusRow(depth, "Loading…", "loading")); return; }
    if (state.error) { into.appendChild(this.errorRow(folder, depth, state.error)); return; }
    const entries = state.listing?.entries ?? [];
    if (entries.length === 0) { into.appendChild(this.statusRow(depth, folder === "" ? "Nothing here yet." : "This folder is empty.", "empty")); return; }
    for (const entry of entries.slice(0, state.shown)) {
      into.appendChild(this.row(entry, depth));
      if (entry.isFolder && this.expanded.has(entry.path)) this.appendFolder(into, entry.path, depth + 1);
    }
    if (entries.length > state.shown) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "nyra-nc-tree__more";
      more.style.setProperty("--depth", String(depth));
      more.textContent = `Show ${Math.min(PAGE_SIZE, entries.length - state.shown)} more of ${plural(entries.length - state.shown, "item")}`;
      more.addEventListener("click", () => { state.shown += PAGE_SIZE; this.renderRows(); });
      into.appendChild(more);
    }
  }

  private row(entry: SyncTreeEntry, depth: number): HTMLElement {
    const open = entry.isFolder && this.expanded.has(entry.path);
    const row = document.createElement("div");
    row.className = "nyra-nc-tree__row";
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(depth + 1));
    row.dataset.path = entry.path;
    row.tabIndex = -1;
    row.style.setProperty("--depth", String(depth));
    if (entry.isFolder) row.setAttribute("aria-expanded", String(open));
    this.applyState(row, selectionState(entry.path, this.excludes));

    const twist = document.createElement("span");
    twist.className = "nyra-nc-tree__twist";
    if (entry.isFolder) twist.appendChild(createIcon("chevron-right", 14));
    const check = document.createElement("span");
    check.className = "nyra-nc-check";
    check.setAttribute("aria-hidden", "true");
    const icon = document.createElement("span");
    icon.className = "nyra-nc-tree__icon";
    icon.appendChild(createIcon(entry.isFolder ? "folder" : "file", 16));
    const name = document.createElement("span");
    name.className = "nyra-nc-tree__name";
    name.textContent = entry.name;
    name.title = entry.path;
    const meta = document.createElement("span");
    meta.className = "nyra-nc-tree__meta";
    const parts: string[] = [];
    if (this.hasServerListing() && entry.onServer && !entry.onDevice) parts.push("Server only");
    else if (this.hasServerListing() && entry.onDevice && !entry.onServer) parts.push("This device only");
    if (!entry.isFolder && entry.size !== null) parts.push(formatBytes(entry.size));
    meta.textContent = parts.join(" · ");
    row.append(twist, check, icon, name, meta);

    twist.addEventListener("click", (event) => { event.stopPropagation(); this.setExpanded(entry, !this.expanded.has(entry.path)); });
    check.addEventListener("click", (event) => { event.stopPropagation(); void this.toggle(entry); });
    row.addEventListener("click", () => { if (entry.isFolder) this.setExpanded(entry, !this.expanded.has(entry.path)); else void this.toggle(entry); });
    row.addEventListener("focus", () => { this.focusedPath = entry.path; });
    return row;
  }

  private hasServerListing(): boolean { return this.folders.get("")?.listing?.serverReachable === true; }

  private statusRow(depth: number, text: string, kind: string): HTMLElement {
    const row = document.createElement("div");
    row.className = `nyra-nc-tree__status nyra-nc-tree__status--${kind}`;
    row.style.setProperty("--depth", String(depth));
    row.textContent = text;
    return row;
  }

  private errorRow(folder: string, depth: number, message: string): HTMLElement {
    const row = this.statusRow(depth, `Could not load this folder: ${message} `, "error");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "nyra-nc-tree__retry";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => { this.folders.delete(folder); void this.ensureLoaded(folder); });
    row.appendChild(retry);
    return row;
  }

  private applyState(row: HTMLElement, state: SelectionState): void {
    row.setAttribute("aria-checked", state === "included" ? "true" : state === "excluded" ? "false" : "mixed");
    row.classList.toggle("is-excluded", state === "excluded");
  }

  /** Re-derives every row's checkbox from the current exclusions without rebuilding the list. */
  private refreshStates(): void {
    this.list?.querySelectorAll<HTMLElement>(".nyra-nc-tree__row").forEach((row) => this.applyState(row, selectionState(row.dataset.path ?? "", this.excludes)));
  }

  private setExpanded(entry: SyncTreeEntry, open: boolean): void {
    if (open) { this.expanded.add(entry.path); void this.ensureLoaded(entry.path); } else this.expanded.delete(entry.path);
    this.focusedPath = entry.path;
    this.renderRows();
    this.list?.querySelector<HTMLElement>(`[data-path="${CSS.escape(entry.path)}"]`)?.focus({ preventScroll: true });
  }

  // ---- keyboard ---------------------------------------------------------------------------------------------

  private ensureTabStop(): void {
    const list = this.list;
    if (!list || list.querySelector('.nyra-nc-tree__row[tabindex="0"]')) return;
    list.querySelector<HTMLElement>(".nyra-nc-tree__row")?.setAttribute("tabindex", "0");
  }

  private onKeyDown(event: KeyboardEvent): void {
    const current = (event.target as HTMLElement | null)?.closest<HTMLElement>(".nyra-nc-tree__row");
    if (!current || !this.list) return;
    const rows = [...this.list.querySelectorAll<HTMLElement>(".nyra-nc-tree__row")];
    const index = rows.indexOf(current);
    const path = current.dataset.path ?? "";
    const entry = this.findEntry(path);
    const focus = (target: HTMLElement | undefined): void => {
      if (!target) return;
      rows.forEach((row) => row.tabIndex = -1);
      target.tabIndex = 0;
      target.focus();
    };
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); focus(rows[index + 1]); break;
      case "ArrowUp": event.preventDefault(); focus(rows[index - 1]); break;
      case "Home": event.preventDefault(); focus(rows[0]); break;
      case "End": event.preventDefault(); focus(rows[rows.length - 1]); break;
      case "ArrowRight":
        if (entry?.isFolder) { event.preventDefault(); if (!this.expanded.has(path)) this.setExpanded(entry, true); else focus(rows[index + 1]); }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (entry?.isFolder && this.expanded.has(path)) this.setExpanded(entry, false);
        else focus(rows.slice(0, index).reverse().find((row) => Number(row.getAttribute("aria-level")) < Number(current.getAttribute("aria-level"))));
        break;
      case " ": case "Enter":
        if (entry && (event.key === " " || !entry.isFolder)) { event.preventDefault(); void this.toggle(entry); }
        else if (entry) { event.preventDefault(); this.setExpanded(entry, !this.expanded.has(path)); }
        break;
      default: break;
    }
  }

  private findEntry(path: string): SyncTreeEntry | undefined {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return this.folders.get(parent)?.listing?.entries.find((entry) => entry.path === path);
  }
}
