import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export type StorageSlotType = "ledger" | "instance";

export interface StorageSlotInfo {
  slotType: StorageSlotType;
  capacity: string;
  retentionPeriod: string;
  costModel: string;
  notes: string;
}

const SLOT_DESCRIPTIONS: Record<StorageSlotType, Omit<StorageSlotInfo, "slotType">> = {
  ledger: {
    capacity:
      "Bounded per transaction by network resource limits (footprint entries × max entry size). " +
      "Each temporary entry may be up to 64 KB; the total footprint is capped by the network ledger-entry limit.",
    retentionPeriod:
      "Temporary. Entries are automatically evicted after their TTL expires " +
      "(network minimum: 16 ledgers; current default: ~110 days equivalent). " +
      "TTL can be extended at any time by paying rent through an ExtendFootprintTTL operation.",
    costModel:
      "Charged per byte-ledger (bytes stored × ledgers retained). " +
      "Upfront rent must cover the minimum TTL; each extension costs proportionally to bytes × additional ledgers.",
    notes:
      "Best suited for short-lived state such as nonces, session tokens, and per-call scratch space. " +
      "Eviction is non-destructive to contract logic. " +
      "Use instance or persistent storage for state that must survive beyond the retention window.",
  },
  instance: {
    capacity:
      "Shared single entry for the entire contract instance, bounded by the max contract instance size " +
      "(current network limit: 64 KB total including code and data).",
    retentionPeriod:
      "Persists for the lifetime of the contract instance. " +
      "Evicted only when the instance's TTL expires; TTL is automatically extended " +
      "on every contract invocation, so actively-used contracts rarely need manual renewal.",
    costModel:
      "Charged per byte-ledger for the entire instance entry. " +
      "Invocations automatically extend the TTL by at least the minimum TTL, " +
      "amortising rent cost across all callers.",
    notes:
      "Ideal for contract metadata, administrator configuration, feature flags, " +
      "and small frequently-read values. " +
      "Avoid storing large blobs here; use persistent storage for per-user or per-record data.",
  },
};

export function describeStorageSlot(slotType: StorageSlotType): SorokitResult<StorageSlotInfo> {
  const info = SLOT_DESCRIPTIONS[slotType];
  if (info === undefined) {
    return err(
      SorokitErrorCode.UNKNOWN,
      `Unknown storage slot type: "${String(slotType)}". Valid types are: ledger, instance.`,
    );
  }
  return ok({ slotType, ...info });
}
