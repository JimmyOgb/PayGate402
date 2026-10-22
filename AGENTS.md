# PayGate402

> Built with Arc Studio - HTTP 402 Pay-Per-Call Protocol & AI Agent Gateway on Arc

---

## What This App Does

PayGate402 is an onchain protocol and developer portal built on Arc Testnet that implements HTTP-402 micropayments for APIs and autonomous AI agents. Consumers or AI agents pay USDC per call; the smart contract automatically splits revenue 95% to the service provider and 5% to the protocol treasury. Callers are granted verifiable onchain access with replay-protection per `(serviceId, caller, requestId)`.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS (Arc Dark theme)
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build: `bun run contracts:build` (`forge build`), test: `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002)
- Token: USDC (6 decimals) Address: 0x3600000000000000000000000000000000000000

## Deployed Contracts

### PayGate402 (Arc Testnet)
- **Address**: `0xcc69506b784dffda4ee4d221b122303304099971`
- **Explorer**: https://explorer.testnet.arc.io/address/0xcc69506b784dffda4ee4d221b122303304099971
- **Constructor args**: USDC=0x3600000000000000000000000000000000000000, Treasury=0x5B12Ce46C7194aD57d143bC22847224047b1Ef42
- **Deploy tx**: 0x0a152ebecb54acaa000503c48f098fdf998f76c7d8583a870569200180d08040

## Contract Interface

- `registerService(name, endpointDesc, priceInUsdc, gatedPayloadPreview) → serviceId`
- `payForAccess(serviceId, requestId)` — splits 95/5, grants access
- `verifyAccess(serviceId, caller) → bool`
- `setServiceActive(serviceId, active)` — provider only

Fee constants: `PROTOCOL_FEE_BPS = 500`, `BPS_DENOMINATOR = 10000`

## Key Files

- `src/App.tsx` — thin composition root
- `src/components/Header.tsx` — sticky header with wallet connect, USDC balance, view toggle
- `src/components/Marketplace.tsx` — service cards, register form, SDK snippets
- `src/components/ServiceCard.tsx` — per-service pay-to-unlock flow
- `src/components/AgentCLI.tsx` — interactive terminal CLI simulator
- `src/lib/paygate402.ts` — contract config, ABI import, formatting utilities
- `contracts/PayGate402.sol` — main contract
- `contracts/test/MockUSDC.sol` — ERC-20 mock for testing
- `contracts/test/PayGate402.t.sol` — 34 Foundry unit tests (all pass)

## To Run

Linux / Arc Studio (Bun):
```bash
bun install
bun run dev
```

Windows / npm:
```bash
npm ci --legacy-peer-deps
npm run dev
```
