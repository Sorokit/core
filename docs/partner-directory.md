# Stellar Ecosystem Partner Directory

A comprehensive directory of wallets, exchanges, anchors, bridges, and service providers in the Stellar ecosystem.

## Table of Contents

- [Wallets](#wallets)
- [Decentralized Exchanges (DEXs)](#decentralized-exchanges-dexs)
- [Anchors & Fiat On/Off Ramps](#anchors--fiat-onoff-ramps)
- [Bridge Protocols](#bridge-protocols)
- [Data & Price Feeds](#data--price-feeds)
- [Infrastructure & Tools](#infrastructure--tools)
- [Development Tools](#development-tools)

---

## Wallets

### 1. Freighter
**Type**: Browser Extension  
**Network**: Mainnet & Testnet  
**Soroban Support**: ✅ Yes

**Description**: The most popular Stellar browser wallet with full Soroban support.

**Contact & Resources**:
- Website: https://www.freighter.app/
- Documentation: https://docs.freighter.app/
- GitHub: https://github.com/stellar/freighter
- Support: https://discord.gg/stellar-dev
- API: Browser extension API

**Integration Example**: See [Ecosystem Guide - Freighter Section](./ecosystem-guide.md#freighter-wallet)

---

### 2. Lobstr
**Type**: Mobile App (iOS/Android)  
**Network**: Mainnet  
**Soroban Support**: 🔄 In Progress

**Description**: User-friendly mobile wallet with built-in DEX trading.

**Contact & Resources**:
- Website: https://lobstr.co/
- App Store: https://apps.apple.com/app/lobstr-stellar-wallet/id1404357892
- Google Play: https://play.google.com/store/apps/details?id=com.lobstr.client
- Support: support@lobstr.co
- Documentation: https://lobstr.co/faq

**Features**:
- Buy/sell crypto with credit cards
- Built-in DEX trading
- Multi-signature support
- WalletConnect support

---

### 3. Albedo
**Type**: Web Wallet  
**Network**: Mainnet & Testnet  
**Soroban Support**: ✅ Yes

**Description**: Web-based wallet with advanced transaction inspection and signing.

**Contact & Resources**:
- Website: https://albedo.link/
- Documentation: https://albedo.link/docs
- GitHub: https://github.com/stellar-expert/albedo
- NPM: `@albedo-link/intent`
- Support: https://stellar.expert/

**Integration Example**: See [Ecosystem Guide - Albedo Section](./ecosystem-guide.md#albedo-wallet)

---

### 4. XBULL Wallet
**Type**: Browser Extension & Mobile  
**Network**: Mainnet & Testnet  
**Soroban Support**: ✅ Yes

**Description**: Multi-platform wallet with full Soroban contract interaction.

**Contact & Resources**:
- Website: https://xbull.app/
- Chrome Extension: https://chrome.google.com/webstore/detail/xbull-wallet/
- Documentation: https://docs.xbull.app/
- Twitter: @xBullWallet
- Telegram: https://t.me/xBullWallet

**Features**:
- Soroban smart contract interaction
- Multi-account management
- Hardware wallet support (Ledger)
- Custom network configuration

---

### 5. Stellar.Expert Wallet
**Type**: Web Wallet  
**Network**: Mainnet & Testnet  
**Soroban Support**: ✅ Yes

**Description**: Advanced web wallet with account viewer and analytics integration.

**Contact & Resources**:
- Website: https://stellar.expert/account-viewer
- Documentation: https://stellar.expert/docs
- Support: https://stellar.expert/contact

---

## Decentralized Exchanges (DEXs)

### 6. SoroSwap
**Type**: Soroban DEX (Uniswap V2 Style)  
**Network**: Mainnet & Testnet  
**TVL**: ~$2M (Testnet)

**Description**: First AMM-based DEX built on Soroban smart contracts.

**Contact & Resources**:
- Website: https://soroswap.finance/
- Documentation: https://docs.soroswap.finance/
- GitHub: https://github.com/soroswap/core
- Discord: https://discord.gg/soroswap
- Twitter: @SoroswapFinance

**Smart Contracts**:
- Router: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` (Testnet)
- Factory: Contact team for latest addresses

**Integration Example**: See [Ecosystem Guide - SoroSwap Section](./ecosystem-guide.md#soroswap)

---

### 7. StellarX
**Type**: Traditional DEX (Stellar SDEX)  
**Network**: Mainnet  
**Volume**: 24h ~$500K

**Description**: Professional trading platform using Stellar's native order book.

**Contact & Resources**:
- Website: https://www.stellarx.com/
- Documentation: https://support.stellarx.com/
- API: Horizon API via https://horizon.stellar.org
- Support: support@stellarx.com

**Features**:
- Limit & market orders
- Advanced charting
- Fiat on/off ramps
- Mobile app (iOS/Android)

---

### 8. StellarTerm
**Type**: Traditional DEX (Stellar SDEX)  
**Network**: Mainnet & Testnet  
**Open Source**: ✅ Yes

**Description**: Open-source trading interface for Stellar's decentralized exchange.

**Contact & Resources**:
- Website: https://stellarterm.com/
- GitHub: https://github.com/stellarterm/stellarterm
- Support: https://github.com/stellarterm/stellarterm/issues

---

### 9. Lumenswap
**Type**: AMM DEX  
**Network**: Mainnet  
**TVL**: ~$1M

**Description**: Automated market maker with liquidity pools.

**Contact & Resources**:
- Website: https://lumenswap.io/
- Documentation: https://docs.lumenswap.io/
- GitHub: https://github.com/lumenswap
- Discord: https://discord.gg/lumenswap
- Twitter: @LumenSwap

---

## Anchors & Fiat On/Off Ramps

### 10. MoneyGram Access
**Type**: Cash-to-Crypto Anchor  
**Network**: Mainnet  
**Supported Regions**: 180+ countries

**Description**: Send and receive cash through MoneyGram locations using USDC on Stellar.

**Contact & Resources**:
- Website: https://moneygram.com/
- Integration: Via Circle USDC
- Documentation: https://developers.circle.com/
- Support: Contact MoneyGram directly

---

### 11. AnchorUSD
**Type**: USD Stablecoin Anchor  
**Network**: Mainnet  
**Asset**: USDC (Circle)

**Description**: US-based anchor providing USDC on Stellar.

**Contact & Resources**:
- Website: https://www.anchorusd.com/
- Asset Code: USDC
- Issuer: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
- Documentation: https://www.anchorusd.com/developers
- Support: support@anchorusd.com

**SEP Support**:
- SEP-1: ✅ Stellar Info
- SEP-10: ✅ Authentication
- SEP-24: ✅ Hosted Deposit/Withdrawal
- SEP-31: ✅ Cross-border Payments

---

### 12. Tempo
**Type**: European Anchor  
**Network**: Mainnet  
**Supported Regions**: Europe (SEPA)

**Description**: European anchor supporting EUR deposits and withdrawals.

**Contact & Resources**:
- Website: https://tempo.eu.com/
- Asset Code: EURT
- Issuer: `GAP5LETOV6YIE62YAM56STDANPRDO7ZFDBGSNHJQIYGGKSMOZAHOOS2S`
- Documentation: https://tempo.eu.com/developers
- Support: support@tempo.eu.com

---

### 13. DSTOQ
**Type**: Asset Tokenization  
**Network**: Mainnet  
**Focus**: Commodities & Securities

**Description**: Tokenized real-world assets on Stellar.

**Contact & Resources**:
- Website: https://www.dstoq.com/
- Documentation: https://docs.dstoq.com/
- Support: info@dstoq.com

---

### 14. Vibrant
**Type**: Payment Infrastructure  
**Network**: Mainnet  
**Supported Regions**: Africa, Latin America

**Description**: Mobile money integration and remittance corridors.

**Contact & Resources**:
- Website: https://vibrantapp.com/
- Documentation: Contact for API access
- Support: hello@vibrantapp.com
- Twitter: @VibrantApp

---

## Bridge Protocols

### 15. Allbridge
**Type**: Cross-chain Bridge  
**Supported Chains**: Ethereum, BSC, Polygon, Solana, Stellar

**Description**: Multi-chain bridge connecting Stellar with major blockchain networks.

**Contact & Resources**:
- Website: https://allbridge.io/
- Documentation: https://docs.allbridge.io/
- GitHub: https://github.com/allbridge-io
- Discord: https://discord.gg/allbridge
- Support: support@allbridge.io

**Bridged Assets**:
- USDC (Ethereum ↔ Stellar)
- USDT (Ethereum ↔ Stellar)
- More assets in development

---

### 16. Wormhole (Planned)
**Type**: Cross-chain Bridge  
**Status**: Stellar Integration in Development

**Description**: Leading cross-chain bridge expanding to Stellar.

**Contact & Resources**:
- Website: https://wormhole.com/
- Documentation: https://docs.wormhole.com/
- Discord: https://discord.gg/wormholecrypto
- GitHub: https://github.com/wormhole-foundation

---

## Data & Price Feeds

### 17. Stellar Expert
**Type**: Blockchain Explorer & Analytics  
**Network**: All Stellar Networks

**Description**: Comprehensive blockchain explorer with APIs and analytics.

**Contact & Resources**:
- Website: https://stellar.expert/
- API Documentation: https://stellar.expert/openapi.html
- Public API: `https://api.stellar.expert/explorer/{network}/`
- GitHub: https://github.com/stellar-expert
- Support: https://stellar.expert/contact

**API Features**:
- Price data & charts
- Account history
- Asset analytics
- Directory listings
- Payment path finding

**Integration Example**: See [Ecosystem Guide - Price Feeds Section](./ecosystem-guide.md#stellar-expert-api)

---

### 18. StellarChain
**Type**: Blockchain Explorer  
**Network**: Mainnet & Testnet

**Description**: Fast blockchain explorer with transaction search.

**Contact & Resources**:
- Website: https://stellarchain.io/
- API: Contact for access
- Support: support@stellarchain.io

---

### 19. Soroban RPC Providers
**Type**: RPC Infrastructure  
**Network**: Mainnet & Testnet

**Description**: Hosted RPC nodes for Soroban smart contract interaction.

**Providers**:

#### Mercury
- Website: https://mercurydata.app/
- Docs: https://docs.mercurydata.app/
- Focus: Data indexing & analytics

#### QuickNode
- Website: https://www.quicknode.com/
- Docs: https://www.quicknode.com/docs/stellar
- Features: Global nodes, webhooks, analytics

#### Validation Cloud
- Website: https://www.validationcloud.io/
- Enterprise-grade infrastructure
- SLA guarantees

---

## Infrastructure & Tools

### 20. Stellar Development Foundation (SDF)
**Type**: Core Infrastructure  
**Network**: All Networks

**Description**: Non-profit maintaining Stellar protocol and core infrastructure.

**Contact & Resources**:
- Website: https://stellar.org/
- Developers: https://developers.stellar.org/
- GitHub: https://github.com/stellar
- Discord: https://discord.gg/stellar-dev
- Forum: https://stellar.stackexchange.com/

**Core Services**:
- Horizon API servers
- Friendbot (testnet faucet)
- Core protocol development
- SDKs (JS, Python, Go, Java, etc.)

---

### 21. Stellar Laboratory
**Type**: Development Tool  
**Network**: All Networks

**Description**: Web-based tool for building and testing transactions.

**Contact & Resources**:
- Website: https://laboratory.stellar.org/
- GitHub: https://github.com/stellar/laboratory
- Use Cases: Transaction building, XDR viewing, endpoint testing

---

### 22. SorobanHub
**Type**: Contract Explorer  
**Network**: Mainnet & Testnet

**Description**: Explorer and registry for Soroban smart contracts.

**Contact & Resources**:
- Website: https://sorobanhub.com/
- Features: Contract verification, interaction UI
- Support: Via Discord

---

## Development Tools

### 23. Stellar SDK (JavaScript/TypeScript)
**Type**: Official SDK  
**Language**: JavaScript/TypeScript

**Contact & Resources**:
- NPM: `@stellar/stellar-sdk`
- Documentation: https://stellar.github.io/js-stellar-sdk/
- GitHub: https://github.com/stellar/js-stellar-sdk
- Issues: https://github.com/stellar/js-stellar-sdk/issues

---

### 24. Sorokit (This SDK!)
**Type**: Framework-Agnostic SDK  
**Language**: TypeScript

**Description**: Modern SDK focused on wallet integration and developer experience.

**Contact & Resources**:
- NPM: `sorokit-core`
- Documentation: [See main README](../README.md)
- GitHub: https://github.com/Sorokit/core
- Discord: [Join our Discord]

---

### 25. Stellar CLI (soroban-cli)
**Type**: Command Line Tool  
**Use Case**: Local development, contract deployment

**Contact & Resources**:
- Installation: `cargo install soroban-cli`
- Documentation: https://soroban.stellar.org/docs/tools/developer-tools/cli
- GitHub: https://github.com/stellar/soroban-tools

---

## Additional Partner Categories

### Payment Processors
- **Stripe** - Exploring Stellar integration
- **Circle** - USDC issuer on Stellar
- **Monerium** - EUR e-money on Stellar

### Custodians
- **Fireblocks** - Enterprise custody with Stellar support
- **Copper** - Digital asset custody platform

### Market Makers
- Multiple professional market makers active on Stellar DEX

---

## How to Get Listed

Want to add your project to this directory?

**Requirements**:
1. Active project with public documentation
2. Integration with Stellar ecosystem
3. Accessible support channels
4. Open-source preferred (but not required)

**Submission Process**:
1. Fork the repository
2. Add your project following the template above
3. Submit a pull request with:
   - Project name and description
   - Contact information
   - Documentation links
   - Integration examples (if applicable)

**Template**:
```markdown
### [Number]. [Project Name]
**Type**: [Wallet/DEX/Anchor/Bridge/Tool]  
**Network**: [Mainnet/Testnet/Both]  
**[Relevant Metric]**: [Value]

**Description**: [1-2 sentence description]

**Contact & Resources**:
- Website: [URL]
- Documentation: [URL]
- GitHub: [URL] (if open source)
- Support: [Email/Discord/Other]
- API: [If applicable]

**[Special Features/Sections as needed]**
```

---

## Partner Updates

This directory is community-maintained. Partners can submit updates by:
1. Opening an issue with updated information
2. Submitting a pull request with changes
3. Contacting maintainers directly

---

## Disclaimer

This directory is provided for informational purposes only. Inclusion does not constitute endorsement. Always:
- Verify partner credentials independently
- Read terms of service and privacy policies
- Test integrations thoroughly on testnet
- Follow security best practices
- Comply with local regulations

---

## Maintenance

**Last Updated**: 2024  
**Maintained By**: Sorokit Community  
**Update Frequency**: Quarterly or as needed

**Recent Changes**:
- Initial release with 25+ partners
- Comprehensive contact information
- Integration examples for major services

---

## Need Help?

- **Technical Support**: [Stellar Discord](https://discord.gg/stellar-dev)
- **Integration Questions**: Open an issue on [Sorokit GitHub](https://github.com/Sorokit/core/issues)
- **Partner Inquiries**: Contact project maintainers

---

*This directory is a living document. Contributions and updates are welcome!*
