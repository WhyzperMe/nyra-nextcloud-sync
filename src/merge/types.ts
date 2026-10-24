export type TextLineEnding = "none" | "lf" | "crlf" | "cr" | "mixed";

export interface TextMergeLimits {
  /** Maximum size of each BASE/LOCAL/REMOTE input considered for automatic merge. */
  maxInputBytes: number;
  /** Maximum line count per input. */
  maxLines: number;
  /** Maximum BASE×variant cells evaluated by each exact LCS diff. */
  maxDiffCells: number;
}

export interface TextMergeStats {
  baseLines: number;
  localLines: number;
  remoteLines: number;
  localHunks: number;
  remoteHunks: number;
  outputBytes: number;
}

export type TextMergeBlockedReason =
  | "input-too-large"
  | "too-many-lines"
  | "diff-too-complex"
  | "invalid-utf8"
  | "binary-content"
  | "mixed-line-endings"
  | "metadata-conflict"
  | "overlapping-edits";

export interface TextMergeSuccess {
  status: "merged";
  bytes: ArrayBuffer;
  lineEnding: Exclude<TextLineEnding, "mixed">;
  bom: boolean;
  stats: TextMergeStats;
}

export interface TextMergeBlocked {
  status: "blocked";
  reason: TextMergeBlockedReason;
  message: string;
}

export type TextMergeResult = TextMergeSuccess | TextMergeBlocked;
