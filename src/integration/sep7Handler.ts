/**
 * SEP-7 URI Scheme Handler (#602)
 *
 * Implements parsing, validation, generation, and transaction building for
 * Stellar SEP-0007 URI schemes (web+stellar:pay, web+stellar:tx, web+stellar:change_trust, etc.).
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */

import {
  Asset,
  Memo,
  MemoType,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  FeeBumpTransaction,
  Account,
  BASE_FEE,
  Networks,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isValidPublicKey } from "../shared/utils";

// ─── Types & Interfaces ────────────────────────────────────────────────────────

export type Sep7OperationType =
  | "pay"
  | "tx"
  | "change_trust"
  | "manage_offer"
  | "path_payment_strict_receive"
  | "path_payment_strict_send";

export interface Sep7BaseParams {
  operation: Sep7OperationType;
  msg?: string | undefined;
  network_passphrase?: string | undefined;
  origin_domain?: string | undefined;
  signature?: string | undefined;
  callback?: string | undefined;
}

export interface Sep7PayParams extends Sep7BaseParams {
  operation: "pay";
  destination: string;
  amount?: string | undefined;
  asset_code?: string | undefined;
  asset_issuer?: string | undefined;
  memo?: string | undefined;
  memo_type?: "text" | "id" | "hash" | "return" | "MEMO_TEXT" | "MEMO_ID" | "MEMO_HASH" | "MEMO_RETURN" | undefined;
}

export interface Sep7TxParams extends Sep7BaseParams {
  operation: "tx";
  xdr: string;
  pubkey?: string | undefined;
}

export interface Sep7ChangeTrustParams extends Sep7BaseParams {
  operation: "change_trust";
  asset_code: string;
  asset_issuer: string;
  limit?: string | undefined;
}

export interface Sep7ManageOfferParams extends Sep7BaseParams {
  operation: "manage_offer";
  selling_asset_code?: string | undefined;
  selling_asset_issuer?: string | undefined;
  buying_asset_code?: string | undefined;
  buying_asset_issuer?: string | undefined;
  amount: string;
  price: string;
  offer_id?: string | undefined;
}

export interface Sep7PathPaymentReceiveParams extends Sep7BaseParams {
  operation: "path_payment_strict_receive";
  destination: string;
  send_asset_code?: string | undefined;
  send_asset_issuer?: string | undefined;
  send_amount?: string | undefined;
  send_max?: string | undefined;
  dest_asset_code?: string | undefined;
  dest_asset_issuer?: string | undefined;
  dest_amount?: string | undefined;
  dest_min?: string | undefined;
  path?: Array<{ code?: string | undefined; issuer?: string | undefined }> | undefined;
}

export interface Sep7PathPaymentSendParams extends Sep7BaseParams {
  operation: "path_payment_strict_send";
  destination: string;
  send_asset_code?: string | undefined;
  send_asset_issuer?: string | undefined;
  send_amount?: string | undefined;
  send_max?: string | undefined;
  dest_asset_code?: string | undefined;
  dest_asset_issuer?: string | undefined;
  dest_amount?: string | undefined;
  dest_min?: string | undefined;
  path?: Array<{ code?: string | undefined; issuer?: string | undefined }> | undefined;
}

export type Sep7PathPaymentParams = Sep7PathPaymentReceiveParams | Sep7PathPaymentSendParams;

export type Sep7Params =
  | Sep7PayParams
  | Sep7TxParams
  | Sep7ChangeTrustParams
  | Sep7ManageOfferParams
  | Sep7PathPaymentReceiveParams
  | Sep7PathPaymentSendParams;

export interface Sep7ValidationResult {
  valid: boolean;
  operation: Sep7OperationType;
  errors: string[];
  warnings: string[];
  params?: Sep7Params | undefined;
}

/** Options for generating a wallet signing deeplink for a transaction. */
export interface Sep7SigningRedirectOptions {
  /** URL that the wallet POSTs the signed XDR to, prefixed with `url:`. */
  callback?: string;
  /** Public key the wallet should sign with. */
  pubkey?: string;
  /** Message shown to the user by the wallet. */
  msg?: string;
  /** Fully qualified domain that originated the request. */
  originDomain?: string;
  /** Network passphrase, defaults to the Stellar testnet. */
  networkPassphrase?: string;
}

/** A validated SEP-7 wallet redirect and its optional callback target. */
export interface Sep7SigningRedirect {
  /** `web+stellar:tx` URI that opens the user's wallet. */
  uri: string;
  /** Validated URL the wallet should POST the signed XDR to, or null. */
  callbackUrl: string | null;
}

/**
 * Build a SEP-7 signing deeplink from an already assembled transaction.
 *
 * The transaction is serialized with `toXDR()` and verified as canonical
 * base64 before it is embedded in the URI. Callbacks must be absolute HTTPS
 * URLs with the required `url:` prefix.
 */
export function createSep7SigningRedirect(
  transaction: Transaction | FeeBumpTransaction,
  options: Sep7SigningRedirectOptions = {},
): SorokitResult<Sep7SigningRedirect> {
  const xdrResult = encodeSep7TransactionXdr(transaction);
  if (xdrResult.status === "error") return xdrResult;

  let callbackUrl: string | null = null;
  if (options.callback !== undefined) {
    const callbackResult = validateSep7CallbackUrl(options.callback);
    if (callbackResult.status === "error") return callbackResult;
    callbackUrl = callbackResult.data;
  }

  if (options.pubkey !== undefined && !isValidPublicKey(options.pubkey)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid SEP-7 pubkey: '${options.pubkey}'`,
    );
  }

  let originDomain: string | undefined;
  if (options.originDomain !== undefined) {
    const value = options.originDomain.trim();
    try {
      const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
      if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        return err(
          SorokitErrorCode.VALIDATION,
          `Invalid SEP-7 origin_domain: '${options.originDomain}'`,
        );
      }
      originDomain = parsed.hostname;
    } catch {
      return err(
        SorokitErrorCode.VALIDATION,
        `Invalid SEP-7 origin_domain: '${options.originDomain}'`,
      );
    }
  }

  const params: Sep7TxParams = {
    operation: "tx",
    xdr: xdrResult.data,
    ...(options.callback !== undefined && { callback: options.callback }),
    ...(options.pubkey !== undefined && { pubkey: options.pubkey }),
    ...(options.msg !== undefined && { msg: options.msg }),
    ...(originDomain !== undefined && { origin_domain: originDomain }),
    ...(options.networkPassphrase !== undefined && {
      network_passphrase: options.networkPassphrase,
    }),
  };
  const uriResult = generateSep7Uri(params);
  if (uriResult.status === "error") return uriResult;
  return ok({ uri: uriResult.data, callbackUrl });
}

/** Alias for {@link createSep7SigningRedirect}. */
export const buildSep7SigningRedirect = createSep7SigningRedirect;

/**
 * Validate a SEP-7 `callback` value before it is embedded in a URI or used as
 * a redirect target. Only absolute HTTP(S) URLs with the required `url:` prefix
 * are accepted, so a wallet can never be redirected to a script or a relative
 * path.
 */
export function validateSep7CallbackUrl(callback: string): SorokitResult<string> {
  if (typeof callback !== "string" || !callback.startsWith("url:")) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Callback parameter must start with 'url:' prefix",
    );
  }
  const rawValue = callback.slice(4);
  let raw: string;
  try {
    raw = decodeURIComponent(rawValue);
  } catch {
    return err(SorokitErrorCode.VALIDATION, `Invalid callback URL: '${rawValue}'`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err(SorokitErrorCode.VALIDATION, `Invalid callback URL: '${raw}'`);
  }
  if (url.protocol !== "https:") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Callback URL must use secure HTTPS protocol",
    );
  }
  if (!url.hostname || url.username || url.password) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Callback URL must have a hostname and no embedded credentials",
    );
  }
  return ok(url.toString());
}

const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Check that a string is canonical, padded base64 before decoding it as XDR. */
export function isValidSep7XdrBase64(xdrValue: string): boolean {
  if (typeof xdrValue !== "string" || !CANONICAL_BASE64_PATTERN.test(xdrValue)) {
    return false;
  }
  const bytes = Buffer.from(xdrValue, "base64");
  return bytes.length > 0 && bytes.toString("base64") === xdrValue;
}

/** Encode a transaction as the canonical base64 XDR value required by SEP-7. */
export function encodeSep7TransactionXdr(
  transaction: Transaction | FeeBumpTransaction,
): SorokitResult<string> {
  try {
    const xdr = transaction.toXDR();
    if (!isValidSep7XdrBase64(xdr)) {
      return err(SorokitErrorCode.VALIDATION, "Transaction XDR is not canonical base64.");
    }
    return ok(xdr);
  } catch (cause) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Failed to encode transaction XDR for SEP-7.",
      cause,
    );
  }
}

export interface Sep7BuildOptions {
  /**
   * Source account public key used to build the transaction (if not provided in URI or XDR).
   */
  sourceAccount?: string | undefined;

  /**
   * Account sequence number (defaults to "0" for unsubmitted transaction template).
   */
  sequenceNumber?: string | undefined;

  /**
   * Network passphrase (defaults to Testnet if not provided in URI).
   */
  networkPassphrase?: string | undefined;

  /**
   * Base fee in stroops (default 100).
   */
  baseFee?: string | undefined;

  /**
   * Timebounds timeout in seconds (default 300).
   */
  timeoutSeconds?: number | undefined;
}

// ─── URI Parser ────────────────────────────────────────────────────────────────

/**
 * Parses a SEP-7 URI string into structured parameter objects.
 */
export function parseSep7Uri(uri: string): SorokitResult<Sep7Params> {
  if (!uri || typeof uri !== "string") {
    return err(
      SorokitErrorCode.VALIDATION,
      "Invalid URI: input must be a non-empty string",
    );
  }

  const trimmed = uri.trim();
  const prefixMatch = trimmed.match(/^(?:web\+stellar:|stellar:)(\/\/)?([^?]+)\??(.*)$/i);
  if (!prefixMatch) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Invalid SEP-7 URI scheme: URI must start with 'web+stellar:' or 'stellar:'",
    );
  }

  const rawOperation = (prefixMatch[2] ?? "").toLowerCase();
  const queryString = prefixMatch[3] || "";
  const queryParams = new URLSearchParams(queryString);

  const getParam = (key: string): string | undefined => {
    const val = queryParams.get(key);
    return val !== null ? decodeURIComponent(val) : undefined;
  };

  const base: Sep7BaseParams = {
    operation: rawOperation as Sep7OperationType,
    msg: getParam("msg"),
    network_passphrase: getParam("network_passphrase"),
    origin_domain: getParam("origin_domain"),
    signature: getParam("signature"),
    callback: getParam("callback"),
  };

  switch (rawOperation) {
    case "pay": {
      const destination = getParam("destination");
      if (!destination) {
        return err(
          SorokitErrorCode.VALIDATION,
          "Missing required SEP-7 pay parameter: 'destination'",
        );
      }
      const payParams: Sep7PayParams = {
        ...base,
        operation: "pay",
        destination,
        amount: getParam("amount"),
        asset_code: getParam("asset_code"),
        asset_issuer: getParam("asset_issuer"),
        memo: getParam("memo"),
        memo_type: getParam("memo_type") as Sep7PayParams["memo_type"],
      };
      return ok(payParams);
    }

    case "tx": {
      const xdr = getParam("xdr");
      if (!xdr) {
        return err(
          SorokitErrorCode.VALIDATION,
          "Missing required SEP-7 tx parameter: 'xdr'",
        );
      }
      if (!isValidSep7XdrBase64(xdr)) {
        return err(
          SorokitErrorCode.VALIDATION,
          "Invalid SEP-7 tx parameter: 'xdr' must be canonical base64",
        );
      }
      const txParams: Sep7TxParams = {
        ...base,
        operation: "tx",
        xdr,
        pubkey: getParam("pubkey"),
      };
      return ok(txParams);
    }

    case "change_trust":
    case "add_trustline":
    case "add-trustline": {
      const asset_code = getParam("asset_code");
      const asset_issuer = getParam("asset_issuer");
      if (!asset_code || !asset_issuer) {
        return err(
          SorokitErrorCode.VALIDATION,
          "Missing required change_trust parameters: 'asset_code' and 'asset_issuer'",
        );
      }
      const trustParams: Sep7ChangeTrustParams = {
        ...base,
        operation: "change_trust",
        asset_code,
        asset_issuer,
        limit: getParam("limit"),
      };
      return ok(trustParams);
    }

    case "manage_offer":
    case "manage-offer": {
      const amount = getParam("amount");
      const price = getParam("price");
      if (!amount || !price) {
        return err(
          SorokitErrorCode.VALIDATION,
          "Missing required manage_offer parameters: 'amount' and 'price'",
        );
      }
      const offerParams: Sep7ManageOfferParams = {
        ...base,
        operation: "manage_offer",
        selling_asset_code: getParam("selling_asset_code"),
        selling_asset_issuer: getParam("selling_asset_issuer"),
        buying_asset_code: getParam("buying_asset_code"),
        buying_asset_issuer: getParam("buying_asset_issuer"),
        amount,
        price,
        offer_id: getParam("offer_id"),
      };
      return ok(offerParams);
    }

    case "path_payment_strict_receive":
    case "path_payment_strict_send":
    case "path_payment":
    case "path-payment": {
      const destination = getParam("destination");
      if (!destination) {
        return err(
          SorokitErrorCode.VALIDATION,
          "Missing required path payment parameter: 'destination'",
        );
      }
      const opType =
        rawOperation === "path_payment_strict_send"
          ? "path_payment_strict_send"
          : "path_payment_strict_receive";

      const pathParam = getParam("path");
      let parsedPath: Array<{ code?: string | undefined; issuer?: string | undefined }> | undefined;
      if (pathParam) {
        parsedPath = pathParam.split(",").map((p) => {
          const parts = p.split(":");
          if (parts.length === 2) {
            return {
              ...(parts[0] ? { code: parts[0] } : {}),
              ...(parts[1] ? { issuer: parts[1] } : {}),
            };
          }
          return { code: "XLM" };
        });
      }

      const pathPaymentParams: Sep7PathPaymentParams = {
        ...base,
        operation: opType,
        destination,
        send_asset_code: getParam("send_asset_code"),
        send_asset_issuer: getParam("send_asset_issuer"),
        send_amount: getParam("send_amount"),
        send_max: getParam("send_max"),
        dest_asset_code: getParam("dest_asset_code"),
        dest_asset_issuer: getParam("dest_asset_issuer"),
        dest_amount: getParam("dest_amount"),
        dest_min: getParam("dest_min"),
        path: parsedPath,
      };
      return ok(pathPaymentParams);
    }

    default:
      return err(
        SorokitErrorCode.VALIDATION,
        `Unsupported SEP-7 operation type: '${rawOperation}'`,
      );
  }
}

// ─── URI Validator ─────────────────────────────────────────────────────────────

/**
 * Validates a SEP-7 URI string and returns detailed diagnostic messages.
 */
export function validateSep7Uri(uri: string): SorokitResult<Sep7ValidationResult> {
  const parseResult = parseSep7Uri(uri);
  if (parseResult.status !== "ok") {
    return ok({
      valid: false,
      operation: "pay",
      errors: [parseResult.error.message],
      warnings: [],
    });
  }

  const params = parseResult.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate callback protocol if present
  if (params.callback !== undefined) {
    const callbackResult = validateSep7CallbackUrl(params.callback);
    if (callbackResult.status === "error") {
      errors.push(callbackResult.error.message);
    }
  }

  // Operation-specific validations
  switch (params.operation) {
    case "pay": {
      if (!isValidPublicKey(params.destination) && !StrKey.isValidMed25519PublicKey(params.destination)) {
        errors.push(`Invalid destination Stellar address: '${params.destination}'`);
      }
      if (params.amount !== undefined) {
        const amt = parseFloat(params.amount);
        if (isNaN(amt) || amt <= 0) {
          errors.push(`Invalid amount: '${params.amount}' must be a positive number`);
        }
      }
      if (params.asset_code) {
        if (!/^[a-zA-Z0-9]{1,12}$/.test(params.asset_code)) {
          errors.push(`Invalid asset_code: '${params.asset_code}' must be 1-12 alphanumeric characters`);
        }
        if (!params.asset_issuer) {
          errors.push("Non-native asset requires 'asset_issuer' parameter");
        } else if (!isValidPublicKey(params.asset_issuer)) {
          errors.push(`Invalid asset_issuer address: '${params.asset_issuer}'`);
        }
      } else if (params.asset_issuer) {
        errors.push("Asset issuer specified without 'asset_code'");
      }

      if (params.memo && params.memo_type) {
        const mType = params.memo_type.toUpperCase();
        if (mType === "ID" || mType === "MEMO_ID") {
          if (!/^\d+$/.test(params.memo)) {
            errors.push(`Memo ID must be a positive 64-bit integer, got: '${params.memo}'`);
          }
        } else if (mType === "HASH" || mType === "MEMO_HASH" || mType === "RETURN" || mType === "MEMO_RETURN") {
          if (!/^[0-9a-fA-F]{64}$/.test(params.memo) && Buffer.from(params.memo, "base64").length !== 32) {
            errors.push(`Memo ${mType} must be a 32-byte hex or base64 string`);
          }
        }
      }
      break;
    }

    case "tx": {
      if (!isValidSep7XdrBase64(params.xdr)) {
        errors.push("Invalid XDR: 'xdr' must be canonical base64");
      } else {
        try {
          TransactionBuilder.fromXDR(
            params.xdr,
            params.network_passphrase ?? Networks.TESTNET,
          );
        } catch {
          errors.push("Invalid XDR: payload is not a decodable Stellar transaction");
        }
      }
      if (params.pubkey && !isValidPublicKey(params.pubkey)) {
        errors.push(`Invalid replacement pubkey: '${params.pubkey}'`);
      }
      break;
    }

    case "change_trust": {
      if (!/^[a-zA-Z0-9]{1,12}$/.test(params.asset_code)) {
        errors.push(`Invalid asset_code: '${params.asset_code}'`);
      }
      if (!isValidPublicKey(params.asset_issuer)) {
        errors.push(`Invalid asset_issuer: '${params.asset_issuer}'`);
      }
      if (params.limit !== undefined) {
        const lim = parseFloat(params.limit);
        if (isNaN(lim) || lim < 0) {
          errors.push(`Invalid trustline limit: '${params.limit}'`);
        }
      }
      break;
    }

    case "manage_offer": {
      const amt = parseFloat(params.amount);
      const prc = parseFloat(params.price);
      if (isNaN(amt) || amt < 0) {
        errors.push(`Invalid amount: '${params.amount}'`);
      }
      if (isNaN(prc) || prc <= 0) {
        errors.push(`Invalid price: '${params.price}' must be positive`);
      }
      break;
    }

    case "path_payment_strict_receive":
    case "path_payment_strict_send": {
      if (!isValidPublicKey(params.destination)) {
        errors.push(`Invalid destination address: '${params.destination}'`);
      }
      break;
    }
  }

  return ok({
    valid: errors.length === 0,
    operation: params.operation,
    errors,
    warnings,
    params,
  });
}

// ─── Transaction Builder ───────────────────────────────────────────────────────

/**
 * Builds a prepared Stellar Transaction from a SEP-7 URI.
 */
export async function buildFromSep7Uri(
  uri: string,
  options: Sep7BuildOptions = {},
): Promise<SorokitResult<Transaction | FeeBumpTransaction>> {
  const parseResult = parseSep7Uri(uri);
  if (parseResult.status !== "ok") {
    return err(parseResult.error.code, parseResult.error.message);
  }

  const params = parseResult.data;
  const networkPassphrase =
    params.network_passphrase ?? options.networkPassphrase ?? Networks.TESTNET;

  if (params.callback !== undefined) {
    const callbackResult = validateSep7CallbackUrl(params.callback);
    if (callbackResult.status === "error") return callbackResult;
  }

  if (params.operation === "tx") {
    if (!isValidSep7XdrBase64(params.xdr)) {
      return err(
        SorokitErrorCode.VALIDATION,
        "Invalid SEP-7 XDR: 'xdr' must be canonical base64",
      );
    }
    try {
      const tx = TransactionBuilder.fromXDR(params.xdr, networkPassphrase);
      return ok(tx);
    } catch (e) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to decode XDR from SEP-7 tx URI: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const sourceAccountPk = options.sourceAccount;
  if (!sourceAccountPk) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Missing sourceAccount option required to construct transaction for non-tx SEP-7 URI",
    );
  }

  if (!isValidPublicKey(sourceAccountPk)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Invalid sourceAccount public key: '${sourceAccountPk}'`,
    );
  }

  const account = new Account(sourceAccountPk, options.sequenceNumber ?? "0");
  const builder = new TransactionBuilder(account, {
    fee: options.baseFee ?? BASE_FEE,
    networkPassphrase,
  });

  const timeout = options.timeoutSeconds ?? 300;
  builder.setTimeout(timeout);

  switch (params.operation) {
    case "pay": {
      const asset =
        params.asset_code && params.asset_issuer
          ? new Asset(params.asset_code, params.asset_issuer)
          : Asset.native();

      const amount = params.amount ?? "0";
      builder.addOperation(
        Operation.payment({
          destination: params.destination,
          asset,
          amount,
        }),
      );

      if (params.memo) {
        const mType = (params.memo_type ?? "text").toUpperCase();
        if (mType === "ID" || mType === "MEMO_ID") {
          builder.addMemo(Memo.id(params.memo));
        } else if (mType === "HASH" || mType === "MEMO_HASH") {
          builder.addMemo(Memo.hash(params.memo));
        } else if (mType === "RETURN" || mType === "MEMO_RETURN") {
          builder.addMemo(Memo.return(params.memo));
        } else {
          builder.addMemo(Memo.text(params.memo));
        }
      }
      break;
    }

    case "change_trust": {
      const asset = new Asset(params.asset_code, params.asset_issuer);
      builder.addOperation(
        Operation.changeTrust({
          asset,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        }),
      );
      break;
    }

    case "manage_offer": {
      const selling =
        params.selling_asset_code && params.selling_asset_issuer
          ? new Asset(params.selling_asset_code, params.selling_asset_issuer)
          : Asset.native();
      const buying =
        params.buying_asset_code && params.buying_asset_issuer
          ? new Asset(params.buying_asset_code, params.buying_asset_issuer)
          : Asset.native();

      builder.addOperation(
        Operation.manageSellOffer({
          selling,
          buying,
          amount: params.amount,
          price: params.price,
          offerId: params.offer_id ?? "0",
        }),
      );
      break;
    }

    case "path_payment_strict_receive": {
      const sendAsset =
        params.send_asset_code && params.send_asset_issuer
          ? new Asset(params.send_asset_code, params.send_asset_issuer)
          : Asset.native();
      const destAsset =
        params.dest_asset_code && params.dest_asset_issuer
          ? new Asset(params.dest_asset_code, params.dest_asset_issuer)
          : Asset.native();

      const pathAssets = (params.path ?? []).map((p) =>
        p.code && p.issuer ? new Asset(p.code, p.issuer) : Asset.native(),
      );

      builder.addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset,
          sendMax: params.send_max ?? params.send_amount ?? "0",
          destination: params.destination,
          destAsset,
          destAmount: params.dest_amount ?? "0",
          path: pathAssets,
        }),
      );
      break;
    }

    case "path_payment_strict_send": {
      const sendAsset =
        params.send_asset_code && params.send_asset_issuer
          ? new Asset(params.send_asset_code, params.send_asset_issuer)
          : Asset.native();
      const destAsset =
        params.dest_asset_code && params.dest_asset_issuer
          ? new Asset(params.dest_asset_code, params.dest_asset_issuer)
          : Asset.native();

      const pathAssets = (params.path ?? []).map((p) =>
        p.code && p.issuer ? new Asset(p.code, p.issuer) : Asset.native(),
      );

      builder.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset,
          sendAmount: params.send_amount ?? "0",
          destination: params.destination,
          destAsset,
          destMin: params.dest_min ?? params.dest_amount ?? "0",
          path: pathAssets,
        }),
      );
      break;
    }
  }

  try {
    const tx = builder.build();
    return ok(tx);
  } catch (e) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build transaction from SEP-7 URI: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ─── URI Generator ─────────────────────────────────────────────────────────────

/**
 * Generates a valid SEP-7 URI from parameters.
 */
export function generateSep7Uri(params: Sep7Params): SorokitResult<string> {
  if (params.callback !== undefined) {
    const callbackResult = validateSep7CallbackUrl(params.callback);
    if (callbackResult.status === "error") return callbackResult;
  }
  if (params.operation === "tx" && !isValidSep7XdrBase64(params.xdr)) {
    return err(
      SorokitErrorCode.VALIDATION,
      "Invalid SEP-7 XDR: 'xdr' must be canonical base64",
    );
  }

  const query = new URLSearchParams();

  if (params.msg) query.set("msg", params.msg);
  if (params.network_passphrase) query.set("network_passphrase", params.network_passphrase);
  if (params.origin_domain) query.set("origin_domain", params.origin_domain);
  if (params.signature) query.set("signature", params.signature);
  if (params.callback) query.set("callback", params.callback);

  switch (params.operation) {
    case "pay":
      query.set("destination", params.destination);
      if (params.amount) query.set("amount", params.amount);
      if (params.asset_code) query.set("asset_code", params.asset_code);
      if (params.asset_issuer) query.set("asset_issuer", params.asset_issuer);
      if (params.memo) query.set("memo", params.memo);
      if (params.memo_type) query.set("memo_type", params.memo_type);
      break;

    case "tx":
      query.set("xdr", params.xdr);
      if (params.pubkey) query.set("pubkey", params.pubkey);
      break;

    case "change_trust":
      query.set("asset_code", params.asset_code);
      query.set("asset_issuer", params.asset_issuer);
      if (params.limit) query.set("limit", params.limit);
      break;

    case "manage_offer":
      query.set("amount", params.amount);
      query.set("price", params.price);
      if (params.selling_asset_code) query.set("selling_asset_code", params.selling_asset_code);
      if (params.selling_asset_issuer) query.set("selling_asset_issuer", params.selling_asset_issuer);
      if (params.buying_asset_code) query.set("buying_asset_code", params.buying_asset_code);
      if (params.buying_asset_issuer) query.set("buying_asset_issuer", params.buying_asset_issuer);
      if (params.offer_id) query.set("offer_id", params.offer_id);
      break;

    case "path_payment_strict_receive":
    case "path_payment_strict_send":
      query.set("destination", params.destination);
      if (params.send_asset_code) query.set("send_asset_code", params.send_asset_code);
      if (params.send_asset_issuer) query.set("send_asset_issuer", params.send_asset_issuer);
      if (params.send_amount) query.set("send_amount", params.send_amount);
      if (params.dest_asset_code) query.set("dest_asset_code", params.dest_asset_code);
      if (params.dest_asset_issuer) query.set("dest_asset_issuer", params.dest_asset_issuer);
      if (params.dest_amount) query.set("dest_amount", params.dest_amount);
      break;
  }

  const queryString = query.toString();
  return ok(`web+stellar:${params.operation}${queryString ? `?${queryString}` : ""}`);
}
