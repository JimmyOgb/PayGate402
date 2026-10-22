/**
 * PayGate402 Authoritative Arc Mainnet Contract Config & Protocol Types
 * Strictly targets Arc Mainnet (Chain ID 5042) and Contract V2 (0xa27e390CC82793911D805D4cB3E0c50F2117C77A).
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
  USDC_MAINNET_ADDRESS,
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
  USDC_MAINNET_ADDRESS,
  getNetworkConfig,
  type NetworkConfig,
}

export const SUPPORTED_CHAIN_IDS = [ARC_MAINNET_CHAIN_ID] as const
export const isSupportedChain = (chainId?: number): boolean => chainId === ARC_MAINNET_CHAIN_ID

// Canonical Mainnet Protocol Addresses
export const PAYGATE402_ADDRESS = PAYGATE402_MAINNET_ADDRESS
export const PROTOCOL_TREASURY_ADDRESS = PROTOCOL_TREASURY_MAINNET_ADDRESS
export const MAINNET_DEPLOY_TX_HASH = '0x0a152ebecb54acaa000503c48f098fdf998f76c7d8583a870569200180d08040' as const
export const DEPLOY_TX_HASH = MAINNET_DEPLOY_TX_HASH

export const PROTOCOL_FEE_BPS = 500n
export const BPS_DENOMINATOR = 10000n
export const MIN_SERVICE_PRICE_RAW = 20n // 0.000020 USDC minimum per contract

export const PAYGATE402 = {
  address: PAYGATE402_ADDRESS,
  abi: artifactV2.abi,
} as const

export const getContractConfig = (chainId?: number) => {
  const net = getNetworkConfig(chainId)
  const isMainnet = net.chainId === ARC_MAINNET_CHAIN_ID
  const contractAddress = (net.contractAddress || PAYGATE402_MAINNET_ADDRESS) as `0x${string}`
  const treasuryAddress = (net.treasuryAddress || PROTOCOL_TREASURY_MAINNET_ADDRESS) as `0x${string}`
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

export const USDC_FACT = getUsdc(ARC_MAINNET_CHAIN_ID)!
export const CHAIN_FACT = requireChain(ARC_MAINNET_CHAIN_ID)

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

// Production has ZERO synthetic or demo services. All services are read from Arc Mainnet.
export const DEMO_SERVICES: DemoServiceTemplate[] = []
