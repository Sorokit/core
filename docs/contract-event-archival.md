# Contract Event Archival

Persistent storage and querying layer for Soroban contract events, enabling long-term analytics beyond live event subscriptions.

## Overview

The contract event archival module provides:

- **Persistent storage** - Archive events from live subscriptions
- **Historical queries** - Search archived events with filters and pagination
- **Time series analytics** - Aggregate events over time intervals
- **Pluggable storage** - Replaceable storage adapters for any backend
- **Deduplication** - Automatic handling of duplicate events
- **Error isolation** - Storage failures don't corrupt live event streams

## Quick Start

```typescript
import {
  EventArchivalManager,
  InMemoryEventArchiveStorage,
} from "sorokit-core";

// Create storage adapter
const storage = new InMemoryEventArchiveStorage();

// Create archival manager
const manager = new EventArchivalManager(storage, {
  batchSize: 50,
  deduplicate: true,
});

// Start archiving contract events
const subscription = await manager.archiveContractEvents(
  "CONTRACT_ADDRESS",
  undefined, // optional filter
  {
    horizonUrl: "https://horizon-testnet.stellar.org",
    intervalMs: 1500,
  }
);

// Query archived events
const results = await manager.queryArchivedEvents({
  contractIds: ["CONTRACT_ADDRESS"],
  fromTimestamp: Date.now() - 86400000, // Last 24 hours
  limit: 100,
});

// Get aggregated statistics
const stats = await manager.getEventAggregation({
  contractIds: ["CONTRACT_ADDRESS"],
}, 3600000); // 1 hour buckets

// Stop archiving
subscription.data.unsubscribe();
```

## Storage Adapters

### In-Memory Storage

Stores events in memory for testing and development:

```typescript
import { InMemoryEventArchiveStorage } from "sorokit-core";

const storage = new InMemoryEventArchiveStorage();
```

**Use cases:**
- Testing
- Development
- Prototyping

**Limitations:**
- Data lost on restart
- Limited by available memory
- Not suitable for production

### Custom Storage Adapters

Implement the `EventArchiveStorage` interface for production use:

```typescript
import type { EventArchiveStorage } from "sorokit-core";

class DatabaseStorage implements EventArchiveStorage {
  async store(events) {
    // Store in database
    return ok(undefined);
  }

  async query(query) {
    // Query from database
    return ok({ events: [], pagination: {...} });
  }

  async aggregate(query, intervalMs) {
    // Aggregate data
    return ok({ total: 0, byType: [], rate: 0 });
  }

  async delete(query) {
    // Delete events
    return ok(0);
  }

  async exists(eventId) {
    // Check existence
    return false;
  }

  async getStats() {
    // Return stats
    return ok({ totalEvents: 0, uniqueContracts: 0 });
  }
}
```

**Recommended backends:**
- **PostgreSQL** - Full-featured SQL with JSON support
- **MongoDB** - Document storage with flexible schemas
- **TimescaleDB** - Time-series optimized PostgreSQL
- **ClickHouse** - Analytics-optimized columnar database
- **Amazon S3** - Object storage for long-term archival
- **Google BigQuery** - Serverless analytics

## Archiving Events

### Basic Archival

```typescript
const subscription = await manager.archiveContractEvents(
  "CONTRACT_ADDRESS",
  undefined,
  { horizonUrl: "https://horizon-testnet.stellar.org" }
);
```

### With Filtering

Archive only specific event types:

```typescript
const subscription = await manager.archiveContractEvents(
  "CONTRACT_ADDRESS",
  {
    eventTypes: ["transfer", "mint"],
    topics: ["important-topic"],
  },
  { horizonUrl: "https://horizon-testnet.stellar.org" }
);
```

### With Error Handling

Handle storage failures gracefully:

```typescript
const manager = new EventArchivalManager(storage, {
  batchSize: 50,
  deduplicate: true,
  onStorageError: (error, failedEvents) => {
    console.error("Storage error:", error.message);
    console.log("Failed to store:", failedEvents.length, "events");
    // Log to monitoring service, retry queue, etc.
  },
});
```

### Monitoring Archival

```typescript
const subscription = await manager.archiveContractEvents(...);

// Check stats periodically
setInterval(() => {
  const stats = subscription.data.getStats();
  console.log("Archived:", stats.archivedCount);
  console.log("Duplicates skipped:", stats.duplicateCount);
  console.log("Errors:", stats.errorCount);
}, 60000);
```

## Querying Archived Events

### Basic Query

```typescript
const result = await manager.queryArchivedEvents({
  contractIds: ["CONTRACT_ADDRESS"],
});

if (result.status === "ok") {
  console.log("Found:", result.data.events.length);
  console.log("Total:", result.data.pagination.total);
}
```

### Filter by Event Type

```typescript
const result = await manager.queryArchivedEvents({
  contractIds: ["CONTRACT_ADDRESS"],
  eventTypes: ["transfer", "mint"],
});
```

### Filter by Time Range

```typescript
const result = await manager.queryArchivedEvents({
  contractIds: ["CONTRACT_ADDRESS"],
  fromTimestamp: Date.now() - 86400000, // Last 24 hours
  toTimestamp: Date.now(),
});
```

### Filter by Ledger Range

```typescript
const result = await manager.queryArchivedEvents({
  contractIds: ["CONTRACT_ADDRESS"],
  fromLedger: 1000000,
  toLedger: 1001000,
});
```

### Filter by Topics

```typescript
const result = await manager.queryArchivedEvents({
  topics: ["specific-topic"],
});

// Or with regex
const result = await manager.queryArchivedEvents({
  topics: [/topic-\d+/],
});
```

### Pagination

```typescript
// Page 1
const page1 = await manager.queryArchivedEvents({
  limit: 100,
  offset: 0,
});

// Page 2
const page2 = await manager.queryArchivedEvents({
  limit: 100,
  offset: 100,
});

// Check if more results available
if (page1.status === "ok" && page1.data.pagination.hasMore) {
  // Load next page
}
```

### Sorting

```typescript
// Sort by timestamp, newest first
const result = await manager.queryArchivedEvents({
  orderBy: "timestamp",
  order: "desc",
});

// Sort by ledger, oldest first
const result = await manager.queryArchivedEvents({
  orderBy: "ledger",
  order: "asc",
});

// Sort by contract ID
const result = await manager.queryArchivedEvents({
  orderBy: "contractId",
  order: "asc",
});
```

### Complex Queries

Combine multiple filters:

```typescript
const result = await manager.queryArchivedEvents({
  contractIds: ["CONTRACT_1", "CONTRACT_2"],
  eventTypes: ["transfer"],
  topics: [/important-.*/],
  fromTimestamp: Date.now() - 604800000, // Last week
  limit: 50,
  orderBy: "timestamp",
  order: "desc",
});
```

## Aggregations and Analytics

### Event Counts by Type

```typescript
const result = await manager.getEventAggregation({
  contractIds: ["CONTRACT_ADDRESS"],
});

if (result.status === "ok") {
  console.log("Total events:", result.data.total);
  console.log("By type:");
  for (const { eventType, count } of result.data.byType) {
    console.log(`  ${eventType}: ${count}`);
  }
}
```

### Event Rate

```typescript
const result = await manager.getEventAggregation({
  contractIds: ["CONTRACT_ADDRESS"],
  fromTimestamp: Date.now() - 3600000, // Last hour
});

if (result.status === "ok") {
  console.log("Events per second:", result.data.rate);
}
```

### Time Series Data

```typescript
const result = await manager.getEventAggregation(
  {
    contractIds: ["CONTRACT_ADDRESS"],
    fromTimestamp: Date.now() - 86400000, // Last 24 hours
  },
  3600000 // 1 hour buckets
);

if (result.status === "ok" && result.data.timeSeries) {
  for (const bucket of result.data.timeSeries) {
    console.log(new Date(bucket.timestamp), ":", bucket.count, "events");
  }
}
```

### Custom Analytics

```typescript
// Get events for custom processing
const result = await manager.queryArchivedEvents({
  contractIds: ["CONTRACT_ADDRESS"],
  fromTimestamp: startTime,
  toTimestamp: endTime,
  limit: 10000,
});

if (result.status === "ok") {
  // Custom aggregation logic
  const uniqueEmitters = new Set(
    result.data.events.map((e) => e.emitter).filter(Boolean)
  );
  console.log("Unique emitters:", uniqueEmitters.size);
}
```

## Helper Functions

### Standalone Query

```typescript
import { queryContractEventArchive } from "sorokit-core";

const result = await queryContractEventArchive(storage, {
  contractIds: ["CONTRACT_ADDRESS"],
  limit: 100,
});
```

### Calculate Event Rate

```typescript
import { calculateArchivedEventRate } from "sorokit-core";

const rate = await calculateArchivedEventRate(storage, {
  contractIds: ["CONTRACT_ADDRESS"],
  fromTimestamp: Date.now() - 3600000,
});

if (rate.status === "ok") {
  console.log("Events per second:", rate.data);
}
```

### Get Time Series

```typescript
import { getArchivedEventTimeSeries } from "sorokit-core";

const timeSeries = await getArchivedEventTimeSeries(
  storage,
  {
    contractIds: ["CONTRACT_ADDRESS"],
    fromTimestamp: Date.now() - 86400000,
  },
  3600000 // 1 hour buckets
);
```

## Data Management

### Delete Old Events

```typescript
// Delete events older than 30 days
const result = await manager.deleteArchivedEvents({
  toTimestamp: Date.now() - 30 * 86400000,
});

if (result.status === "ok") {
  console.log("Deleted:", result.data, "events");
}
```

### Storage Statistics

```typescript
const result = await manager.getStorageStats();

if (result.status === "ok") {
  console.log("Total events:", result.data.totalEvents);
  console.log("Unique contracts:", result.data.uniqueContracts);
  console.log("Oldest event:", new Date(result.data.oldestTimestamp!));
  console.log("Newest event:", new Date(result.data.newestTimestamp!));
}
```

## Architecture

### Event Flow

```
Live Events → Subscription → Batch Buffer → Deduplication → Storage Adapter → Database
                                ↓
                          Error Handler (failures)
```

### Separation of Concerns

- **Live Subscription** - Streams events in real-time
- **Batch Buffer** - Collects events for efficient storage
- **Deduplication** - Prevents duplicate storage
- **Storage Adapter** - Abstracts storage backend
- **Error Isolation** - Storage failures don't affect subscription

### Deduplication Strategy

1. Check event ID against current batch
2. Check event ID in storage via `exists()`
3. Skip if duplicate, store if new

## Best Practices

### 1. Choose Appropriate Storage

- **Development**: In-memory storage
- **Testing**: In-memory or file-based storage
- **Production**: Database or cloud storage

### 2. Batch Size Tuning

```typescript
new EventArchivalManager(storage, {
  batchSize: 50, // Adjust based on event frequency
});
```

- High frequency events: Larger batches (100-200)
- Low frequency events: Smaller batches (10-50)
- Balance between latency and efficiency

### 3. Monitor Storage Health

```typescript
setInterval(async () => {
  const stats = await manager.getStorageStats();
  if (stats.status === "ok") {
    // Alert if storage grows too large
    if (stats.data.totalEvents > 10_000_000) {
      console.warn("High event count, consider archiving");
    }
  }
}, 3600000); // Check hourly
```

### 4. Handle Storage Errors

```typescript
new EventArchivalManager(storage, {
  onStorageError: (error, events) => {
    // Log to monitoring service
    logger.error("Storage failure", {
      error: error.message,
      eventCount: events.length,
      eventIds: events.map((e) => e.id),
    });
    
    // Optionally retry or queue for later
    retryQueue.add(events);
  },
});
```

### 5. Implement Data Retention

```typescript
// Daily cleanup job
setInterval(async () => {
  const thirtyDaysAgo = Date.now() - 30 * 86400000;
  await manager.deleteArchivedEvents({
    toTimestamp: thirtyDaysAgo,
  });
}, 86400000); // Run daily
```

### 6. Optimize Queries

```typescript
// Use specific filters
const result = await manager.queryArchivedEvents({
  contractIds: ["CONTRACT_ADDRESS"], // Indexed
  eventTypes: ["transfer"], // Indexed
  fromTimestamp: recentTime, // Limit time range
  limit: 100, // Reasonable limit
});
```

## Comparison with Live Subscriptions

| Feature | Live Subscription | Event Archival |
|---------|------------------|----------------|
| **Latency** | Real-time | Batch delay (seconds) |
| **History** | Recent only | Full history |
| **Queries** | Limited filtering | Full query support |
| **Persistence** | Transient | Permanent |
| **Analytics** | In-flight only | Historical analysis |
| **Storage** | Memory only | Configurable backend |

## Use Cases

### 1. Analytics Dashboard

```typescript
// Real-time + historical data
const manager = new EventArchivalManager(storage);

// Archive for history
await manager.archiveContractEvents(contractId, undefined, options);

// Query recent trends
const last24h = await manager.getEventAggregation({
  fromTimestamp: Date.now() - 86400000,
}, 3600000); // Hourly buckets
```

### 2. Audit Logging

```typescript
// Archive all events for compliance
const manager = new EventArchivalManager(storage, {
  deduplicate: true,
  onStorageError: (error, events) => {
    // Critical: must not lose audit logs
    backupLogger.log(events);
  },
});
```

### 3. Event Replay

```typescript
// Query historical events for replay
const events = await manager.queryArchivedEvents({
  contractIds: ["CONTRACT_ADDRESS"],
  fromLedger: startLedger,
  toLedger: endLedger,
  orderBy: "ledger",
  order: "asc",
});

// Process events in order
for (const event of events.data.events) {
  await processEvent(event);
}
```

### 4. Performance Monitoring

```typescript
// Track event rates over time
const timeSeries = await manager.getEventAggregation({
  contractIds: ["CONTRACT_ADDRESS"],
}, 300000); // 5 minute buckets

// Detect anomalies
for (const bucket of timeSeries.data.timeSeries!) {
  if (bucket.count > threshold) {
    alert("High event volume detected");
  }
}
```

## Testing

```typescript
import { InMemoryEventArchiveStorage } from "sorokit-core";

describe("Event archival tests", () => {
  let storage: InMemoryEventArchiveStorage;
  
  beforeEach(() => {
    storage = new InMemoryEventArchiveStorage();
  });

  it("archives and queries events", async () => {
    const manager = new EventArchivalManager(storage);
    
    // Test archival logic
    // ...
  });
});
```

## Migration from Live Subscriptions

Existing `subscribeContractEvents` code continues to work. Add archival incrementally:

```typescript
// Existing code (unchanged)
subscribeContractEvents(contractId, filter, callback, options);

// Add archival
const manager = new EventArchivalManager(storage);
await manager.archiveContractEvents(contractId, filter, options);

// Now you have both real-time AND historical access
```

## API Reference

See full type definitions in `src/soroban/eventArchival/types.ts`.

### EventArchivalManager

- `archiveContractEvents(contractId, filter, options)` - Start archiving
- `queryArchivedEvents(query)` - Query archived events
- `getEventAggregation(query, intervalMs)` - Get aggregations
- `deleteArchivedEvents(query)` - Delete events
- `getStorageStats()` - Get storage statistics

### EventArchiveStorage Interface

- `store(events)` - Persist events
- `query(query)` - Query with filters
- `aggregate(query, intervalMs)` - Aggregate data
- `delete(query)` - Delete events
- `exists(eventId)` - Check existence
- `getStats()` - Get statistics

## Support

For issues or questions:
- GitHub Issues: [sorokit-core/issues](https://github.com/Sorokit/core/issues)
- Documentation: [docs/contract-event-archival.md](./contract-event-archival.md)
