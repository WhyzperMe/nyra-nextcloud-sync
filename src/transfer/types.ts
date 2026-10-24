export type TransferKind = "chunked-create" | "chunked-update";
export type TransferPhase =
  | "prepared"
  | "upload-created"
  | "uploading"
  | "assembling"
  | "temp-ready"
  | "backup-moving"
  | "backup-ready"
  | "installing"
  | "installed"
  | "verified"
  | "complete";

export interface TransferTuning {
  chunkUploadThresholdBytes: number;
  uploadChunkBytes: number;
  downloadRangeChunkBytes: number;
  maxWholeDownloadBytes: number;
}

export interface TransferJournalPayload {
  version: 1;
  operationKey: string;
  operationId: string;
  kind: TransferKind;
  phase: TransferPhase;
  targetPath: string;
  targetUrl: string;
  tempPath: string;
  tempUrl: string;
  backupPath: string | null;
  backupUrl: string | null;
  uploadId: string;
  uploadUrl: string;
  sourceHash: string;
  sourceSize: number;
  chunkSize: number;
  chunkCount: number;
  uploadedChunks: number[];
  expectedTargetFileId: string | null;
  expectedTargetEtag: string | null;
  tempFileId: string | null;
  tempEtag: string | null;
  backupFileId: string | null;
  backupEtag: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransferJournalRecord extends TransferJournalPayload {
  sequence: number;
  previousHash: string | null;
  recordHash: string;
}

export interface TransferRecoveryReport {
  inspected: number;
  recovered: number;
  remoteChanged: boolean;
  messages: string[];
}
