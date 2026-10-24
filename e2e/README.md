# Live tests

Opt-in tests against a **real Nextcloud server**. They never run in CI and never touch anything outside a freshly created, uniquely named folder, which they delete afterwards. Use a dedicated test account or folder and an app password.

## `npm run e2e:live`

Runs the real plugin (`src/main.ts`, scheduler, watcher, folder sync) with a minimal `obsidian` mock on two real temporary directories ("desktop" and "iPad", the latter with mobile memory limits) and checks the server independently with raw WebDAV requests.

Scenarios: auto-push of new notes/folders/empty folders/binary/unicode names, second device pull, polling, concurrent edits merge, folder and file deletion without reappearing, empty-folder deletion, folder rename, 24 MiB chunked transfer, exclusion patterns, pause, mass-deletion hold/undo/approve, restore from retained copies and from the Nextcloud trash bin, user size limit, version listing/compare/restore, conflict compare and resolution, files above the mobile memory limit, restart with offline edits, efficient polling, final convergence.

```sh
export NYRA_E2E_SERVER=https://cloud.example.com
export NYRA_E2E_USER=testuser
export NYRA_E2E_APP_PASSWORD=xxxxx-xxxxx-xxxxx-xxxxx-xxxxx
export NYRA_E2E_PARENT=Obsidian        # existing remote folder that may be written to
npm run e2e:live
```

Set `NYRA_E2E_RAW_LOG=1` to print unredacted warnings and errors (the production logger redacts them).

## `npm run acceptance:live`

Raw WebDAV conformance checks (create-only PUT, `If-Match` update and stale rejection, MOVE identity, ranges, chunk upload v2, conditional DELETE, simultaneous writes) followed by production-engine scenarios.

```sh
export NYRA_ACCEPTANCE_ENABLE=1
export NYRA_ACCEPTANCE_ALLOW_DESTRUCTIVE_TEST_ROOT=YES
export NYRA_ACCEPTANCE_SERVER=https://cloud.example.com
export NYRA_ACCEPTANCE_USER=testuser
export NYRA_ACCEPTANCE_APP_PASSWORD=xxxxx-xxxxx-xxxxx-xxxxx-xxxxx
export NYRA_ACCEPTANCE_ROOT=Obsidian/AcceptanceTests   # must already exist
npm run acceptance:live
```

## `npm run ui:preview`

Renders the settings UI with sample data (healthy, syncing, needs attention, not connected) in headless Chrome and writes PNG screenshots to `ui-preview-out/`. Offline, no server needed. Edit `e2e/ui-preview/preview.ts` to change the sample states.

```sh
node scripts/ui-preview.mjs ui-preview-out healthy,dark,900 attention,light,390,safety   # scenario,theme,width[,tab[,height]]
```
