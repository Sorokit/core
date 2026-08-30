export type ContractAuditStatus = "success" | "failed";

export interface ContractAuditEntry {
  timestamp: number;
  caller: string;
  contractId: string;
  functionName: string;
  transactionId?: string;
  durationMs?: number;
  status: ContractAuditStatus;
  sanitizedArgs?: Record<string, unknown>;
}

const auditEntries: ContractAuditEntry[] = [];

export function recordContractInvocation(entry: Omit<ContractAuditEntry, "timestamp">): ContractAuditEntry {
  const record: ContractAuditEntry = {
    ...entry,
    timestamp: Date.now(),
  };
  auditEntries.push(record);
  return record;
}

export interface ContractAuditFilter {
  caller?: string;
  contractId?: string;
  functionName?: string;
  status?: ContractAuditStatus;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export function queryContractAuditLog(filters?: ContractAuditFilter): ContractAuditEntry[] {
  let results = [...auditEntries];

  if (filters) {
    if (filters.caller) results = results.filter((e) => e.caller === filters.caller);
    if (filters.contractId) results = results.filter((e) => e.contractId === filters.contractId);
    if (filters.functionName) results = results.filter((e) => e.functionName === filters.functionName);
    if (filters.status) results = results.filter((e) => e.status === filters.status);
    if (filters.since) results = results.filter((e) => e.timestamp >= filters.since!);
    if (filters.until) results = results.filter((e) => e.timestamp <= filters.until!);
  }

  results.sort((a, b) => a.timestamp - b.timestamp);

  const offset = filters?.offset ?? 0;
  const limit = filters?.limit ?? results.length;
  return results.slice(offset, offset + limit);
}

export function exportAuditLogAsJson(entries?: ContractAuditEntry[]): string {
  return JSON.stringify(entries ?? auditEntries, null, 2);
}

export function exportAuditLogAsCsv(entries?: ContractAuditEntry[]): string {
  const data = entries ?? auditEntries;
  if (data.length === 0) return "";

  const headers = ["timestamp", "caller", "contractId", "functionName", "transactionId", "durationMs", "status"];
  const rows = data.map((e) =>
    headers.map((h) => {
      const val = (e as unknown as Record<string, unknown>)[h];
      return val === undefined || val === null ? "" : String(val);
    }).join(","),
  );

  return [headers.join(","), ...rows].join("\n");
}

export function clearContractAuditLog(): void {
  auditEntries.length = 0;
}
