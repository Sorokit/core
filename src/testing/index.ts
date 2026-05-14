/**
 * sorokit-core/testing — test utilities for consumers.
 *
 * Import from "@sorokit/core/testing" in your test files.
 * Do NOT import this in production code — it depends on vitest.
 */
export {
  createMockClient,
  createMockWalletAdapter,
  MOCK_PUBLIC_KEY,
  MOCK_NETWORK_CONFIG,
  MOCK_WALLET_STATE,
  MOCK_CONNECTED_WALLET_STATE,
  MOCK_ASSET_BALANCE,
  MOCK_ACCOUNT_INFO,
  MOCK_TX_RESULT,
  MOCK_PREPARED_CALL,
  MOCK_SIMULATE_RESULT,
  MOCK_CONTRACT_CALL_RESULT,
} from "./mockClient";
export type { MockClientConfig } from "./mockClient";
