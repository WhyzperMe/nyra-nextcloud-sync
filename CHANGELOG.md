# Changelog

## 0.18.1

- **Clearer ETag diagnostics:** when the server-safety check pauses remote writes because Nextcloud did not advance the ETag after an immediate update, the message now says what happened (ETag unchanged, file id changed or no ETag), at which update and folder, with the observed values.

## 0.18.0

- **Choose what to sync visually:** the new **Files** tab shows your vault as a tree (this device and Nextcloud together, loaded folder by folder, with sizes and "Server only" / "This device only" hints). Uncheck any file or folder to keep it out of sync in both directions; a half-checked folder has excluded items inside. Excluded items are never uploaded, downloaded or deleted, and including them again compares both sides by content instead of replaying old deletions.
- **Everything on by default:** auto-sync, deletion sync (with the approval guard), fast polling and safe text merge are on for new installations and are switched on once for existing ones. A new vault suggests its own Nextcloud folder (`Obsidian/<vault name>`) and creates it on first connection if it does not exist yet. Background sync starts 5 seconds after Obsidian opens.
- **Polish:** the choice menus, tab hover states and headings were reworked (no grey hover boxes, aligned headings, SVG chevron and check marks, no stray scrollbars).

- **New settings design:** flat and quiet, in the style of a professional tool: a status block with Sync now / Pause and five numbers, text tabs (Overview, Account, Sync, Safety, Advanced), grouped settings with hairline borders, a compact activity list (the file name stays readable when paths are long), alerts only for what needs a decision, a first-run guide, and layouts from phone to wide desktop in light and dark themes. No gradients, shadows or decorative animation; motion is limited to press feedback, the choice menu and the busy indicator, and only uses transform and opacity. A full rebuild of any settings screen takes about 2 ms (9 ms with 870 elements), and the busy state updates in place. New icon set with constant stroke weight and a flat logo. `npm run ui:preview` renders the screens with sample and worst-case data in headless Chrome.

- **Mass-deletion protection:** a sync that would delete more than a configurable number of files or folders (default 20), or most of the vault, waits for your approval. The settings show what is held and offer **Approve** or **Undo** (restores the files here). Explicit conflict choices are never held.
- **Restore deleted files:** every deletion made by sync is recorded with the retained BASE bytes and can be restored from the new dialog (also command **Restore deleted files…**). The same dialog restores from the Nextcloud trash bin.
- **Previous versions:** command **Show previous versions of the current note** lists Nextcloud's versions, compares them with the current text and restores one as a copy or in place (only for fully synced notes).
- **Conflict comparison:** a **Compare** button in conflict review shows line diffs between this device, Nextcloud and the common ancestor. A blocked automatic merge now keeps the remote hash it verified, so **Keep local / remote / both** are offered immediately (previously they could be missing).
- **Scope control:** gitignore-style exclusion patterns, an optional "only these folders" list, a per-vault maximum file size, and **Pause auto-sync** (setting and command).
- **Activity panel:** recent uploads, downloads, merges, moves, deletions, folder changes, held deletions and errors, plus the files skipped for size.
- **Efficient polling:** after a one-time server probe, idle background polls use a single request on the sync root's ETag instead of a full recursive scan (full scan at least every 5 minutes). Between fully verified scans, unchanged files are no longer re-read and re-hashed (git-style size + mtime rule with a 2-second race window); startup, resume, manual syncs and the 5-minute fence still hash everything.
- The plugin's own probe files are removed from the Nextcloud trash bin after use.
- `main.ts` and the settings UI were split into focused modules; 60+ new tests and 9 new live scenarios (22 in total).

## 0.17.0

- **Folder sync:** empty folders are created, mirrored and deleted on both sides. Folder deletions are decided with a three-way baseline, so a deleted folder never reappears and a never-confirmed folder is never deleted.
- **Deletions on by default** for new installations (local files remain recoverable, Nextcloud keeps a trash bin). Existing installations keep their saved choice.
- **Mobile fix:** one file above the device memory limit no longer marks the whole local scan incomplete and pauses all syncing. Such files are skipped on that device (local and remote, consistently), are never deleted or overwritten, and are listed in the status panel.
- **Server ETag drift:** storage backends that restamp an ETag shortly after a write no longer abort the cycle. The cycle re-inventories and replans (bounded) instead.
- HTTP 423 (locked) is treated as a transient conflict that triggers a fresh plan instead of a hard failure.
- Hosts without the Web Locks API fall back to an in-process writer lease instead of refusing to sync.
- New opt-in live end-to-end test that runs the real plugin on two real directories against a Nextcloud server.
- Removed legacy staged verification scripts, historical reports, generated bundles and the unused docker harness. Script-based self-tests and fuzzers now run under Vitest.

## 0.16.1

- Revalidate scheduling and deletion permissions after the asynchronous health preflight.
- Ignore stale health responses, drain scan workers after failures, block portable path aliases, locale-independent plan ordering.
- Extended the conditional-write probe to DELETE and MOVE at staging and sync roots.

## 0.16.0

- Block automatic recreation of known deletions before the first verified BASE.
- Verify upload sources before creating remote parent folders; revoke cached write capability when a server proves unreliable.
- Full two-device engine scenarios; cross-platform CI.
