import { Asset, Operation, xdr } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";

/** Asset representation acceptable by builders */
export type BuilderAsset =
  | Asset
  | { code: string; issuer?: string | null }
  | string;

/**
 * Normalise a BuilderAsset into a Stellar SDK Asset.
 */
export function normalizeBuilderAsset(asset: BuilderAsset): Asset {
  if (asset instanceof Asset) return asset;
  if (typeof asset === "string") {
    const trimmed = asset.trim();
    if (trimmed.toUpperCase() === "XLM" || trimmed.toUpperCase() === "NATIVE" || trimmed === "") {
      return Asset.native();
    }
    const [code, issuer] = trimmed.split(":");
    return issuer ? new Asset(code, issuer) : Asset.native();
  }
  if (!asset.code || asset.code.toUpperCase() === "XLM" || !asset.issuer) {
    return Asset.native();
  }
  return new Asset(asset.code, asset.issuer);
}

/** Configuration parameters for PathPaymentStrictSendBuilder */
export interface PathPaymentStrictSendParams {
  sendAsset?: BuilderAsset;
  sendAmount?: string;
  destination?: string;
  destAsset?: BuilderAsset;
  destMin?: string;
  path?: BuilderAsset[];
  source?: string;
}

/** Configuration parameters for PathPaymentStrictReceiveBuilder */
export interface PathPaymentStrictReceiveParams {
  sendAsset?: BuilderAsset;
  sendMax?: string;
  destination?: string;
  destAsset?: BuilderAsset;
  destAmount?: string;
  path?: BuilderAsset[];
  source?: string;
}

/**
 * Builder for building Stellar strict-send path payments.
 * In a strict-send path payment, the source amount sent is exact,
 * while the destination receives at least `destMin`.
 */
export class PathPaymentStrictSendBuilder {
  private _sendAsset?: BuilderAsset;
  private _sendAmount?: string;
  private _destination?: string;
  private _destAsset?: BuilderAsset;
  private _destMin?: string;
  private _path: BuilderAsset[] = [];
  private _source?: string;

  constructor(params?: PathPaymentStrictSendParams) {
    if (params) {
      if (params.sendAsset !== undefined) this._sendAsset = params.sendAsset;
      if (params.sendAmount !== undefined) this._sendAmount = params.sendAmount;
      if (params.destination !== undefined) this._destination = params.destination;
      if (params.destAsset !== undefined) this._destAsset = params.destAsset;
      if (params.destMin !== undefined) this._destMin = params.destMin;
      if (params.path !== undefined) this._path = [...params.path];
      if (params.source !== undefined) this._source = params.source;
    }
  }

  setSendAsset(asset: BuilderAsset): this {
    this._sendAsset = asset;
    return this;
  }
  sendAsset(asset: BuilderAsset): this {
    return this.setSendAsset(asset);
  }

  setSendAmount(amount: string): this {
    this._sendAmount = amount;
    return this;
  }
  sendAmount(amount: string): this {
    return this.setSendAmount(amount);
  }

  setDestination(destination: string): this {
    this._destination = destination;
    return this;
  }
  destination(destination: string): this {
    return this.setDestination(destination);
  }

  setDestAsset(asset: BuilderAsset): this {
    this._destAsset = asset;
    return this;
  }
  destAsset(asset: BuilderAsset): this {
    return this.setDestAsset(asset);
  }

  setDestMin(destMin: string): this {
    this._destMin = destMin;
    return this;
  }
  destMin(destMin: string): this {
    return this.setDestMin(destMin);
  }

  setPath(path: BuilderAsset[]): this {
    this._path = [...path];
    return this;
  }
  path(path: BuilderAsset[]): this {
    return this.setPath(path);
  }

  addPathAsset(asset: BuilderAsset): this {
    this._path.push(asset);
    return this;
  }
  addPath(asset: BuilderAsset): this {
    return this.addPathAsset(asset);
  }

  setSource(source: string): this {
    this._source = source;
    return this;
  }
  source(source: string): this {
    return this.setSource(source);
  }

  getParams(): PathPaymentStrictSendParams {
    return {
      sendAsset: this._sendAsset,
      sendAmount: this._sendAmount,
      destination: this._destination,
      destAsset: this._destAsset,
      destMin: this._destMin,
      path: [...this._path],
      source: this._source,
    };
  }

  build(): SorokitResult<xdr.Operation> {
    if (!this._sendAsset) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "sendAsset is required for path payment strict send");
    }
    if (!this._sendAmount) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "sendAmount is required for path payment strict send");
    }
    if (!this._destination) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "destination is required for path payment strict send");
    }
    if (!this._destAsset) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "destAsset is required for path payment strict send");
    }
    if (!this._destMin) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "destMin is required for path payment strict send");
    }

    try {
      const op = Operation.pathPaymentStrictSend({
        sendAsset: normalizeBuilderAsset(this._sendAsset),
        sendAmount: this._sendAmount,
        destination: this._destination,
        destAsset: normalizeBuilderAsset(this._destAsset),
        destMin: this._destMin,
        path: this._path.map(normalizeBuilderAsset),
        ...(this._source ? { source: this._source } : {}),
      });
      return ok(op);
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to build pathPaymentStrictSend operation: ${toMessage(cause)}`,
        cause,
      );
    }
  }

  toOperation(): xdr.Operation {
    const res = this.build();
    if (res.status === "error") {
      throw new Error(res.error.message);
    }
    return res.data;
  }
}

/**
 * Builder for building Stellar strict-receive path payments.
 * In a strict-receive path payment, the destination amount received is exact,
 * while the source sends at most `sendMax`.
 */
export class PathPaymentStrictReceiveBuilder {
  private _sendAsset?: BuilderAsset;
  private _sendMax?: string;
  private _destination?: string;
  private _destAsset?: BuilderAsset;
  private _destAmount?: string;
  private _path: BuilderAsset[] = [];
  private _source?: string;

  constructor(params?: PathPaymentStrictReceiveParams) {
    if (params) {
      if (params.sendAsset !== undefined) this._sendAsset = params.sendAsset;
      if (params.sendMax !== undefined) this._sendMax = params.sendMax;
      if (params.destination !== undefined) this._destination = params.destination;
      if (params.destAsset !== undefined) this._destAsset = params.destAsset;
      if (params.destAmount !== undefined) this._destAmount = params.destAmount;
      if (params.path !== undefined) this._path = [...params.path];
      if (params.source !== undefined) this._source = params.source;
    }
  }

  setSendAsset(asset: BuilderAsset): this {
    this._sendAsset = asset;
    return this;
  }
  sendAsset(asset: BuilderAsset): this {
    return this.setSendAsset(asset);
  }

  setSendMax(sendMax: string): this {
    this._sendMax = sendMax;
    return this;
  }
  sendMax(sendMax: string): this {
    return this.setSendMax(sendMax);
  }

  setDestination(destination: string): this {
    this._destination = destination;
    return this;
  }
  destination(destination: string): this {
    return this.setDestination(destination);
  }

  setDestAsset(asset: BuilderAsset): this {
    this._destAsset = asset;
    return this;
  }
  destAsset(asset: BuilderAsset): this {
    return this.setDestAsset(asset);
  }

  setDestAmount(destAmount: string): this {
    this._destAmount = destAmount;
    return this;
  }
  destAmount(destAmount: string): this {
    return this.setDestAmount(destAmount);
  }

  setPath(path: BuilderAsset[]): this {
    this._path = [...path];
    return this;
  }
  path(path: BuilderAsset[]): this {
    return this.setPath(path);
  }

  addPathAsset(asset: BuilderAsset): this {
    this._path.push(asset);
    return this;
  }
  addPath(asset: BuilderAsset): this {
    return this.addPathAsset(asset);
  }

  setSource(source: string): this {
    this._source = source;
    return this;
  }
  source(source: string): this {
    return this.setSource(source);
  }

  getParams(): PathPaymentStrictReceiveParams {
    return {
      sendAsset: this._sendAsset,
      sendMax: this._sendMax,
      destination: this._destination,
      destAsset: this._destAsset,
      destAmount: this._destAmount,
      path: [...this._path],
      source: this._source,
    };
  }

  build(): SorokitResult<xdr.Operation> {
    if (!this._sendAsset) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "sendAsset is required for path payment strict receive");
    }
    if (!this._sendMax) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "sendMax is required for path payment strict receive");
    }
    if (!this._destination) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "destination is required for path payment strict receive");
    }
    if (!this._destAsset) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "destAsset is required for path payment strict receive");
    }
    if (!this._destAmount) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "destAmount is required for path payment strict receive");
    }

    try {
      const op = Operation.pathPaymentStrictReceive({
        sendAsset: normalizeBuilderAsset(this._sendAsset),
        sendMax: this._sendMax,
        destination: this._destination,
        destAsset: normalizeBuilderAsset(this._destAsset),
        destAmount: this._destAmount,
        path: this._path.map(normalizeBuilderAsset),
        ...(this._source ? { source: this._source } : {}),
      });
      return ok(op);
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Failed to build pathPaymentStrictReceive operation: ${toMessage(cause)}`,
        cause,
      );
    }
  }

  toOperation(): xdr.Operation {
    const res = this.build();
    if (res.status === "error") {
      throw new Error(res.error.message);
    }
    return res.data;
  }
}

/**
 * Create a new PathPaymentStrictSendBuilder.
 */
export function buildPathPaymentStrictSend(
  params?: PathPaymentStrictSendParams,
): PathPaymentStrictSendBuilder {
  return new PathPaymentStrictSendBuilder(params);
}

/**
 * Create a new PathPaymentStrictReceiveBuilder.
 */
export function buildPathPaymentStrictReceive(
  params?: PathPaymentStrictReceiveParams,
): PathPaymentStrictReceiveBuilder {
  return new PathPaymentStrictReceiveBuilder(params);
}
