import type { SyncPlan } from "../planner/types";

export interface BootstrapAssessment {
  localFiles: number;
  remoteFiles: number;
  plan: SyncPlan;
  canPublish: boolean;
  canDownload: boolean;
  publishReason: string;
  downloadReason: string;
}
