# Security and data safety

**Source version 0.18.0 · durable schema v1**

## Implemented boundaries

- **Transport:** HTTPS except loopback development. No TLS bypass, trust-all certificates or insecure CA fallback.
- **Authentication:** Login Flow v2 app passwords use Obsidian SecretStorage. Ordinary settings store a reference, not the secret. The plugin does not store primary account passwords.
- **URLs:** credentials in URLs are rejected. Same-origin and canonical-path restrictions protect login/DAV requests; traversal and malformed hrefs fail closed.
- **Privacy:** structured logs redact credentials, tokens, private paths, identities, hashes, plan fingerprints and free-text errors. URL fields expose only origin. No telemetry. Support reports use an allowlist; review before sharing.
- **Writes:** events are hints. Fresh facts, plan scope/WAL binding, exact hashes, fileId/ETag checks, create-only semantics and verified postconditions remain required.
- **Concurrency:** operation guards and a Web Locks writer lease serialize ownership. Missing ownership blocks writes.
- **Recovery:** immutable generations, WAL and BASE objects are retained. Unknown evidence is preserved. Garbage collection is disabled.
- **Deletion:** configurable (on for new installations). Failed scans cannot prove absence. BASE-backed deletion needs fresh preconditions; ambiguous delete-versus-edit transitions remain blocked. Folders are only removed when empty. Large deletions need explicit approval, and every sync deletion is restorable from retained BASE bytes or the Nextcloud trash bin.
- **Mobile:** no production Node/Electron dependency. Read budgets are bounded; iOS background timer continuity is not assumed.

## Server requirements and limits

Production servers need publicly trusted TLS and correct atomic conditional writes. Nyra probes create-only behaviour, same-second ETag changes, stale PUT/DELETE/MOVE rejection and guarded MOVE integrity at the staging and sync roots, and pauses writes on detected failures. A later mutation that proves an ETag unreliable revokes the cached capability. These checks cannot repair a server that accepts stale writes.

A typed stale-plan/ETag outcome only schedules a fresh inventory and plan; it never relaxes an old precondition.

Tombstones block recreation of a known deletion before initial BASE establishment. Overlapping sync tools can independently restore data.

Development dependencies are locked and audited; there are no runtime dependencies. Tests do not establish every-server or physical-device compatibility.

## Report a vulnerability

Use private GitHub vulnerability reporting when available. Never post credentials, vault contents or unredacted logs publicly. If private reporting is unavailable, ask for a private contact without including exploit data or secrets. You can write me an email but i prefer GitHub vulnerability reporting.
