import { describe, it, expect } from "vitest";
import {
  DependencyGraphError,
  findParallelizableTransactions,
  planTransactionExecution,
  resolveTransactionOrder,
  validateDependencies,
  type TransactionNode,
} from "../transaction/dependencyGraph";

/** Shorthand for a node with dependencies. */
function tx(id: string, dependsOn: string[] = []): TransactionNode {
  return { id, dependsOn };
}

/** Assert that `before` is ordered ahead of `after` in `order`. */
function precedes(order: string[], before: string, after: string): boolean {
  return order.indexOf(before) < order.indexOf(after);
}

describe("validateDependencies", () => {
  it("accepts a well-formed graph", () => {
    const result = validateDependencies([
      tx("a"),
      tx("b", ["a"]),
      tx("c", ["b"]),
    ]);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("reports duplicate transaction identifiers", () => {
    const result = validateDependencies([tx("a"), tx("b"), tx("a")]);

    expect(result.valid).toBe(false);
    const duplicate = result.errors.find((e) => e.code === "DUPLICATE_ID");
    expect(duplicate).toBeDefined();
    expect(duplicate?.chain).toEqual(["a"]);
  });

  it("reports a duplicate identifier only once regardless of repeat count", () => {
    const result = validateDependencies([tx("a"), tx("a"), tx("a"), tx("a")]);

    const duplicates = result.errors.filter((e) => e.code === "DUPLICATE_ID");
    expect(duplicates).toHaveLength(1);
  });

  it("reports missing dependencies with the referencing transaction", () => {
    const result = validateDependencies([tx("a", ["ghost"]), tx("b", ["a"])]);

    expect(result.valid).toBe(false);
    const missing = result.errors.find((e) => e.code === "MISSING_DEPENDENCY");
    expect(missing).toBeDefined();
    expect(missing?.chain).toEqual(["a", "ghost"]);
    expect(missing?.message).toContain("ghost");
  });

  it("reports every missing dependency, not just the first", () => {
    const result = validateDependencies([
      tx("a", ["ghost1"]),
      tx("b", ["ghost2"]),
    ]);

    const missing = result.errors.filter((e) => e.code === "MISSING_DEPENDENCY");
    expect(missing).toHaveLength(2);
  });

  it("detects a direct circular dependency", () => {
    const result = validateDependencies([tx("a", ["b"]), tx("b", ["a"])]);

    expect(result.valid).toBe(false);
    const cycle = result.errors.find((e) => e.code === "CIRCULAR_DEPENDENCY");
    expect(cycle).toBeDefined();
    // The chain reads end to end, repeating the entry node.
    expect(cycle?.chain).toEqual(["a", "b", "a"]);
  });

  it("detects a longer circular chain and names every member", () => {
    const result = validateDependencies([
      tx("a", ["c"]),
      tx("b", ["a"]),
      tx("c", ["b"]),
    ]);

    const cycle = result.errors.find((e) => e.code === "CIRCULAR_DEPENDENCY");
    expect(cycle).toBeDefined();
    expect(cycle?.chain).toEqual(["a", "c", "b", "a"]);
    expect(cycle?.message).toContain("a -> c -> b -> a");
  });

  it("normalises a cycle so the entry point does not change the report", () => {
    const fromA = validateDependencies([
      tx("a", ["c"]),
      tx("b", ["a"]),
      tx("c", ["b"]),
    ]);
    // Same cycle, nodes supplied in a different order.
    const fromC = validateDependencies([
      tx("c", ["b"]),
      tx("a", ["c"]),
      tx("b", ["a"]),
    ]);

    const cycleA = fromA.errors.find((e) => e.code === "CIRCULAR_DEPENDENCY");
    const cycleC = fromC.errors.find((e) => e.code === "CIRCULAR_DEPENDENCY");
    expect(cycleA?.chain).toEqual(cycleC?.chain);
  });

  it("reports a self-dependency distinctly from a cycle", () => {
    const result = validateDependencies([tx("a", ["a"])]);

    expect(result.valid).toBe(false);
    const self = result.errors.find((e) => e.code === "SELF_DEPENDENCY");
    expect(self).toBeDefined();
    expect(self?.chain).toEqual(["a", "a"]);
  });

  it("rejects blank or non-string identifiers", () => {
    const result = validateDependencies([
      tx(""),
      tx("   "),
      { id: 42 as unknown as string },
    ]);

    const invalid = result.errors.filter((e) => e.code === "INVALID_ID");
    expect(invalid).toHaveLength(3);
  });

  it("collects several distinct problems in one pass", () => {
    const result = validateDependencies([
      tx("a", ["ghost"]),
      tx("b", ["c"]),
      tx("c", ["b"]),
      tx("a"),
    ]);

    const codes = new Set(result.errors.map((e) => e.code));
    expect(codes.has("MISSING_DEPENDENCY")).toBe(true);
    expect(codes.has("CIRCULAR_DEPENDENCY")).toBe(true);
    expect(codes.has("DUPLICATE_ID")).toBe(true);
  });

  it("treats an empty graph as valid", () => {
    expect(validateDependencies([])).toEqual({ valid: true, errors: [] });
  });

  it("ignores duplicate declarations of the same dependency", () => {
    const result = validateDependencies([tx("a"), tx("b", ["a", "a", "a"])]);

    expect(result.valid).toBe(true);
  });
});

describe("planTransactionExecution", () => {
  it("orders a linear chain from root to leaf", () => {
    const result = planTransactionExecution([
      tx("c", ["b"]),
      tx("a"),
      tx("b", ["a"]),
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.order).toEqual(["a", "b", "c"]);
  });

  it("respects every edge in a branching graph", () => {
    // a -> b, a -> c, b -> d, c -> d
    const result = planTransactionExecution([
      tx("d", ["b", "c"]),
      tx("b", ["a"]),
      tx("c", ["a"]),
      tx("a"),
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const { order } = result.plan;
    expect(precedes(order, "a", "b")).toBe(true);
    expect(precedes(order, "a", "c")).toBe(true);
    expect(precedes(order, "b", "d")).toBe(true);
    expect(precedes(order, "c", "d")).toBe(true);
  });

  it("produces the same order regardless of input order", () => {
    const nodes = [tx("d", ["b", "c"]), tx("b", ["a"]), tx("c", ["a"]), tx("a")];
    const shuffled = [nodes[3]!, nodes[2]!, nodes[0]!, nodes[1]!];

    const first = planTransactionExecution(nodes);
    const second = planTransactionExecution(shuffled);

    expect(first.valid && second.valid).toBe(true);
    if (!first.valid || !second.valid) return;
    expect(first.plan.order).toEqual(second.plan.order);
  });

  it("breaks ties lexicographically so the order is stable", () => {
    const result = planTransactionExecution([tx("z"), tx("m"), tx("a")]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.order).toEqual(["a", "m", "z"]);
  });

  it("groups fully independent transactions into a single parallel level", () => {
    const result = planTransactionExecution([tx("a"), tx("b"), tx("c")]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.parallelGroups).toEqual([["a", "b", "c"]]);
  });

  it("splits a branching graph into dependency levels", () => {
    const result = planTransactionExecution([
      tx("a"),
      tx("b", ["a"]),
      tx("c", ["a"]),
      tx("d", ["b", "c"]),
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.parallelGroups).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("gives a linear chain one transaction per level", () => {
    const result = planTransactionExecution([
      tx("a"),
      tx("b", ["a"]),
      tx("c", ["b"]),
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.parallelGroups).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps the flat order consistent with the parallel levels", () => {
    const result = planTransactionExecution([
      tx("a"),
      tx("b", ["a"]),
      tx("c", ["a"]),
      tx("d", ["b"]),
      tx("e"),
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.parallelGroups.flat()).toEqual(result.plan.order);
  });

  it("handles disconnected subgraphs in one plan", () => {
    const result = planTransactionExecution([
      tx("a1"),
      tx("a2", ["a1"]),
      tx("b1"),
      tx("b2", ["b1"]),
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.order).toHaveLength(4);
    expect(precedes(result.plan.order, "a1", "a2")).toBe(true);
    expect(precedes(result.plan.order, "b1", "b2")).toBe(true);
  });

  it("validates before ordering and returns no partial plan", () => {
    const result = planTransactionExecution([
      tx("a"),
      tx("b", ["a"]),
      tx("c", ["missing"]),
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.code).toBe("MISSING_DEPENDENCY");
    expect(result).not.toHaveProperty("plan");
  });

  it("carries the caller's payload through to the plan", () => {
    const result = planTransactionExecution<{ xdr: string }>([
      { id: "a", payload: { xdr: "AAAA" } },
      { id: "b", dependsOn: ["a"], payload: { xdr: "BBBB" } },
    ]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.nodes.get("b")?.payload).toEqual({ xdr: "BBBB" });
  });

  it("plans an empty graph as an empty order", () => {
    const result = planTransactionExecution([]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.order).toEqual([]);
    expect(result.plan.parallelGroups).toEqual([]);
  });

  it("handles a deep chain without exhausting the call stack", () => {
    // A recursive resolver would overflow well before this depth.
    const nodes: TransactionNode[] = [tx("n0")];
    for (let i = 1; i < 10_000; i += 1) {
      nodes.push(tx(`n${i}`, [`n${i - 1}`]));
    }

    const result = planTransactionExecution(nodes);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.plan.order).toHaveLength(10_000);
    expect(result.plan.order[0]).toBe("n0");
  });

  it("detects a cycle in a deep graph without exhausting the call stack", () => {
    const nodes: TransactionNode[] = [tx("n0", ["n9999"])];
    for (let i = 1; i < 10_000; i += 1) {
      nodes.push(tx(`n${i}`, [`n${i - 1}`]));
    }

    const result = planTransactionExecution(nodes);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.code === "CIRCULAR_DEPENDENCY")).toBe(
      true,
    );
  });
});

describe("resolveTransactionOrder", () => {
  it("returns the deterministic order for a valid graph", () => {
    const order = resolveTransactionOrder([
      tx("b", ["a"]),
      tx("a"),
      tx("c", ["b"]),
    ]);

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("throws a DependencyGraphError carrying the structured errors", () => {
    expect(() =>
      resolveTransactionOrder([tx("a", ["b"]), tx("b", ["a"])]),
    ).toThrow(DependencyGraphError);

    try {
      resolveTransactionOrder([tx("a", ["b"]), tx("b", ["a"])]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyGraphError);
      const graphError = error as DependencyGraphError;
      expect(graphError.errors[0]?.code).toBe("CIRCULAR_DEPENDENCY");
      expect(graphError.errors[0]?.chain).toEqual(["a", "b", "a"]);
      expect(graphError.message).toContain("a -> b -> a");
    }
  });

  it("throws when a dependency is missing", () => {
    try {
      resolveTransactionOrder([tx("a", ["ghost"])]);
      expect.unreachable("should have thrown");
    } catch (error) {
      const graphError = error as DependencyGraphError;
      expect(graphError.errors[0]?.code).toBe("MISSING_DEPENDENCY");
    }
  });
});

describe("findParallelizableTransactions", () => {
  it("returns levels that can each be executed in parallel", () => {
    const groups = findParallelizableTransactions([
      tx("a"),
      tx("b"),
      tx("c", ["a", "b"]),
    ]);

    expect(groups).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });

  it("throws on an invalid graph rather than returning partial groups", () => {
    expect(() =>
      findParallelizableTransactions([tx("a", ["b"]), tx("b", ["a"])]),
    ).toThrow(DependencyGraphError);
  });
});
