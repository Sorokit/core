/**
 * Deterministic test data management for E2E scenarios.
 *
 * Fixtures are derived from a seed rather than generated randomly, so the
 * exact same accounts come back on every run — scenarios stay repeatable
 * across local runs, CI shards, and different network states without
 * needing to persist generated keys anywhere.
 */

import { createHash } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";

export type TestNetworkState = "testnet" | "futurenet";

export interface TestFixtureAccount {
  keypair: Keypair;
  publicKey: string;
  network: TestNetworkState;
  label: string;
}

export class TestDataManager {
  private readonly seed: string;
  private readonly counters = new Map<TestNetworkState, number>();

  constructor(seed = "sorokit-e2e") {
    this.seed = seed;
  }

  /**
   * Deterministically derive the next account for a `(network, label)` pair.
   * Calling this twice with the same arguments on a fresh manager instance
   * always returns the same keypair; calling it repeatedly on the same
   * instance advances to a fresh account each time.
   */
  account(network: TestNetworkState, label: string): TestFixtureAccount {
    const index = this.counters.get(network) ?? 0;
    this.counters.set(network, index + 1);

    const digest = createHash("sha256").update(`${this.seed}:${network}:${label}:${index}`).digest();
    const keypair = Keypair.fromRawEd25519Seed(digest.subarray(0, 32));

    return { keypair, publicKey: keypair.publicKey(), network, label };
  }

  /** Derive `count` accounts sharing a label prefix (e.g. multi-sig co-signers). */
  accounts(network: TestNetworkState, labelPrefix: string, count: number): TestFixtureAccount[] {
    return Array.from({ length: count }, (_, i) => this.account(network, `${labelPrefix}-${i}`));
  }

  /** Reset the derivation counter, so the next `account()` call replays from index 0. */
  reset(network?: TestNetworkState): void {
    if (network) this.counters.delete(network);
    else this.counters.clear();
  }
}
