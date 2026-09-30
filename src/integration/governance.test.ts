import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  configureGovernance,
  createHttpGovernanceProvider,
  getProposal,
  getProposals,
  getVotingPower,
  normalizeProposal,
  resetGovernance,
  trackProposal,
  voteOnProposal,
  type GovernanceProposal,
  type GovernanceProvider,
} from "./governance";
import * as integration from "./index";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// #686 — governance proposals, voting, voting power and tracking.

const VOTER = Keypair.random().publicKey();

const raw = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  title: "Protocol upgrade",
  status: "active",
  tally: { yes: "10", no: 2, abstain: 0 },
  ...overrides,
});

function fakeProvider(overrides: Partial<GovernanceProvider> = {}): GovernanceProvider & {
  listProposals: ReturnType<typeof vi.fn>;
  getProposal: ReturnType<typeof vi.fn>;
  submitVote: ReturnType<typeof vi.fn>;
  getVotingPower: ReturnType<typeof vi.fn>;
} {
  return {
    listProposals: vi.fn(async () => [
      raw(),
      raw({ id: 2, title: "Fee change", status: "passed" }),
      raw({ id: "gov-3", title: "Treasury", status: "ACTIVE" }),
    ]),
    getProposal: vi.fn(async (_n, id) => raw({ id })),
    submitVote: vi.fn(async () => ({ txHash: "abc123" })),
    getVotingPower: vi.fn(async () => ({ power: "5000" })),
    ...overrides,
  } as never;
}

beforeEach(() => resetGovernance());
afterEach(() => {
  resetGovernance();
  vi.useRealTimers();
});

describe("configuration & validation", () => {
  it("errors with INVALID_CONFIG when no provider is configured", async () => {
    const res = await getProposals("testnet");
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("INVALID_CONFIG");
  });

  it("rejects unsupported networks", async () => {
    const res = await getProposals("devnet" as never, { provider: fakeProvider() });
    expect(res.error?.code).toBe("INVALID_NETWORK");
  });

  it("uses the configured default provider and network", async () => {
    const provider = fakeProvider();
    configureGovernance(provider, { network: "futurenet" });
    await getProposals();
    expect(provider.listProposals).toHaveBeenCalledWith("futurenet");
  });

  it("per-call provider overrides the default", async () => {
    const dflt = fakeProvider();
    const other = fakeProvider();
    configureGovernance(dflt);
    await getProposals("testnet", { provider: other });
    expect(other.listProposals).toHaveBeenCalledOnce();
    expect(dflt.listProposals).not.toHaveBeenCalled();
  });
});

describe("getProposals", () => {
  it("returns active proposals by default, normalising status and tallies", async () => {
    const res = await getProposals("testnet", { provider: fakeProvider() });
    expect(res.status).toBe("ok");
    expect(res.data!.map((p) => p.id)).toEqual([1, "gov-3"]);
    expect(res.data![0]).toEqual({
      id: 1,
      title: "Protocol upgrade",
      status: "active",
      tally: { yes: 10n, no: 2n, abstain: 0n },
    });
  });

  it("supports status filters and { proposals: [] } envelopes", async () => {
    const provider = fakeProvider({
      listProposals: vi.fn(async () => ({ proposals: [raw(), raw({ id: 2, status: "passed" })] })),
    });
    const all = await getProposals("testnet", { provider, status: "all" });
    expect(all.data).toHaveLength(2);
    const passed = await getProposals("testnet", { provider, status: "passed" });
    expect(passed.data!.map((p) => p.id)).toEqual([2]);
    const bad = await getProposals("testnet", { provider, status: "open" as never });
    expect(bad.error?.code).toBe("VALIDATION");
  });

  it("maps malformed provider data to VALIDATION and transport failures to NETWORK_ERROR", async () => {
    const malformed = await getProposals("testnet", {
      provider: fakeProvider({ listProposals: vi.fn(async () => [raw({ status: "weird" })]) }),
    });
    expect(malformed.error?.code).toBe("VALIDATION");
    const notArray = await getProposals("testnet", { provider: fakeProvider({ listProposals: vi.fn(async () => ({})) }) });
    expect(notArray.error?.code).toBe("VALIDATION");
    const down = await getProposals("testnet", {
      provider: fakeProvider({ listProposals: vi.fn(async () => { throw new Error("ECONNRESET"); }) }),
    });
    expect(down.error?.code).toBe("NETWORK_ERROR");
    expect(down.error?.message).toContain("ECONNRESET");
  });
});

describe("normalizeProposal", () => {
  it.each([
    [null, "object"],
    [{ title: "x", status: "active" }, "id"],
    [{ id: -1, title: "x", status: "active" }, "id"],
    [{ id: 1, title: "  ", status: "active" }, "title"],
    [{ id: 1, title: "x", status: "active", tally: { yes: "1.5" } }, "integer"],
    [{ id: 1, title: "x", status: "active", tally: { yes: -1 } }, "negative"],
  ])("rejects %j", (input, message) => {
    expect(() => normalizeProposal(input)).toThrow(message);
  });

  it("keeps optional fields", () => {
    const p = normalizeProposal({ id: "a", title: " T ", status: "pending", description: "d", endsAt: "2026-10-01T00:00:00Z" });
    expect(p).toEqual({ id: "a", title: "T", status: "pending", description: "d", endsAt: "2026-10-01T00:00:00Z" });
  });
});

describe("voteOnProposal", () => {
  it("submits a vote on an active proposal and returns the receipt", async () => {
    const provider = fakeProvider();
    const res = await voteOnProposal(1, "YES", { provider, voter: VOTER });
    expect(res.status).toBe("ok");
    expect(res.data).toEqual({ proposalId: 1, vote: "yes", voter: VOTER, txHash: "abc123" });
    expect(provider.submitVote).toHaveBeenCalledWith({ network: "testnet", proposalId: 1, vote: "yes", voter: VOTER });
  });

  it("omits voter when not given and accepts `hash` as the tx field", async () => {
    const provider = fakeProvider({ submitVote: vi.fn(async () => ({ hash: "h1" })) });
    const res = await voteOnProposal("gov-3", "abstain", { provider });
    expect(res.data).toEqual({ proposalId: "gov-3", vote: "abstain", txHash: "h1" });
    expect(provider.submitVote.mock.calls[0]![0]).not.toHaveProperty("voter");
  });

  it("refuses closed proposals without submitting", async () => {
    const provider = fakeProvider({ getProposal: vi.fn(async () => raw({ status: "executed" })) });
    const res = await voteOnProposal(1, "no", { provider });
    expect(res.error?.code).toBe("VALIDATION");
    expect(res.error?.message).toContain("executed");
    expect(provider.submitVote).not.toHaveBeenCalled();
  });

  it("validates the vote, id and voter before any network call", async () => {
    const provider = fakeProvider();
    expect((await voteOnProposal(1, "maybe", { provider })).error?.code).toBe("VALIDATION");
    expect((await voteOnProposal("", "yes", { provider })).error?.code).toBe("VALIDATION");
    expect((await voteOnProposal(1.5, "yes", { provider })).error?.code).toBe("VALIDATION");
    expect((await voteOnProposal(1, "yes", { provider, voter: "GBAD" })).error?.code).toBe("INVALID_ADDRESS");
    expect(provider.getProposal).not.toHaveBeenCalled();
  });

  it("reports unknown proposals and failed submissions", async () => {
    const missing = await voteOnProposal(9, "yes", { provider: fakeProvider({ getProposal: vi.fn(async () => null) }) });
    expect(missing.error?.message).toContain("not found");
    const noHash = await voteOnProposal(1, "yes", { provider: fakeProvider({ submitVote: vi.fn(async () => ({})) }) });
    expect(noHash.error?.code).toBe("VALIDATION");
    const rejected = await voteOnProposal(1, "yes", {
      provider: fakeProvider({ submitVote: vi.fn(async () => { throw new Error("tx_bad_auth"); }) }),
    });
    expect(rejected.error?.code).toBe("TX_SUBMIT_FAILED");
  });

  it("detects a provider returning a different proposal", async () => {
    const res = await getProposal(1, { provider: fakeProvider({ getProposal: vi.fn(async () => raw({ id: 2 })) }) });
    expect(res.error?.code).toBe("VALIDATION");
  });
});

describe("getVotingPower", () => {
  it("returns bigint power for a valid key", async () => {
    const provider = fakeProvider();
    const res = await getVotingPower(VOTER, { provider, network: "mainnet" });
    expect(res.data).toEqual({ publicKey: VOTER, network: "mainnet", power: 5000n });
    expect(provider.getVotingPower).toHaveBeenCalledWith("mainnet", VOTER);
  });

  it("accepts a bare number and rejects bad keys, negative or non-integer power", async () => {
    expect((await getVotingPower(VOTER, { provider: fakeProvider({ getVotingPower: vi.fn(async () => 7) }) })).data?.power).toBe(7n);
    expect((await getVotingPower("GNOPE", { provider: fakeProvider() })).error?.code).toBe("INVALID_ADDRESS");
    expect(
      (await getVotingPower(VOTER, { provider: fakeProvider({ getVotingPower: vi.fn(async () => ({ power: -1 })) }) })).error?.code,
    ).toBe("VALIDATION");
    expect(
      (await getVotingPower(VOTER, { provider: fakeProvider({ getVotingPower: vi.fn(async () => ({ power: "1e3" })) }) })).error?.code,
    ).toBe("VALIDATION");
  });
});

describe("trackProposal", () => {
  function sequence(states: Array<Record<string, unknown> | Error>) {
    let i = 0;
    return vi.fn(async () => {
      const next = states[Math.min(i, states.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    });
  }

  it("reports only real changes and stops at a terminal status", async () => {
    vi.useFakeTimers();
    const getProposalFn = sequence([
      raw(),
      raw(), // unchanged → no update
      raw({ tally: { yes: 11, no: 2, abstain: 0 } }),
      raw({ status: "passed", tally: { yes: 11, no: 2, abstain: 0 } }),
    ]);
    const updates: GovernanceProposal[] = [];
    const res = await trackProposal(1, {
      provider: fakeProvider({ getProposal: getProposalFn }),
      intervalMs: 1_000,
      onUpdate: (p) => updates.push(p),
    });
    expect(res.status).toBe("ok");
    const tracker = res.data!;
    expect(tracker.current.status).toBe("active");
    expect(tracker.active).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.map((p) => p.tally?.yes)).toEqual([11n]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates.at(-1)?.status).toBe("passed");
    expect(tracker.active).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(getProposalFn).toHaveBeenCalledTimes(4);
  });

  it("stop() and AbortSignal end polling", async () => {
    vi.useFakeTimers();
    const getProposalFn = vi.fn(async () => raw());
    const res = await trackProposal(1, { provider: fakeProvider({ getProposal: getProposalFn }), intervalMs: 1_000 });
    res.data!.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getProposalFn).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const second = await trackProposal(1, {
      provider: fakeProvider({ getProposal: getProposalFn }),
      intervalMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.data!.active).toBe(false);
    expect(getProposalFn).toHaveBeenCalledTimes(2);
  });

  it("keeps polling through transient errors and gives up after maxConsecutiveErrors", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const getProposalFn = sequence([raw(), new Error("timeout"), raw(), new Error("down"), new Error("down")]);
    const res = await trackProposal(1, {
      provider: fakeProvider({ getProposal: getProposalFn }),
      intervalMs: 1_000,
      maxConsecutiveErrors: 2,
      onError: (e) => errors.push(e.code),
    });
    await vi.advanceTimersByTimeAsync(1_000); // error 1
    await vi.advanceTimersByTimeAsync(1_000); // ok → counter resets
    expect(res.data!.active).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000); // two errors in a row → stop
    expect(errors).toEqual(["NETWORK_ERROR", "NETWORK_ERROR", "NETWORK_ERROR"]);
    expect(res.data!.active).toBe(false);
  });

  it("does not start polling for an already-terminal proposal and validates options", async () => {
    const done = await trackProposal(1, { provider: fakeProvider({ getProposal: vi.fn(async () => raw({ status: "rejected" })) }) });
    expect(done.data!.active).toBe(false);
    expect((await trackProposal(1, { provider: fakeProvider(), intervalMs: 10 })).error?.code).toBe("VALIDATION");
    expect((await trackProposal(1, { provider: fakeProvider(), maxConsecutiveErrors: 0 })).error?.code).toBe("VALIDATION");
    expect((await trackProposal(1)).error?.code).toBe("INVALID_CONFIG");
  });
});

describe("createHttpGovernanceProvider", () => {
  function http(routes: Record<string, { status?: number; body?: unknown }>) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      const route = routes[key];
      if (!route) throw new Error(`unexpected ${key}`);
      return {
        ok: (route.status ?? 200) < 400,
        status: route.status ?? 200,
        json: async () => route.body,
      } as Response;
    });
  }

  it("implements the documented REST contract end to end", async () => {
    const fetchFn = http({
      "GET https://gov.test/proposals": { body: { proposals: [raw()] } },
      "GET https://gov.test/proposals/1": { body: raw() },
      "POST https://gov.test/proposals/1/votes": { body: { txHash: "tx9" } },
      [`GET https://gov.test/voting-power/${VOTER}`]: { body: { power: "42" } },
    });
    configureGovernance(createHttpGovernanceProvider({ endpoints: { testnet: "https://gov.test/" }, fetch: fetchFn, headers: { "X-Api-Key": "k" } }));

    expect((await getProposals("testnet")).data).toHaveLength(1);
    const vote = await voteOnProposal(1, "yes", { voter: VOTER });
    expect(vote.data?.txHash).toBe("tx9");
    expect((await getVotingPower(VOTER)).data?.power).toBe(42n);

    const postInit = fetchFn.mock.calls.find(([, init]) => init?.method === "POST")![1]!;
    expect(JSON.parse(String(postInit.body))).toEqual({ vote: "yes", voter: VOTER });
    expect((postInit.headers as Record<string, string>)["X-Api-Key"]).toBe("k");
  });

  it("maps 404 to not-found, other HTTP errors to NETWORK_ERROR, and URL-encodes ids", async () => {
    const fetchFn = http({
      "GET https://gov.test/proposals/a%2Fb": { status: 404 },
      "GET https://gov.test/proposals": { status: 503 },
    });
    const provider = createHttpGovernanceProvider({ endpoints: { testnet: "https://gov.test" }, fetch: fetchFn });
    expect((await getProposal("a/b", { provider })).error?.message).toContain("not found");
    const down = await getProposals("testnet", { provider });
    expect(down.error?.code).toBe("NETWORK_ERROR");
    expect(down.error?.message).toContain("HTTP 503");
  });

  it("errors for networks without an endpoint", async () => {
    const provider = createHttpGovernanceProvider({ endpoints: { testnet: "https://gov.test" }, fetch: vi.fn() });
    const res = await getProposals("mainnet", { provider });
    expect(res.error?.code).toBe("NETWORK_ERROR");
    expect(res.error?.message).toContain("No governance endpoint configured for mainnet");
  });

  it("aborts slow requests after timeoutMs", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const provider = createHttpGovernanceProvider({ endpoints: { testnet: "https://gov.test" }, fetch: fetchFn as never, timeoutMs: 50 });
    const pending = getProposals("testnet", { provider });
    await vi.advanceTimersByTimeAsync(60);
    expect((await pending).error?.message).toContain("aborted");
  });
});

describe("exports", () => {
  it("is exported from src/integration/index.ts and src/index.ts", () => {
    for (const name of ["getProposals", "voteOnProposal", "getVotingPower", "trackProposal", "configureGovernance", "createHttpGovernanceProvider"]) {
      expect(typeof (integration as Record<string, unknown>)[name]).toBe("function");
    }
    // Root barrel: checked statically because src/index.ts cannot currently be
    // loaded on main (it re-exports `unlinkWallet` & co. that #670 never
    // implemented). #456 already owns `getVotingPower`, so #686's is aliased.
    const rootSrc = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    const block = rootSrc.slice(rootSrc.indexOf("// ─── On-chain governance (#686)"));
    const exportsBlock = block.slice(0, block.indexOf('} from "./integration/governance";'));
    for (const name of ["getProposals", "voteOnProposal", "trackProposal", "getVotingPower as getGovernanceVotingPower"]) {
      expect(exportsBlock).toContain(name);
    }
  });
});
