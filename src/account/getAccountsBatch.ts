import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { getAccount } from "./getAccount";
import type { AccountInfo } from "./types";

/**
 * Fetch full account details for multiple accounts in parallel from Horizon.
 * Returns an array of individual results. Handles partial failures gracefully.
 */
export async function getAccountsBatch(
  horizonUrl: string,
  publicKeys: string[],
): Promise<SorokitResult<SorokitResult<AccountInfo>[]>> {
  try {
    const promises = publicKeys.map((publicKey) =>
      getAccount(horizonUrl, publicKey),
    );
    const results = await Promise.all(promises);
    return ok(results);
  } catch (cause) {
    return err(
      SorokitErrorCode.UNKNOWN,
      `Failed to execute batch accounts fetch: ${toMessage(cause)}`,
      cause,
    );
  }
}
