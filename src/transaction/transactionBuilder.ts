/**
 * Transaction Builder with Undo/Redo History (#139)
 *
 * `createTransactionBuilder()` returns a builder whose operations are stored
 * in an immutable history stack inside a closure.  Each call to `addOperation`
 * appends to the stack; `undo()` pops the last operation and moves it onto a
 * redo stack; `redo()` moves the next operation back onto the main stack.
 *
 * Committing the builder (via `getOperations`) always reflects the current
 * state of the history — it never includes undone operations.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single named operation recorded in the builder history. */
export interface TransactionOperation {
  /** Human-readable label identifying the operation (e.g. "payment", "trustline"). */
  type: string;
  /** Arbitrary payload describing the operation's parameters. */
  params: Record<string, unknown>;
}

export interface SetMemoOptions {
  /**
   * When true, allows empty or whitespace-only memo strings.
   * Defaults to false.
   */
  allowEmpty?: boolean;
}

/** Public interface returned by `createTransactionBuilder`. */
export interface TransactionBuilder {
  /**
   * Set or update the transaction memo.
   * By default, rejects empty or whitespace-only memos.
   * Pass `{ allowEmpty: true }` to opt in to allowing empty or whitespace memos.
   *
   * @param memo - The memo string.
   * @param options - Optional configuration (e.g. `{ allowEmpty: true }`).
   * @returns The builder itself for chaining.
   */
  setMemo(memo: string, options?: SetMemoOptions): TransactionBuilder;

  /**
   * Return the currently configured memo, if any.
   */
  getMemo(): string | undefined;

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
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Create a new transaction builder that tracks full undo/redo history.
 *
 * The history is stored entirely in a closure — no external state is mutated.
 *
 * @example
 * ```ts
 * const builder = createTransactionBuilder();
 *
 * builder
 *   .addOperation({ type: "payment", params: { destination: "GDEST...", amount: "10" } })
 *   .addOperation({ type: "trustline", params: { assetCode: "USDC" } });
 *
 * builder.undo();           // removes "trustline"
 * builder.redo();           // re-adds "trustline"
 * builder.getOperations();  // [payment, trustline]
 * ```
 */
export function createTransactionBuilder(): TransactionBuilder {
  // ── Closure state ──────────────────────────────────────────────────────────
  //
  // `_history`  – operations that are currently "applied" (will be returned by
  //               getOperations).
  // `_redoStack` – operations that have been undone and can be re-applied. The
  //                top of the redo stack is the LAST element in the array.
  //
  // Invariant: every element in both arrays is a plain object — we never hold
  //            references to the caller's object (shallow-copied on entry).

  let _history: TransactionOperation[] = [];
  let _redoStack: TransactionOperation[] = [];
  let _memo: string | undefined;

  // ── Helper ─────────────────────────────────────────────────────────────────

  function shallowCopyOp(op: TransactionOperation): TransactionOperation {
    return { type: op.type, params: { ...op.params } };
  }

  // ── Builder object ──────────────────────────────────────────────────────────

  const builder: TransactionBuilder = {
    setMemo(memo: string, options?: SetMemoOptions): TransactionBuilder {
      if (typeof memo !== "string") {
        throw new Error("Memo must be a string");
      }
      if (!options?.allowEmpty && memo.trim().length === 0) {
        throw new Error("Memo cannot be empty or whitespace-only");
      }
      _memo = memo;
      return builder;
    },

    getMemo(): string | undefined {
      return _memo;
    },

    addOperation(operation: TransactionOperation): TransactionBuilder {
      // Adding a new operation after undo(s) discards the redo stack so that
      // history stays linear (no branching).
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
      // Return a shallow copy so callers cannot mutate internal state.
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
      _memo = undefined;
      return builder;
    },
  };

  return builder;
}
