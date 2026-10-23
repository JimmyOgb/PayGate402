/**
 * Deterministic Mock RPC Client for Offline Testing and $0 Local Simulation
 * SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED
 */
import type { Address, Hex, Log, Transaction, TransactionReceipt } from 'viem'
import {
  encodeAbiParameters,
  encodeFunctionData,
  pad,
  parseAbiParameters,
  toHex,
} from 'viem'
import {
  ACCESS_GRANTED_TOPIC0,
  ARC_TESTNET_CHAIN_ID,
  PAYGATE402_CONTRACT_ADDRESS,
} from './types.ts'
import {
  VerificationError,
  loadContractAbi,
  type RpcClientInterface,
  type ServiceInfo,
} from './verifier.ts'

const artifact = { abi: loadContractAbi() }

export class MockRpcClient implements RpcClientInterface {
  public chainId: number = ARC_TESTNET_CHAIN_ID
  public blockNumber: bigint = 50000n
  public transactions = new Map<string, Transaction>()
  public receipts = new Map<string, TransactionReceipt>()
  public prices = new Map<string, bigint>([
    ['0', 100_000n], // 0.10 USDC
    ['1', 500_000n], // 0.50 USDC
  ])
  public throwOnRpc = false

  getChainId(): Promise<number> {
    if (this.throwOnRpc) return Promise.reject(new Error('RPC connection refused: connection timed out'))
    return Promise.resolve(this.chainId)
  }

  getBlockNumber(): Promise<bigint> {
    if (this.throwOnRpc) return Promise.reject(new Error('RPC connection refused: connection timed out'))
    return Promise.resolve(this.blockNumber)
  }

  getTransaction(txHash: Hex): Promise<Transaction | null> {
    if (this.throwOnRpc) return Promise.reject(new Error('RPC connection refused: connection timed out'))
    return Promise.resolve(this.transactions.get(txHash.toLowerCase()) ?? null)
  }

  getTransactionReceipt(txHash: Hex): Promise<TransactionReceipt | null> {
    if (this.throwOnRpc) return Promise.reject(new Error('RPC connection refused: connection timed out'))
    return Promise.resolve(this.receipts.get(txHash.toLowerCase()) ?? null)
  }

  getServicePrice(serviceId: bigint): Promise<bigint> {
    if (this.throwOnRpc) return Promise.reject(new Error('RPC connection refused: connection timed out'))
    const price = this.prices.get(serviceId.toString())
    if (price === undefined) {
      return Promise.reject(
        new VerificationError(
          `Service ID ${serviceId} does not exist on PayGate402 contract`,
          400,
          'SERVICE_NOT_FOUND'
        )
      )
    }
    return Promise.resolve(price)
  }

  getService(serviceId: bigint): Promise<ServiceInfo | null> {
    if (this.throwOnRpc) return Promise.reject(new Error('RPC connection refused: connection timed out'))
    const price = this.prices.get(serviceId.toString())
    if (price === undefined) return Promise.resolve(null)
    return Promise.resolve({
      serviceId,
      provider: '0x5b12ce46c7194ad57d143bc22847224047b1ef42',
      name: `Simulated Demo Service ${serviceId}`,
      endpointDescription: 'SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED',
      priceInUsdc: price,
      active: true,
    })
  }

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
      blockNumber = 49995n,
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
