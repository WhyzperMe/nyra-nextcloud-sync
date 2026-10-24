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
 * The engine deliberately does less than Git's interactive merge machinery:
 * it only returns bytes when BASE→LOCAL and BASE→REMOTE edits provably commute.
 * It never emits conflict markers and never guesses an ordering for two edits at
 * the same logical location. Unsupported/ambiguous cases are returned as blocked.
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

  const localCells = base.value.lines.length * local.value.lines.length;
  const remoteCells = base.value.lines.length * remote.value.lines.length;
  if (!Number.isSafeInteger(localCells) || !Number.isSafeInteger(remoteCells) || localCells > limits.maxDiffCells || remoteCells > limits.maxDiffCells) {
    return blocked("diff-too-complex", `Automatic merge diff budget exceeded (${limits.maxDiffCells} cells per side).`);
  }

  const localHunks = changesFromBase(base.value.lines, local.value.lines);
  const remoteHunks = changesFromBase(base.value.lines, remote.value.lines);
  const mergedLines = mergeHunks(base.value.lines, localHunks, remoteHunks);
  if (mergedLines === null) {
    return blocked("overlapping-edits", "Both devices changed the same text region. Nyra will not write conflict markers automatically.");
  }

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
      outputBytes: output.byteLength
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

function changesFromBase(base: readonly string[], variant: readonly string[]): ChangeHunk[] {
  const pairs = hirschbergPairs(base, variant, 0, base.length, 0, variant.length);
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

function mergeHunks(base: readonly string[], local: readonly ChangeHunk[], remote: readonly ChangeHunk[]): string[] | null {
  const output: string[] = [];
  let cursor = 0;
  let li = 0;
  let ri = 0;
  while (li < local.length || ri < remote.length) {
    const l = li < local.length ? local[li]! : null;
    const r = ri < remote.length ? remote[ri]! : null;

    if (l && r && equivalentHunk(l, r)) {
      appendBase(output, base, cursor, l.start);
      output.push(...l.replacement);
      cursor = l.end;
      li += 1;
      ri += 1;
      continue;
    }
    if (l && r && hunksInteract(l, r)) return null;

    const chooseLocal = l !== null && (r === null || compareHunkOrder(l, r) <= 0);
    const hunk = chooseLocal ? l! : r!;
    if (hunk.start < cursor) return null;
    appendBase(output, base, cursor, hunk.start);
    output.push(...hunk.replacement);
    cursor = hunk.end;
    if (chooseLocal) li += 1; else ri += 1;
  }
  appendBase(output, base, cursor, base.length);
  return output;
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
