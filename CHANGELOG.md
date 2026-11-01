# Changelog

## 0.23.0

**Nothing is deleted on Nextcloud because a device looks empty, and one tap restores what was lost.**

- **Restore everything deleted since…** (Settings → Devices → Restore deleted files, or the command "Restore deleted files…"). Pick a time (last hour, 6 hours, 24 hours, 7 days, 30 days, or any date and time), see how many items it covers, and tap once. Items come back from the Nextcloud trash bin (folders first, missing parent folders are recreated), and files the trash bin no longer has are written back from the copies this device retained. Nothing existing is overwritten and one failing item never stops the rest. Restored files then sync to the device.
- **A wiped side is never mirrored.** If this device shows no files while Nextcloud holds them, Nyra holds every deletion on Nextcloud at any size (even a three-file vault), and the same applies the other way round. These holds are never released automatically; the notice says what is happening and what to do.
- **Automatic approval is narrower.** Held deletions are released by themselves only if they remove files from this device, stay under a tenth of the tracked files and have waited 10 minutes. Deleting on Nextcloud always needs a person.
- **Download from Nextcloud works on an emptied phone.** A device that still remembered its old files read the empty vault as "everything was deleted" and refused to download. The button now forgets those stale histories first (without any deletion intent) and then downloads.
- **Test this device's storage** (Diagnostics): writes, reads back three times, appends, renames, lists hidden files and checks modification times in a scratch folder, and names the exact failing step.
- 18 new tests.

## 0.22.0

**Phone: "Download blocked: durable transaction references missing or corrupt immutable object …" and folders that never get removed.**

- **Root cause of the blocked download.** When a file that never reached a stored baseline disappeared locally, Nyra wrote a deletion record that pointed at a content hash that was never saved. The state store (rightly) refused to commit a reference to a missing object, so the local scan threw, and that scan runs first in every download and sync. One such file kept the whole phone blocked. Deletion records now only reference stored baselines, and the store drops a recovery hint whose object is not stored instead of failing.
- **Lost baseline objects no longer wedge sync.** If a stored baseline copy vanishes (cleared cache, interrupted write, partial restore), a record that only carries it forward now loses that baseline and is treated as "no common ancestor" (never as a deletion), so normal planning and automatic conflict handling take over. A brand-new baseline must still verify.
- **Folders.** A cycle that fails on one file no longer skips folder housekeeping (it re-checks emptiness on both sides, so it is safe after a partial run); the blocked scan above was the most likely reason folders never disappeared on the phone. Folders that only hold system metadata (.nomedia, Thumbs.db, desktop.ini, .DS_Store, ._ files, .directory) are now removed as empty, because Android file managers leave these behind.
- **Phone storage hardening.** Whole-file reads retry twice before a file is declared "changed while being read", which covers short reads right after a write.
- 9 new tests: unstored tombstone hints, lost baseline release, new baselines still verified, folder junk removal, folder pass after a failed plan.

## 0.21.0

**Phone sync no longer stops with "Local transfer snapshot chunk failed size verification" or "Durable state store is degraded".**

- **Uploads no longer round-trip through phone storage.** Before an upload Nyra copied the file in chunks into a temporary folder and read each chunk back. On Android the read-back can come back short right after a write, which aborted the sync. The verified bytes are already in memory, so the upload now takes its chunks straight from them: no extra writes, no read-back, same SHA-256 checks.
- **The state store heals itself.** A failed state write used to freeze the store until the plugin was reloaded. Writes are now retried (the identical record, so nothing can fork), read-after-write checks wait briefly for slow phone storage before they are believed, and if the store still freezes it replays what is really on disk and resumes by itself on the next change. Reloading is only needed if that replay itself fails.
- **Held deletions release themselves.** New setting **Approve held deletions automatically** (on by default): a large batch of deletions is still held first, but if it stays unchanged for 10 minutes and removes at most half of the tracked files, Nyra carries it out. Bigger batches keep waiting for you. Everything stays recoverable under Recently deleted and in the Nextcloud trash.
- **Fewer interruptions on phones.** While a sync is running the screen is kept awake (best effort), because Android freezes Obsidian soon after the screen turns off and can cut a transfer or a write in half. Syncing continues the moment you return to Obsidian. Android does not let Obsidian run reliably with the screen off; this cannot be changed by a plugin.
- 8 new tests: short-read phone storage, retry and in-place recovery of the state store, automatic deletion approval, the wake lock.

## 0.20.0

**Huge notes and drawings merge instead of stopping at "Automatic merge is limited to 2097152 bytes per version".**

- **Excalidraw drawings are merged semantically.** A `.excalidraw.md` file stores the scene as one compressed block, which cannot be merged line by line (and a line merge of two compressed streams could corrupt the drawing). Nyra now decompresses the scene, merges it element by element exactly like Excalidraw reconciles collaborators (an element only one side changed keeps that change; an element both changed goes to the higher `version`, then the lower `versionNonce`; additions from both devices are kept; a change beats a deletion; the result is ordered by Excalidraw's fractional index; app state and embedded files are merged per key), and writes it back in the plugin's own format. The codec is bit-compatible with the library Excalidraw uses (verified on a real 2.5 MB drawing, identical after a round trip) and the merge is deterministic, so every device produces the same file. A 2.5 MB drawing with 7,500 strokes merges in a few seconds on a desktop. If a drawing cannot be parsed, Nyra now asks for review instead of attempting a text merge.
- **Plain-text merge scales to very large notes.** The common start and end of two versions are skipped before the exact diff, so edits in different places of a 200,000-line note merge in well under a second instead of exceeding the diff budget. Budgets: 16 MiB per version (was 2 MiB; the old default is upgraded automatically, up to 128 MiB can be set in `data.json`), 250,000 lines (was 12,000), 64 million diff cells (was 8 million).
- 15 new tests: codec compatibility and round trips, all merge rules (including identical results on both devices), a drawing above the old limit, unparseable files, merging the text around the drawing, and a 200,000-line note.

## 0.19.0

**Conflicts resolve themselves.** New setting **Resolve conflicts automatically** (Sync → on by default). Nothing is ever discarded: whatever does not stay at the path is first saved next to it.

- **Two versions of one file (edited on two devices, or created on both):** the newer version stays; the other one is saved as `name (Nyra conflict LOCAL|REMOTE …)` and syncs like any note. Times closer than two seconds, or an unknown time, are decided by content hash, so every device reaches the same result. Text edits that do not overlap are still merged first.
- **Deleted on one side, changed on the other:** the change wins and the file is restored (downloaded or uploaded again) with a verified new baseline.
- **Renamed differently on both sides:** the Nextcloud name wins; the local file is moved to it (refused if that path is occupied).
- **"…collides with another replica's path or required parent directory":** this was bookkeeping, not your files. Nyra now re-pairs the durable records of such paths by their exact path (local with Nextcloud) before planning, never touches a file, never infers a deletion and clears stale tombstones. Genuine letter-case/Unicode aliases of two different files are left for review.
- The activity list shows **Conflict resolved** with the reason; "Review both versions" now only lists what Nyra could not settle on its own. Switch the setting off to restore the previous fully manual behaviour.
- 14 new tests cover the repair of the screenshot case, the decision rules (including identical decisions on every device), restore and rename plans, a restore through the real executor and the cycle hook.

## 0.18.6

- **Cleans up the leftover `etag-probe…` files that other sync clients complained about** ("file names containing ? are not supported", for example in the Nextcloud desktop client). Older versions created these short-lived connection-check files with an icon and `# ? %` in the name and, on some clients, could not delete them again, so they piled up in `.nyra-nextcloud-sync-runtime`. Before each safety check Nyra now deletes stale `etag-probe*` files (small, untouched for ten minutes, removed with their own ETag) in that folder; young probes of another device and every other file are left alone.
- The check itself uses plain ASCII names since 0.18.4 and cleans up reliably since 0.18.5. Update every device (iPad too): a device that still runs an older version keeps creating the old files.

## 0.18.5

- **Fixes "move conditional-write probe failed with HTTP 412 … An If-None-Match header was specified, but the ETag matched" on iPad:** Nyra never sent an `If-None-Match` with that request. The iOS HTTP stack cached the earlier download of the same file and added its own `If-None-Match` validator to the following rename/write, so Nextcloud refused a perfectly valid, unchanged file. (This would also have blocked uploading a note after it had been downloaded on the iPad.)
- **Two layers of protection:** every read (GET/HEAD) now goes to a unique URL, so nothing about it can be cached or validated later; and if a write is still refused with a 412 that names an `If-None-Match` the request never carried, it is repeated once on a fresh URL (the refused write never ran, so this is safe). Create-only writes that really send `If-None-Match: *` and ordinary precondition failures are never retried.
- New tests cover the injected-validator case end to end, the unique read URLs and the cases that must not be retried.

## 0.18.4

- **Fixes the iPad "move conditional-write probe failed with HTTP 412":** the server-safety check no longer trusts a refused MOVE blindly. A rename with `Overwrite: F` can never destroy data, so after an unexpected answer Nyra looks at the real server state: if the file was already moved (the answer was lost or replayed) the step counts as done, and if Nextcloud rejected a matching ETag although the source is unchanged, the rename is repeated once without `If-Match`. A genuinely changed source still fails. If the check still fails, the message now lists the real state (source present or missing, destination, ETags).
- **The same safeguard for real renames:** a remote rename that Nextcloud answers with a spurious 412 while the source still has the expected ETag is repeated once without `If-Match`; a changed source is still refused.
- **Plain probe file names:** the connection probe no longer uses an emoji and the characters `# ? %` in its file name (it only tested path handling, which has its own tests). Sync clients that watch the same folder, such as the Nextcloud desktop client on Windows, no longer report "file name not supported" for it.

## 0.18.3

- **Errors you can read in full on iPad and phone:** sync errors are no longer cut off with "…". The Overview shows a **Last sync failed** card with the complete message in a scrollable, selectable box, a **Copy** button and **Try again**. Rows in the activity list open on tap to show the full text (errors start open), and the Auto-sync status shows the real error instead of just "Attention". Messages in the box wrap and can be copied, so they can be pasted into a bug report.
- **Server reasons instead of bare status codes:** when Nextcloud refuses a request, the message now includes its explanation (for example `HTTP 400 (Destination header …)`). Stored sync errors keep up to 800 characters instead of 180.
- **Safer connection check on iPad:** the guarded-MOVE step of the server-safety check now moves its probe file to a plain-ASCII name, so clients that mangle special characters in the `Destination` header can no longer block syncing.

## 0.18.2

- **Fixes "Remote writes are paused: Nextcloud did not advance the ETag":** Nextcloud only changes a file's ETag when its stored modification time changes, so rewriting a file with the same source mtime kept the old ETag even though the bytes changed. The server-safety check no longer pauses on this. Every conditional update now carries a modification time whose second differs from the remote file's current one, so the ETag reliably advances and a concurrent same-second edit from another device is still detected. The safety check tests exactly that behavior and still pauses when a server truly keeps the ETag.
- Test server now models this ETag-follows-mtime behavior; new tests cover the probe, real updates with an equal source mtime and the mtime rule.

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
