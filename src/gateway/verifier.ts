/**
 * Blockchain Payment & Cryptographic Verifier
 * Validates receipts, confirmation depth, contract address, function input,
 * AccessGranted events, on-chain price quotes, and EIP-712 wallet signatures.
 */
import {
  createPublicClient,
  http,
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  parseAbiParameters,
  verifyTypedData,
  type Address,
  type Hex,
  type Log,
  type Transaction,
  type TransactionReceipt,
} from 'viem'
import {
  ACCESS_GRANTED_TOPIC0,
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  PAY_FOR_ACCESS_SELECTOR,
  PAYGATE_EIP712_TYPES,
  PAYGATE402_CONTRACT_ADDRESS,
  buildEip712Domain,
  type PaymentChallenge,
} from './types.ts'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const artifact = require('../../contracts/out/PayGate402.sol/PayGate402.json') as { abi: readonly unknown[] }

export interface ServiceInfo {
  serviceId: bigint
  provider: Address
  name: string
  endpointDescription: string
  priceInUsdc: bigint
  active: boolean
}

export interface RpcClientInterface {
  getChainId(): Promise<number>
  getBlockNumber(): Promise<bigint>
  getTransaction(txHash: Hex): Promise<Transaction | null>
  getTransactionReceipt(txHash: Hex): Promise<TransactionReceipt | null>
  getServicePrice(serviceId: bigint): Promise<bigint>
  getService?(serviceId: bigint): Promise<ServiceInfo | null>
}

export class ViemRpcClient implements RpcClientInterface {
  private client: ReturnType<typeof createPublicClient>
  private contractAddress: Address

  constructor(
    rpcUrl: string = 'https://rpc.testnet.arc.io',
    contractAddress: Address = PAYGATE402_CONTRACT_ADDRESS
  ) {
    this.client = createPublicClient({
      transport: http(rpcUrl),
    })
    this.contractAddress = contractAddress
  }

  async getChainId(): Promise<number> {
    return this.client.getChainId()
  }

  async getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber()
  }

  async getTransaction(txHash: Hex): Promise<Transaction | null> {
    try {
      const tx = await this.client.getTransaction({ hash: txHash })
      return tx
    } catch {
      return null
    }
  }

  async getTransactionReceipt(txHash: Hex): Promise<TransactionReceipt | null> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: txHash })
      return receipt
    } catch {
      return null
    }
  }

  async getService(serviceId: bigint): Promise<ServiceInfo | null> {
    try {
      const nextId = (await this.client.readContract({
        address: this.contractAddress,
        abi: artifact.abi,
        functionName: 'nextServiceId',
      })) as bigint

      if (serviceId >= nextId) {
        return null
      }

      const res = (await this.client.readContract({
        address: this.contractAddress,
        abi: artifact.abi,
        functionName: 'services',
        args: [serviceId],
      })) as readonly [bigint, Address, string, string, bigint, string, boolean, bigint, bigint]

      return {
        serviceId: res[0],
        provider: res[1],
        name: res[2],
        endpointDescription: res[3],
        priceInUsdc: res[4],
        active: res[6],
      }
    } catch {
      return null
    }
  }

  async getServicePrice(serviceId: bigint): Promise<bigint> {
    const service = await this.getService(serviceId)
    if (!service) {
      throw new VerificationError(
        `Service ${serviceId.toString()} does not exist on-chain`,
        400,
        'SERVICE_NOT_FOUND'
      )
    }
    if (!service.active) {
      throw new VerificationError(
        `Service ${serviceId.toString()} is currently paused/inactive`,
        400,
        'SERVICE_INACTIVE'
      )
    }
    if (service.priceInUsdc < 20n) {
      throw new VerificationError(
        `Service price (${service.priceInUsdc}) is invalid (minimum 20 base units required)`,
        400,
        'INVALID_PRICE'
      )
    }
    return service.priceInUsdc
  }
}

export class VerificationError extends Error {
  public readonly statusCode: number
  public readonly code: string

  constructor(message: string, statusCode: number = 402, code: string = 'VERIFICATION_FAILED') {
    super(message)
    this.name = 'VerificationError'
    this.statusCode = statusCode
    this.code = code
  }
}

export class BlockchainVerifier {
  private readonly rpc: RpcClientInterface
  private readonly minConfirmations: number
  public readonly contractAddress: Address
  public readonly chainId: number

  constructor(
    rpc: RpcClientInterface,
    minConfirmations: number = 1,
    contractAddress: Address = PAYGATE402_CONTRACT_ADDRESS,
    chainId: number = ARC_TESTNET_CHAIN_ID
  ) {
    this.rpc = rpc
    this.minConfirmations = minConfirmations
    this.contractAddress = contractAddress
    this.chainId = chainId
  }

  /**
   * Verifies the on-chain payment and cryptographic binding against the persisted challenge.
   */
  public async verifyPayment(params: {
    txHash: Hex
    challenge: PaymentChallenge
    signature: Hex
    currentPath: string
    currentMethod: string
    currentBodyDigest: Hex
  }): Promise<{
    verifiedCaller: Address
    amountPaid: bigint
    blockNumber: bigint
  }> {
    const { txHash, challenge, signature, currentPath, currentMethod, currentBodyDigest } = params

    // 1. Verify Request Binding Against Persisted Challenge
    if (challenge.path !== currentPath) {
      throw new VerificationError(
        `Path mismatch: challenge was issued for ${challenge.path}, got ${currentPath}`,
        400,
        'PATH_MISMATCH'
      )
    }

    if (challenge.method.toUpperCase() !== currentMethod.toUpperCase()) {
      throw new VerificationError(
        `Method mismatch: challenge was issued for ${challenge.method}, got ${currentMethod}`,
        400,
        'METHOD_MISMATCH'
      )
    }

    if (challenge.bodyDigest.toLowerCase() !== currentBodyDigest.toLowerCase()) {
      throw new VerificationError(
        'Request body digest mismatch: payload has been modified',
        400,
        'BODY_DIGEST_MISMATCH'
      )
    }

    // 2. Verify Expiry
    if (Date.now() > challenge.expiresAt) {
      throw new VerificationError('Payment challenge has expired. Request a new challenge.', 402, 'CHALLENGE_EXPIRED')
    }

    // 3. Verify Chain ID
    const chainId = await this.rpc.getChainId()
    if (chainId !== this.chainId) {
      const expectedName = this.chainId === ARC_MAINNET_CHAIN_ID ? 'Arc Mainnet' : 'Arc Testnet'
      throw new VerificationError(
        `RPC chain ID ${chainId} does not match expected ${expectedName} (${this.chainId})`,
        400,
        'WRONG_CHAIN'
      )
    }

    // 4. Query Transaction and Validate Target Contract & Input Selector
    const tx = await this.rpc.getTransaction(txHash)
    if (!tx) {
      throw new VerificationError(`Transaction ${txHash} not found in mempool or blocks`, 402, 'TX_NOT_FOUND')
    }

    if (!tx.to || tx.to.toLowerCase() !== this.contractAddress.toLowerCase()) {
      throw new VerificationError(
        `Transaction target ${tx.to} does not match expected contract ${this.contractAddress}`,
        402,
        'WRONG_CONTRACT'
      )
    }

    // Validate Input Data: must be payForAccess(serviceId, requestId)
    if (!tx.input || !tx.input.startsWith(PAY_FOR_ACCESS_SELECTOR)) {
      throw new VerificationError(
        `Transaction input selector does not match payForAccess (${PAY_FOR_ACCESS_SELECTOR})`,
        402,
        'WRONG_METHOD'
      )
    }

    try {
      const decodedInput = decodeFunctionData({
        abi: artifact.abi,
        data: tx.input,
      })

      if (decodedInput.functionName !== 'payForAccess') {
        throw new VerificationError('Decoded function name is not payForAccess', 402, 'WRONG_METHOD')
      }

      const [inputServiceId, inputRequestId] = decodedInput.args as [bigint, Hex]

      if (inputServiceId !== challenge.serviceId) {
        throw new VerificationError(
          `Input serviceId ${inputServiceId} does not match challenge serviceId ${challenge.serviceId}`,
          402,
          'SERVICE_ID_MISMATCH'
        )
      }

      if (inputRequestId.toLowerCase() !== challenge.requestId.toLowerCase()) {
        throw new VerificationError(
          `Input requestId ${inputRequestId} does not match challenge requestId ${challenge.requestId}`,
          402,
          'REQUEST_ID_MISMATCH'
        )
      }
    } catch (err: unknown) {
      if (err instanceof VerificationError) throw err
      throw new VerificationError('Failed to decode transaction input data', 402, 'INPUT_DECODE_ERROR')
    }

    // 5. Query Transaction Receipt and Check Status & Confirmations
    const receipt = await this.rpc.getTransactionReceipt(txHash)
    if (!receipt) {
      throw new VerificationError(
        `Transaction ${txHash} is still pending. Wait for on-chain block inclusion.`,
        402,
        'TX_PENDING'
      )
    }

    if (receipt.status !== 'success') {
      throw new VerificationError(`Transaction ${txHash} reverted on-chain`, 402, 'TX_REVERTED')
    }

    const currentBlock = await this.rpc.getBlockNumber()
    const confirmations = currentBlock >= receipt.blockNumber ? currentBlock - receipt.blockNumber + 1n : 0n

    if (confirmations < BigInt(this.minConfirmations)) {
      throw new VerificationError(
        `Transaction has ${confirmations} confirmations; required: ${this.minConfirmations}`,
        402,
        'INSUFFICIENT_CONFIRMATIONS'
      )
    }

    // 6. Decode and Validate AccessGranted Event
    const matchingLogs = (receipt.logs || []).filter(
      (l: Log) =>
        l.address.toLowerCase() === this.contractAddress.toLowerCase() &&
        l.topics[0]?.toLowerCase() === ACCESS_GRANTED_TOPIC0.toLowerCase()
    )

    if (matchingLogs.length === 0) {
      throw new VerificationError(
        'Transaction receipt contains no AccessGranted event from PayGate402 contract',
        402,
        'EVENT_NOT_FOUND'
      )
    }

    if (matchingLogs.length > 1) {
      throw new VerificationError('Transaction receipt contains multiple AccessGranted events', 402, 'MULTIPLE_EVENTS')
    }

    const log = matchingLogs[0]

    // Decode Indexed Topics:
    // topic 1: serviceId (uint256)
    // topic 2: caller (address)
    // topic 3: requestId (bytes32)
    if (!log.topics[1] || !log.topics[2] || !log.topics[3]) {
      throw new VerificationError('AccessGranted event is missing required indexed topics', 402, 'MALFORMED_EVENT')
    }

    const eventServiceId = BigInt(log.topics[1])
    // The address is right-aligned in 32 bytes (offset 24 to 64 hex chars = 12 to 32 bytes)
    const rawCallerTopic = log.topics[2]
    const eventCaller = getAddress(`0x${rawCallerTopic.slice(26)}`)
    const eventRequestId = log.topics[3]

    // Decode Data: (uint256 amountPaid, uint256 timestamp)
    let eventAmountPaid: bigint
    try {
      const decodedData = decodeAbiParameters(
        parseAbiParameters('uint256 amountPaid, uint256 timestamp'),
        log.data
      )
      eventAmountPaid = decodedData[0]
    } catch {
      throw new VerificationError('Failed to decode AccessGranted event data parameters', 402, 'EVENT_DATA_DECODE_ERROR')
    }

    // Match Event Fields Against Challenge
    if (eventServiceId !== challenge.serviceId) {
      throw new VerificationError(
        `Event serviceId ${eventServiceId} does not match challenge ${challenge.serviceId}`,
        402,
        'EVENT_SERVICE_MISMATCH'
      )
    }

    if (eventRequestId.toLowerCase() !== challenge.requestId.toLowerCase()) {
      throw new VerificationError(
        `Event requestId ${eventRequestId} does not match challenge ${challenge.requestId}`,
        402,
        'EVENT_REQUEST_MISMATCH'
      )
    }

    if (challenge.payer && eventCaller.toLowerCase() !== challenge.payer.toLowerCase()) {
      throw new VerificationError(
        `Event caller ${eventCaller} does not match challenge payer ${challenge.payer}`,
        401,
        'CALLER_MISMATCH'
      )
    }

    // Match amount paid against challenge quoted price
    if (eventAmountPaid < challenge.quotedPrice) {
      throw new VerificationError(
        `Amount paid (${eventAmountPaid}) is less than quoted price (${challenge.quotedPrice})`,
        402,
        'INSUFFICIENT_AMOUNT'
      )
    }

    // Check against current on-chain price (handles price changes during challenge lifetime)
    const currentPrice = await this.rpc.getServicePrice(challenge.serviceId)
    if (eventAmountPaid < currentPrice) {
      throw new VerificationError(
        `Service price increased to ${currentPrice} base units; payment of ${eventAmountPaid} is insufficient`,
        402,
        'PRICE_CHANGED'
      )
    }

    // 7. Verify EIP-712 Wallet Signature
    const eip712Message = {
      serviceId: challenge.serviceId,
      requestId: challenge.requestId,
      txHash: txHash,
      method: challenge.method,
      path: challenge.path,
      bodyDigest: challenge.bodyDigest,
      quotedPrice: challenge.quotedPrice,
      expiresAt: BigInt(challenge.expiresAt),
    }

    const domain = buildEip712Domain(this.chainId, this.contractAddress)
    let isValidSignature = false
    try {
      isValidSignature = await verifyTypedData({
        address: eventCaller,
        domain,
        types: PAYGATE_EIP712_TYPES,
        primaryType: 'PayGateAuthorization',
        message: eip712Message,
        signature,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new VerificationError(`Signature verification failed: ${msg}`, 401, 'INVALID_SIGNATURE')
    }

    if (!isValidSignature) {
      throw new VerificationError(
        'Wallet signature is invalid or was not signed by the payment caller address',
        401,
        'SIGNER_MISMATCH'
      )
    }

    // Also assert that the signer is the transaction broadcaster (tx.from)
    if (tx.from.toLowerCase() !== eventCaller.toLowerCase()) {
      throw new VerificationError(
        `Transaction broadcaster (${tx.from}) does not match event caller (${eventCaller})`,
        401,
        'BROADCASTER_MISMATCH'
      )
    }

    return {
      verifiedCaller: eventCaller,
      amountPaid: eventAmountPaid,
      blockNumber: receipt.blockNumber,
    }
  }
}
