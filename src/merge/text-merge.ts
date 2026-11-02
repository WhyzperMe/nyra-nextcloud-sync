import type {
  TextLineEnding,
  TextMergeBlocked,
  TextMergeLimits,
  TextMergeResult,
  TextMergeSuccess
} from "./types";

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

interface DecodedText {
  text: string;
  normalized: string;
  lines: string[];
  bom: boolean;
  lineEnding: TextLineEnding;
}

interface ChangeHunk {
  start: number;
  end: number;
  replacement: string[];
}

interface LcsPair {
  a: number;
  b: number;
}

/**
 * Strict, bounded, conflict-free three-way text merge.
 *
 * It never emits conflict markers and returns bytes only when both sides' edits can be combined
 * without discarding anything and without a guess that depends on which device runs the merge:
 *
 *  - edits to different lines combine (line level);
 *  - edits that overlap a line are re-tried on words, but only if at least one unchanged word
 *    or punctuation mark separates them, so two people rewording the same sentence still block;
 *  - two pure insertions at the same spot (both sides appended a line, added a list item, ...)
 *    keep both, in an order fixed by the inserted text alone, so every device writes the same bytes.
 *
 * Everything else (edit against deletion, rewrites of the same words, mixed line endings,
 * binary or invalid UTF-8 content, exceeded budgets) is returned as blocked and left to the
 * conflict policy, which preserves both versions.
 */
export function mergeTextThreeWay(
  baseBytes: ArrayBuffer,
  localBytes: ArrayBuffer,
  remoteBytes: ArrayBuffer,
  limits: TextMergeLimits
): TextMergeResult {
  const limitError = validateLimits(limits);
  if (limitError) return blocked("diff-too-complex", limitError);
  if (baseBytes.byteLength > limits.maxInputBytes || localBytes.byteLength > limits.maxInputBytes || remoteBytes.byteLength > limits.maxInputBytes) {
    return blocked("input-too-large", `Automatic merge is limited to ${limits.maxInputBytes} bytes per version.`);
  }

  const base = decodeText(baseBytes);
  if (base.status === "blocked") return base;
  const local = decodeText(localBytes);
  if (local.status === "blocked") return local;
  const remote = decodeText(remoteBytes);
  if (remote.status === "blocked") return remote;

  if (base.value.lineEnding === "mixed" || local.value.lineEnding === "mixed" || remote.value.lineEnding === "mixed") {
    return blocked("mixed-line-endings", "Automatic merge is disabled for files with mixed line-ending styles.");
  }
  if (Math.max(base.value.lines.length, local.value.lines.length, remote.value.lines.length) > limits.maxLines) {
    return blocked("too-many-lines", `Automatic merge is limited to ${limits.maxLines} lines per version.`);
  }

  const chosenBom = chooseThreeWayMetadata(base.value.bom, local.value.bom, remote.value.bom);
  if (chosenBom === null) return blocked("metadata-conflict", "Both sides changed the UTF-8 BOM state differently.");
  const chosenEol = chooseThreeWayMetadata(base.value.lineEnding, local.value.lineEnding, remote.value.lineEnding);
  if (chosenEol === null) return blocked("metadata-conflict", "Both sides changed the line-ending style differently.");

  // Only the region between the common head and tail of two versions needs the exact diff.
  const localCells = trimmedCells(base.value.lines, local.value.lines);
  const remoteCells = trimmedCells(base.value.lines, remote.value.lines);
  if (!Number.isSafeInteger(localCells) || !Number.isSafeInteger(remoteCells) || localCells > limits.maxDiffCells || remoteCells > limits.maxDiffCells) {
    return blocked("diff-too-complex", `Automatic merge diff budget exceeded (${limits.maxDiffCells} cells per side).`);
  }

  const localHunks = changesFromBase(base.value.lines, local.value.lines);
  const remoteHunks = changesFromBase(base.value.lines, remote.value.lines);
  const work: MergeWork = { cells: Math.min(limits.maxDiffCells, TOKEN_CELL_BUDGET), tokenMerges: 0, insertionMerges: 0 };
  const merged = mergeHunkLists(base.value.lines, localHunks, remoteHunks, "line", work);
  if (typeof merged === "string") {
    return merged === "diff-too-complex"
      ? blocked("diff-too-complex", "Merging the overlapping edits word by word exceeded the diff budget.")
      : blocked("overlapping-edits", "Both devices changed the same text region. Nyra will not write conflict markers automatically.");
  }
  const mergedLines = merged;

  const lineEnding = materializedLineEnding(chosenEol, mergedLines);
  const joined = mergedLines.join(eolString(lineEnding));
  const encoded = new TextEncoder().encode(joined);
  const output = new Uint8Array(encoded.byteLength + (chosenBom ? UTF8_BOM.byteLength : 0));
  if (chosenBom) output.set(UTF8_BOM, 0);
  output.set(encoded, chosenBom ? UTF8_BOM.byteLength : 0);

  const success: TextMergeSuccess = {
    status: "merged",
    bytes: exactArrayBuffer(output),
    lineEnding,
    bom: chosenBom,
    stats: {
      baseLines: base.value.lines.length,
      localLines: local.value.lines.length,
      remoteLines: remote.value.lines.length,
      localHunks: localHunks.length,
      remoteHunks: remoteHunks.length,
      outputBytes: output.byteLength,
      tokenMerges: work.tokenMerges,
      insertionMerges: work.insertionMerges
    }
  };
  return success;
}

function decodeText(bytes: ArrayBuffer): { status: "ok"; value: DecodedText } | TextMergeBlocked {
  const source = new Uint8Array(bytes);
  if (source.includes(0)) return blocked("binary-content", "NUL bytes indicate binary/opaque content.");
  const bom = source.byteLength >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf;
  const body = bom ? source.subarray(3) : source;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return blocked("invalid-utf8", "Automatic merge requires valid UTF-8 text.");
  }
  // A decoded U+0000 can only come from an explicit NUL byte, already rejected;
  // keep this second check defensive against unusual decoder behavior.
  if (text.includes("\u0000")) return blocked("binary-content", "NUL characters indicate binary/opaque content.");

  const lineEnding = detectLineEnding(text);
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { status: "ok", value: { text, normalized, lines: normalized.split("\n"), bom, lineEnding } };
}

function detectLineEnding(text: string): TextLineEnding {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (index + 1 < text.length && text.charCodeAt(index + 1) === 10) {
        crlf += 1;
        index += 1;
      } else cr += 1;
    } else if (code === 10) lf += 1;
  }
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  if (kinds === 0) return "none";
  if (kinds > 1) return "mixed";
  if (crlf > 0) return "crlf";
  if (cr > 0) return "cr";
  return "lf";
}

function materializedLineEnding(chosen: Exclude<TextLineEnding, "mixed">, lines: readonly string[]): Exclude<TextLineEnding, "mixed"> {
  if (lines.length <= 1) return "none";
  return chosen === "none" ? "lf" : chosen;
}

function eolString(kind: Exclude<TextLineEnding, "mixed">): string {
  if (kind === "crlf") return "\r\n";
  if (kind === "cr") return "\r";
  return "\n";
}

function chooseThreeWayMetadata<T>(base: T, local: T, remote: T): T | null {
  if (Object.is(local, remote)) return local;
  if (Object.is(local, base)) return remote;
  if (Object.is(remote, base)) return local;
  return null;
}

/** Lines both versions share at the start and at the end; they cannot be part of any change. */
function commonEnds(base: readonly string[], variant: readonly string[]): { prefix: number; suffix: number } {
  const limit = Math.min(base.length, variant.length);
  let prefix = 0;
  while (prefix < limit && base[prefix] === variant[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && base[base.length - 1 - suffix] === variant[variant.length - 1 - suffix]) suffix += 1;
  return { prefix, suffix };
}

function trimmedCells(base: readonly string[], variant: readonly string[]): number {
  const { prefix, suffix } = commonEnds(base, variant);
  return (base.length - prefix - suffix) * (variant.length - prefix - suffix);
}

function changesFromBase(base: readonly string[], variant: readonly string[]): ChangeHunk[] {
  const { prefix, suffix } = commonEnds(base, variant);
  const middle = hirschbergPairs(base, variant, prefix, base.length - suffix, prefix, variant.length - suffix);
  const pairs: LcsPair[] = [];
  for (let index = 0; index < prefix; index += 1) pairs.push({ a: index, b: index });
  for (const pair of middle) pairs.push(pair);
  for (let index = 0; index < suffix; index += 1) pairs.push({ a: base.length - suffix + index, b: variant.length - suffix + index });
  const hunks: ChangeHunk[] = [];
  let previousA = -1;
  let previousB = -1;
  for (let index = 0; index <= pairs.length; index += 1) {
    const pair = index < pairs.length ? pairs[index]! : { a: base.length, b: variant.length };
    const start = previousA + 1;
    const end = pair.a;
    const replacementStart = previousB + 1;
    const replacementEnd = pair.b;
    if (start !== end || replacementStart !== replacementEnd) {
      hunks.push({ start, end, replacement: variant.slice(replacementStart, replacementEnd) });
    }
    previousA = pair.a;
    previousB = pair.b;
  }
  return hunks;
}

/** Hirschberg LCS reconstruction: exact, deterministic, O(n*m) time and O(m) memory. */
function hirschbergPairs(
  a: readonly string[],
  b: readonly string[],
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): LcsPair[] {
  const n = aEnd - aStart;
  const m = bEnd - bStart;
  if (n === 0 || m === 0) return [];
  if (n === 1) {
    const needle = a[aStart]!;
    for (let j = bStart; j < bEnd; j += 1) if (needle === b[j]) return [{ a: aStart, b: j }];
    return [];
  }

  const aMid = aStart + Math.floor(n / 2);
  const left = lcsPrefixLengths(a, b, aStart, aMid, bStart, bEnd);
  const right = lcsSuffixLengths(a, b, aMid, aEnd, bStart, bEnd);
  let splitOffset = 0;
  let best = -1;
  for (let k = 0; k <= m; k += 1) {
    const score = left[k]! + right[k]!;
    // Stable earliest split makes the diff deterministic across runtimes.
    if (score > best) { best = score; splitOffset = k; }
  }
  const bMid = bStart + splitOffset;
  return [
    ...hirschbergPairs(a, b, aStart, aMid, bStart, bMid),
    ...hirschbergPairs(a, b, aMid, aEnd, bMid, bEnd)
  ];
}

function lcsPrefixLengths(
  a: readonly string[], b: readonly string[], aStart: number, aEnd: number, bStart: number, bEnd: number
): Uint32Array {
  const m = bEnd - bStart;
  let previous = new Uint32Array(m + 1);
  let current = new Uint32Array(m + 1);
  for (let i = aStart; i < aEnd; i += 1) {
    current[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      current[j] = a[i] === b[bStart + j - 1]
        ? previous[j - 1]! + 1
        : Math.max(previous[j]!, current[j - 1]!);
    }
    const swap = previous; previous = current; current = swap;
  }
  return previous;
}

function lcsSuffixLengths(
  a: readonly string[], b: readonly string[], aStart: number, aEnd: number, bStart: number, bEnd: number
): Uint32Array {
  const m = bEnd - bStart;
  let previous = new Uint32Array(m + 1);
  let current = new Uint32Array(m + 1);
  for (let i = aEnd - 1; i >= aStart; i -= 1) {
    current[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      current[j] = a[i] === b[bEnd - j]
        ? previous[j - 1]! + 1
        : Math.max(previous[j]!, current[j - 1]!);
    }
    const swap = previous; previous = current; current = swap;
  }
  const suffix = new Uint32Array(m + 1);
  for (let k = 0; k <= m; k += 1) suffix[k] = previous[m - k]!;
  return suffix;
}

type MergeFailure = "overlapping-edits" | "diff-too-complex";
interface MergeWork { cells: number; tokenMerges: number; insertionMerges: number }
/** Total word-level diff cells one merge may spend, on top of the per-side line budget. */
const TOKEN_CELL_BUDGET = 16_000_000;
const MAX_TOKENS_PER_REGION = 50_000;
const TOKEN_PATTERN = /\n|[^\S\n]+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/**
 * Merges two change lists over the same base. `level` "line" resolves interacting edits through
 * resolveCluster (insertions at one spot, word-level retry); "token" never resolves them and also demands
 * a separating unchanged word between edits of different sides.
 */
function mergeHunkLists(
  base: readonly string[], local: readonly ChangeHunk[], remote: readonly ChangeHunk[], level: "line" | "token", work: MergeWork
): string[] | MergeFailure {
  const output: string[] = [];
  let cursor = 0;
  let li = 0;
  let ri = 0;
  let previous: { side: "l" | "r"; end: number } | null = null;
  while (li < local.length || ri < remote.length) {
    const l = li < local.length ? local[li]! : null;
    const r = ri < remote.length ? remote[ri]! : null;

    if (l && r && equivalentHunk(l, r)) {
      if (l.start < cursor) return "overlapping-edits";
      appendBase(output, base, cursor, l.start);
      output.push(...l.replacement);
      cursor = l.end;
      li += 1;
      ri += 1;
      previous = null;
      continue;
    }
    if (l && r && hunksInteract(l, r)) {
      if (level === "token") return "overlapping-edits";
      // Grow the region while further edits of either side touch it, then resolve it as one unit.
      let start = Math.min(l.start, r.start);
      let end = Math.max(l.end, r.end);
      const localCluster = [l];
      const remoteCluster = [r];
      li += 1;
      ri += 1;
      for (let grew = true; grew;) {
        grew = false;
        while (li < local.length && hunksInteract({ start, end, replacement: [] }, local[li]!)) {
          localCluster.push(local[li]!); end = Math.max(end, local[li]!.end); start = Math.min(start, local[li]!.start); li += 1; grew = true;
        }
        while (ri < remote.length && hunksInteract({ start, end, replacement: [] }, remote[ri]!)) {
          remoteCluster.push(remote[ri]!); end = Math.max(end, remote[ri]!.end); start = Math.min(start, remote[ri]!.start); ri += 1; grew = true;
        }
      }
      if (start < cursor) return "overlapping-edits";
      const resolved = resolveCluster(base, start, end, localCluster, remoteCluster, work);
      if (typeof resolved === "string") return resolved;
      appendBase(output, base, cursor, start);
      output.push(...resolved);
      cursor = end;
      previous = null;
      continue;
    }

    const chooseLocal = l !== null && (r === null || compareHunkOrder(l, r) <= 0);
    const hunk = chooseLocal ? l! : r!;
    if (hunk.start < cursor) return "overlapping-edits";
    const side = chooseLocal ? "l" : "r";
    if (level === "token" && previous && previous.side !== side && !hasSeparatingWord(base, previous.end, hunk.start)) return "overlapping-edits";
    appendBase(output, base, cursor, hunk.start);
    output.push(...hunk.replacement);
    cursor = hunk.end;
    previous = { side, end: hunk.end };
    if (chooseLocal) li += 1; else ri += 1;
  }
  appendBase(output, base, cursor, base.length);
  return output;
}

/** True when an unchanged word or punctuation mark (not only blanks and line breaks) lies between two edits. */
function hasSeparatingWord(base: readonly string[], from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) if (!/^\s+$/u.test(base[index]!)) return true;
  return false;
}

function applyRegion(base: readonly string[], start: number, end: number, hunks: readonly ChangeHunk[]): string[] {
  const out: string[] = [];
  let position = start;
  for (const hunk of hunks) {
    appendBase(out, base, position, hunk.start);
    out.push(...hunk.replacement);
    position = hunk.end;
  }
  appendBase(out, base, position, end);
  return out;
}

/** Combines the edits of both sides inside one interacting region, or reports why that is not safe. */
function resolveCluster(
  base: readonly string[], start: number, end: number, localCluster: readonly ChangeHunk[], remoteCluster: readonly ChangeHunk[], work: MergeWork
): string[] | MergeFailure {
  const l = localCluster[0]!;
  const r = remoteCluster[0]!;
  if (localCluster.length === 1 && remoteCluster.length === 1 && l.start === l.end && r.start === r.end && l.start === r.start) {
    work.insertionMerges += 1;
    return orderInsertions(l.replacement, r.replacement);
  }

  // Retry on words. Every line carries its own terminator so that an empty result stays distinguishable from one empty line.
  const asText = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join("");
  const baseTokens = tokenize(asText(base.slice(start, end)));
  const localTokens = tokenize(asText(applyRegion(base, start, end, localCluster)));
  const remoteTokens = tokenize(asText(applyRegion(base, start, end, remoteCluster)));
  if (!baseTokens || !localTokens || !remoteTokens) return "overlapping-edits";
  if (Math.max(baseTokens.length, localTokens.length, remoteTokens.length) > MAX_TOKENS_PER_REGION) return "diff-too-complex";
  const cells = trimmedCells(baseTokens, localTokens) + trimmedCells(baseTokens, remoteTokens);
  if (!Number.isSafeInteger(cells) || cells > work.cells) return "diff-too-complex";
  work.cells -= cells;

  const merged = mergeHunkLists(baseTokens, changesFromBase(baseTokens, localTokens), changesFromBase(baseTokens, remoteTokens), "token", work);
  if (typeof merged === "string") return merged;
  const text = merged.join("");
  if (text !== "" && !text.endsWith("\n")) return "overlapping-edits";
  work.tokenMerges += 1;
  return text === "" ? [] : text.slice(0, -1).split("\n");
}

function tokenize(text: string): string[] | null {
  const tokens = text.match(TOKEN_PATTERN) ?? [];
  return tokens.join("") === text ? tokens : null;
}

/**
 * Two insertions at the same spot keep both. The order depends only on the inserted lines, never on which
 * device is "local", so any two devices merging the same pair write identical bytes. If one insertion already
 * contains the other, the larger one is used instead of repeating lines.
 */
function orderInsertions(left: readonly string[], right: readonly string[]): string[] {
  if (containsRun(left, right)) return [...left];
  if (containsRun(right, left)) return [...right];
  const first = compareLines(left, right) <= 0 ? left : right;
  const second = first === left ? right : left;
  return [...first, ...second];
}

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return true;
  for (let offset = 0; offset + needle.length <= haystack.length; offset += 1) {
    let matches = true;
    for (let index = 0; index < needle.length; index += 1) if (haystack[offset + index] !== needle[index]) { matches = false; break; }
    if (matches) return true;
  }
  return false;
}

function compareLines(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return left.length - right.length;
}

function equivalentHunk(left: ChangeHunk, right: ChangeHunk): boolean {
  if (left.start !== right.start || left.end !== right.end || left.replacement.length !== right.replacement.length) return false;
  for (let i = 0; i < left.replacement.length; i += 1) if (left.replacement[i] !== right.replacement[i]) return false;
  return true;
}

function hunksInteract(left: ChangeHunk, right: ChangeHunk): boolean {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return right.start < left.start && left.start < right.end;
  if (rightInsertion) return left.start < right.start && right.start < left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function compareHunkOrder(left: ChangeHunk, right: ChangeHunk): number {
  if (left.start !== right.start) return left.start - right.start;
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion !== rightInsertion) return leftInsertion ? -1 : 1;
  return left.end - right.end;
}

function appendBase(output: string[], base: readonly string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) output.push(base[index]!);
}

function blocked(reason: TextMergeBlocked["reason"], message: string): TextMergeBlocked {
  return { status: "blocked", reason, message };
}

function validateLimits(limits: TextMergeLimits): string | null {
  if (!Number.isSafeInteger(limits.maxInputBytes) || limits.maxInputBytes <= 0) return "maxInputBytes must be a positive safe integer.";
  if (!Number.isSafeInteger(limits.maxLines) || limits.maxLines <= 0) return "maxLines must be a positive safe integer.";
  if (!Number.isSafeInteger(limits.maxDiffCells) || limits.maxDiffCells <= 0) return "maxDiffCells must be a positive safe integer.";
  return null;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
