import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { NyraError, errorMessage } from "../core/errors";
import type { Logger } from "../diagnostics/logger";
import { safeUrlForLog } from "../security/redaction";

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
  /**
   * Optional operation-specific timeout. `null` disables the synthetic timeout.
   * Obsidian requestUrl is not cancellable, so mutation methods default to no
   * synthetic timeout: abandoning an in-flight write could let it commit later
   * after the caller has already reconciled an apparently failed operation.
   */
  timeoutMs?: number | null;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
  json(): unknown;
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export class HttpClient implements HttpTransport {
  constructor(
    private readonly logger: Logger,
    private readonly timeoutMs = 30_000
  ) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    const method = request.method ?? "GET";
    this.logger.debug("http.request", {
      method,
      url: safeUrlForLog(request.url),
      headers: request.headers
    });

    const params: RequestUrlParam = {
      url: request.url,
      method,
      throw: false
    };
    if (request.headers !== undefined) params.headers = request.headers;
    if (request.body !== undefined) params.body = request.body;
    if (request.contentType !== undefined) params.contentType = request.contentType;

    let response: RequestUrlResponse;
    try {
      const configuredTimeout = request.timeoutMs === undefined
        ? (isAmbiguousMutationMethod(method) ? null : this.timeoutMs)
        : request.timeoutMs;
      response = configuredTimeout === null
        ? await requestUrl(params)
        : await withTimeout(
          requestUrl(params),
          configuredTimeout,
          `Network request timed out after ${configuredTimeout} ms.`
        );
    } catch (error) {
      throw new NyraError(
        "network-error",
        `Network request failed for ${safeUrlForLog(request.url)}: ${errorMessage(error)}`,
        error
      );
    }

    this.logger.debug("http.response", {
      method,
      url: safeUrlForLog(request.url),
      status: response.status
    });

    const text = response.text;
    return {
      status: response.status,
      headers: response.headers,
      text,
      arrayBuffer: response.arrayBuffer,
      json: () => {
        try {
          return JSON.parse(text) as unknown;
        } catch (error) {
          throw new NyraError(
            "network-error",
            `Expected JSON from ${safeUrlForLog(request.url)}, but the response was not valid JSON.`,
            error
          );
        }
      }
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}

function isAmbiguousMutationMethod(method: string): boolean {
  return method === "PUT" || method === "MOVE" || method === "DELETE" || method === "MKCOL" || method === "COPY" || method === "PATCH";
}
