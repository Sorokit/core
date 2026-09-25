/**
 * Contract Dependency Resolution and Version Management (#498)
 *
 * Provides a dependency resolver that builds a dependency graph from contract metadata,
 * tracks required versions, and validates compatibility before a contract is used.
 */

import { ok, err, SorokitResult, SorokitErrorCode } from "../shared/response";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ContractDependency {
  contractId: string;
  version: string;
  versionConstraint?: string; // e.g., "^1.0.0", "~2.1.0", ">=3.0.0"
}

export interface ContractMetadata {
  contractId: string;
  version: string;
  dependencies?: ContractDependency[];
  // Additional metadata can be added as needed
}

export interface DependencyNode {
  contractId: string;
  version: string;
  dependencies: Map<string, DependencyNode>;
  depth: number;
}

export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  root: string;
}

export interface VersionConflict {
  contractId: string;
  requiredVersions: string[];
  conflictingConstraints: string[];
  dependents: string[];
}

export interface ResolutionResult {
  graph: DependencyGraph;
  resolvedVersions: Map<string, string>;
  conflicts: VersionConflict[];
  circularDependencies: string[][];
}

export interface DependencyResolverConfig {
  cacheTtlMs?: number;
  enableCache?: boolean;
  maxDepth?: number;
}

// ─── Version Constraint Parsing ───────────────────────────────────────────────

export interface VersionConstraint {
  operator: ">" | ">=" | "=" | "<" | "<=" | "~" | "^";
  version: string;
}

export function parseVersionConstraint(
  constraint: string,
): SorokitResult<VersionConstraint> {
  const match = constraint.match(/^([~^]?)([><=]?)([\d.]+)$/);
  if (!match) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid version constraint: ${constraint}`,
    );
  }

  const [, prefix, operator, version] = match;
  let finalOperator: VersionConstraint["operator"] = "=";

  if (prefix === "~") {
    finalOperator = "~";
  } else if (prefix === "^") {
    finalOperator = "^";
  } else if (operator === ">") {
    finalOperator = ">";
  } else if (operator === ">=") {
    finalOperator = ">=";
  } else if (operator === "<") {
    finalOperator = "<";
  } else if (operator === "<=") {
    finalOperator = "<=";
  }

  return ok({ operator: finalOperator, version });
}

export function satisfiesVersion(
  version: string,
  constraint: VersionConstraint,
): boolean {
  const v1 = parseVersion(version);
  const v2 = parseVersion(constraint.version);

  if (!v1 || !v2) return false;

  switch (constraint.operator) {
    case "=":
      return compareVersions(v1, v2) === 0;
    case ">":
      return compareVersions(v1, v2) > 0;
    case ">=":
      return compareVersions(v1, v2) >= 0;
    case "<":
      return compareVersions(v1, v2) < 0;
    case "<=":
      return compareVersions(v1, v2) <= 0;
    case "~":
      // ~1.2.3 means >=1.2.3 <1.3.0
      if (v1.major !== v2.major || v1.minor !== v2.minor) return false;
      return compareVersions(v1, v2) >= 0;
    case "^":
      // ^1.2.3 means >=1.2.3 <2.0.0
      if (v1.major !== v2.major) return false;
      return compareVersions(v1, v2) >= 0;
    default:
      return false;
  }
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(version: string): ParsedVersion | null {
  const parts = version.split(".").map(Number);
  if (parts.length < 2 || parts.some(isNaN)) return null;
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
  };
}

function compareVersions(v1: ParsedVersion, v2: ParsedVersion): number {
  if (v1.major !== v2.major) return v1.major - v2.major;
  if (v1.minor !== v2.minor) return v1.minor - v2.minor;
  return v1.patch - v2.patch;
}

// ─── Dependency Graph Construction ────────────────────────────────────────────

export class ContractDependencyResolver {
  private metadataCache: Map<string, { metadata: ContractMetadata; timestamp: number }>;
  private config: Required<DependencyResolverConfig>;

  constructor(config: DependencyResolverConfig = {}) {
    this.metadataCache = new Map();
    this.config = {
      cacheTtlMs: config.cacheTtlMs ?? 5 * 60 * 1000, // 5 minutes default
      enableCache: config.enableCache ?? true,
      maxDepth: config.maxDepth ?? 50,
    };
  }

  /**
   * Register contract metadata for dependency resolution
   */
  registerMetadata(metadata: ContractMetadata): void {
    if (this.config.enableCache) {
      this.metadataCache.set(metadata.contractId, {
        metadata,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Get cached metadata if available and not expired
   */
  getCachedMetadata(contractId: string): ContractMetadata | null {
    if (!this.config.enableCache) return null;

    const cached = this.metadataCache.get(contractId);
    if (!cached) return null;

    const isExpired = Date.now() - cached.timestamp > this.config.cacheTtlMs;
    if (isExpired) {
      this.metadataCache.delete(contractId);
      return null;
    }

    return cached.metadata;
  }

  /**
   * Clear cached metadata for a specific contract or all contracts
   */
  clearCache(contractId?: string): void {
    if (contractId) {
      this.metadataCache.delete(contractId);
    } else {
      this.metadataCache.clear();
    }
  }

  /**
   * Refresh metadata cache for a specific contract
   */
  async refreshMetadata(
    contractId: string,
    fetchMetadata: (contractId: string) => Promise<ContractMetadata>,
  ): Promise<SorokitResult<ContractMetadata>> {
    try {
      const metadata = await fetchMetadata(contractId);
      this.registerMetadata(metadata);
      return ok(metadata);
    } catch (error) {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `Failed to refresh metadata for ${contractId}`,
        error,
      );
    }
  }

  /**
   * Build dependency graph starting from a root contract
   */
  async buildDependencyGraph(
    rootContractId: string,
    fetchMetadata?: (contractId: string) => Promise<ContractMetadata>,
  ): Promise<SorokitResult<ResolutionResult>> {
    const nodes = new Map<string, DependencyNode>();
    const conflicts: VersionConflict[] = [];
    const circularDeps: string[][] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const path: string[] = [];

    const resolveNode = async (
      contractId: string,
      depth: number,
    ): Promise<SorokitResult<DependencyNode>> => {
      if (depth > this.config.maxDepth) {
        return err(
          SorokitErrorCode.VALIDATION,
          `Maximum dependency depth exceeded: ${depth}`,
        );
      }

      // Check for circular dependencies
      if (visiting.has(contractId)) {
        const cycleStart = path.indexOf(contractId);
        const cycle = [...path.slice(cycleStart), contractId];
        circularDeps.push(cycle);
        return err(
          SorokitErrorCode.VALIDATION,
          `Circular dependency detected: ${cycle.join(" -> ")}`,
        );
      }

      if (visited.has(contractId)) {
        const existing = nodes.get(contractId);
        if (!existing) {
          return err(
            SorokitErrorCode.INTERNAL,
            `Inconsistent state: visited node not found`,
          );
        }
        return ok(existing);
      }

      visiting.add(contractId);
      path.push(contractId);

      // Get metadata (from cache or fetch)
      let metadata = this.getCachedMetadata(contractId);
      if (!metadata && fetchMetadata) {
        const fetchResult = await fetchMetadata(contractId);
        if (fetchResult.status === "error") {
          return err(
            SorokitErrorCode.NETWORK_ERROR,
            `Failed to fetch metadata for ${contractId}`,
            fetchResult.error.cause,
          );
        }
        metadata = fetchResult.data;
        this.registerMetadata(metadata);
      }

      if (!metadata) {
        return err(
          SorokitErrorCode.VALIDATION,
          `Metadata not found for contract: ${contractId}`,
        );
      }

      // Create node
      const node: DependencyNode = {
        contractId,
        version: metadata.version,
        dependencies: new Map(),
        depth,
      };

      // Resolve dependencies recursively
      if (metadata.dependencies) {
        for (const dep of metadata.dependencies) {
          const depResult = await resolveNode(dep.contractId, depth + 1);
          if (depResult.status === "error") {
            return depResult;
          }

          const depNode = depResult.data;

          // Check version constraint if specified
          if (dep.versionConstraint) {
            const constraintResult = parseVersionConstraint(dep.versionConstraint);
            if (constraintResult.status === "error") {
              return constraintResult;
            }

            if (!satisfiesVersion(depNode.version, constraintResult.data)) {
              conflicts.push({
                contractId: dep.contractId,
                requiredVersions: [dep.version],
                conflictingConstraints: [dep.versionConstraint],
                dependents: [contractId],
              });
            }
          }

          node.dependencies.set(dep.contractId, depNode);
        }
      }

      nodes.set(contractId, node);
      visited.add(contractId);
      visiting.delete(contractId);
      path.pop();

      return ok(node);
    };

    const rootResult = await resolveNode(rootContractId, 0);
    if (rootResult.status === "error") {
      return rootResult;
    }

    const resolvedVersions = new Map<string, string>();
    nodes.forEach((node, id) => {
      resolvedVersions.set(id, node.version);
    });

    return ok({
      graph: {
        nodes,
        root: rootContractId,
      },
      resolvedVersions,
      conflicts,
      circularDependencies: circularDeps,
    });
  }

  /**
   * Validate that all dependencies in the graph are compatible
   */
  validateCompatibility(
    graph: DependencyGraph,
  ): SorokitResult<{ valid: boolean; conflicts: VersionConflict[] }> {
    const conflicts: VersionConflict[] = [];
    const versionRequirements = new Map<string, Set<string>>();

    // Collect all version requirements for each contract
    const collectRequirements = (node: DependencyNode) => {
      node.dependencies.forEach((dep, depId) => {
        if (!versionRequirements.has(depId)) {
          versionRequirements.set(depId, new Set());
        }
        versionRequirements.get(depId)!.add(dep.version);
        collectRequirements(dep);
      });
    };

    const rootNode = graph.nodes.get(graph.root);
    if (!rootNode) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Root contract not found in graph: ${graph.root}`,
      );
    }

    collectRequirements(rootNode);

    // Check for conflicts
    versionRequirements.forEach((versions, contractId) => {
      if (versions.size > 1) {
        const node = graph.nodes.get(contractId);
        conflicts.push({
          contractId,
          requiredVersions: Array.from(versions),
          conflictingConstraints: [],
          dependents: [],
        });
      }
    });

    return ok({
      valid: conflicts.length === 0,
      conflicts,
    });
  }

  /**
   * Get all transitive dependencies for a contract
   */
  getTransitiveDependencies(
    graph: DependencyGraph,
    contractId: string,
  ): SorokitResult<string[]> {
    const node = graph.nodes.get(contractId);
    if (!node) {
      return err(
        SorokitErrorCode.VALIDATION,
        `Contract not found in graph: ${contractId}`,
      );
    }

    const dependencies: string[] = [];
    const collect = (n: DependencyNode) => {
      n.dependencies.forEach((dep, depId) => {
        dependencies.push(depId);
        collect(dep);
      });
    };

    collect(node);
    return ok(dependencies);
  }

  /**
   * Check if a contract has any dependencies
   */
  hasDependencies(graph: DependencyGraph, contractId: string): boolean {
    const node = graph.nodes.get(contractId);
    return node ? node.dependencies.size > 0 : false;
  }

  /**
   * Get dependency depth for a contract
   */
  getDependencyDepth(graph: DependencyGraph, contractId: string): number {
    const node = graph.nodes.get(contractId);
    return node ? node.depth : -1;
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

const defaultResolver = new ContractDependencyResolver();

export function createDependencyResolver(
  config?: DependencyResolverConfig,
): ContractDependencyResolver {
  return new ContractDependencyResolver(config);
}

export function getDefaultResolver(): ContractDependencyResolver {
  return defaultResolver;
}
