/**
 * On-chain governance: proposals, voting, voting power and proposal tracking (#686).
 *
 * Stellar has no single protocol-level governance contract, so this module is
 * deliberately **provider-based**: every operation goes through a
 * {@link GovernanceProvider}, which knows how to read proposals and submit
 * votes for a particular governance system (a Soroban DAO contract, an
 * indexer, a hosted API…). The SDK owns validation, normalisation, error
 * handling and polling; the provider owns transport and signing.
 *
 * - {@link createHttpGovernanceProvider} ships a ready-to-use provider for
 *   any service exposing the small REST contract documented on that function.
 * - {@link configureGovernance} installs a default provider; every function
 *   also accepts `options.provider` to override it per call (handy in tests
 *   and multi-DAO apps).
 *
 * Every public function returns a {@link SorokitResult} and never throws:
 * invalid input → `VALIDATION` / `INVALID_ADDRESS` / `INVALID_NETWORK`,
 * missing configuration → `INVALID_CONFIG`, provider/network failures →
 * `NETWORK_ERROR`, a vote that fails to submit → `TX_SUBMIT_FAILED`.
 *
 * ```ts
 * configureGovernance(createHttpGovernanceProvider({
 *   endpoints: { testnet: "https://gov.example.org/testnet" },
 * }));
 * const proposals = await getProposals("testnet");     // active proposals
 * const voted = await voteOnProposal(1, "yes", { voter: "G..." });
 * ```
 */

import { StrKey } from "@stellar/stellar-sdk";
import { SorokitErrorCode, err, ok } from "../shared/response";
import type { SorokitError, SorokitResult } from "../shared/response";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GovernanceNetwork = "mainnet" | "testnet" | "futurenet";
export type ProposalId = string | number;
export type VoteChoice = "yes" | "no" | "abstain";

export const PROPOSAL_STATUSES = [
  "pending",
  "active",
  "passed",
  "rejected",
  "executed",
  "cancelled",
  "expired",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Statuses after which a proposal can no longer change. */
export const TERMINAL_PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  "passed",
  "rejected",
  "executed",
  "cancelled",
  "expired",
];

export interface ProposalTally {
  yes: bigint;
  no: bigint;
  abstain: bigint;
}

export interface GovernanceProposal {
  id: ProposalId;
  title: string;
  status: ProposalStatus;
  description?: string;
  /** ISO-8601 time voting closes, when known. */
  endsAt?: string;
  /** Current vote weights, when the source reports them. */
  tally?: ProposalTally;
}

export interface VoteReceipt {
  proposalId: ProposalId;
  vote: VoteChoice;
  voter?: string;
  /** Hash of the submitted vote transaction. */
  txHash: string;
}

export interface VotingPower {
  publicKey: string;
  network: GovernanceNetwork;
  power: bigint;
}

/** Transport/signing adapter for a governance system. */
export interface GovernanceProvider {
  listProposals(network: GovernanceNetwork): Promise<unknown>;
  getProposal(network: GovernanceNetwork, id: ProposalId): Promise<unknown>;
  submitVote(input: {
    network: GovernanceNetwork;
    proposalId: ProposalId;
    vote: VoteChoice;
    voter?: string;
  }): Promise<unknown>;
  getVotingPower(network: GovernanceNetwork, publicKey: string): Promise<unknown>;
}

export interface GovernanceCallOptions {
  /** Defaults to the network configured with {@link configureGovernance} ("testnet"). */
  network?: GovernanceNetwork;
  /** Overrides the configured provider for this call. */
  provider?: GovernanceProvider;
}

// ─── Configuration ───────────────────────────────────────────────────────────

let defaultProvider: GovernanceProvider | null = null;
let defaultNetwork: GovernanceNetwork = "testnet";

/** Install (or clear, with `null`) the default governance provider. */
export function configureGovernance(
  provider: GovernanceProvider | null,
  options: { network?: GovernanceNetwork } = {},
): void {
  defaultProvider = provider;
  if (options.network) defaultNetwork = options.network;
}

/** Reset configuration to its initial state (mainly for tests). */
export function resetGovernance(): void {
  defaultProvider = null;
  defaultNetwork = "testnet";
}

// ─── Validation & normalisation ──────────────────────────────────────────────

const NETWORKS: readonly GovernanceNetwork[] = ["mainnet", "testnet", "futurenet"];
const VOTES: readonly VoteChoice[] = ["yes", "no", "abstain"];

/** Thrown internally for malformed provider data; converted to `VALIDATION`. */
class GovernanceDataError extends Error {}

type Resolved =
  | { ok: true; network: GovernanceNetwork; provider: GovernanceProvider }
  | { ok: false; error: SorokitResult<never> };

function resolve(options: GovernanceCallOptions | undefined, network?: unknown): Resolved {
  const net = network ?? options?.network ?? defaultNetwork;
  if (!NETWORKS.includes(net as GovernanceNetwork)) {
    return {
      ok: false,
      error: err(
        SorokitErrorCode.INVALID_NETWORK,
        `Unsupported governance network "${String(net)}"; expected one of ${NETWORKS.join(", ")}`,
      ),
    };
  }
  const provider = options?.provider ?? defaultProvider;
  if (!provider) {
    return {
      ok: false,
      error: err(
        SorokitErrorCode.INVALID_CONFIG,
        "No governance provider configured; call configureGovernance(...) or pass options.provider",
      ),
    };
  }
  return { ok: true, network: net as GovernanceNetwork, provider };
}

function isProposalId(value: unknown): value is ProposalId {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

function sameId(a: ProposalId, b: ProposalId): boolean {
  return String(a) === String(b);
}

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new GovernanceDataError(`${field} must be an integer`);
}

/** Validates and normalises one proposal returned by a provider. */
export function normalizeProposal(raw: unknown): GovernanceProposal {
  if (!raw || typeof raw !== "object") throw new GovernanceDataError("proposal must be an object");
  const r = raw as Record<string, unknown>;
  if (!isProposalId(r.id)) throw new GovernanceDataError("proposal.id is missing or invalid");
  if (typeof r.title !== "string" || !r.title.trim()) {
    throw new GovernanceDataError(`proposal ${String(r.id)} has no title`);
  }
  const status = typeof r.status === "string" ? r.status.toLowerCase() : "";
  if (!(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
    throw new GovernanceDataError(`proposal ${String(r.id)} has unknown status "${String(r.status)}"`);
  }

  const proposal: GovernanceProposal = { id: r.id, title: r.title.trim(), status: status as ProposalStatus };
  if (typeof r.description === "string") proposal.description = r.description;
  if (typeof r.endsAt === "string") proposal.endsAt = r.endsAt;
  const tally = (r.tally ?? r.votes) as Record<string, unknown> | undefined;
  if (tally && typeof tally === "object") {
    proposal.tally = {
      yes: toBigInt(tally.yes ?? 0, "tally.yes"),
      no: toBigInt(tally.no ?? 0, "tally.no"),
      abstain: toBigInt(tally.abstain ?? 0, "tally.abstain"),
    };
    if (proposal.tally.yes < 0n || proposal.tally.no < 0n || proposal.tally.abstain < 0n) {
      throw new GovernanceDataError(`proposal ${String(r.id)} has a negative tally`);
    }
  }
  return proposal;
}

function fail<T>(error: unknown, code: SorokitErrorCode, action: string): SorokitResult<T> {
  if (error instanceof GovernanceDataError) {
    return err(SorokitErrorCode.VALIDATION, `Invalid governance data: ${error.message}`, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return err(code, `Failed to ${action}: ${message}`, error);
}

// ─── Operations ──────────────────────────────────────────────────────────────

/**
 * Proposals on `network`. Returns only `active` proposals unless
 * `options.status` asks for others (`"all"` or a specific status).
 */
export async function getProposals(
  network?: GovernanceNetwork,
  options: GovernanceCallOptions & { status?: ProposalStatus | "all" } = {},
): Promise<SorokitResult<GovernanceProposal[]>> {
  const ctx = resolve(options, network);
  if (!ctx.ok) return ctx.error;
  const { provider, network: net } = ctx;
  const wanted = options.status ?? "active";
  if (wanted !== "all" && !(PROPOSAL_STATUSES as readonly string[]).includes(wanted)) {
    return err(SorokitErrorCode.VALIDATION, `Unknown proposal status filter "${String(wanted)}"`);
  }

  try {
    const raw = await provider.listProposals(net);
    const list = Array.isArray(raw) ? raw : (raw as { proposals?: unknown })?.proposals;
    if (!Array.isArray(list)) throw new GovernanceDataError("proposal list must be an array");
    const proposals = list.map(normalizeProposal);
    return ok(wanted === "all" ? proposals : proposals.filter((p) => p.status === wanted));
  } catch (error) {
    return fail(error, SorokitErrorCode.NETWORK_ERROR, "fetch governance proposals");
  }
}

/** A single proposal by id (any status). `NOT FOUND` maps to `VALIDATION`. */
export async function getProposal(
  proposalId: ProposalId,
  options: GovernanceCallOptions = {},
): Promise<SorokitResult<GovernanceProposal>> {
  if (!isProposalId(proposalId)) {
    return err(SorokitErrorCode.VALIDATION, "proposalId must be a non-negative integer or a non-empty string");
  }
  const ctx = resolve(options);
  if (!ctx.ok) return ctx.error;
  const { provider, network } = ctx;
  try {
    const raw = await provider.getProposal(network, proposalId);
    if (raw === null || raw === undefined) {
      return err(SorokitErrorCode.VALIDATION, `Proposal ${String(proposalId)} was not found`);
    }
    const proposal = normalizeProposal(raw);
    if (!sameId(proposal.id, proposalId)) {
      throw new GovernanceDataError(`provider returned proposal ${String(proposal.id)} for ${String(proposalId)}`);
    }
    return ok(proposal);
  } catch (error) {
    return fail(error, SorokitErrorCode.NETWORK_ERROR, `fetch proposal ${String(proposalId)}`);
  }
}

/**
 * Cast `vote` on `proposalId`. The proposal is re-read first and the vote is
 * refused unless it is `active`, so a closed proposal is never voted on.
 */
export async function voteOnProposal(
  proposalId: ProposalId,
  vote: VoteChoice | string,
  options: GovernanceCallOptions & { voter?: string } = {},
): Promise<SorokitResult<VoteReceipt>> {
  if (!isProposalId(proposalId)) {
    return err(SorokitErrorCode.VALIDATION, "proposalId must be a non-negative integer or a non-empty string");
  }
  const choice = typeof vote === "string" ? vote.trim().toLowerCase() : "";
  if (!(VOTES as readonly string[]).includes(choice)) {
    return err(SorokitErrorCode.VALIDATION, `Vote must be one of ${VOTES.join(", ")}`);
  }
  if (options.voter !== undefined && !StrKey.isValidEd25519PublicKey(options.voter)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, "voter must be a valid Stellar public key (G...)");
  }

  const current = await getProposal(proposalId, options);
  if (current.status === "error") return current;
  if (current.data.status !== "active") {
    return err(
      SorokitErrorCode.VALIDATION,
      `Proposal ${String(proposalId)} is ${current.data.status}; only active proposals accept votes`,
    );
  }

  const ctx = resolve(options);
  if (!ctx.ok) return ctx.error;
  try {
    // `voter` is omitted, not set to undefined (exactOptionalPropertyTypes).
    const voterField = options.voter !== undefined ? { voter: options.voter } : {};
    const raw = (await ctx.provider.submitVote({
      network: ctx.network,
      proposalId,
      vote: choice as VoteChoice,
      ...voterField,
    })) as { txHash?: unknown; hash?: unknown } | null;
    const txHash = raw?.txHash ?? raw?.hash;
    if (typeof txHash !== "string" || !txHash) {
      throw new GovernanceDataError("vote submission did not return a transaction hash");
    }
    return ok<VoteReceipt>({ proposalId, vote: choice as VoteChoice, ...voterField, txHash });
  } catch (error) {
    return fail(error, SorokitErrorCode.TX_SUBMIT_FAILED, `submit vote on proposal ${String(proposalId)}`);
  }
}

/** Voting weight of `publicKey` on the configured governance system. */
export async function getVotingPower(
  publicKey: string,
  options: GovernanceCallOptions = {},
): Promise<SorokitResult<VotingPower>> {
  if (typeof publicKey !== "string" || !StrKey.isValidEd25519PublicKey(publicKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, "publicKey must be a valid Stellar public key (G...)");
  }
  const ctx = resolve(options);
  if (!ctx.ok) return ctx.error;
  const { provider, network } = ctx;
  try {
    const raw = await provider.getVotingPower(network, publicKey);
    const value = raw !== null && typeof raw === "object" ? (raw as { power?: unknown }).power : raw;
    const power = toBigInt(value, "power");
    if (power < 0n) throw new GovernanceDataError("power must not be negative");
    return ok({ publicKey, network, power });
  } catch (error) {
    return fail(error, SorokitErrorCode.NETWORK_ERROR, "fetch voting power");
  }
}

// ─── Tracking ────────────────────────────────────────────────────────────────

export interface TrackProposalOptions extends GovernanceCallOptions {
  /** Called with the new state whenever status or tally changes. */
  onUpdate?: (proposal: GovernanceProposal) => void;
  /** Called for failed polls; tracking continues until `maxConsecutiveErrors`. */
  onError?: (error: SorokitError) => void;
  /** Poll interval in ms (minimum 1000, default 15000). */
  intervalMs?: number;
  /** Stop after this many consecutive failed polls (default 5). */
  maxConsecutiveErrors?: number;
  signal?: AbortSignal;
}

export interface ProposalTracker {
  /** Latest known state. */
  readonly current: GovernanceProposal;
  /** False once stopped, aborted, terminal, or out of retries. */
  readonly active: boolean;
  stop(): void;
}

function changed(a: GovernanceProposal, b: GovernanceProposal): boolean {
  return (
    a.status !== b.status ||
    a.endsAt !== b.endsAt ||
    a.tally?.yes !== b.tally?.yes ||
    a.tally?.no !== b.tally?.no ||
    a.tally?.abstain !== b.tally?.abstain
  );
}

/**
 * Poll `proposalId` and report changes via `onUpdate`. The initial state is
 * returned immediately; polling stops by itself once the proposal reaches a
 * terminal status, on `stop()`, on `signal` abort, or after
 * `maxConsecutiveErrors` failed polls in a row.
 */
export async function trackProposal(
  proposalId: ProposalId,
  options: TrackProposalOptions = {},
): Promise<SorokitResult<ProposalTracker>> {
  const intervalMs = options.intervalMs ?? 15_000;
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
    return err(SorokitErrorCode.VALIDATION, "intervalMs must be at least 1000");
  }
  const maxErrors = options.maxConsecutiveErrors ?? 5;
  if (!Number.isInteger(maxErrors) || maxErrors < 1) {
    return err(SorokitErrorCode.VALIDATION, "maxConsecutiveErrors must be a positive integer");
  }

  const initial = await getProposal(proposalId, options);
  if (initial.status === "error") return initial;

  let current = initial.data;
  let active = !TERMINAL_PROPOSAL_STATUSES.includes(current.status) && !options.signal?.aborted;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let errors = 0;

  const stop = () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  options.signal?.addEventListener("abort", stop, { once: true });

  const poll = async () => {
    timer = undefined;
    if (!active) return;
    const next = await getProposal(proposalId, options);
    if (!active) return;
    if (next.status === "error") {
      errors += 1;
      options.onError?.(next.error);
      if (errors >= maxErrors) return stop();
    } else {
      errors = 0;
      if (changed(current, next.data)) {
        current = next.data;
        options.onUpdate?.(current);
      }
      if (TERMINAL_PROPOSAL_STATUSES.includes(current.status)) return stop();
    }
    timer = setTimeout(() => void poll(), intervalMs);
  };

  if (active) timer = setTimeout(() => void poll(), intervalMs);

  return ok({
    get current() {
      return current;
    },
    get active() {
      return active;
    },
    stop,
  });
}

// ─── HTTP provider ───────────────────────────────────────────────────────────

export interface HttpGovernanceProviderOptions {
  /** Base URL per network, e.g. `{ testnet: "https://gov.example.org/testnet" }`. */
  endpoints: Partial<Record<GovernanceNetwork, string>>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * Provider for any service implementing this REST contract under a
 * per-network base URL:
 *
 * | Method | Path                         | Response |
 * |--------|------------------------------|----------|
 * | GET    | `/proposals`                 | `Proposal[]` or `{ proposals: Proposal[] }` |
 * | GET    | `/proposals/{id}`            | `Proposal` (404 → not found) |
 * | POST   | `/proposals/{id}/votes`      | body `{ vote, voter? }` → `{ txHash }` |
 * | GET    | `/voting-power/{publicKey}`  | `{ power }` (integer or integer string) |
 *
 * `Proposal` = `{ id, title, status, description?, endsAt?, tally?: { yes, no, abstain } }`.
 * Path segments are URL-encoded; requests time out after `timeoutMs` (10 s).
 */
export function createHttpGovernanceProvider(options: HttpGovernanceProviderOptions): GovernanceProvider {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const base = (network: GovernanceNetwork) => {
    const url = options.endpoints[network];
    if (!url) throw new Error(`No governance endpoint configured for ${network}`);
    return url.replace(/\/+$/, "");
  };

  const request = async (url: string, init: RequestInit = {}): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {
        ...init,
        headers: { Accept: "application/json", ...options.headers, ...(init.headers as Record<string, string>) },
        signal: controller.signal,
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const seg = (value: ProposalId | string) => encodeURIComponent(String(value));

  return {
    listProposals: (network) => request(`${base(network)}/proposals`),
    getProposal: (network, id) => request(`${base(network)}/proposals/${seg(id)}`),
    submitVote: ({ network, proposalId, vote, voter }) =>
      request(`${base(network)}/proposals/${seg(proposalId)}/votes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vote, voter }),
      }),
    getVotingPower: (network, publicKey) => request(`${base(network)}/voting-power/${seg(publicKey)}`),
  };
}
