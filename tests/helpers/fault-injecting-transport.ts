import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/network/http-client";

export type FaultPhase = "before" | "after";
export type FaultAction =
  | { kind: "throw"; message: string }
  | { kind: "status"; status: number; headers?: Record<string, string> }
  | { kind: "truncate-body"; bytes: number };

export interface TransportFaultRule {
  id: string;
  method?: string;
  urlIncludes?: string;
  phase: FaultPhase;
  occurrence?: number;
  times?: number;
  action: FaultAction;
}

/**
 * Deterministic adversarial wrapper used by Stage-8 chaos tests.
 *
 * "after" faults call the delegate first and then hide the committed result,
 * which models the most dangerous class of sync failure: the server applied a
 * mutation but the client only observed a transport error.
 */
export class FaultInjectingTransport implements HttpTransport {
  private readonly seen = new Map<string, number>();
  private readonly fired = new Map<string, number>();

  constructor(
    private readonly delegate: HttpTransport,
    private readonly rules: readonly TransportFaultRule[]
  ) {}

  hitCount(id: string): number { return this.fired.get(id) ?? 0; }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const before = this.match(request, "before");
    if (before) return await this.applyBefore(before, request);

    const response = await this.delegate.request(request);
    const after = this.match(request, "after");
    return after ? this.applyAfter(after, response) : response;
  }

  private match(request: HttpRequest, phase: FaultPhase): TransportFaultRule | null {
    const method = (request.method ?? "GET").toUpperCase();
    for (const rule of this.rules) {
      if (rule.phase !== phase) continue;
      if (rule.method && rule.method.toUpperCase() !== method) continue;
      if (rule.urlIncludes && !request.url.includes(rule.urlIncludes)) continue;
      const key = `${rule.id}:${phase}`;
      const seen = (this.seen.get(key) ?? 0) + 1;
      this.seen.set(key, seen);
      const occurrence = rule.occurrence ?? 1;
      const maxFires = rule.times ?? 1;
      const fired = this.fired.get(rule.id) ?? 0;
      if (seen < occurrence || fired >= maxFires) continue;
      this.fired.set(rule.id, fired + 1);
      return rule;
    }
    return null;
  }

  private async applyBefore(rule: TransportFaultRule, request: HttpRequest): Promise<HttpResponse> {
    if (rule.action.kind === "throw") throw new Error(rule.action.message);
    if (rule.action.kind === "status") return response(rule.action.status, rule.action.headers ?? {});
    throw new Error(`Fault '${rule.id}' cannot truncate a response before request dispatch (${request.url}).`);
  }

  private applyAfter(rule: TransportFaultRule, responseValue: HttpResponse): HttpResponse {
    if (rule.action.kind === "throw") throw new Error(rule.action.message);
    if (rule.action.kind === "status") return response(rule.action.status, rule.action.headers ?? {});
    const remove = rule.action.bytes;
    if (!Number.isSafeInteger(remove) || remove <= 0) throw new Error(`Fault '${rule.id}' has an invalid truncation size.`);
    if (responseValue.arrayBuffer.byteLength < remove) throw new Error(`Fault '${rule.id}' cannot truncate beyond the response body.`);
    const truncated = responseValue.arrayBuffer.slice(0, responseValue.arrayBuffer.byteLength - remove);
    const text = new TextDecoder().decode(truncated);
    return {
      status: responseValue.status,
      headers: { ...responseValue.headers },
      arrayBuffer: truncated,
      text,
      json: () => JSON.parse(text) as unknown
    };
  }
}

function response(status: number, headers: Record<string, string>): HttpResponse {
  const body = new ArrayBuffer(0);
  return { status, headers, text: "", arrayBuffer: body, json: () => null };
}
