const sdk = require('@stellar/stellar-sdk');
console.log(Object.keys(sdk.Operation).filter(k => k.toLowerCase().includes('contract') || k.toLowerCase().includes('wasm')));
