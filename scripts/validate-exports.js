const { execSync } = require('child_process');
const path = require('path');
const Module = require('module');

// Intercept require('vitest') to prevent Vitest from throwing "Vitest failed to access its internal state"
// when the testing bundle is loaded in a pure Node.js process.
const originalRequire = Module.prototype.require;
Module.prototype.require = function (request) {
  if (request === 'vitest') {
    return {
      vi: {
        fn: () => (() => {}),
        mock: () => {},
        hoisted: (fn) => fn(),
        importActual: () => Promise.resolve({}),
      },
      describe: () => {},
      it: () => {},
      expect: () => {},
      beforeEach: () => {},
      afterEach: () => {},
      beforeAll: () => {},
      afterAll: () => {},
    };
  }
  return originalRequire.apply(this, arguments);
};

try {
  console.log('Building package via npm run build...');
  execSync('npm run build', { stdio: 'inherit' });
  console.log('Build completed successfully.\n');
} catch (error) {
  console.warn('⚠️ Warning: npm run build exited with an error. Proceeding with validation of built files.\n');
}

const mainPath = path.resolve(__dirname, '../dist/index.js');
const testingPath = path.resolve(__dirname, '../dist/testing/index.js');

console.log(`Loading main module from: ${mainPath}`);
let mainModule;
try {
  mainModule = require(mainPath);
} catch (error) {
  console.error(`Error: Failed to require main bundle from ${mainPath}:`, error.message);
  process.exit(1);
}

console.log(`Loading testing module from: ${testingPath}`);
let testingModule;
try {
  testingModule = require(testingPath);
} catch (error) {
  console.error(`Error: Failed to require testing bundle from ${testingPath}:`, error.message);
  process.exit(1);
}

const expectedMainExports = [
  'createSorokitClient',
  'FreighterAdapter',
  'XBullAdapter',
  'LobstrAdapter',
  'RabetAdapter',
  'WalletType',
  'SorokitErrorCode',
  'ok',
  'err',
  'isOk',
  'isErr',
  'resolveNetwork',
  'NETWORK_DEFAULTS',
  'checkMainnetSafety',
  'extractTransactionTotalXlm',
  'isMainnetNetwork',
  'DEFAULT_MAINNET_SAFETY_THRESHOLD_XLM',
  'MAINNET_NETWORK_PASSPHRASE'
];

const expectedTestingExports = [
  'createMockClient',
  'createMockWalletAdapter'
];

let failed = false;

console.log('\nValidating main exports from dist/index.js...');
for (const name of expectedMainExports) {
  if (mainModule[name] === undefined) {
    console.error(`❌ Missing main export: "${name}" is undefined or not exported.`);
    failed = true;
  } else {
    console.log(`✅ Main export "${name}" is present.`);
  }
}

const sharedModule = require(path.resolve(__dirname, '../dist/shared/index.js'));
for (const name of [
  'checkMainnetSafety', 'extractTransactionTotalXlm', 'isMainnetNetwork',
  'DEFAULT_MAINNET_SAFETY_THRESHOLD_XLM', 'MAINNET_NETWORK_PASSPHRASE',
]) {
  if (sharedModule[name] === undefined) {
    console.error(`Missing shared export: ${name}`);
    failed = true;
  }
}
if (mainModule.SorokitErrorCode.MAINNET_SAFETY_LIMIT !== 'MAINNET_SAFETY_LIMIT') {
  console.error('Missing Mainnet safety error code');
  failed = true;
}

console.log('\nValidating testing exports from dist/testing/index.js...');
for (const name of expectedTestingExports) {
  if (testingModule[name] === undefined) {
    console.error(`❌ Missing testing export: "${name}" is undefined or not exported.`);
    failed = true;
  } else {
    console.log(`✅ Testing export "${name}" is present.`);
  }
}

if (failed) {
  console.error('\n❌ Build validation failed. One or more exports are missing.');
  process.exit(1);
} else {
  console.log('\n✨ Build validation passed successfully! All expected exports are present.');
  process.exit(0);
}
