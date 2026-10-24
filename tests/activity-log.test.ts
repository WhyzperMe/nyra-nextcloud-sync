import { describe, expect, it } from "vitest";
import { ActivityLog, activityKindForStep } from "../src/activity/activity-log";
import type { ExecutionReport, ExecutionStepResult } from "../src/execution/types";
import { MemoryVaultAdapter } from "./helpers/memory-vault";

const result = (kind: ExecutionStepResult["kind"], status: ExecutionStepResult["status"], path: string, message = "m"): ExecutionStepResult => ({ entryId: "e", kind, status, message, path });
const report = (results: ExecutionStepResult[]): ExecutionReport => ({ results } as unknown as ExecutionReport);

describe("activity log", () => {
  it("maps user-visible step outcomes and hides internal bookkeeping", () => {
    expect(activityKindForStep("upload-update", "completed")).toBe("uploaded");
    expect(activityKindForStep("download-create", "completed")).toBe("downloaded");
    expect(activityKindForStep("delete-remote", "completed")).toBe("deleted-on-server");
    expect(activityKindForStep("delete-local", "completed")).toBe("deleted-here");
    expect(activityKindForStep("merge-text", "completed")).toBe("merged");
    expect(activityKindForStep("establish-baseline", "completed")).toBeNull();
    expect(activityKindForStep("retire-record", "completed")).toBeNull();
    expect(activityKindForStep("upload-update", "blocked")).toBe("needs-review");
    expect(activityKindForStep("establish-baseline", "blocked")).toBeNull();
    expect(activityKindForStep("upload-update", "skipped")).toBeNull();
  });

  it("records reports newest first, persists across sessions and stays bounded", async () => {
    const adapter = new MemoryVaultAdapter();
    const log = new ActivityLog(adapter, "activity.json", () => new Date("2026-10-21T10:00:00Z"));
    await log.addReport(report([result("upload-create", "completed", "a.md"), result("establish-baseline", "completed", "a.md"), result("delete-remote", "blocked", "b.md", "held")]));
    expect(log.recent().map((entry) => [entry.kind, entry.path])).toEqual([["needs-review", "b.md"], ["uploaded", "a.md"]]);
    expect(log.recent()[0]?.detail).toBe("held");

    const reopened = new ActivityLog(adapter, "activity.json");
    await reopened.load();
    expect(reopened.recent()).toHaveLength(2);

    for (let batch = 0; batch < 8; batch += 1) {
      await reopened.add(Array.from({ length: 50 }, (_, index) => ({ at: "2026-10-21T10:00:00Z", kind: "uploaded" as const, path: `f-${batch}-${index}` })));
    }
    expect(reopened.recent(1000)).toHaveLength(300);
    expect(reopened.recent(1)[0]?.path).toBe("f-7-49");
  });

  it("survives damaged storage and records errors", async () => {
    const adapter = new MemoryVaultAdapter();
    await adapter.write("activity.json", "not json");
    const log = new ActivityLog(adapter, "activity.json", () => new Date("2026-10-21T10:00:00Z"));
    await log.load();
    expect(log.recent()).toEqual([]);
    await log.addError("Server unreachable");
    expect(log.recent()[0]).toMatchObject({ kind: "error", detail: "Server unreachable" });
  });
});
