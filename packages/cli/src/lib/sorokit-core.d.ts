/**
 * Ambient module shim.
 *
 * sorokit-core's own `.d.ts` build currently fails (pre-existing
 * exactOptionalPropertyTypes errors in shared/cacheInvalidation.ts, unrelated
 * to this CLI), so this package's tsc can't resolve real types for it from
 * `dist/`. This shim lets the CLI typecheck and build against the JS output
 * that IS produced. Delete this file once the root package's DTS build is
 * fixed and its real declaration files are available again.
 */
declare module "sorokit-core";
declare module "sorokit-core/soroban";
