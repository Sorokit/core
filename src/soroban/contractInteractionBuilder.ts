import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { getContractMethods } from "./contractMetadata";
import { encodeContractArgs } from "./contractEncoding";
import type { ContractMethod, ContractMethodInput } from "./types";

export interface ContractInteractionBuilderConfig {
  rpcUrl: string;
  contractId?: string;
}

export interface ArgumentField {
  name: string;
  type: string;
  placeholder: string;
  required: boolean;
  defaultValue: unknown;
}

export interface MethodSelection {
  method: ContractMethod;
  arguments: ArgumentField[];
}

export interface GeneratedCallCode {
  javascript: string;
  typescript: string;
  xdr: string;
  json: string;
}

export type BuilderStateListener = (state: BuilderState) => void;
export type BuilderStateUnsubscribe = () => void;

export interface BuilderState {
  contractId: string | null;
  contractIdValid: boolean;
  contractIdError: string | null;
  methods: ContractMethod[];
  selectedMethod: ContractMethod | null;
  selectedMethodIndex: number;
  arguments: Record<string, unknown>;
  argumentErrors: Record<string, string>;
  validationErrors: string[];
  code: GeneratedCallCode | null;
  loading: boolean;
  error: string | null;
}

function getPlaceholder(type: string): string {
  const t = type.toLowerCase();
  if (t === "bool") return "true / false";
  if (t === "u32" || t === "i32") return "0";
  if (t === "u64" || t === "i64" || t === "u128" || t === "i128") return "0";
  if (t === "string") return "text";
  if (t === "symbol") return "symbol";
  if (t === "bytes") return "0x...";
  if (t === "address") return "G... or C...";
  if (t.startsWith("option<")) return `optional ${t.slice(7, -1)}`;
  if (t.startsWith("vec<")) return `[${t.slice(4, -1)}]`;
  if (t.startsWith("map<")) return `{ key: value }`;
  if (t.startsWith("bytesn<") || t.startsWith("bytesN<")) return "0x...";
  return type;
}

function getDefaultValue(type: string): unknown {
  const t = type.toLowerCase();
  if (t === "bool") return false;
  if (t === "u32" || t === "i32" || t === "u64" || t === "i64" || t === "u128" || t === "i128") return 0;
  if (t === "string" || t === "symbol" || t === "address") return "";
  if (t === "bytes") return null;
  if (t.startsWith("option<")) return null;
  if (t.startsWith("vec<")) return [];
  if (t.startsWith("map<")) return {};
  return "";
}

function defaultValueToSource(value: unknown, type: string): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    if (type === "symbol") return `Symbol.for("${value}")`;
    return `"${value}"`;
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => defaultValueToSource(v, typeof v)).join(", ")}]`;
  if (typeof value === "object") {
    if (value instanceof Uint8Array) return `new Uint8Array([${Array.from(value).join(", ")}])`;
    if (Buffer.isBuffer(value)) return `Buffer.from("${value.toString("hex")}", "hex")`;
    return JSON.stringify(value);
  }
  return String(value);
}

const CONTRACT_ID_REGEX = /^[CD][a-km-zA-HJ-NP-Z1-9]{40,60}$/;

function validateContractId(contractId: string): string | null {
  if (!contractId || contractId.trim().length === 0) {
    return "Contract address is required.";
  }
  if (!CONTRACT_ID_REGEX.test(contractId.trim())) {
    return "Invalid contract address format. Expected a Stellar contract ID (C... or D...).";
  }
  return null;
}

export class ContractInteractionBuilder {
  private _rpcUrl: string;
  private _state: BuilderState;
  private _listeners: Set<BuilderStateListener> = new Set();

  constructor(config: ContractInteractionBuilderConfig) {
    this._rpcUrl = config.rpcUrl;
    this._state = {
      contractId: config.contractId ?? null,
      contractIdValid: config.contractId ? validateContractId(config.contractId) === null : false,
      contractIdError: config.contractId ? validateContractId(config.contractId) : null,
      methods: [],
      selectedMethod: null,
      selectedMethodIndex: -1,
      arguments: {},
      argumentErrors: {},
      validationErrors: [],
      code: null,
      loading: false,
      error: null,
    };
  }

  get state(): BuilderState {
    return { ...this._state, arguments: { ...this._state.arguments } };
  }

  get methods(): ContractMethod[] {
    return [...this._state.methods];
  }

  get selectedMethod(): ContractMethod | null {
    return this._state.selectedMethod;
  }

  subscribe(listener: BuilderStateListener): BuilderStateUnsubscribe {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  private _emit(): void {
    const state = this.state;
    for (const listener of this._listeners) {
      listener(state);
    }
  }

  setContractId(contractId: string): SorokitResult<void> {
    const trimmed = contractId.trim();
    const error = validateContractId(trimmed);
    this._state.contractId = trimmed;
    this._state.contractIdValid = error === null;
    this._state.contractIdError = error;
    if (error) {
      this._state.methods = [];
      this._state.selectedMethod = null;
      this._state.selectedMethodIndex = -1;
      this._state.code = null;
    }
    this._emit();
    return error ? err(SorokitErrorCode.CONTRACT_READ_FAILED, error) : ok(undefined);
  }

  async loadMethods(): Promise<SorokitResult<ContractMethod[]>> {
    if (!this._state.contractId || !this._state.contractIdValid) {
      return err(SorokitErrorCode.CONTRACT_READ_FAILED, "Valid contract address is required before loading methods.");
    }

    this._state.loading = true;
    this._state.error = null;
    this._emit();

    try {
      const result = await getContractMethods(this._rpcUrl, this._state.contractId);
      if (result.status === "error") {
        this._state.loading = false;
        this._state.error = result.error.message;
        this._emit();
        return result;
      }

      this._state.methods = result.data;
      this._state.loading = false;
      this._emit();
      return ok(result.data);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this._state.loading = false;
      this._state.error = message;
      this._emit();
      return err(SorokitErrorCode.CONTRACT_READ_FAILED, message, cause);
    }
  }

  selectMethod(index: number): SorokitResult<MethodSelection> {
    if (index < 0 || index >= this._state.methods.length) {
      return err(SorokitErrorCode.CONTRACT_PREPARE_FAILED, "Invalid method index.");
    }

    const method = this._state.methods[index];
    if (!method) {
      return err(SorokitErrorCode.CONTRACT_PREPARE_FAILED, "Method not found.");
    }

    const fields: ArgumentField[] = method.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      placeholder: getPlaceholder(input.type),
      required: true,
      defaultValue: getDefaultValue(input.type),
    }));

    const args: Record<string, unknown> = {};
    for (const field of fields) {
      args[field.name] = field.defaultValue;
    }

    this._state.selectedMethod = method;
    this._state.selectedMethodIndex = index;
    this._state.arguments = args;
    this._state.argumentErrors = {};
    this._state.validationErrors = [];
    this._state.code = null;
    this._emit();

    return ok({ method, arguments: fields });
  }

  setArgument(name: string, value: unknown): void {
    this._state.arguments[name] = value;
    this._state.argumentErrors[name] = "";
    this._state.code = null;
    this._emit();
  }

  setArgumentError(name: string, error: string): void {
    this._state.argumentErrors[name] = error;
    this._emit();
  }

  validateArguments(): boolean {
    if (!this._state.selectedMethod) return false;

    const errors: Record<string, string> = {};
    const validationErrors: string[] = [];

    for (const input of this._state.selectedMethod.inputs) {
      const value = this._state.arguments[input.name];
      const error = this._validateArgument(input, value);
      if (error) {
        errors[input.name] = error;
        validationErrors.push(`${input.name}: ${error}`);
      }
    }

    this._state.argumentErrors = errors;
    this._state.validationErrors = validationErrors;
    this._emit();

    return validationErrors.length === 0;
  }

  private _validateArgument(input: ContractMethodInput, value: unknown): string | null {
    const type = input.type.toLowerCase();

    if (value === undefined || value === null) {
      if (type.startsWith("option<")) return null;
      return `${input.name} is required.`;
    }

    try {
      if (type === "bool") {
        if (typeof value !== "boolean") return `${input.name} must be a boolean.`;
      } else if (type === "u32" || type === "i32") {
        if (typeof value !== "number" || !Number.isInteger(value)) return `${input.name} must be an integer.`;
      } else if (["u64", "i64", "u128", "i128"].includes(type)) {
        if (typeof value !== "number" && typeof value !== "bigint") return `${input.name} must be a number.`;
      } else if (type === "string" || type === "symbol" || type === "address") {
        if (typeof value !== "string" || value.trim().length === 0) return `${input.name} must be a non-empty string.`;
        if (type === "address" && !/^[GDC][a-km-zA-HJ-NP-Z1-9]{40,60}$/.test(value)) return `${input.name} must be a valid Stellar address.`;
      } else if (type === "bytes") {
        if (!(value instanceof Uint8Array) && !Buffer.isBuffer(value)) return `${input.name} must be bytes.`;
      } else if (type === "vec") {
        if (!Array.isArray(value)) return `${input.name} must be an array.`;
      } else if (type === "map") {
        if (typeof value !== "object" || Array.isArray(value) || value === null) return `${input.name} must be an object.`;
      }
    } catch {
      return `${input.name} validation failed.`;
    }

    return null;
  }

  generateCallCode(): SorokitResult<GeneratedCallCode> {
    if (!this._state.selectedMethod || !this._state.contractId) {
      return err(SorokitErrorCode.CONTRACT_PREPARE_FAILED, "Select a method and provide arguments first.");
    }

    if (!this.validateArguments()) {
      return err(SorokitErrorCode.CONTRACT_PREPARE_FAILED, "Fix argument errors before generating code.");
    }

    const method = this._state.selectedMethod;
    const args = this._state.arguments;
    const code = this._buildCode(method, args);
    this._state.code = code;
    this._emit();
    return ok(code);
  }

  private _buildCode(method: ContractMethod, args: Record<string, unknown>): GeneratedCallCode {
    const jsArgs = method.inputs.map((input) => {
      const value = args[input.name];
      return defaultValueToSource(value, input.type);
    });

    const jsCode = `const { SorokitClient } = require("sorokit-core");

const client = createSorokitClient({ network: "testnet" });

const result = await client.soroban.invoke({
  contractId: "${this._state.contractId}",
  method: "${method.name}",
  args: [${jsArgs.join(", ")}],
}, signFn);`;

    const tsCode = `import { createSorokitClient } from "sorokit-core";

const client = createSorokitClient({ network: "testnet" });

const result = await client.soroban.invoke({
  contractId: "${this._state.contractId!}",
  method: "${method.name}",
  args: [${jsArgs.join(", ")}],
}, signFn);`;

    const xdrPreview = this._buildXdrPreview(method, args);

    const jsonPreview = JSON.stringify(
      {
        contractId: this._state.contractId,
        method: method.name,
        args: method.inputs.map((input) => ({
          name: input.name,
          type: input.type,
          value: args[input.name],
        })),
      },
      null,
      2,
    );

    return { javascript: jsCode, typescript: tsCode, xdr: xdrPreview, json: jsonPreview };
  }

  private _buildXdrPreview(method: ContractMethod, args: Record<string, unknown>): string {
    try {
      const values = method.inputs.map((input) => args[input.name]);
      const scVals = encodeContractArgs(method, values);
      return scVals.map((v) => v.toXDR("base64")).join("\n");
    } catch {
      return "Unable to encode arguments to XDR. Check argument types.";
    }
  }

  reset(): void {
    this._state = {
      contractId: this._state.contractId,
      contractIdValid: false,
      contractIdError: null,
      methods: [],
      selectedMethod: null,
      selectedMethodIndex: -1,
      arguments: {},
      argumentErrors: {},
      validationErrors: [],
      code: null,
      loading: false,
      error: null,
    };
    this._emit();
  }

  resetAll(): void {
    this._state = {
      contractId: null,
      contractIdValid: false,
      contractIdError: null,
      methods: [],
      selectedMethod: null,
      selectedMethodIndex: -1,
      arguments: {},
      argumentErrors: {},
      validationErrors: [],
      code: null,
      loading: false,
      error: null,
    };
    this._emit();
  }
}

export function createContractInteractionBuilder(
  config: ContractInteractionBuilderConfig,
): ContractInteractionBuilder {
  return new ContractInteractionBuilder(config);
}
