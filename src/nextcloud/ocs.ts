import { NyraError } from "../core/errors";

interface OcsEnvelope {
  ocs?: {
    meta?: {
      status?: string;
      statuscode?: number;
      message?: string;
    };
    data?: unknown;
  };
}

export function unwrapOcsData(payload: unknown, context: string): unknown {
  if (!isRecord(payload)) {
    throw new NyraError("ocs-verification-failed", `${context} returned invalid JSON.`);
  }

  const envelope = payload as OcsEnvelope;
  const ocs = envelope.ocs;
  if (!ocs || !ocs.meta) {
    throw new NyraError("ocs-verification-failed", `${context} did not return an OCS envelope.`);
  }

  const statusCode = Number(ocs.meta.statuscode ?? 0);
  const status = String(ocs.meta.status ?? "");
  if ((statusCode !== 100 && statusCode !== 200) || status.toLowerCase() !== "ok") {
    const message = String(ocs.meta.message ?? "Unknown OCS error");
    throw new NyraError("ocs-verification-failed", `${context} failed: ${message}`);
  }

  return ocs.data;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
