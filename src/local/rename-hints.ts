import type { LocalRenameHint } from "./types";

/** Coalesces authoritative rename chains (A→B, B→C => A→C) without inventing identity. */
export function coalesceExactRenames(hints: readonly LocalRenameHint[]): LocalRenameHint[] {
  const result: LocalRenameHint[] = [];
  for (const hint of hints) {
    if (hint.confidence !== "exact") continue;
    const predecessor = result.find((candidate) => candidate.newPath === hint.oldPath && candidate.kind === hint.kind);
    if (predecessor) {
      predecessor.newPath = hint.newPath;
      continue;
    }
    result.push({ ...hint });
  }
  return result.filter((hint) => hint.oldPath !== hint.newPath);
}
