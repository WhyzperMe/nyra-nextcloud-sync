import { Notice } from "obsidian";
import { errorMessage } from "../core/errors";
import type { SyncPlanItem } from "../planner/types";
import type NyraNextcloudSyncPlugin from "../main";
import type { SyncConflictReview } from "../main";
import { formatBytes } from "./format";
import { ConflictDiffModal } from "./conflict-diff-modal";
import { humanDisposition } from "./settings-text";
import { plural } from "../core/plural";

export function conflictReview(conflict: SyncConflictReview, owner: NyraNextcloudSyncPlugin, refresh: () => void): HTMLElement {
  const details = document.createElement("details");
  details.className = "nyra-nc-conflict-review";
  details.dataset.nyraStateKey = `conflict:${conflict.entryId}`;
  const summary = document.createElement("summary");
  summary.dataset.nyraFocusKey = `conflict:${conflict.entryId}:summary`;
  summary.textContent = `${conflict.path} · ${conflict.reasons[0] ?? "Changes need review"}`;
  details.appendChild(summary);
  const grid = document.createElement("div");
  grid.className = "nyra-nc-conflict-review__grid";
  grid.append(
    replicaReviewCard("LOCAL", conflict.local ? {
      path: conflict.local.path, hash: conflict.local.sha256, size: conflict.local.size,
      time: `Modified ${metadataTime(conflict.local.mtimeMs)}`
    } : null),
    replicaReviewCard("BASE", conflict.base ? {
      path: conflict.base.path, hash: conflict.base.sha256, size: conflict.base.size,
      time: `Captured ${conflict.base.createdAt}`
    } : null),
    replicaReviewCard("REMOTE", conflict.remote ? {
      path: conflict.remote.path, hash: conflict.remote.sha256, size: conflict.remote.size,
      time: conflict.remote.mtimeMs === null ? "Modified time unavailable" : `Modified ${metadataTime(conflict.remote.mtimeMs)}`,
      identity: `fileId ${conflict.remote.fileId ?? "unavailable"} · ETag ${conflict.remote.etag ?? "unavailable"}`
    } : null)
  );
  details.appendChild(grid);
  const winnerEligible = conflict.local && conflict.remote && conflict.remote.sha256 && conflict.remote.fileId && conflict.remote.etag &&
    conflict.local.path === conflict.remote.path && (conflict.classification === "both-change" || conflict.classification === "concurrent-create");
  const mergeRetryEligible = conflict.classification === "both-change" && conflict.local && conflict.remote &&
    conflict.remote.sha256 && conflict.remote.fileId && conflict.remote.etag;
  const comparable = conflict.local && conflict.remote && conflict.remote.fileId && conflict.remote.etag;
  if (winnerEligible || mergeRetryEligible || comparable) {
    const actions = document.createElement("div");
    actions.className = "nyra-nc-conflict-actions";
    if (comparable) {
      const compare = conflictAction("Compare", () => {
        const choices: Array<{ label: string; run: () => void }> = [];
        if (winnerEligible) {
          choices.push({ label: "Keep local", run: () => runConflictChoice(owner, conflict.entryId, "keep-local", refresh) });
          choices.push({ label: "Keep remote", run: () => runConflictChoice(owner, conflict.entryId, "keep-remote", refresh) });
          choices.push({ label: "Keep both", run: () => runConflictChoice(owner, conflict.entryId, "keep-both", refresh) });
        }
        new ConflictDiffModal(owner.app, owner, conflict.entryId, conflict.path, choices).open();
      });
      compare.dataset.nyraFocusKey = `conflict:${conflict.entryId}:compare`;
      actions.appendChild(compare);
    }
    if (winnerEligible) {
      const keepLocal = conflictAction("Keep local", () => runConflictChoice(owner, conflict.entryId, "keep-local", refresh));
      keepLocal.dataset.nyraFocusKey = `conflict:${conflict.entryId}:keep-local`;
      const keepRemote = conflictAction("Keep remote", () => runConflictChoice(owner, conflict.entryId, "keep-remote", refresh));
      keepRemote.dataset.nyraFocusKey = `conflict:${conflict.entryId}:keep-remote`;
      const keepBoth = conflictAction("Keep both", () => runConflictChoice(owner, conflict.entryId, "keep-both", refresh));
      keepBoth.dataset.nyraFocusKey = `conflict:${conflict.entryId}:keep-both`;
      actions.append(keepLocal, keepRemote, keepBoth);
    }
    if (mergeRetryEligible) {
      const retryMerge = conflictAction("Retry safe merge", () => runConflictChoice(owner, conflict.entryId, "retry-safe-merge", refresh));
      retryMerge.dataset.nyraFocusKey = `conflict:${conflict.entryId}:retry-merge`;
      actions.appendChild(retryMerge);
    }
    details.appendChild(actions);
    if (winnerEligible) {
      const actionNote = document.createElement("p");
      actionNote.className = "nyra-nc-review-note";
      actionNote.textContent = "Keep-side choices first create and verify a visible conflict copy of the displaced version. The original is changed only afterward with fresh hash and ETag checks.";
      details.appendChild(actionNote);
    }
  }
  return details;
}

export function conflictAction(label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", run);
  return button;
}

export function runConflictChoice(owner: NyraNextcloudSyncPlugin, entryId: string, choice: "keep-local" | "keep-remote" | "keep-both" | "retry-safe-merge", refresh: () => void): void {
  void owner.resolveConflict(entryId, choice).then((report) => {
    if (choice === "keep-both") new Notice("Both versions were preserved as separate local copies. The original remains unchanged for review.");
    else if (choice === "retry-safe-merge") new Notice("Safe merge retried; overlapping changes that remain are still blocked.");
    else new Notice(`${choice === "keep-local" ? "LOCAL" : "REMOTE"} version selected · ${plural(report?.completed ?? 0, "step")}.`);
    refresh();
  }).catch((error: unknown) => new Notice(`Conflict resolution paused: ${errorMessage(error)}`, 12_000));
}

export function replicaReviewCard(label: string, replica: { path: string; hash: string | null; size: number; time: string; identity?: string } | null): HTMLElement {
  const card = document.createElement("section");
  card.className = "nyra-nc-conflict-version";
  const heading = document.createElement("h4"); heading.textContent = label; card.appendChild(heading);
  if (!replica) {
    const absent = document.createElement("span"); absent.textContent = "No version present"; card.appendChild(absent); return card;
  }
  for (const value of [replica.path, replica.hash ? `SHA-256 ${replica.hash}` : "Content hash not verified", formatBytes(replica.size), replica.time, replica.identity]) {
    if (!value) continue;
    const line = document.createElement("span"); line.textContent = value; card.appendChild(line);
  }
  return card;
}

export function metadataTime(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toLocaleString()} (metadata only)` : "metadata unavailable";
}

export function planRow(entry: SyncPlanItem): HTMLElement {
  const details = document.createElement("details"); details.className = `nyra-nc-plan-row nyra-nc-plan-row--${entry.disposition}`;
  details.dataset.nyraStateKey = `plan:${entry.entryId}`;
  const summary = document.createElement("summary");
  summary.dataset.nyraFocusKey = `plan:${entry.entryId}:summary`;
  const path = document.createElement("span"); path.className = "nyra-nc-plan-row__path"; path.textContent = entry.displayPath;
  const tag = document.createElement("span"); tag.className = "nyra-nc-plan-row__tag"; tag.textContent = humanDisposition(entry.disposition);
  summary.append(path, tag); details.appendChild(summary);
  const body = document.createElement("div"); body.className = "nyra-nc-plan-row__body";
  const classification = document.createElement("div"); classification.className = "nyra-nc-plan-row__class"; classification.textContent = entry.classification.replaceAll("-", " ");
  body.appendChild(classification);
  const reasons = document.createElement("ul");
  for (const reason of entry.reasons) { const li = document.createElement("li"); li.textContent = reason; reasons.appendChild(li); }
  body.appendChild(reasons);
  if (entry.steps.length) { const steps = document.createElement("ol"); steps.className = "nyra-nc-plan-steps"; for (const planned of entry.steps) { const li=document.createElement("li"); li.textContent=planned.description; steps.appendChild(li); } body.appendChild(steps); }
  details.appendChild(body); return details;
}
