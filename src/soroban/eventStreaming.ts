/**
 * Contract Event Stream — Monitor Contract Events in Real-Time (#990)
 *
 * Provides real-time event streaming and topic filtering for Soroban smart contracts.
 */

import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ContractEvent, ContractEventFilter } from "./subscribeContractEvents";

export interface ContractEventStreamOptions {
  filter?: ContractEventFilter | undefined;
  pollIntervalMs?: number | undefined;
  fetchEventsFn?: ((contractId: string, filter?: ContractEventFilter) => Promise<ContractEvent[]>) | undefined;
}

export class ContractEventStream {
  private active = false;
  private listeners: Set<(event: ContractEvent) => void> = new Set();
  private contractId: string;
  private options?: ContractEventStreamOptions | undefined;
  private timer: NodeJS.Timeout | null = null;
  private eventBuffer: ContractEvent[] = [];

  constructor(contractId: string, options?: ContractEventStreamOptions) {
    this.contractId = contractId;
    this.options = options;
  }

  onEvent(callback: (event: ContractEvent) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  pushEvent(event: ContractEvent): void {
    if (!this.matchesFilter(event)) return;

    this.eventBuffer.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private matchesFilter(event: ContractEvent): boolean {
    const f = this.options?.filter;
    if (!f) return true;

    if (f.eventType && event.eventType !== f.eventType) return false;
    if (f.contractId && event.contractId !== f.contractId && event.contract_id !== f.contractId) return false;
    if (f.topics && f.topics.length > 0) {
      const eventTopics = event.topics ?? event.topic ?? [];
      const match = f.topics.some((t) => {
        const strTopic = typeof t === "string" ? t : t.source;
        return eventTopics.some((et) => et && String(et).includes(strTopic));
      });
      if (!match) return false;
    }
    return true;
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;

    if (this.options?.fetchEventsFn) {
      const poll = async () => {
        if (!this.active) return;
        try {
          const events = await this.options!.fetchEventsFn!(this.contractId, this.options?.filter);
          for (const ev of events) {
            this.pushEvent(ev);
          }
        } catch {}
        if (this.active) {
          this.timer = setTimeout(poll, this.options?.pollIntervalMs ?? 2000);
        }
      };
      await poll();
    }
  }

  stop(): void {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get isStreaming(): boolean {
    return this.active;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ContractEvent> {
    while (this.active || this.eventBuffer.length > 0) {
      if (this.eventBuffer.length > 0) {
        yield this.eventBuffer.shift()!;
      } else {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
}

/**
 * Initialize contract event stream for a contract ID.
 */
export function createContractEventStream(
  contractId: string,
  options?: ContractEventStreamOptions,
): SorokitResult<ContractEventStream> {
  try {
    if (!contractId || typeof contractId !== "string" || contractId.trim().length === 0) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Cannot stream events: valid contractId is required",
      );
    }

    const stream = new ContractEventStream(contractId.trim(), options);
    return ok(stream);
  } catch (cause) {
    return err(
      SorokitErrorCode.INTERNAL,
      cause instanceof Error ? cause.message : "Failed to initialize contract event stream",
      cause,
    );
  }
}

export { createContractEventStream as streamContractEvents };
