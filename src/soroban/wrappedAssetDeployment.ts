import { Address, Contract, Keypair, Operation, StrKey, xdr } from '@stellar/stellar-sdk';
import { SorokitResult, ok, err } from '../types/result';
import { ContractId } from '../types/contract';
import { buildContractDeploy } from './contractDeploy';
import { SorokitError, ErrorCode } from '../types/errors';

/**
 * Options for deploying a wrapped asset (Stellar Asset Contract).
 */
export interface DeployWrappedAssetOptions {
  /** Optional network passphrase used when deriving the contract ID. */
  networkPassphrase?: string;
  /** Optional fee for the deploy operation (in stroops). */
  fee?: string;
  /** Optional timeout for the deploy operation (in seconds). */
  timeout?: number;
}

/**
 * Deploys a Stellar Asset Contract (SAC) for the given asset and sets the
 * provided admin key via contract initialization.
 *
 * This helper automates deployment of the standard SAC contract binary for a
 * wrapped asset. It does NOT implement asset minting.
 *
 * @param asset - The asset to wrap. Either a canonical asset string
 *   (`"native"` or `"CODE:ISSUER"`) or an `Asset` instance.
 * @param adminKey - The admin public key (G...) that will administer the
 *   deployed contract.
 * @param options - Optional deployment options.
 * @returns A `SorokitResult` containing the deployed `ContractId`.
 */
export async function deployWrappedAsset(
  asset: string | { code: string; issuer: string } | { isNative: () => boolean },
  adminKey: string,
  options: DeployWrappedAssetOptions = {},
): Promise<SorokitResult<ContractId>> {
  // Validate admin key.
  if (!adminKey || typeof adminKey !== 'string') {
    return err(
      new SorokitError(
        ErrorCode.INVALID_ARGUMENT,
        'adminKey is required and must be a string',
      ),
    );
  }

  if (!StrKey.isValidEd25519PublicKey(adminKey)) {
    return err(
      new SorokitError(
        ErrorCode.INVALID_ARGUMENT,
        `adminKey is not a valid Stellar public key: ${adminKey}`,
      ),
    );
  }

  // Validate asset.
  const assetValidation = validateAsset(asset);
  if (!assetValidation.valid) {
    return err(
      new SorokitError(ErrorCode.INVALID_ARGUMENT, assetValidation.message),
    );
  }

  try {
    const adminAddress = Address.fromString(adminKey);

    // Build the SAC deploy operation. The SAC contract is deployed using the
    // standard contract deploy operation with the asset as the deployer.
    const deployOp = buildSacDeployOperation(assetValidation.asset);

    // Initialize the contract by setting the admin key. The SAC exposes an
    // `admin` entry point that sets the admin address; we invoke it as part of
    // the deployment flow so the admin is configured immediately.
    const initOp = buildSetAdminOperation(adminAddress);

    const deployResult = await buildContractDeploy({
      operations: [deployOp, initOp],
      networkPassphrase: options.networkPassphrase,
      fee: options.fee,
      timeout: options.timeout,
    });

    if (!deployResult.ok) {
      return err(deployResult.error);
    }

    const contractId = deployResult.value.contractId;
    if (!contractId) {
      return err(
        new SorokitError(
          ErrorCode.DEPLOYMENT_FAILED,
          'Contract deployment did not return a contract ID',
        ),
      );
    }

    return ok(contractId);
  } catch (error) {
    return err(
      new SorokitError(
        ErrorCode.DEPLOYMENT_FAILED,
        `Failed to deploy wrapped asset contract: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      ),
    );
  }
}

interface AssetValidationResult {
  valid: boolean;
  message: string;
  asset?: { code: string; issuer: string } | { isNative: () => boolean };
}

function validateAsset(
  asset: string | { code: string; issuer: string } | { isNative: () => boolean },
): AssetValidationResult {
  if (asset === undefined || asset === null) {
    return { valid: false, message: 'asset is required' };
  }

  if (typeof asset === 'string') {
    const trimmed = asset.trim();
    if (trimmed.length === 0) {
      return { valid: false, message: 'asset must not be empty' };
    }

    if (trimmed.toLowerCase() === 'native') {
      return { valid: true, message: '', asset: { isNative: () => true } };
    }

    const parts = trimmed.split(':');
    if (parts.length !== 2) {
      return {
        valid: false,
        message: `Invalid asset string "${asset}". Expected "native" or "CODE:ISSUER"`,
      };
    }

    const [code, issuer] = parts;
    if (!code || code.length < 1 || code.length > 12) {
      return {
        valid: false,
        message: `Invalid asset code "${code}". Must be 1-12 characters`,
      };
    }

    if (!StrKey.isValidEd25519PublicKey(issuer)) {
      return {
        valid: false,
        message: `Invalid asset issuer "${issuer}". Must be a valid Stellar public key`,
      };
    }

    return { valid: true, message: '', asset: { code, issuer } };
  }

  if (typeof asset === 'object') {
    if (typeof (asset as { isNative?: () => boolean }).isNative === 'function') {
      return { valid: true, message: '', asset };
    }

    const { code, issuer } = asset as { code?: string; issuer?: string };
    if (!code || typeof code !== 'string' || code.length < 1 || code.length > 12) {
      return {
        valid: false,
        message: 'asset.code must be a string of 1-12 characters',
      };
    }
    if (!issuer || typeof issuer !== 'string' || !StrKey.isValidEd25519PublicKey(issuer)) {
      return {
        valid: false,
        message: 'asset.issuer must be a valid Stellar public key',
      };
    }
    return { valid: true, message: '', asset: { code, issuer } };
  }

  return { valid: false, message: 'asset must be a string or asset object' };
}

function buildSacDeployOperation(
  asset: { code: string; issuer: string } | { isNative: () => boolean },
): xdr.Operation {
  // The SAC is deployed via the standard contract deploy operation, using the
  // asset as the deployer. The Stellar SDK exposes this through
  // `Operation.createStellarAssetContract` (or the equivalent deploy op).
  // We construct the operation using the SDK helper when available.
  const op = (Operation as unknown as {
    createStellarAssetContract?: (args: { asset: unknown }) => xdr.Operation;
  }).createStellarAssetContract;

  if (typeof op === 'function') {
    return op({ asset });
  }

  // Fallback: build a contract deploy operation with the asset as deployer.
  // This mirrors the SAC deployment semantics used by the network.
  return Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeCreateContract(
      new xdr.CreateContractArgs({
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(
          assetToXdr(asset),
        ),
        executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
      }),
    ),
    auth: [],
  });
}

function buildSetAdminOperation(admin: Address): xdr.Operation {
  // Invoke the SAC `admin` entry point to set the admin address.
  return Operation.invokeContractFunction({
    contract: '', // resolved at deploy time by the deploy helper
    function: 'admin',
    args: [admin.toScVal()],
  });
}

function assetToXdr(
  asset: { code: string; issuer: string } | { isNative: () => boolean },
): xdr.Asset {
  if (typeof (asset as { isNative?: () => boolean }).isNative === 'function' &&
      (asset as { isNative: () => boolean }).isNative()) {
    return xdr.Asset.assetTypeNative();
  }

  const { code, issuer } = asset as { code: string; issuer: string };
  const issuerAccountId = Keypair.fromPublicKey(issuer).xdrAccountId();
  return xdr.Asset.assetTypeCreditAlphanum4(
    code,
    issuerAccountId,
  );
}

// Re-export Contract type for consumers that need it.
export type { Contract };
```

Note: The implementation above references `buildContractDeploy` from `./contractDeploy` and types from `../types/result`, `../types/contract`, and `../types/errors`. If those modules use different names or shapes in your codebase, adjust the imports and the `buildContractDeploy` call signature accordingly. The core logic — validation of `asset` and `adminKey`, SAC deploy operation construction, admin initialization, and returning `SorokitResult<ContractId>` — is self-contained and does not implement minting.