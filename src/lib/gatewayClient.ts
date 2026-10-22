/**
 * Client library for interacting with the PayGate402 Secure Gateway
 * Enforces fail-closed challenge acquisition, Keccak-256 body digest binding,
 * EOA sender compatibility checks, and EIP-712 cryptographic authorization.
 */
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { getNetworkConfig } from './networkConfig.ts'

export const GATEWAY_BASE_URL =
  (typeof window !== 'undefined' &&
    ((window as unknown as { __PAYGATE_GATEWAY_URL__?: string }).__PAYGATE_GATEWAY_URL__ ||
      (import.meta as unknown as { env?: { VITE_GATEWAY_URL?: string } }).env?.VITE_GATEWAY_URL)) ||
  'http://localhost:4020'

export const PAYGATE_EIP712_DOMAIN = {
  name: 'PayGate402 Gateway',
  version: '1',
  chainId: 5042,
  verifyingContract: '0xa27e390CC82793911D805D4cB3E0c50F2117C77A',
} as const

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

/**
 * Authoritative Keccak-256 digest of an empty request body ("").
 * keccak256(toHex("")) === 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
 */
export const EMPTY_BODY_DIGEST: Hex =
  '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'

export const ZERO_BYTES32: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000'

const BYTES32_HEX_REGEX = /^0x[0-9a-fA-F]{64}$/

export class GatewayIntegrationError extends Error {
  public readonly code: string
  public readonly statusCode: number

  constructor(message: string, code: string = 'GATEWAY_INTEGRATION_ERROR', statusCode: number = 400) {
    super(message)
    this.name = 'GatewayIntegrationError'
    this.code = code
    this.statusCode = statusCode
  }
}

export interface ChallengeData {
  serviceId: string
  requestId: Hex
  quotedPrice: string
  quotedPriceFormatted: string
  chainId: number
  contract: Address
  usdcToken: Address
  method: string
  path: string
  bodyDigest: Hex
  expiresAt: number
}

export interface GatewayChallengeResult {
  status: 402
  challenge: ChallengeData
}

export interface GatewaySuccessResult {
  status: 200
  payload: unknown
  txHash: Hex
  requestId: Hex
  caller: Address
  amountPaid: string
  blockNumber: string
  isCached: boolean
}

export interface GatewayHealthStatus {
  online: boolean
  mockRpc: boolean
  upstreamMode: 'mock' | 'http' | 'unknown'
  chainId?: number
  contract?: Address
  demoNotice?: string
}

/**
 * Computes the Keccak-256 digest of an HTTP request body string,
 * matching `keccak256(toHex(bodyStr || ''))` in `src/gateway/server.ts`.
 */
export function computeBodyDigest(body: string = ''): Hex {
  return keccak256(toHex(body || ''))
}

/**
 * Normalizes a gateway sub-path so client and gateway path bindings match exactly.
 */
export function normalizeGatewaySubPath(subPath: string = ''): string {
  if (!subPath || subPath === '/') return '/'
  return subPath.startsWith('/') ? subPath : `/${subPath}`
}

/**
 * Validates that a challenge object is an authoritative, non-synthetic gateway challenge
 * and matches the expected request parameters.
 */
export function validateAuthoritativeChallenge(
  challenge: unknown,
  expected?: {
    serviceId?: bigint
    method?: string
    subPath?: string
    body?: string
  }
): ChallengeData {
  if (!challenge || typeof challenge !== 'object') {
    throw new GatewayIntegrationError(
      'Gateway response is missing a challenge object',
      'INVALID_CHALLENGE',
      502
    )
  }

  const c = challenge as Partial<ChallengeData>

  if (typeof c.requestId !== 'string' || !BYTES32_HEX_REGEX.test(c.requestId)) {
    throw new GatewayIntegrationError(
      'Challenge requestId is missing or not a valid 32-byte hex string',
      'INVALID_CHALLENGE_REQUEST_ID',
      502
    )
  }

  if (c.requestId.toLowerCase() === ZERO_BYTES32) {
    throw new GatewayIntegrationError(
      'Zero-filled requestId is forbidden in payment challenges',
      'ZERO_REQUEST_ID_FORBIDDEN',
      400
    )
  }

  if (typeof c.bodyDigest !== 'string' || !BYTES32_HEX_REGEX.test(c.bodyDigest)) {
    throw new GatewayIntegrationError(
      'Challenge bodyDigest is missing or not a valid 32-byte hex string',
      'INVALID_CHALLENGE_BODY_DIGEST',
      502
    )
  }

  if (c.bodyDigest.toLowerCase() === ZERO_BYTES32) {
    throw new GatewayIntegrationError(
      'Zero-filled bodyDigest (0x0000...0000) is forbidden; bodyDigest must be a valid Keccak-256 hash',
      'ZERO_BODY_DIGEST_FORBIDDEN',
      400
    )
  }

  if (typeof c.serviceId !== 'string' || !/^\d+$/.test(c.serviceId)) {
    throw new GatewayIntegrationError(
      'Challenge serviceId is missing or invalid',
      'INVALID_CHALLENGE_SERVICE_ID',
      502
    )
  }

  if (typeof c.quotedPrice !== 'string' || !/^\d+$/.test(c.quotedPrice)) {
    throw new GatewayIntegrationError(
      'Challenge quotedPrice is missing or invalid',
      'INVALID_CHALLENGE_PRICE',
      502
    )
  }

  const priceBigInt = BigInt(c.quotedPrice)
  if (priceBigInt < 20n) {
    throw new GatewayIntegrationError(
      `Challenge quotedPrice (${c.quotedPrice}) is below minimum 20 base units`,
      'INVALID_CHALLENGE_PRICE',
      400
    )
  }

  if (typeof c.method !== 'string' || !c.method.trim()) {
    throw new GatewayIntegrationError('Challenge HTTP method is missing', 'INVALID_CHALLENGE_METHOD', 502)
  }

  if (typeof c.path !== 'string' || !c.path.startsWith('/')) {
    throw new GatewayIntegrationError('Challenge path is missing or invalid', 'INVALID_CHALLENGE_PATH', 502)
  }

  if (typeof c.expiresAt !== 'number' || !Number.isFinite(c.expiresAt) || c.expiresAt <= Date.now()) {
    throw new GatewayIntegrationError(
      'Challenge has already expired or has an invalid expiresAt timestamp',
      'CHALLENGE_EXPIRED',
      402
    )
  }

  if (c.chainId !== 5042002 && c.chainId !== 5042) {
    throw new GatewayIntegrationError(
      `Challenge chainId (${String(c.chainId)}) does not match supported Arc networks (5042002, 5042)`,
      'WRONG_CHAIN',
      400
    )
  }

  const net = getNetworkConfig(c.chainId)
  const expectedContract = net.contractAddress || PAYGATE_EIP712_DOMAIN.verifyingContract
  if (
    typeof c.contract !== 'string' ||
    c.contract.toLowerCase() !== expectedContract.toLowerCase()
  ) {
    throw new GatewayIntegrationError(
      `Challenge contract (${String(c.contract)}) does not match PayGate402 on ${net.chainName} (${expectedContract})`,
      'WRONG_CONTRACT',
      400
    )
  }

  if (expected) {
    if (expected.serviceId !== undefined && c.serviceId !== expected.serviceId.toString()) {
      throw new GatewayIntegrationError(
        `Challenge serviceId (${c.serviceId}) does not match requested serviceId (${expected.serviceId.toString()})`,
        'SERVICE_ID_MISMATCH',
        400
      )
    }

    if (expected.method !== undefined && c.method.toUpperCase() !== expected.method.toUpperCase()) {
      throw new GatewayIntegrationError(
        `Challenge method (${c.method}) does not match requested method (${expected.method})`,
        'METHOD_MISMATCH',
        400
      )
    }

    if (expected.subPath !== undefined) {
      const cleanExpected = normalizeGatewaySubPath(expected.subPath)
      if (c.path !== cleanExpected) {
        throw new GatewayIntegrationError(
          `Challenge path (${c.path}) does not match requested path (${cleanExpected})`,
          'PATH_MISMATCH',
          400
        )
      }
    }

    if (expected.body !== undefined) {
      const expectedDigest = computeBodyDigest(expected.body)
      if (c.bodyDigest.toLowerCase() !== expectedDigest.toLowerCase()) {
        throw new GatewayIntegrationError(
          `Challenge bodyDigest (${c.bodyDigest}) does not match Keccak-256 digest of request body (${expectedDigest})`,
          'BODY_DIGEST_MISMATCH',
          400
        )
      }
    }
  }

  return c as ChallengeData
}

/**
 * Checks if the local/testnet gateway server is online and inspects its operating mode.
 */
export async function checkGatewayStatus(gatewayUrl: string = GATEWAY_BASE_URL): Promise<GatewayHealthStatus> {
  try {
    const res = await fetch(`${gatewayUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) {
      return { online: false, mockRpc: false, upstreamMode: 'unknown' }
    }
    const data = (await res.json()) as {
      status?: string
      mockRpc?: boolean
      upstreamMode?: 'mock' | 'http'
      chainId?: number
      contract?: Address
      demoNotice?: string
    }
    return {
      online: data.status === 'healthy',
      mockRpc: Boolean(data.mockRpc),
      upstreamMode: data.upstreamMode ?? 'unknown',
      chainId: data.chainId,
      contract: data.contract,
      demoNotice: data.demoNotice,
    }
  } catch {
    return { online: false, mockRpc: false, upstreamMode: 'unknown' }
  }
}

/**
 * Checks if the local/testnet gateway server is online
 */
export async function checkGatewayHealth(gatewayUrl: string = GATEWAY_BASE_URL): Promise<boolean> {
  const status = await checkGatewayStatus(gatewayUrl)
  return status.online
}

/**
 * Verifies that the connected consumer wallet is a standard EOA (no deployed contract bytecode).
 * The PayGate402 Gateway verifier requires `tx.to == PayGate402`, selector `0xed38c2de`, and `tx.from == eventCaller`.
 * Smart contract wallets / ERC-4337 bundlers fail verification and must be blocked before spending USDC.
 */
export async function checkConsumerWalletCompatibility(params: {
  address: Address
  getBytecode?: (address: Address) => Promise<Hex | undefined>
}): Promise<void> {
  const { address, getBytecode } = params
  if (!getBytecode) return

  const bytecode = await getBytecode(address)
  if (bytecode && bytecode !== '0x' && bytecode.length > 2) {
    throw new GatewayIntegrationError(
      `Wallet ${address} is a smart contract account (bytecode detected). The PayGate402 Gateway verifier requires direct EOA transactions where tx.from matches the caller and tx.to targets PayGate402 directly. Connect a standard EOA wallet (e.g. MetaMask).`,
      'SMART_ACCOUNT_UNSUPPORTED',
      400
    )
  }
}

/**
 * Initiates the HTTP 402 challenge for a target service endpoint.
 * Fails closed if the gateway is unreachable, returns a non-402 error (such as 400 SERVICE_NOT_FOUND),
 * or returns a malformed challenge.
 */
export async function requestPaymentChallenge(params: {
  serviceId: bigint
  subPath?: string
  method?: string
  body?: string
  payerAddress?: Address
  gatewayUrl?: string
}): Promise<GatewayChallengeResult> {
  const {
    serviceId,
    subPath = '',
    method = 'POST',
    body = '',
    payerAddress,
    gatewayUrl = GATEWAY_BASE_URL,
  } = params
  const cleanPath = normalizeGatewaySubPath(subPath)
  const targetUrl = `${gatewayUrl}/v1/gateway/${serviceId.toString()}${cleanPath}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (payerAddress) {
    headers['X-Payment-Payer'] = payerAddress
  }

  let res: Response
  try {
    res = await fetch(targetUrl, {
      method: method.toUpperCase(),
      headers,
      body: method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD' ? body : undefined,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new GatewayIntegrationError(
      `PayGate402 Gateway is unreachable at ${gatewayUrl}: ${msg}`,
      'GATEWAY_OFFLINE',
      503
    )
  }

  if (res.status === 402) {
    const data = (await res.json()) as { challenge?: unknown }
    const effectiveBody = method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD' ? body : ''
    const validated = validateAuthoritativeChallenge(data.challenge, {
      serviceId,
      method: method.toUpperCase(),
      subPath: cleanPath,
      body: effectiveBody,
    })
    return {
      status: 402,
      challenge: validated,
    }
  }

  const errData = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
  throw new GatewayIntegrationError(
    errData.error || `Expected HTTP 402 challenge from gateway, received status ${res.status}`,
    errData.code || 'CHALLENGE_ISSUANCE_FAILED',
    res.status
  )
}

/**
 * Fail-closed preflight for live wallet payment flows (ServiceCard, FlowDashboard, AgentCLI).
 * Verifies:
 * 1. Consumer wallet EOA compatibility (rejects smart contract / ERC-4337 wallets).
 * 2. Gateway online status.
 * 3. Gateway is not in mock RPC mode (unless `allowMockRpc` is explicitly true for offline simulation).
 * 4. Gateway issues a valid HTTP 402 challenge for the target service and endpoint.
 */
export async function prepareLivePaymentChallenge(params: {
  serviceId: bigint
  subPath?: string
  method?: string
  body?: string
  payerAddress: Address
  gatewayUrl?: string
  allowMockRpc?: boolean
  getBytecode?: (address: Address) => Promise<Hex | undefined>
}): Promise<{ challenge: ChallengeData; health: GatewayHealthStatus }> {
  const {
    serviceId,
    subPath = '',
    method = 'POST',
    body = '',
    payerAddress,
    gatewayUrl = GATEWAY_BASE_URL,
    allowMockRpc = false,
    getBytecode,
  } = params

  // 1. EOA Compatibility Check
  await checkConsumerWalletCompatibility({ address: payerAddress, getBytecode })

  // 2. Gateway Health & Mode Check
  const health = await checkGatewayStatus(gatewayUrl)
  if (!health.online) {
    throw new GatewayIntegrationError(
      `PayGate402 Gateway server is unreachable at ${gatewayUrl}. Live wallet transactions are blocked because an authoritative HTTP 402 challenge cannot be obtained.`,
      'GATEWAY_OFFLINE',
      503
    )
  }

  if (health.mockRpc && !allowMockRpc) {
    throw new GatewayIntegrationError(
      'SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED: Gateway is currently running in Mock RPC mode (mockRpc: true). Live wallet transactions are blocked to prevent spending real Arc Testnet USDC against offline mock fixtures.',
      'GATEWAY_IN_MOCK_MODE',
      400
    )
  }

  // 3. Request & Validate Authoritative HTTP 402 Challenge
  const { challenge } = await requestPaymentChallenge({
    serviceId,
    subPath,
    method,
    body,
    payerAddress,
    gatewayUrl,
  })

  return { challenge, health }
}

/**
 * Constructs the EIP-712 `PayGateAuthorization` message strictly from a validated gateway challenge.
 * Rejects synthetic challenges, zero-filled body digests, or expired challenges.
 */
export function buildEip712AuthorizationMessage(challenge: ChallengeData, txHash: Hex) {
  const validated = validateAuthoritativeChallenge(challenge)
  if (!BYTES32_HEX_REGEX.test(txHash) || txHash.toLowerCase() === ZERO_BYTES32) {
    throw new GatewayIntegrationError(
      'Invalid payment transaction hash for EIP-712 authorization',
      'INVALID_TX_HASH',
      400
    )
  }

  return {
    serviceId: BigInt(validated.serviceId),
    requestId: validated.requestId,
    txHash,
    method: validated.method,
    path: validated.path,
    bodyDigest: validated.bodyDigest,
    quotedPrice: BigInt(validated.quotedPrice),
    expiresAt: BigInt(validated.expiresAt),
  }
}

/**
 * Submits on-chain payment proof and cryptographic signature to unlock protected resource.
 * Validates challenge integrity before sending request to the gateway.
 */
export async function submitPaymentToGateway(params: {
  serviceId: bigint
  subPath?: string
  method?: string
  body?: string
  txHash: Hex
  requestId: Hex
  signature: Hex
  payerAddress: Address
  gatewayUrl?: string
}): Promise<GatewaySuccessResult> {
  const {
    serviceId,
    subPath = '',
    method = 'POST',
    body = '',
    txHash,
    requestId,
    signature,
    payerAddress,
    gatewayUrl = GATEWAY_BASE_URL,
  } = params

  if (!BYTES32_HEX_REGEX.test(requestId) || requestId.toLowerCase() === ZERO_BYTES32) {
    throw new GatewayIntegrationError(
      'Invalid or zero-filled requestId supplied for gateway authorization',
      'INVALID_CHALLENGE_REQUEST_ID',
      400
    )
  }

  const cleanPath = normalizeGatewaySubPath(subPath)
  const targetUrl = `${gatewayUrl}/v1/gateway/${serviceId.toString()}${cleanPath}`
  const upperMethod = method.toUpperCase()

  const res = await fetch(targetUrl, {
    method: upperMethod,
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-TxHash': txHash,
      'X-Payment-RequestId': requestId,
      'X-Payment-Signature': signature,
      'X-Payment-Payer': payerAddress,
    },
    body: upperMethod !== 'GET' && upperMethod !== 'HEAD' ? body : undefined,
  })

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Unknown verification error' }))) as {
      error?: string
      code?: string
    }
    throw new GatewayIntegrationError(
      errorData.error || `Gateway returned HTTP ${res.status}`,
      errorData.code || 'VERIFICATION_FAILED',
      res.status
    )
  }

  const isCached = res.headers.get('X-PayGate-Status') === 'VERIFIED_ONCHAIN_CACHED'
  const caller = (res.headers.get('X-PayGate-Caller') as Address) || payerAddress
  const amountPaid = res.headers.get('X-PayGate-Amount-Paid') || '0'
  const blockNumber = res.headers.get('X-PayGate-Block-Number') || '0'
  const payload: unknown = await res.json()

  return {
    status: 200,
    payload,
    txHash,
    requestId,
    caller,
    amountPaid,
    blockNumber,
    isCached,
  }
}

/**
 * End-to-end post-payment gateway authorization helper used by ServiceCard, FlowDashboard, and AgentCLI.
 * Ensures a transaction receipt alone NEVER unlocks access; requires EIP-712 signing of the authoritative
 * challenge and HTTP 200 verification from the Gateway.
 */
export async function authorizeConfirmedPaymentWithGateway(params: {
  challenge: ChallengeData
  txHash: Hex
  payerAddress: Address
  body?: string
  gatewayUrl?: string
  signTypedData: (args: {
    domain: {
      name: string
      version: string
      chainId: number
      verifyingContract: Address
    }
    types: typeof PAYGATE_EIP712_TYPES
    primaryType: 'PayGateAuthorization'
    message: ReturnType<typeof buildEip712AuthorizationMessage>
  }) => Promise<Hex>
}): Promise<GatewaySuccessResult> {
  const { challenge, txHash, payerAddress, body = '', gatewayUrl = GATEWAY_BASE_URL, signTypedData } = params

  const effectiveBody =
    challenge.method.toUpperCase() !== 'GET' && challenge.method.toUpperCase() !== 'HEAD' ? body : ''
  const validated = validateAuthoritativeChallenge(challenge, {
    serviceId: BigInt(challenge.serviceId),
    method: challenge.method,
    subPath: challenge.path,
    body: effectiveBody,
  })

  const message = buildEip712AuthorizationMessage(validated, txHash)

  const domain = {
    name: 'PayGate402 Gateway',
    version: '1',
    chainId: validated.chainId,
    verifyingContract: validated.contract,
  }

  const signature = await signTypedData({
    domain,
    types: PAYGATE_EIP712_TYPES,
    primaryType: 'PayGateAuthorization',
    message,
  })

  return submitPaymentToGateway({
    serviceId: BigInt(validated.serviceId),
    subPath: validated.path,
    method: validated.method,
    body: effectiveBody,
    txHash,
    requestId: validated.requestId,
    signature,
    payerAddress,
    gatewayUrl,
  })
}
