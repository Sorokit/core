import { WalletType } from "./types";
import type {
  WalletAdapter,
  WalletCapability,
  WalletCapabilityId,
  WalletCapabilities,
  WalletFeature,
} from "./types";

export const WALLET_CAPABILITY_IDS = {
  accountRead: "account.read",
  accountMulti: "account.multi",
  accountSwitch: "account.switch",
  transactionSign: "transaction.sign",
  transactionSignMultisig: "transaction.sign_multisig",
  transactionSignSoroban: "transaction.sign_soroban",
  hardwareSigning: "hardware.signing",
  qrSigning: "qr.signing",
} as const satisfies Record<string, WalletCapabilityId>;

const STANDARD_CAPABILITIES = Object.values(WALLET_CAPABILITY_IDS) as WalletCapabilityId[];

const FEATURE_CAPABILITIES: Partial<Record<WalletFeature, WalletCapabilityId[]>> = {
  multisig: [WALLET_CAPABILITY_IDS.transactionSignMultisig],
  hardware: [WALLET_CAPABILITY_IDS.hardwareSigning],
  ledger: [WALLET_CAPABILITY_IDS.hardwareSigning],
  trezor: [WALLET_CAPABILITY_IDS.hardwareSigning],
  qr: [WALLET_CAPABILITY_IDS.qrSigning],
};

const WALLET_FEATURES: Record<WalletType, WalletFeature[]> = {
  [WalletType.FREIGHTER]: ["multisig"],
  [WalletType.XBULL]: ["multisig", "hardware"],
  [WalletType.LOBSTR]: ["multisig"],
  [WalletType.HANA]: [],
  [WalletType.RABET]: [],
};

const CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  [WALLET_CAPABILITY_IDS.accountRead]: "Read the currently selected public key.",
  [WALLET_CAPABILITY_IDS.accountMulti]: "List multiple accounts exposed by the wallet.",
  [WALLET_CAPABILITY_IDS.accountSwitch]: "Switch the active wallet account programmatically.",
  [WALLET_CAPABILITY_IDS.transactionSign]: "Sign Stellar transaction XDR.",
  [WALLET_CAPABILITY_IDS.transactionSignMultisig]: "Participate in multi-signature transaction flows.",
  [WALLET_CAPABILITY_IDS.transactionSignSoroban]: "Sign Soroban contract invocation transactions.",
  [WALLET_CAPABILITY_IDS.hardwareSigning]: "Use a hardware-backed signing flow.",
  [WALLET_CAPABILITY_IDS.qrSigning]: "Use QR-based signing or handoff flows.",
};

function normalizeCapabilities(
  walletType: WalletType,
  capabilities: WalletCapability[],
): WalletCapabilities {
  const byId = new Map<string, WalletCapability>();

  for (const id of STANDARD_CAPABILITIES) {
    const cap: WalletCapability = {
      id,
      supported: false,
      source: "fallback",
    };
    const desc = CAPABILITY_DESCRIPTIONS[id];
    if (desc !== undefined) cap.description = desc;
    byId.set(id, cap);
  }

  for (const capability of capabilities) {
    const desc = capability.description ?? CAPABILITY_DESCRIPTIONS[capability.id];
    const cap: WalletCapability = {
      id: capability.id,
      supported: capability.supported,
      source: capability.source,
    };
    if (desc !== undefined) cap.description = desc;
    byId.set(capability.id, cap);
  }

  const normalized = Array.from(byId.values());
  return {
    walletType,
    capabilities: normalized,
    supports(capability: string): boolean {
      return normalized.some((item) => item.id === capability && item.supported);
    },
  };
}

function fallbackCapabilities(adapter: WalletAdapter): WalletCapability[] {
  const supported = new Set<WalletCapabilityId>([
    WALLET_CAPABILITY_IDS.accountRead,
    WALLET_CAPABILITY_IDS.transactionSign,
  ]);

  if (typeof adapter.getAccounts === "function") {
    supported.add(WALLET_CAPABILITY_IDS.accountMulti);
  }

  if (typeof adapter.setActiveAccount === "function") {
    supported.add(WALLET_CAPABILITY_IDS.accountSwitch);
  }

  for (const feature of WALLET_FEATURES[adapter.walletType] ?? []) {
    for (const capability of FEATURE_CAPABILITIES[feature] ?? []) {
      supported.add(capability);
    }
  }

  return Array.from(supported).map((id) => {
    const cap: WalletCapability = {
      id,
      supported: true,
      source: "fallback",
    };
    const desc = CAPABILITY_DESCRIPTIONS[id];
    if (desc !== undefined) cap.description = desc;
    return cap;
  });
}

export function getWalletCapabilities(adapter: WalletAdapter): WalletCapabilities {
  const declared = adapter.getCapabilities?.();
  if (declared) {
    return normalizeCapabilities(adapter.walletType, declared.capabilities);
  }

  return normalizeCapabilities(adapter.walletType, fallbackCapabilities(adapter));
}