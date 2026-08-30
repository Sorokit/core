export type KeyRotationStatus = "success" | "failed";

export interface KeyRotationAuditEntry {
  timestamp: number;
  account: string;
  operator?: string;
  previousSigner: string;
  newSigner: string;
  transactionId?: string;
  status: KeyRotationStatus;
  reason?: string;
}

const auditLog: KeyRotationAuditEntry[] = [];

export function recordKeyRotation(entry: Omit<KeyRotationAuditEntry, "timestamp">): KeyRotationAuditEntry {
  const record: KeyRotationAuditEntry = {
    ...entry,
    timestamp: Date.now(),
  };
  auditLog.push(record);
  return record;
}

export interface GetKeyRotationHistoryOptions {
  limit?: number;
  offset?: number;
  status?: KeyRotationStatus;
}

export function getKeyRotationHistory(
  account: string,
  options?: GetKeyRotationHistoryOptions,
): KeyRotationAuditEntry[] {
  let entries = auditLog.filter((e) => e.account === account);

  if (options?.status) {
    entries = entries.filter((e) => e.status === options.status);
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);

  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? entries.length;
  return entries.slice(offset, offset + limit);
}

export function detectSuspiciousRotationPattern(
  account: string,
  windowMs: number = 3600_000,
  threshold: number = 3,
): boolean {
  const now = Date.now();
  const recent = auditLog.filter(
    (e) => e.account === account && e.timestamp >= now - windowMs,
  );
  return recent.length >= threshold;
}

export function clearKeyRotationAuditLog(): void {
  auditLog.length = 0;
}
