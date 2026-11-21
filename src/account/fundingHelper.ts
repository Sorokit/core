import { getAccount } from "./getAccount";
import { isValidStellarPublicKey } from "./keyRotation";
import type { AccountInfo } from "./types";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

/** Public Friendbot endpoints. Friendbot exists on testnet and futurenet only. */
export const FRIENDBOT_URLS: Record<string, string> = {
  testnet: "https://friendbot.stellar.org",
  futurenet: "https://friendbot-futurenet.stellar.org",
};

export interface FundingOptions {
  /** Network name used to pick the default Friendbot URL. Default: "testnet". */
  network?: string;
  /** Custom funding endpoint, required on networks without Friendbot. Called as `?addr=<key>`. */
  friendbotUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * Create and fund an account through Friendbot (or a custom endpoint), then
 * return the resulting account. Friendbot decides the funded amount (10,000 XLM
 * on testnet), so `initialBalance` is checked afterwards and reported as an
 * error if the account holds less than requested.
 */
export async function createAndFundAccount(
  horizonUrl: string,
  publicKey: string,
  initialBalance = "0",
  options: FundingOptions = {},
): Promise<SorokitResult<AccountInfo>> {
  if (!isValidStellarPublicKey(publicKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${publicKey}`);
  }
  const minimum = Number(initialBalance);
  if (!Number.isFinite(minimum) || minimum < 0) {
    return err(SorokitErrorCode.VALIDATION, `Invalid initialBalance: ${initialBalance}`);
  }
  const endpoint = options.friendbotUrl ?? FRIENDBOT_URLS[options.network ?? "testnet"];
  if (!endpoint) {
    return err(SorokitErrorCode.INVALID_CONFIG, `No funding endpoint for network "${options.network}". Pass friendbotUrl.`);
  }
  try {
    const res = await (options.fetchFn ?? fetch)(`${endpoint}?addr=${encodeURIComponent(publicKey)}`);
    if (!res.ok) {
      return err(SorokitErrorCode.NETWORK_ERROR, `Funding endpoint responded ${res.status}.`);
    }
  } catch (cause) {
    return err(SorokitErrorCode.NETWORK_ERROR, "Funding request failed.", cause);
  }
  const account = await getAccount(horizonUrl, publicKey);
  if (account.status === "error") return account;
  const native = account.data.balances.find((b) => b.assetType === "native");
  if (minimum > 0 && Number(native?.balance ?? 0) < minimum) {
    return err(SorokitErrorCode.VALIDATION, `Funded balance ${native?.balance ?? "0"} is below requested ${initialBalance}.`);
  }
  return account;
}
