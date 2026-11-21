/**
 * Deterministic helpers for keys used to identify Soroban contract data entries.
 * Object fields are sorted recursively; array order remains meaningful.
 */

export type ContractDataKey = Readonly<Record<string, unknown>>;

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `{"$bigint":${JSON.stringify(value.toString())}}`;
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  if (typeof value !== "object") return JSON.stringify(value);

  if (seen.has(value)) throw new TypeError("ContractDataKey cannot contain circular references");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalize(entry, seen)).join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry, seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Serialize a contract data key canonically for equality checks and cache keys.
 * The result is independent of object insertion order at every nesting level.
 */
export function serializeContractDataKey(key: ContractDataKey): string {
  if (key === null || typeof key !== "object" || Array.isArray(key)) {
    throw new TypeError("ContractDataKey must be a non-null object");
  }
  return canonicalize(key, new Set<object>());
}

/** Compare two contract data keys by their canonical serialization. */
export function equalContractDataKeys(left: ContractDataKey, right: ContractDataKey): boolean {
  return serializeContractDataKey(left) === serializeContractDataKey(right);
}
