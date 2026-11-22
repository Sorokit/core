import { describe, expect, it } from "vitest";
import { createConnectionStateMachine } from "./connectionStateMachine";

describe("createConnectionStateMachine", () => {
  it("accepts valid transitions and rejects invalid ones", () => {
    const machine = createConnectionStateMachine();
    expect(machine.transition("connect").status).toBe("ok");
    expect(machine.transition("connected").data).toBe("connected");
    expect(machine.transition("connect").status).toBe("error");
  });
});
