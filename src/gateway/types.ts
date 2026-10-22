/**
 * PayGate402 Gateway Types and Protocol Constants
 * Supports explicit multi-chain configuration for Arc Testnet (5042002) and Arc Mainnet (5042).
 */
import type { Address, Hex } from 'viem'

export const ARC_TESTNET_CHAIN_ID = 5042002
export const ARC_MAINNET_CHAIN_ID = 5042

export const SUPPORTED_CHAIN_IDS = [ARC_TESTNET_CHAIN_ID, ARC_MAINNET_CHAIN_ID] as const
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number]

export const ARC_TESTNET_PAYGATE_CONTRACT: Address = '0xcc69506b784dffda4ee4d221b122303304099971'
/** Arc Mainnet PayGate402 contract deployed in Stage 8.17 */
export const ARC_MAINNET_PAYGATE_CONTRACT: Address = '0xa27e390CC82793911D805D4cB3E0c50F2117C77A'

export const ARC_TESTNET_RPC = 'https://rpc.testnet.arc.io'
export const ARC_MAINNET_RPC = 'https://rpc.mainnet.arc.io'

export const USDC_TOKEN_ADDRESS: Address = '0x3600000000000000000000000000000000000000'
export const ARC_USDC_ADDRESS = USDC_TOKEN_ADDRESS

// Backward compatibility default
export const PAYGATE402_CONTRACT_ADDRESS: Address = ARC_TESTNET_PAYGATE_CONTRACT

// Keccak-256 hash of "AccessGranted(uint256,address,bytes32,uint256,uint256)"
export const ACCESS_GRANTED_TOPIC0: Hex = '0x0dc4e40c86b2bf38e31031e5e60c412251e428049601aa6cf3d582fa9cfdbd75'

// Function selector for "payForAccess(uint256,bytes32)"
export const PAY_FOR_ACCESS_SELECTOR: Hex = '0xed38c2de'

/**
 * Derives the authoritative EIP-712 Domain for a given network and verifying contract.
 */
export function buildEip712Domain(chainId: number, verifyingContract: Address) {
  return {
    name: 'PayGate402 Gateway',
    version: '1',
    chainId,
    verifyingContract,
  } as const
}

/**
 * Default EIP-712 Domain for Arc Testnet (backward compatibility)
 */
export const PAYGATE_EIP712_DOMAIN = buildEip712Domain(
  ARC_TESTNET_CHAIN_ID,
  PAYGATE402_CONTRACT_ADDRESS
)

/**
 * EIP-712 Type Definitions
 */
export const PAYGATE_EIP712_TYPES = {
  PayGateAuthorization: [
    { name: 'serviceId', type: 'uint256' },
    { name: 'requestId', type: 'bytes32' },
    { name: 'txHash', type: 'bytes32' },
    { name: 'method', type: 'string' },
    { name: 'path', type: 'string' },
    { name: 'bodyDigest', type: 'bytes32' },
    { name: 'quotedPrice', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const

export type PaymentState =
  | 'PENDING'
  | 'VERIFYING'
  | 'RESERVED'
  | 'DISPATCHING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNCERTAIN'

export interface PaymentChallenge {
  requestId: Hex
  serviceId: bigint
  payer: Address | ''
  method: string
  path: string
  bodyDigest: Hex
  quotedPrice: bigint // In USDC base units (6 decimals)
  chainId: number
  createdAt: number // Unix ms timestamp
  expiresAt: number // Unix ms timestamp
  status: 'ISSUED' | 'CONSUMED' | 'EXPIRED'
}

export interface PaymentRecord {
  txHash: Hex
  requestId: Hex
  serviceId: bigint
  caller: Address
  amountPaid: bigint
  state: PaymentState
  cachedResponse: string | null
  createdAt: number
  updatedAt: number
  consumedAt: number | null
  failureReason?: string | null
}

export type UpstreamMode = 'mock' | 'http' | 'real_metrics'

export interface GatewayConfig {
  port: number
  chainId: number
  contractAddress: Address
  usdcAddress: Address
  minConfirmations: number
  challengeTtlMs: number
  dbPath: string // ':memory:' or file path
  rpcUrl: string
  upstreamMode: UpstreamMode
  upstreamBaseUrl?: string
  mockUpstreamPayload?: string
  mockRpc?: boolean
  maxBodySizeBytes?: number // Default: 1048576 (1 MiB)
  rateLimitWindowMs?: number // Default: 60000 (1 minute)
  maxChallengesPerWindow?: number // Default: 60
}

export class GatewayConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayConfigurationError'
  }
}

/**
 * ARCHITECTURAL CONSTRAINT:
 * The PayGate402 Gateway currently uses local embedded SQLite (node:sqlite) for state persistence.
 * This implementation provides strict ACID replay protection for a SINGLE GATEWAY INSTANCE.
 * It does NOT synchronize locks across distributed replicas or serverless lambdas. Multi-instance
 * deployments require an external distributed datastore (e.g. Postgres or distributed consensus).
 */
export interface UpstreamResponse {
  status: number
  headers?: Record<string, string>
  body: string
  latencyMs: number
}
