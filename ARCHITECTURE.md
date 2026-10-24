# Architecture

**Source version 0.18.0 · durable schema v1 · source code is authoritative**

## One synchronization pipeline

~~~text
Vault hints / adaptive poll
  → verified local facts + complete remote inventory
  → LOCAL / BASE / REMOTE reconciliation
  → convergence audit + deterministic scope-bound plan
  → fresh hash / fileId / ETag preconditions
  → transactional executor + read-back verification
  → durable publication of a new verified BASE
  → folder reconciliation (create / delete, including empty folders)
~~~

| Responsibility | Source |
| --- | --- |
| Obsidian lifecycle, scope and operation guard | src/main.ts |
| Quiet time and adaptive retry deadlines | src/autosync/ |
| Cycle ordering and parent-root mirror guard | src/sync/ |
| Stable hashing, event-race fences and reconciliation | src/local/ |
| Bounded DAV parsing and complete inventories | src/remote/ |
| Deterministic decisions and explicit conflict plans | src/planner/ |
| Local manifests, guarded mutations and postconditions | src/execution/ |
| WAL, immutable snapshots, recovery generations, BASE | src/state/durable/ |
| Chunk uploads, ranged downloads and journals | src/transfer/ |
| Login Flow, SecretStorage and URL policy | src/auth/, src/security/ |
| Folder mirroring | src/folders/ |
| Scope rules, oversized files | src/local/path-policy.ts, src/local/user-rules.ts |
| Deletion guard, deletion ledger, restore, trash bin | src/execution/delete-guard.ts, src/execution/deletion-hold.ts, src/recovery/ |
| Activity log | src/activity/ |
| Fast remote check | src/remote/root-etag.ts |
| Conflict comparison, version history | src/recovery/history-service.ts, src/merge/line-diff.ts |
| Commands, status bar, conflict-copy naming | src/plugin/ |
| Settings | src/ui/settings-tab.ts, styles.css |

## Identity and authority

LOCAL, BASE and REMOTE have independent paths. SHA-256 proves content equality; timestamps are metadata. Remote fileId identifies renames; ETags fence updates. Plans bind the store, generation and WAL anchor and are fingerprinted before execution. Cross-identity path collisions block writes. Heuristic rename candidates never authorize moves.

The planner also conservatively blocks NFC/case aliases and file-versus-parent-directory collisions across the observed replicas. Actual paths are preserved. Plan order uses ordinal comparison so the device's locale cannot change its fingerprint. Different byte lengths always contradict content equality, even if an unreliable server reuses its ETag.

Manual and scheduled work share an operation guard. A feature-detected Web Locks lease protects the app-profile writer across windows; unavailable or occupied locks fail closed. Device-profile and account/root binding isolate histories. Changing account/root scope requires reload. Legacy recovery evidence is retained.

## Scheduling and performance

Events move a quiet deadline, normally 1 second. The watcher coalesces exact-path reads; tree events request a full scan. Local quiet cycles flush hints before planning. Startup, resume, delete-enabled cycles, incomplete observations and the five-minute fence require complete local scans. Remote discovery uses complete recursive PROPFIND, without assuming an unsupported incremental REPORT.

Remote polling starts at 15 seconds and doubles toward 2 minutes after inactive cycles. Health, maintenance and throttling control backoff. New edit hints cannot shorten a retry deadline. Internal errors retain an approximately 60-second pause; a manual request can explicitly retry. One attempt owns both health preflight and execution.

Expected remote ETag/identity changes or a stale durable-plan anchor use the typed `sync-precondition-changed` outcome. The cycle runner first re-inventories and replans immediately (after 1.5 s and 3 s) because some storage backends restamp an ETag shortly after a write; if that is not enough, auto-sync retries a new inventory/plan cycle after a jittered 2-second delay, exponentially capped at 60 seconds. HTTP 423 (locked by another client) takes the same path. It never replays the old physical plan. Unreliable server preconditions, fingerprint tampering and internal integrity failures do not use this fast path.

After asynchronous health checking, scheduling revalidates enabled state, readiness, quiet time and deletion permission. A permission granted during that preflight is not added to the pending attempt; a revoked permission takes effect. Health responses are bound to the server and observation revision. Delayed results cannot override a newer authenticated observation or publish after shutdown. Failed parallel scans drain active workers before releasing ownership.

Whole-file reads and BASE objects have platform-aware bounds because Obsidian readBinary is not streaming. Transfers use bounded chunks/ranges. WAL retention is unbounded and object collection remains disabled to preserve evidence; large histories remain a performance limitation.

## Deletions and folders

Only trustworthy observations prove absence. Failed scans never authorize deletion. Baseline-backed deletion requires an unchanged surviving version, complete inventories, recoverable BASE and fresh preconditions. Automatic deletion is a setting (on for new installations); blocked deletion keeps its tombstone. Local deletions move the bytes into the plugin's recovery area and Nextcloud keeps deleted files in its trash bin.

Version 0.16.0 blocks an unbaselined one-sided record with a deletion tombstone. A known deletion must not become a new create from the other side after interrupted initial convergence or restart. Without BASE, both automatic restoration and deletion would guess intent.

Files carry full identity. Folders carry only presence, so they are reconciled separately after the file engine has converged (`src/folders/`). A persisted folder BASE records the folders confirmed on both sides at the last sync:

| LOCAL | REMOTE | in BASE | Action |
| --- | --- | --- | --- |
| yes | yes | – | keep, record in BASE |
| yes | no | no | create on Nextcloud (new local folder) |
| no | yes | no | create locally (new remote folder) |
| yes | no | yes | deleted remotely → remove local folder, only if empty |
| no | yes | yes | deleted locally → remove remote folder, only if a fresh listing shows it empty |

A folder is never removed while either side still holds a file inside it; the file engine decides those files first. Without deletion permission nothing is removed and the BASE entry is kept. A missing or damaged folder BASE is treated as empty, which can only create folders, never delete them.

## Scope rules

`LocalPathPolicy` is the single scope authority used by the local scanner, the remote scanner, the planner and folder mirroring. Static rules (reserved roots, config tree), the user's exclusion patterns and include-only folders are evaluated on every check, so settings apply immediately. Items outside the scope are dormant: their records are neither updated nor deleted, on either side. Files and folders are evaluated separately so that ancestors of an include-only folder stay traversable.

## Deletion safety net

1. **Guard:** before executing an automatic plan, `evaluateDeleteGuard` counts `delete-local` and `delete-remote` steps. More than the threshold, or more than half of the tracked files (from five up), puts them on hold: the plan runs with destructive steps blocked and `DeletionHold` exposes what is pending. An approval covers the number of deletions shown, expires after 15 minutes and is consumed by the sync that uses it. Folder removals are held with the same threshold. Explicit conflict choices bypass the guard.
2. **Ledger:** every completed delete step records path, BASE hash and size (`deleted-v1.json`, 500 entries, 90 days). The bytes are the retained BASE objects, so **Restore** works offline.
3. **Nextcloud trash bin:** the DAV trashbin endpoint lists and restores items below the sync root. The plugin's own probe files are purged from it after use.

## Polling cost

A remote-poll cycle may skip the recursive PROPFIND when the sync root's ETag equals the one recorded by the last authoritative scan. The shortcut is enabled per server only after `RemoteRootChangeDetector.verifyPropagation` proved that a nested create and delete both change the root ETag. It is bypassed for non-poll triggers, after a replan, after five minutes, and whenever the check fails. Locally, scans between the periodic verified ones reuse a hash when size and mtime are unchanged and the file was already stable for two seconds when hashed; startup, resume, manual runs and the five-minute fence read everything.

## Device limits

Obsidian's `readBinary` materializes whole files, so each device has a whole-file memory limit (32 MiB mobile, 128 MiB desktop). Files above it are skipped consistently on both replicas of that device through the path policy (`oversized` sets filled by the local and remote scanners). Their records, if any, become dormant: they are neither deleted nor overwritten, and they never make a scan incomplete. They still count as occupants of their folders.

## Merge, recovery and lifecycle

Merge verifies BASE/LOCAL/REMOTE, fatal UTF-8 decoding, type/size/line/diff limits and non-overlapping changes. The executor verifies both output hashes and advances BASE only after convergence. Conflicts never insert markers into original notes. Eligible explicit choices preserve user versions before replacement.

Local apply manifests and transfer journals are separate from replica WAL state. Ambiguous completion is reconciled before retry. Recovery verifies immutable generations, WAL chains and required BASE objects. UI registration is immediate, but sync remains gated until background recovery succeeds. Shutdown drains work before releasing ownership. Mobile code uses no production Node/Electron filesystem APIs; iOS suspension is expected.

A conditional-write probe precedes remote mutation. It verifies create-only PUT, ETag advancement for changed content at a fixed source mtime, stale PUT/DELETE/MOVE rejection and guarded MOVE identity/content. Fixing source mtime exercises the same-second preservation hazard even over a slow connection. Both user-root transfer staging and the selected sync root are checked because their storage mounts can differ. Detected unreliable ETags, including during later execution, revoke cached write capability and pause writes. This is a sampled capability check, not proof for every nested mount or future request. A passing probe cannot make an intermittently broken server reliable.

The reserved runtime segment is always excluded by local path policy and remote traversal at every depth, including retained probe evidence inside a selected or nested root.

Schema v1 and retained history remain compatible.
