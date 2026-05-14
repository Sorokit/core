export { resolveNetwork } from "./resolveNetwork";
export type { NetworkOverrides } from "./resolveNetwork";
export type { NetworkType, NetworkConfig } from "./types";
export { NETWORK_DEFAULTS } from "./types";

// Keep getNetwork and setNetwork as thin wrappers for backward compat
// within the codebase — they delegate to resolveNetwork
export { getNetwork } from "./getNetwork";
export { setNetwork } from "./setNetwork";
