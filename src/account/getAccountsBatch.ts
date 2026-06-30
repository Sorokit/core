import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { getAccount } from "./getAccount";
import type { AccountInfo } from "./types";

/**
 * Fetch full account details for multiple accounts in parallel from Horizon.
 * Uses Promise.allSettled so a single account failure never blocks the rest.
 * Returns an array of individual results, each carrying its own ok/error status.
 */
export async function getAccountsBatch(
  horizonUrl: string,
  publicKeys: string[],
): Promise<SorokitResult<SorokitResult<AccountInfo>[]>> {
  try {
    const settled = await Promise.allSettled(
      publicKeys.map((publicKey) => getAccount(horizonUrl, publicKey)),
    );

    const results = settled.map((r): SorokitResult<AccountInfo> =>
      r.status === "fulfilled"
        ? r.value
        : err(
            SorokitErrorCode.ACCOUNT_FETCH_FAILED,
            `Failed to fetch account: ${toMessage(r.reason)}`,
            r.reason,
          ),
    );

    return ok(results);
  } catch (cause) {
    return err(
      SorokitErrorCode.UNKNOWN,
      `Failed to execute batch accounts fetch: ${toMessage(cause)}`,
      cause,
    );
  }
}
