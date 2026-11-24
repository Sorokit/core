/**
 * Anonymous, opt-in usage analytics helper.
 *
 * This module provides a lightweight, privacy-preserving analytics facility
 * that can be used to understand how the SDK is used. It is **opt-in** and
 * **disabled by default**. When enabled, only anonymous, non-identifying data
 * is collected:
 *
 *  - Feature usage (feature names only)
 *  - Error patterns (error categories/codes only, never messages or stacks)
 *  - Performance metrics (timing durations in milliseconds)
 *
 * No PII (public keys, addresses, secrets, tokens, user identifiers, free-form
 * strings, etc.) is ever recorded or transmitted. This helper does **not**
 * implement an analytics server or perform any network transmission itself;
 * it only buffers sanitized events in memory and exposes them via a sink
 * callback that callers may provide.
 */

import { SorokitResult, ok, err } from '../core/result';

/**
 * A single sanitized analytics event. All fields are anonymous and contain
 * no PII.
 */
export interface AnalyticsEvent {
  /** Category of the event. */
  readonly type: 'feature' | 'error' | 'performance';
  /** Anonymous feature name, error category, or performance metric name. */
  readonly name: string;
  /** Optional numeric value (e.g. duration in ms). Never free-form text. */
  readonly value?: number;
  /** Timestamp (epoch ms) when the event was recorded. */
  readonly timestamp: number;
}

/**
 * Sink callback invoked with sanitized events. Callers may use this to
 * forward events to their own (opt-in) analytics backend. The helper itself
 * never transmits data.
 */
export type AnalyticsSink = (event: AnalyticsEvent) => void;

/**
 * Configuration for the analytics helper.
 */
export interface AnalyticsConfig {
  /** Whether analytics collection is enabled. Defaults to `false`. */
  enabled?: boolean;
  /**
   * Optional sink invoked with each sanitized event. Only called when
   * analytics is enabled.
   */
  sink?: AnalyticsSink;
  /**
   * Optional maximum number of buffered events retained in memory.
   * Defaults to 100. Oldest events are dropped when the limit is exceeded.
   */
  maxBufferSize?: number;
}

const DEFAULT_MAX_BUFFER_SIZE = 100;

interface AnalyticsState {
  enabled: boolean;
  sink?: AnalyticsSink;
  maxBufferSize: number;
  buffer: AnalyticsEvent[];
}

const state: AnalyticsState = {
  enabled: false,
  sink: undefined,
  maxBufferSize: DEFAULT_MAX_BUFFER_SIZE,
  buffer: [],
};

/**
 * Patterns that indicate potentially sensitive data. Any string matching
 * these patterns is rejected and replaced with a safe placeholder.
 */
const PII_PATTERNS: readonly RegExp[] = [
  // Base58-like public keys / addresses (Solana-style, 32-44 chars)
  /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/,
  // Hex strings (private keys, hashes, tokens) of 16+ chars
  /\b[0-9a-fA-F]{16,}\b/,
  // Email addresses
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  // URLs
  /https?:\/\/\S+/i,
  // Bearer tokens / API keys / secrets
  /\b(bearer|token|secret|apikey|api[_-]?key|password|passwd|pwd)\b/i,
  // IPv4 addresses
  /\b\d{1,3}(\.\d{1,3}){3}\b/,
  // Long alphanumeric strings that look like keys/tokens
  /\b[A-Za-z0-9_-]{40,}\b/,
];

/**
 * Placeholder used when a value is rejected due to suspected PII.
 */
const REDACTED = '[redacted]';

/**
 * Determines whether a string appears to contain PII or other sensitive data.
 */
function containsPii(value: string): boolean {
  return PII_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Sanitizes a name string. Only short, simple identifiers are allowed.
 * Anything that looks like PII, is too long, or contains unexpected
 * characters is redacted.
 */
function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') {
    return REDACTED;
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    return REDACTED;
  }
  // Only allow simple identifier-like characters (letters, digits, . _ - :).
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    return REDACTED;
  }
  if (containsPii(trimmed)) {
    return REDACTED;
  }
  return trimmed;
}

/**
 * Sanitizes a numeric value. Non-finite or non-numeric values are dropped.
 */
function sanitizeValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

/**
 * Configures the analytics helper. Analytics is disabled by default; call
 * this with `{ enabled: true }` to opt in.
 *
 * @returns `SorokitResult<void>` indicating success or failure.
 */
export function configureAnalytics(config: AnalyticsConfig = {}): SorokitResult<void> {
  try {
    if (config.enabled !== undefined) {
      state.enabled = Boolean(config.enabled);
    }
    if (config.sink !== undefined) {
      if (typeof config.sink !== 'function') {
        return err(new Error('Analytics sink must be a function'));
      }
      state.sink = config.sink;
    }
    if (config.maxBufferSize !== undefined) {
      if (
        typeof config.maxBufferSize !== 'number' ||
        !Number.isFinite(config.maxBufferSize) ||
        config.maxBufferSize < 0
      ) {
        return err(new Error('maxBufferSize must be a non-negative number'));
      }
      state.maxBufferSize = Math.floor(config.maxBufferSize);
    }
    // When disabled, clear any buffered data.
    if (!state.enabled) {
      state.buffer = [];
    }
    return ok(undefined);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Returns whether analytics collection is currently enabled.
 */
export function isAnalyticsEnabled(): boolean {
  return state.enabled;
}

/**
 * Returns a copy of the currently buffered sanitized events.
 */
export function getBufferedAnalyticsEvents(): AnalyticsEvent[] {
  return state.buffer.slice();
}

/**
 * Clears the in-memory event buffer.
 */
export function clearAnalyticsBuffer(): void {
  state.buffer = [];
}

/**
 * Records a sanitized event internally. No-op when analytics is disabled.
 */
function recordEvent(event: AnalyticsEvent): void {
  if (!state.enabled) {
    return;
  }
  if (state.maxBufferSize > 0) {
    state.buffer.push(event);
    while (state.buffer.length > state.maxBufferSize) {
      state.buffer.shift();
    }
  }
  if (state.sink) {
    try {
      state.sink(event);
    } catch {
      // Sink errors must never propagate to callers.
    }
  }
}

/**
 * Tracks a feature usage event. Only the (sanitized) feature name is
 * recorded. No PII is captured.
 *
 * @param featureName Anonymous feature identifier (e.g. `"transfer"`).
 * @returns `SorokitResult<void>`.
 */
export async function trackFeatureUsage(featureName: string): Promise<SorokitResult<void>> {
  try {
    if (!state.enabled) {
      return ok(undefined);
    }
    const name = sanitizeName(featureName);
    recordEvent({
      type: 'feature',
      name,
      timestamp: Date.now(),
    });
    return ok(undefined);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Tracks an error pattern. Only a sanitized error category is recorded;
 * error messages, stacks, and any other potentially identifying details are
 * discarded.
 *
 * @param errorCategory Anonymous error category (e.g. `"network"`).
 * @returns `SorokitResult<void>`.
 */
export async function trackErrorPattern(errorCategory: string): Promise<SorokitResult<void>> {
  try {
    if (!state.enabled) {
      return ok(undefined);
    }
    const name = sanitizeName(errorCategory);
    recordEvent({
      type: 'error',
      name,
      timestamp: Date.now(),
    });
    return ok(undefined);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Tracks a performance metric. Only a sanitized metric name and a numeric
 * duration (in milliseconds) are recorded.
 *
 * @param metricName Anonymous metric identifier (e.g. `"rpc_latency"`).
 * @param durationMs Duration in milliseconds.
 * @returns `SorokitResult<void>`.
 */
export async function trackPerformance(
  metricName: string,
  durationMs: number,
): Promise<SorokitResult<void>> {
  try {
    if (!state.enabled) {
      return ok(undefined);
    }
    const name = sanitizeName(metricName);
    const value = sanitizeValue(durationMs);
    if (value === undefined) {
      return err(new Error('durationMs must be a finite number'));
    }
    recordEvent({
      type: 'performance',
      name,
      value,
      timestamp: Date.now(),
    });
    return ok(undefined);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Exposed for testing: sanitizes a name string using the same rules applied
 * to tracked events.
 */
export const __testing = {
  sanitizeName,
  sanitizeValue,
  containsPii,
};
```

Now the test file at `src/infrastructure/analyticsHelper.test.ts`:

```typescript
import {
  configureAnalytics,
  isAnalyticsEnabled,
  trackFeatureUsage,
  trackErrorPattern,
  trackPerformance,
  getBufferedAnalyticsEvents,
  clearAnalyticsBuffer,
  __testing,
} from './analyticsHelper';

describe('analyticsHelper', () => {
  beforeEach(() => {
    configureAnalytics({ enabled: false, sink: undefined, maxBufferSize: 100 });
    clearAnalyticsBuffer();
  });

  describe('opt-in / opt-out', () => {
    it('is disabled by default', () => {
      configureAnalytics({});
      expect(isAnalyticsEnabled()).toBe(false);
    });

    it('does not record events when disabled', async () => {
      configureAnalytics({ enabled: false });
      const result = await trackFeatureUsage('transfer');
      expect(result.ok).toBe(true);
      expect(getBufferedAnalyticsEvents()).toHaveLength(0);
    });

    it('records events when enabled', async () => {
      configureAnalytics({ enabled: true });
      const result = await trackFeatureUsage('transfer');
      expect(result.ok).toBe(true);
      const events = getBufferedAnalyticsEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('feature');
      expect(events[0].name).toBe('transfer');
    });

    it('clears buffer when disabled', async () => {
      configureAnalytics({ enabled: true });
      await trackFeatureUsage('transfer');
      expect(getBufferedAnalyticsEvents()).toHaveLength(1);
      configureAnalytics({ enabled: false });
      expect(getBufferedAnalyticsEvents()).toHaveLength(0);
    });
  });

  describe('PII exclusion', () => {
    it('redacts base58 public keys', async () => {
      configureAnalytics({ enabled: true });
      await trackFeatureUsage('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
      const events = getBufferedAnalyticsEvents();
      expect(events[0].name).toBe('[redacted]');
    });

    it('redacts hex secrets', async () => {
      configureAnalytics({ enabled: true });
      await trackFeatureUsage('deadbeefdeadbeefdeadbeef');
      expect(getBufferedAnalyticsEvents()[0].name).toBe('[redacted]');
    });

    it('redacts email addresses', async () => {
      configureAnalytics({ enabled: true });
      await trackErrorPattern('user@example.com');
      expect(getBufferedAnalyticsEvents()[0].name).toBe('[redacted]');
    });

    it('redacts URLs', async () => {
      configureAnalytics({ enabled: true });
      await trackErrorPattern('https://example.com/secret');
      expect(getBufferedAnalyticsEvents()[0].name).toBe('[redacted]');
    });

    it('redacts token-like strings', async () => {
      configureAnalytics({ enabled: true });
      await trackErrorPattern('bearer');
      expect(getBufferedAnalyticsEvents()[0].name).toBe('[redacted]');
    });

    it('redacts names with unexpected characters', async () => {
      configureAnalytics({ enabled: true });
      await trackFeatureUsage('transfer with spaces');
      expect(getBufferedAnalyticsEvents()[0].name).toBe('[redacted]');
    });

    it('keeps safe identifiers', () => {
      expect(__testing.sanitizeName('transfer')).toBe('transfer');
      expect(__testing.sanitizeName('rpc_latency')).toBe('rpc_latency');
      expect(__testing.sanitizeName('error.network')).toBe('error.network');
    });
  });

  describe('performance tracking', () => {
    it('records numeric durations', async () => {
      configureAnalytics({ enabled: true });
      const result = await trackPerformance('rpc_latency', 42);
      expect(result.ok).toBe(true);
      const events = getBufferedAnalyticsEvents();
      expect(events[0].type).toBe('performance');
      expect(events[0].name).toBe('rpc_latency');
      expect(events[0].value).toBe(42);
    });

    it('rejects non-finite durations', async () => {
      configureAnalytics({ enabled: true });
      const result = await trackPerformance('rpc_latency', Number.NaN);
      expect(result.ok).toBe(false);
      expect(getBufferedAnalyticsEvents()).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('returns err for invalid sink', () => {
      // @ts-expect-error testing invalid input
      const result = configureAnalytics({ sink: 'not-a-function' });
      expect(result.ok).toBe(false);
    });

    it('returns err for invalid maxBufferSize', () => {
      const result = configureAnalytics({ maxBufferSize: -1 });
      expect(result.ok).toBe(false);
    });

    it('does not propagate sink errors', async () => {
      configureAnalytics({
        enabled: true,
        sink: () => {
          throw new Error('sink failure');
        },
      });
      const result = await trackFeatureUsage('transfer');
      expect(result.ok).toBe(true);
    });
  });

  describe('buffer limits', () => {
    it('respects maxBufferSize', async () => {
      configureAnalytics({ enabled: true, maxBufferSize: 2 });
      await trackFeatureUsage('a');
      await trackFeatureUsage('b');
      await trackFeatureUsage('c');
      const events = getBufferedAnalyticsEvents();
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.name)).toEqual(['b', 'c']);
    });
  });
});
```

Now update `src/infrastructure/index.ts` to export the helper. Since I don't have the current content, I'll provide the additions to append:

```typescript
// Analytics helper (opt-in, anonymous)
export {
  configureAnalytics,
  isAnalyticsEnabled,
  trackFeatureUsage,
  trackErrorPattern,
  trackPerformance,
  getBufferedAnalyticsEvents,
  clearAnalyticsBuffer,
} from './analyticsHelper';
export type {
  AnalyticsEvent,
  AnalyticsSink,
  AnalyticsConfig,
} from './analyticsHelper';
```

And in `src/index.ts`, add:

```typescript
export {
  configureAnalytics,
  isAnalyticsEnabled,
  trackFeatureUsage,
  trackErrorPattern,
  trackPerformance,
  getBufferedAnalyticsEvents,
  clearAnalyticsBuffer,
} from './infrastructure/analyticsHelper';
export type {
  AnalyticsEvent,
  AnalyticsSink,
  AnalyticsConfig,
} from './infrastructure/analyticsHelper';
```

And in `README.md`, add a section:

```markdown
## Anonymous Usage Analytics (Opt-in)

The SDK includes an optional, **opt-in** analytics helper that can help guide
development by understanding anonymous usage patterns. It is **disabled by
default** and never transmits data on its own.

### What is collected

When enabled, only anonymous, non-identifying data is recorded:

- **Feature usage** — feature names only (e.g. `"transfer"`)
- **Error patterns** — error categories only (e.g. `"network"`); error
  messages and stack traces are never recorded
- **Performance** — metric names and numeric durations in milliseconds

### What is NOT collected

- Public keys, addresses, or wallet identifiers
- Private keys, secrets, tokens, or API keys
- Email addresses, URLs, or IP addresses
- Any free-form text, messages, or stack traces
- Any personally identifiable information (PII)

All recorded values are sanitized; anything that resembles sensitive data is
redacted before being stored.

### Enabling analytics

```typescript
import { configureAnalytics } from 'sorokit';

configureAnalytics({
  enabled: true,
  // Optional: forward sanitized events to your own backend.
  sink: (event) => {
    // event contains only anonymous data
  },
});
```

To disable, call `configureAnalytics({ enabled: false })`. Disabling also
clears any buffered events.

The helper does not implement or contact any analytics server; forwarding
events is entirely up to the integrator via the optional `sink`.