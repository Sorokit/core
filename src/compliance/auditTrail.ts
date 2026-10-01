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
  readonly actor: string;
  readonly context: Readonly<AuditContext>;
}

export interface AuditFilters {
  actor?: string;
  operation?: string;
  start?: string | Date;
  end?: string | Date;
}

export interface ComplianceDateRange { start: string | Date; end: string | Date }

export interface ComplianceAuditReport {
  generatedAt: string;
  range: { start: string; end: string };
  totalOperations: number;
  operationsByType: Record<string, number>;
  actors: string[];
  records: readonly AuditRecord[];
}

export interface AuditTrail {
  recordOperation(operation: string, actor: string, context?: AuditContext): SorokitResult<AuditRecord>;
  getAuditTrail(filters?: AuditFilters): SorokitResult<readonly AuditRecord[]>;
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

export function createAuditTrail(): AuditTrail {
  const records: AuditRecord[] = [];
  let sequence = 0;

  const getAuditTrail = (filters: AuditFilters = {}): SorokitResult<readonly AuditRecord[]> => {
    const start = filters.start ? new Date(filters.start).getTime() : -Infinity;
    const end = filters.end ? new Date(filters.end).getTime() : Infinity;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      return err(SorokitErrorCode.INVALID_CONFIG, "Invalid audit date range");
    }
    return ok(Object.freeze(records.filter((record) => {
      const timestamp = Date.parse(record.timestamp);
      return (!filters.actor || record.actor === filters.actor)
        && (!filters.operation || record.operation === filters.operation)
        && timestamp >= start && timestamp <= end;
    })));
  };

  return {
    recordOperation(operation, actor, context = {}) {
      if (!operation.trim() || !actor.trim()) {
        return err(SorokitErrorCode.INVALID_CONFIG, "operation and actor are required");
      }
      const timestamp = new Date().toISOString();
      const record = Object.freeze({
        id: `${Date.now()}-${++sequence}`,
        sequence,
        timestamp,
        operation,
        actor,
        context: deepFreeze(snapshot(context)),
      });
      records.push(record);
      return ok(record);
    },
    getAuditTrail,
    generateComplianceReport(range) {
      const result = getAuditTrail(range);
      if (result.status === "error") return result;
      const operationsByType: Record<string, number> = {};
      const actors = new Set<string>();
      for (const record of result.data) {
        operationsByType[record.operation] = (operationsByType[record.operation] ?? 0) + 1;
        actors.add(record.actor);
      }
      return ok({
        generatedAt: new Date().toISOString(),
        range: { start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() },
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
export const getAuditTrail = defaultAuditTrail.getAuditTrail;
export const generateComplianceReport = defaultAuditTrail.generateComplianceReport;
