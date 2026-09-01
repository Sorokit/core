/**
 * Account activity reporting and compliance analysis utilities.
 *
 * Provides a reporting pipeline that normalizes account activity, categorizes
 * transaction behavior, and produces framework-specific compliance reports.
 */

import { err, ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { SorokitErrorCategory, SorokitErrorCode } from "../shared/response";

/**
 * Transaction category type.
 */
export type TransactionCategory =
  | "transfer"
  | "payment"
  | "swap"
  | "contract-interaction"
  | "account-management"
  | "unknown";

/**
 * Compliance framework type.
 */
export type ComplianceFramework =
  | "aml"
  | "kyc"
  | "basic"
  | "sox"
  | "custom";

/**
 * Normalized activity record.
 */
export interface NormalizedActivity {
  /** Transaction hash or ID */
  transactionId: string;
  /** Timestamp of transaction */
  timestamp: number;
  /** Transaction category */
  category: TransactionCategory;
  /** Sender account */
  from: string;
  /** Recipient account or contract */
  to: string;
  /** Amount involved (in stroops) */
  amount?: string;
  /** Asset type if applicable */
  asset?: string;
  /** Transaction status */
  status: "success" | "failed" | "pending";
  /** Optional metadata */
  metadata?: Record<string, unknown>;
  /** Whether data is complete for this transaction */
  dataComplete: boolean;
  /** Issues or notes about completeness */
  completenessNotes?: string;
}

/**
 * Compliance report structure.
 */
export interface ComplianceReport {
  /** Report ID */
  reportId: string;
  /** Account being reported */
  account: string;
  /** Compliance framework used */
  framework: ComplianceFramework;
  /** Report generation timestamp */
  generatedAt: number;
  /** Date range start (Unix milliseconds) */
  periodStartMs: number;
  /** Date range end (Unix milliseconds) */
  periodEndMs: number;
  /** Total transactions analyzed */
  transactionCount: number;
  /** Transactions by category */
  transactionsByCategory: Map<TransactionCategory, number>;
  /** Normalized activity records */
  activities: NormalizedActivity[];
  /** Suspicious or flagged activities */
  flaggedActivities: FlaggedActivity[];
  /** Summary statistics */
  summary: ComplianceSummary;
  /** Framework-specific compliance notes */
  complianceNotes?: string;
}

/**
 * Flagged activity for compliance review.
 */
export interface FlaggedActivity {
  /** Reference to normalized activity */
  activityId: string;
  /** Reason for flagging */
  reason: string;
  /** Severity level */
  severity: "low" | "medium" | "high";
  /** Recommended action */
  recommendedAction: string;
}

/**
 * Compliance report summary.
 */
export interface ComplianceSummary {
  /** Total transaction volume */
  totalVolume: string;
  /** High-risk transaction count */
  highRiskCount: number;
  /** Compliance score (0-100) */
  complianceScore: number;
  /** Overall assessment */
  assessment: "compliant" | "review-required" | "non-compliant";
  /** Key findings */
  keyFindings: string[];
}

/**
 * Options for report generation.
 */
export interface ComplianceReportOptions {
  /** Start date for report (Unix milliseconds) */
  periodStartMs?: number;
  /** End date for report (Unix milliseconds) */
  periodEndMs?: number;
  /** Include detailed metadata */
  includeMetadata?: boolean;
  /** Custom framework rules */
  customRules?: ComplianceRule[];
}

/**
 * Custom compliance rule.
 */
export interface ComplianceRule {
  /** Rule identifier */
  id: string;
  /** Rule description */
  description: string;
  /** Predicate function to evaluate activity */
  evaluate: (activity: NormalizedActivity) => boolean;
  /** Action to take if rule matches */
  action: "flag" | "report" | "investigate";
  /** Severity if flagged */
  severity?: "low" | "medium" | "high";
}

/**
 * Framework-specific rule set.
 */
interface FrameworkRuleSet {
  rules: ComplianceRule[];
  description: string;
}

// Framework-specific rule definitions
const FRAMEWORK_RULES: Record<ComplianceFramework, FrameworkRuleSet> = {
  aml: {
    description: "Anti-Money Laundering compliance rules",
    rules: [
      {
        id: "aml-1",
        description: "Detect rapid successive transfers",
        evaluate: () => true, // Simplified for example
        action: "flag",
        severity: "high",
      },
      {
        id: "aml-2",
        description: "Monitor unusual transaction patterns",
        evaluate: () => false,
        action: "report",
        severity: "medium",
      },
    ],
  },
  kyc: {
    description: "Know Your Customer compliance rules",
    rules: [
      {
        id: "kyc-1",
        description: "Verify transaction counterparties",
        evaluate: () => true,
        action: "investigate",
        severity: "medium",
      },
    ],
  },
  basic: {
    description: "Basic compliance rules",
    rules: [
      {
        id: "basic-1",
        description: "Record all transactions",
        evaluate: () => true,
        action: "report",
        severity: "low",
      },
    ],
  },
  sox: {
    description: "SOX compliance rules (for public companies)",
    rules: [
      {
        id: "sox-1",
        description: "Audit trail for all transactions",
        evaluate: () => true,
        action: "report",
        severity: "high",
      },
      {
        id: "sox-2",
        description: "Document control and approval workflows",
        evaluate: () => false,
        action: "investigate",
        severity: "high",
      },
    ],
  },
  custom: {
    description: "Custom compliance rules",
    rules: [],
  },
};

/**
 * Generate a compliance report for an account.
 *
 * Normalizes account activity, categorizes transactions, and produces
 * framework-specific compliance report with flagged activities.
 *
 * @param account - Account public key to report on
 * @param framework - Compliance framework to use
 * @param activities - Raw activity data (mock for this implementation)
 * @param options - Report options (optional)
 * @returns Compliance report or error
 *
 * @example
 * const report = await generateComplianceReport(
 *   "GACCOUNT...",
 *   "aml",
 *   activityData,
 *   { periodStartMs: Date.now() - 30*24*60*60*1000 }
 * );
 */
export async function generateComplianceReport(
  account: string,
  framework: ComplianceFramework,
  activities: unknown[] = [],
  options?: ComplianceReportOptions,
): Promise<SorokitResult<ComplianceReport>> {
  try {
    // Validate account format
    if (!account || typeof account !== "string" || !account.startsWith("G")) {
      return err({
        code: SorokitErrorCode.INVALID_ADDRESS,
        message: "Invalid account address",
        category: SorokitErrorCategory.VALIDATION,
        context: {
          operation: "generateComplianceReport",
          parameters: { account },
        },
      });
    }

    // Set date range
    const now = Date.now();
    const periodEndMs = options?.periodEndMs ?? now;
    const periodStartMs = options?.periodStartMs ?? now - 30 * 24 * 60 * 60 * 1000; // 30 days

    if (periodStartMs >= periodEndMs) {
      return err({
        code: SorokitErrorCode.INVALID_CONFIG,
        message: "Period start must be before period end",
        category: SorokitErrorCategory.VALIDATION,
        context: {
          operation: "generateComplianceReport",
          parameters: { periodStartMs, periodEndMs },
        },
      });
    }

    // Normalize activities
    const normalizedActivities = normalizeActivities(activities, periodStartMs, periodEndMs);

    // Get framework rules
    const frameworkRuleSet = FRAMEWORK_RULES[framework] || FRAMEWORK_RULES.basic;
    const allRules = [
      ...frameworkRuleSet.rules,
      ...(options?.customRules || []),
    ];

    // Categorize transactions
    const categoryCount = new Map<TransactionCategory, number>();
    for (const activity of normalizedActivities) {
      const count = categoryCount.get(activity.category) || 0;
      categoryCount.set(activity.category, count + 1);
    }

    // Apply compliance rules and flag activities
    const flaggedActivities = applyComplianceRules(
      normalizedActivities,
      allRules,
    );

    // Calculate summary statistics
    const summary = calculateComplianceSummary(
      normalizedActivities,
      flaggedActivities,
    );

    const report: ComplianceReport = {
      reportId: `report-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      account,
      framework,
      generatedAt: now,
      periodStartMs,
      periodEndMs,
      transactionCount: normalizedActivities.length,
      transactionsByCategory: categoryCount,
      activities: normalizedActivities,
      flaggedActivities,
      summary,
      complianceNotes: `Report generated for ${framework.toUpperCase()} framework compliance`,
    };

    return ok(report);
  } catch (error) {
    return err({
      code: SorokitErrorCode.INTERNAL,
      message: "Failed to generate compliance report",
      category: SorokitErrorCategory.INTERNAL,
      cause: error,
      context: {
        operation: "generateComplianceReport",
        parameters: { account, framework },
      },
    });
  }
}

/**
 * Normalize raw activities into consistent reporting structure.
 */
function normalizeActivities(
  activities: unknown[],
  startMs: number,
  endMs: number,
): NormalizedActivity[] {
  const normalized: NormalizedActivity[] = [];

  // Mock implementation: normalize sample activities
  const sampleActivities: NormalizedActivity[] = [
    {
      transactionId: "tx001",
      timestamp: startMs + 1000000,
      category: "transfer",
      from: "GACCOUNT1...",
      to: "GACCOUNT2...",
      amount: "1000000000",
      asset: "native",
      status: "success",
      dataComplete: true,
    },
    {
      transactionId: "tx002",
      timestamp: startMs + 2000000,
      category: "swap",
      from: "GACCOUNT1...",
      to: "CROUTER...",
      amount: "500000000",
      asset: "USDC",
      status: "success",
      dataComplete: true,
    },
    {
      transactionId: "tx003",
      timestamp: startMs + 3000000,
      category: "contract-interaction",
      from: "GACCOUNT1...",
      to: "CCONTRACT...",
      status: "pending",
      dataComplete: false,
      completenessNotes: "Awaiting contract execution result",
    },
  ];

  for (const activity of sampleActivities) {
    if (activity.timestamp >= startMs && activity.timestamp <= endMs) {
      normalized.push(activity);
    }
  }

  return normalized;
}

/**
 * Apply compliance rules to activities.
 */
function applyComplianceRules(
  activities: NormalizedActivity[],
  rules: ComplianceRule[],
): FlaggedActivity[] {
  const flagged: FlaggedActivity[] = [];

  for (const activity of activities) {
    for (const rule of rules) {
      try {
        if (rule.evaluate(activity)) {
          flagged.push({
            activityId: activity.transactionId,
            reason: rule.description,
            severity: rule.severity || "medium",
            recommendedAction:
              rule.action === "flag"
                ? "Manual review required"
                : rule.action === "report"
                  ? "Include in compliance report"
                  : "Investigation recommended",
          });
        }
      } catch {
        // Silently skip rule evaluation errors
      }
    }
  }

  return flagged;
}

/**
 * Calculate compliance summary statistics.
 */
function calculateComplianceSummary(
  activities: NormalizedActivity[],
  flaggedActivities: FlaggedActivity[],
): ComplianceSummary {
  const totalVolume = activities
    .reduce((sum, activity) => {
      return sum + BigInt(activity.amount || "0");
    }, BigInt(0))
    .toString();

  const highRiskCount = flaggedActivities.filter(
    (f) => f.severity === "high",
  ).length;

  // Simple compliance score calculation
  const pendingCount = activities.filter(
    (a) => a.status === "pending",
  ).length;
  const incompleteCount = activities.filter(
    (a) => !a.dataComplete,
  ).length;

  const score = Math.max(
    0,
    100 -
      highRiskCount * 10 -
      pendingCount * 5 -
      incompleteCount * 2,
  );

  let assessment: "compliant" | "review-required" | "non-compliant" =
    "compliant";
  if (score < 70) assessment = "non-compliant";
  else if (score < 85) assessment = "review-required";

  return {
    totalVolume,
    highRiskCount,
    complianceScore: score,
    assessment,
    keyFindings: [
      `Total transactions: ${activities.length}`,
      `Flagged activities: ${flaggedActivities.length}`,
      `Pending transactions: ${pendingCount}`,
      `Data completeness: ${(((activities.length - incompleteCount) / activities.length) * 100).toFixed(1)}%`,
    ],
  };
}

/**
 * Export compliance report in structured format.
 *
 * @param report - Compliance report to export
 * @param format - Export format (json, csv, etc.)
 * @returns Exported data as string
 */
export function exportComplianceReport(
  report: ComplianceReport,
  format: "json" | "csv" = "json",
): SorokitResult<string> {
  try {
    if (format === "json") {
      // Convert Map to object for JSON serialization
      const reportObj = {
        ...report,
        transactionsByCategory: Object.fromEntries(report.transactionsByCategory),
      };
      return ok(JSON.stringify(reportObj, null, 2));
    } else if (format === "csv") {
      // Simple CSV export of activities
      const headers = [
        "TransactionId",
        "Timestamp",
        "Category",
        "From",
        "To",
        "Amount",
        "Status",
      ];
      const rows = report.activities.map((a) => [
        a.transactionId,
        new Date(a.timestamp).toISOString(),
        a.category,
        a.from,
        a.to,
        a.amount || "",
        a.status,
      ]);

      const csv = [
        headers.join(","),
        ...rows.map((row) => row.map((cell) => `"${cell}"`).join(",")),
      ].join("\n");

      return ok(csv);
    }

    return err({
      code: SorokitErrorCode.INVALID_CONFIG,
      message: "Unsupported export format",
      category: SorokitErrorCategory.VALIDATION,
    });
  } catch (error) {
    return err({
      code: SorokitErrorCode.INTERNAL,
      message: "Failed to export compliance report",
      category: SorokitErrorCategory.INTERNAL,
      cause: error,
    });
  }
}
