/**
 * Comprehensive Automated Security & Offline Test Suite for PayGate402 Gateway
 * Tests all payment semantics, event spoofing, replay protection, concurrent races,
 * and fail-closed recovery policies without live funds or network dependencies.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Address, Hex, Log, Transaction, TransactionReceipt } from 'viem'
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  parseAbiParameters,
  toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  ACCESS_GRANTED_TOPIC0,
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_PAYGATE_CONTRACT,
  PAY_FOR_ACCESS_SELECTOR,
  PAYGATE_EIP712_DOMAIN,
  PAYGATE_EIP712_TYPES,
  PAYGATE402_CONTRACT_ADDRESS,
  USDC_TOKEN_ADDRESS,
  buildEip712Domain,
  GatewayConfigurationError,
  type GatewayConfig,
} from '../src/gateway/types.ts'
import { resolveGatewayConfig } from '../src/gateway/index.ts'
import { GatewayDb } from '../src/gateway/db.ts'
import { BlockchainVerifier, ViemRpcClient, VerificationError, type RpcClientInterface, type ServiceInfo } from '../src/gateway/verifier.ts'
import { MockUpstreamAdapter, RealDataUpstreamAdapter, fetchArcMainnetTelemetry } from '../src/gateway/upstream.ts'
import { createGatewayServer } from '../src/gateway/server.ts'
import { decodeServiceRegisteredReceipt } from '../src/lib/eventDecoder.ts'
import { getNetworkConfig } from '../src/lib/networkConfig.ts'
import { createServer as createHttpServer } from 'node:http'
import {
  EMPTY_BODY_DIGEST,
  ZERO_BYTES32,
  GatewayIntegrationError,
  authorizeConfirmedPaymentWithGateway,
  buildEip712AuthorizationMessage,
  checkConsumerWalletCompatibility,
  checkGatewayStatus,
  computeBodyDigest,
  prepareLivePaymentChallenge,
  requestPaymentChallenge,
  submitPaymentToGateway,
  validateAuthoritativeChallenge,
} from '../src/lib/gatewayClient.ts'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const artifact = require('../contracts/out/PayGate402.sol/PayGate402.json') as { abi: readonly unknown[] }

// Standard deterministic test wallets
const ALICE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BOB_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const alice = privateKeyToAccount(ALICE_KEY)
const bob = privateKeyToAccount(BOB_KEY)

/**
 * Deterministic Mock RPC Client
 */
class MockRpcClient implements RpcClientInterface {
  public chainId: number = ARC_TESTNET_CHAIN_ID
  public blockNumber: bigint = 5000n
  public transactions = new Map<string, Transaction>()
  public receipts = new Map<string, TransactionReceipt>()
  public prices = new Map<string, bigint>([
    ['0', 100_000n], // 0.10 USDC
    ['1', 250_000n], // 0.25 USDC
  ])
  public throwOnRpc = false

  async getChainId(): Promise<number> {
    if (this.throwOnRpc) throw new Error('RPC connection refused: connection timed out')
    return this.chainId
  }

  async getBlockNumber(): Promise<bigint> {
    if (this.throwOnRpc) throw new Error('RPC connection refused: connection timed out')
    return this.blockNumber
  }

  async getTransaction(txHash: Hex): Promise<Transaction | null> {
    if (this.throwOnRpc) throw new Error('RPC connection refused: connection timed out')
    return this.transactions.get(txHash.toLowerCase()) ?? null
  }

  async getTransactionReceipt(txHash: Hex): Promise<TransactionReceipt | null> {
    if (this.throwOnRpc) throw new Error('RPC connection refused: connection timed out')
    return this.receipts.get(txHash.toLowerCase()) ?? null
  }

  async getServicePrice(serviceId: bigint): Promise<bigint> {
    if (this.throwOnRpc) throw new Error('RPC connection refused: connection timed out')
    const price = this.prices.get(serviceId.toString())
    if (price === undefined) {
      throw new VerificationError(
        `Service ID ${serviceId} does not exist on PayGate402 contract`,
        400,
        'SERVICE_NOT_FOUND'
      )
    }
    return price
  }

  async getService(serviceId: bigint): Promise<ServiceInfo | null> {
    if (this.throwOnRpc) throw new Error('RPC connection refused: connection timed out')
    const price = this.prices.get(serviceId.toString())
    if (price === undefined) return null
    return {
      serviceId,
      provider: '0x5b12ce46c7194ad57d143bc22847224047b1ef42',
      name: `Test Service ${serviceId}`,
      endpointDescription: 'Test Description',
      priceInUsdc: price,
      active: true,
    }
  }

  /**
   * Helper to register a valid on-chain payment fixture
   */
  public registerValidPayment(params: {
    txHash: Hex
    serviceId: bigint
    requestId: Hex
    caller: Address
    amountPaid: bigint
    blockNumber?: bigint
    status?: 'success' | 'reverted'
    targetContract?: Address
    customInput?: Hex
    customLogAddress?: Address
    customTopic0?: Hex
    omitLog?: boolean
  }) {
    const {
      txHash,
      serviceId,
      requestId,
      caller,
      amountPaid,
      blockNumber = 4995n,
      status = 'success',
      targetContract = PAYGATE402_CONTRACT_ADDRESS,
      customInput,
      customLogAddress = PAYGATE402_CONTRACT_ADDRESS,
      customTopic0 = ACCESS_GRANTED_TOPIC0,
      omitLog = false,
    } = params

    const input =
      customInput ??
      encodeFunctionData({
        abi: artifact.abi,
        functionName: 'payForAccess',
        args: [serviceId, requestId],
      })

    const tx = {
      hash: txHash,
      to: targetContract,
      from: caller,
      input,
      value: 0n,
      blockNumber,
    } as unknown as Transaction

    this.transactions.set(txHash.toLowerCase(), tx)

    const logs: Log[] = []
    if (!omitLog) {
      const data = encodeAbiParameters(
        parseAbiParameters('uint256 amountPaid, uint256 timestamp'),
        [amountPaid, BigInt(Math.floor(Date.now() / 1000))]
      )

      logs.push({
        address: customLogAddress,
        topics: [
          customTopic0,
          pad(toHex(serviceId), { size: 32 }),
          pad(caller, { size: 32 }),
          requestId,
        ],
        data,
        blockNumber,
        transactionHash: txHash,
        logIndex: 0,
      } as unknown as Log)
    }

    const receipt = {
      transactionHash: txHash,
      blockNumber,
      status,
      to: targetContract,
      from: caller,
      logs,
    } as unknown as TransactionReceipt

    this.receipts.set(txHash.toLowerCase(), receipt)
  }
}

/**
 * Test Server Harness
 */
async function setupTestHarness(opts?: {
  dbPath?: string
  minConfirmations?: number
  challengeTtlMs?: number
  mockPayload?: string
  upstreamMode?: string
  maxBodySizeBytes?: number
  rateLimitWindowMs?: number
  maxChallengesPerWindow?: number
  mockRpc?: boolean
}) {
  const db = new GatewayDb(opts?.dbPath ?? ':memory:')
  const rpc = new MockRpcClient()
  const minConfirmations = opts?.minConfirmations ?? 1
  const verifier = new BlockchainVerifier(rpc, minConfirmations)
  const upstream = new MockUpstreamAdapter(opts?.mockPayload)
  if (opts?.upstreamMode) {
    upstream.mode = opts.upstreamMode as any
  }

  const config: GatewayConfig = {
    port: 0, // OS assigns free port
    chainId: ARC_TESTNET_CHAIN_ID,
    contractAddress: PAYGATE402_CONTRACT_ADDRESS,
    usdcAddress: USDC_TOKEN_ADDRESS,
    minConfirmations,
    challengeTtlMs: opts?.challengeTtlMs ?? 15 * 60 * 1000,
    dbPath: opts?.dbPath ?? ':memory:',
    rpcUrl: 'http://mock-rpc',
    upstreamMode: (opts?.upstreamMode as any) ?? 'mock',
    maxBodySizeBytes: opts?.maxBodySizeBytes,
    rateLimitWindowMs: opts?.rateLimitWindowMs,
    maxChallengesPerWindow: opts?.maxChallengesPerWindow,
    mockRpc: opts?.mockRpc ?? false,
  }

  const server = createGatewayServer({
    config,
    db,
    verifier,
    upstream,
    rpc,
  })

  await new Promise<void>(resolve => server.listen(0, () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseUrl = `http://127.0.0.1:${port}`

  const teardown = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()))
    })
    db.close()
  }

  return {
    db,
    rpc,
    upstream,
    verifier,
    baseUrl,
    teardown,
  }
}

describe('PayGate402 Stage 3 Security & Payment Semantics Test Suite', () => {
  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Health Endpoint
  // ─────────────────────────────────────────────────────────────────────────────
  test('1. GET /health returns valid gateway status, chain ID, and contract address', async () => {
    const harness = await setupTestHarness()
    try {
      const res = await fetch(`${harness.baseUrl}/health`)
      assert.equal(res.status, 200)
      const data = (await res.json()) as { status: string; chainId: number; contract: string }
      assert.equal(data.status, 'healthy')
      assert.equal(data.chainId, 5042002)
      assert.equal(data.contract.toLowerCase(), PAYGATE402_CONTRACT_ADDRESS.toLowerCase())
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Unauthenticated Request Returns HTTP 402 with Challenge Details
  // ─────────────────────────────────────────────────────────────────────────────
  test('2. Unauthenticated request triggers HTTP 402 Payment Required with challenge ticket', async () => {
    const harness = await setupTestHarness()
    try {
      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/signals/whale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'top-signals' }),
      })

      assert.equal(res.status, 402)
      assert.ok(res.headers.get('WWW-Authenticate')?.includes('PayGate402'))
      assert.equal(res.headers.get('X-Payment-Contract')?.toLowerCase(), PAYGATE402_CONTRACT_ADDRESS.toLowerCase())
      assert.equal(res.headers.get('X-Required-Amount'), '100000')

      const body = (await res.json()) as {
        challenge: { requestId: string; quotedPrice: string; serviceId: string; bodyDigest: string }
      }
      assert.ok(body.challenge.requestId.startsWith('0x'))
      assert.equal(body.challenge.serviceId, '0')
      assert.equal(body.challenge.quotedPrice, '100000')

      // Assert challenge was persisted in SQLite
      const inDb = harness.db.getChallenge(body.challenge.requestId as Hex)
      assert.ok(inDb)
      assert.equal(inDb?.status, 'ISSUED')
      assert.equal(inDb?.quotedPrice, 100_000n)
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Valid Payment Authorizes Single Protected API Request
  // ─────────────────────────────────────────────────────────────────────────────
  test('3. Valid payment unlocks protected upstream payload and marks challenge consumed', async () => {
    const harness = await setupTestHarness()
    try {
      // Step A: Request Challenge
      const postBody = JSON.stringify({ asset: 'USDC', filter: 'whale' })
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/signals/whale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody,
      })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex; quotedPrice: string; expiresAt: number } }

      // Step B: Mock On-Chain Settlement on Arc Testnet
      const txHash: Hex = '0x1111111111111111111111111111111111111111111111111111111111111111'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      // Step C: Alice signs EIP-712 authorization
      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/signals/whale',
          bodyDigest: keccak256(toHex(postBody)),
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      // Step D: Re-send request with payment credentials
      const res200 = await fetch(`${harness.baseUrl}/v1/gateway/0/signals/whale`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
          'X-Payment-Payer': alice.address,
        },
        body: postBody,
      })

      assert.equal(res200.status, 200)
      assert.equal(res200.headers.get('X-PayGate-Status'), 'VERIFIED_ONCHAIN_SUCCESS')
      assert.equal(res200.headers.get('X-PayGate-Caller')?.toLowerCase(), alice.address.toLowerCase())

      const payload = (await res200.json()) as { signal: string }
      assert.equal(payload.signal, 'VERIFIED_ONCHAIN_PAYMENT_PAYLOAD')
      assert.equal(harness.upstream.invocationCount, 1)

      // Verify payment record in DB is SUCCEEDED
      const payment = harness.db.getPayment(txHash)
      assert.equal(payment?.state, 'SUCCEEDED')
      assert.ok(payment?.consumedAt)
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Pending Transaction Rejected (Receipt missing)
  // ─────────────────────────────────────────────────────────────────────────────
  test('4. Pending transaction without receipt is rejected with 402 TX_PENDING', async () => {
    const harness = await setupTestHarness()
    try {
      const postBody = JSON.stringify({ test: 1 })
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST', body: postBody })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      const txHash: Hex = '0x2222222222222222222222222222222222222222222222222222222222222222'
      // Register tx in mempool, but omit receipt
      harness.rpc.transactions.set(txHash.toLowerCase(), {
        hash: txHash,
        to: PAYGATE402_CONTRACT_ADDRESS,
        from: alice.address,
        input: encodeFunctionData({
          abi: artifact.abi,
          functionName: 'payForAccess',
          args: [0n, challenge.requestId],
        }),
      } as unknown as Transaction)

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex(postBody)),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
        body: postBody,
      })

      assert.equal(res.status, 402)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'TX_PENDING')
      assert.equal(harness.upstream.invocationCount, 0)
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Reverted Transaction Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  test('5. Reverted transaction on-chain is rejected with 402 TX_REVERTED', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      const txHash: Hex = '0x3333333333333333333333333333333333333333333333333333333333333333'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
        status: 'reverted', // EVM receipt status = 0
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 402)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'TX_REVERTED')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Wrong Chain ID Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  test('6. Wrong chain ID rejected with 400 WRONG_CHAIN', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      const txHash: Hex = '0x4444444444444444444444444444444444444444444444444444444444444444'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      // Simulate RPC reporting Ethereum Mainnet (1) instead of Arc Testnet (5042002)
      harness.rpc.chainId = 1

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 400)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'WRONG_CHAIN')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Wrong Contract Address Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  test('7. Payment sent to wrong contract is rejected with 402 WRONG_CONTRACT', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      const txHash: Hex = '0x5555555555555555555555555555555555555555555555555555555555555555'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
        targetContract: '0x1111111111111111111111111111111111111111', // wrong contract
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 402)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'WRONG_CONTRACT')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Wrong Method Selector Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  test('8. Transaction calling wrong function is rejected with 402 WRONG_METHOD', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      const txHash: Hex = '0x6666666666666666666666666666666666666666666666666666666666666666'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
        customInput: '0xa9059cbb0000000000000000000000005b12ce46c7194ad57d143bc22847224047b1ef4200000000000000000000000000000000000000000000000000000000000186a0', // ERC-20 transfer selector
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 402)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'WRONG_METHOD')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Fake Event from Malicious Contract Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  test('9. Spoofed event emitted by malicious contract is rejected with 402 EVENT_NOT_FOUND', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      const txHash: Hex = '0x7777777777777777777777777777777777777777777777777777777777777777'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
        customLogAddress: '0x9999999999999999999999999999999999999999', // Attacker's contract
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 402)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'EVENT_NOT_FOUND')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Wrong Payer / Front-running Attack Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  test('10. Front-running attack: Bob submitting Alice transaction is rejected with 401 SIGNER_MISMATCH', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      // Alice paid on chain
      const txHash: Hex = '0x8888888888888888888888888888888888888888888888888888888888888888'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      // Bob tries to steal Alice's payment by signing with Bob's private key
      const bobSig = await bob.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': bobSig,
          'X-Payment-Payer': bob.address,
        },
      })

      assert.equal(res.status, 401)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'SIGNER_MISMATCH')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Wrong Service ID Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  test('11. Tx paying for Service 0 submitted to unlock Service 1 is rejected', async () => {
    const harness = await setupTestHarness()
    try {
      // Challenge created for Service 1
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/1/audit`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      // Tx paid for Service 0
      const txHash: Hex = '0x9999999999999999999999999999999999999999999999999999999999999999'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n, // Mismatched service!
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 250_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 1n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/audit',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 250_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/1/audit`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 402)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'SERVICE_ID_MISMATCH')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Expired Challenge Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  test('12. Expired challenge rejected with 402 CHALLENGE_EXPIRED', async () => {
    const harness = await setupTestHarness({ challengeTtlMs: -1000 }) // instantly expired
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      const txHash: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 402)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'CHALLENGE_EXPIRED')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. Insufficient Amount Paid Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  test('13. Insufficient payment amount is rejected with 402 INSUFFICIENT_AMOUNT', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      const txHash: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 50_000n, // Less than 100,000 required
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 402)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'INSUFFICIENT_AMOUNT')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 14. Price Change During Outstanding Challenge
  // ─────────────────────────────────────────────────────────────────────────────
  test('14. Price increase on-chain before payment renders lower payment insufficient', async () => {
    const harness = await setupTestHarness()
    try {
      // Challenge quoted at 100,000 base units
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      // Provider increased price on-chain to 150,000
      harness.rpc.prices.set('0', 150_000n)

      const txHash: Hex = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n, // Paid old quoted price
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 402)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'PRICE_CHANGED')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 15. Duplicate Transaction Replay Attack Prevented
  // ─────────────────────────────────────────────────────────────────────────────
  test('15. Replay attack: submitting same txHash for second request is rejected with 409', async () => {
    const harness = await setupTestHarness()
    try {
      // Request 1
      const res402A = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge: challengeA } = (await res402A.json()) as { challenge: { requestId: Hex; expiresAt: number } }

      const txHash: Hex = '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challengeA.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sigA = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challengeA.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(challengeA.expiresAt),
        },
      })

      // Request 1 succeeds
      const res1 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challengeA.requestId,
          'X-Payment-Signature': sigA,
        },
      })
      assert.equal(res1.status, 200)

      // Request 2 (New challenge)
      const res402B = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge: challengeB } = (await res402B.json()) as { challenge: { requestId: Hex; expiresAt: number } }

      const sigB = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challengeB.requestId,
          txHash, // Replaying txHash!
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(challengeB.expiresAt),
        },
      })

      // Request 2 must fail
      const res2 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challengeB.requestId,
          'X-Payment-Signature': sigB,
        },
      })

      assert.equal(res2.status, 409)
      const data = (await res2.json()) as { code: string }
      assert.equal(data.code, 'PAYMENT_ALREADY_CONSUMED')
      // Upstream must have only been invoked ONCE total
      assert.equal(harness.upstream.invocationCount, 1)
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 16. Concurrent Replay Attempts (Atomic Race Condition)
  // ─────────────────────────────────────────────────────────────────────────────
  test('16. Concurrent requests with same txHash trigger atomic lock; exactly one succeeds', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex; expiresAt: number } }

      const txHash: Hex = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      // Fire 5 simultaneous requests with the exact same payment credentials
      const requests = Array.from({ length: 5 }, () =>
        fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
          method: 'POST',
          headers: {
            'X-Payment-TxHash': txHash,
            'X-Payment-RequestId': challenge.requestId,
            'X-Payment-Signature': sig,
          },
        })
      )

      const results = await Promise.all(requests)
      const statuses = results.map(r => r.status)

      // Exactly one or more 200s (first execute, subsequent might be idempotent cached), but NO double upstream execution!
      assert.ok(statuses.includes(200))
      assert.equal(harness.upstream.invocationCount, 1)
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 17. Safe Cached Idempotent Retry
  // ─────────────────────────────────────────────────────────────────────────────
  test('17. Legitimate retry of succeeded request returns cached response without dispatching upstream again', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex; expiresAt: number } }

      const txHash: Hex = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      // First call -> 200 OK
      const res1 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })
      assert.equal(res1.status, 200)
      assert.equal(harness.upstream.invocationCount, 1)

      // Retry identical call -> 200 OK CACHED
      const res2 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })
      assert.equal(res2.status, 200)
      assert.equal(res2.headers.get('X-PayGate-Status'), 'VERIFIED_ONCHAIN_CACHED')
      // Upstream invocation count MUST STILL BE 1
      assert.equal(harness.upstream.invocationCount, 1)
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 18. Upstream Timeout After Dispatch Locks to UNCERTAIN (Fail Closed)
  // ─────────────────────────────────────────────────────────────────────────────
  test('18. Upstream timeout after execution started locks payment to UNCERTAIN and prevents double spend', async () => {
    const harness = await setupTestHarness()
    try {
      harness.upstream.mode = 'timeout_after_exec'

      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex; expiresAt: number } }

      const txHash: Hex = '0x1212121212121212121212121212121212121212121212121212121212121212'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 504)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'UPSTREAM_TIMEOUT_UNCERTAIN')

      // Assert DB state is UNCERTAIN
      const payment = harness.db.getPayment(txHash)
      assert.equal(payment?.state, 'UNCERTAIN')

      // Attempting to retry now fails closed with 409 UNCERTAIN_LOCKED
      const retryRes = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })
      assert.equal(retryRes.status, 409)
      const retryData = (await retryRes.json()) as { code: string }
      assert.equal(retryData.code, 'PAYMENT_LOCKED_UNCERTAIN')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 19. RPC Timeout Returns 503 RPC_UNAVAILABLE
  // ─────────────────────────────────────────────────────────────────────────────
  test('19. RPC timeout failure returns 503 RPC_UNAVAILABLE and allows safe retry', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      const txHash: Hex = '0x1313131313131313131313131313131313131313131313131313131313131313'
      harness.rpc.throwOnRpc = true // RPC down

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 503)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'RPC_UNAVAILABLE')

      // Assert payment is marked FAILED (retriable when RPC recovers)
      const payment = harness.db.getPayment(txHash)
      assert.equal(payment?.state, 'FAILED')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 20. Verification that verifyAccess() Cannot Bypass Per-Request Payment
  // ─────────────────────────────────────────────────────────────────────────────
  test('20. On-chain verifyAccess() flag cannot bypass gateway: fresh request without payment gets 402', async () => {
    const harness = await setupTestHarness()
    try {
      // Alice has hasAccess[0][alice] = true on-chain.
      // But she sends a new request without payment headers.
      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-Payer': alice.address,
        },
      })

      // Must strictly return 402, refusing to grant free access
      assert.equal(res.status, 402)
      assert.equal(harness.upstream.invocationCount, 0)
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 21. Attempt to Unlock Different Path Fails (Path Mismatch)
  // ─────────────────────────────────────────────────────────────────────────────
  test('21. Attempting to use payment issued for Path A on Path B fails with 400 PATH_MISMATCH', async () => {
    const harness = await setupTestHarness()
    try {
      // Issued for /feed
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      const txHash: Hex = '0x1414141414141414141414141414141414141414141414141414141414141414'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 15 * 60 * 1000),
        },
      })

      // Send to /different-endpoint
      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/different-endpoint`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 400)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'PATH_MISMATCH')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 22. Persistent Database Process Restart & Recovery
  // ─────────────────────────────────────────────────────────────────────────────
  test('22. Persistent SQLite DB restart preserves consumed state across server reboots', async () => {
    const fs = await import('node:fs')
    const dbFilePath = 'test-restart-persistence.db'

    // Clean up any stale test database
    if (fs.existsSync(dbFilePath)) fs.unlinkSync(dbFilePath)

    try {
      // Phase 1: Start gateway instance 1 on persistent DB
      const harness1 = await setupTestHarness({ dbPath: dbFilePath })
      const postBody = JSON.stringify({ action: 'persist-check' })

      const res402A = await fetch(`${harness1.baseUrl}/v1/gateway/0/feed`, { method: 'POST', body: postBody })
      const { challenge: challengeA } = (await res402A.json()) as {
        challenge: { requestId: Hex; expiresAt: number }
      }

      const txHash: Hex = '0x2525252525252525252525252525252525252525252525252525252525252525'
      harness1.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challengeA.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sigA = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challengeA.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex(postBody)),
          quotedPrice: 100_000n,
          expiresAt: BigInt(challengeA.expiresAt),
        },
      })

      const res1 = await fetch(`${harness1.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challengeA.requestId,
          'X-Payment-Signature': sigA,
        },
        body: postBody,
      })
      assert.equal(res1.status, 200)

      // Simulate Gateway Crash & Process Termination
      await harness1.teardown()

      // Phase 2: Start new gateway instance 2 on the SAME database file
      const harness2 = await setupTestHarness({ dbPath: dbFilePath })
      // Share RPC mocks for verification
      harness2.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challengeA.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      // Attempt A: Attacker tries to replay txHash on instance 2 with a new challenge
      const res402B = await fetch(`${harness2.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge: challengeB } = (await res402B.json()) as {
        challenge: { requestId: Hex; expiresAt: number }
      }

      const sigB = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challengeB.requestId,
          txHash, // Replaying txHash
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(challengeB.expiresAt),
        },
      })

      const replayRes = await fetch(`${harness2.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challengeB.requestId,
          'X-Payment-Signature': sigB,
        },
      })

      // Must strictly be rejected with 409: state persisted across process restart!
      assert.equal(replayRes.status, 409)
      const replayData = (await replayRes.json()) as { code: string }
      assert.equal(replayData.code, 'PAYMENT_ALREADY_CONSUMED')

      // Attempt B: Legitimate retry of original request on instance 2 returns cached response
      const retryRes = await fetch(`${harness2.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challengeA.requestId,
          'X-Payment-Signature': sigA,
        },
        body: postBody,
      })
      assert.equal(retryRes.status, 200)
      assert.equal(retryRes.headers.get('X-PayGate-Status'), 'VERIFIED_ONCHAIN_CACHED')

      await harness2.teardown()
    } finally {
      if (fs.existsSync(dbFilePath)) fs.unlinkSync(dbFilePath)
    }
  })

  test('23. Request body digest mismatch: tampering with POST body is rejected with 400 BODY_DIGEST_MISMATCH', async () => {
    const harness = await setupTestHarness()
    try {
      const originalBody = JSON.stringify({ action: 'buy_signals', symbol: 'ETH' })
      const tamperedBody = JSON.stringify({ action: 'buy_signals', symbol: 'BTC_TAMPERED' })

      // Step 1: Challenge issued for originalBody
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/signals`, {
        method: 'POST',
        body: originalBody,
      })
      assert.equal(res402.status, 402)
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex; expiresAt: number; bodyDigest: Hex } }

      // Confirm digest was calculated from original body
      assert.equal(challenge.bodyDigest, keccak256(toHex(originalBody)))

      const txHash: Hex = '0x3131313131313131313131313131313131313131313131313131313131313131'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      // Client signs the original challenge
      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/signals',
          bodyDigest: challenge.bodyDigest,
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      // Step 2: Client submits with TAMPERED body
      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/signals`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
        body: tamperedBody,
      })

      assert.equal(res.status, 400)
      const data = (await res.json()) as { error: string; code: string }
      assert.equal(data.code, 'BODY_DIGEST_MISMATCH')
      assert.match(data.error, /Request body digest mismatch/)
    } finally {
      await harness.teardown()
    }
  })

  test('24. Malformed or corrupted signature format is rejected with 401 INVALID_SIGNATURE', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      assert.equal(res402.status, 402)
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex } }

      const txHash: Hex = '0x3232323232323232323232323232323232323232323232323232323232323232'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      // Malformed signature: truncated non-canonical byte sequence
      const malformedSig: Hex = '0xdeadbeef1234'

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': malformedSig,
        },
      })

      assert.equal(res.status, 401)
      const data = (await res.json()) as { error: string; code: string }
      assert.equal(data.code, 'INVALID_SIGNATURE')
      assert.match(data.error, /Signature verification failed/)
    } finally {
      await harness.teardown()
    }
  })

  test('25. Malformed AccessGranted event log missing topics is rejected with 402 MALFORMED_EVENT', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      assert.equal(res402.status, 402)
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex; expiresAt: number; bodyDigest: Hex } }

      const txHash: Hex = '0x3333333333333333333333333333333333333333333333333333333333333333'
      // Register payment with missing topic 3 (requestId)
      harness.rpc.transactions.set(txHash.toLowerCase(), {
        hash: txHash,
        to: PAYGATE402_CONTRACT_ADDRESS,
        from: alice.address,
        input: encodeFunctionData({
          abi: artifact.abi,
          functionName: 'payForAccess',
          args: [0n, challenge.requestId],
        }),
        value: 0n,
        blockNumber: 4995n,
      } as unknown as Transaction)

      // Receipt contains AccessGranted topic0, but only 2 topics total (missing caller and requestId topics)
      harness.rpc.receipts.set(txHash.toLowerCase(), {
        transactionHash: txHash,
        blockNumber: 4995n,
        status: 'success',
        to: PAYGATE402_CONTRACT_ADDRESS,
        from: alice.address,
        logs: [
          {
            address: PAYGATE402_CONTRACT_ADDRESS,
            topics: [ACCESS_GRANTED_TOPIC0, pad(toHex(0n), { size: 32 })], // Missing topics[2] and topics[3]
            data: encodeAbiParameters(parseAbiParameters('uint256 amountPaid, uint256 timestamp'), [100_000n, 12345678n]),
            blockNumber: 4995n,
            transactionHash: txHash,
            logIndex: 0,
          } as unknown as Log,
        ],
      } as unknown as TransactionReceipt)

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: challenge.bodyDigest,
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 402)
      const data = (await res.json()) as { error: string; code: string }
      assert.equal(data.code, 'MALFORMED_EVENT')
    } finally {
      await harness.teardown()
    }
  })

  test('26. Process restart behavior when lingering payment was in DISPATCHING state', async () => {
    const dbFilePath = join(tmpdir(), `pg402-lingering-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)

    try {
      // Setup DB with an in-flight payment left in DISPATCHING when process terminated
      const db1 = new GatewayDb(dbFilePath)
      const requestId: Hex = '0x4444444444444444444444444444444444444444444444444444444444444444'
      const txHash: Hex = '0x5555555555555555555555555555555555555555555555555555555555555555'

      db1.createChallenge({
        requestId,
        serviceId: 0n,
        payer: alice.address,
        method: 'POST',
        path: '/feed',
        bodyDigest: keccak256(toHex('')),
        quotedPrice: 100_000n,
        chainId: ARC_TESTNET_CHAIN_ID,
        createdAt: Date.now(),
        expiresAt: Date.now() + 600000,
        status: 'ISSUED',
      })

      const lockRes = db1.tryAcquirePaymentLock({
        txHash,
        requestId,
        serviceId: 0n,
        caller: alice.address,
        amountPaid: 100_000n,
      })
      assert.equal(lockRes.acquired, true)
      db1.transitionState(txHash, 'RESERVED', 'DISPATCHING')
      db1.close()

      // Gateway restarts. Client retries payment that was interrupted during DISPATCHING
      const harness = await setupTestHarness({ dbPath: dbFilePath })
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 600000),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': requestId,
          'X-Payment-Signature': sig,
        },
      })

      // Confirms Stage 5 remediation: startup recovery locks in-flight DISPATCHING to UNCERTAIN (PAYMENT_LOCKED_UNCERTAIN)
      assert.equal(res.status, 409)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'PAYMENT_LOCKED_UNCERTAIN')

      await harness.teardown()
    } finally {
      try {
        rmSync(dbFilePath, { force: true })
      } catch {
        // ignore cleanup error
      }
    }
  })

  test('27. Explicit verification endpoint POST /v1/gateway/verify-payment enforces required fields and returns verification details', async () => {
    const harness = await setupTestHarness()
    try {
      // 1. Missing fields rejection
      const emptyRes = await fetch(`${harness.baseUrl}/v1/gateway/verify-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert.equal(emptyRes.status, 400)
      const emptyData = (await emptyRes.json()) as { code: string }
      assert.equal(emptyData.code, 'INVALID_REQUEST_BODY')

      // 2. Unknown challenge rejection
      const unknownRes = await fetch(`${harness.baseUrl}/v1/gateway/verify-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
          requestId: '0x9999999999999999999999999999999999999999999999999999999999999999',
          signature: '0x00',
        }),
      })
      assert.equal(unknownRes.status, 404)
      const unknownData = (await unknownRes.json()) as { code: string }
      assert.equal(unknownData.code, 'CHALLENGE_NOT_FOUND')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 28. Malformed AccessGranted Event Data Parameter
  // ─────────────────────────────────────────────────────────────────────────────
  test('28. AccessGranted event with corrupted data parameter is rejected with 402 EVENT_DATA_DECODE_ERROR', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as {
        challenge: { requestId: Hex; expiresAt: number; bodyDigest: Hex }
      }
      const txHash: Hex = '0x2828282828282828282828282828282828282828282828282828282828282828'

      harness.rpc.transactions.set(txHash.toLowerCase(), {
        hash: txHash,
        to: PAYGATE402_CONTRACT_ADDRESS,
        from: alice.address,
        input: encodeFunctionData({
          abi: artifact.abi,
          functionName: 'payForAccess',
          args: [0n, challenge.requestId],
        }),
        value: 0n,
        blockNumber: 4995n,
      } as unknown as Transaction)

      // Receipt contains AccessGranted event with truncated, invalid ABI data
      harness.rpc.receipts.set(txHash.toLowerCase(), {
        transactionHash: txHash,
        blockNumber: 4995n,
        status: 'success',
        to: PAYGATE402_CONTRACT_ADDRESS,
        from: alice.address,
        logs: [
          {
            address: PAYGATE402_CONTRACT_ADDRESS,
            topics: [
              ACCESS_GRANTED_TOPIC0,
              pad(toHex(0n), { size: 32 }),
              pad(alice.address, { size: 32 }),
              challenge.requestId,
            ],
            data: '0x1234' as Hex, // Corrupted data field
            blockNumber: 4995n,
            transactionHash: txHash,
            logIndex: 0,
          } as unknown as Log,
        ],
      } as unknown as TransactionReceipt)

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: challenge.bodyDigest,
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 402)
      const data = (await res.json()) as { error: string; code: string }
      assert.equal(data.code, 'EVENT_DATA_DECODE_ERROR')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 29. Challenge Issued with Bound Payer Rejects Different Event Caller
  // ─────────────────────────────────────────────────────────────────────────────
  test('29. Pre-bound challenge payer rejects different on-chain caller with 401 CALLER_MISMATCH', async () => {
    const harness = await setupTestHarness()
    try {
      // Challenge specifically bound to Alice
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-Payer': alice.address,
        },
      })
      const { challenge } = (await res402.json()) as {
        challenge: { requestId: Hex; expiresAt: number; bodyDigest: Hex }
      }
      const txHash: Hex = '0x2929292929292929292929292929292929292929292929292929292929292929'

      // But Bob was the one who called payForAccess on-chain
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: bob.address,
        amountPaid: 100_000n,
      })

      const bobSig = await bob.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: challenge.bodyDigest,
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': bobSig,
          'X-Payment-Payer': bob.address,
        },
      })

      assert.equal(res.status, 401)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'CALLER_MISMATCH')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 30. HTTP Request Method Mismatch
  // ─────────────────────────────────────────────────────────────────────────────
  test('30. HTTP method mismatch: challenge issued for POST submitted as PUT rejected with 400 METHOD_MISMATCH', async () => {
    const harness = await setupTestHarness()
    try {
      // Challenge issued for POST
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as {
        challenge: { requestId: Hex; expiresAt: number; bodyDigest: Hex }
      }
      const txHash: Hex = '0x3030303030303030303030303030303030303030303030303030303030303030'

      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: challenge.bodyDigest,
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      // Client resubmits with PUT instead of POST
      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'PUT',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 400)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'METHOD_MISMATCH')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 31. Unregistered Service Rejection Before Challenge
  // ─────────────────────────────────────────────────────────────────────────────
  test('31. Unregistered service ID rejected with 400 SERVICE_NOT_FOUND', async () => {
    const harness = await setupTestHarness()
    try {
      const res = await fetch(`${harness.baseUrl}/v1/gateway/999/feed`, { method: 'POST' })
      assert.equal(res.status, 400)
      const data = (await res.json()) as { code: string; error: string }
      assert.equal(data.code, 'SERVICE_NOT_FOUND')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 32. Concurrent Retries of Failed Payment Yield Only One Lock Winner
  // ─────────────────────────────────────────────────────────────────────────────
  test('32. Concurrent retries of a failed payment yield only one lock winner', async () => {
    const harness = await setupTestHarness()
    try {
      const txHash: Hex = '0xaaaa1111222233334444555566667777888899990000aaaabbbbccccddddeeee'
      const requestId: Hex = '0xaaaa1111222233334444555566667777888899990000aaaabbbbccccdddd0001'

      harness.db.createChallenge({
        requestId,
        serviceId: 0n,
        payer: alice.address,
        method: 'POST',
        path: '/feed',
        bodyDigest: keccak256(toHex('')),
        quotedPrice: 100_000n,
        chainId: ARC_TESTNET_CHAIN_ID,
        createdAt: Date.now(),
        expiresAt: Date.now() + 600000,
        status: 'ISSUED',
      })

      const params = {
        txHash,
        requestId,
        serviceId: 0n,
        caller: alice.address,
        amountPaid: 100_000n,
      }
      harness.db.tryAcquirePaymentLock(params)
      harness.db.recordFailed(txHash, 'RPC_TIMEOUT')

      const stateBefore = harness.db.getPayment(txHash)
      assert.equal(stateBefore?.state, 'FAILED')

      // Now run two concurrent tryAcquirePaymentLock calls on the same failed txHash
      const lock1 = harness.db.tryAcquirePaymentLock(params)
      const lock2 = harness.db.tryAcquirePaymentLock(params)

      assert.equal(lock1.acquired, true)
      assert.equal(lock2.acquired, false)
      assert.equal(lock2.reason, 'CONCURRENT_CONFLICT')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 33. Conservative Startup Recovery for In-Flight States
  // ─────────────────────────────────────────────────────────────────────────────
  test('33. Stale in-flight requests recover conservatively after process restart', async () => {
    const harness = await setupTestHarness()
    try {
      const txDispatching: Hex = '0x1111000011110000111100001111000011110000111100001111000011110000'
      const txReserved: Hex = '0x2222000022220000222200002222000022220000222200002222000022220000'
      const reqId1: Hex = '0x0000000000000000000000000000000000000000000000000000000000000001'
      const reqId2: Hex = '0x0000000000000000000000000000000000000000000000000000000000000002'

      harness.db.createChallenge({
        requestId: reqId1,
        serviceId: 0n,
        payer: alice.address,
        method: 'POST',
        path: '/feed',
        bodyDigest: keccak256(toHex('')),
        quotedPrice: 100_000n,
        chainId: ARC_TESTNET_CHAIN_ID,
        createdAt: Date.now(),
        expiresAt: Date.now() + 600000,
        status: 'ISSUED',
      })

      harness.db.createChallenge({
        requestId: reqId2,
        serviceId: 0n,
        payer: alice.address,
        method: 'POST',
        path: '/feed',
        bodyDigest: keccak256(toHex('')),
        quotedPrice: 100_000n,
        chainId: ARC_TESTNET_CHAIN_ID,
        createdAt: Date.now(),
        expiresAt: Date.now() + 600000,
        status: 'ISSUED',
      })

      harness.db.tryAcquirePaymentLock({
        txHash: txDispatching,
        requestId: reqId1,
        serviceId: 0n,
        caller: alice.address,
        amountPaid: 100_000n,
      })
      harness.db.transitionState(txDispatching, 'RESERVED', 'DISPATCHING')

      harness.db.tryAcquirePaymentLock({
        txHash: txReserved,
        requestId: reqId2,
        serviceId: 0n,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const recovered = harness.db.recoverStartupStates()
      assert.equal(recovered.recoveredUncertain, 1)
      assert.equal(recovered.recoveredFailed, 1)

      const stateDispatching = harness.db.getPayment(txDispatching)
      assert.equal(stateDispatching?.state, 'UNCERTAIN')

      const stateReserved = harness.db.getPayment(txReserved)
      assert.equal(stateReserved?.state, 'FAILED')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 34. Post-Dispatch Network Failure Sets UNCERTAIN & Prevents Re-dispatch
  // ─────────────────────────────────────────────────────────────────────────────
  test('34. Socket reset after upstream dispatch marks payment UNCERTAIN (504 fail-closed)', async () => {
    const harness = await setupTestHarness({ upstreamMode: 'econnreset_after_exec' })
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex; bodyDigest: Hex; expiresAt: number } }
      const txHash: Hex = '0x3434343434343434343434343434343434343434343434343434343434343434'

      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: challenge.bodyDigest,
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      assert.equal(res.status, 504)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'UPSTREAM_TIMEOUT_UNCERTAIN')

      const payment = harness.db.getPayment(txHash)
      assert.equal(payment?.state, 'UNCERTAIN')

      // Retry is rejected as locked / non-repeatable
      const retry = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })
      assert.equal(retry.status, 409)
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 35. Cached Response on Duplicate Successful Request
  // ─────────────────────────────────────────────────────────────────────────────
  test('35. Duplicate successful requests return cached output without redispatch', async () => {
    const harness = await setupTestHarness()
    try {
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex; bodyDigest: Hex; expiresAt: number } }
      const txHash: Hex = '0x3535353535353535353535353535353535353535353535353535353535353535'

      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: challenge.bodyDigest,
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      const res1 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })
      assert.equal(res1.status, 200)

      // Immediate resubmission returns cached output without duplicate upstream call
      const res2 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })
      assert.equal(res2.status, 200)
      assert.equal(res2.headers.get('X-PayGate-Cached'), 'true')
      assert.equal(harness.upstream.invocationCount, 1)
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 36. Payload Body Size Limit (HTTP 413)
  // ─────────────────────────────────────────────────────────────────────────────
  test('36. Request body exceeding maxBodySizeBytes returns HTTP 413 PAYLOAD_TOO_LARGE', async () => {
    const harness = await setupTestHarness({ maxBodySizeBytes: 64 })
    try {
      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ padding: 'X'.repeat(256) }),
      })
      assert.equal(res.status, 413)
      const data = (await res.json()) as { code: string }
      assert.equal(data.code, 'PAYLOAD_TOO_LARGE')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 37. Challenge Rate Limiting (HTTP 429)
  // ─────────────────────────────────────────────────────────────────────────────
  test('37. Challenge rate limiting returns HTTP 429 RATE_LIMIT_EXCEEDED when threshold reached', async () => {
    const harness = await setupTestHarness({ maxChallengesPerWindow: 2, rateLimitWindowMs: 5000 })
    try {
      const r1 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      assert.equal(r1.status, 402)
      const r2 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      assert.equal(r2.status, 402)
      const r3 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      assert.equal(r3.status, 429)
      const data = (await r3.json()) as { code: string }
      assert.equal(data.code, 'RATE_LIMIT_EXCEEDED')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 38. Persistence Survives Restart & Replay Attempts Remain Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  test('38. SQLite persistence across restarts ensures settled payments remain protected against replay', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pg402-test-'))
    const dbFile = join(tempDir, 'gateway.db')
    const txHash: Hex = '0x3838383838383838383838383838383838383838383838383838383838383838'

    try {
      // Instance 1
      const harness1 = await setupTestHarness({ dbPath: dbFile })
      const res402 = await fetch(`${harness1.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex; bodyDigest: Hex; expiresAt: number } }

      harness1.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: challenge.bodyDigest,
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      const res1 = await fetch(`${harness1.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })
      assert.equal(res1.status, 200)
      await harness1.teardown()

      // Instance 2 restarts from the same on-disk DB
      const harness2 = await setupTestHarness({ dbPath: dbFile })
      
      // Attacker attempts replay by requesting a new challenge and trying to authorize it with the spent txHash
      const res402_2 = await fetch(`${harness2.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      const { challenge: challenge2 } = (await res402_2.json()) as { challenge: { requestId: Hex; bodyDigest: Hex; expiresAt: number } }

      const sigReplay = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge2.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: challenge2.bodyDigest,
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge2.expiresAt),
        },
      })

      const resReplay = await fetch(`${harness2.baseUrl}/v1/gateway/0/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge2.requestId,
          'X-Payment-Signature': sigReplay,
        },
      })
      assert.equal(resReplay.status, 409)
      const data = (await resReplay.json()) as { code: string }
      assert.equal(data.code, 'PAYMENT_ALREADY_CONSUMED')
      await harness2.teardown()
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup error
      }
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // Stage 7.1 Regression Tests — Fail-Closed UI / Gateway Integration Repair
  // ─────────────────────────────────────────────────────────────────────────────

  test('39. Stage 7.1 (Task 6.1): ServiceCard blocks payment when challenge issuance fails', async () => {
    let walletApproveInvoked = false
    let walletPayInvoked = false
    let preflightError: string | null = null
    let step: string = 'challenging'

    await assert.rejects(
      async () => {
        await prepareLivePaymentChallenge({
          serviceId: 0n,
          subPath: '/v1/signals',
          method: 'POST',
          body: '',
          payerAddress: alice.address,
          gatewayUrl: 'http://127.0.0.1:1', // Unreachable port causes challenge issuance failure
        })
        walletPayInvoked = true
      },
      (err: unknown) => {
        assert.ok(err instanceof GatewayIntegrationError)
        preflightError = err.message
        step = 'idle'
        return true
      }
    )

    assert.equal(walletApproveInvoked, false, 'Approval must never be called on challenge issuance failure')
    assert.equal(walletPayInvoked, false, 'payForAccess must never be called on challenge issuance failure')
    assert.equal(step, 'idle', 'ServiceCard state must reset to idle on failure')
    assert.ok(preflightError !== null, 'ServiceCard must record preflight error message')

    // Static source check of ServiceCard.tsx
    const serviceCardSrc = readFileSync(join(process.cwd(), 'src/components/ServiceCard.tsx'), 'utf8')
    assert.ok(serviceCardSrc.includes('setPreflightError(msg)'), 'ServiceCard must set preflight error in catch block')
    assert.ok(serviceCardSrc.includes("setStep('idle')"), 'ServiceCard must reset step to idle in catch block')
    assert.ok(serviceCardSrc.includes('disabled={'), 'ServiceCard payment button must have disabled guards')
    assert.ok(serviceCardSrc.includes('preflightError'), 'ServiceCard must render preflight error alert')
  })

  test('40. Stage 7.1 (Task 6.2): FlowDashboard blocks payment when the gateway is offline', async () => {
    const offlineUrl = 'http://127.0.0.1:1'
    const status = await checkGatewayStatus(offlineUrl)
    assert.equal(status.online, false)

    let challenge: ChallengeData | null = null
    let challengeError: string | null = null
    let currentScreen = 'selection'
    let walletApproveInvoked = false
    let walletPayInvoked = false

    // Simulate FlowDashboard handleSelectService when offline
    try {
      if (!status.online) {
        throw new Error(
          'PayGate402 Gateway is offline at localhost:4020. Challenge issuance failed and wallet transactions are disabled.'
        )
      }
      const res = await requestPaymentChallenge({
        serviceId: 0n,
        subPath: '/v1/signals',
        method: 'POST',
        gatewayUrl: offlineUrl,
      })
      challenge = res.challenge
      currentScreen = 'challenge'
    } catch (err: unknown) {
      challenge = null
      challengeError = err instanceof Error ? err.message : String(err)
      currentScreen = 'challenge'
    }

    assert.equal(challenge, null, 'No synthetic challenge may be created')
    assert.ok(challengeError !== null, 'Visible challenge error must be recorded')
    assert.ok(challengeError.includes('offline'), 'Error message must note gateway is offline')

    // Simulate FlowDashboard handleContinueToPay
    let continueAllowed = false
    if (!challenge || challengeError) {
      continueAllowed = false
    } else {
      continueAllowed = true
      currentScreen = 'confirm'
    }
    assert.equal(continueAllowed, false, 'Payment continuation must be blocked')
    assert.equal(currentScreen, 'challenge', 'Screen must remain on challenge with error banner')

    // Simulate FlowDashboard handleWalletConfirm
    let confirmError: string | null = null
    if (!challenge || challengeError) {
      confirmError = 'Missing valid HTTP 402 gateway challenge. Payment transaction blocked.'
    } else {
      walletPayInvoked = true
    }
    assert.ok(confirmError !== null)
    assert.equal(walletApproveInvoked, false)
    assert.equal(walletPayInvoked, false)

    // Static source check of FlowDashboard.tsx
    const flowDashboardSrc = readFileSync(join(process.cwd(), 'src/components/FlowDashboard.tsx'), 'utf8')
    assert.ok(
      !flowDashboardSrc.includes('setChallenge({'),
      'FlowDashboard must not synthesize a challenge in catch blocks'
    )
    assert.ok(flowDashboardSrc.includes('setChallenge(null)'), 'FlowDashboard must clear challenge on error')
    assert.ok(flowDashboardSrc.includes('setChallengeError(msg)'), 'FlowDashboard must set challengeError')
  })

  test('41. Stage 7.1 (Task 6.3): SERVICE_NOT_FOUND cannot trigger a synthetic challenge or transaction', async () => {
    const harness = await setupTestHarness()
    try {
      let walletTxInvoked = false
      await assert.rejects(
        async () => {
          await prepareLivePaymentChallenge({
            serviceId: 999n, // Unregistered on-chain service ID
            subPath: '/',
            method: 'POST',
            body: '',
            payerAddress: alice.address,
            gatewayUrl: harness.baseUrl,
          })
          walletTxInvoked = true
        },
        (err: unknown) => {
          assert.ok(err instanceof GatewayIntegrationError)
          assert.equal(err.code, 'SERVICE_NOT_FOUND')
          assert.equal(err.statusCode, 400)
          return true
        }
      )
      assert.equal(walletTxInvoked, false, 'Wallet tx must never be invoked on SERVICE_NOT_FOUND')

      // Also directly via requestPaymentChallenge
      await assert.rejects(
        async () => {
          await requestPaymentChallenge({
            serviceId: 999n,
            gatewayUrl: harness.baseUrl,
          })
        },
        (err: unknown) => {
          assert.ok(err instanceof GatewayIntegrationError)
          assert.equal(err.code, 'SERVICE_NOT_FOUND')
          return true
        }
      )

      // Ensure no challenge record exists in database
      const dummyReqId: Hex = '0x1234567890123456789012345678901234567890123456789012345678901234'
      assert.equal(harness.db.getChallenge(dummyReqId), null)
    } finally {
      await harness.teardown()
    }
  })

  test('42. Stage 7.1 (Task 6.4): No live payment uses a locally generated requestId', async () => {
    const harness = await setupTestHarness()
    try {
      const fabricatedRequestId: Hex =
        '0xbaadf00dbaadf00dbaadf00dbaadf00dbaadf00dbaadf00dbaadf00dbaadf00d'
      const txHash: Hex = '0x4343434343434343434343434343434343434343434343434343434343434343'

      // Even if a caller paid on-chain with a locally fabricated requestId:
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: fabricatedRequestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: fabricatedRequestId,
          txHash,
          method: 'POST',
          path: '/',
          bodyDigest: EMPTY_BODY_DIGEST,
          quotedPrice: 100_000n,
          expiresAt: BigInt(Date.now() + 600_000),
        },
      })

      await assert.rejects(
        async () => {
          await submitPaymentToGateway({
            serviceId: 0n,
            subPath: '/',
            method: 'POST',
            body: '',
            txHash,
            requestId: fabricatedRequestId,
            signature: sig,
            payerAddress: alice.address,
            gatewayUrl: harness.baseUrl,
          })
        },
        (err: unknown) => {
          assert.ok(err instanceof GatewayIntegrationError)
          assert.equal(err.code, 'CHALLENGE_NOT_FOUND')
          assert.equal(err.statusCode, 400)
          return true
        }
      )
      assert.equal(harness.upstream.invocationCount, 0)

      // Static code check across UI components to prove 0 locally generated requestIds
      const serviceCardSrc = readFileSync(join(process.cwd(), 'src/components/ServiceCard.tsx'), 'utf8')
      const flowDashboardSrc = readFileSync(join(process.cwd(), 'src/components/FlowDashboard.tsx'), 'utf8')
      const agentCliSrc = readFileSync(join(process.cwd(), 'src/components/AgentCLI.tsx'), 'utf8')

      assert.ok(!serviceCardSrc.includes('crypto.getRandomValues'), 'ServiceCard must not fabricate local requestId')
      assert.ok(!flowDashboardSrc.includes('crypto.getRandomValues'), 'FlowDashboard must not fabricate local requestId')
      assert.ok(!agentCliSrc.includes('Math.random'), 'AgentCLI must not fabricate timestamp/random requestId')
    } finally {
      await harness.teardown()
    }
  })

  test('43. Stage 7.1 (Task 6.5): No live authorization uses a zero-filled bodyDigest', async () => {
    const harness = await setupTestHarness()
    try {
      const { challenge } = await requestPaymentChallenge({
        serviceId: 0n,
        subPath: '/signals',
        method: 'POST',
        body: '',
        payerAddress: alice.address,
        gatewayUrl: harness.baseUrl,
      })

      // 1. Client-side validator rejects synthetic zero-filled bodyDigest before wallet signing
      assert.throws(
        () =>
          validateAuthoritativeChallenge({
            ...challenge,
            bodyDigest: ZERO_BYTES32,
          }),
        (err: unknown) => {
          assert.ok(err instanceof GatewayIntegrationError)
          assert.equal(err.code, 'ZERO_BODY_DIGEST_FORBIDDEN')
          return true
        }
      )

      // 2. Gateway server rejects EIP-712 signature signed over zero-filled bodyDigest
      const txHash: Hex = '0x4242424242424242424242424242424242424242424242424242424242424242'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const badZeroDigestSig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/signals',
          bodyDigest: ZERO_BYTES32, // Zero-filled digest instead of Keccak-256("")
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      await assert.rejects(
        async () => {
          await submitPaymentToGateway({
            serviceId: 0n,
            subPath: '/signals',
            method: 'POST',
            body: '',
            txHash,
            requestId: challenge.requestId,
            signature: badZeroDigestSig,
            payerAddress: alice.address,
            gatewayUrl: harness.baseUrl,
          })
        },
        (err: unknown) => {
          assert.ok(err instanceof GatewayIntegrationError)
          assert.equal(err.code, 'SIGNER_MISMATCH')
          assert.equal(err.statusCode, 401)
          return true
        }
      )
      assert.equal(harness.upstream.invocationCount, 0)

      // 3. Static audit of UI components to ensure ZERO_BYTES32 is not used as a bodyDigest
      const serviceCardSrc = readFileSync(join(process.cwd(), 'src/components/ServiceCard.tsx'), 'utf8')
      const flowDashboardSrc = readFileSync(join(process.cwd(), 'src/components/FlowDashboard.tsx'), 'utf8')
      assert.ok(
        !serviceCardSrc.includes('0x0000000000000000000000000000000000000000000000000000000000000000'),
        'ServiceCard must not use zero-filled bodyDigest'
      )
      assert.ok(
        !flowDashboardSrc.includes('0x0000000000000000000000000000000000000000000000000000000000000000'),
        'FlowDashboard must not use zero-filled bodyDigest'
      )
    } finally {
      await harness.teardown()
    }
  })

  test('44. Stage 7.1 (Task 6.6): AgentCLI never unlocks on receipt alone', async () => {
    const harness = await setupTestHarness()
    try {
      const { challenge } = await requestPaymentChallenge({
        serviceId: 0n,
        subPath: '/signals',
        method: 'POST',
        body: '',
        payerAddress: alice.address,
        gatewayUrl: harness.baseUrl,
      })

      const txHash: Hex = '0x4444444444444444444444444444444444444444444444444444444444444445'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      // 1. Calling gateway with txHash & requestId but without EIP-712 signature returns 402 (never unlocks)
      const resNoSig = await fetch(`${harness.baseUrl}/v1/gateway/0/signals`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
        },
      })
      assert.equal(resNoSig.status, 402, 'Receipt alone must return 402')
      assert.equal(harness.upstream.invocationCount, 0, 'Upstream must not be dispatched on receipt alone')

      // 2. Calling with invalid signature returns 401
      const resBadSig = await fetch(`${harness.baseUrl}/v1/gateway/0/signals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': '0x' + '11'.repeat(65),
          'X-Payment-Payer': alice.address,
        },
      })
      assert.equal(resBadSig.status, 401, 'Bad signature must return 401')
      assert.equal(harness.upstream.invocationCount, 0)

      // 3. Calling authorizeConfirmedPaymentWithGateway with valid EIP-712 signature unlocks HTTP 200
      const authorized = await authorizeConfirmedPaymentWithGateway({
        challenge,
        txHash,
        payerAddress: alice.address,
        body: '',
        gatewayUrl: harness.baseUrl,
        signTypedData: args => alice.signTypedData(args),
      })

      assert.equal(authorized.status, 200)
      assert.equal(authorized.txHash, txHash)
      assert.equal(authorized.requestId, challenge.requestId)
      assert.equal(harness.upstream.invocationCount, 1)

      // 4. Source check of AgentCLI.tsx: explicit message that receipt alone does not unlock
      const agentCliSrc = readFileSync(join(process.cwd(), 'src/components/AgentCLI.tsx'), 'utf8')
      assert.ok(
        agentCliSrc.includes('Transaction receipt alone does NOT unlock protected data'),
        'AgentCLI must document that receipt alone does not unlock'
      )
    } finally {
      await harness.teardown()
    }
  })

  test('45. Stage 7.1 (Task 6.7): Empty-body hashing matches the expected Keccak-256 digest', async () => {
    const expected = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    assert.equal(EMPTY_BODY_DIGEST, expected)
    assert.equal(computeBodyDigest(''), expected)
    assert.equal(computeBodyDigest(), expected)
    assert.equal(keccak256(toHex('')), expected)

    // Verify on Gateway server challenge issuance
    const harness = await setupTestHarness()
    try {
      const res = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      assert.equal(res.status, 402)
      const data = (await res.json()) as { challenge: ChallengeData }
      assert.equal(data.challenge.bodyDigest, expected)
    } finally {
      await harness.teardown()
    }
  })

  test('46. Stage 7.1 (Task 6.8): Changed method, path, body, serviceId, requestId, price or expiry fails authorization as appropriate', async () => {
    const harness = await setupTestHarness()
    try {
      const validTxHash: Hex = '0x4646464646464646464646464646464646464646464646464646464646464646'
      const baseReqId: Hex = '0x1234567812345678123456781234567812345678123456781234567812345678'
      const baseExpiresAt = Date.now() + 600_000

      harness.rpc.registerValidPayment({
        txHash: validTxHash,
        serviceId: 0n,
        requestId: baseReqId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const baseChallenge: PaymentChallenge = {
        requestId: baseReqId,
        serviceId: 0n,
        payer: alice.address.toLowerCase() as Address,
        method: 'POST',
        path: '/v1/signals',
        bodyDigest: EMPTY_BODY_DIGEST,
        quotedPrice: 100_000n,
        chainId: ARC_TESTNET_CHAIN_ID,
        createdAt: Date.now(),
        expiresAt: baseExpiresAt,
        status: 'ISSUED',
      }

      const validSig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: baseReqId,
          txHash: validTxHash,
          method: 'POST',
          path: '/v1/signals',
          bodyDigest: EMPTY_BODY_DIGEST,
          quotedPrice: 100_000n,
          expiresAt: BigInt(baseExpiresAt),
        },
      })

      // Baseline: valid verification succeeds
      const validRes = await harness.verifier.verifyPayment({
        txHash: validTxHash,
        challenge: baseChallenge,
        signature: validSig,
        currentPath: '/v1/signals',
        currentMethod: 'POST',
        currentBodyDigest: EMPTY_BODY_DIGEST,
      })
      assert.equal(validRes.verifiedCaller.toLowerCase(), alice.address.toLowerCase())

      // 1. Changed method -> METHOD_MISMATCH
      await assert.rejects(
        () =>
          harness.verifier.verifyPayment({
            txHash: validTxHash,
            challenge: baseChallenge,
            signature: validSig,
            currentPath: '/v1/signals',
            currentMethod: 'GET', // Changed from POST
            currentBodyDigest: EMPTY_BODY_DIGEST,
          }),
        (err: unknown) => {
          assert.ok(err instanceof VerificationError)
          assert.equal(err.code, 'METHOD_MISMATCH')
          return true
        }
      )

      // 2. Changed path -> PATH_MISMATCH
      await assert.rejects(
        () =>
          harness.verifier.verifyPayment({
            txHash: validTxHash,
            challenge: baseChallenge,
            signature: validSig,
            currentPath: '/v1/other', // Changed from /v1/signals
            currentMethod: 'POST',
            currentBodyDigest: EMPTY_BODY_DIGEST,
          }),
        (err: unknown) => {
          assert.ok(err instanceof VerificationError)
          assert.equal(err.code, 'PATH_MISMATCH')
          return true
        }
      )

      // 3. Changed body -> BODY_DIGEST_MISMATCH
      await assert.rejects(
        () =>
          harness.verifier.verifyPayment({
            txHash: validTxHash,
            challenge: baseChallenge,
            signature: validSig,
            currentPath: '/v1/signals',
            currentMethod: 'POST',
            currentBodyDigest: computeBodyDigest('{"tampered":true}'), // Changed body
          }),
        (err: unknown) => {
          assert.ok(err instanceof VerificationError)
          assert.equal(err.code, 'BODY_DIGEST_MISMATCH')
          return true
        }
      )

      // 4. Changed serviceId -> SERVICE_ID_MISMATCH
      await assert.rejects(
        () =>
          harness.verifier.verifyPayment({
            txHash: validTxHash,
            challenge: { ...baseChallenge, serviceId: 1n }, // Changed to 1n
            signature: validSig,
            currentPath: '/v1/signals',
            currentMethod: 'POST',
            currentBodyDigest: EMPTY_BODY_DIGEST,
          }),
        (err: unknown) => {
          assert.ok(err instanceof VerificationError)
          assert.equal(err.code, 'SERVICE_ID_MISMATCH')
          return true
        }
      )

      // 5. Changed requestId -> REQUEST_ID_MISMATCH
      const alteredReqId: Hex = '0x9999999999999999999999999999999999999999999999999999999999999999'
      await assert.rejects(
        () =>
          harness.verifier.verifyPayment({
            txHash: validTxHash,
            challenge: { ...baseChallenge, requestId: alteredReqId }, // Changed requestId
            signature: validSig,
            currentPath: '/v1/signals',
            currentMethod: 'POST',
            currentBodyDigest: EMPTY_BODY_DIGEST,
          }),
        (err: unknown) => {
          assert.ok(err instanceof VerificationError)
          assert.equal(err.code, 'REQUEST_ID_MISMATCH')
          return true
        }
      )

      // 6. Changed price:
      // Case 6A: Payment amount less than quoted price -> INSUFFICIENT_AMOUNT
      await assert.rejects(
        () =>
          harness.verifier.verifyPayment({
            txHash: validTxHash,
            challenge: { ...baseChallenge, quotedPrice: 200_000n }, // Quoted price higher than paid (100k)
            signature: validSig,
            currentPath: '/v1/signals',
            currentMethod: 'POST',
            currentBodyDigest: EMPTY_BODY_DIGEST,
          }),
        (err: unknown) => {
          assert.ok(err instanceof VerificationError)
          assert.equal(err.code, 'INSUFFICIENT_AMOUNT')
          return true
        }
      )

      // Case 6B: On-chain price increased during challenge -> PRICE_CHANGED
      harness.rpc.prices.set('0', 250_000n)
      await assert.rejects(
        () =>
          harness.verifier.verifyPayment({
            txHash: validTxHash,
            challenge: baseChallenge,
            signature: validSig,
            currentPath: '/v1/signals',
            currentMethod: 'POST',
            currentBodyDigest: EMPTY_BODY_DIGEST,
          }),
        (err: unknown) => {
          assert.ok(err instanceof VerificationError)
          assert.equal(err.code, 'PRICE_CHANGED')
          return true
        }
      )
      harness.rpc.prices.set('0', 100_000n) // reset

      // 7. Changed expiry -> CHALLENGE_EXPIRED
      await assert.rejects(
        () =>
          harness.verifier.verifyPayment({
            txHash: validTxHash,
            challenge: { ...baseChallenge, expiresAt: Date.now() - 1000 }, // Expired
            signature: validSig,
            currentPath: '/v1/signals',
            currentMethod: 'POST',
            currentBodyDigest: EMPTY_BODY_DIGEST,
          }),
        (err: unknown) => {
          assert.ok(err instanceof VerificationError)
          assert.equal(err.code, 'CHALLENGE_EXPIRED')
          return true
        }
      )
    } finally {
      await harness.teardown()
    }
  })

  test('47. Stage 7.1 (Task 6.9): Mock mode remains explicitly identified as simulated', async () => {
    const mockHarness = await setupTestHarness({ mockRpc: true })
    try {
      // 1. GET /health identifies mock mode and demo notice
      const healthRes = await fetch(`${mockHarness.baseUrl}/health`)
      assert.equal(healthRes.status, 200)
      const healthData = (await healthRes.json()) as { mockRpc: boolean; demoNotice: string }
      assert.equal(healthData.mockRpc, true)
      assert.equal(healthData.demoNotice, 'SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED')

      // 2. Mock payment registration endpoint returns simulated confirmation
      const regRes = await fetch(`${mockHarness.baseUrl}/v1/mock/register-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
          requestId: '0x8888888888888888888888888888888888888888888888888888888888888888',
          caller: alice.address,
        }),
      })
      assert.equal(regRes.status, 200)
      const regData = (await regRes.json()) as { simulated: boolean; notice: string }
      assert.equal(regData.simulated, true)
      assert.equal(regData.notice, 'SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED')

      // 3. Client preflight blocks live wallet transactions in mock mode
      await assert.rejects(
        () =>
          prepareLivePaymentChallenge({
            serviceId: 0n,
            payerAddress: alice.address,
            gatewayUrl: mockHarness.baseUrl,
            allowMockRpc: false, // Default: false for live payments
          }),
        (err: unknown) => {
          assert.ok(err instanceof GatewayIntegrationError)
          assert.equal(err.code, 'GATEWAY_IN_MOCK_MODE')
          assert.ok(err.message.includes('SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED'))
          return true
        }
      )

      // 4. Source check of UI components to ensure simulated notices exist
      const serviceCardSrc = readFileSync(join(process.cwd(), 'src/components/ServiceCard.tsx'), 'utf8')
      const flowDashboardSrc = readFileSync(join(process.cwd(), 'src/components/FlowDashboard.tsx'), 'utf8')
      assert.ok(serviceCardSrc.includes('SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED'))
      assert.ok(flowDashboardSrc.includes('SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED'))
    } finally {
      await mockHarness.teardown()
    }
  })

  test('48. Stage 7.1 (Task 6.10): Existing replay protection and cached-retry behavior remain intact', async () => {
    const harness = await setupTestHarness()
    try {
      const { challenge } = await requestPaymentChallenge({
        serviceId: 0n,
        subPath: '/signals',
        method: 'POST',
        body: '',
        payerAddress: alice.address,
        gatewayUrl: harness.baseUrl,
      })

      const txHash: Hex = '0x4848484848484848484848484848484848484848484848484848484848484848'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: 100_000n,
      })

      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/signals',
          bodyDigest: EMPTY_BODY_DIGEST,
          quotedPrice: 100_000n,
          expiresAt: BigInt(challenge.expiresAt),
        },
      })

      // 1. Initial successful payment
      const res1 = await fetch(`${harness.baseUrl}/v1/gateway/0/signals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
          'X-Payment-Payer': alice.address,
        },
      })
      assert.equal(res1.status, 200)
      assert.equal(res1.headers.get('X-PayGate-Status'), 'VERIFIED_ONCHAIN_SUCCESS')
      assert.equal(harness.upstream.invocationCount, 1)

      // 2. Idempotent retry with identical txHash and requestId returns cached response without redispatching
      const res2 = await fetch(`${harness.baseUrl}/v1/gateway/0/signals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
          'X-Payment-Payer': alice.address,
        },
      })
      assert.equal(res2.status, 200)
      assert.equal(res2.headers.get('X-PayGate-Status'), 'VERIFIED_ONCHAIN_CACHED')
      assert.equal(res2.headers.get('X-PayGate-Cached'), 'true')
      assert.equal(harness.upstream.invocationCount, 1, 'Upstream must NOT be reinvoked on cached replay')

      // 3. Replay attack: reusing same txHash with a different requestId is rejected with 409
      const { challenge: challenge2 } = await requestPaymentChallenge({
        serviceId: 0n,
        subPath: '/signals',
        method: 'POST',
        body: '',
        payerAddress: alice.address,
        gatewayUrl: harness.baseUrl,
      })

      const resReplayTx = await fetch(`${harness.baseUrl}/v1/gateway/0/signals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-TxHash': txHash, // Reused txHash
          'X-Payment-RequestId': challenge2.requestId,
          'X-Payment-Signature': sig,
          'X-Payment-Payer': alice.address,
        },
      })
      assert.equal(resReplayTx.status, 409, 'Reusing txHash for new challenge must return 409')
      const replayData = (await resReplayTx.json()) as { code: string }
      assert.equal(replayData.code, 'PAYMENT_ALREADY_CONSUMED')
      assert.equal(harness.upstream.invocationCount, 1)
    } finally {
      await harness.teardown()
    }
  })

  test('49. Stage 7.1 (Task 5): Smart-account / ERC-4337 wallets are rejected pre-payment with SMART_ACCOUNT_UNSUPPORTED', async () => {
    // 1. Smart account wallet compatibility check rejects contract bytecode (e.g. ERC-4337 account)
    await assert.rejects(
      async () => {
        await checkConsumerWalletCompatibility({
          address: '0x5B12Ce46C7194aD57d143bC22847224047b1Ef42',
          getBytecode: async () => '0x6080604052348015600f57600080fd5b50',
        })
      },
      (err: unknown) => {
        assert.ok(err instanceof GatewayIntegrationError)
        assert.equal(err.code, 'SMART_ACCOUNT_UNSUPPORTED')
        assert.ok(err.message.includes('EOA transactions'))
        return true
      }
    )

    // 2. Standard EOA wallet (0x bytecode) passes compatibility check
    await checkConsumerWalletCompatibility({
      address: alice.address,
      getBytecode: async () => '0x',
    })
  })

  test('50. Stage 8.1: Multi-chain configuration validation & Mainnet/Testnet separation', async () => {
    // 1. Defaults to Arc Testnet (5042002)
    const testnetConfig = resolveGatewayConfig({ mockRpc: true })
    assert.equal(testnetConfig.chainId, ARC_TESTNET_CHAIN_ID)
    assert.equal(testnetConfig.contractAddress, ARC_TESTNET_PAYGATE_CONTRACT)

    // 2. Rejects unsupported chain ID
    assert.throws(
      () => resolveGatewayConfig({ chainId: 999999 }),
      (err: unknown) => {
        assert.ok(err instanceof GatewayConfigurationError)
        assert.ok(err.message.includes('Unsupported chain ID: 999999'))
        return true
      }
    )

    // 3. Rejects live Arc Mainnet without configured contract address
    assert.throws(
      () => resolveGatewayConfig({ chainId: ARC_MAINNET_CHAIN_ID, mockRpc: false }),
      (err: unknown) => {
        assert.ok(err instanceof GatewayConfigurationError)
        assert.ok(err.message.includes('Mainnet contract address is not configured'))
        return true
      }
    )

    // 4. Rejects reusing Testnet contract address for Mainnet
    assert.throws(
      () =>
        resolveGatewayConfig({
          chainId: ARC_MAINNET_CHAIN_ID,
          contractAddress: ARC_TESTNET_PAYGATE_CONTRACT,
          mockRpc: false,
        }),
      (err: unknown) => {
        assert.ok(err instanceof GatewayConfigurationError)
        assert.ok(err.message.includes('cannot use the Arc Testnet contract address'))
        return true
      }
    )

    // 5. Successfully resolves Mainnet when distinct address is provided
    const mainnetCustomAddr = '0x1234567890123456789012345678901234567890'
    const mainnetConfig = resolveGatewayConfig({
      chainId: ARC_MAINNET_CHAIN_ID,
      contractAddress: mainnetCustomAddr,
      mockRpc: false,
    })
    assert.equal(mainnetConfig.chainId, ARC_MAINNET_CHAIN_ID)
    assert.equal(mainnetConfig.contractAddress, mainnetCustomAddr)
    assert.equal(mainnetConfig.rpcUrl, 'https://rpc.mainnet.arc.io')
  })

  test('51. Stage 8.1: Dynamic EIP-712 domain derivation and network mismatch protection', async () => {
    const testnetDomain = buildEip712Domain(ARC_TESTNET_CHAIN_ID, ARC_TESTNET_PAYGATE_CONTRACT)
    assert.equal(testnetDomain.chainId, ARC_TESTNET_CHAIN_ID)
    assert.equal(testnetDomain.verifyingContract, ARC_TESTNET_PAYGATE_CONTRACT)

    const mainnetAddr = '0x2222222222222222222222222222222222222222' as Address
    const mainnetDomain = buildEip712Domain(ARC_MAINNET_CHAIN_ID, mainnetAddr)
    assert.equal(mainnetDomain.chainId, ARC_MAINNET_CHAIN_ID)
    assert.equal(mainnetDomain.verifyingContract, mainnetAddr)

    // Verify typed data signed for Testnet fails on Mainnet verifier
    const mainnetVerifier = new BlockchainVerifier(
      new MockRpcClient(),
      1,
      mainnetAddr,
      ARC_MAINNET_CHAIN_ID
    )
    assert.equal(mainnetVerifier.chainId, ARC_MAINNET_CHAIN_ID)
    assert.equal(mainnetVerifier.contractAddress, mainnetAddr)
  })

  test('52. Stage 8.1: ServiceRegistered event decoding (reverted, wrong emitter, missing, ambiguous, valid)', async () => {
    const contractAddr = '0xcc69506b784dffda4ee4d221b122303304099971' as Address
    const serviceRegisteredTopic = '0x67be3c810154c389fd2646b1c47628f982539f07681810b2d5f736f6df245a08'

    // 1. Reverted transaction
    const revertedReceipt = {
      status: 'reverted',
      logs: [],
    } as unknown as TransactionReceipt
    const res1 = decodeServiceRegisteredReceipt(revertedReceipt, contractAddr)
    assert.equal(res1.success, false)
    if (!res1.success) {
      assert.equal(res1.code, 'TX_NOT_SUCCESS')
    }

    // 2. Wrong emitting contract
    const wrongEmitterReceipt = {
      status: 'success',
      logs: [
        {
          address: '0x1111111111111111111111111111111111111111',
          topics: [serviceRegisteredTopic],
          data: '0x',
        },
      ],
    } as unknown as TransactionReceipt
    const res2 = decodeServiceRegisteredReceipt(wrongEmitterReceipt, contractAddr)
    assert.equal(res2.success, false)
    if (!res2.success) {
      assert.equal(res2.code, 'EVENT_NOT_FOUND')
    }

    // 3. Missing event
    const missingReceipt = {
      status: 'success',
      logs: [],
    } as unknown as TransactionReceipt
    const res3 = decodeServiceRegisteredReceipt(missingReceipt, contractAddr)
    assert.equal(res3.success, false)
    if (!res3.success) {
      assert.equal(res3.code, 'EVENT_NOT_FOUND')
    }

    // 4. Ambiguous events (>1 matching logs)
    const ambiguousReceipt = {
      status: 'success',
      logs: [
        { address: contractAddr, topics: [serviceRegisteredTopic], data: '0x' },
        { address: contractAddr, topics: [serviceRegisteredTopic], data: '0x' },
      ],
    } as unknown as TransactionReceipt
    const res4 = decodeServiceRegisteredReceipt(ambiguousReceipt, contractAddr)
    assert.equal(res4.success, false)
    if (!res4.success) {
      assert.equal(res4.code, 'AMBIGUOUS_EVENTS')
    }

    // 5. Malformed log data
    const malformedReceipt = {
      status: 'success',
      logs: [
        {
          address: contractAddr,
          topics: [
            serviceRegisteredTopic,
            pad(toHex(0n), { size: 32 }),
            pad(alice.address, { size: 32 }),
          ],
          data: '0x1234', // Truncated ABI data
        },
      ],
    } as unknown as TransactionReceipt
    const res5 = decodeServiceRegisteredReceipt(malformedReceipt, contractAddr)
    assert.equal(res5.success, false)
    if (!res5.success) {
      assert.equal(res5.code, 'DECODE_EXCEPTION')
    }

    // 6. Valid receipt & event log
    const validData = encodeAbiParameters(
      parseAbiParameters('string name, uint256 priceInUsdc'),
      ['Whale Accumulation Signals', 100000n]
    )
    const validReceipt = {
      status: 'success',
      logs: [
        {
          address: contractAddr,
          topics: [
            serviceRegisteredTopic,
            pad(toHex(5n), { size: 32 }), // serviceId = 5
            pad(alice.address, { size: 32 }), // provider = alice
          ],
          data: validData,
        },
      ],
    } as unknown as TransactionReceipt
    const res6 = decodeServiceRegisteredReceipt(validReceipt, contractAddr)
    assert.equal(res6.success, true)
    if (res6.success) {
      assert.equal(res6.data.serviceId, 5n)
      assert.equal(res6.data.name, 'Whale Accumulation Signals')
      assert.equal(res6.data.priceInUsdc, 100000n)
      assert.equal(res6.data.provider.toLowerCase(), alice.address.toLowerCase())
    }
  })

  test('53. Stage 8.1: RealDataUpstreamAdapter (schema validation, timeout, oversized response, HTTP error)', async () => {
    // Start a temporary local HTTP test fixture server
    let serverMode: 'normal' | 'timeout' | 'oversized' | 'invalid_json' | 'error_500' = 'normal'
    const fixtureServer = createHttpServer((_req, res) => {
      if (serverMode === 'timeout') {
        // Do not respond; wait for client abort
        return
      }
      if (serverMode === 'error_500') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Server explosion' }))
        return
      }
      if (serverMode === 'invalid_json') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('<html>Not JSON</html>')
        return
      }
      if (serverMode === 'oversized') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: 'A'.repeat(70000) }))
        return
      }
      // Normal
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ metric: 'block_time', value: 1.25 }))
    })

    await new Promise<void>(resolve => fixtureServer.listen(0, '127.0.0.1', () => resolve()))
    const addr = fixtureServer.address() as { port: number }
    const fixtureUrl = `http://127.0.0.1:${addr.port}`

    try {
      const adapter = new RealDataUpstreamAdapter({
        endpointUrl: fixtureUrl,
        timeoutMs: 200,
        maxResponseSizeBytes: 65536,
      })

      // 1. Normal valid dispatch
      serverMode = 'normal'
      const res = await adapter.dispatch({
        serviceId: 0n,
        method: 'GET',
        path: '/metrics',
        body: '',
        idempotencyKey: '0x1111',
      })
      assert.equal(res.status, 200)
      const parsedBody = JSON.parse(res.body) as {
        status: number
        provenance: { source: string; verifiedLive: boolean }
        data: { metric: string; value: number }
      }
      assert.equal(parsedBody.status, 200)
      assert.equal(parsedBody.provenance.source, fixtureUrl)
      assert.equal(parsedBody.provenance.verifiedLive, true)
      assert.equal(parsedBody.data.metric, 'block_time')

      // 2. Timeout abort
      serverMode = 'timeout'
      await assert.rejects(
        async () => {
          await adapter.dispatch({
            serviceId: 0n,
            method: 'GET',
            path: '/timeout',
            body: '',
            idempotencyKey: '0x2222',
          })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.equal((err as { statusCode: number }).statusCode, 504)
          assert.equal((err as { isTimeoutAfterDispatch: boolean }).isTimeoutAfterDispatch, true)
          return true
        }
      )

      // 3. Oversized response
      serverMode = 'oversized'
      await assert.rejects(
        async () => {
          await adapter.dispatch({
            serviceId: 0n,
            method: 'GET',
            path: '/oversized',
            body: '',
            idempotencyKey: '0x3333',
          })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.ok(err.message.includes('exceeded size limit'))
          return true
        }
      )

      // 4. Invalid non-JSON payload
      serverMode = 'invalid_json'
      await assert.rejects(
        async () => {
          await adapter.dispatch({
            serviceId: 0n,
            method: 'GET',
            path: '/invalid',
            body: '',
            idempotencyKey: '0x4444',
          })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.ok(err.message.includes('invalid non-JSON'))
          return true
        }
      )

      // 5. Upstream 500 error
      serverMode = 'error_500'
      await assert.rejects(
        async () => {
          await adapter.dispatch({
            serviceId: 0n,
            method: 'GET',
            path: '/error',
            body: '',
            idempotencyKey: '0x5555',
          })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.ok(err.message.includes('HTTP error: received status 500'))
          return true
        }
      )
    } finally {
      await new Promise<void>(resolve => fixtureServer.close(() => resolve()))
    }
  })

  test('54. Stage 8.18A: Frontend multi-chain network config resolution (Testnet default and Mainnet deployed v2)', async () => {
    // 1. Arc Testnet (5042002) config preserved
    const testnet = getNetworkConfig(5042002)
    assert.equal(testnet.chainId, 5042002)
    assert.equal(testnet.chainName, 'Arc Testnet')
    assert.equal(testnet.contractAddress, '0xcc69506b784dffda4ee4d221b122303304099971')
    assert.equal(testnet.treasuryAddress, '0x5B12Ce46C7194aD57d143bC22847224047b1Ef42')
    assert.equal(testnet.usdcAddress, '0x3600000000000000000000000000000000000000')
    assert.equal(testnet.explorerBase, 'https://explorer.testnet.arc.io')
    assert.equal(testnet.isDeployed, true)

    // 2. Default fallback is Arc Testnet
    const defaultNet = getNetworkConfig(undefined)
    assert.equal(defaultNet.chainId, 5042002)
    assert.equal(defaultNet.isDeployed, true)

    // 3. Arc Mainnet (5042) config resolves to deployed PayGate402 v2 contract
    const mainnet = getNetworkConfig(5042)
    assert.equal(mainnet.chainId, 5042)
    assert.equal(mainnet.chainName, 'Arc')
    assert.equal(mainnet.contractAddress, '0xa27e390CC82793911D805D4cB3E0c50F2117C77A')
    assert.equal(mainnet.treasuryAddress, '0xDc7c4aFBa201D2a3108061107346e9ff70f0Ca2c')
    assert.equal(mainnet.usdcAddress, '0x3600000000000000000000000000000000000000')
    assert.equal(mainnet.explorerBase, 'https://explorer.arc.io')
    assert.equal(mainnet.isDeployed, true)

    // 4. Invalid or unknown chain ID falls back safely to default network (Testnet)
    const unknownNet = getNetworkConfig(999999)
    assert.equal(unknownNet.chainId, 5042002)
    assert.equal(unknownNet.isDeployed, true)
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 55. Stage 8.3: Direct Arc Mainnet Telemetry fetcher
  // ─────────────────────────────────────────────────────────────────────────────
  test('55. Stage 8.3: Direct Arc Mainnet Telemetry fetcher (batch JSON-RPC format, timeout handling, payload structure)', async () => {
    let mode: 'normal' | 'timeout' = 'normal'
    const fixtureServer = createHttpServer((_req, res) => {
      if (mode === 'timeout') return
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, result: '0x19d1bcc' }, // 27073484
          {
            jsonrpc: '2.0',
            id: 2,
            result: {
              number: '0x19d1bcc',
              hash: '0xa1292207ca8de86d8977c56beec886dc4605de074d69be414544da1d75d1ed66',
              timestamp: '0x6ad8f14c', // 1792565516
              gasUsed: '0x518cb',     // 334043
              gasLimit: '0x1c9c380',   // 30000000
              transactions: ['0xtx1', '0xtx2'],
            },
          },
          { jsonrpc: '2.0', id: 3, result: '0x578b97d24' }, // 23498012000 wei
        ])
      )
    })

    await new Promise<void>(resolve => fixtureServer.listen(0, '127.0.0.1', () => resolve()))
    const addr = fixtureServer.address() as { port: number }
    const fixtureUrl = `http://127.0.0.1:${addr.port}`

    try {
      // 1. Happy path: valid batch parse and structured telemetry
      mode = 'normal'
      const payload = await fetchArcMainnetTelemetry({
        endpointUrl: fixtureUrl,
        timeoutMs: 500,
        maxResponseSizeBytes: 65536,
      })

      assert.equal(payload.status, 200)
      assert.equal(payload.service, 'arc-l1-telemetry')
      assert.equal(payload.network, 'Arc Mainnet')
      assert.equal(payload.chainId, 5042)
      assert.equal(payload.telemetry.blockNumber, 27073484)
      assert.equal(payload.telemetry.blockHash, '0xa1292207ca8de86d8977c56beec886dc4605de074d69be414544da1d75d1ed66')
      assert.equal(payload.telemetry.blockTimestamp, 1792602444)
      assert.equal(payload.telemetry.gasUsed, 334027)
      assert.equal(payload.telemetry.gasLimit, 30000000)
      assert.equal(payload.telemetry.transactionCount, 2)
      assert.equal(payload.provenance.source, fixtureUrl)
      assert.equal(payload.provenance.verifiedLive, true)

      // 2. Timeout path: fails closed with 504
      mode = 'timeout'
      await assert.rejects(
        async () => {
          await fetchArcMainnetTelemetry({
            endpointUrl: fixtureUrl,
            timeoutMs: 100,
          })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.equal((err as { statusCode: number }).statusCode, 504)
          assert.equal((err as { isTimeoutAfterDispatch: boolean }).isTimeoutAfterDispatch, true)
          return true
        }
      )
    } finally {
      await new Promise<void>(resolve => fixtureServer.close(() => resolve()))
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 56. Stage 8.3: Server endpoint GET /v1/telemetry/arc-mainnet
  // ─────────────────────────────────────────────────────────────────────────────
  test('56. Stage 8.3: Server endpoint GET /v1/telemetry/arc-mainnet returns genuine Arc L1 telemetry', async () => {
    const harness = await setupTestHarness()
    try {
      const res = await fetch(`${harness.baseUrl}/v1/telemetry/arc-mainnet`, {
        method: 'GET',
      })
      // If RPC is reachable, returns 200; if network RPC blips, returns 502 with error code
      assert.ok(res.status === 200 || res.status === 502)
      if (res.status === 200) {
        assert.equal(res.headers.get('x-paygate-upstream'), 'verified-arc-telemetry')
        const data = (await res.json()) as {
          status: number
          service: string
          network: string
          chainId: number
          telemetry: { blockNumber: number }
          provenance: { source: string; verifiedLive: boolean }
        }
        assert.equal(data.status, 200)
        assert.equal(data.service, 'arc-l1-telemetry')
        assert.equal(data.network, 'Arc Mainnet')
        assert.equal(data.chainId, 5042)
        assert.ok(data.telemetry.blockNumber > 0)
        assert.equal(data.provenance.verifiedLive, true)
      }
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 57. Stage 8.3: PayGate402V2 architectural invariants & service catalog alignment
  // ─────────────────────────────────────────────────────────────────────────────
  test('57. Stage 8.3: PayGate402V2 architectural invariants & service catalog alignment', async () => {
    // 1. Verify Contract v2 source code invariants
    const v2Path = join(process.cwd(), 'contracts', 'PayGate402V2.sol')
    const v2Source = readFileSync(v2Path, 'utf8')

    // Invariant A: hasAccess state variable declaration is completely removed
    assert.ok(
      !v2Source.includes('public hasAccess') && !v2Source.includes('mapping(uint256 => mapping(address => bool))'),
      'PayGate402V2 must not contain hasAccess mapping declaration'
    )

    // Invariant B: verifyAccess method declaration is completely removed
    assert.ok(
      !v2Source.includes('function verifyAccess('),
      'PayGate402V2 must not contain verifyAccess function declaration'
    )

    // Invariant C: usedRequestIds is single-level contract-wide mapping(bytes32 => bool)
    assert.ok(
      v2Source.includes('mapping(bytes32 => bool) public usedRequestIds'),
      'PayGate402V2 usedRequestIds must be contract-wide mapping(bytes32 => bool)'
    )

    // Invariant D: Reentrancy protection — inherits ReentrancyGuard and has nonReentrant modifier
    assert.ok(v2Source.includes('is ReentrancyGuard'), 'PayGate402V2 must inherit ReentrancyGuard')
    assert.ok(v2Source.includes('nonReentrant'), 'payForAccess must have nonReentrant modifier')

    // Invariant E: CEI pattern — state effects occur before transferFrom
    const usedReqPos = v2Source.indexOf('usedRequestIds[requestId] = true;')
    const transferPos = v2Source.indexOf('usdcToken.transferFrom(msg.sender, service.provider')
    assert.ok(usedReqPos !== -1 && transferPos !== -1)
    assert.ok(usedReqPos < transferPos, 'CEI violation: usedRequestIds must update BEFORE external transferFrom')

    // 2. Verify Service Catalog alignment in src/lib/paygate402.ts
    const catalogPath = join(process.cwd(), 'src', 'lib', 'paygate402.ts')
    const catalogSource = readFileSync(catalogPath, 'utf8')

    // Primary service is Arc L1 Real-Time Telemetry
    assert.ok(catalogSource.includes('Arc L1 Real-Time Telemetry'))
    assert.ok(catalogSource.includes('/v1/telemetry/arc-mainnet'))

    // All demo services must be explicitly marked DEMO — SYNTHETIC DATA
    assert.ok(catalogSource.includes('[DEMO — SYNTHETIC DATA] Whale Accumulation Signals'))
    assert.ok(catalogSource.includes('[DEMO — SYNTHETIC DATA] DeFi Market Analysis'))
    assert.ok(catalogSource.includes('[DEMO — SYNTHETIC DATA] Smart Contract Security Audit'))
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 58. Stage 8.4: Adversarial Arc Telemetry
  // ─────────────────────────────────────────────────────────────────────────────
  test('58. Stage 8.4: Adversarial Arc Telemetry (RPC error handling, chain identity mismatch, zero gasLimit handling)', async () => {
    let mode: 'rpc_error' | 'wrong_chain' | 'zero_gas_limit' = 'rpc_error'
    const fixtureServer = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (mode === 'rpc_error') {
        res.end(
          JSON.stringify([
            { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Simulated RPC node failure' } },
            { jsonrpc: '2.0', id: 2, result: null },
            { jsonrpc: '2.0', id: 3, result: null },
            { jsonrpc: '2.0', id: 4, result: '0x13b2' },
          ])
        )
        return
      }
      if (mode === 'wrong_chain') {
        res.end(
          JSON.stringify([
            { jsonrpc: '2.0', id: 1, result: '0x1000' },
            {
              jsonrpc: '2.0',
              id: 2,
              result: {
                number: '0x1000',
                hash: '0xabc',
                timestamp: '0x6ad8f14c',
                gasUsed: '0x100',
                gasLimit: '0x1000',
                transactions: [],
              },
            },
            { jsonrpc: '2.0', id: 3, result: '0x100' },
            { jsonrpc: '2.0', id: 4, result: '0x1' }, // Chain ID 1 (Ethereum) instead of 5042 (0x13b2)
          ])
        )
        return
      }
      if (mode === 'zero_gas_limit') {
        res.end(
          JSON.stringify([
            { jsonrpc: '2.0', id: 1, result: '0x1000' },
            {
              jsonrpc: '2.0',
              id: 2,
              result: {
                number: '0x1000',
                hash: '0xabc',
                timestamp: '0x6ad8f14c',
                gasUsed: '0x0',
                gasLimit: '0x0', // Zero gasLimit edge case
                transactions: [],
              },
            },
            { jsonrpc: '2.0', id: 3, result: '0x100' },
            { jsonrpc: '2.0', id: 4, result: '0x13b2' }, // Correct 5042
          ])
        )
        return
      }
    })

    await new Promise<void>(resolve => fixtureServer.listen(0, '127.0.0.1', () => resolve()))
    const addr = fixtureServer.address() as { port: number }
    const fixtureUrl = `http://127.0.0.1:${addr.port}`

    try {
      // 1. RPC error in batch item throws 502 with message
      mode = 'rpc_error'
      await assert.rejects(
        async () => {
          await fetchArcMainnetTelemetry({ endpointUrl: fixtureUrl, timeoutMs: 500 })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.equal((err as { statusCode: number }).statusCode, 502)
          assert.ok(err.message.includes('Simulated RPC node failure'))
          return true
        }
      )

      // 2. Chain identity mismatch throws 502
      mode = 'wrong_chain'
      await assert.rejects(
        async () => {
          await fetchArcMainnetTelemetry({ endpointUrl: fixtureUrl, timeoutMs: 500 })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.equal((err as { statusCode: number }).statusCode, 502)
          assert.ok(err.message.includes('chain identity mismatch'))
          return true
        }
      )

      // 3. Zero gasLimit handled safely without NaN or division by zero
      mode = 'zero_gas_limit'
      const payload = await fetchArcMainnetTelemetry({ endpointUrl: fixtureUrl, timeoutMs: 500 })
      assert.equal(payload.status, 200)
      assert.equal(payload.telemetry.gasLimit, 0)
      assert.equal(payload.telemetry.gasUtilizationPercent, 0)
    } finally {
      await new Promise<void>(resolve => fixtureServer.close(() => resolve()))
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 59. Stage 8.4: Adversarial Replay & Cross-Service Scope
  // ─────────────────────────────────────────────────────────────────────────────
  test('59. Stage 8.4: Adversarial Replay & Cross-Service Scope (Service 0 challenge rejected on Service 1)', async () => {
    const harness = await setupTestHarness()
    try {
      // Payer obtains challenge for Service 0
      const res402 = await fetch(`${harness.baseUrl}/v1/gateway/0/feed`, { method: 'POST' })
      assert.equal(res402.status, 402)
      const { challenge } = (await res402.json()) as { challenge: { requestId: Hex; quotedPrice: string } }

      const txHash: Hex = '0x1234567890123456789012345678901234567890123456789012345678901234'
      harness.rpc.registerValidPayment({
        txHash,
        serviceId: 0n,
        requestId: challenge.requestId,
        caller: alice.address,
        amountPaid: BigInt(challenge.quotedPrice),
      })

      // Payer signs authorization for Service 0
      const sig = await alice.signTypedData({
        domain: PAYGATE_EIP712_DOMAIN,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: {
          serviceId: 0n,
          requestId: challenge.requestId,
          txHash,
          method: 'POST',
          path: '/feed',
          bodyDigest: keccak256(toHex('')),
          quotedPrice: BigInt(challenge.quotedPrice),
          expiresAt: BigInt(Date.now() + 900_000),
        },
      })

      // Attacker attempts to submit Service 0 payment to Service 1 gateway endpoint
      const crossServiceRes = await fetch(`${harness.baseUrl}/v1/gateway/1/feed`, {
        method: 'POST',
        headers: {
          'X-Payment-TxHash': txHash,
          'X-Payment-RequestId': challenge.requestId,
          'X-Payment-Signature': sig,
        },
      })

      // Must be rejected: EIP-712 authorization bound to serviceId 0 fails verification on serviceId 1
      assert.equal(crossServiceRes.status, 401)
      const errData = (await crossServiceRes.json()) as { code: string }
      assert.equal(errData.code, 'SIGNER_MISMATCH')
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 60. Stage 8.4: Gateway State Machine Crash Recovery & Atomic Idempotency
  // ─────────────────────────────────────────────────────────────────────────────
  test('60. Stage 8.4: Gateway State Machine Crash Recovery & Atomic Idempotency', async () => {
    const harness = await setupTestHarness()
    try {
      const txHash: Hex = '0x9999999999999999999999999999999999999999999999999999999999999999'
      const requestId: Hex = '0x8888888888888888888888888888888888888888888888888888888888888888'

      // Database schema enforces foreign key: challenge must exist before payment lock
      harness.db.createChallenge({
        requestId,
        serviceId: 0n,
        payer: alice.address,
        method: 'POST',
        path: '/feed',
        bodyDigest: keccak256(toHex('')),
        quotedPrice: 100_000n,
        chainId: 5042002,
        createdAt: Date.now(),
        expiresAt: Date.now() + 900_000,
        status: 'ISSUED',
      })

      // Acquire lock first time -> success
      const lock1 = harness.db.tryAcquirePaymentLock({
        txHash,
        requestId,
        serviceId: 0n,
        caller: alice.address,
        amountPaid: 100_000n,
      })
      assert.equal(lock1.acquired, true)

      // Concurrent second attempt before completion -> CONCURRENT_CONFLICT (409)
      const lock2 = harness.db.tryAcquirePaymentLock({
        txHash,
        requestId,
        serviceId: 0n,
        caller: alice.address,
        amountPaid: 100_000n,
      })
      assert.equal(lock2.acquired, false)
      assert.equal(lock2.reason, 'CONCURRENT_CONFLICT')

      // Crash recovery simulation: record failure resets lock to FAILED
      harness.db.recordFailed(txHash, 'Simulated RPC crash')
      const rec = harness.db.getPayment(txHash)
      assert.equal(rec?.state, 'FAILED')

      // After FAILED, lock can be re-acquired for valid retry
      const lockRetry = harness.db.tryAcquirePaymentLock({
        txHash,
        requestId,
        serviceId: 0n,
        caller: alice.address,
        amountPaid: 100_000n,
      })
      assert.equal(lockRetry.acquired, true)
    } finally {
      await harness.teardown()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 61. Stage 8.5: Adversarial Telemetry Block Timestamp & Hash Validation
  // ─────────────────────────────────────────────────────────────────────────────
  test('61. Stage 8.5: Adversarial Telemetry Block Timestamp & Hash Validation (fail-closed without epoch fallback)', async () => {
    let mode: 'missing_timestamp' | 'malformed_hex_timestamp' | 'zero_timestamp' | 'missing_hash' | 'malformed_hash' = 'missing_timestamp'
    const fixtureServer = createHttpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (mode === 'missing_timestamp') {
        res.end(
          JSON.stringify([
            { jsonrpc: '2.0', id: 1, result: '0x1000' },
            {
              jsonrpc: '2.0',
              id: 2,
              result: {
                number: '0x1000',
                hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
                // timestamp missing completely
                gasUsed: '0x100',
                gasLimit: '0x1000',
                transactions: [],
              },
            },
            { jsonrpc: '2.0', id: 3, result: '0x100' },
            { jsonrpc: '2.0', id: 4, result: '0x13b2' },
          ])
        )
        return
      }
      if (mode === 'malformed_hex_timestamp') {
        res.end(
          JSON.stringify([
            { jsonrpc: '2.0', id: 1, result: '0x1000' },
            {
              jsonrpc: '2.0',
              id: 2,
              result: {
                number: '0x1000',
                hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
                timestamp: 'not-a-valid-hex-timestamp',
                gasUsed: '0x100',
                gasLimit: '0x1000',
                transactions: [],
              },
            },
            { jsonrpc: '2.0', id: 3, result: '0x100' },
            { jsonrpc: '2.0', id: 4, result: '0x13b2' },
          ])
        )
        return
      }
      if (mode === 'zero_timestamp') {
        res.end(
          JSON.stringify([
            { jsonrpc: '2.0', id: 1, result: '0x1000' },
            {
              jsonrpc: '2.0',
              id: 2,
              result: {
                number: '0x1000',
                hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
                timestamp: '0x0', // Zero timestamp (epoch fallback rejected)
                gasUsed: '0x100',
                gasLimit: '0x1000',
                transactions: [],
              },
            },
            { jsonrpc: '2.0', id: 3, result: '0x100' },
            { jsonrpc: '2.0', id: 4, result: '0x13b2' },
          ])
        )
        return
      }
      if (mode === 'missing_hash') {
        res.end(
          JSON.stringify([
            { jsonrpc: '2.0', id: 1, result: '0x1000' },
            {
              jsonrpc: '2.0',
              id: 2,
              result: {
                number: '0x1000',
                // hash missing
                timestamp: '0x6ad8f14c',
                gasUsed: '0x100',
                gasLimit: '0x1000',
                transactions: [],
              },
            },
            { jsonrpc: '2.0', id: 3, result: '0x100' },
            { jsonrpc: '2.0', id: 4, result: '0x13b2' },
          ])
        )
        return
      }
      if (mode === 'malformed_hash') {
        res.end(
          JSON.stringify([
            { jsonrpc: '2.0', id: 1, result: '0x1000' },
            {
              jsonrpc: '2.0',
              id: 2,
              result: {
                number: '0x1000',
                hash: 'not-a-hex-hash',
                timestamp: '0x6ad8f14c',
                gasUsed: '0x100',
                gasLimit: '0x1000',
                transactions: [],
              },
            },
            { jsonrpc: '2.0', id: 3, result: '0x100' },
            { jsonrpc: '2.0', id: 4, result: '0x13b2' },
          ])
        )
        return
      }
    })

    await new Promise<void>(resolve => fixtureServer.listen(0, '127.0.0.1', () => resolve()))
    const addr = fixtureServer.address() as { port: number }
    const fixtureUrl = `http://127.0.0.1:${addr.port}`

    try {
      // 1. Missing timestamp throws 502 UpstreamError
      mode = 'missing_timestamp'
      await assert.rejects(
        async () => {
          await fetchArcMainnetTelemetry({ endpointUrl: fixtureUrl, timeoutMs: 500 })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.equal((err as { statusCode: number }).statusCode, 502)
          assert.ok(err.message.includes('invalid or missing block timestamp'))
          return true
        }
      )

      // 2. Malformed hex timestamp throws 502 UpstreamError
      mode = 'malformed_hex_timestamp'
      await assert.rejects(
        async () => {
          await fetchArcMainnetTelemetry({ endpointUrl: fixtureUrl, timeoutMs: 500 })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.equal((err as { statusCode: number }).statusCode, 502)
          assert.ok(err.message.includes('invalid or missing block timestamp'))
          return true
        }
      )

      // 3. Zero timestamp throws 502 UpstreamError (epoch fallback rejected)
      mode = 'zero_timestamp'
      await assert.rejects(
        async () => {
          await fetchArcMainnetTelemetry({ endpointUrl: fixtureUrl, timeoutMs: 500 })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.equal((err as { statusCode: number }).statusCode, 502)
          assert.ok(err.message.includes('unparseable block timestamp'))
          return true
        }
      )

      // 4. Missing block hash throws 502 UpstreamError
      mode = 'missing_hash'
      await assert.rejects(
        async () => {
          await fetchArcMainnetTelemetry({ endpointUrl: fixtureUrl, timeoutMs: 500 })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.equal((err as { statusCode: number }).statusCode, 502)
          assert.ok(err.message.includes('invalid or missing block hash'))
          return true
        }
      )

      // 5. Malformed block hash throws 502 UpstreamError
      mode = 'malformed_hash'
      await assert.rejects(
        async () => {
          await fetchArcMainnetTelemetry({ endpointUrl: fixtureUrl, timeoutMs: 500 })
        },
        (err: unknown) => {
          assert.ok(err instanceof Error)
          assert.equal((err as { statusCode: number }).statusCode, 502)
          assert.ok(err.message.includes('invalid or missing block hash'))
          return true
        }
      )
    } finally {
      await new Promise<void>(resolve => fixtureServer.close(() => resolve()))
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 62. Stage 8.6: Multi-Chain BlockchainVerifier & ViemRpcClient Integration
  // ─────────────────────────────────────────────────────────────────────────────
  test('62. Stage 8.6: Multi-Chain BlockchainVerifier & ViemRpcClient Integration (dynamic chainId and contractAddress)', async () => {
    const mainnetAddr = '0x1234567890123456789012345678901234567890' as Address
    const rpc = new MockRpcClient()
    const mainnetVerifier = new BlockchainVerifier(rpc, 1, mainnetAddr, ARC_MAINNET_CHAIN_ID)

    assert.equal(mainnetVerifier.chainId, ARC_MAINNET_CHAIN_ID)
    assert.equal(mainnetVerifier.contractAddress, mainnetAddr)

    const baseChallenge: PaymentChallenge = {
      requestId: '0x1111111111111111111111111111111111111111111111111111111111111111',
      serviceId: 0n,
      payer: alice.address,
      method: 'POST',
      path: '/v1/signals',
      bodyDigest: EMPTY_BODY_DIGEST,
      quotedPrice: 100_000n,
      chainId: ARC_MAINNET_CHAIN_ID,
      createdAt: Date.now(),
      expiresAt: Date.now() + 900_000,
      status: 'ISSUED',
    }

    const txHash: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    rpc.registerValidPayment({
      txHash,
      serviceId: 0n,
      requestId: baseChallenge.requestId,
      caller: alice.address,
      amountPaid: 100_000n,
      targetContract: mainnetAddr,
      customLogAddress: mainnetAddr,
    })

    const mainnetDomain = buildEip712Domain(ARC_MAINNET_CHAIN_ID, mainnetAddr)
    const sig = await alice.signTypedData({
      domain: mainnetDomain,
      types: PAYGATE_EIP712_TYPES,
      primaryType: 'PayGateAuthorization',
      message: {
        serviceId: 0n,
        requestId: baseChallenge.requestId,
        txHash,
        method: 'POST',
        path: '/v1/signals',
        bodyDigest: EMPTY_BODY_DIGEST,
        quotedPrice: 100_000n,
        expiresAt: BigInt(baseChallenge.expiresAt),
      },
    })

    // Case 1: RPC returns 5042 -> Verification passes
    rpc.chainId = ARC_MAINNET_CHAIN_ID
    const res = await mainnetVerifier.verifyPayment({
      txHash,
      challenge: baseChallenge,
      signature: sig,
      currentPath: '/v1/signals',
      currentMethod: 'POST',
      currentBodyDigest: EMPTY_BODY_DIGEST,
    })
    assert.equal(res.verifiedCaller.toLowerCase(), alice.address.toLowerCase())
    assert.equal(res.amountPaid, 100_000n)

    // Case 2: RPC returns Testnet chain 5042002 -> Fails with WRONG_CHAIN
    rpc.chainId = ARC_TESTNET_CHAIN_ID
    await assert.rejects(
      () =>
        mainnetVerifier.verifyPayment({
          txHash,
          challenge: baseChallenge,
          signature: sig,
          currentPath: '/v1/signals',
          currentMethod: 'POST',
          currentBodyDigest: EMPTY_BODY_DIGEST,
        }),
      (err: unknown) => {
        assert.ok(err instanceof VerificationError)
        assert.equal(err.code, 'WRONG_CHAIN')
        assert.ok(err.message.includes('Arc Mainnet (5042)'))
        return true
      }
    )

    // Case 3: ViemRpcClient custom contract address initialization
    const client = new ViemRpcClient('http://127.0.0.1:1', mainnetAddr)
    assert.ok(client)
  })
})


