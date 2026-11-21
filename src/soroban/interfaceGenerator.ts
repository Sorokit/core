import type { ParsedABI } from "./abiParser";

const TS_TYPES: Record<string, string> = {
  bool: "boolean",
  void: "void",
  string: "string",
  symbol: "string",
  address: "string",
  u32: "number",
  i32: "number",
  u64: "bigint",
  i64: "bigint",
  u128: "bigint",
  i128: "bigint",
  u256: "bigint",
  i256: "bigint",
  bytes: "Uint8Array",
};

function toTs(type: string): string {
  const wrapped = /^(vec|option)<(.+)>$/.exec(type);
  if (wrapped) {
    const inner = toTs(wrapped[2]!);
    return wrapped[1] === "vec" ? `Array<${inner}>` : `${inner} | undefined`;
  }
  return TS_TYPES[type] ?? "unknown";
}

/**
 * Generate TypeScript interface source for a contract ABI.
 * Returns a string; writing it to disk is the caller's responsibility.
 */
export function generateInterface(abi: ParsedABI, name = "Contract"): string {
  const lines = abi.methods.map((m) => {
    const params = m.args.map((a) => `${a.name}: ${toTs(a.type)}`).join(", ");
    return `  ${m.name}(${params}): Promise<${toTs(m.returns)}>;`;
  });
  return `export interface ${name} {\n${lines.join("\n")}\n}\n`;
}
