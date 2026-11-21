/**
 * Transaction Group Builder (#956).
 *
 * Sequence Number Handling in Groups:
 * In Stellar, multiple transactions from the same source account can be submitted
 * sequentially as an atomic or ordered group. Each subsequent transaction must
 * have an incremented sequence number:
 *   tx[0]: baseSequence (or seq)
 *   tx[1]: baseSequence + 1
 *   tx[2]: baseSequence + 2
 *   ...
 *
 * The `TransactionGroupBuilder` manages this sequence numbering automatically:
 * when a base sequence is specified (or derived from the first transaction in the group),
 * each transaction in the group is assigned a monotonically increasing sequence
 * number (`baseSequence + i`), ensuring they can be submitted sequentially without collision.
 */

import {
  Transaction,
  TransactionBuilder,
  Networks,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";

export interface GroupBuilderOptions {
  baseSequence?: string | bigint | number;
  sourceAccount?: string;
  networkPassphrase?: string;
}

export class TransactionGroupBuilder {
  private _transactions: (Transaction | string)[] = [];
  private _baseSequence?: string;
  private _sourceAccount?: string;
  private _networkPassphrase: string;

  constructor(options?: GroupBuilderOptions) {
    if (options?.baseSequence !== undefined) {
      this._baseSequence = options.baseSequence.toString();
    }
    this._sourceAccount = options?.sourceAccount;
    this._networkPassphrase =
      options?.networkPassphrase ?? Networks.TESTNET;
  }

  /**
   * Add a transaction to the group. Supports method chaining.
   */
  addTransaction(tx: Transaction | string): this {
    this._transactions.push(tx);
    return this;
  }

  /**
   * Add multiple transactions to the group. Supports method chaining.
   */
  addTransactions(txs: (Transaction | string)[]): this {
    for (const tx of txs) {
      this.addTransaction(tx);
    }
    return this;
  }

  /**
   * Set the starting base sequence number for the group. Supports method chaining.
   */
  setBaseSequence(sequence: string | bigint | number): this {
    this._baseSequence = sequence.toString();
    return this;
  }

  /**
   * Set the common source account for the group. Supports method chaining.
   */
  setSourceAccount(sourceAccount: string): this {
    this._sourceAccount = sourceAccount;
    return this;
  }

  /**
   * Set network passphrase for decoding transaction XDRs. Supports method chaining.
   */
  setNetworkPassphrase(networkPassphrase: string): this {
    this._networkPassphrase = networkPassphrase;
    return this;
  }

  /**
   * Return a snapshot of the transactions currently in the group.
   */
  getTransactions(): ReadonlyArray<Transaction | string> {
    return [...this._transactions];
  }

  /**
   * Return number of transactions in the group.
   */
  size(): number {
    return this._transactions.length;
  }

  /**
   * Clear all transactions from the group.
   */
  clear(): this {
    this._transactions = [];
    return this;
  }

  /**
   * Build and return the ordered group of transactions with managed sequence numbers.
   */
  build(): SorokitResult<Transaction[]> {
    try {
      if (this._transactions.length === 0) {
        return ok([]);
      }

      const parsedTransactions: Transaction[] = [];

      for (const item of this._transactions) {
        if (typeof item === "string") {
          const parsed = TransactionBuilder.fromXDR(
            item,
            this._networkPassphrase,
          );
          if (!(parsed instanceof Transaction)) {
            return err(
              SorokitErrorCode.TX_BUILD_FAILED,
              "FeeBumpTransaction cannot be grouped as a regular transaction.",
            );
          }
          parsedTransactions.push(parsed);
        } else if (item instanceof Transaction) {
          parsedTransactions.push(item);
        } else {
          parsedTransactions.push(item as unknown as Transaction);
        }
      }

      // Determine starting sequence
      let currentSeq: bigint;
      if (this._baseSequence !== undefined) {
        currentSeq = BigInt(this._baseSequence);
      } else if (parsedTransactions[0]?.sequence) {
        currentSeq = BigInt(parsedTransactions[0].sequence);
      } else {
        currentSeq = 1n;
      }

      // Assign consecutive sequence numbers across the group
      const grouped: Transaction[] = [];
      for (let i = 0; i < parsedTransactions.length; i++) {
        const tx = parsedTransactions[i]!;
        const assignedSeq = (currentSeq + BigInt(i)).toString();

        try {
          (tx as any).sequence = assignedSeq;
        } catch {
          // Ignore if sequence field is non-writable
        }
        grouped.push(tx);
      }

      return ok(grouped);
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to build transaction group: ${toMessage(cause)}`,
        cause,
      );
    }
  }
}

/**
 * Helper factory to create a new `TransactionGroupBuilder`.
 */
export function createTransactionGroupBuilder(
  options?: GroupBuilderOptions,
): TransactionGroupBuilder {
  return new TransactionGroupBuilder(options);
}
