import { isExcalidrawPath, mergeExcalidrawThreeWay, mergeExcalidrawTwoWay } from "./excalidraw-merge";
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

/** Merge without a common ancestor; only drawings support it (their elements carry their own versions). */
export function mergeFileTwoWay(path: string, local: ArrayBuffer, remote: ArrayBuffer, limits: TextMergeLimits): TextMergeResult {
  if (!isExcalidrawPath(path)) {
    return { status: "blocked", reason: "overlapping-edits", message: "Without a common ancestor only drawings can be merged automatically." };
  }
  return mergeExcalidrawTwoWay(path, local, remote, limits);
}
