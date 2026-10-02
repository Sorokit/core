import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts reads HOME via node:os homedir() at call time, so point HOME at
// an isolated temp dir before importing the module, keeping these tests from
// touching the real ~/.sorokit on the machine running them.
const tempHome = mkdtempSync(join(tmpdir(), "sorokit-cli-config-test-"));
process.env.HOME = tempHome;

const { loadConfig, saveConfig, getConfigPath, redactedConfig } = await import("./config.js");

test("loadConfig returns the testnet default when no config file exists", () => {
  const config = loadConfig();
  assert.equal(config.network, "testnet");
  assert.equal(config.secret, undefined);
});

test("saveConfig then loadConfig round-trips the saved values", () => {
  saveConfig({ network: "mainnet", secret: "SFAKESECRET" });
  const config = loadConfig();
  assert.equal(config.network, "mainnet");
  assert.equal(config.secret, "SFAKESECRET");
});

test("getConfigPath points inside the config directory", () => {
  assert.match(getConfigPath(), /\.sorokit[\\/]config\.json$/);
});

test("redactedConfig masks the middle of a secret", () => {
  const redacted = redactedConfig({ network: "testnet", secret: "SABCDEFGHIJKLMNOPQRSTUVWXYZ1234" });
  assert.equal(redacted.secret, "SABC...1234");
  assert.notEqual(redacted.secret, "SABCDEFGHIJKLMNOPQRSTUVWXYZ1234");
});

test("redactedConfig leaves secret undefined when none is set", () => {
  const redacted = redactedConfig({ network: "testnet" });
  assert.equal(redacted.secret, undefined);
});

test("cleanup: remove temp home dir", () => {
  rmSync(tempHome, { recursive: true, force: true });
});
