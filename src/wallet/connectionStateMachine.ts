/**
 * @file connectionStateMachine.ts
 * Finite State Machine managing the lifecycle of wallet connections.
 *
 * Prevents invalid state transitions, tracks context (public key, wallet type, error),
 * and provides event subscriptions for UI and downstream consumers.
 *
 * Valid State Transitions:
 * --------------------------------------------------------------------------
 *  From State     | Allowed Target States
 * --------------------------------------------------------------------------
 *  idle           | connecting
 *  connecting     | connected, error, disconnected, idle
 *  connected      | disconnected, connecting, error
 *  error          | connecting, idle, disconnected
 *  disconnected   | connecting, idle
 * --------------------------------------------------------------------------
 */

export type ConnectionState = "idle" | "connecting" | "connected" | "error" | "disconnected";

export interface ConnectionStateContext {
  publicKey?: string | null | undefined;
  walletType?: string | null | undefined;
  error?: Error | string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ConnectionStateChangeEvent {
  from: ConnectionState;
  to: ConnectionState;
  context: ConnectionStateContext;
  timestamp: number;
}

export type ConnectionStateListener = (event: ConnectionStateChangeEvent) => void;
export type ConnectionStateUnsubscribe = () => void;

export class InvalidStateTransitionError extends Error {
  public readonly from: ConnectionState;
  public readonly to: ConnectionState;

  constructor(from: ConnectionState, to: ConnectionState, message?: string) {
    super(message ?? `Invalid wallet connection state transition from '${from}' to '${to}'.`);
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
    Object.setPrototypeOf(this, InvalidStateTransitionError.prototype);
  }
}

/**
 * Mapping of permissible state transitions.
 * Documented explicitly to prevent invalid or out-of-order lifecycle events.
 */
export const VALID_CONNECTION_TRANSITIONS: Record<ConnectionState, readonly ConnectionState[]> = {
  idle: ["connecting"],
  connecting: ["connected", "error", "disconnected", "idle"],
  connected: ["disconnected", "connecting", "error"],
  error: ["connecting", "idle", "disconnected"],
  disconnected: ["connecting", "idle"],
};

export interface ConnectionStateMachineOptions {
  initialState?: ConnectionState | undefined;
  initialContext?: ConnectionStateContext | undefined;
  onStateChange?: ConnectionStateListener | undefined;
}

/**
 * State machine managing wallet connection lifecycles.
 */
export class ConnectionStateMachine {
  private _state: ConnectionState;
  private _context: ConnectionStateContext;
  private readonly listeners: Set<ConnectionStateListener> = new Set();

  constructor(options: ConnectionStateMachineOptions = {}) {
    this._state = options.initialState ?? "idle";
    this._context = { ...options.initialContext };
    if (options.onStateChange) {
      this.listeners.add(options.onStateChange);
    }
  }

  /**
   * Current active state of the connection lifecycle.
   */
  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Current context associated with the state machine.
   */
  get context(): Readonly<ConnectionStateContext> {
    return this._context;
  }

  /**
   * Quick boolean state inspect checks.
   */
  is(targetState: ConnectionState): boolean {
    return this._state === targetState;
  }

  get isIdle(): boolean {
    return this._state === "idle";
  }

  get isConnecting(): boolean {
    return this._state === "connecting";
  }

  get isConnected(): boolean {
    return this._state === "connected";
  }

  get isError(): boolean {
    return this._state === "error";
  }

  get isDisconnected(): boolean {
    return this._state === "disconnected";
  }

  /**
   * Checks whether transitioning to target state is permissible from current state.
   */
  canTransitionTo(targetState: ConnectionState): boolean {
    const allowed = VALID_CONNECTION_TRANSITIONS[this._state];
    return allowed ? allowed.includes(targetState) : false;
  }

  /**
   * Transitions to a new state if valid. Throws InvalidStateTransitionError if transition is illegal.
   */
  transition(targetState: ConnectionState, updateContext?: Partial<ConnectionStateContext>): void {
    if (!this.canTransitionTo(targetState)) {
      throw new InvalidStateTransitionError(this._state, targetState);
    }

    const previousState = this._state;
    this._state = targetState;

    if (updateContext) {
      this._context = {
        ...this._context,
        ...updateContext,
      };
    }

    const event: ConnectionStateChangeEvent = {
      from: previousState,
      to: targetState,
      context: { ...this._context },
      timestamp: Date.now(),
    };

    this.notifyListeners(event);
  }

  /**
   * Attempts transition; returns true if successful, false if transition is invalid without throwing.
   */
  tryTransition(targetState: ConnectionState, updateContext?: Partial<ConnectionStateContext>): boolean {
    if (!this.canTransitionTo(targetState)) {
      return false;
    }
    this.transition(targetState, updateContext);
    return true;
  }

  // ─── Convenience Helper Methods ──────────────────────────────────────────

  /**
   * Transitions to "connecting".
   */
  connect(context?: Partial<ConnectionStateContext>): void {
    this.transition("connecting", context);
  }

  /**
   * Transitions to "connected" with public key and wallet type.
   */
  setConnected(publicKey: string, walletType?: string, metadata?: Record<string, unknown>): void {
    this.transition("connected", {
      publicKey,
      walletType: walletType ?? this._context.walletType,
      error: null,
      metadata: metadata ?? this._context.metadata,
    });
  }

  /**
   * Transitions to "error" with an error message or Error object.
   */
  setError(error: Error | string, context?: Partial<ConnectionStateContext>): void {
    this.transition("error", {
      error,
      ...context,
    });
  }

  /**
   * Transitions to "disconnected".
   */
  disconnect(context?: Partial<ConnectionStateContext>): void {
    this.transition("disconnected", {
      publicKey: null,
      ...context,
    });
  }

  /**
   * Resets the state machine back to "idle".
   */
  reset(context?: Partial<ConnectionStateContext>): void {
    this.transition("idle", {
      publicKey: null,
      error: null,
      ...context,
    });
  }

  // ─── Subscription Management ─────────────────────────────────────────────

  /**
   * Subscribes a callback to all state transitions.
   * Returns an unsubscribe function.
   */
  subscribe(listener: ConnectionStateListener): ConnectionStateUnsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Alias for subscribe.
   */
  onStateChange(listener: ConnectionStateListener): ConnectionStateUnsubscribe {
    return this.subscribe(listener);
  }

  private notifyListeners(event: ConnectionStateChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // Prevent subscriber error from breaking state transition
        console.error("Error in connection state machine listener:", err);
      }
    }
  }
}

/**
 * Factory function to create and return a new ConnectionStateMachine instance.
 */
export function createConnectionStateMachine(
  initialState?: ConnectionState,
  options?: Omit<ConnectionStateMachineOptions, "initialState">
): ConnectionStateMachine {
  return new ConnectionStateMachine({
    initialState,
    ...options,
  });
}
