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
// #686: governance proposals, voting, voting power and tracking.
export {
  configureGovernance,
  createHttpGovernanceProvider,
  getProposal,
  getProposals,
  getVotingPower,
  normalizeProposal,
  resetGovernance,
  trackProposal,
  voteOnProposal,
  PROPOSAL_STATUSES,
  TERMINAL_PROPOSAL_STATUSES,
} from "./governance";
export type {
  GovernanceCallOptions,
  GovernanceNetwork,
  GovernanceProposal,
  GovernanceProvider,
  HttpGovernanceProviderOptions,
  ProposalId,
  ProposalStatus,
  ProposalTally,
  ProposalTracker,
  TrackProposalOptions,
  VoteChoice,
  VoteReceipt,
  VotingPower,
} from "./governance";
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
