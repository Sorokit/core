import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FailoverManager,
  createFailoverManager,
  type EndpointConfig,
  type FailoverConfig,
} from './failover';

// Helper to build a mock Response
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

// Helper to build a network error
function networkError(message = 'Network error'): Error {
  return new Error(message);
}

describe('FailoverManager', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const primaryEndpoint: EndpointConfig = {
    url: 'https://primary.example.com',
    name: 'primary',
  };
  const backupEndpoint: EndpointConfig = {
    url: 'https://backup.example.com',
    name: 'backup',
  };
  const tertiaryEndpoint: EndpointConfig = {
    url: 'https://tertiary.example.com',
    name: 'tertiary',
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('failover scenarios', () => {
    it('fails over to backup when primary endpoint fails', async () => {
      const manager = createFailoverManager({
        endpoints: [primaryEndpoint, backupEndpoint],
        healthCheckIntervalMs: 0,
        failureThreshold: 1,
      });

      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(primaryEndpoint.url)) {
          throw networkError('primary down');
        }
        return mockResponse({ result: 'ok', source: 'backup' });
      });

      const result = await manager.request<{ result: string; source: string }>(
        '/path',
        { method: 'GET' },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.source).toBe('backup');
      }
      // Primary attempted first, then backup
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstUrl = String(fetchMock.mock.calls[0][0]);
      const secondUrl = String(fetchMock.mock.calls[1][0]);
      expect(firstUrl.startsWith(primaryEndpoint.url)).toBe(true);
      expect(secondUrl.startsWith(backupEndpoint.url)).toBe(true);

      manager.destroy();
    });

    it('fails over when primary returns a server error status', async () => {
      const manager = createFailoverManager({
        endpoints: [primaryEndpoint, backupEndpoint],
        healthCheckIntervalMs: 0,
        failureThreshold: 1,
      });

      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(primaryEndpoint.url)) {
          return mockResponse({ error: 'boom' }, 503);
        }
        return mockResponse({ result: 'ok', source: 'backup' });
      });

      const result = await manager.request<{ result: string; source: string }>(
        '/path',
        { method: 'GET' },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.source).toBe('backup');
      }

      manager.destroy();
    });

    it('returns an error SorokitResult when all endpoints fail', async () => {
      const manager = createFailoverManager({
        endpoints: [primaryEndpoint, backupEndpoint, tertiaryEndpoint],
        healthCheckIntervalMs: 0,
        failureThreshold: 1,
      });

      fetchMock.mockImplementation(async () => {
        throw networkError('all down');
      });

      const result = await manager.request('/path', { method: 'GET' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeDefined();
      }
      // All three endpoints attempted
      expect(fetchMock).toHaveBeenCalledTimes(3);

      manager.destroy();
    });

    it('returns an error SorokitResult when all endpoints return error statuses', async () => {
      const manager = createFailoverManager({
        endpoints: [primaryEndpoint, backupEndpoint],
        healthCheckIntervalMs: 0,
        failureThreshold: 1,
      });

      fetchMock.mockImplementation(async () => mockResponse({ error: 'x' }, 500));

      const result = await manager.request('/path', { method: 'GET' });

      expect(result.ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      manager.destroy();
    });
  });

  describe('health checks', () => {
    it('marks an endpoint unhealthy after threshold failures', async () => {
      const manager = createFailoverManager({
        endpoints: [primaryEndpoint, backupEndpoint],
        healthCheckIntervalMs: 0,
        failureThreshold: 2,
      });

      // Simulate two consecutive failures on primary
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(primaryEndpoint.url)) {
          throw networkError('primary down');
        }
        return mockResponse({ ok: true });
      });

      // First request: primary fails once, then backup succeeds
      await manager.request('/path', { method: 'GET' });
      // Second request: primary fails again -> reaches threshold
      await manager.request('/path', { method: 'GET' });

      const health = manager.getHealthStatus();
      const primaryHealth = health.find((h) => h.name === 'primary');
      expect(primaryHealth).toBeDefined();
      expect(primaryHealth?.healthy).toBe(false);
      expect(primaryHealth?.consecutiveFailures).toBeGreaterThanOrEqual(2);

      manager.destroy();
    });

    it('recovers an endpoint after a successful health check', async () => {
      const manager = createFailoverManager({
        endpoints: [primaryEndpoint, backupEndpoint],
        healthCheckIntervalMs: 0,
        failureThreshold: 1,
      });

      // Fail primary once to mark it unhealthy
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(primaryEndpoint.url)) {
          throw networkError('primary down');
        }
        return mockResponse({ ok: true });
      });

      await manager.request('/path', { method: 'GET' });

      let primaryHealth = manager
        .getHealthStatus()
        .find((h) => h.name === 'primary');
      expect(primaryHealth?.healthy).toBe(false);

      // Now primary recovers; run a health check
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(primaryEndpoint.url)) {
          return mockResponse({ ok: true });
        }
        return mockResponse({ ok: true });
      });

      await manager.runHealthChecks();

      primaryHealth = manager
        .getHealthStatus()
        .find((h) => h.name === 'primary');
      expect(primaryHealth?.healthy).toBe(true);
      expect(primaryHealth?.consecutiveFailures).toBe(0);

      manager.destroy();
    });

    it('runs periodic health checks when interval is set', async () => {
      vi.useFakeTimers();
      try {
        const manager = createFailoverManager({
          endpoints: [primaryEndpoint, backupEndpoint],
          healthCheckIntervalMs: 1000,
          failureThreshold: 1,
        });

        fetchMock.mockImplementation(async () => mockResponse({ ok: true }));

        // Advance time to trigger a health check
        await vi.advanceTimersByTimeAsync(1000);

        // Health checks hit each endpoint
        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

        manager.destroy();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('round-robin distribution', () => {
    it('distributes requests across healthy endpoints', async () => {
      const manager = createFailoverManager({
        endpoints: [primaryEndpoint, backupEndpoint, tertiaryEndpoint],
        healthCheckIntervalMs: 0,
        failureThreshold: 1,
        strategy: 'round-robin',
      });

      const hits: Record<string, number> = {
        primary: 0,
        backup: 0,
        tertiary: 0,
      };

      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(primaryEndpoint.url)) hits.primary++;
        else if (url.startsWith(backupEndpoint.url)) hits.backup++;
        else if (url.startsWith(tertiaryEndpoint.url)) hits.tertiary++;
        return mockResponse({ ok: true });
      });

      for (let i = 0; i < 6; i++) {
        const result = await manager.request('/path', { method: 'GET' });
        expect(result.ok).toBe(true);
      }

      // Each endpoint should have been hit twice
      expect(hits.primary).toBe(2);
      expect(hits.backup).toBe(2);
      expect(hits.tertiary).toBe(2);

      manager.destroy();
    });

    it('skips unhealthy endpoints during round-robin', async () => {
      const manager = createFailoverManager({
        endpoints: [primaryEndpoint, backupEndpoint],
        healthCheckIntervalMs: 0,
        failureThreshold: 1,
        strategy: 'round-robin',
      });

      // Mark primary unhealthy by failing it
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(primaryEndpoint.url)) {
          throw networkError('primary down');
        }
        return mockResponse({ ok: true });
      });

      await manager.request('/path', { method: 'GET' });

      // Reset call tracking
      fetchMock.mockClear();

      // Subsequent requests should only hit backup
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith(primaryEndpoint.url)) {
          throw networkError('primary still down');
        }
        return mockResponse({ ok: true });
      });

      for (let i = 0; i < 3; i++) {
        const result = await manager.request('/path', { method: 'GET' });
        expect(result.ok).toBe(true);
      }

      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.every((u) => u.startsWith(backupEndpoint.url))).toBe(true);

      manager.destroy();
    });
  });

  describe('connection pool stats', () => {
    it('reflects active and queued requests', async () => {
      const manager = createFailoverManager({
        endpoints: [primaryEndpoint],
        healthCheckIntervalMs: 0,
        failureThreshold: 1,
        maxConcurrentPerEndpoint: 1,
      });

      let resolveFirst: (() => void) | undefined;
      const firstGate = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      fetchMock.mockImplementation(async () => {
        await firstGate;
        return mockResponse({ ok: true });
      });

      const first = manager.request('/path', { method: 'GET' });
      const second = manager.request('/path', { method: 'GET' });

      // Give microtasks a chance to start the first request
      await Promise.resolve();

      const stats = manager.getPoolStats();
      expect(stats).toBeDefined();
      expect(stats.active).toBeGreaterThanOrEqual(1);
      expect(stats.queued).toBeGreaterThanOrEqual(1);

      // Release the gate
      resolveFirst?.();
      await Promise.all([first, second]);

      const finalStats = manager.getPoolStats();
      expect(finalStats.active).toBe(0);
      expect(finalStats.queued).toBe(0);

      manager.destroy();
    });
  });

  describe('configuration', () => {
    it('throws when no endpoints are provided', () => {
      const config: FailoverConfig = {
        endpoints: [],
        healthCheckIntervalMs: 0,
      };
      expect(() => new FailoverManager(config)).toThrow();
    });
  });
});