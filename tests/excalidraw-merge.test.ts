import { describe, expect, it } from "vitest";
import { isExcalidrawPath, mergeExcalidrawThreeWay } from "../src/merge/excalidraw-merge";
import { mergeFileThreeWay } from "../src/merge/merge-dispatch";
import { compressToBase64, decompressFromBase64 } from "../src/merge/lz-string";
import type { TextMergeLimits } from "../src/merge/types";

const limits: TextMergeLimits = { maxInputBytes: 16 * 1024 * 1024, maxLines: 250_000, maxDiffCells: 64_000_000 };
const enc = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const dec = (bytes: ArrayBuffer): string => new TextDecoder().decode(bytes);

type El = { id: string; type: string; index: string; version: number; versionNonce: number; isDeleted: boolean; x: number; y: number; points?: number[][] };
const el = (id: string, index: string, over: Partial<El> = {}): El => ({ id, type: "freedraw", index, version: 1, versionNonce: 100, isDeleted: false, x: 0, y: 0, ...over });
const scene = (elements: El[], appState: Record<string, unknown> = { theme: "dark", scrollX: 0 }, files: Record<string, unknown> = {}) =>
  ({ type: "excalidraw", version: 2, source: "https://example.test/plugin/2.29.1", elements, appState, files });

function file(drawing: unknown, head = "---\n\nexcalidraw-plugin: parsed\n\n---\n\n# Excalidraw Data\n\n## Text Elements\n%%\n## Drawing\n"): ArrayBuffer {
  const packed = compressToBase64(JSON.stringify(drawing, null, "\t"));
  const lines = packed.match(/.{1,256}/gs) ?? [];
  return enc(`${head}\`\`\`compressed-json\n${lines.join("\n")}\n\`\`\`\n%%`);
}
function readScene(bytes: ArrayBuffer): { elements: El[]; appState: Record<string, unknown>; files: Record<string, unknown> } {
  const text = dec(bytes);
  const body = /```compressed-json\n([\s\S]*?)\n```/.exec(text)![1]!.replace(/\n/g, "");
  return JSON.parse(decompressFromBase64(body)!);
}
function merge(base: unknown, local: unknown, remote: unknown, limit = limits) {
  return mergeExcalidrawThreeWay("Maths/Graph.excalidraw.md", file(base), file(local), file(remote), limit);
}

describe("LZ-string codec", () => {
  it("is bit-compatible with the library Excalidraw uses (prefix taken from a real drawing)", () => {
    const prefix = "{\n\t\"type\": \"excalidraw\",\n\t\"version\": 2,\n\t\"source\": \"https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.29.1\",\n\t\"elements\": [\n\t\t{\n\t\t\t\"id\": \"bGVdTOpwC_lmly1-xzMn0\",\n\t\t\t\"type\": \"freedraw\",\n\t\t\t\"x\": -93.90751381786609,\n\t\t\t\"y\": -436.14274385800843,\n\t\t\t\"width\": 20.43193725260585,\n\t\t\t\"height\": 35.98460590757446,\n\t\t\t\"";
    const real = "N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqATLZMzYBXUtiRoIACyhQ4zZAHoFAc0JRJQgEYA6bGwC2CgF7N6hbEcK4OCtptbErHALRY8RMpWdx8Q1TdIEfARcZgRmBShcZQUe";
    expect(compressToBase64(prefix).startsWith(real)).toBe(true);
  });

  it("round-trips empty, ASCII, unicode, surrogate pairs and long repetitive input", () => {
    for (const sample of ["", "a", "hello hello hello", "Ünïcödé — 日本語 🙂 \u0000 ÿ ￿", "x".repeat(100_000), JSON.stringify({ a: [1, 2, 3], b: "é".repeat(500) })]) {
      expect(decompressFromBase64(compressToBase64(sample))).toBe(sample);
    }
    let seed = 12345;
    const random = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let round = 0; round < 25; round += 1) {
      const sample = Array.from({ length: 1 + (random() % 4000) }, () => String.fromCharCode(random() % (round % 2 === 0 ? 128 : 65536))).join("");
      expect(decompressFromBase64(compressToBase64(sample))).toBe(sample);
    }
  });

  it("rejects garbage instead of looping", () => {
    expect(decompressFromBase64("")).toBeNull();
    expect(decompressFromBase64("!!!!")).not.toBe("anything");
  });
});

describe("Excalidraw semantic merge", () => {
  it("is recognised by file name", () => {
    expect(isExcalidrawPath("A/B.excalidraw.md")).toBe(true);
    expect(isExcalidrawPath("B.excalidraw")).toBe(true);
    expect(isExcalidrawPath("B.md")).toBe(false);
  });

  it("keeps strokes drawn on both devices, ordered by Excalidraw's fractional index", () => {
    const base = scene([el("a", "a0"), el("b", "a1")]);
    const local = scene([el("a", "a0"), el("l1", "a05"), el("b", "a1"), el("l2", "a2")]);
    const remote = scene([el("a", "a0"), el("b", "a1"), el("r1", "a1V")]);
    const result = merge(base, local, remote);
    expect(result.status).toBe("merged");
    if (result.status !== "merged") return;
    expect(readScene(result.bytes).elements.map((item) => item.id)).toEqual(["a", "l1", "b", "r1", "l2"]);
  });

  it("applies independent edits of different elements from both sides", () => {
    const base = scene([el("a", "a0"), el("b", "a1")]);
    const local = scene([el("a", "a0", { version: 2, versionNonce: 5, x: 50 }), el("b", "a1")]);
    const remote = scene([el("a", "a0"), el("b", "a1", { version: 3, versionNonce: 6, y: 70 })]);
    const result = merge(base, local, remote);
    if (result.status !== "merged") throw new Error("blocked");
    const merged = readScene(result.bytes).elements;
    expect(merged.find((item) => item.id === "a")?.x).toBe(50);
    expect(merged.find((item) => item.id === "b")?.y).toBe(70);
    expect(result.stats.localHunks).toBe(1);
    expect(result.stats.remoteHunks).toBe(1);
  });

  it("settles an element both devices changed like Excalidraw does and gives both devices the same drawing", () => {
    const base = scene([el("a", "a0")]);
    const mine = scene([el("a", "a0", { version: 4, versionNonce: 9, x: 1 })]);
    const theirs = scene([el("a", "a0", { version: 6, versionNonce: 2, x: 2 })]);
    const onMyDevice = merge(base, mine, theirs);
    const onTheirDevice = merge(base, theirs, mine);
    if (onMyDevice.status !== "merged" || onTheirDevice.status !== "merged") throw new Error("blocked");
    expect(readScene(onMyDevice.bytes).elements[0]?.x).toBe(2);
    expect(dec(onMyDevice.bytes)).toBe(dec(onTheirDevice.bytes));
    // Equal versions fall back to the lower versionNonce.
    const tieMine = scene([el("a", "a0", { version: 5, versionNonce: 9, x: 1 })]);
    const tieTheirs = scene([el("a", "a0", { version: 5, versionNonce: 2, x: 2 })]);
    const tie = merge(base, tieMine, tieTheirs);
    if (tie.status !== "merged") throw new Error("blocked");
    expect(readScene(tie.bytes).elements[0]?.x).toBe(2);
  });

  it("lets a change beat a deletion and removes an element the other side left untouched", () => {
    const base = scene([el("keep", "a0"), el("gone", "a1"), el("edited", "a2")]);
    const local = scene([el("keep", "a0"), el("edited", "a2", { version: 2, versionNonce: 3, x: 9 })]); // deleted "gone", edited "edited"
    const remote = scene([el("keep", "a0"), el("gone", "a1"), el("edited", "a2")]);
    const removed = merge(base, local, remote);
    if (removed.status !== "merged") throw new Error("blocked");
    expect(readScene(removed.bytes).elements.map((item) => item.id)).toEqual(["keep", "edited"]);

    const remote2 = scene([el("keep", "a0"), el("gone", "a1", { version: 2, versionNonce: 4, x: 3 }), el("edited", "a2")]);
    const kept = merge(base, local, remote2);
    if (kept.status !== "merged") throw new Error("blocked");
    expect(readScene(kept.bytes).elements.map((item) => item.id)).toEqual(["keep", "gone", "edited"]);
  });

  it("merges app state per key and unions embedded files", () => {
    const base = scene([el("a", "a0")], { theme: "dark", viewBackgroundColor: "#fff", scrollX: 0 }, { f1: { id: "f1", created: 1 } });
    const local = scene([el("a", "a0")], { theme: "light", viewBackgroundColor: "#fff", scrollX: 0 }, { f1: { id: "f1", created: 1 }, f2: { id: "f2", created: 2 } });
    const remote = scene([el("a", "a0")], { theme: "dark", viewBackgroundColor: "#000", scrollX: 0 }, { f1: { id: "f1", created: 1 }, f3: { id: "f3", created: 3 } });
    const result = merge(base, local, remote);
    if (result.status !== "merged") throw new Error("blocked");
    const merged = readScene(result.bytes);
    expect(merged.appState).toMatchObject({ theme: "light", viewBackgroundColor: "#000" });
    expect(Object.keys(merged.files).sort()).toEqual(["f1", "f2", "f3"]);
  });

  it("writes the same bytes the plugin would for an unchanged drawing", () => {
    const drawing = scene([el("a", "a0"), el("b", "a1")]);
    const original = file(drawing);
    const result = mergeExcalidrawThreeWay("X.excalidraw.md", original, original, original, limits);
    if (result.status !== "merged") throw new Error("blocked");
    expect(dec(result.bytes)).toBe(dec(original));
  });

  it("merges the Markdown around the drawing (text elements) with the text engine", () => {
    const base = scene([el("a", "a0")]);
    const head = (text: string): string => `---\n\nexcalidraw-plugin: parsed\n\n---\n\n# Excalidraw Data\n\n## Text Elements\n${text}%%\n## Drawing\n`;
    const result = mergeExcalidrawThreeWay(
      "T.excalidraw.md",
      file(base, head("one ^a1\n\ntwo ^a2\n\nthree ^a3\n\n")),
      file(base, head("ONE ^a1\n\ntwo ^a2\n\nthree ^a3\n\n")),
      file(base, head("one ^a1\n\ntwo ^a2\n\nTHREE ^a3\n\n")),
      limits
    );
    if (result.status !== "merged") throw new Error("blocked");
    expect(dec(result.bytes)).toContain("ONE ^a1\n\ntwo ^a2\n\nTHREE ^a3");
  });

  it("merges a drawing larger than the old 2 MiB limit and stays within the configured budget", () => {
    const strokes = (prefix: string, count: number, from = 0): El[] => Array.from({ length: count }, (_, i) =>
      el(`${prefix}${i}`, `a${String(from + i).padStart(6, "0")}`, { points: Array.from({ length: 30 }, (_p, k) => [k * 1.37 + i * 0.011, Math.sin(k + i) * 41.3]) }));
    const common = strokes("s", 5000);
    const base = scene(common);
    const local = scene([...common, ...strokes("l", 400, 5000)]);
    const remote = scene([...common, ...strokes("r", 400, 9000)]);
    const baseBytes = file(base);
    expect(baseBytes.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    const started = Date.now();
    const result = mergeExcalidrawThreeWay("Big.excalidraw.md", baseBytes, file(local), file(remote), limits);
    if (result.status !== "merged") throw new Error(`blocked: ${result.message}`);
    expect(readScene(result.bytes).elements.length).toBe(5800);
    expect(Date.now() - started).toBeLessThan(30_000);
    const tight = mergeExcalidrawThreeWay("Big.excalidraw.md", baseBytes, file(local), file(remote), { ...limits, maxInputBytes: 2 * 1024 * 1024 });
    expect(tight.status === "blocked" && tight.reason).toBe("input-too-large");
  }, 60_000);

  it("never falls back to a line merge of compressed data", () => {
    const broken = enc("# not a drawing\n```compressed-json\n!!!notvalid!!!\n```\n");
    const result = mergeFileThreeWay("Broken.excalidraw.md", broken, broken, file(scene([el("a", "a0")])), limits);
    expect(result.status === "blocked" && result.reason).toBe("excalidraw-unparseable");
    const noBlock = mergeFileThreeWay("Plain.excalidraw.md", enc("just text"), enc("just text!"), enc("just text"), limits);
    expect(noBlock.status === "blocked" && noBlock.reason).toBe("excalidraw-unparseable");
  });

  it("sends ordinary notes to the text merger", () => {
    const result = mergeFileThreeWay("Notes/A.md", enc("a\nb\nc\n"), enc("A\nb\nc\n"), enc("a\nb\nC\n"), limits);
    expect(result.status === "merged" && dec(result.bytes)).toBe("A\nb\nC\n");
  });
});

describe("large text merge", () => {
  it("merges edits in distant places of a 200,000-line note quickly", () => {
    const lines = Array.from({ length: 200_000 }, (_, i) => `line ${i} with some ordinary words in it`);
    const local = [...lines]; local[1000] = "LOCAL EDIT";
    const remote = [...lines]; remote[190_000] = "REMOTE EDIT";
    const started = Date.now();
    const result = mergeFileThreeWay("Notes/Huge.md", enc(lines.join("\n")), enc(local.join("\n")), enc(remote.join("\n")), limits);
    expect(result.status).toBe("merged");
    if (result.status !== "merged") return;
    const merged = dec(result.bytes).split("\n");
    expect(merged[1000]).toBe("LOCAL EDIT");
    expect(merged[190_000]).toBe("REMOTE EDIT");
    expect(merged.length).toBe(200_000);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);
});

describe("Excalidraw merge without a common ancestor", async () => {
  const { mergeExcalidrawTwoWay } = await import("../src/merge/excalidraw-merge");
  const { mergeFileTwoWay } = await import("../src/merge/merge-dispatch");
  const path = "Schule/Physik.excalidraw.md";

  it("keeps every stroke of two independently created copies and lets the newer element version win", () => {
    const restored = file(scene([el("a", "a0", { version: 3, x: 10 }), el("b", "a1")]));
    const live = file(scene([el("a", "a0", { version: 5, x: 99 }), el("c", "a2")], { theme: "light", scrollX: 4 }));
    const result = mergeExcalidrawTwoWay(path, restored, live, limits);
    expect(result.status).toBe("merged");
    if (result.status !== "merged") return;
    const merged = readScene(result.bytes);
    expect(merged.elements.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(merged.elements[0]).toMatchObject({ version: 5, x: 99 });
  });

  it("gives every device the same bytes no matter which copy it calls local", () => {
    const one = file(scene([el("a", "a0", { version: 2, x: 1 }), el("l", "a1")], { theme: "dark" }), "---\nexcalidraw-plugin: parsed\n---\n## Text Elements\nfoo ^1\n%%\n## Drawing\n");
    const two = file(scene([el("a", "a0", { version: 2, x: 2 }), el("r", "a2")], { theme: "light" }), "---\nexcalidraw-plugin: parsed\n---\n## Text Elements\nbar ^2\n%%\n## Drawing\n");
    const forward = mergeExcalidrawTwoWay(path, one, two, limits);
    const backward = mergeExcalidrawTwoWay(path, two, one, limits);
    expect(forward.status).toBe("merged");
    expect(backward.status).toBe("merged");
    if (forward.status === "merged" && backward.status === "merged") expect(dec(forward.bytes)).toBe(dec(backward.bytes));
  });

  it("is idempotent for identical copies and refuses what is not a drawing", () => {
    const same = file(scene([el("a", "a0")]));
    const result = mergeExcalidrawTwoWay(path, same, same, limits);
    expect(result.status).toBe("merged");
    if (result.status === "merged") expect(readScene(result.bytes).elements.map((item) => item.id)).toEqual(["a"]);
    expect(mergeFileTwoWay("Notes/A.md", enc("a"), enc("b"), limits).status).toBe("blocked");
    expect(mergeExcalidrawTwoWay(path, enc("garbage"), same, limits).status).toBe("blocked");
  });
});
