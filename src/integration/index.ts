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
export type {
  FederationResolverOptions,
  ResolvedAddress,
} from "./federationResolver";
export {
  createDID,
  resolveDID,
  linkAccountToDID,
  verifyDIDOwnership,
  STELLAR_DID_METHOD,
} from "./didSupport";
export type {
  StellarDIDDocument,
  DIDVerificationMethod,
  DIDInfo,
  DIDLinkRecord,
  DIDOwnershipProof,
  DIDVerificationResult,
  CreateDIDOptions,
  ResolveDIDOptions,
  LinkDIDOptions,
  VerifyDIDOptions,
  DIDServiceEndpoint,
  DIDResolver,
} from "./didSupport";
