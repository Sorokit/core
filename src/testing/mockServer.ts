import { delay, http, HttpResponse, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";

export type MockServerScenario = "success" | "timeout" | "error" | "rate-limit" | "malformed";
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
  if (scenario === "timeout") await delay(responseDelay || 5_000);
  if (scenario === "error") return HttpResponse.json({ error: "Mock server error" }, { status: 500 });
  if (scenario === "rate-limit") return HttpResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  if (scenario === "malformed") return HttpResponse.text("{ malformed json", { status: 200 });
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

export function teardownMockServer(): void {
  server.close();
  scenario = "success";
  responseDelay = 0;
  overrides = {};
}

export { server as mockServer };
