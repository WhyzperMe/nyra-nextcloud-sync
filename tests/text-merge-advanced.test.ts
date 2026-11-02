import { describe, expect, it } from "vitest";
import { mergeTextThreeWay } from "../src/merge/text-merge";

const enc = new TextEncoder();
const dec = new TextDecoder();
const limits = { maxInputBytes: 2 * 1024 * 1024, maxLines: 12_000, maxDiffCells: 8_000_000 };
const b = (value: string): ArrayBuffer => enc.encode(value).buffer as ArrayBuffer;
const merge = (base: string, local: string, remote: string) => mergeTextThreeWay(b(base), b(local), b(remote), limits);
function merged(base: string, local: string, remote: string): string {
  const result = merge(base, local, remote);
  if (result.status !== "merged") throw new Error(`${result.reason}: ${result.message}`);
  return dec.decode(result.bytes);
}
/** Merge from both devices' point of view; both must agree byte for byte. */
function both(base: string, local: string, remote: string): string {
  const forward = merged(base, local, remote);
  expect(merged(base, remote, local), "the other device must write the same bytes").toBe(forward);
  return forward;
}
const blockedReason = (base: string, local: string, remote: string): string | null => {
  const a = merge(base, local, remote), c = merge(base, remote, local);
  expect(a.status, "both devices must reach the same verdict").toBe(c.status);
  return a.status === "blocked" ? a.reason : null;
};

describe("two devices append or insert at the same spot", () => {
  it("keeps both appended lines at the end of a note, identically on both devices", () => {
    expect(both("# Log\n- 09:00 start\n", "# Log\n- 09:00 start\n- 10:00 phone\n", "# Log\n- 09:00 start\n- 10:30 laptop\n"))
      .toBe("# Log\n- 09:00 start\n- 10:00 phone\n- 10:30 laptop\n");
  });

  it("keeps both list items added in the middle of a list", () => {
    expect(both("- a\n- c\n", "- a\n- b1\n- c\n", "- a\n- b2\n- c\n")).toBe("- a\n- b1\n- b2\n- c\n");
  });

  it("does not repeat lines when one insertion already contains the other", () => {
    expect(both("A\nB\n", "A\nx\ny\nB\n", "A\ny\nB\n")).toBe("A\nx\ny\nB\n");
  });

  it("merges several independent same-spot insertions in one note", () => {
    expect(both("A\nB\nC\n", "A\nL1\nB\nC\nL2\n", "A\nR1\nB\nC\nR2\n")).toBe("A\nL1\nR1\nB\nC\nL2\nR2\n");
  });
});

describe("two devices edit the same paragraph", () => {
  const base = "Intro line\nThe quick brown fox jumps over the lazy dog near the river bank.\nOutro\n";

  it("combines edits to different sentences of one long line", () => {
    const local = base.replace("quick", "fast");
    const remote = base.replace("river bank", "old mill");
    expect(both(base, local, remote)).toBe("Intro line\nThe fast brown fox jumps over the lazy dog near the old mill.\nOutro\n");
  });

  it("combines an edit and an insertion in the same line", () => {
    const local = base.replace("lazy", "sleepy");
    const remote = base.replace("Outro", "Outro");
    expect(both(base, local, remote)).toBe(local);
    const inserted = base.replace("jumps", "jumps swiftly");
    expect(both(base, local, inserted)).toBe("Intro line\nThe quick brown fox jumps swiftly over the sleepy dog near the river bank.\nOutro\n");
  });

  it("handles unicode words and markdown syntax", () => {
    const start = "Café **wichtig** [[Seite|Titel]] 日本語 text\n";
    expect(both(start, start.replace("Café", "Tee"), start.replace("text", "Notiz"))).toBe("Tee **wichtig** [[Seite|Titel]] 日本語 Notiz\n");
    expect(both(start, start.replace("Seite", "Anderes"), start.replace("Titel", "Alias"))).toBe("Café **wichtig** [[Anderes|Alias]] 日本語 text\n");
  });

  it("still blocks when both rewrite the same words", () => {
    expect(blockedReason(base, base.replace("quick brown", "slow red"), base.replace("quick brown", "fast green"))).toBe("overlapping-edits");
    expect(blockedReason("one two three\n", "one TWO three\n", "one TOO three\n")).toBe("overlapping-edits");
  });

  it("blocks edits that are separated by blanks only, and merges them once a word separates them", () => {
    expect(blockedReason("alpha beta gamma\n", "ALPHA beta gamma\n", "alpha BETA gamma\n")).toBe("overlapping-edits");
    expect(both("alpha beta gamma\n", "ALPHA beta gamma\n", "alpha beta GAMMA\n")).toBe("ALPHA beta GAMMA\n");
  });

  it("blocks an edit against a deletion of the same text", () => {
    expect(blockedReason("keep\nold text here\nkeep too\n", "keep\nkeep too\n", "keep\nold NEW here\nkeep too\n")).toBe("overlapping-edits");
  });

  it("blocks two different insertions at the same word position", () => {
    expect(blockedReason("one two\n", "one big two\n", "one small two\n")).toBe("overlapping-edits");
  });

  it("keeps CRLF and BOM when merging inside a line", () => {
    const base = "\uFEFFfirst sentence here. second sentence there.\r\nend\r\n";
    const result = merge(base, base.replace("first", "1st"), base.replace("there", "elsewhere"));
    expect(result.status).toBe("merged");
    if (result.status === "merged") {
      expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(result.bytes)).toBe("\uFEFF1st sentence here. second sentence elsewhere.\r\nend\r\n");
      expect(result.stats.tokenMerges).toBe(1);
      expect(result.bom).toBe(true);
      expect(result.lineEnding).toBe("crlf");
    }
  });

  it("reports how it merged", () => {
    const result = merge("a b c d e\n", "a X c d e\n", "a b c d Y\n");
    expect(result.status === "merged" && result.stats.tokenMerges).toBe(1);
    const insertions = merge("a\n", "a\nx\n", "a\ny\n");
    expect(insertions.status === "merged" && insertions.stats.insertionMerges).toBe(1);
  });

  it("fails closed on regions too large for the word-level budget instead of hanging", () => {
    const words = Array.from({ length: 70_000 }, (_, i) => `w${i}`).join(" ");
    const result = mergeTextThreeWay(b(`${words}\n`), b(`${words} L\n`.replace("w10 ", "x10 ")), b(`${words} R\n`.replace("w20 ", "y20 ")), limits);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(["diff-too-complex", "overlapping-edits"]).toContain(result.reason);
  });
});

// ---- randomized properties ---------------------------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const VOCAB = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "Äpfel", "日本", "x1", "-", "[[Link]]", "**b**"];
function randomDoc(random: () => number, minLines = 1, maxLines = 8): string[] {
  const lines = minLines + Math.floor(random() * (maxLines - minLines + 1));
  return Array.from({ length: lines }, () => Array.from({ length: 1 + Math.floor(random() * 9) }, () => VOCAB[Math.floor(random() * VOCAB.length)]!).join(" "));
}
function mutate(random: () => number, doc: readonly string[]): string[] {
  const out = [...doc];
  for (let edits = 1 + Math.floor(random() * 3); edits > 0; edits -= 1) {
    const kind = Math.floor(random() * 5);
    const line = Math.floor(random() * Math.max(1, out.length));
    const words = (out[line] ?? "").split(" ");
    if (kind === 0 && out.length) { words[Math.floor(random() * words.length)] = `${VOCAB[Math.floor(random() * VOCAB.length)]}!`; out[line] = words.join(" "); }
    else if (kind === 1 && out.length) { words.splice(Math.floor(random() * (words.length + 1)), 0, `new${Math.floor(random() * 99)}`); out[line] = words.join(" "); }
    else if (kind === 2 && out.length > 1) out.splice(line, 1);
    else if (kind === 3) out.splice(Math.floor(random() * (out.length + 1)), 0, `fresh line ${Math.floor(random() * 99)}`);
    else if (out.length && words.length > 1) { words.splice(Math.floor(random() * words.length), 1); out[line] = words.join(" "); }
  }
  return out;
}
const join = (lines: readonly string[]): string => `${lines.join("\n")}\n`;
const wordCounts = (value: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const word of value.split(/\s+/).filter(Boolean)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
};

describe("merge properties over random documents", () => {
  it("is symmetric, idempotent, never loses an inserted word and never throws (6000 random triples)", () => {
    let merges = 0, tokenMerges = 0, insertionMerges = 0, blockedCount = 0;
    for (let seed = 1; seed <= 6000; seed += 1) {
      const random = prng(seed);
      const baseLines = randomDoc(random);
      const base = join(baseLines), local = join(mutate(random, baseLines)), remote = join(mutate(random, baseLines));
      const forward = merge(base, local, remote), backward = merge(base, remote, local);
      expect(forward.status, `seed ${seed}: verdicts differ`).toBe(backward.status);
      if (forward.status === "blocked") { blockedCount += 1; continue; }
      if (backward.status !== "merged") throw new Error("unreachable");
      merges += 1; tokenMerges += forward.stats.tokenMerges ?? 0; insertionMerges += forward.stats.insertionMerges ?? 0;
      const output = dec.decode(forward.bytes);
      expect(output, `seed ${seed}: devices disagree`).toBe(dec.decode(backward.bytes));
      // Every word a side added to the base is in the result at least as often as that side added it.
      const baseCounts = wordCounts(base), outputCounts = wordCounts(output);
      for (const side of [local, remote]) {
        for (const [word, count] of wordCounts(side)) {
          const added = count - (baseCounts.get(word) ?? 0);
          if (added > 0) expect(outputCounts.get(word) ?? 0, `seed ${seed}: lost "${word}"`).toBeGreaterThanOrEqual(added);
        }
      }
      // One side unchanged: the result is the other side, and merging a version with itself changes nothing.
      expect(merged(base, base, local)).toBe(local);
      expect(merged(base, local, base)).toBe(local);
      expect(merged(base, local, local)).toBe(local);
    }
    // The generator must actually exercise the new paths and still produce conflicts.
    expect(merges).toBeGreaterThan(1500);
    expect(tokenMerges).toBeGreaterThan(50);
    expect(insertionMerges).toBeGreaterThan(50);
    expect(blockedCount).toBeGreaterThan(500);
  }, 60_000);

  it("produces exactly the union of edits made at separated positions inside one line (oracle)", () => {
    for (let seed = 1; seed <= 1500; seed += 1) {
      const random = prng(seed * 31);
      const words = Array.from({ length: 12 + Math.floor(random() * 10) }, (_, i) => `w${i}`);
      const localSite = Math.floor(random() * (words.length - 4));
      const remoteSite = localSite + 2 + Math.floor(random() * (words.length - localSite - 2)); // at least one untouched word between
      const edit = (site: number, tag: string): string[] => words.map((word, i) => (i === site ? `${tag}${i}` : word));
      const expected = words.map((word, i) => (i === localSite ? `L${i}` : i === remoteSite ? `R${i}` : word));
      const swapRoles = random() < 0.5;
      const localLine = edit(localSite, "L").join(" "), remoteLine = edit(remoteSite, "R").join(" ");
      const result = both(`top\n${words.join(" ")}\nbottom\n`, `top\n${swapRoles ? remoteLine : localLine}\nbottom\n`, `top\n${swapRoles ? localLine : remoteLine}\nbottom\n`);
      expect(result, `seed ${seed}`).toBe(`top\n${expected.join(" ")}\nbottom\n`);
    }
  });
});
