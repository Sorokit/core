/**
 * SDK health checks, diagnostics, and dependency status reporting (#527).
 *
 * Applications had no unified way to tell whether their SDK environment was
 * working. Failures can originate from Horizon, Soroban RPC, a wallet adapter,
 * configuration, or network selection, and each had to be probed by hand.
 *
 * {@link checkSdkHealth} runs a lightweight status sweep;
 * {@link runDiagnostics} performs deeper checks and returns actionable
 * recommendations. Every individual check is exported so an application can
 * run only the ones relevant to its environment.
 *
 * Diagnostics are strictly read-only: no check connects a wallet, switches a
 * network, signs anything, or writes to SDK state, and no check reports a
 * private key, secret, or other sensitive wallet data.
 */

import { SDK_VERSION } from "./constants";
import { isBrowser } from "./environment";
import { NETWORK_DEFAULTS } from "../network/config";
import type { NetworkType } from "../network/config";
import type { WalletAdapter } from "../wallet/types";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Status of a single check or of the SDK overall.
 *
 * - `healthy` — working normally.
 * - `degraded` — usable, but something is wrong or slow.
 * - `unavailable` — not usable.
 * - `skipped` — not applicable to this environment, so not evaluated.
 */
export type DiagnosticHealthStatus =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "skipped";

/** Identifier for each built-in check. */
export type DiagnosticCheckId =
  | "horizon"
  | "sorobanRpc"
  | "walletAdapter"
  | "networkConfig"
  | "environment";

/** The outcome of one check. */
export interface DiagnosticCheckResult {
  /** Which check produced this result. */
  id: DiagnosticCheckId;
  /** Human-readable check name. */
  name: string;
  status: DiagnosticHealthStatus;
  /** One-line summary of the outcome. */
  message: string;
  /**
   * Round-trip latency in milliseconds for checks that contact an external
   * dependency, or null for local checks and for checks that never ran.
   */
  latencyMs: number | null;
  /** Specific problems found. */
  issues: string[];
  /** Actionable steps to resolve the issues, where one can be given. */
  recommendations: string[];
}

/** Lightweight overall SDK health report. */
export interface SdkHealthReport {
  /** Worst status across all checks that ran. */
  status: DiagnosticHealthStatus;
  /** SDK version this report came from. */
  version: string;
  /** Network the checks were run against, or null when unresolved. */
  network: NetworkType | null;
  /** ISO-8601 timestamp of the report. */
  timestamp: string;
  /** Individual check results. */
  checks: DiagnosticCheckResult[];
}

/** Deeper diagnostic report with aggregated guidance. */
export interface DiagnosticsReport extends SdkHealthReport {
  /** Every issue found, across all checks. */
  issues: string[];
  /** Every recommendation, de-duplicated, across all checks. */
  recommendations: string[];
  /** Count of checks by resulting status. */
  summary: Record<DiagnosticHealthStatus, number>;
}

/** Shared options for the connectivity checks. */
export interface EndpointCheckOptions {
  /** Per-request timeout in milliseconds. Default: 5000. */
  timeoutMs?: number;
  /** Fetch implementation override — required outside a browser/Node 18+. */
  fetchFn?: typeof fetch;
  /** Latency above which an endpoint is reported as degraded. Default: 1500. */
  slowLatencyMs?: number;
}

/** Options shared by {@link checkSdkHealth} and {@link runDiagnostics}. */
export interface SdkHealthOptions extends EndpointCheckOptions {
  /** Network to check. Default: "testnet". */
  network?: NetworkType;
  /** Horizon URL override. Defaults to the network's configured URL. */
  horizonUrl?: string;
  /** Soroban RPC URL override. Defaults to the network's configured URL. */
  rpcUrl?: string;
  /** Wallet adapter to inspect. Omit to skip the wallet check. */
  walletAdapter?: WalletAdapter;
  /** Expected network passphrase, checked against the resolved config. */
  expectedNetworkPassphrase?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default per-endpoint timeout for diagnostic requests. */
export const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 5000;

/** Default latency above which an endpoint is considered degraded. */
export const DEFAULT_SLOW_LATENCY_MS = 1500;

/** Ranking used to reduce individual check statuses to an overall status. */
const STATUS_SEVERITY: Record<DiagnosticHealthStatus, number> = {
  skipped: 0,
  healthy: 1,
  degraded: 2,
  unavailable: 3,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveFetch(fetchFn?: typeof fetch): typeof fetch | undefined {
  if (fetchFn) return fetchFn;
  return typeof fetch !== "undefined" ? fetch : undefined;
}

/**
 * Reduce individual check statuses to one overall status.
 *
 * Skipped checks are ignored — a check that did not apply is not evidence of
 * health or of failure. When every check was skipped the result is `skipped`.
 */
export function combineHealthStatuses(
  statuses: DiagnosticHealthStatus[],
): DiagnosticHealthStatus {
  let worst: DiagnosticHealthStatus = "skipped";
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) {
      worst = status;
    }
  }
  return worst;
}

interface PingOutcome {
  reachable: boolean;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
  timedOut: boolean;
}

/**
 * Issue a single timed request, never throwing.
 *
 * A timeout is distinguished from a transport failure so the caller can
 * recommend raising the timeout rather than chasing a connectivity problem.
 */
async function ping(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  init?: RequestInit,
): Promise<PingOutcome> {
  const start = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "GET",
      ...init,
      signal: controller.signal,
    });
    return {
      reachable: response.ok,
      latencyMs: Date.now() - start,
      httpStatus: response.status,
      timedOut: false,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (cause) {
    return {
      reachable: false,
      latencyMs: Date.now() - start,
      timedOut,
      error: timedOut
        ? `Request timed out after ${timeoutMs}ms`
        : cause instanceof Error
          ? cause.message
          : String(cause),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function noFetchResult(
  id: DiagnosticCheckId,
  name: string,
): DiagnosticCheckResult {
  return {
    id,
    name,
    status: "unavailable",
    message: "No fetch implementation available.",
    latencyMs: null,
    issues: ["The runtime provides no global fetch."],
    recommendations: [
      "Pass options.fetchFn, or run on Node 18+ where fetch is global.",
    ],
  };
}

/** Build a connectivity check result from a ping outcome. */
function endpointResult(
  id: DiagnosticCheckId,
  name: string,
  label: string,
  outcome: PingOutcome,
  slowLatencyMs: number,
): DiagnosticCheckResult {
  const issues: string[] = [];
  const recommendations: string[] = [];

  if (outcome.timedOut) {
    issues.push(`${label} timed out: ${outcome.error ?? "unknown"}`);
    recommendations.push(
      `Raise options.timeoutMs, or check whether ${label} is reachable from this network.`,
    );
    return {
      id,
      name,
      status: "unavailable",
      message: `${label} timed out.`,
      latencyMs: outcome.latencyMs,
      issues,
      recommendations,
    };
  }

  if (!outcome.reachable) {
    issues.push(`${label} unreachable: ${outcome.error ?? "unknown"}`);
    recommendations.push(
      `Verify the ${label} URL is correct and the service is up.`,
    );
    return {
      id,
      name,
      status: "unavailable",
      message: `${label} is unreachable.`,
      latencyMs: outcome.latencyMs,
      issues,
      recommendations,
    };
  }

  if (outcome.latencyMs > slowLatencyMs) {
    issues.push(
      `${label} responded in ${outcome.latencyMs}ms, above the ${slowLatencyMs}ms threshold.`,
    );
    recommendations.push(
      `Consider a geographically closer or less loaded ${label} provider.`,
    );
    return {
      id,
      name,
      status: "degraded",
      message: `${label} is reachable but slow.`,
      latencyMs: outcome.latencyMs,
      issues,
      recommendations,
    };
  }

  return {
    id,
    name,
    status: "healthy",
    message: `${label} is reachable.`,
    latencyMs: outcome.latencyMs,
    issues,
    recommendations,
  };
}

// ─── Individual checks ───────────────────────────────────────────────────────

/**
 * Check Horizon connectivity and capture response latency.
 *
 * Requests a single ledger, the cheapest endpoint that proves Horizon is both
 * reachable and serving data.
 */
export async function checkHorizonConnectivity(
  horizonUrl: string,
  options: EndpointCheckOptions = {},
): Promise<DiagnosticCheckResult> {
  const fetchFn = resolveFetch(options.fetchFn);
  if (!fetchFn) return noFetchResult("horizon", "Horizon connectivity");

  const timeoutMs = options.timeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS;
  const slowLatencyMs = options.slowLatencyMs ?? DEFAULT_SLOW_LATENCY_MS;
  const url = `${horizonUrl.replace(/\/$/, "")}/ledgers?limit=1`;

  const outcome = await ping(url, fetchFn, timeoutMs);
  return endpointResult(
    "horizon",
    "Horizon connectivity",
    "Horizon",
    outcome,
    slowLatencyMs,
  );
}

/**
 * Check Soroban RPC connectivity and capture response latency.
 *
 * Calls `getHealth`, the RPC's own liveness method, rather than merely opening
 * a socket, so a running-but-unhealthy node is reported as such.
 */
export async function checkSorobanRpcConnectivity(
  rpcUrl: string,
  options: EndpointCheckOptions = {},
): Promise<DiagnosticCheckResult> {
  const fetchFn = resolveFetch(options.fetchFn);
  if (!fetchFn) return noFetchResult("sorobanRpc", "Soroban RPC connectivity");

  const timeoutMs = options.timeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS;
  const slowLatencyMs = options.slowLatencyMs ?? DEFAULT_SLOW_LATENCY_MS;

  const outcome = await ping(rpcUrl, fetchFn, timeoutMs, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  });

  return endpointResult(
    "sorobanRpc",
    "Soroban RPC connectivity",
    "Soroban RPC",
    outcome,
    slowLatencyMs,
  );
}

/**
 * Check the configured wallet adapter's availability.
 *
 * Only `isAvailable()` is called: connecting would prompt the user and mutate
 * application state, which a diagnostic must never do. No key, address, or
 * other wallet secret is read or reported.
 */
export function checkWalletAdapterStatus(
  adapter?: WalletAdapter,
): DiagnosticCheckResult {
  const name = "Wallet adapter";

  if (!adapter) {
    return {
      id: "walletAdapter",
      name,
      status: "skipped",
      message: "No wallet adapter configured.",
      latencyMs: null,
      issues: [],
      recommendations: [],
    };
  }

  let available: boolean;
  try {
    available = adapter.isAvailable();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      id: "walletAdapter",
      name,
      status: "unavailable",
      message: "Wallet adapter availability check threw.",
      latencyMs: null,
      issues: [`Adapter "${adapter.walletType}" threw: ${detail}`],
      recommendations: [
        "Confirm the adapter is constructed correctly and its extension API is present.",
      ],
    };
  }

  if (!available) {
    const recommendations = isBrowser()
      ? [`Install or enable the ${adapter.walletType} extension, then reload.`]
      : [
          `${adapter.walletType} requires a browser environment; wallet operations are unavailable here.`,
        ];
    return {
      id: "walletAdapter",
      name,
      status: "unavailable",
      message: `Wallet "${adapter.walletType}" is not available.`,
      latencyMs: null,
      issues: [`Adapter "${adapter.walletType}" reports it is not available.`],
      recommendations,
    };
  }

  return {
    id: "walletAdapter",
    name,
    status: "healthy",
    message: `Wallet "${adapter.walletType}" is available.`,
    latencyMs: null,
    issues: [],
    recommendations: [],
  };
}

/**
 * Validate network and endpoint configuration without contacting anything.
 *
 * Catches the misconfigurations that otherwise surface as confusing runtime
 * failures: an unknown network, a malformed URL, plaintext HTTP against
 * mainnet, and a passphrase that does not match the selected network.
 */
export function checkNetworkConfiguration(
  options: {
    network?: NetworkType;
    horizonUrl?: string;
    rpcUrl?: string;
    expectedNetworkPassphrase?: string;
  } = {},
): DiagnosticCheckResult {
  const name = "Network configuration";
  const issues: string[] = [];
  const recommendations: string[] = [];

  const network = options.network ?? "testnet";
  const defaults = NETWORK_DEFAULTS[network] as
    | (typeof NETWORK_DEFAULTS)[NetworkType]
    | undefined;

  if (!defaults) {
    return {
      id: "networkConfig",
      name,
      status: "unavailable",
      message: `Unknown network "${network}".`,
      latencyMs: null,
      issues: [`"${network}" is not a supported network.`],
      recommendations: [
        `Use one of: ${Object.keys(NETWORK_DEFAULTS).join(", ")}.`,
      ],
    };
  }

  const horizonUrl = options.horizonUrl ?? defaults.horizonUrl;
  const rpcUrl = options.rpcUrl ?? defaults.rpcUrl;

  for (const [label, url] of [
    ["Horizon", horizonUrl],
    ["Soroban RPC", rpcUrl],
  ] as const) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      issues.push(`${label} URL is not a valid URL: "${url}".`);
      recommendations.push(`Provide an absolute ${label} URL including scheme.`);
      continue;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      issues.push(`${label} URL uses unsupported scheme "${parsed.protocol}".`);
      recommendations.push(`Use an http:// or https:// ${label} URL.`);
      continue;
    }

    // Plaintext against mainnet exposes live traffic to tampering; on test
    // networks it is a normal local-development setup.
    if (parsed.protocol === "http:" && network === "mainnet") {
      issues.push(`${label} URL uses plaintext HTTP on mainnet.`);
      recommendations.push(`Use an https:// ${label} URL on mainnet.`);
    }
  }

  if (
    options.expectedNetworkPassphrase !== undefined &&
    options.expectedNetworkPassphrase !== defaults.networkPassphrase
  ) {
    issues.push(
      `Configured passphrase does not match the "${network}" network passphrase.`,
    );
    recommendations.push(
      `Set the passphrase to "${defaults.networkPassphrase}" or select the matching network.`,
    );
  }

  if (issues.length > 0) {
    // A mismatched passphrase makes every signature invalid for the target
    // network, so it is unusable rather than merely degraded.
    const unusable = issues.some((issue) =>
      issue.includes("passphrase does not match"),
    );
    return {
      id: "networkConfig",
      name,
      status: unusable ? "unavailable" : "degraded",
      message: `Network configuration for "${network}" has ${issues.length} issue(s).`,
      latencyMs: null,
      issues,
      recommendations,
    };
  }

  return {
    id: "networkConfig",
    name,
    status: "healthy",
    message: `Network configuration for "${network}" is valid.`,
    latencyMs: null,
    issues: [],
    recommendations: [],
  };
}

/**
 * Check the local runtime for the capabilities the SDK depends on.
 *
 * Reports only capability presence — never environment variables, tokens, or
 * any other value that could carry a secret.
 */
export function checkEnvironment(
  options: { fetchFn?: typeof fetch } = {},
): DiagnosticCheckResult {
  const issues: string[] = [];
  const recommendations: string[] = [];

  if (!resolveFetch(options.fetchFn)) {
    issues.push("No global fetch implementation is available.");
    recommendations.push(
      "Run on Node 18+ or pass options.fetchFn with a fetch-compatible implementation.",
    );
  }

  if (typeof AbortController === "undefined") {
    issues.push("AbortController is unavailable, so request timeouts cannot be enforced.");
    recommendations.push("Upgrade the runtime or load an AbortController polyfill.");
  }

  return {
    id: "environment",
    name: "Runtime environment",
    // The SDK still performs offline work without fetch, so a missing
    // capability degrades it rather than making it entirely unusable.
    status: issues.length > 0 ? "degraded" : "healthy",
    message:
      issues.length > 0
        ? `Runtime is missing ${issues.length} capability/capabilities.`
        : `Runtime (${isBrowser() ? "browser" : "non-browser"}) supports all required capabilities.`,
    latencyMs: null,
    issues,
    recommendations,
  };
}

// ─── Aggregate reports ───────────────────────────────────────────────────────

function resolveEndpoints(options: SdkHealthOptions): {
  network: NetworkType;
  horizonUrl: string;
  rpcUrl: string;
} {
  const network = options.network ?? "testnet";
  const defaults = NETWORK_DEFAULTS[network] ?? NETWORK_DEFAULTS.testnet;
  return {
    network,
    horizonUrl: options.horizonUrl ?? defaults.horizonUrl,
    rpcUrl: options.rpcUrl ?? defaults.rpcUrl,
  };
}

/**
 * Run a lightweight SDK health check.
 *
 * Contacts Horizon and Soroban RPC once each, inspects the configured wallet
 * adapter, and validates network configuration. Checks run concurrently, so
 * the call costs roughly one endpoint round trip rather than two.
 *
 * The call is read-only and never throws: a failing dependency is reported in
 * the returned status, not raised.
 */
export async function checkSdkHealth(
  options: SdkHealthOptions = {},
): Promise<SdkHealthReport> {
  const { network, horizonUrl, rpcUrl } = resolveEndpoints(options);
  const endpointOptions: EndpointCheckOptions = {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    ...(options.slowLatencyMs === undefined
      ? {}
      : { slowLatencyMs: options.slowLatencyMs }),
  };

  const [horizon, rpc] = await Promise.all([
    checkHorizonConnectivity(horizonUrl, endpointOptions),
    checkSorobanRpcConnectivity(rpcUrl, endpointOptions),
  ]);

  const checks: DiagnosticCheckResult[] = [
    horizon,
    rpc,
    checkWalletAdapterStatus(options.walletAdapter),
    checkNetworkConfiguration({
      network,
      horizonUrl,
      rpcUrl,
      ...(options.expectedNetworkPassphrase === undefined
        ? {}
        : { expectedNetworkPassphrase: options.expectedNetworkPassphrase }),
    }),
  ];

  return {
    status: combineHealthStatuses(checks.map((check) => check.status)),
    version: SDK_VERSION,
    network,
    timestamp: new Date().toISOString(),
    checks,
  };
}

/**
 * Run deeper diagnostics and return actionable troubleshooting information.
 *
 * Extends {@link checkSdkHealth} with a runtime capability check and rolls all
 * findings up into de-duplicated issue and recommendation lists plus a count
 * of checks by status.
 *
 * Like every check here, this is read-only: it does not connect a wallet,
 * switch networks, or otherwise mutate application state, and it reports no
 * private keys, secrets, or wallet data.
 */
export async function runDiagnostics(
  options: SdkHealthOptions = {},
): Promise<DiagnosticsReport> {
  const health = await checkSdkHealth(options);
  const environment = checkEnvironment(
    options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn },
  );
  const checks = [...health.checks, environment];

  const issues: string[] = [];
  const recommendations: string[] = [];
  const summary: Record<DiagnosticHealthStatus, number> = {
    healthy: 0,
    degraded: 0,
    unavailable: 0,
    skipped: 0,
  };

  for (const check of checks) {
    summary[check.status] += 1;
    issues.push(...check.issues);
    for (const recommendation of check.recommendations) {
      // Several checks can suggest the same fix; report it once.
      if (!recommendations.includes(recommendation)) {
        recommendations.push(recommendation);
      }
    }
  }

  return {
    ...health,
    status: combineHealthStatuses(checks.map((check) => check.status)),
    checks,
    issues,
    recommendations,
    summary,
  };
}
