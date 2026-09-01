/**
 * Contract event archival module.
 *
 * Provides persistent storage and querying for contract events.
 * Enables long-term analytics beyond live event subscriptions.
 *
 * @module soroban/eventArchival
 *
 * @example
 * import {
 *   EventArchivalManager,
 *   InMemoryEventArchiveStorage,
 * } from "sorokit-core";
 *
 * // Create storage
 * const storage = new InMemoryEventArchiveStorage();
 *
 * // Create manager
 * const manager = new EventArchivalManager(storage, {
 *   batchSize: 50,
 *   deduplicate: true,
 * });
 *
 * // Start archiving
 * const subscription = await manager.archiveContractEvents(
 *   "CONTRACT123",
 *   undefined,
 *   { horizonUrl: "https://horizon-testnet.stellar.org" }
 * );
 *
 * // Query archived events
 * const results = await manager.queryArchivedEvents({
 *   contractIds: ["CONTRACT123"],
 *   fromTimestamp: Date.now() - 86400000,
 *   limit: 100,
 * });
 *
 * // Get aggregations
 * const stats = await manager.getEventAggregation({
 *   contractIds: ["CONTRACT123"],
 * }, 3600000); // 1 hour buckets
 *
 * // Stop archiving
 * subscription.data.unsubscribe();
 */

export { EventArchivalManager, queryContractEventArchive, calculateArchivedEventRate, getArchivedEventTimeSeries } from "./eventArchivalManager";
export { InMemoryEventArchiveStorage } from "./inMemoryStorage";

export type {
  EventArchiveStorage,
  ArchivedContractEvent,
  EventArchiveQuery,
  ArchiveQueryResult,
  PaginationInfo,
  TimeSeriesBucket,
  EventTypeCount,
  EventAggregation,
  EventArchivalOptions,
  EventArchivalSubscription,
  ArchivalStats,
  StorageStats,
} from "./types";
