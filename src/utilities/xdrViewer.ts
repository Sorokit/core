import {
  Transaction,
  FeeBumpTransaction,
  TransactionBuilder,
  Networks,
} from "@stellar/stellar-sdk";

function formatAsset(asset: any): string {
  if (!asset) return "unknown";
  if (typeof asset.isNative === "function" && asset.isNative()) {
    return "XLM (native)";
  }
  if (asset.code && asset.issuer) {
    return `${asset.code}:${asset.issuer}`;
  }
  if (typeof asset === "string") {
    return asset;
  }
  return JSON.stringify(asset);
}

function formatOperation(op: any, index: number): string {
  const lines: string[] = [];
  const typeStr = op.type ? op.type.replace(/([A-Z])/g, " $1").toLowerCase() : "unknown";
  const title = `  [Operation ${index + 1}] ${typeStr.toUpperCase()}`;
  lines.push(title);

  if (op.source) {
    lines.push(`    Source Account: ${op.source}`);
  }

  switch (op.type) {
    case "payment":
      lines.push(`    Destination:    ${op.destination}`);
      lines.push(`    Asset:          ${formatAsset(op.asset)}`);
      lines.push(`    Amount:         ${op.amount}`);
      break;
    case "createAccount":
      lines.push(`    Destination:      ${op.destination}`);
      lines.push(`    Starting Balance: ${op.startingBalance} XLM`);
      break;
    case "changeTrust":
      lines.push(`    Asset / Line: ${formatAsset(op.line)}`);
      lines.push(`    Limit:        ${op.limit ?? "maximum"}`);
      break;
    case "allowTrust":
      lines.push(`    Trustor:   ${op.trustor}`);
      lines.push(`    Asset:     ${op.assetCode}`);
      lines.push(`    Authorize: ${op.authorize}`);
      break;
    case "setOptions":
      if (op.inflationDest) lines.push(`    Inflation Dest: ${op.inflationDest}`);
      if (op.clearFlags !== undefined) lines.push(`    Clear Flags:    ${op.clearFlags}`);
      if (op.setFlags !== undefined) lines.push(`    Set Flags:      ${op.setFlags}`);
      if (op.masterWeight !== undefined) lines.push(`    Master Weight:  ${op.masterWeight}`);
      if (op.lowThreshold !== undefined) lines.push(`    Low Threshold:  ${op.lowThreshold}`);
      if (op.medThreshold !== undefined) lines.push(`    Med Threshold:  ${op.medThreshold}`);
      if (op.highThreshold !== undefined) lines.push(`    High Threshold: ${op.highThreshold}`);
      if (op.homeDomain) lines.push(`    Home Domain:    ${op.homeDomain}`);
      if (op.signer) lines.push(`    Signer:         weight=${op.signer.weight}`);
      break;
    case "manageSellOffer":
    case "manageBuyOffer":
      lines.push(`    Selling:  ${formatAsset(op.selling)}`);
      lines.push(`    Buying:   ${formatAsset(op.buying)}`);
      lines.push(`    Amount:   ${op.amount ?? op.buyAmount}`);
      lines.push(`    Price:    ${op.price}`);
      if (op.offerId) lines.push(`    Offer ID: ${op.offerId}`);
      break;
    case "pathPaymentStrictReceive":
    case "pathPaymentStrictSend":
      lines.push(`    Send Asset: ${formatAsset(op.sendAsset)}`);
      lines.push(`    Dest Asset: ${formatAsset(op.destAsset)}`);
      lines.push(`    Destination: ${op.destination}`);
      if (op.sendAmount) lines.push(`    Send Amount: ${op.sendAmount}`);
      if (op.sendMax) lines.push(`    Send Max:    ${op.sendMax}`);
      if (op.destAmount) lines.push(`    Dest Amount: ${op.destAmount}`);
      if (op.destMin) lines.push(`    Dest Min:    ${op.destMin}`);
      if (op.path && op.path.length > 0) {
        lines.push(`    Path:        ${op.path.map(formatAsset).join(" -> ")}`);
      }
      break;
    case "manageData":
      lines.push(`    Name:  ${op.name}`);
      lines.push(`    Value: ${op.value ? op.value.toString("utf8") : "(cleared)"}`);
      break;
    case "bumpSequence":
      lines.push(`    Bump To: ${op.bumpTo}`);
      break;
    case "accountMerge":
      lines.push(`    Destination: ${op.destination}`);
      break;
    default:
      for (const [key, val] of Object.entries(op)) {
        if (key !== "type" && key !== "source") {
          lines.push(`    ${key}: ${typeof val === "object" ? JSON.stringify(val) : String(val)}`);
        }
      }
      break;
  }

  return lines.join("\n");
}

/**
 * Formats a Stellar transaction XDR (or parsed Transaction instance) into a
 * clear, human-readable string for debugging and inspection.
 *
 * Uses the Stellar SDK library to parse the XDR.
 *
 * @param xdr               - Base64 XDR string or Transaction/FeeBumpTransaction instance.
 * @param networkPassphrase - Network passphrase used to parse the XDR. Defaults to Networks.TESTNET.
 * @returns Formatted human-readable string detailing all transaction fields and operations.
 */
export function formatXDR(
  xdr: string | Transaction | FeeBumpTransaction,
  networkPassphrase: string = Networks.TESTNET,
): string {
  let tx: Transaction | FeeBumpTransaction;

  if (typeof xdr === "string") {
    try {
      tx = TransactionBuilder.fromXDR(xdr.trim(), networkPassphrase);
    } catch (err: any) {
      return `[Error parsing transaction XDR: ${err?.message ?? String(err)}]`;
    }
  } else if (xdr && typeof xdr === "object") {
    tx = xdr;
  } else {
    return "[Error: Invalid transaction or XDR provided]";
  }

  const lines: string[] = [];
  lines.push("======================== STELLAR TRANSACTION ========================");

  if (tx instanceof FeeBumpTransaction) {
    lines.push("Type:             Fee Bump Transaction");
    lines.push(`Fee Source:       ${tx.feeSource}`);
    lines.push(`Max Fee:          ${tx.fee} stroops (${Number(tx.fee) / 10_000_000} XLM)`);
    lines.push(`Signatures Count: ${tx.signatures?.length ?? 0}`);
    if (tx.signatures && tx.signatures.length > 0) {
      tx.signatures.forEach((sig, i) => {
        lines.push(`  Signature ${i + 1}: hint=${sig.hint().toString("hex")}`);
      });
    }

    lines.push("-------------------------- Inner Transaction --------------------------");
    const inner = tx.innerTransaction;
    lines.push(`Source Account:   ${inner.source}`);
    lines.push(`Sequence Number:  ${inner.sequence}`);
    lines.push(`Inner Fee:        ${inner.fee} stroops (${Number(inner.fee) / 10_000_000} XLM)`);
    lines.push(`Memo:             type=${inner.memo?.type ?? "none"}, value=${inner.memo?.value ?? "none"}`);
    lines.push(`Operations Count: ${inner.operations?.length ?? 0}`);
    if (inner.operations && inner.operations.length > 0) {
      lines.push("Operations:");
      inner.operations.forEach((op, i) => {
        lines.push(formatOperation(op, i));
      });
    }
  } else {
    lines.push("Type:             Standard Transaction");
    lines.push(`Source Account:   ${tx.source}`);
    lines.push(`Sequence Number:  ${tx.sequence}`);
    lines.push(`Fee:              ${tx.fee} stroops (${Number(tx.fee) / 10_000_000} XLM)`);
    lines.push(`Memo:             type=${tx.memo?.type ?? "none"}, value=${tx.memo?.value ?? "none"}`);

    if (tx.timeBounds) {
      lines.push(`TimeBounds:       minTime=${tx.timeBounds.minTime}, maxTime=${tx.timeBounds.maxTime}`);
    }

    lines.push(`Signatures Count: ${tx.signatures?.length ?? 0}`);
    if (tx.signatures && tx.signatures.length > 0) {
      tx.signatures.forEach((sig, i) => {
        lines.push(`  Signature ${i + 1}: hint=${sig.hint().toString("hex")}`);
      });
    }

    lines.push(`Operations Count: ${tx.operations?.length ?? 0}`);
    if (tx.operations && tx.operations.length > 0) {
      lines.push("Operations:");
      tx.operations.forEach((op, i) => {
        lines.push(formatOperation(op, i));
      });
    }
  }

  lines.push("=====================================================================");
  return lines.join("\n");
}
