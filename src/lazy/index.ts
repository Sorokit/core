/**
 * On-demand module loading (#682).
 *
 * Large, optional parts of the SDK are loaded with dynamic `import()` only
 * when an application first needs them, so they stay out of the initial
 * bundle. Import this entry point on its own (`sorokit-core/lazy`) to get the
 * loader without the full SDK barrel.
 *
 * ## Lazy-loadable modules
 *
 * | Name            | Contents                                             |
 * |-----------------|------------------------------------------------------|
 * | `soroban`       | Contract read/invoke/deploy, events, SAC helpers     |
 * | `integration`   | SEP-2 federation, SEP-6/10/24 anchors, DID, governance |
 * | `governance`    | Proposals, voting, voting power, tracking (#686)     |
 * | `keyManagement` | Mnemonic derivation, secret validation, key rotation |
 * | `streaming`     | Persistent streaming cursor store                    |
 * | `privacy`       | Zero-knowledge proof helpers                         |
 * | `compliance`    | Audit trail and compliance reports                   |
 *
 * ```ts
 * import { loadModule } from "sorokit-core/lazy";
 * const soroban = await loadModule("soroban");
 * if (soroban.status === "ok") await soroban.data.readContract(...);
 * ```
 *
 * Guarantees:
 * - each module is imported at most once; concurrent `loadModule` calls for
 *   the same name share one in-flight import;
 * - a failed import is not cached, so a later call retries it;
 * - `loadModule` never throws — failures come back as `SorokitResult` errors.
 *
 * Automatic (implicit) loading is out of scope; callers decide when to load.
 */

import type {
  AnchorAsset,
  AnchorRequestOptions,
  Sep10AuthOptions,
  Sep24InteractiveResult,
} from "../integration/anchors";
import type { FederationResolverOptions, ResolvedAddress } from "../integration/federationResolver";
import type { DerivedStellarKey, RotateSecretKeyOptions } from "../shared/keyManagement";
import type { Transaction } from "@stellar/stellar-sdk";
import { SorokitErrorCode, err, ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ─── Module registry ─────────────────────────────────────────────────────────

const MODULE_LOADERS = {
  soroban: () => import("../soroban"),
  integration: () => import("../integration"),
  governance: () => import("../integration/governance"),
  keyManagement: () => import("../shared/keyManagement"),
  streaming: () => import("../streaming/cursorStore"),
  privacy: () => import("../privacy/zeroKnowledge"),
  compliance: () => import("../compliance"),
} as const;

export type LazyModuleName = keyof typeof MODULE_LOADERS;
export type LazyModule<N extends LazyModuleName> = Awaited<ReturnType<(typeof MODULE_LOADERS)[N]>>;

/** Every module name `loadModule` accepts. */
export const LAZY_MODULES = Object.freeze(Object.keys(MODULE_LOADERS) as LazyModuleName[]);

const inFlight = new Map<LazyModuleName, Promise<unknown>>();
const loaded = new Map<LazyModuleName, unknown>();

export function isLazyModuleName(name: unknown): name is LazyModuleName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(MODULE_LOADERS, name);
}

/** Import (once) and track a module. Rejects on failure; the failure is not cached. */
function importModule<N extends LazyModuleName>(name: N): Promise<LazyModule<N>> {
  const done = loaded.get(name);
  if (done) return Promise.resolve(done as LazyModule<N>);
  let pending = inFlight.get(name) as Promise<LazyModule<N>> | undefined;
  if (!pending) {
    pending = (MODULE_LOADERS[name]() as Promise<LazyModule<N>>).then(
      (mod) => {
        loaded.set(name, mod);
        inFlight.delete(name);
        return mod;
      },
      (error: unknown) => {
        inFlight.delete(name); // allow a retry
        throw error;
      },
    );
    inFlight.set(name, pending);
  }
  return pending;
}

/**
 * Load a module by name. Resolves to `ok(module)`; an unknown name gives
 * `VALIDATION`, and an import failure (e.g. a chunk that failed to download)
 * gives `INTERNAL` with the original error as `cause`.
 */
export async function loadModule<N extends LazyModuleName>(name: N): Promise<SorokitResult<LazyModule<N>>> {
  if (!isLazyModuleName(name)) {
    return err(
      SorokitErrorCode.VALIDATION,
      `Unknown lazy module "${String(name)}"; expected one of ${LAZY_MODULES.join(", ")}`,
    );
  }
  try {
    return ok(await importModule(name));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(SorokitErrorCode.INTERNAL, `Failed to load module "${name}": ${message}`, error);
  }
}

/** Load several modules in parallel; fails on the first module that fails. */
export async function preloadModules(
  names: readonly LazyModuleName[] = LAZY_MODULES,
): Promise<SorokitResult<LazyModuleName[]>> {
  const results = await Promise.all(names.map((name) => loadModule(name)));
  const failed = results.find((r) => r.status === "error");
  if (failed && failed.status === "error") return failed;
  return ok([...names]);
}

/** Whether `name` has finished loading. */
export function isModuleLoaded(name: LazyModuleName): boolean {
  return loaded.has(name);
}

/** Names of modules loaded so far, in load order. */
export function getLoadedModules(): LazyModuleName[] {
  return [...loaded.keys()];
}

/**
 * Forget load tracking (tests only). The JavaScript module cache is not
 * affected, so re-loading returns the same module instance.
 */
export function resetLazyModules(): void {
  inFlight.clear();
  loaded.clear();
}

// ─── Named loaders (pre-#682 API, unchanged behaviour) ───────────────────────

/** Load Soroban features only when the application needs them. */
export const loadSoroban = () => importModule("soroban");

/** Load SEP-2 federation and SEP-6/10/24 anchor features on demand. */
export const loadIntegration = () => importModule("integration");

/** Load the key derivation and signer rotation helpers on demand. */
export const loadKeyManagement = () => importModule("keyManagement");

/** Load governance proposals/voting helpers on demand (#686). */
export const loadGovernance = () => importModule("governance");

export async function resolveFederatedAddress(address: string, options?: FederationResolverOptions): Promise<SorokitResult<ResolvedAddress>> {
  return (await import("../integration/federationResolver")).resolveFederatedAddress(address, options);
}

export async function authenticateSep10(anchorUrl: string, options: Sep10AuthOptions): Promise<SorokitResult<string>> {
  return (await import("../integration/anchors")).authenticateSep10(anchorUrl, options);
}

export async function initiateSep6Transfer(anchorUrl: string, asset: AnchorAsset, options?: AnchorRequestOptions & { direction?: "deposit" | "withdraw" }): Promise<SorokitResult<Record<string, unknown>>> {
  return (await import("../integration/anchors")).initiateSep6Transfer(anchorUrl, asset, options);
}

export async function initiateSep24Interactive(anchorUrl: string, asset: AnchorAsset, options?: AnchorRequestOptions & { direction?: "deposit" | "withdraw" }): Promise<SorokitResult<Sep24InteractiveResult>> {
  return (await import("../integration/anchors")).initiateSep24Interactive(anchorUrl, asset, options);
}

export async function getSep6TransactionStatus(anchorUrl: string, id: string, options?: AnchorRequestOptions): Promise<SorokitResult<Record<string, unknown>>> {
  return (await import("../integration/anchors")).getSep6TransactionStatus(anchorUrl, id, options);
}

export async function deriveKey(mnemonic: string, path?: string, passphrase?: string): Promise<SorokitResult<DerivedStellarKey>> {
  return (await import("../shared/keyManagement")).deriveKey(mnemonic, path, passphrase);
}

export async function validateSecretKey(secretKey: string): Promise<SorokitResult<{ publicKey: string }>> {
  return (await import("../shared/keyManagement")).validateSecretKey(secretKey);
}

export async function rotateSecretKey(options: RotateSecretKeyOptions): Promise<SorokitResult<Transaction>> {
  return (await import("../shared/keyManagement")).rotateSecretKey(options);
}

export async function clearFederationAddressCache(): Promise<void> {
  (await import("../integration/federationResolver")).clearFederationAddressCache();
}
