/**
 * WalletConnect v2 adapter.
 *
 * Enables mobile wallets (and any WalletConnect-compatible wallet) to sign
 * Stellar transactions via the WalletConnect Sign API v2.
 *
 * Consumer responsibilities:
 * - Install @walletconnect/sign-client (peer dependency)
 * - Obtain a WalletConnect Cloud project ID at https://cloud.walletconnect.com
 * - Pass projectId (and optionally metadata/relayUrl) to the constructor
 *
 * The adapter owns the full session lifecycle:
 * - Lazy initialisation of SignClient on first use
 * - Session pairing via URI (QR code / deep-link)
 * - Account + network discovery from session namespaces
 * - Transaction signing via `stellar_signXDR`
 * - Reconnection across page/app restarts via persisted session topic
 * - Disconnect cleans up the remote session
 *
 * All public methods return SorokitResult — nothing is thrown.
 */

import { WalletType } from "../types";
import type { WalletAdapter, SignTransactionInput } from "../types";
import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import { isUserRejection, isTimeoutError, toMessage } from "../../shared";

// ─── WalletConnect types (typed locally — never imported at runtime until the
//     consumer installs @walletconnect/sign-client) ───────────────────────────

interface WCSessionNamespace {
  accounts: string[]; // "stellar:<network>:<publicKey>"
  methods: string[];
  events: string[];
}

interface WCSession {
  topic: string;
  namespaces: Record<string, WCSessionNamespace>;
}

interface WCConnectResult {
  uri?: string;
  approval: () => Promise<WCSession>;
}

interface WCSignClient {
  session: {
    getAll(): WCSession[];
    get(topic: string): WCSession;
  };
  connect(params: {
    requiredNamespaces: Record<
      string,
      {
        methods: string[];
        chains: string[];
        events: string[];
      }
    >;
  }): Promise<WCConnectResult>;
  disconnect(params: {
    topic: string;
    reason: { code: number; message: string };
  }): Promise<void>;
  request<T>(params: {
    topic: string;
    chainId: string;
    request: { method: string; params: unknown };
  }): Promise<T>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
}

interface WCSignClientStatic {
  init(opts: {
    projectId: string;
    metadata?: {
      name: string;
      description: string;
      url: string;
      icons: string[];
    };
    relayUrl?: string;
  }): Promise<WCSignClient>;
}

// ─── Stellar-specific WalletConnect constants ─────────────────────────────────

/** WalletConnect chain IDs for Stellar networks. */
const STELLAR_CHAIN = {
  MAINNET: "stellar:pubnet",
  TESTNET: "stellar:testnet",
  FUTURENET: "stellar:futurenet",
} as const;

/** Standard Stellar method exposed over WalletConnect. */
const STELLAR_SIGN_METHOD = "stellar_signXDR";

/** Required WalletConnect namespace key for Stellar. */
const STELLAR_NAMESPACE = "stellar";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve a Stellar network passphrase to the WalletConnect chain ID. */
function chainIdFromPassphrase(passphrase: string): string {
  const p = passphrase.trim();
  if (p === "Public Global Stellar Network ; September 2015")
    return STELLAR_CHAIN.MAINNET;
  if (p === "Test SDF Network ; September 2015") return STELLAR_CHAIN.TESTNET;
  if (p === "Test SDF Future Network ; October 2022")
    return STELLAR_CHAIN.FUTURENET;
  // For custom/private networks fall back to testnet chain — wallets will
  // verify the passphrase themselves via the XDR.
  return STELLAR_CHAIN.TESTNET;
}

/** Parse a WalletConnect Stellar account string into its public key. */
function publicKeyFromAccount(account: string): string {
  // Format: "stellar:<network>:<publicKey>"
  const parts = account.split(":");
  return parts[parts.length - 1] ?? account;
}

/** Return the first Stellar account from a session, or null. */
function firstAccountFromSession(session: WCSession): string | null {
  const ns = session.namespaces[STELLAR_NAMESPACE];
  if (!ns || ns.accounts.length === 0) return null;
  const first = ns.accounts[0];
  if (!first) return null;
  return publicKeyFromAccount(first);
}

/** Derive a WalletConnect chain ID from a live session (first chain listed). */
function chainIdFromSession(session: WCSession, fallback: string): string {
  const ns = session.namespaces[STELLAR_NAMESPACE];
  if (!ns || ns.accounts.length === 0) return fallback;
  // Account format is "stellar:<network>:<pubkey>" — extract chain portion.
  const account = ns.accounts[0];
  if (!account) return fallback;
  const parts = account.split(":");
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return fallback;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface WalletConnectAdapterConfig {
  /** WalletConnect Cloud project ID (required). */
  projectId: string;
  /**
   * dApp metadata shown in the wallet pairing dialog.
   * Defaults to generic Sorokit metadata when omitted.
   */
  metadata?: {
    name: string;
    description: string;
    url: string;
    icons: string[];
  };
  /** WalletConnect relay server URL. Defaults to the public relay. */
  relayUrl?: string;
  /**
   * Callback invoked with the pairing URI when a new session is being
   * established.  The application should present this as a QR code or
   * deep-link for the user to scan / tap.
   *
   * When absent, the URI is logged to console.warn as a fallback.
   */
  onPairingUri?: (uri: string) => void;
  /**
   * Networks to request access to.
   * Defaults to ["stellar:pubnet", "stellar:testnet"].
   */
  chains?: string[];
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class WalletConnectAdapter implements WalletAdapter {
  readonly walletType = WalletType.WALLETCONNECT;

  private readonly config: {
    projectId: string;
    metadata: NonNullable<WalletConnectAdapterConfig["metadata"]>;
    chains: string[];
    onPairingUri?: (uri: string) => void;
    relayUrl?: string;
  };

  private client: WCSignClient | null = null;
  private session: WCSession | null = null;

  constructor(config: WalletConnectAdapterConfig) {
    if (!config.projectId) {
      throw new Error("WalletConnectAdapter: projectId is required.");
    }
    this.config = {
      projectId: config.projectId,
      metadata: config.metadata ?? {
        name: "Sorokit dApp",
        description: "Stellar application powered by sorokit-core",
        url:
          typeof window !== "undefined"
            ? window.location.origin
            : "https://sorokit.dev",
        icons: [],
      },
      chains: config.chains ?? [STELLAR_CHAIN.MAINNET, STELLAR_CHAIN.TESTNET],
      ...(config.onPairingUri !== undefined
        ? { onPairingUri: config.onPairingUri }
        : {}),
      ...(config.relayUrl !== undefined ? { relayUrl: config.relayUrl } : {}),
    };
  }

  // ─── WalletAdapter ──────────────────────────────────────────────────────────

  /**
   * WalletConnect works in both browser and Node environments.
   * Always returns true — availability depends on network, not the runtime.
   */
  isAvailable(): boolean {
    return true;
  }

  /**
   * Initialise the SignClient, reuse an existing session if available, or
   * start a new pairing flow.  Returns the connected public key on success.
   */
  async connect(): Promise<SorokitResult<string>> {
    try {
      const client = await this._ensureClient();

      // Reuse an active session if one exists.
      const restored = this._restoreSession(client);
      if (restored) {
        this.session = restored;
        const pubkey = firstAccountFromSession(restored);
        if (pubkey) return ok(pubkey);
      }

      // No active session — start a new pairing.
      return await this._pair(client);
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        `WalletConnect connection failed: ${toMessage(cause)}`,
        cause,
      );
    }
  }

  /** Terminate the active WalletConnect session. */
  async disconnect(): Promise<SorokitResult<undefined>> {
    const session = this.session;
    this.session = null;

    if (!session || !this.client) return ok(undefined);

    try {
      await this.client.disconnect({
        topic: session.topic,
        reason: { code: 6000, message: "User disconnected" },
      });
    } catch {
      // Disconnect errors are non-fatal — session may have already expired.
    }

    return ok(undefined);
  }

  /**
   * Sign a transaction XDR via the connected WalletConnect session.
   * Returns the signed XDR string on success.
   */
  async signTransaction(
    input: SignTransactionInput,
  ): Promise<SorokitResult<string>> {
    if (!this.client || !this.session) {
      return err(
        SorokitErrorCode.WALLET_NOT_CONNECTED,
        "WalletConnect session is not active. Call connect() first.",
      );
    }

    const chainId = chainIdFromSession(
      this.session,
      chainIdFromPassphrase(input.networkPassphrase),
    );

    try {
      const result = await this.client.request<{ signedXDR: string } | string>({
        topic: this.session.topic,
        chainId,
        request: {
          method: STELLAR_SIGN_METHOD,
          params: {
            xdr: input.transactionXdr,
            ...(input.accountToSign !== undefined && {
              accountToSign: input.accountToSign,
            }),
          },
        },
      });

      // Wallets may return `{ signedXDR: "..." }` or the raw XDR string.
      const signedXdr =
        typeof result === "string"
          ? result
          : (result as { signedXDR: string }).signedXDR;

      if (!signedXdr) {
        return err(
          SorokitErrorCode.WALLET_SIGN_FAILED,
          "Wallet returned an empty signed transaction XDR.",
        );
      }

      return ok(signedXdr);
    } catch (cause) {
      if (isUserRejection(cause)) {
        return err(
          SorokitErrorCode.WALLET_SIGN_REJECTED,
          "User rejected the WalletConnect signature request.",
          cause,
        );
      }
      if (isTimeoutError(cause)) {
        return err(
          SorokitErrorCode.OPERATION_TIMEOUT,
          `WalletConnect signing timed out: ${toMessage(cause)}`,
          cause,
        );
      }
      return err(
        SorokitErrorCode.WALLET_SIGN_FAILED,
        `WalletConnect signing failed: ${toMessage(cause)}`,
        cause,
      );
    }
  }

  // ─── Public helpers ─────────────────────────────────────────────────────────

  /**
   * Return all Stellar accounts exposed by the active session.
   * Implements the optional WalletAdapter.getAccounts contract.
   */
  async getAccounts(): Promise<SorokitResult<string[]>> {
    if (!this.session) {
      return err(
        SorokitErrorCode.WALLET_NOT_CONNECTED,
        "WalletConnect session is not active. Call connect() first.",
      );
    }
    const ns = this.session.namespaces[STELLAR_NAMESPACE];
    if (!ns) {
      return err(
        SorokitErrorCode.WALLET_NOT_FOUND,
        "No Stellar namespace found in WalletConnect session.",
      );
    }
    const accounts = ns.accounts.map(publicKeyFromAccount);
    return ok(accounts);
  }

  /**
   * Return the pairing URI from the most recently initiated connection flow.
   * Useful for tests or UI code that needs direct access to the URI.
   */
  getActiveSession(): WCSession | null {
    return this.session;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /** Lazy-init the WalletConnect SignClient. */
  private async _ensureClient(): Promise<WCSignClient> {
    if (this.client) return this.client;

    // Dynamic import keeps @walletconnect/sign-client as a true peer dep
    // that is not bundled unless the consumer uses this adapter.
    let SignClient: WCSignClientStatic;
    try {
      const mod = await import("@walletconnect/sign-client" as string);
      SignClient = (mod.SignClient ?? mod.default) as WCSignClientStatic;
    } catch {
      throw new Error(
        "WalletConnect requires @walletconnect/sign-client. " +
          "Install it: npm install @walletconnect/sign-client",
      );
    }

    const initOpts: Parameters<WCSignClientStatic["init"]>[0] = {
      projectId: this.config.projectId,
      metadata: this.config.metadata,
    };
    if (this.config.relayUrl) initOpts.relayUrl = this.config.relayUrl;

    this.client = await SignClient.init(initOpts);

    // Automatically clear the local session reference when the wallet
    // terminates the session from the other end.
    const onDelete = () => {
      this.session = null;
    };
    this.client.on("session_delete", onDelete);
    this.client.on("session_expire", onDelete);

    return this.client;
  }

  /** Find an existing active Stellar session from the client's store. */
  private _restoreSession(client: WCSignClient): WCSession | null {
    try {
      const sessions = client.session.getAll();
      // Prefer sessions that have the Stellar namespace and at least one account.
      return (
        sessions.find(
          (s) =>
            STELLAR_NAMESPACE in s.namespaces &&
            (s.namespaces[STELLAR_NAMESPACE]?.accounts.length ?? 0) > 0,
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  /** Initiate a new WalletConnect pairing flow. */
  private async _pair(client: WCSignClient): Promise<SorokitResult<string>> {
    const { uri, approval } = await client.connect({
      requiredNamespaces: {
        [STELLAR_NAMESPACE]: {
          methods: [STELLAR_SIGN_METHOD],
          chains: this.config.chains,
          events: ["accountsChanged"],
        },
      },
    });

    if (uri) {
      if (this.config.onPairingUri) {
        this.config.onPairingUri(uri);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[sorokit] WalletConnect pairing URI:", uri);
      }
    }

    let session: WCSession;
    try {
      session = await approval();
    } catch (cause) {
      if (isUserRejection(cause)) {
        return err(
          SorokitErrorCode.WALLET_SIGN_REJECTED,
          "User rejected the WalletConnect pairing request.",
          cause,
        );
      }
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        `WalletConnect pairing failed: ${toMessage(cause)}`,
        cause,
      );
    }

    this.session = session;
    const pubkey = firstAccountFromSession(session);

    if (!pubkey) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        "WalletConnect session established but no Stellar account was returned.",
      );
    }

    return ok(pubkey);
  }
}
