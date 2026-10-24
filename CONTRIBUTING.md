# Contributing

1. Use a supported Node version and run `npm ci`.
2. Keep changes scoped. Add regression, fault or recovery tests for behaviour changes; comments should explain invariants and reasons.
3. Run `npm run check` before opening a pull request. For changes to sync behaviour also run the opt-in live tests in [e2e/README.md](e2e/README.md) against a throw-away server.
4. Releases: `npm version <x.y.z>` updates `manifest.json` and `versions.json`; pushing the tag `x.y.z` publishes `main.js`, `manifest.json` and `styles.css` via the release workflow.

Never include credentials, server-specific settings, vault notes or recovery state in issues or pull requests.

Preserve LOCAL/BASE/REMOTE identity, exact preconditions, deletion safety, mobile read bounds and recoverable ambiguous completion. Never relax a safety assertion to hide a failure.
