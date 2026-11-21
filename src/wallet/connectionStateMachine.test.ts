import { describe, it, expect, vi } from "vitest";
import {
  ConnectionStateMachine,
  createConnectionStateMachine,
  InvalidStateTransitionError,
  VALID_CONNECTION_TRANSITIONS,
} from "./connectionStateMachine";
import type { ConnectionState, ConnectionStateChangeEvent } from "./connectionStateMachine";

describe("ConnectionStateMachine", () => {
  describe("initialization", () => {
    it("defaults to idle state with empty context", () => {
      const sm = createConnectionStateMachine();
      expect(sm.state).toBe("idle");
      expect(sm.isIdle).toBe(true);
      expect(sm.isConnecting).toBe(false);
      expect(sm.isConnected).toBe(false);
      expect(sm.isError).toBe(false);
      expect(sm.isDisconnected).toBe(false);
      expect(sm.context).toEqual({});
    });

    it("accepts custom initial state and context", () => {
      const sm = new ConnectionStateMachine({
        initialState: "connected",
        initialContext: { publicKey: "GABCD123", walletType: "freighter" },
      });
      expect(sm.state).toBe("connected");
      expect(sm.isConnected).toBe(true);
      expect(sm.context.publicKey).toBe("GABCD123");
      expect(sm.context.walletType).toBe("freighter");
    });

    it("invokes onStateChange passed to constructor on transitions", () => {
      const onStateChange = vi.fn();
      const sm = createConnectionStateMachine("idle", { onStateChange });
      sm.transition("connecting");
      expect(onStateChange).toHaveBeenCalledTimes(1);
      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "idle",
          to: "connecting",
        })
      );
    });
  });

  describe("canTransitionTo and validation", () => {
    it("allows idle -> connecting", () => {
      const sm = createConnectionStateMachine("idle");
      expect(sm.canTransitionTo("connecting")).toBe(true);
      expect(sm.canTransitionTo("connected")).toBe(false);
      expect(sm.canTransitionTo("disconnected")).toBe(false);
      expect(sm.canTransitionTo("error")).toBe(false);
    });

    it("allows connecting -> connected, error, disconnected, idle", () => {
      const sm = createConnectionStateMachine("connecting");
      expect(sm.canTransitionTo("connected")).toBe(true);
      expect(sm.canTransitionTo("error")).toBe(true);
      expect(sm.canTransitionTo("disconnected")).toBe(true);
      expect(sm.canTransitionTo("idle")).toBe(true);
    });

    it("allows connected -> disconnected, connecting, error", () => {
      const sm = createConnectionStateMachine("connected");
      expect(sm.canTransitionTo("disconnected")).toBe(true);
      expect(sm.canTransitionTo("connecting")).toBe(true);
      expect(sm.canTransitionTo("error")).toBe(true);
      expect(sm.canTransitionTo("idle")).toBe(false);
    });

    it("allows error -> connecting, idle, disconnected", () => {
      const sm = createConnectionStateMachine("error");
      expect(sm.canTransitionTo("connecting")).toBe(true);
      expect(sm.canTransitionTo("idle")).toBe(true);
      expect(sm.canTransitionTo("disconnected")).toBe(true);
      expect(sm.canTransitionTo("connected")).toBe(false);
    });

    it("allows disconnected -> connecting, idle", () => {
      const sm = createConnectionStateMachine("disconnected");
      expect(sm.canTransitionTo("connecting")).toBe(true);
      expect(sm.canTransitionTo("idle")).toBe(true);
      expect(sm.canTransitionTo("connected")).toBe(false);
      expect(sm.canTransitionTo("error")).toBe(false);
    });

    it("throws InvalidStateTransitionError when illegal transition is attempted", () => {
      const sm = createConnectionStateMachine("idle");
      expect(() => sm.transition("connected")).toThrow(InvalidStateTransitionError);
      expect(() => sm.transition("error")).toThrow(/Invalid wallet connection state transition from 'idle' to 'error'/);
    });

    it("tryTransition returns false without throwing on illegal transition", () => {
      const sm = createConnectionStateMachine("idle");
      const result = sm.tryTransition("connected");
      expect(result).toBe(false);
      expect(sm.state).toBe("idle");
    });

    it("tryTransition returns true and updates state on valid transition", () => {
      const sm = createConnectionStateMachine("idle");
      const result = sm.tryTransition("connecting");
      expect(result).toBe(true);
      expect(sm.state).toBe("connecting");
    });
  });

  describe("lifecycle transitions and context updates", () => {
    it("completes full connect -> disconnect cycle", () => {
      const sm = createConnectionStateMachine();

      // idle -> connecting
      sm.connect({ walletType: "freighter" });
      expect(sm.isConnecting).toBe(true);
      expect(sm.context.walletType).toBe("freighter");

      // connecting -> connected
      sm.setConnected("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ");
      expect(sm.isConnected).toBe(true);
      expect(sm.context.publicKey).toBe("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ");
      expect(sm.context.walletType).toBe("freighter");

      // connected -> disconnected
      sm.disconnect();
      expect(sm.isDisconnected).toBe(true);
      expect(sm.context.publicKey).toBeNull();

      // disconnected -> idle
      sm.reset();
      expect(sm.isIdle).toBe(true);
    });

    it("handles connection failure and error recovery", () => {
      const sm = createConnectionStateMachine();

      sm.connect();
      expect(sm.isConnecting).toBe(true);

      const error = new Error("User rejected connection request");
      sm.setError(error);
      expect(sm.isError).toBe(true);
      expect(sm.context.error).toBe(error);

      // retry from error -> connecting
      sm.connect();
      expect(sm.isConnecting).toBe(true);

      // succeed after retry
      sm.setConnected("GB12345");
      expect(sm.isConnected).toBe(true);
      expect(sm.context.error).toBeNull();
    });

    it("handles error during active connection", () => {
      const sm = createConnectionStateMachine("connected", {
        initialContext: { publicKey: "G11111" },
      });

      sm.setError("RPC node unreachable");
      expect(sm.isError).toBe(true);
      expect(sm.context.error).toBe("RPC node unreachable");
    });
  });

  describe("event subscriptions and callbacks", () => {
    it("notifies listeners on each valid transition", () => {
      const sm = createConnectionStateMachine();
      const events: ConnectionStateChangeEvent[] = [];

      const unsubscribe = sm.onStateChange((event) => {
        events.push(event);
      });

      sm.connect({ walletType: "xbull" });
      sm.setConnected("GABC123");

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        from: "idle",
        to: "connecting",
        context: { walletType: "xbull" },
      });
      expect(events[1]).toMatchObject({
        from: "connecting",
        to: "connected",
        context: { publicKey: "GABC123", walletType: "xbull", error: null },
      });
      expect(events[0].timestamp).toBeGreaterThan(0);

      unsubscribe();
      sm.disconnect();
      // Should not receive disconnect event after unsubscribe
      expect(events).toHaveLength(2);
    });

    it("does not crash state machine if listener throws an error", () => {
      const sm = createConnectionStateMachine();
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      sm.subscribe(() => {
        throw new Error("Subscriber crash");
      });

      expect(() => sm.connect()).not.toThrow();
      expect(sm.state).toBe("connecting");

      consoleErrorSpy.mockRestore();
    });
  });

  describe("VALID_CONNECTION_TRANSITIONS documentation verification", () => {
    it("exports all states with non-empty allowed transitions", () => {
      const states: ConnectionState[] = ["idle", "connecting", "connected", "error", "disconnected"];
      for (const st of states) {
        expect(VALID_CONNECTION_TRANSITIONS[st]).toBeDefined();
        expect(VALID_CONNECTION_TRANSITIONS[st].length).toBeGreaterThan(0);
      }
    });
  });
});
