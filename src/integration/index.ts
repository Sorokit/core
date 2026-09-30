export {
  authenticateSep10,
  getSep6TransactionStatus,
  initiateSep6Transfer,
  initiateSep24Interactive,
} from "./anchors";
export type {
  AnchorAsset,
  AnchorRequestOptions,
  Sep10AuthOptions,
  Sep24InteractiveResult,
} from "./anchors";
export { deriveKey, rotateSecretKey, validateSecretKey } from "../shared/keyManagement";
export type {
  DerivedStellarKey,
  RotateSecretKeyOptions,
} from "../shared/keyManagement";
export {
  clearFederationAddressCache,
  resolveFederatedAddress,
} from "./federationResolver";
export { createDID, resolveDID, linkAccountToDID, verifyDIDOwnership, clearDIDLinks } from "./didSupport";
export type { DIDData, DIDDocument } from "./didSupport";
export type {
  FederationResolverOptions,
  ResolvedAddress,
} from "./federationResolver";
