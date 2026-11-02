# Automatic conflict resolution

What Nyra does on its own when two devices changed the same note, and what it deliberately leaves alone. The goal is the order *merge if both edits can be combined without loss → otherwise keep one version at the path and preserve the other → never silently drop content*.

## 1. Merge first (`src/merge/text-merge.ts`)

For text files with a common ancestor, the three versions (BASE, LOCAL, REMOTE) are merged without conflict markers:

| Situation | Result |
| --- | --- |
| Edits to different lines | both applied |
| Edits to different parts of one long line (typical Obsidian paragraph) | both applied, **if at least one unchanged word or punctuation mark lies between them** |
| Both devices appended or inserted lines at the same spot | both kept; the order depends only on the inserted text, so both devices compute identical bytes. If one insertion already contains the other it is not repeated |
| Both made the identical edit | applied once |
| Both rewrote the same words, one edited what the other deleted, edits separated by blanks only, two different insertions at the same word position | **blocked**, handled by section 2 |
| Binary or invalid UTF-8, mixed line endings, different BOM/EOL changes on both sides, files over the size/line/diff budgets | **blocked** |

Guarantees checked by the tests (`tests/text-merge-advanced.test.ts`, 6000 random documents plus an oracle for separated word edits, and three deliberate-defect mutants that must fail the tests):

- **Symmetry:** merging with LOCAL/REMOTE swapped gives the same verdict and the same bytes. Two devices merging at the same time therefore cannot create new conflicts for each other.
- **Idempotence:** merging with an unchanged side returns the other side; merging a version with itself changes nothing.
- **No loss:** every word a side added appears in the result at least as often as it was added.
- **Bounded:** word-level work shares a 16 M-cell budget per merge and at most 50 000 tokens per region; beyond that the merge is blocked as `diff-too-complex`.

Limits: the word-level step compares words and punctuation, not meaning. Two edits that are textually separate can still contradict each other (for example one device negates a sentence and the other edits a clause that depends on it). The one-word separation rule reduces, but cannot remove, that risk, and the merged text should be glanced at like any merge.

## 2. Decide which version stays (`src/planner/auto-resolution.ts`)

If a merge is blocked (or there is no ancestor), one version stays at the path and the other is first preserved as a *conflict copy* (a normal note that syncs everywhere):

1. An **empty file never replaces content**, whichever side is newer.
2. Otherwise the **clearly newer** modification time wins (difference above 2 s). A time more than 24 h in the future of this device's clock is not trusted (wrong clock, touched file).
3. Otherwise a **deterministic content tie-break** (larger SHA-256) so that both devices choose the same winner.
4. Deleted on one side, changed on the other: **the change wins** and the file is restored.
5. Renamed differently on both sides: the **Nextcloud name** wins.

Every decision is logged with its `basis` (`non-empty-content`, `newer-modification`, `content-tiebreak`, `change-beats-delete`, `remote-name`) and shown in the activity list.

Known limits: modification times come from the device that wrote the file, so a device with a wrong but plausible clock can win a conflict it should not have. The loser is never lost (conflict copy), only moved. Each resolution re-scans both sides before it changes anything, so many simultaneous conflicts resolve correctly but not quickly.

## 3. Evidence

Offline: unit, property and executor tests (see above, `tests/auto-resolution.test.ts`, `tests/text-merge*.test.ts`, convergence and soak suites). Live, against one real Nextcloud with two simulated devices (2026-11-02): separate-sentence edits and both-append merge into one note without conflict copy, empty-versus-content keeps the content and preserves the empty version, overlapping edits end in a conflict copy; all with serial and with four parallel workers. No phone was tested.
