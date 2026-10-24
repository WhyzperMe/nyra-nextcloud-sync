import { describe, expect, it } from "vitest";
import { deriveOverviewSyncState } from "../src/sync/derived-status";

const ready = { blocked: false, busy: false, offline: false, waiting: false, attention: false };
describe("Overview status priority", () => {
  it("never presents a write-safety or recovery block as synced", () => {
    expect(deriveOverviewSyncState({ ...ready, blocked: true })).toBe("Needs attention");
    expect(deriveOverviewSyncState({ ...ready, blocked: true, busy: true })).toBe("Needs attention");
  });
  it("does not label queued offline edits as an active sync", () => {
    expect(deriveOverviewSyncState({ ...ready, offline: true, waiting: true })).toBe("Offline");
  });
  it("shows actual in-flight work while an outage is being detected", () => {
    expect(deriveOverviewSyncState({ ...ready, busy: true, offline: true })).toBe("Syncing");
  });
  it("distinguishes healthy readiness, queued work and review", () => {
    expect(deriveOverviewSyncState(ready)).toBe("Synced");
    expect(deriveOverviewSyncState({ ...ready, waiting: true })).toBe("Syncing");
    expect(deriveOverviewSyncState({ ...ready, attention: true })).toBe("Needs attention");
  });
});
