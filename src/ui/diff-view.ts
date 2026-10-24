import { diffLines, foldContext, splitLines } from "../merge/line-diff";
import { plural } from "../core/plural";

/** Renders a unified line diff (changed lines with a few lines of context) into `container`. */
export function renderDiff(container: HTMLElement, before: string, after: string): void {
  container.empty();
  const diff = diffLines(splitLines(before), splitLines(after));
  const summary = container.createDiv({ cls: "nyra-nc-diff__summary" });
  if (before === after) { summary.setText("The two versions are identical."); return; }
  summary.setText(diff.complete ? `${plural(diff.added, "line")} added, ${diff.removed} removed` : "The versions differ too much for a line comparison; showing everything as replaced.");
  const body = container.createDiv({ cls: "nyra-nc-diff" });
  const shown = diff.complete ? foldContext(diff.lines, 3) : diff.lines.slice(0, 400);
  for (const entry of shown) {
    if (entry.kind === "skip") {
      body.createDiv({ cls: "nyra-nc-diff__line nyra-nc-diff__line--skip", text: `⋯ ${plural(entry.count, "unchanged line")}` });
      continue;
    }
    const prefix = entry.kind === "add" ? "+ " : entry.kind === "remove" ? "- " : "  ";
    body.createDiv({ cls: `nyra-nc-diff__line nyra-nc-diff__line--${entry.kind}`, text: prefix + entry.text });
  }
  if (!diff.complete && diff.lines.length > shown.length) body.createDiv({ cls: "nyra-nc-diff__line nyra-nc-diff__line--skip", text: `⋯ ${plural(diff.lines.length - shown.length, "more line")}` });
}
