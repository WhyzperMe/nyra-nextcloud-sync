

export const SETTINGS_FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface SettingsFocusSnapshot {
  key: string | null;
  settingName: string | null;
  settingOccurrence: number;
  controlIndex: number;
}

export interface SettingsViewSnapshot {
  scroll: Array<{ element: HTMLElement; top: number; left: number }>;
  details: Map<string, boolean>;
  focus: SettingsFocusSnapshot | null;
  windowX: number;
  windowY: number;
}

/** A titled group: heading and description above a bordered card. Returns the card that settings are appended to. */
export function createSection(container: HTMLElement, title: string, description: string): HTMLElement {
  const section = container.createEl("section", { cls: "nyra-nc-section" });
  const head = section.createDiv({ cls: "nyra-nc-section__head" });
  head.createEl("h3", { text: title });
  if (description) head.createEl("p", { text: description });
  return section.createDiv({ cls: "nyra-nc-section__body" });
}

export function captureSettingsView(container: HTMLElement): SettingsViewSnapshot {
  const scroll: SettingsViewSnapshot["scroll"] = [];
  for (let element: HTMLElement | null = container; element; element = element.parentElement) {
    scroll.push({ element, top: element.scrollTop, left: element.scrollLeft });
  }

  const details = new Map<string, boolean>();
  container.querySelectorAll<HTMLDetailsElement>("details").forEach((element, index) => {
    details.set(element.dataset.nyraStateKey ?? `details:${index}`, element.open);
  });

  let focus: SettingsFocusSnapshot | null = null;
  const active = document.activeElement;
  if (active instanceof HTMLElement && container.contains(active)) {
    const keyed = active.closest<HTMLElement>("[data-nyra-focus-key]");
    const row = active.closest<HTMLElement>(".setting-item");
    const settingName = row?.querySelector<HTMLElement>(".setting-item-name")?.textContent?.trim() ?? null;
    const rows = settingName
      ? [...container.querySelectorAll<HTMLElement>(".setting-item")].filter((candidate) => candidate.querySelector<HTMLElement>(".setting-item-name")?.textContent?.trim() === settingName)
      : [];
    const controls = row ? [...row.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE)] : [];
    focus = {
      key: keyed?.dataset.nyraFocusKey ?? null,
      settingName,
      settingOccurrence: Math.max(0, rows.indexOf(row!)),
      controlIndex: controls.indexOf(active)
    };
  }

  return { scroll, details, focus, windowX: window.scrollX, windowY: window.scrollY };
}

export function restoreDetails(container: HTMLElement, state: Map<string, boolean>): void {
  container.querySelectorAll<HTMLDetailsElement>("details").forEach((element, index) => {
    const key = element.dataset.nyraStateKey ?? `details:${index}`;
    const open = state.get(key);
    if (open !== undefined) element.open = open;
  });
}

export function restoreScroll(state: SettingsViewSnapshot["scroll"]): void {
  for (const { element, top, left } of state) {
    if (!element.isConnected) continue;
    element.scrollTop = top;
    element.scrollLeft = left;
  }
}

export function restoreFocus(container: HTMLElement, state: SettingsFocusSnapshot | null): void {
  if (!state) return;

  let target: HTMLElement | undefined;
  let focusRow: HTMLElement | undefined;
  if (state.key) {
    target = [...container.querySelectorAll<HTMLElement>("[data-nyra-focus-key]")]
      .find((element) => element.dataset.nyraFocusKey === state.key);
  }
  if (!target && state.settingName) {
    const rows = [...container.querySelectorAll<HTMLElement>(".setting-item")]
      .filter((element) => element.querySelector<HTMLElement>(".setting-item-name")?.textContent?.trim() === state.settingName);
    focusRow = rows[state.settingOccurrence];
    target = focusRow ? [...focusRow.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE)][state.controlIndex] : undefined;
  }
  if (!target || target.matches(":disabled") || target.getAttribute("aria-disabled") === "true") {
    if (focusRow) {
      focusRow.tabIndex = -1;
      focusRow.focus({ preventScroll: true });
    }
    return;
  }
  target.focus({ preventScroll: true });
}

export function statusCard(title: string, headline: string, tone: Tone, detail: string): HTMLElement {
  const card = document.createElement("div"); card.className = "nyra-nc-card";
  const top = document.createElement("div"); top.className = "nyra-nc-card__top";
  const label = document.createElement("span"); label.className = "nyra-nc-card__label"; label.textContent = title;
  const dot = document.createElement("span"); dot.className = `nyra-nc-dot nyra-nc-dot--${tone}`;
  top.append(label, dot);
  const value = document.createElement("div"); value.className = "nyra-nc-card__value"; value.textContent = headline;
  const sub = document.createElement("div"); sub.className = "nyra-nc-card__detail"; sub.textContent = detail;
  card.append(top, value, sub); return card;
}

export function metric(label: string, value: number, tone: Tone): HTMLElement {
  const node = document.createElement("div"); node.className = `nyra-nc-metric nyra-nc-metric--${tone}`;
  const strong = document.createElement("strong"); strong.textContent = String(value);
  const span = document.createElement("span"); span.textContent = label;
  node.append(strong, span); return node;
}

export type Tone = "ok" | "warn" | "error" | "neutral";

/** Copies text with the async clipboard API, falling back to a hidden textarea for webviews that lack it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  try {
    const area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.className = "nyra-nc-offscreen";
    document.body.appendChild(area); area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch { return false; }
}

/** The complete message, wrapped, selectable and scrollable, with a Copy button — nothing is ever cut off. */
export function appendErrorDetail(parent: HTMLElement, text: string): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "nyra-nc-detail";
  const body = document.createElement("pre"); body.className = "nyra-nc-detail__text"; body.textContent = text; body.tabIndex = 0;
  const copy = document.createElement("button"); copy.type = "button"; copy.className = "nyra-nc-detail__copy"; copy.textContent = "Copy";
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    void copyText(text).then((ok) => { copy.textContent = ok ? "Copied" : "Press and hold the text to copy"; globalThis.setTimeout(() => { copy.textContent = "Copy"; }, 2000); });
  });
  wrap.append(body, copy);
  parent.appendChild(wrap);
  return wrap;
}
