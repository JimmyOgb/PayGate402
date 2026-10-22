/**
 * PayGate402 Gateway Application Entry Point
 * Starts the HTTP 402 reverse proxy with configurable RPC, database, and upstream adapters.
 * Implements strict multi-chain validation for Arc Testnet (5042002) and Arc Mainnet (5042).
 */
import { GatewayDb } from './db.ts'
import { BlockchainVerifier, ViemRpcClient, type RpcClientInterface } from './verifier.ts'
import { MockRpcClient } from './mockRpc.ts'
import {
  HttpUpstreamAdapter,
  MockUpstreamAdapter,
  RealDataUpstreamAdapter,
  type UpstreamAdapter,
} from './upstream.ts'
import { createGatewayServer } from './server.ts'
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_PAYGATE_CONTRACT,
  ARC_MAINNET_PAYGATE_CONTRACT,
  ARC_TESTNET_RPC,
  ARC_MAINNET_RPC,
  USDC_TOKEN_ADDRESS,
  SUPPORTED_CHAIN_IDS,
  GatewayConfigurationError,
  type GatewayConfig,
} from './types.ts'
import type { Address } from 'viem'

/**
 * Resolves and validates Gateway configuration.
 * Fails closed if the chain ID is unsupported or if Mainnet is missing its dedicated contract address.
 */
export function resolveGatewayConfig(customConfig?: Partial<GatewayConfig>): GatewayConfig {
  const isMockRpc = Boolean(customConfig?.mockRpc || process.env.MOCK_RPC === 'true')
  const rawChainId = customConfig?.chainId ?? (process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : ARC_TESTNET_CHAIN_ID)

  if (!SUPPORTED_CHAIN_IDS.includes(rawChainId as 5042002 | 5042)) {
    throw new GatewayConfigurationError(
      `Unsupported chain ID: ${rawChainId}. Supported networks are Arc Testnet (${ARC_TESTNET_CHAIN_ID}) and Arc Mainnet (${ARC_MAINNET_CHAIN_ID}).`
    )
  }
  const chainId = rawChainId

  // Resolve contract address
  let contractAddress: Address | undefined =
    customConfig?.contractAddress ?? (process.env.PAYGATE_CONTRACT_ADDRESS as Address | undefined)

  if (!contractAddress) {
    if (chainId === ARC_TESTNET_CHAIN_ID) {
      contractAddress = ARC_TESTNET_PAYGATE_CONTRACT
    } else if (chainId === ARC_MAINNET_CHAIN_ID) {
      if (isMockRpc) {
        // Permit deterministic placeholder for mock unit test suites only
        contractAddress = '0x1111111111111111111111111111111111111111'
      } else {
        throw new GatewayConfigurationError(
          'Refusing to start live gateway on Arc Mainnet (5042): Mainnet contract address is not configured. Deploy PayGate402 to Arc Mainnet and set PAYGATE_CONTRACT_ADDRESS.'
        )
      }
    }
  }

  // Address sanity and distinct network check
  if (!contractAddress || !/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) {
    throw new GatewayConfigurationError(`Invalid or missing PayGate402 contract address: "${contractAddress}"`)
  }

  if (chainId === ARC_MAINNET_CHAIN_ID && !isMockRpc) {
    if (contractAddress.toLowerCase() === ARC_TESTNET_PAYGATE_CONTRACT.toLowerCase()) {
      throw new GatewayConfigurationError(
        `Refusing to start: Mainnet (5042) cannot use the Arc Testnet contract address (${ARC_TESTNET_PAYGATE_CONTRACT}). A distinct Mainnet contract must be deployed and configured.`
      )
    }
  }

  // Resolve RPC URL
  const rpcUrl =
    customConfig?.rpcUrl ??
    process.env.ARC_RPC_URL ??
    (chainId === ARC_MAINNET_CHAIN_ID ? ARC_MAINNET_RPC : ARC_TESTNET_RPC)

  // Resolve USDC Address
  const usdcAddress =
    customConfig?.usdcAddress ??
    (process.env.USDC_ADDRESS as Address | undefined) ??
    USDC_TOKEN_ADDRESS

  const port = customConfig?.port ?? Number(process.env.PORT || 4020)
  const dbPath = customConfig?.dbPath ?? process.env.DB_PATH ?? 'gateway.db'
  const minConfirmations = customConfig?.minConfirmations ?? Number(process.env.MIN_CONFIRMATIONS || 1)
  const upstreamMode =
    customConfig?.upstreamMode ??
    (process.env.UPSTREAM_MODE === 'real_metrics'
      ? 'real_metrics'
      : process.env.UPSTREAM_MODE === 'http'
        ? 'http'
        : 'mock')

  const maxBodySizeBytes = customConfig?.maxBodySizeBytes ?? Number(process.env.MAX_BODY_SIZE_BYTES || 1048576)
  const rateLimitWindowMs = customConfig?.rateLimitWindowMs ?? Number(process.env.RATE_LIMIT_WINDOW_MS || 60000)
  const maxChallengesPerWindow =
    customConfig?.maxChallengesPerWindow ?? Number(process.env.MAX_CHALLENGES_PER_WINDOW || 60)

  return {
    port,
    chainId,
    contractAddress,
    usdcAddress,
    minConfirmations,
    challengeTtlMs: 15 * 60 * 1000, // 15 minutes
    dbPath,
    rpcUrl,
    upstreamMode,
    maxBodySizeBytes,
    rateLimitWindowMs,
    maxChallengesPerWindow,
    mockRpc: isMockRpc,
    ...customConfig,
  }
}

export function startGateway(customConfig?: Partial<GatewayConfig>) {
  const config = resolveGatewayConfig(customConfig)

  const db = new GatewayDb(config.dbPath)
  const rpc: RpcClientInterface = config.mockRpc
    ? new MockRpcClient()
    : new ViemRpcClient(config.rpcUrl, config.contractAddress)
  const verifier = new BlockchainVerifier(rpc, config.minConfirmations, config.contractAddress, config.chainId)

  let upstream: UpstreamAdapter
  if (config.upstreamMode === 'real_metrics') {
    upstream = new RealDataUpstreamAdapter({
      endpointUrl: process.env.UPSTREAM_METRICS_URL ?? config.rpcUrl,
    })
  } else if (config.upstreamMode === 'http' && process.env.UPSTREAM_BASE_URL) {
    upstream = new HttpUpstreamAdapter(process.env.UPSTREAM_BASE_URL)
  } else {
    upstream = new MockUpstreamAdapter()
  }

  const server = createGatewayServer({
    config,
    db,
    verifier,
    upstream,
    rpc,
  })

  server.listen(config.port, () => {
    const mockBanner = config.mockRpc
      ? `\n  *** SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED ***\n  RPC Client:        Deterministic Mock RPC (Services 0 & 1)\n`
      : ''
    const networkName = config.chainId === ARC_MAINNET_CHAIN_ID ? 'Arc Mainnet' : 'Arc Testnet'
    process.stdout.write(`
======================================================
  PayGate402 Secure HTTP 402 Gateway Started${mockBanner}
======================================================
  Port:              ${config.port}
  Network:           ${networkName} (Chain ID ${config.chainId})
  Contract:          ${config.contractAddress}
  USDC Token:        ${config.usdcAddress}
  Min Confirmations: ${config.minConfirmations}
  Upstream Mode:     ${config.upstreamMode}
  Database:          ${config.dbPath} (WAL Enabled)
  Max Body Size:     ${(config.maxBodySizeBytes ?? 1048576) / 1024 / 1024} MiB
  Rate Limit:        ${config.maxChallengesPerWindow ?? 60} challenges / ${(config.rateLimitWindowMs ?? 60000) / 1000}s
  Architecture:      Single-Instance Embedded SQLite
  Health Check:      http://localhost:${config.port}/health
  Protected Proxy:   http://localhost:${config.port}/v1/gateway/:serviceId/*
======================================================
`)
  })

  return {
    server,
    db,
    verifier,
    upstream,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()))
      })
      db.close()
    },
  }
}

// Auto-start gateway if executed directly via Node.js
if (process.argv[1] && (process.argv[1].endsWith('gateway/index.ts') || process.argv[1].endsWith('gateway\\index.ts'))) {
  startGateway()
}
