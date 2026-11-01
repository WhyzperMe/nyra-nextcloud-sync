import { isExcalidrawPath, mergeExcalidrawThreeWay } from "./excalidraw-merge";
import { mergeTextThreeWay } from "./text-merge";
import type { TextMergeLimits, TextMergeResult } from "./types";

/**
 * Chooses the merge engine for a file. Excalidraw drawings are merged semantically; their compressed
 * data is never line-merged, because a textual merge of two compressed streams can produce a corrupt drawing.
 */
export function mergeFileThreeWay(path: string, base: ArrayBuffer, local: ArrayBuffer, remote: ArrayBuffer, limits: TextMergeLimits): TextMergeResult {
  return isExcalidrawPath(path)
    ? mergeExcalidrawThreeWay(path, base, local, remote, limits)
    : mergeTextThreeWay(base, local, remote, limits);
}
