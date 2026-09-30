/**
 * React transaction status dashboard example (#708).
 *
 * Copy this pattern into your app. It subscribes to a
 * `TransactionStatusAggregator` (live metrics + chart data) and renders
 * success rate, fee analysis, status distribution, and recent transactions.
 */
import { useEffect, useState } from "react";
import {
  TransactionStatusAggregator,
  streamTransactionStatus,
  type DashboardSnapshot,
} from "../../src/transaction/transactionDashboard";
import type { TransactionResult } from "../../src/transaction/types";

export const dashboard = new TransactionStatusAggregator({ maxEntries: 1000 });

// Poll your transaction source and fan out to all subscribers.
export function startLiveUpdates(fetchRecent: () => Promise<TransactionResult[]>): () => void {
  const handle = streamTransactionStatus(fetchRecent, dashboard, { intervalMs: 5000 });
  return () => handle.stop();
}

export function TransactionStatusDashboard({ aggregator = dashboard }: { aggregator?: TransactionStatusAggregator }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(() => aggregator.getSnapshot());

  useEffect(() => aggregator.subscribe(setSnapshot), [aggregator]);

  return (
    <section aria-label="Transaction status dashboard">
      <header>
        <h2>Transactions ({snapshot.metrics.total})</h2>
        <p>
          Success rate: {(snapshot.metrics.successRate * 100).toFixed(1)}% · Avg fee:{" "}
          {snapshot.metrics.avgFee ?? "—"} · Avg confirmation:{" "}
          {snapshot.metrics.avgProcessingTimeMs !== null
            ? `${Math.round(snapshot.metrics.avgProcessingTimeMs)}ms`
            : "—"}
        </p>
      </header>
      <ul>
        {snapshot.charts.statusDistribution.map((s) => (
          <li key={s.label}>
            {s.label}: {s.value}
          </li>
        ))}
      </ul>
      <ol>
        {snapshot.recent.map((entry) => (
          <li key={entry.tx.hash}>
            {entry.tx.hash.slice(0, 8)}… — {entry.tx.status} ({entry.category})
          </li>
        ))}
      </ol>
    </section>
  );
}
