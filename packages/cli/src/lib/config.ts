import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type NetworkName = "mainnet" | "testnet" | "futurenet";

export interface SorokitCliConfig {
  network: NetworkName;
  /** Stellar secret seed (S...) used to sign `pay` / `contract deploy`. Never printed. */
  secret?: string;
  horizonUrl?: string;
  rpcUrl?: string;
}

const DEFAULT_CONFIG: SorokitCliConfig = { network: "testnet" };

function configDir(): string {
  return join(homedir(), ".sorokit");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): SorokitCliConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: SorokitCliConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getConfigPath(): string {
  return configPath();
}

/** Config with secrets replaced, for safe display in `sorokit config`. */
export function redactedConfig(config: SorokitCliConfig): Record<string, unknown> {
  return {
    ...config,
    secret: config.secret ? `${config.secret.slice(0, 4)}...${config.secret.slice(-4)}` : undefined,
  };
}
