import { xdr } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { decodeContractValue } from "./contractEncoding";

export interface EventSchemaParameter {
  name: string;
  location: "topic" | "data";
}

export interface EventSchema {
  name: string;
  /** Number of leading topics reserved for the event prefix. */
  prefixTopics: number;
  params: EventSchemaParameter[];
}

export interface DecodedEvent<TData = Record<string, unknown>> {
  name: string;
  contractId?: string;
  /** All topics, including the event prefix, decoded to native values. */
  topics: unknown[];
  /** Named topic parameters from the event specification. */
  topicParams: Record<string, unknown>;
  /** Named data parameters, or the decoded event value when no params exist. */
  data: TData;
  raw: xdr.ContractEvent;
}

type EventSpecRecord = Record<string, unknown>;

function isRecord(value: unknown): value is EventSpecRecord {
  return typeof value === "object" && value !== null;
}

function readMember(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  const member = value[key];
  return typeof member === "function" ? member.call(value) : member;
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.toString === "function") {
    const text = value.toString();
    return text === "[object Object]" ? undefined : text;
  }
  return undefined;
}

function readEventEntry(entry: unknown): EventSpecRecord | undefined {
  if (!isRecord(entry)) return undefined;

  const switchValue = readMember(entry, "switch");
  const switchName = isRecord(switchValue) ? readString(switchValue.name) : undefined;
  if (switchName && switchName !== "scSpecEntryEventV0") return undefined;

  const eventValue =
    switchName === "scSpecEntryEventV0"
      ? readMember(entry, "scSpecEntryEventV0")
      : entry;
  return isRecord(eventValue) ? eventValue : undefined;
}

function readEventCandidates(abi: unknown): unknown[] {
  if (Array.isArray(abi)) return abi;
  if (!isRecord(abi)) return [];

  const events = readMember(abi, "events");
  if (Array.isArray(events)) return events;

  const entries = readMember(abi, "entries");
  if (Array.isArray(entries)) return entries;

  const spec = readMember(abi, "spec");
  if (Array.isArray(spec)) return spec;

  return [abi];
}

function normalizeLocation(value: unknown): "topic" | "data" | undefined {
  const text = readString(value);
  if (text) {
    const normalized = text.toLowerCase();
    if (normalized.includes("topic")) return "topic";
    if (normalized.includes("data")) return "data";
  }

  if (typeof value === "number") {
    const enumValues = (
      xdr as unknown as Record<string, unknown>
    ).ScSpecEventParamLocation;
    const topic = readMember(enumValues, "scSpecEventParamLocationTopic");
    const data = readMember(enumValues, "scSpecEventParamLocationData");
    if (value === topic) return "topic";
    if (value === data) return "data";
  }
  return undefined;
}

/**
 * Build a decoder schema from an ABI event declaration. The ABI may be an
 * array of ScSpecEntry XDR values or an object containing `events` or `entries`.
 *
 * @throws {Error} if the named event is absent or its parameters are invalid.
 */
export function createEventSchema(abi: unknown, eventName: string): EventSchema {
  const event = readEventCandidates(abi)
    .map(readEventEntry)
    .find((candidate) => readString(readMember(candidate, "name")) === eventName);

  if (!event) throw new Error(`Event "${eventName}" was not found in the ABI.`);

  const rawParams = readMember(event, "params");
  if (!Array.isArray(rawParams)) {
    throw new TypeError(`Event "${eventName}" has an invalid parameter list.`);
  }

  const params = rawParams.map((rawParam, index): EventSchemaParameter => {
    const name = readString(readMember(rawParam, "name"));
    const location = normalizeLocation(readMember(rawParam, "location"));
    if (!name || !location) {
      throw new TypeError(
        `Event "${eventName}" has an invalid parameter at index ${index}.`,
      );
    }
    return { name, location };
  });

  const prefixTopicsValue = readMember(event, "prefixTopics");
  const prefixTopics =
    prefixTopicsValue === undefined ? 0 : Number(prefixTopicsValue);
  if (!Number.isSafeInteger(prefixTopics) || prefixTopics < 0) {
    throw new TypeError(`Event "${eventName}" has an invalid topic prefix.`);
  }

  return { name: eventName, prefixTopics, params };
}

function isScVal(value: unknown): value is xdr.ScVal {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { switch?: unknown }).switch !== "function"
  ) {
    return false;
  }
  return true;
}

function decodeValue(value: unknown): unknown {
  if (!isScVal(value)) throw new TypeError("Expected a Soroban ScVal.");
  return decodeContractValue(value);
}

function getEventBody(event: unknown): EventSpecRecord {
  const body = readMember(event, "body");
  if (!isRecord(body)) throw new TypeError("Expected a contract event with a body.");

  const switchValue = readMember(body, "switch");
  const switchName = isRecord(switchValue) ? readString(switchValue.name) : undefined;
  if (switchName && switchName !== "contractEventV0") {
    throw new TypeError(`Unsupported contract event body "${switchName}".`);
  }

  const version0 = readMember(body, "v0");
  const eventBody = isRecord(version0) ? version0 : body;
  if (!Array.isArray(readMember(eventBody, "topics"))) {
    throw new TypeError("Contract event topics are missing or invalid.");
  }
  return eventBody;
}

function eventContractId(event: unknown): string | undefined {
  const value = readMember(event, "contractId");
  return value == null ? undefined : readString(value);
}

/**
 * Decode a Soroban contract event using the event's ABI-derived schema.
 */
export function decodeEvent<TData = Record<string, unknown>>(
  xdrEvent: xdr.ContractEvent,
  eventSchema: EventSchema,
): SorokitResult<DecodedEvent<TData>> {
  try {
    if (
      !eventSchema ||
      typeof eventSchema.name !== "string" ||
      !Number.isSafeInteger(eventSchema.prefixTopics) ||
      eventSchema.prefixTopics < 0 ||
      !Array.isArray(eventSchema.params)
    ) {
      throw new TypeError("Invalid event schema.");
    }

    const body = getEventBody(xdrEvent);
    const rawTopics = readMember(body, "topics") as unknown[];
    if (eventSchema.prefixTopics > rawTopics.length) {
      throw new TypeError("Event contains fewer topics than its schema prefix.");
    }

    const topics = rawTopics.map(decodeValue);
    const topicParams: Record<string, unknown> = {};
    const topicDefinitions = eventSchema.params.filter(
      (param) => param.location === "topic",
    );
    if (eventSchema.prefixTopics + topicDefinitions.length > rawTopics.length) {
      throw new TypeError("Event contains fewer topics than its schema requires.");
    }
    topicDefinitions.forEach((param, index) => {
      topicParams[param.name] = topics[eventSchema.prefixTopics + index];
    });

    const rawData = readMember(body, "data");
    const dataDefinitions = eventSchema.params.filter(
      (param) => param.location === "data",
    );
    let data: unknown;
    if (dataDefinitions.length === 0) {
      data = decodeValue(rawData);
    } else if (dataDefinitions.length === 1) {
      data = { [dataDefinitions[0].name]: decodeValue(rawData) };
    } else {
      if (!isScVal(rawData) || rawData.switch().name !== "scvVec") {
        throw new TypeError("Event data must be a vector for multiple data parameters.");
      }
      const values = rawData.vec();
      if (!values || values.length !== dataDefinitions.length) {
        throw new TypeError("Event data does not match the schema parameter count.");
      }
      data = Object.fromEntries(
        dataDefinitions.map((param, index) => [
          param.name,
          decodeContractValue(values[index]),
        ]),
      );
    }

    const contractId = eventContractId(xdrEvent);
    return ok({
      name: eventSchema.name,
      ...(contractId !== undefined ? { contractId } : {}),
      topics,
      topicParams,
      data: data as TData,
      raw: xdrEvent,
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.XDR_INVALID,
      cause instanceof Error ? cause.message : String(cause),
      cause,
    );
  }
}
