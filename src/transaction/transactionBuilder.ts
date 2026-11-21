/**
 * Transaction Builder with Undo/Redo History & Fluent Chaining (#139, #955)
 *
 * `createTransactionBuilder()` returns a builder whose operations are stored
 * in an immutable history stack inside a closure. Each call to `addOperation`
 * appends to the stack; `undo()` pops the last operation and moves it onto a
 * redo stack; `redo()` moves the next operation back onto the main stack.
 *
 * All setter methods support method chaining:
 * ```ts
 * const ops = builder
 *   .setSourceAccount("G...")
 *   .setFee(100)
 *   .setMemo("hello")
 *   .addOperation({ type: "payment", params: { ... } })
 *   .build();
 * ```
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single named operation recorded in the builder history. */
export interface TransactionOperation {
  /** Human-readable label identifying the operation (e.g. "payment", "trustline"). */
  type: string;
  /** Arbitrary payload describing the operation's parameters. */
  params: Record<string, unknown>;
}

/** Public interface returned by `createTransactionBuilder`. */
export interface TransactionBuilder {
  /**
   * Append a new operation to the builder.
   * Calling `addOperation` after an `undo` clears the redo stack (standard
   * linear-history behaviour — no branching histories).
   *
   * @returns The builder itself for chaining.
   */
  addOperation(operation: TransactionOperation): TransactionBuilder;

  /**
   * Remove the most recently added (or re-done) operation from the active
   * history and push it onto the redo stack.
   *
   * @returns The operation that was removed, or `undefined` when there is
   *   nothing left to undo.
   */
  undo(): TransactionOperation | undefined;

  /**
   * Re-apply the most recently undone operation, moving it back onto the
   * active history.
   *
   * @returns The operation that was re-applied, or `undefined` when there is
   *   nothing to redo.
   */
  redo(): TransactionOperation | undefined;

  /**
   * Return an ordered, immutable snapshot of the currently active operations
   * (i.e. everything that has been added and not subsequently undone).
   */
  getOperations(): ReadonlyArray<TransactionOperation>;

  /**
   * Return the number of currently active operations (after accounting for
   * any undos).
   */
  size(): number;

  /**
   * Return the number of operations sitting on the redo stack (i.e. how many
   * times `redo()` can still be called).
   */
  redoSize(): number;

  /**
   * Reset the builder to its initial empty state, clearing both the active
   * history and the redo stack.
   *
   * @returns The builder itself for chaining.
   */
  clear(): TransactionBuilder;

  /**
   * Set the transaction source account public key.
   *
   * @returns The builder itself for chaining.
   */
  setSourceAccount(source: string): TransactionBuilder;
  getSourceAccount(): string | undefined;

  /**
   * Set the transaction fee.
   *
   * @returns The builder itself for chaining.
   */
  setFee(fee: string | number): TransactionBuilder;
  getFee(): string | number | undefined;

  /**
   * Set the transaction memo.
   *
   * @returns The builder itself for chaining.
   */
  setMemo(memo: string): TransactionBuilder;
  getMemo(): string | undefined;

  /**
   * Set the transaction timeout in seconds.
   *
   * @returns The builder itself for chaining.
   */
  setTimeout(timeout: number): TransactionBuilder;
  getTimeout(): number | undefined;

  /**
   * Set the network identifier.
   *
   * @returns The builder itself for chaining.
   */
  setNetwork(network: string): TransactionBuilder;
  getNetwork(): string | undefined;

  /**
   * Set the sequence number.
   *
   * @returns The builder itself for chaining.
   */
  setSequenceNumber(seq: string): TransactionBuilder;
  getSequenceNumber(): string | undefined;

  /**
   * Finalize and build operations array.
   */
  build(): ReadonlyArray<TransactionOperation>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Create a new transaction builder that tracks full undo/redo history
 * and supports fluent method chaining.
 *
 * @example
 * ```ts
 * const builder = createTransactionBuilder();
 *
 * const ops = builder
 *   .setSourceAccount("G...")
 *   .setFee("100")
 *   .addOperation({ type: "payment", params: { destination: "GDEST...", amount: "10" } })
 *   .addOperation({ type: "trustline", params: { assetCode: "USDC" } })
 *   .build();
 * ```
 */
export function createTransactionBuilder(): TransactionBuilder {
  let _history: TransactionOperation[] = [];
  let _redoStack: TransactionOperation[] = [];
  let _sourceAccount: string | undefined;
  let _fee: string | number | undefined;
  let _memo: string | undefined;
  let _timeout: number | undefined;
  let _network: string | undefined;
  let _sequenceNumber: string | undefined;

  // ── Helper ─────────────────────────────────────────────────────────────────

  function shallowCopyOp(op: TransactionOperation): TransactionOperation {
    return { type: op.type, params: { ...op.params } };
  }

  // ── Builder object ──────────────────────────────────────────────────────────

  const builder: TransactionBuilder = {
    addOperation(operation: TransactionOperation): TransactionBuilder {
      _redoStack = [];
      _history.push(shallowCopyOp(operation));
      return builder;
    },

    undo(): TransactionOperation | undefined {
      const op = _history.pop();
      if (op === undefined) {
        return undefined;
      }
      _redoStack.push(op);
      return op;
    },

    redo(): TransactionOperation | undefined {
      const op = _redoStack.pop();
      if (op === undefined) {
        return undefined;
      }
      _history.push(op);
      return op;
    },

    getOperations(): ReadonlyArray<TransactionOperation> {
      return [..._history];
    },

    size(): number {
      return _history.length;
    },

    redoSize(): number {
      return _redoStack.length;
    },

    clear(): TransactionBuilder {
      _history = [];
      _redoStack = [];
      _sourceAccount = undefined;
      _fee = undefined;
      _memo = undefined;
      _timeout = undefined;
      _network = undefined;
      _sequenceNumber = undefined;
      return builder;
    },

    setSourceAccount(source: string): TransactionBuilder {
      _sourceAccount = source;
      return builder;
    },

    getSourceAccount(): string | undefined {
      return _sourceAccount;
    },

    setFee(fee: string | number): TransactionBuilder {
      _fee = fee;
      return builder;
    },

    getFee(): string | number | undefined {
      return _fee;
    },

    setMemo(memo: string): TransactionBuilder {
      _memo = memo;
      return builder;
    },

    getMemo(): string | undefined {
      return _memo;
    },

    setTimeout(timeout: number): TransactionBuilder {
      _timeout = timeout;
      return builder;
    },

    getTimeout(): number | undefined {
      return _timeout;
    },

    setNetwork(network: string): TransactionBuilder {
      _network = network;
      return builder;
    },

    getNetwork(): string | undefined {
      return _network;
    },

    setSequenceNumber(seq: string): TransactionBuilder {
      _sequenceNumber = seq;
      return builder;
    },

    getSequenceNumber(): string | undefined {
      return _sequenceNumber;
    },

    build(): ReadonlyArray<TransactionOperation> {
      return [..._history];
    },
  };

  return builder;
}
