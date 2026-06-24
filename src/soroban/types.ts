/**
 * Soroban module public types.
 */
import type { xdr } from "@stellar/stellar-sdk";

export interface ContractMethodInput {
  name: string;
  type: string;
}

export interface ContractMethod {
  name: string;
  inputs: ContractMethodInput[];
  returnType: string | null;
}

export interface ContractAbiMethod {
  name: string;
  args: unknown[];
  returns?: unknown;
}

export interface ContractAbiObject {
  methods: ContractAbiMethod[];
}

export interface ContractAbiFunctionObject {
  functions: ContractAbiMethod[];
}

export interface ContractAbiSpec {
  funcs(): xdr.ScSpecFunctionV0[];
}

export type ContractAbi =
  | ContractAbiObject
  | ContractAbiFunctionObject
  | ContractAbiSpec
  | xdr.ScSpecFunctionV0[];

export interface ContractInvokeParams {
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  cachedMetadata?: ContractMethod[];
  /** Optional ABI used to validate method name and argument count before simulation */
  contractAbi?: ContractAbi;
  /** Public key of the invoking account */
  publicKey: string;
}

export interface ContractReadParams {
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  cachedMetadata?: ContractMethod[];
  /** Optional ABI used to validate method name and argument count before simulation */
  contractAbi?: ContractAbi;
  /**
   * Public key of a funded account to use as the simulation source.
   * Required — the Soroban RPC needs a real account to simulate against.
   */
  publicKey: string;
}

export interface ContractCallResult {
  /** Raw ScVal result */
  result: xdr.ScVal;
  /** Convenience: result decoded to a native JS value where possible */
  value: unknown;
}

export interface PreparedContractCall {
  /** XDR-encoded transaction ready for signing */
  transactionXdr: string;
  /** Estimated fee in stroops */
  fee: string;
}

/**
 * Configuration for the polling loop in invokeContract().
 */
export interface SorobanPollConfig {
  /** Maximum number of polling attempts before giving up. Default: 20 */
  maxAttempts?: number;
  /** Milliseconds between polling attempts. Default: 1500 */
  intervalMs?: number;
}

/**
 * Result of a pre-flight transaction simulation.
 * Returned by soroban.simulate() — used for fee estimation and pre-flight checks.
 */
export interface SimulateTransactionResult {
  /** Estimated fee in stroops */
  fee: string;
  /** Whether the simulation succeeded */
  success: boolean;
  /** Error message if simulation failed */
  error?: string;
}
