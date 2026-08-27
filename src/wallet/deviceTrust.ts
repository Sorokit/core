export interface DeviceSignals {
  userAgent?: string;
  platform?: string;
  language?: string;
  timezone?: string;
  screen?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  touchPoints?: number;
}

export interface DeviceFingerprint {
  id: string;
  available: boolean;
  signalCount: number;
}

export interface TrustHistoryEntry {
  fingerprint: string;
  timestamp?: number;
  walletType?: string;
  publicKey?: string;
}

export interface TrustScoreOptions {
  threshold?: number;
  now?: number;
  maxHistoryAgeMs?: number;
}

export interface TrustEvaluation {
  score: number;
  trusted: boolean;
  securityFlag: boolean;
  requiresVerification: boolean;
  reason: "recognized" | "first_time" | "changed_device" | "unusual_pattern" | "unavailable";
}

const DEFAULT_HISTORY_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function defaultSignals(): DeviceSignals {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & { deviceMemory?: number; maxTouchPoints?: number };
  return {
    ...(nav.userAgent ? { userAgent: nav.userAgent } : {}),
    ...(nav.platform ? { platform: nav.platform } : {}),
    ...(nav.language ? { language: nav.language } : {}),
    ...(typeof Intl !== "undefined" ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
    ...(typeof screen !== "undefined" ? { screen: `${screen.width}x${screen.height}x${screen.colorDepth}` } : {}),
    ...(nav.hardwareConcurrency !== undefined ? { hardwareConcurrency: nav.hardwareConcurrency } : {}),
    ...(nav.deviceMemory !== undefined ? { deviceMemory: nav.deviceMemory } : {}),
    ...(nav.maxTouchPoints !== undefined ? { touchPoints: nav.maxTouchPoints } : {}),
  };
}

function hash(value: string): string {
  let first = 2166136261;
  let second = 2246822519;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ (code + i), 3266489917);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function generateDeviceFingerprint(signals: DeviceSignals = defaultSignals()): DeviceFingerprint {
  const entries = Object.entries(signals)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return { id: "unavailable", available: false, signalCount: 0 };
  const normalized = entries.map(([key, value]) => `${key}:${String(value).slice(0, 128)}`).join("|");
  return { id: `dfp_${hash(normalized)}`, available: true, signalCount: entries.length };
}

export function evaluateDeviceTrust(
  fingerprint: DeviceFingerprint | string,
  history: TrustHistoryEntry[] = [],
  options: TrustScoreOptions = {},
): TrustEvaluation {
  const id = typeof fingerprint === "string" ? fingerprint : fingerprint.id;
  const available = typeof fingerprint === "string" ? id !== "unavailable" : fingerprint.available;
  const threshold = Math.max(0, Math.min(100, options.threshold ?? DEFAULT_TRUST_THRESHOLD));
  if (!available || !id) {
    return { score: 50, trusted: false, securityFlag: false, requiresVerification: false, reason: "unavailable" };
  }
  const now = options.now ?? Date.now();
  const maxAge = options.maxHistoryAgeMs ?? DEFAULT_HISTORY_AGE_MS;
  const recent = history.filter((entry) => !entry.timestamp || now - entry.timestamp <= maxAge);
  const exact = recent.find((entry) => entry.fingerprint === id);
  if (exact) return { score: 100, trusted: true, securityFlag: false, requiresVerification: false, reason: "recognized" };
  if (recent.length === 0) {
    const score = 70;
    return { score, trusted: score >= threshold, securityFlag: false, requiresVerification: score < threshold, reason: "first_time" };
  }
  const score = recent.length >= 3 ? 15 : 35;
  return { score, trusted: score >= threshold, securityFlag: true, requiresVerification: true, reason: recent.length >= 3 ? "unusual_pattern" : "changed_device" };
}

export const DEFAULT_TRUST_THRESHOLD = 60;
