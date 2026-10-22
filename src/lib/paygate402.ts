/**
 * PayGate402 contract config & service catalog
 *
 * NOTE ON CONTRACT VERSIONS:
 * - Contract v1: Deployed on Arc Testnet at 0xcc69506b784dffda4ee4d221b122303304099971.
 * - Contract v2: Local reviewed architecture in `contracts/PayGate402V2.sol`.
 *   Removes permanent access mapping (`hasAccess`), enforces global request ID replay protection,
 *   and implements strict Checks-Effects-Interactions (CEI). Undeployed on Arc Mainnet ($0 spent).
 */
import artifactV1 from '../../contracts/out/PayGate402.sol/PayGate402.json'
import artifactV2 from '../../contracts/out/PayGate402V2.sol/PayGate402V2.json'
import { getUsdc, requireChain } from '@/onchain-facts'
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  PAYGATE402_TESTNET_ADDRESS,
  PROTOCOL_TREASURY_TESTNET_ADDRESS,
  PAYGATE402_MAINNET_ADDRESS,
  PROTOCOL_TREASURY_MAINNET_ADDRESS,
  getNetworkConfig,
  type NetworkConfig,
} from './networkConfig'

export {
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  PAYGATE402_TESTNET_ADDRESS,
  PROTOCOL_TREASURY_TESTNET_ADDRESS,
  PAYGATE402_MAINNET_ADDRESS,
  PROTOCOL_TREASURY_MAINNET_ADDRESS,
  getNetworkConfig,
  type NetworkConfig,
}

export const SUPPORTED_CHAIN_IDS = [ARC_MAINNET_CHAIN_ID, ARC_TESTNET_CHAIN_ID] as const
export const isSupportedChain = (chainId?: number): boolean =>
  Boolean(chainId && (SUPPORTED_CHAIN_IDS as readonly number[]).includes(chainId))

export const PAYGATE402_ADDRESS = PAYGATE402_TESTNET_ADDRESS
export const PROTOCOL_TREASURY_ADDRESS = PROTOCOL_TREASURY_TESTNET_ADDRESS
export const DEPLOY_TX_HASH = '0x0a152ebecb54acaa000503c48f098fdf998f76c7d8583a870569200180d08040' as const

export const PROTOCOL_FEE_BPS = 500n
export const BPS_DENOMINATOR = 10000n
export const MIN_SERVICE_PRICE_RAW = 20n // 0.000020 USDC minimum per contract

export const PAYGATE402 = {
  address: PAYGATE402_ADDRESS,
  abi: artifactV1.abi,
} as const

export const getContractConfig = (chainId?: number) => {
  const net = getNetworkConfig(chainId)
  const isMainnet = net.chainId === ARC_MAINNET_CHAIN_ID
  const contractAddress = (net.contractAddress || PAYGATE402_TESTNET_ADDRESS) as `0x${string}`
  const treasuryAddress = (net.treasuryAddress || PROTOCOL_TREASURY_TESTNET_ADDRESS) as `0x${string}`
  const abi = isMainnet ? artifactV2.abi : artifactV1.abi

  return {
    chainId: net.chainId,
    chainName: net.chainName,
    contractAddress,
    treasuryAddress,
    abi,
    explorerBase: net.explorerBase,
    usdcAddress: net.usdcAddress as `0x${string}`,
    isMainnet,
    isDeployed: net.isDeployed,
  }
}

export const USDC_FACT = getUsdc(ARC_TESTNET_CHAIN_ID)!
export const CHAIN_FACT = requireChain(ARC_TESTNET_CHAIN_ID)

export const EXPLORER_BASE = CHAIN_FACT.explorerBase

export const getContractExplorerUrl = (chainId?: number) => {
  const net = getNetworkConfig(chainId)
  return `${net.explorerBase}/address/${net.contractAddress || PAYGATE402_ADDRESS}`
}

export const getAddressExplorerUrl = (address: string, chainId?: number) => {
  const net = getNetworkConfig(chainId)
  return `${net.explorerBase}/address/${address}`
}

export const getTxExplorerUrl = (hash: string, chainId?: number) => {
  const net = getNetworkConfig(chainId)
  return `${net.explorerBase}/tx/${hash}`
}

export interface ServiceData {
  serviceId: bigint
  provider: string
  name: string
  endpointDescription: string
  priceInUsdc: bigint
  gatedPayloadPreview: string
  active: boolean
  totalCalls: bigint
  totalRevenue: bigint
}

export interface DemoServiceTemplate {
  id: string
  name: string
  category: 'DeFi & Signals' | 'Security & Audit' | 'AI & Agents' | 'Infrastructure'
  endpointPath: string
  httpMethod: 'GET' | 'POST'
  endpointDescription: string
  priceInUsdc: bigint
  tags: string[]
  gatedPayloadPreview: string
}

export const formatUsdcAmount = (raw: bigint): string => {
  const n = Number(raw) / 1_000_000
  if (n === 0) return '0.00'
  if (n < 0.001) return n.toFixed(6)
  if (n < 0.01) return n.toFixed(4)
  return n.toFixed(2)
}

export const formatUsdcExact = (raw: bigint): string => {
  const n = Number(raw) / 1_000_000
  if (n === 0) return '0.00'
  // Strip trailing zeros after 2 decimal places
  const fixed6 = n.toFixed(6)
  return fixed6.replace(/(\.\d{2,}?)0+$/, '$1')
}

export const parseUsdcAmount = (s: string): bigint => {
  const f = parseFloat(s)
  if (isNaN(f) || f <= 0) return 0n
  return BigInt(Math.round(f * 1_000_000))
}

export const calculateFeeSplit = (priceInUsdc: bigint) => {
  const protocolFee = (priceInUsdc * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR
  const providerAmount = priceInUsdc - protocolFee
  return {
    total: priceInUsdc,
    providerAmount,
    protocolFee,
    providerPct: 95,
    protocolPct: 5,
  }
}

export const truncAddr = (addr: string) => {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export const inferServiceCategory = (
  name: string,
  description: string,
  tags: string[] = []
): 'DeFi & Signals' | 'Security & Audit' | 'AI & Agents' | 'Infrastructure' => {
  const text = `${name} ${description} ${tags.join(' ')}`.toLowerCase()
  if (text.includes('security') || text.includes('audit') || text.includes('vulnerability') || text.includes('reentrancy')) {
    return 'Security & Audit'
  }
  if (text.includes('defi') || text.includes('whale') || text.includes('signal') || text.includes('liquidation') || text.includes('alpha')) {
    return 'DeFi & Signals'
  }
  if (text.includes('ai') || text.includes('llm') || text.includes('prompt') || text.includes('agent') || text.includes('inference')) {
    return 'AI & Agents'
  }
  return 'Infrastructure'
}

export const DEMO_SERVICES: DemoServiceTemplate[] = [
  {
    id: 'arc-l1-telemetry',
    name: 'Arc L1 Real-Time Telemetry',
    category: 'Infrastructure',
    endpointPath: '/v1/telemetry/arc-mainnet',
    httpMethod: 'GET',
    endpointDescription: 'Live, authentic Arc L1 blockchain metrics (block height, timestamp, gas utilization, transaction count). Direct RPC query with verifiable source provenance.',
    priceInUsdc: 100_000n, // 0.10 USDC
    tags: ['Arc L1', 'Live Telemetry', 'Zero Synthetic Data', 'Verifiable Provenance'],
    gatedPayloadPreview: JSON.stringify({
      status: 200,
      service: 'arc-l1-telemetry',
      network: 'Arc Mainnet',
      chainId: 5042,
      status_text: 'online',
      telemetry: {
        blockNumber: 27073554,
        blockHash: '0xa1292207ca8de86d8977c56beec886dc4605de074d69be414544da1d75d1ed66',
        blockTimestampIso: '2026-10-21T06:52:30.000Z',
        gasUtilizationPercent: 1.11,
        transactionCount: 2,
        gasPriceGwei: '23.4980'
      },
      provenance: {
        source: 'https://rpc.mainnet.arc.io',
        verifiedLive: true,
        latencyMs: 38
      }
    }, null, 2),
  },
  {
    id: 'demo-whale-accumulation',
    name: '[DEMO — SYNTHETIC DATA] Whale Accumulation Signals',
    category: 'DeFi & Signals',
    endpointPath: '/v1/signals/whale-accumulation',
    httpMethod: 'GET',
    endpointDescription: 'Sample algorithmic alerts demonstrating HTTP 402 integration with synthetic transaction patterns.',
    priceInUsdc: 100_000n, // 0.10 USDC
    tags: ['Demo', 'Synthetic Data', 'DeFi Alert'],
    gatedPayloadPreview: JSON.stringify({
      _notice: 'DEMO — SYNTHETIC DATA (NOT LIVE MARKET DATA)',
      service: 'whale-accumulation',
      signal: {
        address: '0x3ff...a1b2',
        amount: '125000.00',
        confidence: 0.87,
        timestamp: '2025-06-15T12:34:56Z'
      }
    }, null, 2),
  },
  {
    id: 'demo-market-analysis',
    name: '[DEMO — SYNTHETIC DATA] DeFi Market Analysis',
    category: 'DeFi & Signals',
    endpointPath: '/v1/signals/market-analysis',
    httpMethod: 'GET',
    endpointDescription: 'Sample analytics pipeline demonstrating automated HTTP 402 payment flows using synthetic test data.',
    priceInUsdc: 500_000n, // 0.50 USDC
    tags: ['Demo', 'Synthetic Data', 'Analytics'],
    gatedPayloadPreview: JSON.stringify({
      _notice: 'DEMO — SYNTHETIC DATA (NOT LIVE MARKET DATA)',
      service: 'market-analysis',
      liquidity_trend: 'ACCUMULATING',
      top_pools: ['USDC-ETH', 'ARC-USDC'],
      risk_index: 0.22,
      timestamp: '2025-06-15T12:35:00Z'
    }, null, 2),
  },
  {
    id: 'demo-security-audit',
    name: '[DEMO — SYNTHETIC DATA] Smart Contract Security Audit',
    category: 'Security & Audit',
    endpointPath: '/v1/audit/security-analysis',
    httpMethod: 'POST',
    endpointDescription: 'Sample AI security analysis template demonstrating contract vulnerability scanning via simulated responses.',
    priceInUsdc: 1_000_000n, // 1.00 USDC
    tags: ['Demo', 'Synthetic Data', 'Security Audit'],
    gatedPayloadPreview: JSON.stringify({
      _notice: 'DEMO — SYNTHETIC DATA (NOT LIVE MARKET DATA)',
      service: 'security-audit',
      contract: '0xcc69506b784dffda4ee4d221b122303304099971',
      vulnerabilities: [],
      reentrancy_safe: true,
      score: 'A+',
      timestamp: '2025-06-15T12:35:10Z'
    }, null, 2),
  },
]
