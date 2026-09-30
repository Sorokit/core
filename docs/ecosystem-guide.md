# Stellar Ecosystem Integration Guide

This guide provides comprehensive examples for integrating Sorokit with the Stellar ecosystem, including wallets, DEXs, anchors, bridges, and price feeds.

## Table of Contents

- [Wallet Integration](#wallet-integration)
- [DEX Integration](#dex-integration)
- [Anchor Integration](#anchor-integration)
- [Bridge Protocols](#bridge-protocols)
- [Price Feeds](#price-feeds)

---

## Wallet Integration

### WalletConnect

WalletConnect enables secure wallet connections using QR codes and deep links.

**Installation:**
```bash
npm install @walletconnect/sign-client
```

**Integration Example:**
```typescript
import { WalletConnectService } from 'sorokit-core/wallet';

// Initialize WalletConnect
const wcService = new WalletConnectService({
  projectId: 'YOUR_PROJECT_ID', // Get from https://cloud.walletconnect.com
  metadata: {
    name: 'Your App Name',
    description: 'Your app description',
    url: 'https://yourapp.com',
    icons: ['https://yourapp.com/icon.png']
  }
});

// Connect wallet
async function connectWallet() {
  try {
    const session = await wcService.connect({
      chains: ['stellar:pubnet'],
      methods: ['stellar_signTransaction', 'stellar_signXDR'],
    });
    
    console.log('Connected:', session.accounts);
    return session;
  } catch (error) {
    console.error('Connection failed:', error);
  }
}

// Sign transaction
async function signTransaction(xdr: string) {
  const result = await wcService.request({
    method: 'stellar_signXDR',
    params: { xdr },
  });
  
  return result.signedXDR;
}
```

**Resources:**
- [WalletConnect Docs](https://docs.walletconnect.com/)
- [Stellar WalletConnect Spec](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md)

---

### Freighter Wallet

Freighter is a popular Stellar browser extension wallet.

**Detection & Connection:**
```typescript
import { FreighterService } from 'sorokit-core/wallet';

// Check if Freighter is installed
const isFreighterInstalled = await FreighterService.isInstalled();

if (!isFreighterInstalled) {
  console.log('Install Freighter: https://www.freighter.app/');
  return;
}

// Request connection
const publicKey = await FreighterService.connect();
console.log('Connected:', publicKey);

// Sign transaction
async function signWithFreighter(xdr: string, network: string) {
  const signedXDR = await FreighterService.signTransaction({
    xdr,
    network: network === 'mainnet' ? 'PUBLIC' : 'TESTNET',
  });
  
  return signedXDR;
}

// Sign authorization entry (Soroban)
async function signAuthEntry(entryXdr: string) {
  const signedEntry = await FreighterService.signAuthEntry({
    entryXdr,
    network: 'TESTNET',
  });
  
  return signedEntry;
}
```

**Resources:**
- [Freighter Documentation](https://docs.freighter.app/)
- [Freighter GitHub](https://github.com/stellar/freighter)

---

### Albedo Wallet

Albedo provides a web-based wallet interface with deep transaction inspection.

**Installation:**
```bash
npm install @albedo-link/intent
```

**Integration Example:**
```typescript
import albedo from '@albedo-link/intent';

// Request public key
async function connectAlbedo() {
  const result = await albedo.publicKey({
    require_existing: false,
  });
  
  return result.pubkey;
}

// Sign transaction
async function signTransaction(xdr: string) {
  const result = await albedo.tx({
    xdr,
    network: 'public',
    submit: false, // Set true to auto-submit
  });
  
  return result.signed_envelope_xdr;
}

// Sign and submit
async function signAndSubmit(xdr: string) {
  const result = await albedo.tx({
    xdr,
    network: 'public',
    submit: true,
  });
  
  console.log('Transaction hash:', result.tx_hash);
  return result;
}
```

**Resources:**
- [Albedo Documentation](https://albedo.link/docs)
- [Albedo GitHub](https://github.com/stellar-expert/albedo)

---

## DEX Integration

### SoroSwap

SoroSwap is a decentralized exchange built on Soroban.

**Installation:**
```bash
npm install sorokit-core
```

**Integration Example:**
```typescript
import { SorobanService } from 'sorokit-core/soroban';
import { TransactionBuilder } from 'sorokit-core/transaction';

// SoroSwap Router Contract ID (Testnet)
const SOROSWAP_ROUTER = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

// Get swap quote
async function getSwapQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
) {
  const soroban = new SorobanService({ network: 'testnet' });
  
  const result = await soroban.invoke({
    contractId: SOROSWAP_ROUTER,
    method: 'get_amounts_out',
    args: [
      amountIn,
      [tokenIn, tokenOut] // Path
    ],
  });
  
  return result.amounts;
}

// Execute swap
async function executeSwap(
  walletAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOutMin: bigint,
  deadline: number
) {
  const soroban = new SorobanService({ network: 'testnet' });
  
  const tx = await soroban.buildInvocation({
    contractId: SOROSWAP_ROUTER,
    method: 'swap_exact_tokens_for_tokens',
    args: [
      amountIn,
      amountOutMin,
      [tokenIn, tokenOut],
      walletAddress,
      deadline,
    ],
    source: walletAddress,
  });
  
  // Sign and submit with connected wallet
  return tx;
}
```

**Resources:**
- [SoroSwap Documentation](https://docs.soroswap.finance/)
- [SoroSwap Contracts](https://github.com/soroswap/core)

---

### StellarX DEX

StellarX is a traditional Stellar DEX using the native order book.

**Trading Example:**
```typescript
import { TransactionBuilder, Asset } from 'sorokit-core';

// Create buy offer
async function createBuyOffer(
  sourceAccount: string,
  selling: Asset,
  buying: Asset,
  amount: string,
  price: string
) {
  const builder = new TransactionBuilder({ network: 'public' });
  
  const tx = builder
    .source(sourceAccount)
    .manageBuyOffer({
      selling,
      buying,
      buyAmount: amount,
      price,
    })
    .setTimeout(180)
    .build();
  
  return tx;
}

// Get order book
async function getOrderBook(base: Asset, counter: Asset) {
  const response = await fetch(
    `https://horizon.stellar.org/order_book?selling_asset_type=${base.type}&buying_asset_type=${counter.type}`
  );
  
  const data = await response.json();
  
  return {
    bids: data.bids,
    asks: data.asks,
  };
}
```

**Resources:**
- [StellarX Platform](https://www.stellarx.com/)
- [Stellar DEX Docs](https://developers.stellar.org/docs/encyclopedia/sdex)

---

## Anchor Integration

### SEP-24: Hosted Deposit and Withdrawal

SEP-24 enables users to deposit and withdraw fiat through anchors.

**Integration Example:**
```typescript
import { Sep24Service } from 'sorokit-core/integration';

// Initialize SEP-24
const anchor = new Sep24Service({
  homeDomai: 'testanchor.stellar.org',
  asset: 'USDC',
});

// Get anchor info
const info = await anchor.getInfo();
console.log('Supported operations:', info.deposit, info.withdraw);

// Start deposit
async function startDeposit(walletAddress: string, asset: string) {
  const result = await anchor.deposit({
    asset_code: asset,
    account: walletAddress,
  });
  
  // Open interactive URL in iframe/popup
  window.open(result.url, '_blank');
  
  // Poll for transaction status
  return pollTransactionStatus(result.id);
}

// Poll transaction status
async function pollTransactionStatus(id: string) {
  let status = 'pending';
  
  while (status === 'pending' || status === 'pending_user_transfer_start') {
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const tx = await anchor.getTransaction(id);
    status = tx.status;
    
    if (status === 'completed') {
      return tx;
    }
  }
  
  throw new Error(`Transaction failed: ${status}`);
}
```

**Resources:**
- [SEP-24 Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md)
- [Anchor Directory](https://anchors.stellar.org/)

---

### SEP-31: Cross-Border Payments

SEP-31 enables programmatic cross-border payments through anchors.

**Integration Example:**
```typescript
import { Sep31Service } from 'sorokit-core/integration';

// Initialize SEP-31
const remittance = new Sep31Service({
  sendingAnchor: 'send.example.com',
  receivingAnchor: 'receive.example.com',
});

// Get quote
async function getQuote(
  sourceAsset: string,
  destAsset: string,
  destAmount: string
) {
  const quote = await remittance.getQuote({
    send_asset: sourceAsset,
    dest_asset: destAsset,
    dest_amount: destAmount,
  });
  
  return {
    price: quote.price,
    fee: quote.fee,
    expires_at: quote.expires_at,
  };
}

// Send payment
async function sendPayment(
  amount: string,
  destinationAccount: string,
  asset: string
) {
  // Create transaction
  const tx = await remittance.createTransaction({
    amount,
    asset_code: asset,
    fields: {
      transaction: {
        receiver_routing_number: '123456789',
        receiver_account_number: '9876543210',
        type: 'bank_account',
      },
    },
  });
  
  // Execute stellar transaction
  const stellarTx = await executeStellarPayment(tx);
  
  // Notify anchor
  await remittance.notifyTransaction(tx.id, stellarTx.hash);
  
  return tx;
}
```

**Resources:**
- [SEP-31 Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md)
- [Cross-Border Payment Guide](https://developers.stellar.org/docs/anchoring/enabling-cross-border-payments)

---

## Bridge Protocols

### Soroban-EVM Bridge

Connect Stellar with Ethereum and EVM chains.

**Integration Example:**
```typescript
import { BridgeService } from 'sorokit-core/integration';

// Initialize bridge
const bridge = new BridgeService({
  network: 'testnet',
  evmChainId: 5, // Goerli
});

// Bridge tokens from Stellar to Ethereum
async function bridgeToEVM(
  stellarAddress: string,
  evmAddress: string,
  amount: bigint,
  tokenAddress: string
) {
  // Lock tokens on Stellar
  const lockTx = await bridge.lockTokens({
    source: stellarAddress,
    amount,
    token: tokenAddress,
    destination: evmAddress,
    destinationChain: 'ethereum',
  });
  
  // Sign and submit
  const signed = await signTransaction(lockTx);
  await bridge.submitTransaction(signed);
  
  // Wait for bridge relay
  const receipt = await bridge.waitForBridgeCompletion(lockTx.hash);
  
  return receipt.evmTxHash;
}

// Bridge tokens from Ethereum to Stellar
async function bridgeFromEVM(
  evmAddress: string,
  stellarAddress: string,
  amount: bigint,
  tokenAddress: string
) {
  // Burn/lock tokens on EVM
  const burnTx = await bridge.burnEVMTokens({
    from: evmAddress,
    amount,
    token: tokenAddress,
    destination: stellarAddress,
  });
  
  // Wait for Stellar mint
  const receipt = await bridge.waitForMint(burnTx.hash);
  
  return receipt.stellarTxHash;
}
```

**Resources:**
- [Stellar Bridge Docs](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/operations-and-transactions)
- [Testnet Bridge Explorer](https://testbridge.stellar.org)

---

## Price Feeds

### Stellar Expert API

Real-time price data for Stellar assets.

**Integration Example:**
```typescript
import { PriceFeedService } from 'sorokit-core/integration';

// Initialize price feed
const priceFeed = new PriceFeedService({
  provider: 'stellar-expert',
});

// Get current price
async function getAssetPrice(assetCode: string, issuer: string) {
  const price = await priceFeed.getPrice({
    asset_code: assetCode,
    asset_issuer: issuer,
    quote: 'USD',
  });
  
  return {
    price: price.price,
    change24h: price.change_24h,
    volume24h: price.volume_24h,
  };
}

// Get historical prices
async function getHistoricalPrices(
  assetCode: string,
  issuer: string,
  period: '1h' | '1d' | '1w' | '1m'
) {
  const history = await priceFeed.getHistory({
    asset_code: assetCode,
    asset_issuer: issuer,
    period,
  });
  
  return history.prices.map(p => ({
    timestamp: p.timestamp,
    price: p.close,
    volume: p.volume,
  }));
}

// Subscribe to price updates
function subscribeToPrice(assetCode: string, issuer: string, callback: (price: number) => void) {
  return priceFeed.subscribe({
    asset_code: assetCode,
    asset_issuer: issuer,
    onUpdate: (data) => callback(data.price),
  });
}
```

**Resources:**
- [Stellar Expert API](https://stellar.expert/openapi.html)
- [Stellar Expert Platform](https://stellar.expert/)

---

### Horizon API Price Data

Query trade data directly from Horizon.

**Integration Example:**
```typescript
// Get recent trades
async function getRecentTrades(
  baseAsset: { code: string; issuer: string },
  counterAsset: { code: string; issuer: string }
) {
  const url = new URL('https://horizon.stellar.org/trades');
  url.searchParams.set('base_asset_type', 'credit_alphanum4');
  url.searchParams.set('base_asset_code', baseAsset.code);
  url.searchParams.set('base_asset_issuer', baseAsset.issuer);
  url.searchParams.set('counter_asset_type', 'credit_alphanum4');
  url.searchParams.set('counter_asset_code', counterAsset.code);
  url.searchParams.set('counter_asset_issuer', counterAsset.issuer);
  url.searchParams.set('order', 'desc');
  url.searchParams.set('limit', '100');
  
  const response = await fetch(url.toString());
  const data = await response.json();
  
  return data._embedded.records.map((trade: any) => ({
    price: trade.price.n / trade.price.d,
    amount: trade.base_amount,
    timestamp: trade.ledger_close_time,
  }));
}

// Calculate VWAP (Volume Weighted Average Price)
function calculateVWAP(trades: Array<{ price: number; amount: string }>) {
  let totalValue = 0;
  let totalVolume = 0;
  
  for (const trade of trades) {
    const volume = parseFloat(trade.amount);
    totalValue += trade.price * volume;
    totalVolume += volume;
  }
  
  return totalVolume > 0 ? totalValue / totalVolume : 0;
}
```

**Resources:**
- [Horizon API Documentation](https://developers.stellar.org/docs/data/horizon)
- [Horizon Trades Endpoint](https://developers.stellar.org/docs/data/horizon/resources/trades)

---

## Additional Resources

### Developer Tools
- [Stellar Laboratory](https://laboratory.stellar.org/) - Test transactions and operations
- [Stellar Expert](https://stellar.expert/) - Blockchain explorer and analytics
- [SorobanHub](https://sorobanhub.com/) - Soroban contract explorer

### Community
- [Stellar Developers Discord](https://discord.gg/stellar-dev)
- [Stellar Stack Exchange](https://stellar.stackexchange.com/)
- [Stellar Blog](https://stellar.org/blog)

### Testing
- [Friendbot (Testnet Faucet)](https://friendbot.stellar.org/)
- [Soroban Testnet](https://soroban.stellar.org/)

---

## Best Practices

1. **Error Handling**: Always implement robust error handling for network requests and wallet interactions
2. **User Experience**: Provide clear feedback during wallet connections and transactions
3. **Security**: Never expose private keys; always use wallet integrations for signing
4. **Testing**: Test on testnet before deploying to mainnet
5. **Rate Limiting**: Respect API rate limits and implement appropriate backoff strategies
6. **Asset Verification**: Always verify asset codes and issuers to prevent phishing

---

## Need Help?

- **Documentation**: [Stellar Developers](https://developers.stellar.org/)
- **Support**: [Stellar Discord](https://discord.gg/stellar-dev)
- **Issues**: [Sorokit GitHub](https://github.com/Sorokit/core/issues)

---

*Last updated: 2024*  
*Maintained by the Sorokit community*
