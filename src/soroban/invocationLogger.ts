import { sanitizeLogMeta } from "../shared/logger";

function sanitizeInvocationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeInvocationValue);
  if (!value || typeof value !== "object") return value;
  const sanitized = sanitizeLogMeta(value as Record<string, unknown>) ?? {};
  return Object.fromEntries(
    Object.entries(sanitized).map(([key, entry]) => [key, sanitizeInvocationValue(entry)]),
  );
}

export type InvocationStatus = "success" | "error";

export interface InvocationLogEntry {
  contractId: string;
  method: string;
  args: unknown[];
  result: unknown;
  timestamp: string;
  durationMs: number;
  status: InvocationStatus;
}

export interface InvocationLoggerOptions {
  contractId?: string;
  onEntry?: (entry: InvocationLogEntry) => void;
}

export interface InvocationLogger {
  log<T>(contractId: string, method: string, args: unknown[], invoke: () => Promise<T>): Promise<T>;
  entries(): InvocationLogEntry[];
  clear(): void;
}

export function createInvocationLogger(options: InvocationLoggerOptions = {}): InvocationLogger {
  const records: InvocationLogEntry[] = [];
  return {
    async log<T>(
      contractId: string,
      method: string,
      args: unknown[],
      invoke: () => Promise<T>,
    ) {
      if (options.contractId && options.contractId !== contractId) return invoke();
      const started = Date.now();
      const timestamp = new Date(started).toISOString();
      try {
        const result = await invoke();
        const entry = { contractId, method, args: sanitizeInvocationValue(args) as unknown[], result: sanitizeInvocationValue(result), timestamp, durationMs: Date.now() - started, status: "success" as const };
        records.push(entry);
        options.onEntry?.(entry);
        return result;
      } catch (cause) {
        const entry = { contractId, method, args: sanitizeInvocationValue(args) as unknown[], result: sanitizeInvocationValue(cause instanceof Error ? cause.message : cause), timestamp, durationMs: Date.now() - started, status: "error" as const };
        records.push(entry);
        options.onEntry?.(entry);
        throw cause;
      }
    },
    entries: () => records.map((entry) => ({ ...entry, args: [...entry.args] })),
    clear: () => { records.length = 0; },
  };
}
