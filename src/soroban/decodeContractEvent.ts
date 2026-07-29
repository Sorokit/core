import type { ContractEvent } from "./subscribeContractEvents";

export interface DecodedContractEvent<TType extends string = string, TData = unknown> {
  type: TType;
  contractId: string;
  data: TData;
  raw: ContractEvent;
}

export type ContractEventDecoder<T extends DecodedContractEvent = DecodedContractEvent> = (
  event: ContractEvent,
) => T | null;

export interface PairCreatedEvent {
  tokenA: string;
  tokenB: string;
  pair: string;
}

export interface SwapEvent {
  sender: string;
  path: string[];
  amountIn: string;
  amountOut: string;
}

function eventName(event: ContractEvent): string {
  const topics = event.topics ?? event.topic ?? [];
  return String(event.name || topics.at(-1) || "").toLowerCase();
}

function values(event: ContractEvent): unknown[] {
  return Array.isArray(event.value) ? event.value : [event.value];
}

export const decodeFactoryEvent: ContractEventDecoder = (event) => {
  const name = eventName(event);
  const data = values(event);
  if (!["pair_created", "paircreated", "created"].includes(name)) return null;
  if (data.length < 3) return null;
  return {
    type: "factory.pair_created",
    contractId: String(event.contractId ?? event.contract_id ?? ""),
    data: {
      tokenA: String(data[0]),
      tokenB: String(data[1]),
      pair: String(data[2]),
    } satisfies PairCreatedEvent,
    raw: event,
  };
};

export const decodeRouterEvent: ContractEventDecoder = (event) => {
  const name = eventName(event);
  const data = values(event);
  if (!["swap", "swapped", "swap_executed"].includes(name)) return null;
  if (data.length < 4 || !Array.isArray(data[1])) return null;
  return {
    type: "router.swap",
    contractId: String(event.contractId ?? event.contract_id ?? ""),
    data: {
      sender: String(data[0]),
      path: data[1].map(String),
      amountIn: String(data[2]),
      amountOut: String(data[3]),
    } satisfies SwapEvent,
    raw: event,
  };
};

const builtInDecoders: readonly ContractEventDecoder[] = [
  decodeFactoryEvent,
  decodeRouterEvent,
];

export function decodeContractEvent(
  event: ContractEvent,
  additionalDecoders: readonly ContractEventDecoder[] = [],
): DecodedContractEvent | null {
  for (const decoder of [...additionalDecoders, ...builtInDecoders]) {
    const decoded = decoder(event);
    if (decoded) return decoded;
  }
  return null;
}
