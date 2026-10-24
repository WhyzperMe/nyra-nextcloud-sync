import { errorMessage } from "../core/errors";
import type { Logger } from "../diagnostics/logger";
import type { LocalPathPolicy } from "../local/path-policy";
import type { DurableStateStore } from "../state/durable/store";
import { AsyncMutex } from "../state/durable/mutex";
import type { RemoteInventoryReconciler } from "./reconciler";
import type { RemoteInventoryScanner } from "./scanner";
import type { RemoteInventoryRuntimeSummary, RemoteReconcileOutcome } from "./types";
import type { RemoteFullScanResult, RemoteScanMetrics } from "./types";

export class RemoteInventoryService {
  private readonly mutex = new AsyncMutex();
  private status: RemoteInventoryRuntimeSummary["status"] = "idle";
  private directoriesVisited = 0;
  private issueCount = 0;
  private lastScanComplete: boolean | null = null;
  private lastCompletedAt: string | null = null;
  private lastRootPath = "";
  private lastError: string | null = null;
  private lastMetrics: RemoteScanMetrics | null = null;
  private closed = false;

  constructor(
    private readonly scanner: RemoteInventoryScanner,
    private readonly reconciler: RemoteInventoryReconciler,
    private readonly state: DurableStateStore,
    private readonly logger: Logger,
    private readonly policy?: LocalPathPolicy,
    private readonly beforeReconcile?: (scan: RemoteFullScanResult) => Promise<void>
  ) {}

  async scanFull(remoteRootPath: string): Promise<RemoteReconcileOutcome> {
    return await this.mutex.runExclusive(async () => {
      if (this.closed) throw new Error("Remote inventory service is closed.");
      this.status = "scanning";
      this.lastError = null;
      try {
        const scan = await this.scanner.scanFull(remoteRootPath);
        if (this.closed) throw new Error("Remote inventory service closed during discovery.");
        await this.beforeReconcile?.(scan);
        if (this.closed) throw new Error("Remote inventory service closed before reconciliation.");
        const stats = await this.reconciler.applyFullScan(scan);
        this.directoriesVisited = scan.directoriesVisited;
        this.issueCount = scan.issues.length;
        this.lastScanComplete = scan.trust === "authoritative";
        this.lastCompletedAt = scan.finishedAt;
        this.lastRootPath = scan.rootPath;
        this.lastMetrics = scan.metrics ?? null;
        this.status = scan.trust === "authoritative" ? "ready" : "degraded";
        return { scan, stats };
      } catch (error) {
        this.status = this.closed ? "closed" : "degraded";
        this.lastScanComplete = false;
        this.lastError = errorMessage(error);
        this.logger.error("remote.scan-failed", { error: this.lastError });
        throw error;
      }
    });
  }

  summary(): RemoteInventoryRuntimeSummary {
    const state = this.state.getState();
    return {
      status: this.closed ? "closed" : this.status,
      trackedRemoteFiles: Object.values(state.files).filter((record) =>
        record.remote !== null && (!this.policy || this.policy.isIncluded(record.remote.path))
      ).length,
      directoriesVisited: this.directoriesVisited,
      scanProgress: this.status === "scanning" ? this.scanner.progress() : null,
      issueCount: this.issueCount,
      lastScanComplete: this.lastScanComplete,
      lastCompletedAt: this.lastCompletedAt,
      lastRootPath: this.lastRootPath,
      lastError: this.lastError,
      lastMetrics: this.lastMetrics ? structuredClone(this.lastMetrics) : null
    };
  }

  progressSummary(): Pick<RemoteInventoryRuntimeSummary, "status" | "scanProgress"> {
    return {
      status: this.closed ? "closed" : this.status,
      scanProgress: this.status === "scanning" ? this.scanner.progress() : null
    };
  }

  close(): void { this.closed = true; this.status = "closed"; }
}
