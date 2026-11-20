/**
 * MSW (Mock Service Worker) request handlers for Stellar Horizon and Soroban RPC.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO ADD A NEW HANDLER
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Import `http` and `HttpResponse` from `msw` (already imported below).
 * 2. Add a handler to the `handlers` array using the appropriate HTTP method:
 *
 *      http.get('https://horizon-testnet.stellar.org/accounts/:accountId', ({ params }) => {
 *        // validate request, then return a mocked response
 *        return HttpResponse.json({ ... });
 *      })
 *
 * 3. Validate the incoming request inside the handler (query params, body,
 *    headers, path params). If validation fails, return an error response with
 *    the appropriate status code so tests surface bad requests early:
 *
 *      return HttpResponse.json({ error: 'bad request' }, { status: 400 });
 *
 * 4. Keep handlers deterministic. Prefer returning fixtures from `./fixtures`
 *    (or inline constants) over random data so tests stay reproducible.
 *
 * 5. If a test needs a one-off override, use `server.use(...)` inside the test
 *    (see `tests/mocks/server.ts`) rather than editing this file.
 *
 * 6. Export any reusable fixtures/constants from this module so tests can
 *    assert against the same values the handlers return.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { http, HttpResponse } from 'msw';

/** Base URL for the Horizon API used in tests. */
export const HORIZON_URL = 'https://horizon-testnet.stellar.org';

/** Base URL for the Soroban RPC endpoint used in tests. */
export const RPC_URL = 'https://soroban-testnet.stellar.org';

/** A valid-looking Stellar account ID used across tests. */
export const TEST_ACCOUNT_ID =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** A valid-looking transaction hash used across tests. */
export const TEST_TX_HASH =
  '3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889';

/** Default mocked Horizon account payload. */
export const mockAccount = {
  id: TEST_ACCOUNT_ID,
  account_id: TEST_ACCOUNT_ID,
  sequence: '123456789012345',
  subentry_count: 0,
  thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
  flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
  balances: [
    {
      balance: '1000.0000000',
      asset_type: 'native',
    },
  ],
  signers: [
    {
      weight: 1,
      key: TEST_ACCOUNT_ID,
      type: 'ed25519_public_key',
    },
  ],
  data: {},
  num_sponsoring: 0,
  num_sponsored: 0,
  paging_token: TEST_ACCOUNT_ID,
};

/** Default mocked Horizon transaction submission response. */
export const mockSubmitTransactionResponse = {
  hash: TEST_TX_HASH,
  ledger: 123456,
  successful: true,
  envelope_xdr: 'AAAAAgAAAAB...',
  result_xdr: 'AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA=',
  result_meta_xdr: 'AAAAAwAAAAAAAAAE...',
};

/** Default mocked Soroban RPC `getHealth` response. */
export const mockRpcHealth = {
  status: 'healthy',
  latestLedger: 123456,
  oldestLedger: 1,
  ledgerRetentionWindow: 123455,
};

/** Default mocked Soroban RPC `getLatestLedger` response. */
export const mockLatestLedger = {
  id: 'a1b2c3d4e5f6',
  protocolVersion: 21,
  sequence: 123456,
};

/** Default mocked Soroban RPC `getAccount` response. */
export const mockRpcAccount = {
  id: TEST_ACCOUNT_ID,
  sequence: '123456789012345',
};

/** Default mocked Soroban RPC `simulateTransaction` response. */
export const mockSimulateTransactionResponse = {
  latestLedger: 123456,
  minResourceFee: '100',
  transactionData: '',
  events: [],
  results: [
    {
      auth: [],
      xdr: 'AAAAAQAAAAAAAAAB...',
    },
  ],
};

/** Default mocked Soroban RPC `sendTransaction` response. */
export const mockSendTransactionResponse = {
  hash: TEST_TX_HASH,
  status: 'PENDING',
  latestLedger: 123456,
  latestLedgerCloseTime: '1700000000',
};

/** Default mocked Soroban RPC `getTransaction` response. */
export const mockGetTransactionResponse = {
  status: 'SUCCESS',
  latestLedger: 123456,
  latestLedgerCloseTime: '1700000000',
  oldestLedger: 1,
  oldestLedgerCloseTime: '1600000000',
  ledger: 123456,
  createdAt: '1700000000',
  applicationOrder: 1,
  feeBump: false,
  envelopeXdr: 'AAAAAgAAAAB...',
  resultXdr: 'AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA=',
  resultMetaXdr: 'AAAAAwAAAAAAAAAE...',
};

/**
 * Extract the JSON-RPC method name from a parsed request body.
 * Returns `undefined` if the body is not a valid JSON-RPC request.
 */
function getRpcMethod(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const method = (body as { method?: unknown }).method;
  return typeof method === 'string' ? method : undefined;
}

/**
 * Build a JSON-RPC error response.
 */
function rpcError(id: unknown, code: number, message: string) {
  return HttpResponse.json(
    {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message },
    },
    { status: 200 },
  );
}

export const handlers = [
  // ───────────────────────────────────────────────────────────────────────────
  // Horizon: account lookups
  // ───────────────────────────────────────────────────────────────────────────
  http.get(`${HORIZON_URL}/accounts/:accountId`, ({ params }) => {
    const { accountId } = params;

    // Request validation: account IDs must be 56-char Stellar public keys.
    if (typeof accountId !== 'string' || !/^G[A-Z2-7]{55}$/.test(accountId)) {
      return HttpResponse.json(
        {
          type: 'https://stellar.org/horizon-errors/bad_request',
          title: 'Bad Request',
          status: 400,
          detail: 'Invalid account ID.',
        },
        { status: 400 },
      );
    }

    // Unknown accounts return 404, mirroring Horizon behavior.
    if (accountId !== TEST_ACCOUNT_ID) {
      return HttpResponse.json(
        {
          type: 'https://stellar.org/horizon-errors/not_found',
          title: 'Resource Missing',
          status: 404,
          detail: 'The resource at the url requested was not found.',
        },
        { status: 404 },
      );
    }

    return HttpResponse.json(mockAccount);
  }),

  // ───────────────────────────────────────────────────────────────────────────
  // Horizon: transaction submission
  // ───────────────────────────────────────────────────────────────────────────
  http.post(`${HORIZON_URL}/transactions`, async ({ request }) => {
    const contentType = request.headers.get('content-type') ?? '';

    // Request validation: Horizon expects form-encoded submissions with `tx`.
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      return HttpResponse.json(
        {
          type: 'https://stellar.org/horizon-errors/bad_request',
          title: 'Bad Request',
          status: 400,
          detail: 'Unsupported content type.',
        },
        { status: 400 },
      );
    }

    const body = await request.text();
    const form = new URLSearchParams(body);
    const tx = form.get('tx');

    if (!tx) {
      return HttpResponse.json(
        {
          type: 'https://stellar.org/horizon-errors/transaction_malformed',
          title: 'Transaction Malformed',
          status: 400,
          detail: 'Missing required field: tx.',
        },
        { status: 400 },
      );
    }

    return HttpResponse.json(mockSubmitTransactionResponse);
  }),

  // ───────────────────────────────────────────────────────────────────────────
  // Soroban RPC: JSON-RPC calls
  // ───────────────────────────────────────────────────────────────────────────
  http.post(RPC_URL, async ({ request }) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return rpcError(null, -32700, 'Parse error');
    }

    const method = getRpcMethod(body);
    const id = (body as { id?: unknown }).id;

    if (!method) {
      return rpcError(id, -32600, 'Invalid Request');
    }

    switch (method) {
      case 'getHealth':
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: mockRpcHealth,
        });

      case 'getLatestLedger':
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: mockLatestLedger,
        });

      case 'getNetwork':
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            passphrase: 'Test SDF Network ; September 2015',
            protocolVersion: 21,
            friendbotUrl: 'https://friendbot.stellar.org',
          },
        });

      case 'getAccount': {
        const params = (body as { params?: { address?: unknown } }).params;
        const address = params?.address;
        if (typeof address !== 'string' || !/^G[A-Z2-7]{55}$/.test(address)) {
          return rpcError(id, -32602, 'Invalid params: address');
        }
        if (address !== TEST_ACCOUNT_ID) {
          return rpcError(id, -32602, 'Account not found');
        }
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: mockRpcAccount,
        });
      }

      case 'simulateTransaction': {
        const params = (body as { params?: { transaction?: unknown } }).params;
        if (typeof params?.transaction !== 'string' || params.transaction.length === 0) {
          return rpcError(id, -32602, 'Invalid params: transaction');
        }
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: mockSimulateTransactionResponse,
        });
      }

      case 'sendTransaction': {
        const params = (body as { params?: { transaction?: unknown } }).params;
        if (typeof params?.transaction !== 'string' || params.transaction.length === 0) {
          return rpcError(id, -32602, 'Invalid params: transaction');
        }
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: mockSendTransactionResponse,
        });
      }

      case 'getTransaction': {
        const params = (body as { params?: { hash?: unknown } }).params;
        if (typeof params?.hash !== 'string' || params.hash.length === 0) {
          return rpcError(id, -32602, 'Invalid params: hash');
        }
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: id ?? null,
          result: mockGetTransactionResponse,
        });
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }),
];
```

File: tests/mocks/server.ts
Current content:


Change type: create
Step: Create tests/mocks/handlers.ts and tests/mocks/server.ts (and any setup file) as described for MSW; this step creates the new mock infrastructure files. Handlers must cover Horizon account lookups, Horizon transaction submission, and Soroban RPC calls with request validation, and server.ts must export setupServer and lifecycle helpers. Document how to add new handlers in a comment block.

```typescript
/**
 * MSW server setup for Node-based test environments (Jest / Vitest).
 *
 * Usage:
 *
 *   import { server } from './tests/mocks/server';
 *
 *   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
 *   afterEach(() => server.resetHandlers());
 *   afterAll(() => server.close());
 *
 * Or, if using the provided setup file (`tests/mocks/setup.ts`), the lifecycle
 * is wired up automatically via the test runner's `setupFilesAfterEnv`.
 *
 * To override a handler for a single test, use `server.use(...)`:
 *
 *   import { http, HttpResponse } from 'msw';
 *   import { server } from './tests/mocks/server';
 *   import { HORIZON_URL } from './tests/mocks/handlers';
 *
 *   server.use(
 *     http.get(`${HORIZON_URL}/accounts/:accountId`, () =>
 *       HttpResponse.json({ error: 'boom' }, { status: 500 }),
 *     ),
 *   );
 *
 * To add a permanent handler, edit `tests/mocks/handlers.ts` (see the
 * documentation block at the top of that file).
 */

import { setupServer } from 'msw/node';
import { handlers } from './handlers';

/**
 * Shared MSW server instance. Re-exported so tests can call `server.use(...)`
 * to override handlers on a per-test basis.
 */
export const server = setupServer(...handlers);

/**
 * Start the MSW server. Call from `beforeAll`.
 */
export function startServer(): void {
  server.listen({ onUnhandledRequest: 'error' });
}

/**
 * Reset any runtime request handlers added via `server.use(...)`.
 * Call from `afterEach`.
 */
export function resetServer(): void {
  server.resetHandlers();
}

/**
 * Stop the MSW server and clean up resources. Call from `afterAll`.
 */
export function stopServer(): void {
  server.close();
}

export { handlers };
export {
  HORIZON_URL,
  RPC_URL,
  TEST_ACCOUNT_ID,
  TEST_TX_HASH,
  mockAccount,
  mockSubmitTransactionResponse,
  mockRpcHealth,
  mockLatestLedger,
  mockRpcAccount,
  mockSimulateTransactionResponse,
  mockSendTransactionResponse,
  mockGetTransactionResponse,
} from './handlers';
```

File: tests/mocks/setup.ts
Current content:


Change type: create
Step: Create tests/mocks/handlers.ts and tests/mocks/server.ts (and any setup file) as described for MSW; this step creates the new mock infrastructure files. Handlers must cover Horizon account lookups, Horizon transaction submission, and Soroban RPC calls with request validation, and server.ts must export setupServer and lifecycle helpers. Document how to add new handlers in a comment block.

```typescript
/**
 * MSW lifecycle setup for test runners.
 *
 * Register this file in your test runner's setup configuration:
 *
 *   // jest.config.js
 *   module.exports = {
 *     setupFilesAfterEnv: ['<rootDir>/tests/mocks/setup.ts'],
 *   };
 *
 *   // vitest.config.ts
 *   export default defineConfig({
 *     test: {
 *       setupFiles: ['./tests/mocks/setup.ts'],
 *     },
 *   });
 *
 * This wires up the MSW server lifecycle so individual test files do not need
 * to call `server.listen` / `server.resetHandlers` / `server.close` themselves.
 */

import { afterAll, afterEach, beforeAll } from '@jest/globals';
import { resetServer, startServer, stopServer } from './server';

beforeAll(() => {
  startServer();
});

afterEach(() => {
  resetServer();
});

afterAll(() => {
  stopServer();
});