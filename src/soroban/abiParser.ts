import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { contractMetadataInternals } from "./contractMetadata";
import type { ContractMethod } from "./types";

export interface ParsedAbiArg {
  name: string;
  type: string;
}

export interface ParsedAbiMethod {
  name: string;
  args: ParsedAbiArg[];
  returns: string;
}

export interface ParsedABI {
  methods: ParsedAbiMethod[];
}

/** Validate method signatures and convert contract methods into an ABI. */
export function buildABI(methods: ContractMethod[]): SorokitResult<ParsedABI> {
  const seen = new Set<string>();
  const parsed: ParsedAbiMethod[] = [];
  for (const m of methods) {
    if (!m.name || seen.has(m.name)) {
      return err(SorokitErrorCode.VALIDATION, `Invalid or duplicate method name: "${m.name}"`);
    }
    seen.add(m.name);
    const bad = m.inputs.find((i) => !i.name || !i.type);
    if (bad) {
      return err(SorokitErrorCode.VALIDATION, `Method "${m.name}" has an argument without a name or type`);
    }
    parsed.push({
      name: m.name,
      args: m.inputs.map((i) => ({ name: i.name, type: i.type })),
      returns: m.returnType ?? "void",
    });
  }
  return ok({ methods: parsed });
}

/** Fetch the deployed contract spec from RPC and parse its method signatures. Not cached. */
export async function parseABI(
  rpcUrl: string,
  contractId: string,
): Promise<SorokitResult<ParsedABI>> {
  try {
    const wasm = await contractMetadataInternals.fetchContractWasm(rpcUrl, contractId);
    if (wasm.status === "error") return wasm;
    return buildABI(contractMetadataInternals.parseContractMethodsFromWasm(wasm.data));
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      `Failed to parse contract ABI: ${toMessage(cause)}`,
      cause,
    );
  }
}
