import { mergeTextThreeWay } from "./text-merge";
import { compressToBase64, decompressFromBase64 } from "./lz-string";
import type { TextMergeBlocked, TextMergeLimits, TextMergeResult } from "./types";

/**
 * Semantic three-way merge of Excalidraw drawings.
 *
 * A `.excalidraw.md` file keeps the scene as one LZ-compressed JSON block. Compressed data cannot be
 * merged line by line (a single stroke changes the whole stream), so the scene is decompressed, merged
 * element by element and compressed again, exactly like Excalidraw reconciles collaborators:
 *
 *  - an element only one side changed (compared with the common ancestor) keeps that change;
 *  - an element both sides changed goes to the higher `version`, then the lower `versionNonce`;
 *  - an element only one side has is an addition, unless the ancestor had it and the other side left it
 *    untouched (then it was deleted); a change always beats a deletion;
 *  - the result is ordered by Excalidraw's fractional `index`.
 *
 * The merge is deterministic and symmetric: every device computes the same bytes from the same inputs.
 */
interface SceneElement { id: string; version?: number; versionNonce?: number; index?: string; [key: string]: unknown }
interface Scene {
  elements: SceneElement[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
  [key: string]: unknown;
}
interface ParsedDrawing {
  head: string;
  tail: string;
  compressed: boolean;
  scene: Scene;
  bom: boolean;
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
}

export const EXCALIDRAW_MAX_SCENE_CHARS = 256 * 1024 * 1024;
const LINE_LENGTH = 256;
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

export function isExcalidrawPath(path: string): boolean {
  return /\.excalidraw(\.md)?$/i.test(path);
}

export function mergeExcalidrawThreeWay(
  path: string,
  baseBytes: ArrayBuffer,
  localBytes: ArrayBuffer,
  remoteBytes: ArrayBuffer,
  limits: TextMergeLimits
): TextMergeResult {
  if (Math.max(baseBytes.byteLength, localBytes.byteLength, remoteBytes.byteLength) > limits.maxInputBytes) {
    return blocked("input-too-large", `Automatic merge is limited to ${limits.maxInputBytes} bytes per version.`);
  }
  const markdown = !/\.excalidraw$/i.test(path);
  const base = parseDrawing(baseBytes, markdown, "common ancestor");
  if ("status" in base) return base;
  const local = parseDrawing(localBytes, markdown, "local version");
  if ("status" in local) return local;
  const remote = parseDrawing(remoteBytes, markdown, "Nextcloud version");
  if ("status" in remote) return remote;

  return combineDrawings(markdown, base, local, remote, limits);
}

/**
 * Merges two drawings that have no common ancestor (both devices created or recreated the same file).
 * Every element either side has is kept; an element both have goes to the higher `version`. The inputs
 * are put into a canonical order first, so every device produces the same bytes.
 */
export function mergeExcalidrawTwoWay(path: string, aBytes: ArrayBuffer, bBytes: ArrayBuffer, limits: TextMergeLimits): TextMergeResult {
  if (Math.max(aBytes.byteLength, bBytes.byteLength) > limits.maxInputBytes) {
    return blocked("input-too-large", `Automatic merge is limited to ${limits.maxInputBytes} bytes per version.`);
  }
  const markdown = !/.excalidraw$/i.test(path);
  const [firstBytes, secondBytes] = compareBytes(aBytes, bBytes) >= 0 ? [aBytes, bBytes] : [bBytes, aBytes];
  const first = parseDrawing(firstBytes, markdown, "first version");
  if ("status" in first) return first;
  const second = parseDrawing(secondBytes, markdown, "second version");
  if ("status" in second) return second;
  const empty: ParsedDrawing = {
    head: "", tail: "", compressed: first.compressed, bom: first.bom, eol: first.eol, trailingNewline: first.trailingNewline,
    scene: { elements: [], appState: {}, files: {} }
  };
  return combineDrawings(markdown, empty, first, second, limits);
}

function compareBytes(a: ArrayBuffer, b: ArrayBuffer): number {
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  const length = Math.min(x.length, y.length);
  for (let index = 0; index < length; index += 1) if (x[index] !== y[index]) return x[index]! - y[index]!;
  return x.length - y.length;
}

function combineDrawings(markdown: boolean, base: ParsedDrawing, local: ParsedDrawing, remote: ParsedDrawing, limits: TextMergeLimits): TextMergeResult {
  const merged = mergeScenes(base.scene, local.scene, remote.scene);
  const head = mergeSurrounding(base.head, local.head, remote.head, limits);
  const tail = mergeSurrounding(base.tail, local.tail, remote.tail, limits);
  const compressed = chooseThreeWay(base.compressed, local.compressed, remote.compressed) ?? remote.compressed;
  const eol = chooseThreeWay(base.eol, local.eol, remote.eol) ?? remote.eol;
  const bom = chooseThreeWay(base.bom, local.bom, remote.bom) ?? remote.bom;

  // The plugin writes tab-indented JSON; matching it keeps unchanged drawings byte-identical.
  const json = JSON.stringify(merged.scene, null, "	");
  let body: string;
  if (markdown && compressed) {
    const packed = compressToBase64(json);
    body = (packed.match(new RegExp(`.{1,${LINE_LENGTH}}`, "gs")) ?? []).join(eol) + (remote.trailingNewline ? eol : "");
  } else {
    body = json + (remote.trailingNewline ? eol : "");
  }
  const text = markdown ? `${head.text}${body}${tail.text}` : json;
  const encoded = new TextEncoder().encode(text);
  const output = new Uint8Array(encoded.byteLength + (bom ? UTF8_BOM.byteLength : 0));
  if (bom) output.set(UTF8_BOM, 0);
  output.set(encoded, bom ? UTF8_BOM.byteLength : 0);
  if (output.byteLength > limits.maxInputBytes * 2) {
    return blocked("input-too-large", "The merged drawing would exceed the automatic merge size budget.");
  }
  const copy = new Uint8Array(output.byteLength);
  copy.set(output);
  return {
    status: "merged",
    bytes: copy.buffer,
    lineEnding: eol === "\r\n" ? "crlf" : "lf",
    bom,
    stats: {
      baseLines: base.scene.elements.length,
      localLines: local.scene.elements.length,
      remoteLines: remote.scene.elements.length,
      localHunks: merged.localChanges,
      remoteHunks: merged.remoteChanges,
      outputBytes: output.byteLength
    }
  };
}

function parseDrawing(bytes: ArrayBuffer, markdown: boolean, label: string): ParsedDrawing | TextMergeBlocked {
  const source = new Uint8Array(bytes);
  const bom = source.byteLength >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? source.subarray(3) : source);
  } catch {
    return blocked("invalid-utf8", `The ${label} is not valid UTF-8.`);
  }
  const eol: "\r\n" | "\n" = text.includes("\r\n") ? "\r\n" : "\n";
  let head = "";
  let tail = "";
  let payload = text;
  let compressed = false;
  let trailingNewline = false;
  if (markdown) {
    const located = locateBlock(text);
    if (!located) return blocked("excalidraw-unparseable", `The ${label} has no drawing data block.`);
    head = text.slice(0, located.bodyStart);
    tail = text.slice(located.bodyEnd);
    payload = text.slice(located.bodyStart, located.bodyEnd);
    compressed = located.compressed;
    trailingNewline = /\r?\n$/.test(payload);
  }
  let json: string;
  if (markdown && compressed) {
    const packed = payload.replace(/[\r\n\s]/g, "");
    const unpacked = decompressFromBase64(packed);
    if (!unpacked) return blocked("excalidraw-unparseable", `The ${label} drawing data could not be decompressed.`);
    json = unpacked;
  } else {
    json = payload;
  }
  if (json.length > EXCALIDRAW_MAX_SCENE_CHARS) return blocked("input-too-large", `The ${label} drawing is larger than the automatic merge budget.`);
  let scene: unknown;
  try { scene = JSON.parse(json); } catch { return blocked("excalidraw-unparseable", `The ${label} drawing data is not valid JSON.`); }
  if (!isScene(scene)) return blocked("excalidraw-unparseable", `The ${label} is not an Excalidraw scene.`);
  return { head, tail, compressed, scene, bom, eol, trailingNewline };
}

function locateBlock(text: string): { bodyStart: number; bodyEnd: number; compressed: boolean } | null {
  for (const [fence, compressed] of [["```compressed-json", true], ["```json", false]] as const) {
    const open = text.indexOf(fence);
    if (open < 0) continue;
    const lineEnd = text.indexOf("\n", open);
    if (lineEnd < 0) continue;
    const bodyStart = lineEnd + 1;
    const close = text.indexOf("```", bodyStart);
    if (close < 0) continue;
    return { bodyStart, bodyEnd: close, compressed };
  }
  return null;
}

function isScene(value: unknown): value is Scene {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const elements = (value as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return false;
  const ids = new Set<string>();
  for (const element of elements) {
    if (typeof element !== "object" || element === null || typeof (element as { id?: unknown }).id !== "string") return false;
    const id = (element as { id: string }).id;
    if (ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

interface SceneMerge { scene: Scene; localChanges: number; remoteChanges: number }

function mergeScenes(base: Scene, local: Scene, remote: Scene): SceneMerge {
  let localChanges = 0;
  let remoteChanges = 0;
  const baseMap = new Map(base.elements.map((element) => [element.id, element]));
  const localMap = new Map(local.elements.map((element) => [element.id, element]));
  const remoteMap = new Map(remote.elements.map((element) => [element.id, element]));
  const json = new Map<SceneElement, string>();
  const text = (element: SceneElement): string => {
    let cached = json.get(element);
    if (cached === undefined) { cached = JSON.stringify(element); json.set(element, cached); }
    return cached;
  };

  // Union in a stable order: Nextcloud's order first, then elements only this device has.
  const ids: string[] = [...remote.elements.map((element) => element.id), ...local.elements.map((element) => element.id).filter((id) => !remoteMap.has(id))];
  const kept: SceneElement[] = [];
  for (const id of ids) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    if (l && r) {
      const lText = text(l);
      const rText = text(r);
      if (lText === rText) { kept.push(l); continue; }
      const lChanged = !b || lText !== text(b);
      const rChanged = !b || rText !== text(b);
      if (lChanged && !rChanged) { kept.push(l); localChanges += 1; }
      else if (rChanged && !lChanged) { kept.push(r); remoteChanges += 1; }
      else {
        const winner = reconcileElement(l, r, lText, rText);
        kept.push(winner);
        if (winner === l) localChanges += 1; else remoteChanges += 1;
      }
    } else if (l) {
      if (!b) { kept.push(l); localChanges += 1; } // added here
      else if (text(l) === text(b)) remoteChanges += 1; // deleted on Nextcloud, untouched here
      else { kept.push(l); localChanges += 1; } // changed here: the change beats the deletion
    } else if (r) {
      if (!b) { kept.push(r); remoteChanges += 1; }
      else if (text(r) === text(b)) localChanges += 1; // deleted here, untouched on Nextcloud
      else { kept.push(r); remoteChanges += 1; }
    }
  }
  const ordered = kept.every((element) => typeof element.index === "string")
    ? [...kept].sort((a, b) => compareStrings(a.index!, b.index!) || compareStrings(a.id, b.id))
    : kept;

  const merged: Record<string, unknown> = {};
  for (const key of unionKeys(remote, local, base)) {
    if (key === "elements") { merged.elements = ordered; continue; }
    if (key === "appState" || key === "files") {
      const value = mergeRecords(asRecord(base[key]), asRecord(local[key]), asRecord(remote[key]), key === "files" ? preferNewerFile : preferLarger);
      if (value !== undefined) merged[key] = value;
      continue;
    }
    const value = pick(base[key], local[key], remote[key], preferLarger);
    if (value !== undefined) merged[key] = value;
  }
  // Keep the key order of the plugin's own output so unchanged parts stay byte-identical.
  const result: Record<string, unknown> = {};
  for (const key of ["type", "version", "source", "elements", "appState", "files", ...Object.keys(merged)]) {
    if (key in merged && !(key in result)) result[key] = merged[key];
  }
  return { scene: result as Scene, localChanges, remoteChanges };
}

/** Excalidraw's own tie-break: the higher version wins, then the lower versionNonce. */
function reconcileElement(local: SceneElement, remote: SceneElement, localText: string, remoteText: string): SceneElement {
  if (typeof local.version === "number" && typeof remote.version === "number" && local.version !== remote.version) {
    return local.version > remote.version ? local : remote;
  }
  if (typeof local.versionNonce === "number" && typeof remote.versionNonce === "number" && local.versionNonce !== remote.versionNonce) {
    return local.versionNonce < remote.versionNonce ? local : remote;
  }
  return compareStrings(localText, remoteText) >= 0 ? local : remote;
}

function unionKeys(...scenes: Scene[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const scene of scenes) for (const key of Object.keys(scene)) if (!seen.has(key)) { seen.add(key); keys.push(key); }
  return keys;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Per-key three-way merge of a flat record (appState, files). */
function mergeRecords(
  base: Record<string, unknown> | undefined,
  local: Record<string, unknown> | undefined,
  remote: Record<string, unknown> | undefined,
  prefer: (local: unknown, remote: unknown) => unknown
): Record<string, unknown> | undefined {
  if (!local && !remote) return undefined;
  const result: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(remote ?? {}), ...Object.keys(local ?? {})]);
  for (const key of keys) {
    const value = pick(base?.[key], local?.[key], remote?.[key], prefer);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function pick(base: unknown, local: unknown, remote: unknown, prefer: (local: unknown, remote: unknown) => unknown): unknown {
  const l = JSON.stringify(local);
  const r = JSON.stringify(remote);
  if (l === r) return local;
  const b = JSON.stringify(base);
  if (l === b) return remote;
  if (r === b) return local;
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  return prefer(local, remote);
}

function preferLarger(local: unknown, remote: unknown): unknown {
  return compareStrings(JSON.stringify(local), JSON.stringify(remote)) >= 0 ? local : remote;
}

function preferNewerFile(local: unknown, remote: unknown): unknown {
  const created = (value: unknown): number => {
    const stamp = (value as { created?: unknown } | null)?.created;
    return typeof stamp === "number" ? stamp : 0;
  };
  if (created(local) !== created(remote)) return created(local) > created(remote) ? local : remote;
  return preferLarger(local, remote);
}

/** The Markdown around the drawing block (front matter, text elements, embedded files). */
function mergeSurrounding(base: string, local: string, remote: string, limits: TextMergeLimits): { text: string } {
  if (local === remote) return { text: local };
  if (local === base) return { text: remote };
  if (remote === base) return { text: local };
  const encode = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer as ArrayBuffer;
  const merged = mergeTextThreeWay(encode(base), encode(local), encode(remote), { ...limits, maxInputBytes: Math.max(limits.maxInputBytes, 1024 * 1024) });
  if (merged.status === "merged") return { text: new TextDecoder().decode(merged.bytes) };
  // Both devices edited the same text part: keep one deterministically; Excalidraw rebuilds it from the scene.
  return { text: compareStrings(local, remote) >= 0 ? local : remote };
}

function chooseThreeWay<T>(base: T, local: T, remote: T): T | null {
  if (Object.is(local, remote)) return local;
  if (Object.is(local, base)) return remote;
  if (Object.is(remote, base)) return local;
  return null;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function blocked(reason: TextMergeBlocked["reason"], message: string): TextMergeBlocked {
  return { status: "blocked", reason, message };
}
