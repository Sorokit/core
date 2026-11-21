/**
 * decodeContractEvent — decode a raw (unknown-shape) contract event record
 * into a typed DecodedContractEvent, optionally guided by an ABI.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { decodeContractValue } from "./contractEncoding";
import type { DecodedContractEvent, ContractAbi, ContractAbiObject, ContractAbiFunctionObject } from "./types";

export type ContractEventDecoder = (event: Record<string, unknown>) =>
  | (Partial<DecodedContractEvent> & { type: string; contractId: string; data?: unknown; raw: unknown })
  | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Duck-type guard — checks for an xdr.ScVal-like object with a `.switch()` method */
function isScValLike(value: unknown): value is { switch: () => unknown } {
  return isRecord(value) && typeof (value as Record<string, unknown>).switch === "function";
}

function hasMethod(abi: ContractAbi, name: string): boolean {
  if (Array.isArray(abi)) {
    // xdr.ScSpecFunctionV0[] — each entry has a name() method
    return abi.some((fn) => {
      try {
        return (fn as any).name?.().toString() === name;
      } catch {
        return false;
      }
    });
  }

  if (isRecord(abi)) {
    if ("methods" in abi) {
      return (abi as ContractAbiObject).methods.some((m) => m.name === name);
    }
    if ("functions" in abi) {
      return (abi as ContractAbiFunctionObject).functions.some((m) => m.name === name);
    }
    // ContractAbiSpec — has funcs() method
    if (typeof (abi as Record<string, unknown>).funcs === "function") {
      try {
        const funcs = (abi as any).funcs() as unknown[];
        return funcs.some((fn) => {
          try {
            return (fn as any).name?.().toString() === name;
          } catch {
            return false;
          }
        });
      } catch {
        return false;
      }
    }
  }

  return false;
}

/**
 * Decode a raw contract event object into a `DecodedContractEvent`.
 *
 * - If `abi` is provided and the event name is found in the ABI the event is
 *   classified as `type: 'known'`; otherwise `type: 'unknown'`.
 * - The `value` field is decoded via `decodeContractValue` when the raw value
 *   looks like an xdr.ScVal (duck-type check on `.switch()`).
 *
 * Returns `err(CONTRACT_READ_FAILED, ...)` for malformed input or decode errors.
 */
export function decodeContractEvent(
  rawEvent: unknown,
  abi?: ContractAbi,
  customDecoders: ContractEventDecoder[] = [],
): SorokitResult<DecodedContractEvent & { data?: unknown }> {
  if (!isRecord(rawEvent) || Array.isArray(rawEvent)) {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      "malformed event: expected an object",
    );
  }

  try {
    for (const decoder of customDecoders) {
      const custom = decoder(rawEvent);
      if (custom) return ok(custom as DecodedContractEvent & { data?: unknown });
    }

    const contractId = String(rawEvent.contractId ?? rawEvent.contract_id ?? "");
    const name = String(rawEvent.name ?? rawEvent.event_type ?? "");

    const rawTopics = rawEvent.topics;
    const topics: string[] = Array.isArray(rawTopics)
      ? rawTopics
          .filter((t): t is string | number | boolean => t != null)
          .map(String)
      : [];

    const rawValue = rawEvent.value;

    // Determine type and attempt decoding
    let eventType: string;
    let decodedValue: unknown;

    if (abi !== undefined) {
      eventType = hasMethod(abi, name) ? "known" : "unknown";
    } else {
      eventType = "unknown";
    }

    if (isScValLike(rawValue)) {
      // Pass through to decodeContractValue — it expects an xdr.ScVal
      decodedValue = decodeContractValue(rawValue as any);
    } else {
      decodedValue = rawValue;
    }

    if (name === "pair_created" && Array.isArray(rawValue) && rawValue.length >= 3) {
      const [tokenA, tokenB, pair] = rawValue;
      return ok({
        contractId, name, topics, value: rawValue, raw: rawEvent,
        type: "factory.pair_created",
        data: { tokenA: String(tokenA), tokenB: String(tokenB), pair: String(pair) },
      });
    }
    if (topics[0] === "router" && topics[1] === "swap" && Array.isArray(rawValue) && rawValue.length >= 4) {
      const [sender, path, amountIn, amountOut] = rawValue;
      return ok({
        contractId, name, topics, value: rawValue, raw: rawEvent,
        type: "router.swap",
        data: {
          sender: String(sender),
          path: Array.isArray(path) ? path.map(String) : [],
          amountIn: String(amountIn),
          amountOut: String(amountOut),
        },
      });
    }

    return ok<DecodedContractEvent>({
      contractId,
      name,
      topics,
      value: decodedValue,
      raw: rawEvent,
      type: eventType,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return err(SorokitErrorCode.CONTRACT_READ_FAILED, message, caught);
  }
}
