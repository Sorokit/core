import type {
  AnchorAsset,
  AnchorRequestOptions,
  Sep10AuthOptions,
  Sep24InteractiveResult,
} from "./integration/anchors";
import type { FederationResolverOptions, ResolvedAddress } from "./integration/federationResolver";
import type { DerivedStellarKey, RotateSecretKeyOptions } from "./shared/keyManagement";
import type { Transaction } from "@stellar/stellar-sdk";
import type { SorokitResult } from "./shared/response";

/** Load Soroban features only when the application needs them. */
export const loadSoroban = () => import("./soroban");

/** Load SEP-2 federation and SEP-6/10/24 anchor features on demand. */
export const loadIntegration = () => import("./integration");

/** Load the key derivation and signer rotation helpers on demand. */
export const loadKeyManagement = () => import("./shared/keyManagement");

export async function resolveFederatedAddress(address: string, options?: FederationResolverOptions): Promise<SorokitResult<ResolvedAddress>> {
  return (await import("./integration/federationResolver")).resolveFederatedAddress(address, options);
}

export async function authenticateSep10(anchorUrl: string, options: Sep10AuthOptions): Promise<SorokitResult<string>> {
  return (await import("./integration/anchors")).authenticateSep10(anchorUrl, options);
}

export async function initiateSep6Transfer(anchorUrl: string, asset: AnchorAsset, options?: AnchorRequestOptions & { direction?: "deposit" | "withdraw" }): Promise<SorokitResult<Record<string, unknown>>> {
  return (await import("./integration/anchors")).initiateSep6Transfer(anchorUrl, asset, options);
}

export async function initiateSep24Interactive(anchorUrl: string, asset: AnchorAsset, options?: AnchorRequestOptions & { direction?: "deposit" | "withdraw" }): Promise<SorokitResult<Sep24InteractiveResult>> {
  return (await import("./integration/anchors")).initiateSep24Interactive(anchorUrl, asset, options);
}

export async function getSep6TransactionStatus(anchorUrl: string, id: string, options?: AnchorRequestOptions): Promise<SorokitResult<Record<string, unknown>>> {
  return (await import("./integration/anchors")).getSep6TransactionStatus(anchorUrl, id, options);
}

export async function deriveKey(mnemonic: string, path?: string, passphrase?: string): Promise<SorokitResult<DerivedStellarKey>> {
  return (await import("./shared/keyManagement")).deriveKey(mnemonic, path, passphrase);
}

export async function validateSecretKey(secretKey: string): Promise<SorokitResult<{ publicKey: string }>> {
  return (await import("./shared/keyManagement")).validateSecretKey(secretKey);
}

export async function rotateSecretKey(options: RotateSecretKeyOptions): Promise<SorokitResult<Transaction>> {
  return (await import("./shared/keyManagement")).rotateSecretKey(options);
}

export async function clearFederationAddressCache(): Promise<void> {
  (await import("./integration/federationResolver")).clearFederationAddressCache();
}
