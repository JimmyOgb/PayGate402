/**
 * PayGate402 Event Decoder
 * Provides strict, ABI-compliant decoding of on-chain ServiceRegistered events.
 * Enforces transaction success status, emitter address validation, uniqueness, and argument bounds.
 */
import { decodeEventLog, parseAbiItem, type Log, type TransactionReceipt, type Address } from 'viem'

export interface DecodedServiceRegistered {
  serviceId: bigint
  provider: Address
  name: string
  priceInUsdc: bigint
}

export type EventDecodeResult =
  | { success: true; data: DecodedServiceRegistered }
  | { success: false; error: string; code: string }

export const SERVICE_REGISTERED_TOPIC0 =
  '0x67be3c810154c389fd2646b1c47628f982539f07681810b2d5f736f6df245a08' as const

export const SERVICE_REGISTERED_EVENT = parseAbiItem(
  'event ServiceRegistered(uint256 indexed serviceId, address indexed provider, string name, uint256 priceInUsdc)'
)

/**
 * Validates a transaction receipt and decodes the unique ServiceRegistered event.
 * Rejects failed transactions, wrong emitting contracts, missing events, and ambiguous multiple events.
 */
export function decodeServiceRegisteredReceipt(
  receipt: TransactionReceipt,
  expectedContractAddress: Address
): EventDecodeResult {
  if (receipt.status !== 'success') {
    return {
      success: false,
      error: `Transaction status is "${receipt.status}" (reverted or not confirmed)`,
      code: 'TX_NOT_SUCCESS',
    }
  }

  const matchingLogs = (receipt.logs || []).filter(
    (log: Log) =>
      log.address.toLowerCase() === expectedContractAddress.toLowerCase() &&
      log.topics[0]?.toLowerCase() === SERVICE_REGISTERED_TOPIC0.toLowerCase()
  )

  if (matchingLogs.length === 0) {
    return {
      success: false,
      error: `No ServiceRegistered event emitted by contract ${expectedContractAddress}`,
      code: 'EVENT_NOT_FOUND',
    }
  }

  if (matchingLogs.length > 1) {
    return {
      success: false,
      error: `Ambiguous receipt: found ${matchingLogs.length} ServiceRegistered events in a single transaction`,
      code: 'AMBIGUOUS_EVENTS',
    }
  }

  const log = matchingLogs[0]

  try {
    const decoded = decodeEventLog({
      abi: [SERVICE_REGISTERED_EVENT],
      eventName: 'ServiceRegistered',
      data: log.data,
      topics: log.topics,
    })

    if (!decoded.args) {
      return {
        success: false,
        error: 'ServiceRegistered event arguments are missing or malformed',
        code: 'MALFORMED_EVENT_ARGS',
      }
    }

    const { serviceId, provider, name, priceInUsdc } = decoded.args

    if (serviceId === undefined || !provider || name === undefined || priceInUsdc === undefined) {
      return {
        success: false,
        error: 'Decoded ServiceRegistered event is missing required fields',
        code: 'MISSING_EVENT_FIELDS',
      }
    }

    return {
      success: true,
      data: {
        serviceId,
        provider,
        name,
        priceInUsdc,
      },
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error: `Failed to decode ServiceRegistered event ABI: ${msg}`,
      code: 'DECODE_EXCEPTION',
    }
  }
}
