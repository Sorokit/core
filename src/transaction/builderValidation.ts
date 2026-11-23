import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { TransactionOperation } from "./transactionBuilder";

export interface TransactionBuilderFieldRule {
  required?: boolean;
  type?: "string" | "number" | "boolean" | "object" | "array";
  min?: number;
  max?: number;
  pattern?: RegExp;
}

export interface TransactionBuilderSchema {
  fields: Record<string, TransactionBuilderFieldRule>;
  validate?: (operation: TransactionOperation) => string | undefined;
}

export interface TransactionBuilderValidationIssue {
  field: string;
  message: string;
}

export function createTransactionBuilderSchema(
  fields: Record<string, TransactionBuilderFieldRule>,
  validate?: (operation: TransactionOperation) => string | undefined,
): TransactionBuilderSchema {
  return { fields: { ...fields }, ...(validate ? { validate } : {}) };
}

export function validateTransactionBuilder(
  operation: TransactionOperation,
  schema: TransactionBuilderSchema,
): SorokitResult<TransactionOperation> {
  const issues: TransactionBuilderValidationIssue[] = [];
  if (!operation || typeof operation !== "object") {
    return err(SorokitErrorCode.VALIDATION, "Transaction operation is required");
  }
  if (typeof operation.type !== "string" || operation.type.trim() === "") {
    issues.push({ field: "type", message: "type is required" });
  }
  if (!operation.params || typeof operation.params !== "object" || Array.isArray(operation.params)) {
    issues.push({ field: "params", message: "params must be an object" });
  } else {
    for (const [field, rule] of Object.entries(schema.fields)) {
      const value = operation.params[field];
      if (value === undefined || value === null) {
        if (rule.required) issues.push({ field, message: `${field} is required` });
        continue;
      }
      if (rule.type && (rule.type === "array" ? !Array.isArray(value) : typeof value !== rule.type)) {
        issues.push({ field, message: `${field} must be a ${rule.type}` });
        continue;
      }
      if (typeof value === "string" || typeof value === "number") {
        const size = typeof value === "string" ? value.length : value;
        if (rule.min !== undefined && size < rule.min) issues.push({ field, message: `${field} is below the minimum` });
        if (rule.max !== undefined && size > rule.max) issues.push({ field, message: `${field} exceeds the maximum` });
        if (rule.pattern && typeof value === "string" && !rule.pattern.test(value)) issues.push({ field, message: `${field} has an invalid format` });
      }
    }
  }
  const customIssue = schema.validate?.(operation);
  if (customIssue) issues.push({ field: "operation", message: customIssue });
  return issues.length === 0
    ? ok(operation)
    : err(SorokitErrorCode.VALIDATION, issues.map((issue) => `${issue.field}: ${issue.message}`).join("; "), issues);
}

export function validateTransactionOperations(
  operations: ReadonlyArray<TransactionOperation>,
  schema: TransactionBuilderSchema,
): SorokitResult<ReadonlyArray<TransactionOperation>> {
  for (const operation of operations) {
    const result = validateTransactionBuilder(operation, schema);
    if (result.status === "error") return result;
  }
  return ok(operations);
}
