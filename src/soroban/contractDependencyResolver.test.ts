/**
 * Tests for contract dependency resolution and version management (#498)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ContractDependencyResolver,
  parseVersionConstraint,
  satisfiesVersion,
  createDependencyResolver,
  type ContractMetadata,
  type ContractDependency,
  type DependencyResolverConfig,
} from "./contractDependencyResolver";

describe("contractDependencyResolver", () => {
  let resolver: ContractDependencyResolver;

  beforeEach(() => {
    resolver = createDependencyResolver({
      cacheTtlMs: 60000,
      enableCache: true,
      maxDepth: 50,
    });
  });

  describe("parseVersionConstraint", () => {
    it("should parse exact version constraint", () => {
      const result = parseVersionConstraint("1.2.3");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.operator).toBe("=");
        expect(result.data.version).toBe("1.2.3");
      }
    });

    it("should parse caret version constraint", () => {
      const result = parseVersionConstraint("^1.2.3");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.operator).toBe("^");
        expect(result.data.version).toBe("1.2.3");
      }
    });

    it("should parse tilde version constraint", () => {
      const result = parseVersionConstraint("~1.2.3");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.operator).toBe("~");
        expect(result.data.version).toBe("1.2.3");
      }
    });

    it("should parse greater than constraint", () => {
      const result = parseVersionConstraint(">1.2.3");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.operator).toBe(">");
        expect(result.data.version).toBe("1.2.3");
      }
    });

    it("should parse greater than or equal constraint", () => {
      const result = parseVersionConstraint(">=1.2.3");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.operator).toBe(">=");
        expect(result.data.version).toBe("1.2.3");
      }
    });

    it("should reject invalid constraint format", () => {
      const result = parseVersionConstraint("invalid");
      expect(result.status).toBe("error");
    });
  });

  describe("satisfiesVersion", () => {
    it("should match exact version", () => {
      const constraint = { operator: "=" as const, version: "1.2.3" };
      expect(satisfiesVersion("1.2.3", constraint)).toBe(true);
      expect(satisfiesVersion("1.2.4", constraint)).toBe(false);
    });

    it("should match caret version", () => {
      const constraint = { operator: "^" as const, version: "1.2.3" };
      expect(satisfiesVersion("1.2.3", constraint)).toBe(true);
      expect(satisfiesVersion("1.3.0", constraint)).toBe(true);
      expect(satisfiesVersion("1.9.9", constraint)).toBe(true);
      expect(satisfiesVersion("2.0.0", constraint)).toBe(false);
    });

    it("should match tilde version", () => {
      const constraint = { operator: "~" as const, version: "1.2.3" };
      expect(satisfiesVersion("1.2.3", constraint)).toBe(true);
      expect(satisfiesVersion("1.2.4", constraint)).toBe(true);
      expect(satisfiesVersion("1.2.9", constraint)).toBe(true);
      expect(satisfiesVersion("1.3.0", constraint)).toBe(false);
    });

    it("should match greater than", () => {
      const constraint = { operator: ">" as const, version: "1.2.3" };
      expect(satisfiesVersion("1.2.4", constraint)).toBe(true);
      expect(satisfiesVersion("2.0.0", constraint)).toBe(true);
      expect(satisfiesVersion("1.2.3", constraint)).toBe(false);
    });

    it("should match greater than or equal", () => {
      const constraint = { operator: ">=" as const, version: "1.2.3" };
      expect(satisfiesVersion("1.2.3", constraint)).toBe(true);
      expect(satisfiesVersion("1.2.4", constraint)).toBe(true);
      expect(satisfiesVersion("1.2.2", constraint)).toBe(false);
    });
  });

  describe("ContractDependencyResolver", () => {
    it("should register contract metadata", () => {
      const metadata: ContractMetadata = {
        contractId: "contract1",
        version: "1.0.0",
        dependencies: [],
      };

      resolver.registerMetadata(metadata);
      const cached = resolver.getCachedMetadata("contract1");
      expect(cached).toBeDefined();
      expect(cached?.contractId).toBe("contract1");
      expect(cached?.version).toBe("1.0.0");
    });

    it("should clear cache for specific contract", () => {
      const metadata: ContractMetadata = {
        contractId: "contract1",
        version: "1.0.0",
        dependencies: [],
      };

      resolver.registerMetadata(metadata);
      resolver.clearCache("contract1");
      const cached = resolver.getCachedMetadata("contract1");
      expect(cached).toBeNull();
    });

    it("should clear all cache", () => {
      const metadata1: ContractMetadata = {
        contractId: "contract1",
        version: "1.0.0",
        dependencies: [],
      };
      const metadata2: ContractMetadata = {
        contractId: "contract2",
        version: "1.0.0",
        dependencies: [],
      };

      resolver.registerMetadata(metadata1);
      resolver.registerMetadata(metadata2);
      resolver.clearCache();

      expect(resolver.getCachedMetadata("contract1")).toBeNull();
      expect(resolver.getCachedMetadata("contract2")).toBeNull();
    });

    it("should build dependency graph for direct dependencies", async () => {
      const rootMetadata: ContractMetadata = {
        contractId: "root",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep1", version: "1.0.0" },
          { contractId: "dep2", version: "2.0.0" },
        ],
      };

      const dep1Metadata: ContractMetadata = {
        contractId: "dep1",
        version: "1.0.0",
        dependencies: [],
      };

      const dep2Metadata: ContractMetadata = {
        contractId: "dep2",
        version: "2.0.0",
        dependencies: [],
      };

      resolver.registerMetadata(rootMetadata);
      resolver.registerMetadata(dep1Metadata);
      resolver.registerMetadata(dep2Metadata);

      const result = await resolver.buildDependencyGraph("root");
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data.graph.root).toBe("root");
        expect(result.data.resolvedVersions.get("root")).toBe("1.0.0");
        expect(result.data.resolvedVersions.get("dep1")).toBe("1.0.0");
        expect(result.data.resolvedVersions.get("dep2")).toBe("2.0.0");
      }
    });

    it("should resolve nested dependencies", async () => {
      const rootMetadata: ContractMetadata = {
        contractId: "root",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep1", version: "1.0.0" },
        ],
      };

      const dep1Metadata: ContractMetadata = {
        contractId: "dep1",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep2", version: "2.0.0" },
        ],
      };

      const dep2Metadata: ContractMetadata = {
        contractId: "dep2",
        version: "2.0.0",
        dependencies: [],
      };

      resolver.registerMetadata(rootMetadata);
      resolver.registerMetadata(dep1Metadata);
      resolver.registerMetadata(dep2Metadata);

      const result = await resolver.buildDependencyGraph("root");
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data.resolvedVersions.get("root")).toBe("1.0.0");
        expect(result.data.resolvedVersions.get("dep1")).toBe("1.0.0");
        expect(result.data.resolvedVersions.get("dep2")).toBe("2.0.0");
      }
    });

    it("should detect circular dependencies", async () => {
      const rootMetadata: ContractMetadata = {
        contractId: "root",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep1", version: "1.0.0" },
        ],
      };

      const dep1Metadata: ContractMetadata = {
        contractId: "dep1",
        version: "1.0.0",
        dependencies: [
          { contractId: "root", version: "1.0.0" },
        ],
      };

      resolver.registerMetadata(rootMetadata);
      resolver.registerMetadata(dep1Metadata);

      const result = await resolver.buildDependencyGraph("root");
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("Circular dependency");
      }
    });

    it("should detect version conflicts", async () => {
      const rootMetadata: ContractMetadata = {
        contractId: "root",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep1", version: "1.0.0", versionConstraint: "^1.0.0" },
        ],
      };

      const dep1Metadata: ContractMetadata = {
        contractId: "dep1",
        version: "2.0.0", // Conflicts with ^1.0.0
        dependencies: [],
      };

      resolver.registerMetadata(rootMetadata);
      resolver.registerMetadata(dep1Metadata);

      const result = await resolver.buildDependencyGraph("root");
      expect(result.status).toBe("ok");

      if (result.status === "ok") {
        expect(result.data.conflicts.length).toBeGreaterThan(0);
        expect(result.data.conflicts[0].contractId).toBe("dep1");
      }
    });

    it("should handle missing dependencies", async () => {
      const rootMetadata: ContractMetadata = {
        contractId: "root",
        version: "1.0.0",
        dependencies: [
          { contractId: "missing", version: "1.0.0" },
        ],
      };

      resolver.registerMetadata(rootMetadata);

      const result = await resolver.buildDependencyGraph("root");
      expect(result.status).toBe("error");
    });

    it("should respect max depth limit", async () => {
      const config: DependencyResolverConfig = { maxDepth: 2 };
      const limitedResolver = createDependencyResolver(config);

      const rootMetadata: ContractMetadata = {
        contractId: "root",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep1", version: "1.0.0" },
        ],
      };

      const dep1Metadata: ContractMetadata = {
        contractId: "dep1",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep2", version: "1.0.0" },
        ],
      };

      const dep2Metadata: ContractMetadata = {
        contractId: "dep2",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep3", version: "1.0.0" },
        ],
      };

      const dep3Metadata: ContractMetadata = {
        contractId: "dep3",
        version: "1.0.0",
        dependencies: [],
      };

      limitedResolver.registerMetadata(rootMetadata);
      limitedResolver.registerMetadata(dep1Metadata);
      limitedResolver.registerMetadata(dep2Metadata);
      limitedResolver.registerMetadata(dep3Metadata);

      const result = await limitedResolver.buildDependencyGraph("root");
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("Maximum dependency depth");
      }
    });

    it("should get transitive dependencies", async () => {
      const rootMetadata: ContractMetadata = {
        contractId: "root",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep1", version: "1.0.0" },
        ],
      };

      const dep1Metadata: ContractMetadata = {
        contractId: "dep1",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep2", version: "1.0.0" },
        ],
      };

      const dep2Metadata: ContractMetadata = {
        contractId: "dep2",
        version: "1.0.0",
        dependencies: [],
      };

      resolver.registerMetadata(rootMetadata);
      resolver.registerMetadata(dep1Metadata);
      resolver.registerMetadata(dep2Metadata);

      const graphResult = await resolver.buildDependencyGraph("root");
      expect(graphResult.status).toBe("ok");

      if (graphResult.status === "ok") {
        const transitiveResult = resolver.getTransitiveDependencies(
          graphResult.data.graph,
          "root",
        );
        expect(transitiveResult.status).toBe("ok");

        if (transitiveResult.status === "ok") {
          expect(transitiveResult.data).toContain("dep1");
          expect(transitiveResult.data).toContain("dep2");
        }
      }
    });

    it("should check if contract has dependencies", async () => {
      const rootMetadata: ContractMetadata = {
        contractId: "root",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep1", version: "1.0.0" },
        ],
      };

      const dep1Metadata: ContractMetadata = {
        contractId: "dep1",
        version: "1.0.0",
        dependencies: [],
      };

      resolver.registerMetadata(rootMetadata);
      resolver.registerMetadata(dep1Metadata);

      const graphResult = await resolver.buildDependencyGraph("root");
      expect(graphResult.status).toBe("ok");

      if (graphResult.status === "ok") {
        expect(resolver.hasDependencies(graphResult.data.graph, "root")).toBe(true);
        expect(resolver.hasDependencies(graphResult.data.graph, "dep1")).toBe(false);
      }
    });

    it("should get dependency depth", async () => {
      const rootMetadata: ContractMetadata = {
        contractId: "root",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep1", version: "1.0.0" },
        ],
      };

      const dep1Metadata: ContractMetadata = {
        contractId: "dep1",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep2", version: "1.0.0" },
        ],
      };

      const dep2Metadata: ContractMetadata = {
        contractId: "dep2",
        version: "1.0.0",
        dependencies: [],
      };

      resolver.registerMetadata(rootMetadata);
      resolver.registerMetadata(dep1Metadata);
      resolver.registerMetadata(dep2Metadata);

      const graphResult = await resolver.buildDependencyGraph("root");
      expect(graphResult.status === "ok");

      if (graphResult.status === "ok") {
        expect(resolver.getDependencyDepth(graphResult.data.graph, "root")).toBe(0);
        expect(resolver.getDependencyDepth(graphResult.data.graph, "dep1")).toBe(1);
        expect(resolver.getDependencyDepth(graphResult.data.graph, "dep2")).toBe(2);
      }
    });

    it("should validate compatibility", async () => {
      const rootMetadata: ContractMetadata = {
        contractId: "root",
        version: "1.0.0",
        dependencies: [
          { contractId: "dep1", version: "1.0.0" },
        ],
      };

      const dep1Metadata: ContractMetadata = {
        contractId: "dep1",
        version: "1.0.0",
        dependencies: [],
      };

      resolver.registerMetadata(rootMetadata);
      resolver.registerMetadata(dep1Metadata);

      const graphResult = await resolver.buildDependencyGraph("root");
      expect(graphResult.status === "ok");

      if (graphResult.status === "ok") {
        const validation = resolver.validateCompatibility(graphResult.data.graph);
        expect(validation.status).toBe("ok");
        if (validation.status === "ok") {
          expect(validation.data.valid).toBe(true);
        }
      }
    });
  });
});
