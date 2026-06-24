import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import type { ContractAbi } from "./types";

interface ContractAbiValidationInput {
  contractAbi: ContractAbi | undefined;
  method: string;
  argCount: number;
}

interface ContractMethodSpec {
  name: string;
  argCount: number;
}

function nameToString(name: string | Buffer): string {
  return typeof name === "string" ? name : name.toString();
}

function fromXdrFunction(fn: import("@stellar/stellar-sdk").xdr.ScSpecFunctionV0): ContractMethodSpec {
  return {
    name: nameToString(fn.name()),
    argCount: fn.inputs().length,
  };
}

function getMethods(contractAbi: ContractAbi): ContractMethodSpec[] {
  if (Array.isArray(contractAbi)) {
    return contractAbi.map(fromXdrFunction);
  }

  if ("methods" in contractAbi) {
    return contractAbi.methods.map((method) => ({
      name: method.name,
      argCount: method.args.length,
    }));
  }

  if ("functions" in contractAbi) {
    return contractAbi.functions.map((method) => ({
      name: method.name,
      argCount: method.args.length,
    }));
  }

  return contractAbi.funcs().map(fromXdrFunction);
}

export function validateContractAbi({
  contractAbi,
  method,
  argCount,
}: ContractAbiValidationInput): SorokitResult<void> {
  if (!contractAbi) return ok(undefined);

  let methods: ContractMethodSpec[];
  try {
    methods = getMethods(contractAbi);
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_PREPARE_FAILED,
      `Invalid contract ABI: ${toMessage(cause)}`,
      cause,
    );
  }

  const methodSpec = methods.find((entry) => entry.name === method);
  if (!methodSpec) {
    return err(
      SorokitErrorCode.CONTRACT_PREPARE_FAILED,
      `Contract method not found in ABI: ${method}`,
    );
  }

  const expectedArgCount = methodSpec.argCount;
  if (argCount !== expectedArgCount) {
    return err(
      SorokitErrorCode.CONTRACT_PREPARE_FAILED,
      `Contract method ${method} expects ${expectedArgCount} argument(s), received ${argCount}.`,
    );
  }

  return ok(undefined);
}
