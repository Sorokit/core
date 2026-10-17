/**
 * decodeContractEvent — decode a raw (unknown-shape) contract event record
 * into a typed DecodedContractEvent, optionally guided by an ABI.
 *
 * Two call shapes are supported:
 *
 * 1. **ABI-guided mode** — `decodeContractEvent(rawEvent, abi?)`. Returns a
 *    `SorokitResult<DecodedContractEvent>` classifying the event as
 *    `type: 'known'` (name found in the ABI) or `type: 'unknown'`.
 * 2. **Decoder-list mode (legacy)** — `decodeContractEvent(rawEvent, decoders)`.
 *    Custom decoders run first, then the built-in factory/router decoders. The
 *    decoded payload is returned directly, or `null` when nothing matched.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ContractEvent } from "./subscribeContractEvents";
import { decodeContractValue } from "./contractEncoding";
import type {
  DecodedContractEvent as AbiDecodedContractEvent,
  ContractAbi,
  ContractAbiObject,
  ContractAbiFunctionObject,
} from "./types";

/**
 * Result produced by the decoder-list call shape.
 *
 * Generic shape matches the pre-#808 public contract: `raw` is the original
 * event and `data` is the decoder-specific payload.
 */
export interface LegacyDecodedContractEvent<
  TType extends string = string,
  TData = unknown,
> {
  type: TType;
  contractId: string;
  data: TData;
  raw: ContractEvent;
  /** Event name that matched, when the decoder derived one. */
  name?: string;
  /** Normalised topics, when the decoder derived them. */
  topics?: string[];
}

/** Pre-#808 generic name, kept so existing imports keep compiling. */
export type DecodedContractEvent<
  TType extends string = string,
  TData = unknown,
> = LegacyDecodedContractEvent<TType, TData>;

/**
 * A custom contract event decoder. Returns `null` when the decoder does not
 * recognise the event.
 */
export type ContractEventDecoder<
  T extends DecodedContractEvent = DecodedContractEvent,
> = (event: ContractEvent) => T | null;

/** Payload produced by the built-in factory `pair_created` decoder. */
export interface PairCreatedEvent {
  tokenA: string;
  tokenB: string;
  pair: string;
}

/** Payload produced by the built-in router `swap` decoder. */
export interface SwapEvent {
  sender: string;
  path: string[];
  amountIn: string;
  amountOut: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Duck-type guard — checks for an xdr.ScVal-like object with a `.switch()` method */
function isScValLike(value: unknown): value is { switch: () => unknown } {
  return isRecord(value) && typeof (value as Record<string, unknown>).switch === "function";
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry) => entry != null).map((entry) => String(entry))
    : [];
}

/** Normalised event name: explicit name/event_type, else the last topic. */
function eventName(event: ContractEvent): string {
  const topics = event.topics ?? event.topic ?? [];
  return String(event.name || event.event_type || topics.at(-1) || "").toLowerCase();
}

/** Payload values as an array, wrapping a scalar value. */
function values(event: ContractEvent): unknown[] {
  return Array.isArray(event.value) ? event.value : [event.value];
}

/** Built-in decoder for factory `pair_created` events. */
export const decodeFactoryEvent: ContractEventDecoder<
  LegacyDecodedContractEvent<"factory.pair_created", PairCreatedEvent>
> = (event) => {
  const name = eventName(event);
  if (!["pair_created", "paircreated", "created"].includes(name)) {
    return null;
  }

  const data = values(event);
  if (data.length < 3) {
    return null;
  }

  return {
    type: "factory.pair_created",
    contractId: String(event.contractId ?? event.contract_id ?? ""),
    name,
    topics: toStringArray(event.topics),
    data: {
      tokenA: String(data[0]),
      tokenB: String(data[1]),
      pair: String(data[2]),
    },
    raw: event,
  };
};

/** Built-in decoder for router `swap` events. */
export const decodeRouterEvent: ContractEventDecoder<
  LegacyDecodedContractEvent<"router.swap", SwapEvent>
> = (event) => {
  const name = eventName(event);
  if (!["swap", "swapped", "swap_executed"].includes(name)) {
    return null;
  }

  const data = values(event);
  if (data.length < 4 || !Array.isArray(data[1])) {
    return null;
  }

  return {
    type: "router.swap",
    contractId: String(event.contractId ?? event.contract_id ?? ""),
    name,
    topics: toStringArray(event.topics),
    data: {
      sender: String(data[0]),
      path: (data[1] as unknown[]).map((entry) => String(entry)),
      amountIn: String(data[2]),
      amountOut: String(data[3]),
    },
    raw: event,
  };
};

const BUILT_IN_EVENT_DECODERS: readonly ContractEventDecoder[] = [
  decodeFactoryEvent,
  decodeRouterEvent,
];

/**
 * Run custom decoders (in order) followed by the built-in decoders.
 */
function runLegacyDecoders(
  event: ContractEvent,
  customDecoders: readonly ContractEventDecoder[],
): DecodedContractEvent | null {
  for (const decoder of [...customDecoders, ...BUILT_IN_EVENT_DECODERS]) {
    try {
      const decoded = decoder(event);
      if (decoded) {
        return decoded;
      }
    } catch {
      // A misbehaving custom decoder must not break the whole decode.
      continue;
    }
  }

  return null;
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
 * Decode a raw contract event object.
 *
 * Decoder-list mode returns the decoded payload directly (or `null`). ABI-guided
 * mode returns a `SorokitResult<DecodedContractEvent>`; malformed input yields
 * `err(CONTRACT_READ_FAILED, ...)`.
 */
export function decodeContractEventWithAbi(
  rawEvent: unknown,
  abi?: ContractAbi,
): SorokitResult<AbiDecodedContractEvent> {

  if (!isRecord(rawEvent) || Array.isArray(rawEvent)) {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      "malformed event: expected an object",
    );
  }

  try {
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

    return ok<AbiDecodedContractEvent>({
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

/**
 * Decode a raw contract event with the legacy decoder-list contract (#543).
 *
 * Custom decoders run first, then the built-in factory/router decoders. Returns
 * `null` when no decoder recognises the event.
 */
export function decodeContractEvent(
  event: ContractEvent,
  additionalDecoders: readonly ContractEventDecoder[] = [],
): DecodedContractEvent | null {
  if (!isRecord(event) || Array.isArray(event)) {
    return null;
  }

  return runLegacyDecoders(event, additionalDecoders);
}
