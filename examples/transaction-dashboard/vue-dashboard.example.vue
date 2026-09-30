<!--
  Vue transaction status dashboard example (#708).

  Subscribes to a `TransactionStatusAggregator` and renders live metrics,
  status distribution, and recent transactions. Unsubscribes on unmount so
  SPAs don't leak listeners.
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import {
  TransactionStatusAggregator,
  type DashboardSnapshot,
} from "../../src/transaction/transactionDashboard";

const props = defineProps<{ aggregator: TransactionStatusAggregator }>();
const snapshot = ref<DashboardSnapshot>(props.aggregator.getSnapshot());
let unsubscribe: (() => void) | undefined;

onMounted(() => {
  unsubscribe = props.aggregator.subscribe((next) => {
    snapshot.value = next;
  });
});

onUnmounted(() => {
  unsubscribe?.();
});
</script>

<template>
  <section aria-label="Transaction status dashboard">
    <header>
      <h2>Transactions ({{ snapshot.metrics.total }})</h2>
      <p>
        Success rate: {{ (snapshot.metrics.successRate * 100).toFixed(1) }}% · Avg fee:
        {{ snapshot.metrics.avgFee ?? "—" }}
      </p>
    </header>
    <ul>
      <li v-for="s in snapshot.charts.statusDistribution" :key="s.label">
        {{ s.label }}: {{ s.value }}
      </li>
    </ul>
    <ol>
      <li v-for="entry in snapshot.recent" :key="entry.tx.hash">
        {{ entry.tx.hash.slice(0, 8) }}… — {{ entry.tx.status }} ({{ entry.category }})
      </li>
    </ol>
  </section>
</template>
