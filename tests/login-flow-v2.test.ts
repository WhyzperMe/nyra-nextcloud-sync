import { describe, expect, it } from "vitest";
import { LoginFlowV2 } from "../src/auth/login-flow-v2";
import type { Logger } from "../src/diagnostics/logger";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/network/http-client";

class QueueTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly responses: HttpResponse[]) {}
  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No mock response remains.");
    return response;
  }
}

function jsonResponse(status: number, value: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = JSON.stringify(value);
  return { status, headers, text, arrayBuffer: new TextEncoder().encode(text).buffer, json: () => value };
}

describe("Nextcloud Login Flow v2", () => {
  it("starts a versioned browser flow and polls for the generated app password", async () => {
    const http = new QueueTransport([
      jsonResponse(200, {
        poll: { token: "poll-secret", endpoint: "https://cloud.example.com/index.php/login/v2/poll" },
        login: "https://cloud.example.com/index.php/login/v2/flow/one-time-flow-secret"
      }),
      jsonResponse(200, { server: "https://cloud.example.com", loginName: "alice", appPassword: "client-app-password" })
    ]);
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const flow = new LoginFlowV2(http, logger, "0.12.0");
    const session = await flow.begin("https://cloud.example.com");

    expect(http.requests[0]?.headers?.["User-Agent"]).toBe("NyraNextcloudSync/0.12.0 (Obsidian)");
    expect(http.requests[0]?.url).toBe("https://cloud.example.com/index.php/login/v2");
    expect(session.loginUrl).toBe("https://cloud.example.com/index.php/login/v2/flow/one-time-flow-secret");
    const credentials = await flow.poll(session, { cancelled: false });
    expect(credentials.appPassword).toBe("client-app-password");
    expect(http.requests[1]?.body).toBe("token=poll-secret");
  });

  it("starts Login Flow at the server root when given a pasted WebDAV folder URL", async () => {
    const http = new QueueTransport([jsonResponse(200, {
      poll: { token: "poll-secret", endpoint: "https://cloud.example.com/nextcloud/index.php/login/v2/poll" },
      login: "https://cloud.example.com/nextcloud/index.php/login/v2/flow/session"
    })]);
    const flow = new LoginFlowV2(http, { debug() {}, info() {}, warn() {}, error() {} }, "0.15.0");

    await flow.begin("https://cloud.example.com/nextcloud/remote.php/dav/files/alice/Obsidian");

    expect(http.requests[0]?.url).toBe("https://cloud.example.com/nextcloud/index.php/login/v2");
  });

  it("explains the server-base URL and Login Flow requirement on HTTP 401", async () => {
    const http = new QueueTransport([jsonResponse(401, null)]);
    const flow = new LoginFlowV2(http, { debug() {}, info() {}, warn() {}, error() {} }, "0.15.0");

    await expect(flow.begin("https://cloud.example.com"))
      .rejects.toThrow(/server base URL.*Login Flow v2 is enabled/i);
  });

  it("rejects a login page URL outside the configured Nextcloud origin", async () => {
    const http = new QueueTransport([jsonResponse(200, {
      poll: { token: "poll-secret", endpoint: "https://cloud.example.com/index.php/login/v2/poll" },
      login: "https://attacker.example/login"
    })]);
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    await expect(new LoginFlowV2(http, logger, "0.12.0").begin("https://cloud.example.com"))
      .rejects.toThrow(/different origin/i);
    expect(http.requests.length).toBe(1);
  });

  it("rejects a poll endpoint outside the verified origin before polling", async () => {
    const http = new QueueTransport([jsonResponse(200, {
      poll: { token: "poll-secret", endpoint: "https://attacker.example/poll" },
      login: "https://cloud.example.com/login"
    })]);
    const flow = new LoginFlowV2(http, { debug() {}, info() {}, warn() {}, error() {} }, "0.14.0");
    await expect(flow.begin("https://cloud.example.com")).rejects.toThrow(/different origin/i);
    expect(http.requests).toHaveLength(1);
  });

  it("backs off through pending and transient responses and honors Retry-After", async () => {
    const http = new QueueTransport([
      jsonResponse(404, null),
      jsonResponse(503, null, { "Retry-After": "2" }),
      jsonResponse(200, { server: "https://cloud.example.com", loginName: "alice", appPassword: "issued" })
    ]);
    const sleeps: number[] = [];
    const flow = new LoginFlowV2(http, { debug() {}, info() {}, warn() {}, error() {} }, "0.14.0", { sleep: async (ms) => { sleeps.push(ms); } });
    const credential = await flow.poll({
      trustedServerUrl: "https://cloud.example.com",
      loginUrl: "https://cloud.example.com/login",
      pollEndpoint: "https://cloud.example.com/poll",
      pollToken: "private-poll-token",
      expiresAt: Date.now() + 60_000
    }, { cancelled: false });
    expect(credential.appPassword).toBe("issued");
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(http.requests).toHaveLength(3);
  });

  it("rejects malformed credential payloads and cancellation received during a poll", async () => {
    const malformed = new QueueTransport([jsonResponse(200, { server: {}, loginName: "alice", appPassword: "issued" })]);
    const flow = new LoginFlowV2(malformed, { debug() {}, info() {}, warn() {}, error() {} }, "0.14.0");
    await expect(flow.poll({
      trustedServerUrl: "https://cloud.example.com", loginUrl: "https://cloud.example.com/login",
      pollEndpoint: "https://cloud.example.com/poll", pollToken: "token", expiresAt: Date.now() + 60_000
    }, { cancelled: false })).rejects.toThrow(/incomplete credentials/i);

    let cancelled = false;
    const cancellingTransport: HttpTransport = {
      async request(request) {
        if (request.url.endsWith("/poll")) cancelled = true;
        return jsonResponse(200, { server: "https://cloud.example.com", loginName: "alice", appPassword: "issued" });
      }
    };
    const cancelledFlow = new LoginFlowV2(cancellingTransport, { debug() {}, info() {}, warn() {}, error() {} }, "0.14.0");
    await expect(cancelledFlow.poll({
      trustedServerUrl: "https://cloud.example.com", loginUrl: "https://cloud.example.com/login",
      pollEndpoint: "https://cloud.example.com/poll", pollToken: "token", expiresAt: Date.now() + 60_000
    }, { get cancelled() { return cancelled; } })).rejects.toThrow(/cancelled/i);
  });
});
