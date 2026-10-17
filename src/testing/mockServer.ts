import { delay, http, HttpResponse, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";

export type MockServerScenario =
  | "success"
  | "timeout"
  | "error"
  | "rate-limit"
  | "malformed"
  | "fee_surge"
  | "rate_limited"
  | "slow_rpc"
  | "degraded";
export interface MockServerOptions {
  scenario?: MockServerScenario;
  delay?: number;
  overrides?: Partial<Record<string, JsonBodyType>>;
}

let scenario: MockServerScenario = "success";
let responseDelay = 0;
let overrides: Partial<Record<string, JsonBodyType>> = {};

function payload(endpoint: string, fallback: JsonBodyType): JsonBodyType {
  return overrides[endpoint] ?? fallback;
}

async function respond(endpoint: string, fallback: JsonBodyType): Promise<Response> {
  if (scenario === "timeout" || scenario === "slow_rpc") await delay(responseDelay || 5_000);
  if (scenario === "error") return HttpResponse.json({ error: "Mock server error" }, { status: 500 });
  if (scenario === "rate-limit" || scenario === "rate_limited") {
    return HttpResponse.json({ code: "RATE_LIMIT_EXCEEDED", error: "Rate limit exceeded" }, { status: 429 });
  }
  if (scenario === "degraded") {
    return HttpResponse.json({ code: "SERVICE_DEGRADED", error: "Mock service is degraded" }, { status: 503 });
  }
  if (scenario === "malformed") return HttpResponse.text("{ malformed json", { status: 200 });
  if (scenario === "fee_surge") {
    if (endpoint === "simulateTransaction") {
      return HttpResponse.json({ results: [], minResourceFee: "1000" });
    }
    if (endpoint === "sendTransaction") {
      return HttpResponse.json({ status: "PENDING", hash: "mock-hash", feeCharged: "1000" });
    }
  }
  return HttpResponse.json(payload(endpoint, fallback));
}

const horizonHandlers = [
  http.get("*/accounts/:publicKey", ({ params }) => respond("accounts", { id: params.publicKey, balances: [] })),
  http.get("*/transactions", () => respond("transactions", { records: [] })),
  http.get("*/operations", () => respond("operations", { records: [] })),
  http.get("*/trades", () => respond("trades", { records: [] })),
  http.get("*/offers", () => respond("offers", { records: [] })),
];

const rpcHandlers = [
  http.post("*/simulateTransaction", () => respond("simulateTransaction", { results: [], minResourceFee: "0" })),
  http.post("*/sendTransaction", () => respond("sendTransaction", { status: "PENDING", hash: "mock-hash" })),
  http.post("*/getEvents", () => respond("getEvents", { events: [] })),
];

const server = setupServer(...horizonHandlers, ...rpcHandlers);

export function setupMockServer(options: MockServerOptions = {}): void {
  scenario = options.scenario ?? "success";
  responseDelay = options.delay ?? 0;
  overrides = options.overrides ?? {};
  server.listen({ onUnhandledRequest: "bypass" });
}

export function setupMockServerScenario(nextScenario: MockServerScenario, options: Omit<MockServerOptions, "scenario"> = {}): void {
  scenario = nextScenario;
  responseDelay = options.delay ?? responseDelay;
  overrides = options.overrides ?? overrides;
}

/** Change the active response mode without restarting the MSW server. */
export function setResponseMode(
  nextScenario: MockServerScenario,
  options: Omit<MockServerOptions, "scenario"> = {},
): void {
  setupMockServerScenario(nextScenario, options);
}

export function teardownMockServer(): void {
  server.close();
  scenario = "success";
  responseDelay = 0;
  overrides = {};
}

export { server as mockServer };
