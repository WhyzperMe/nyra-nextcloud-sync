import { describe, expect, it } from "vitest";
import { mergeTextThreeWay } from "../src/merge/text-merge";

const enc = new TextEncoder();
const dec = new TextDecoder();
const limits = { maxInputBytes: 2 * 1024 * 1024, maxLines: 12_000, maxDiffCells: 8_000_000 };
const b = (value: string): ArrayBuffer => enc.encode(value).buffer;

function text(result: ReturnType<typeof mergeTextThreeWay>): string {
  if (result.status !== "merged") throw new Error(`${result.reason}: ${result.message}`);
  return dec.decode(result.bytes);
}

describe("Bounded three-way text merge regression", () => {
  it("merges non-overlapping edits from both devices", () => {
    const result = mergeTextThreeWay(b("A\nB\nC\nD\n"), b("A\nLOCAL\nC\nD\n"), b("A\nB\nC\nREMOTE\n"), limits);
    expect(result.status).toBe("merged");
    expect(text(result)).toBe("A\nLOCAL\nC\nREMOTE\n");
  });

  it("deduplicates identical edits", () => {
    const result = mergeTextThreeWay(b("A\nB\n"), b("A\nX\n"), b("A\nX\n"), limits);
    expect(text(result)).toBe("A\nX\n");
  });

  it("blocks overlapping edits instead of emitting conflict markers", () => {
    const result = mergeTextThreeWay(b("A\nB\n"), b("A\nLOCAL\n"), b("A\nREMOTE\n"), limits);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.reason).toBe("overlapping-edits");
  });

  it("blocks competing insertions at the same logical position", () => {
    const result = mergeTextThreeWay(b("A\nB\n"), b("A\nL\nB\n"), b("A\nR\nB\n"), limits);
    expect(result.status).toBe("blocked");
  });

  it("combines independent adjacent replacements and a boundary insert with a deletion", () => {
    const adjacent = mergeTextThreeWay(
      b("A\nB\nC\nD\n"),
      b("A\nLOCAL\nC\nD\n"),
      b("A\nB\nREMOTE\nD\n"),
      limits
    );
    expect(text(adjacent)).toBe("A\nLOCAL\nREMOTE\nD\n");

    const deleteAndInsert = mergeTextThreeWay(
      b("A\nB\nC\n"),
      b("A\nC\n"),
      b("A\nB\nINSERTED\nC\n"),
      limits
    );
    expect(text(deleteAndInsert)).toBe("A\nINSERTED\nC\n");
  });

  it("blocks an insertion inside a region deleted by the other side", () => {
    const result = mergeTextThreeWay(
      b("A\nB\nC\nD\n"),
      b("A\nD\n"),
      b("A\nB\nINSERTED\nC\nD\n"),
      limits
    );
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.reason).toBe("overlapping-edits");
  });

  it("rejects invalid UTF-8, NUL bytes, and mixed line endings", () => {
    const invalid = new Uint8Array([0xff]).buffer;
    expect(mergeTextThreeWay(b("A"), invalid, b("A"), limits).status).toBe("blocked");
    expect(mergeTextThreeWay(b("A"), new Uint8Array([65, 0, 66]).buffer, b("A"), limits).status).toBe("blocked");
    const mixed = b("A\r\nB\n");
    expect(mergeTextThreeWay(mixed, mixed, mixed, limits).status).toBe("blocked");
  });

  it("preserves CRLF/BOM metadata when only one side changes content", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const withBom = (value: string) => {
      const body = enc.encode(value); const out = new Uint8Array(bom.length + body.length); out.set(bom); out.set(body, bom.length); return out.buffer;
    };
    const result = mergeTextThreeWay(withBom("A\r\nB\r\n"), withBom("A\r\nLOCAL\r\n"), withBom("A\r\nB\r\n"), limits);
    expect(result.status).toBe("merged");
    if (result.status === "merged") {
      expect(result.bom).toBe(true);
      expect(result.lineEnding).toBe("crlf");
      const bytes = new Uint8Array(result.bytes);
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(dec.decode(bytes.slice(3))).toBe("A\r\nLOCAL\r\n");
    }
  });

  it("preserves CRLF and BOM across independent edits and supports empty and Unicode notes", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const withBom = (value: string) => {
      const body = enc.encode(value); const out = new Uint8Array(bom.length + body.length); out.set(bom); out.set(body, bom.length); return out.buffer;
    };
    const independent = mergeTextThreeWay(
      withBom("A\r\nB\r\nC\r\n"),
      withBom("A-local\r\nB\r\nC\r\n"),
      withBom("A\r\nB\r\nC-remote\r\n"),
      limits
    );
    expect(independent.status).toBe("merged");
    if (independent.status === "merged") {
      expect(independent.bom).toBe(true);
      expect(independent.lineEnding).toBe("crlf");
      expect(dec.decode(new Uint8Array(independent.bytes).subarray(3))).toBe("A-local\r\nB\r\nC-remote\r\n");
    }

    expect(text(mergeTextThreeWay(b(""), b("phone 📱\n"), b(""), limits))).toBe("phone 📱\n");
    expect(text(mergeTextThreeWay(b("朝\n昼\n夜\n"), b("朝\n昼\n夜 🚀\n"), b("朝 🌅\n昼\n夜\n"), limits)))
      .toBe("朝 🌅\n昼\n夜 🚀\n");
  });

  it("is symmetric for independent edits", () => {
    const base = b("A\nB\nC\nD\n");
    const left = b("A\nL\nC\nD\n");
    const right = b("A\nB\nC\nR\n");
    expect(text(mergeTextThreeWay(base, left, right, limits))).toBe(text(mergeTextThreeWay(base, right, left, limits)));
  });

  it("fails closed when configured complexity budgets are exceeded", () => {
    expect(mergeTextThreeWay(b("A\nB\n"), b("A\nB\n"), b("A\nB\n"), { ...limits, maxDiffCells: 1 }).status).toBe("blocked");
    expect(mergeTextThreeWay(b("012345"), b("012345"), b("012345"), { ...limits, maxInputBytes: 2 }).status).toBe("blocked");
    expect(mergeTextThreeWay(b("A\nB\nC\n"), b("A\nB\nC\n"), b("A\nB\nC\n"), { ...limits, maxLines: 2 }).status).toBe("blocked");
  });

  it("accepts exact byte and line budget boundaries without allocating a large fixture", () => {
    const exactByteLimit = mergeTextThreeWay(b("A"), b("A"), b("A"), { ...limits, maxInputBytes: 1 });
    expect(exactByteLimit.status).toBe("merged");
    const exactLineLimit = mergeTextThreeWay(b("A"), b("A"), b("A"), { ...limits, maxLines: 1 });
    expect(exactLineLimit.status).toBe("merged");
    const combining = mergeTextThreeWay(b("cafe\u0301\nkeep\n"), b("cafe\u0301\nLOCAL\n"), b("CAFÉ\nkeep\n"), limits);
    expect(text(combining)).toBe("CAFÉ\nLOCAL\n");
  });
});
