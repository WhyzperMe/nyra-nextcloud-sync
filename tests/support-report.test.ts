import { describe, expect, it } from "vitest";
import { createRedactedSupportReport } from "../src/diagnostics/support-report";
import { DEFAULT_SETTINGS } from "../src/state/settings";

describe("redacted support report", () => {
  it("contains only allowlisted diagnostic data and strips server paths and secrets", () => {
    const report = createRedactedSupportReport({
      generatedAt: "2026-09-27T10:00:00.000Z",
      pluginVersion: "0.14.0",
      platform: "mobile",
      settings: {
        ...DEFAULT_SETTINGS,
        serverUrl: "https://alice:private-password@cloud.example/private-prefix?token=poll-token",
        remoteRootPath: "Private/Vault/Path",
        lastError: "Authorization: secret password after failed request"
      },
      hasStoredCredentials: true,
      health: null,
      autoSync: null,
      local: {
        status: "degraded", trackedFiles: 3, hashedBytes: 40, issueCount: 1, readBlocks: [{
          path: "private/Large.bin", reasonCode: "LOCAL_FILE_TOO_LARGE_FOR_SAFE_PLATFORM_READ", actualSizeBytes: 900, maxSafeReadBytes: 400
        }], lastScanComplete: false,
        lastCompletedAt: null, lastReason: "private/Note.md", lastError: null
      },
      remote: {
        status: "ready", trackedRemoteFiles: 4, directoriesVisited: 2, scanProgress: null, issueCount: 0, lastScanComplete: true,
        lastCompletedAt: null, lastRootPath: "private-root", lastError: null,
        lastMetrics: { requestCount: 2, responseBytes: 100, responseEntries: 4, networkDurationMs: 3, parseDurationMs: 1, elapsedMs: 4, entriesPerSecond: 1_000, peakConcurrency: 2, retryCount: 0 }
      },
      planner: null,
      execution: null,
      durable: { storeId: "store_private-id", generation: "7", walSequence: "23", files: 3, tombstones: 1, status: "ready" },
      integrity: {
        ok: false, source: "wal-rebuild", generation: "7", walSequence: "23", fileRecords: 3, tombstones: 1,
        verifiedBaselineObjects: 2, validSnapshotCount: 1, latestSnapshotSequence: "20", snapshotInvalidCount: 1,
        storage: {
          auditCompletedAt: "2026-09-27T10:00:00.000Z", lastSuccessfulAuditAt: null,
          walRecordCount: 23, walTransactionCount: 7, walBytes: 12000,
          currentSnapshotSequence: "20", previousSnapshotSequence: "16", currentSnapshotAgeMs: 1000,
          validSnapshotCount: 1, verifiedRecoveryGenerationCount: 2, invalidRecoveryGenerationCount: 0,
          currentRecoverySequence: "20", previousRecoverySequence: "16",
          referencedObjectCount: 4, presentReferencedObjectNames: 4, missingReferencedObjectNames: 0,
          unreferencedObjectNames: 2, unreferencedObjectBytes: 50, objectCount: 6, objectBytes: 500,
          unknownObjectSizeCount: 0, malformedObjectNameCount: 1, unknownObjectEntryCount: 0,
          stagingFileCount: 0, estimatedReclaimableBytes: null, garbageCollectionEnabled: false,
          lastSuccessfulGcAt: null
        },
        errors: ["private/Note.md hash=private-file-hash"]
      },
      transfers: { status: "available", records: 1, byPhase: { uploading: 1 } }
    });

    const text = report.toLowerCase();
    const parsed = JSON.parse(report) as Record<string, unknown>;
    expect(parsed.account).toEqual({ serverOrigin: null, connectionState: "disconnected", credentialsStored: true });
    expect(text).not.toContain("private-password");
    expect(text).not.toContain("poll-token");
    expect(text).not.toContain("private/Note.md");
    expect(text).not.toContain("private/Large.bin");
    expect(text).not.toContain("private-file-hash");
    expect(text).not.toContain("private-root");
    expect(text).toContain('"memorylimitblockpresent": true');
    expect(text).toContain('"errorcount": 1');
  });
});
