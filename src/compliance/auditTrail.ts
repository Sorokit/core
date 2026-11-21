import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface AuditContext {
  before?: unknown;
  after?: unknown;
  [key: string]: unknown;
}

export interface AuditRecord {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly operation: string;
  readonly action: string;
  readonly actor: string;
  readonly context: Readonly<AuditContext>;
}

export interface AuditQueryOptions {
  actor?: string;
  action?: string;
  operation?: string;
  startTime?: string | Date | number;
  endTime?: string | Date | number;
  start?: string | Date | number;
  end?: string | Date | number;
}

export type AuditFilters = AuditQueryOptions;

export interface ComplianceDateRange {
  start?: string | Date | number;
  end?: string | Date | number;
  startTime?: string | Date | number;
  endTime?: string | Date | number;
}

export interface ComplianceAuditReport {
  generatedAt: string;
  range: { start: string; end: string };
  totalOperations: number;
  operationsByType: Record<string, number>;
  actors: string[];
  records: readonly AuditRecord[];
}

export interface AuditTrail {
  recordOperation(
    operation: string,
    actor: string,
    context?: AuditContext,
    customTimestamp?: string | Date | number,
  ): SorokitResult<AuditRecord>;
  recordAction(
    action: string,
    actor: string,
    context?: AuditContext,
    customTimestamp?: string | Date | number,
  ): SorokitResult<AuditRecord>;
  getAuditTrail(filters?: AuditFilters): SorokitResult<readonly AuditRecord[]>;
  queryAuditLog(options?: AuditQueryOptions): SorokitResult<readonly AuditRecord[]>;
  getAllEntries(): SorokitResult<readonly AuditRecord[]>;
  clear(): void;
  generateComplianceReport(range: ComplianceDateRange): SorokitResult<ComplianceAuditReport>;
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseTimestamp(value: string | Date | number | undefined | null): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? NaN : time;
  }
  if (typeof value === "number") {
    return Number.isNaN(value) ? NaN : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return NaN;
    }
    if (/^-?\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      return Number.isNaN(num) ? NaN : num;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  return NaN;
}

export function createAuditTrail(initialRecords: readonly AuditRecord[] = []): AuditTrail {
  const records: AuditRecord[] = [...initialRecords];
  let sequence = records.reduce((max, r) => Math.max(max, r.sequence ?? 0), 0);

  const queryAuditLog = (options: AuditQueryOptions = {}): SorokitResult<readonly AuditRecord[]> => {
    const rawStart = options.startTime ?? options.start;
    const rawEnd = options.endTime ?? options.end;

    const startMs = parseTimestamp(rawStart);
    const endMs = parseTimestamp(rawEnd);

    if (
      (startMs !== undefined && Number.isNaN(startMs)) ||
      (endMs !== undefined && Number.isNaN(endMs)) ||
      (startMs !== undefined && endMs !== undefined && startMs > endMs)
    ) {
      return err(SorokitErrorCode.INVALID_CONFIG, "Invalid audit date range");
    }

    const filtered = records.filter((record) => {
      const timestamp = Date.parse(record.timestamp);
      const targetAction = options.action ?? options.operation;

      if (options.actor && record.actor !== options.actor) {
        return false;
      }
      if (targetAction && record.operation !== targetAction && record.action !== targetAction) {
        return false;
      }
      if (startMs !== undefined && timestamp < startMs) {
        return false;
      }
      if (endMs !== undefined && timestamp > endMs) {
        return false;
      }
      return true;
    });

    return ok(Object.freeze(filtered));
  };

  const recordOperation = (
    operation: string,
    actor: string,
    context: AuditContext = {},
    customTimestamp?: string | Date | number,
  ): SorokitResult<AuditRecord> => {
    if (!operation.trim() || !actor.trim()) {
      return err(SorokitErrorCode.INVALID_CONFIG, "operation and actor are required");
    }

    let timestamp: string;
    if (customTimestamp !== undefined && customTimestamp !== null) {
      const ms = parseTimestamp(customTimestamp);
      if (ms === undefined || Number.isNaN(ms)) {
        return err(SorokitErrorCode.INVALID_CONFIG, "Invalid timestamp");
      }
      timestamp = new Date(ms).toISOString();
    } else {
      timestamp = new Date().toISOString();
    }

    const record: AuditRecord = Object.freeze({
      id: `${Date.now()}-${++sequence}`,
      sequence,
      timestamp,
      operation,
      action: operation,
      actor,
      context: deepFreeze(snapshot(context)),
    });
    records.push(record);
    return ok(record);
  };

  return {
    recordOperation,
    recordAction(action, actor, context = {}, customTimestamp) {
      return recordOperation(action, actor, context, customTimestamp);
    },
    getAuditTrail(filters = {}) {
      return queryAuditLog(filters);
    },
    queryAuditLog,
    getAllEntries() {
      return ok(Object.freeze([...records]));
    },
    clear() {
      records.length = 0;
      sequence = 0;
    },
    generateComplianceReport(range) {
      const result = queryAuditLog(range);
      if (result.status === "error") return result;
      const operationsByType: Record<string, number> = {};
      const actors = new Set<string>();
      for (const record of result.data) {
        operationsByType[record.operation] = (operationsByType[record.operation] ?? 0) + 1;
        actors.add(record.actor);
      }
      const rawStart = range.startTime ?? range.start;
      const rawEnd = range.endTime ?? range.end;
      const startMs = parseTimestamp(rawStart);
      const endMs = parseTimestamp(rawEnd);
      return ok({
        generatedAt: new Date().toISOString(),
        range: {
          start: startMs !== undefined ? new Date(startMs).toISOString() : "",
          end: endMs !== undefined ? new Date(endMs).toISOString() : "",
        },
        totalOperations: result.data.length,
        operationsByType,
        actors: [...actors].sort(),
        records: result.data,
      });
    },
  };
}

const defaultAuditTrail = createAuditTrail();
export const recordOperation = defaultAuditTrail.recordOperation;
export const recordAction = defaultAuditTrail.recordAction;
export const getAuditTrail = defaultAuditTrail.getAuditTrail;
export const queryAuditLog = defaultAuditTrail.queryAuditLog;
export const getAllEntries = defaultAuditTrail.getAllEntries;
export const clearAuditTrail = defaultAuditTrail.clear;
export const generateComplianceReport = defaultAuditTrail.generateComplianceReport;

