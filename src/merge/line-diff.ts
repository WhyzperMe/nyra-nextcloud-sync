export type DiffKind = "equal" | "add" | "remove";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** False when the inputs differ too much for a line diff within the safety limit. */
  complete: boolean;
}

const MAX_EDIT_DISTANCE = 1_500;

/**
 * Line diff using Myers' O(ND) algorithm with a bounded edit distance, so presenting a
 * conflict can never hang on two unrelated large files.
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffResult {
  const n = before.length;
  const m = after.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Only the diagonals reachable at each step are snapshotted, keeping memory near D^2/2 integers.
  const trace: Array<{ low: number; data: Int32Array }> = [];
  let found = -1;

  for (let d = 0; d <= max && found < 0; d += 1) {
    trace.push({ low: offset - d - 1, data: v.slice(offset - d - 1, offset + d + 2) });
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && before[x] === after[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }

  if (found < 0) {
    return { lines: [...before.map((text): DiffLine => ({ kind: "remove", text })), ...after.map((text): DiffLine => ({ kind: "add", text }))], added: m, removed: n, complete: false };
  }

  const reversed: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const { low, data } = trace[d]!;
    const at = (k: number): number => data[offset + k - low]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) { x -= 1; y -= 1; reversed.push({ kind: "equal", text: before[x]! }); }
    if (down) { y -= 1; reversed.push({ kind: "add", text: after[y]! }); }
    else { x -= 1; reversed.push({ kind: "remove", text: before[x]! }); }
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; reversed.push({ kind: "equal", text: before[x]! }); }

  const lines = reversed.reverse();
  return { lines, added: lines.filter((line) => line.kind === "add").length, removed: lines.filter((line) => line.kind === "remove").length, complete: true };
}

/** Keeps changed lines and `context` unchanged lines around them; elided runs become a single separator entry. */
export function foldContext(lines: readonly DiffLine[], context = 3): Array<DiffLine | { kind: "skip"; count: number }> {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "equal") return;
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i += 1) keep[i] = true;
  });
  const output: Array<DiffLine | { kind: "skip"; count: number }> = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) { output.push({ kind: "skip", count: skipped }); skipped = 0; }
      output.push(line);
    } else skipped += 1;
  });
  if (skipped > 0) output.push({ kind: "skip", count: skipped });
  return output;
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
