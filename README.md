# Nyra Nextcloud Sync

Bidirectional Obsidian ↔ Nextcloud sync with verified writes, safe merges and autonomous, loss-free conflict resolution. Works on desktop and on iPad/iPhone.

| | |
| --- | --- |
| **Instant sync** | Edits are picked up after 1 second of quiet. Remote changes are found by polling (15 s, backing off to 2 min while idle, one cheap request when nothing changed) and immediately when Obsidian returns to the foreground |
| **Everything is mirrored** | Notes, attachments, PDFs, images, any file type, nested folders, **empty folders**, renames |
| **Deletions** | Deleting a file or folder deletes it on the other side and it does not come back. A **mass-deletion guard** holds large deletions for your approval; **Restore deleted files** brings them back from retained copies or the Nextcloud trash bin |
| **History** | Browse, compare and restore **previous versions** of a note from Nextcloud |
| **Conflicts** | Non-overlapping text edits are merged automatically. For everything else Nyra decides on its own and never discards data: the newer version stays, the other is saved next to it as a conflict copy; a change beats a deletion; duplicate paths are re-paired. Only genuine ambiguities are left for you, with a **line diff** and Keep local / remote / both |
| **Scope** | Exclude files and folders with simple patterns, sync only chosen folders, cap file size, pause auto-sync |
| **Mobile** | No Node/Electron APIs. Whole-file memory limits are enforced (32 MiB on mobile, 128 MiB on desktop); larger files are skipped on that device, never deleted or blocking |
| **Activity** | The settings list what the last syncs did, what is waiting for approval and what was skipped |
| **Credentials** | Nextcloud Login Flow v2 app password, stored in Obsidian SecretStorage |

## Install

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release (or run `npm ci && npm run build`).
2. Copy them to `<vault>/.obsidian/plugins/nyra-nextcloud-sync/`.
3. Enable **Nyra Nextcloud Sync** under Community plugins.
4. Enter your server URL, choose **Log in with browser**, approve access and pick the remote folder for this vault.

Use the same remote folder on every device. On a new device, run **Download vault from Nextcloud to this device** once; on the first device with data, **Publish this vault to Nextcloud**. Avoid running a second sync tool (for example the Nextcloud desktop client) on the same vault folder: it can independently restore or rename files.

## Everyday use

- Edit normally. Auto-sync coalesces edits and retries after outages.
- **Sync now** (command palette or settings) runs a cycle immediately.
- Conflicts are settled automatically (setting **Resolve conflicts automatically**, on by default). What remains offers **Keep local**, **Keep remote**, **Keep both** or **Retry safe merge**.
- **Automatic deletes** is on by default. Switch it off in settings if you only want additions and edits to propagate. Whenever one sync would delete more than **Ask before deleting more than** items (default 20) or most of the vault, Nyra waits for your approval (settings → Activity, or the command **Approve pending deletions**).
- **Restore deleted files…** and **Show previous versions of the current note** are in the command palette.
- The **Files** tab lets you tick or untick any file or folder in a tree view (this device and Nextcloud together); unticked items are left alone on both sides. Under **Rules and limits** you can also exclude patterns (`*.tmp`, `Private/`, `node_modules`, `/Inbox`, `Attachments/**/raw`), restrict sync to folders, skip files above a size and pause auto-sync.
- iOS suspends apps in the background; opening Obsidian triggers an immediate sync.

## Limits

- Files above the device memory limit (or your own size limit) are not synced from/to that device. The Activity panel lists them.
- Previous versions need Nextcloud's *Versions* app; "replace in place" only works for notes without unsynced changes.
- Folder deletion on Nextcloud is a WebDAV collection delete that is only issued after a fresh listing shows the folder empty; a file added in the milliseconds in between would end up in the Nextcloud trash bin.
- The server must reject stale conditional writes (`If-Match`) correctly. Nyra probes this before writing and pauses writes if the server misbehaves.

## Development

Requires Node 20.19+, 22.12+ or 24+.

```sh
npm ci
npm run check        # typecheck, 300+ tests, production build
npm run dev          # watch build
```

Opt-in live tests against a real Nextcloud (use a throw-away account/folder): see [e2e/README.md](e2e/README.md).

[Architecture](ARCHITECTURE.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

MIT licensed.
