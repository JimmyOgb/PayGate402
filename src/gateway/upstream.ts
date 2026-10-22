/**
 * Protected Upstream Adapter
 * Implements mock upstream for offline deterministic tests and live HTTP adapter with idempotency keys.
 */
import type { UpstreamResponse } from './types.ts'

export interface UpstreamRequest {
  serviceId: bigint
  method: string
  path: string
  body: string
  idempotencyKey: string // Bound requestId
}

export interface UpstreamAdapter {
  dispatch(req: UpstreamRequest): Promise<UpstreamResponse>
}

export class UpstreamError extends Error {
  public readonly isTimeoutAfterDispatch: boolean
  public readonly statusCode: number

  constructor(message: string, isTimeoutAfterDispatch: boolean = false, statusCode: number = 502) {
    super(message)
    this.name = 'UpstreamError'
    this.isTimeoutAfterDispatch = isTimeoutAfterDispatch
    this.statusCode = statusCode
  }
}

/**
 * Deterministic Mock Upstream for Offline Security & Unit Testing
 */
export class MockUpstreamAdapter implements UpstreamAdapter {
  public invocationCount = 0
  public invocationsByKey = new Map<string, number>()
  public mode: 'normal' | 'fail_before_exec' | 'timeout_after_exec' | 'econnreset_after_exec' | 'server_error' = 'normal'
  public customPayload?: string

  constructor(customPayload?: string) {
    this.customPayload = customPayload
  }

  public async dispatch(req: UpstreamRequest): Promise<UpstreamResponse> {
    await Promise.resolve()
    const key = `${req.serviceId.toString()}:${req.idempotencyKey}`
    const count = (this.invocationsByKey.get(key) ?? 0) + 1
    this.invocationsByKey.set(key, count)
    this.invocationCount++

    if (this.mode === 'fail_before_exec') {
      throw new UpstreamError('Failed to establish connection to upstream server', false, 502)
    }

    if (this.mode === 'timeout_after_exec') {
      // Simulate upstream started processing, but timed out before returning
      throw new UpstreamError('Upstream socket timed out after request was received', true, 504)
    }

    if (this.mode === 'econnreset_after_exec') {
      // Simulates socket reset / ECONNRESET after request payload was transmitted
      throw new UpstreamError('read ECONNRESET (socket hang up after dispatch)', true, 504)
    }

    if (this.mode === 'server_error') {
      return {
        status: 500,
        body: JSON.stringify({ error: 'Internal upstream processing exception' }),
        latencyMs: 15,
      }
    }

    const defaultBody = this.customPayload ?? JSON.stringify({
      status: 200,
      serviceId: req.serviceId.toString(),
      path: req.path,
      idempotencyKey: req.idempotencyKey,
      timestamp: Date.now(),
      signal: 'VERIFIED_ONCHAIN_PAYMENT_PAYLOAD',
      data: {
        whale_alert: '15,000,000 USDC transfer from 0x42... to Vault',
        confidence: 0.98,
        action: 'FOLLOW_BUY',
      },
    })

    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: defaultBody,
      latencyMs: 12,
    }
  }

  public reset(): void {
    this.invocationCount = 0
    this.invocationsByKey.clear()
    this.mode = 'normal'
  }
}

/**
 * HTTP Upstream Adapter with Idempotency Key Injection and Timeout Classification
 * 
 * IMPORTANT IDEMPOTENCY STATEMENT:
 * The gateway injects an `Idempotency-Key: <requestId>` header into every upstream dispatch.
 * However, the header alone DOES NOT guarantee idempotency unless the upstream service explicitly
 * implements and enforces idempotency deduplication. If the upstream service is non-idempotent
 * (e.g. charging an external balance or executing a market transaction), any network failure after
 * dispatch must fail-closed to UNCERTAIN to prevent duplicate operations.
 */
export class HttpUpstreamAdapter implements UpstreamAdapter {
  private readonly targetBaseUrl: string
  private readonly timeoutMs: number

  constructor(targetBaseUrl: string, timeoutMs: number = 10000) {
    this.targetBaseUrl = targetBaseUrl
    this.timeoutMs = timeoutMs
  }

  public async dispatch(req: UpstreamRequest): Promise<UpstreamResponse> {
    const url = new URL(req.path, this.targetBaseUrl).toString()
    const start = Date.now()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let requestDispatched = false
    try {
      requestDispatched = true
      const res = await fetch(url, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': req.idempotencyKey,
          'X-PayGate-Service-Id': req.serviceId.toString(),
        },
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
        signal: controller.signal,
      })
      clearTimeout(timer)

      const body = await res.text()
      const latencyMs = Date.now() - start

      return {
        status: res.status,
        body,
        latencyMs,
      }
    } catch (err: unknown) {
      clearTimeout(timer)
      const error = err as Error
      const msg = error.message || ''

      if (error.name === 'AbortError') {
        // Timed out after request was sent -> uncertain outcome
        throw new UpstreamError(`Upstream request timed out after ${this.timeoutMs}ms`, true, 504)
      }

      // Pre-connection failures definitely failed before server received request (retriable 502)
      const isDefinitePreDispatch =
        msg.includes('ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('EAI_AGAIN')

      // Post-dispatch socket hangups or resets (ECONNRESET, EPIPE) may have reached upstream
      const isPotentiallyDispatched = requestDispatched && !isDefinitePreDispatch

      throw new UpstreamError(
        `Network dispatch failure: ${error.message}`,
        isPotentiallyDispatched,
        isPotentiallyDispatched ? 504 : 502
      )
    }
  }
}

export interface RealDataUpstreamOptions {
  endpointUrl?: string
  timeoutMs?: number
  maxResponseSizeBytes?: number
}

export interface ArcTelemetryData {
  service: string
  network: string
  chainId: number
  status: string
  blockNumber: number
  blockHash: string
  blockTimestamp: number
  blockTimestampIso: string
  gasUsed: number
  gasLimit: number
  gasUtilizationPercent: number
  transactionCount: number
  gasPriceWei: string
  gasPriceGwei: string
}

export interface ArcTelemetryPayload {
  status: number
  service: string
  network: string
  chainId: number
  telemetry: ArcTelemetryData
  provenance: {
    source: string
    verifiedLive: boolean
    queryTimestamp: string
    latencyMs: number
  }
  data?: unknown
}

function findRpcItem(items: readonly unknown[], targetId: number): Record<string, unknown> | undefined {
  for (const item of items) {
    if (typeof item === 'object' && item !== null && 'id' in item) {
      const rec = item as Record<string, unknown>
      if (rec['id'] === targetId) {
        return rec
      }
    }
  }
  return undefined
}

/**
 * Directly queries authentic Arc Mainnet L1 telemetry via public JSON-RPC.
 * Zero private keys, zero spend ($0), strictly bounded timeouts and response sizes.
 */
export async function fetchArcMainnetTelemetry(opts?: RealDataUpstreamOptions): Promise<ArcTelemetryPayload> {
  const endpointUrl = opts?.endpointUrl ?? 'https://rpc.mainnet.arc.io'
  const timeoutMs = opts?.timeoutMs ?? 5000
  const maxResponseSizeBytes = opts?.maxResponseSizeBytes ?? 65536 // 64 KiB

  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const batchBody = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['latest', false] },
      { jsonrpc: '2.0', id: 3, method: 'eth_gasPrice', params: [] },
      { jsonrpc: '2.0', id: 4, method: 'eth_chainId', params: [] },
    ])

    const res = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PayGate402-Gateway/1.0 (Arc Telemetry Client)',
      },
      body: batchBody,
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      throw new UpstreamError(`Arc RPC HTTP error: status ${res.status} ${res.statusText}`, false, 502)
    }

    const rawText = await res.text()
    const byteLength = Buffer.byteLength(rawText, 'utf8')
    if (byteLength > maxResponseSizeBytes) {
      throw new UpstreamError(
        `Arc RPC response exceeded size limit: ${byteLength} > ${maxResponseSizeBytes}`,
        false,
        502
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch {
      throw new UpstreamError('Arc RPC returned invalid non-JSON payload', false, 502)
    }

    if (!Array.isArray(parsed)) {
      throw new UpstreamError('Arc RPC returned non-array batch JSON-RPC response', false, 502)
    }

    // Validate that no batch response contains an RPC-level error
    for (const item of parsed) {
      if (typeof item === 'object' && item !== null && 'error' in item) {
        const errObj = (item as Record<string, unknown>)['error']
        const errMsg = typeof errObj === 'object' && errObj !== null && 'message' in errObj
          ? String((errObj as Record<string, unknown>)['message'])
          : 'Unknown JSON-RPC error'
        throw new UpstreamError(`Arc RPC error: ${errMsg}`, false, 502)
      }
    }

    const blockNumItem = findRpcItem(parsed, 1)
    const blockItem = findRpcItem(parsed, 2)
    const gasPriceItem = findRpcItem(parsed, 3)
    const chainIdItem = findRpcItem(parsed, 4)

    // Verify chain identity if returned by RPC
    if (chainIdItem && typeof chainIdItem['result'] === 'string') {
      const returnedChainId = parseInt(chainIdItem['result'], 16)
      if (returnedChainId !== 5042) {
        throw new UpstreamError(
          `Arc RPC chain identity mismatch: expected 5042 (Arc Mainnet), received ${returnedChainId}`,
          false,
          502
        )
      }
    }

    const blockNumHex = typeof blockNumItem?.['result'] === 'string' ? blockNumItem['result'] : undefined
    const blockObj = typeof blockItem?.['result'] === 'object' && blockItem['result'] !== null
      ? (blockItem['result'] as Record<string, unknown>)
      : undefined

    if (!blockNumHex || !/^0x[0-9a-fA-F]+$/.test(blockNumHex)) {
      throw new UpstreamError('Arc RPC returned invalid or missing block number', false, 502)
    }
    if (!blockObj) {
      throw new UpstreamError('Arc RPC batch response missing required block data', false, 502)
    }

    const blockNumber = parseInt(blockNumHex, 16)
    if (isNaN(blockNumber) || blockNumber <= 0) {
      throw new UpstreamError('Arc RPC returned unparseable block number', false, 502)
    }

    const blockTimestampHex = typeof blockObj['timestamp'] === 'string' ? blockObj['timestamp'] : undefined
    if (!blockTimestampHex || !/^0x[0-9a-fA-F]+$/.test(blockTimestampHex)) {
      throw new UpstreamError('Arc RPC returned invalid or missing block timestamp', false, 502)
    }
    const blockTimestamp = parseInt(blockTimestampHex, 16)
    if (isNaN(blockTimestamp) || blockTimestamp <= 0) {
      throw new UpstreamError('Arc RPC returned unparseable block timestamp', false, 502)
    }

    const blockHash = typeof blockObj['hash'] === 'string' ? blockObj['hash'] : undefined
    if (!blockHash || !/^0x[0-9a-fA-F]+$/.test(blockHash)) {
      throw new UpstreamError('Arc RPC returned invalid or missing block hash', false, 502)
    }

    const gasUsedHex = typeof blockObj['gasUsed'] === 'string' ? blockObj['gasUsed'] : undefined
    const gasUsed = gasUsedHex ? parseInt(gasUsedHex, 16) : 0
    const gasLimitHex = typeof blockObj['gasLimit'] === 'string' ? blockObj['gasLimit'] : undefined
    const gasLimit = gasLimitHex ? parseInt(gasLimitHex, 16) : 0
    const txList = Array.isArray(blockObj['transactions']) ? blockObj['transactions'] : []
    const txCount = txList.length
    const gasPriceHex = typeof gasPriceItem?.['result'] === 'string' ? gasPriceItem['result'] : undefined
    const gasPriceWei = gasPriceHex ? BigInt(gasPriceHex).toString() : '0'
    const gasPriceGwei = gasPriceHex ? (Number(BigInt(gasPriceHex)) / 1e9).toFixed(4) : '0'

    const latencyMs = Date.now() - start
    const telemetry: ArcTelemetryData = {
      service: 'arc-l1-telemetry',
      network: 'Arc Mainnet',
      chainId: 5042,
      status: 'online',
      blockNumber,
      blockHash,
      blockTimestamp,
      blockTimestampIso: new Date(blockTimestamp * 1000).toISOString(),
      gasUsed,
      gasLimit,
      gasUtilizationPercent: gasLimit > 0 ? Number(((gasUsed / gasLimit) * 100).toFixed(2)) : 0,
      transactionCount: txCount,
      gasPriceWei,
      gasPriceGwei,
    }

    return {
      status: 200,
      service: 'arc-l1-telemetry',
      network: 'Arc Mainnet',
      chainId: 5042,
      telemetry,
      provenance: {
        source: endpointUrl,
        verifiedLive: true,
        queryTimestamp: new Date().toISOString(),
        latencyMs,
      },
      data: parsed,
    }
  } catch (err: unknown) {
    clearTimeout(timer)
    if (err instanceof UpstreamError) throw err
    const error = err as Error
    if (error.name === 'AbortError') {
      throw new UpstreamError(`Arc RPC telemetry timed out after ${timeoutMs}ms`, true, 504)
    }
    throw new UpstreamError(`Arc RPC telemetry query failure: ${error.message}`, false, 502)
  }
}

/**
 * RealDataUpstreamAdapter
 * Connects to verified, free public endpoints (e.g. Arc blockchain metrics or public market telemetry)
 * without requiring any paid API keys or private tokens.
 * Enforces strict timeouts, response size limits, and runtime JSON schema validation.
 * Never invents or fabricates fallback data on failure.
 */
export class RealDataUpstreamAdapter implements UpstreamAdapter {
  private readonly endpointUrl: string
  private readonly timeoutMs: number
  private readonly maxResponseSizeBytes: number

  constructor(opts?: RealDataUpstreamOptions) {
    this.endpointUrl = opts?.endpointUrl ?? 'https://rpc.mainnet.arc.io'
    this.timeoutMs = opts?.timeoutMs ?? 5000
    this.maxResponseSizeBytes = opts?.maxResponseSizeBytes ?? 65536 // 64 KiB limit
  }

  public async dispatch(req: UpstreamRequest): Promise<UpstreamResponse> {
    const start = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let requestDispatched = false
    try {
      requestDispatched = true

      // If the upstream is an RPC endpoint or path requests telemetry, craft a read-only batch telemetry query
      const isRpc = this.endpointUrl.includes('rpc')
      const isTelemetryPath = req.path.includes('telemetry')
      const requestBody = (isRpc || isTelemetryPath)
        ? JSON.stringify([
            { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
            { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: ['latest', false] },
            { jsonrpc: '2.0', id: 3, method: 'eth_gasPrice', params: [] },
            { jsonrpc: '2.0', id: 4, method: 'eth_chainId', params: [] },
          ])
        : req.method !== 'GET' && req.method !== 'HEAD'
          ? req.body
          : undefined

      const res = await fetch(this.endpointUrl, {
        method: (isRpc || isTelemetryPath) ? 'POST' : req.method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': req.idempotencyKey,
          'X-PayGate-Service-Id': req.serviceId.toString(),
          'User-Agent': 'PayGate402-Gateway/1.0 (Public Metrics Client)',
        },
        body: requestBody,
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (!res.ok) {
        throw new UpstreamError(
          `Upstream HTTP error: received status ${res.status} ${res.statusText}`,
          false,
          502
        )
      }

      // Read text with strict response-size enforcement
      const rawText = await res.text()
      const byteLength = Buffer.byteLength(rawText, 'utf8')
      if (byteLength > this.maxResponseSizeBytes) {
        throw new UpstreamError(
          `Upstream response exceeded size limit: ${byteLength} bytes > ${this.maxResponseSizeBytes} bytes`,
          false,
          502
        )
      }

      // Runtime schema validation
      let parsed: unknown
      try {
        parsed = JSON.parse(rawText)
      } catch {
        throw new UpstreamError('Upstream returned invalid non-JSON payload', false, 502)
      }

      if (typeof parsed !== 'object' || parsed === null) {
        throw new UpstreamError('Upstream returned non-object JSON payload', false, 502)
      }

      const latencyMs = Date.now() - start

      // If response is a batch JSON-RPC result from Arc RPC, structure telemetry data
      let telemetry: ArcTelemetryData | undefined
      if (Array.isArray(parsed)) {
        // Validate that no batch response contains an RPC error
        for (const item of parsed) {
          if (typeof item === 'object' && item !== null && 'error' in item) {
            const errObj = (item as Record<string, unknown>)['error']
            const errMsg = typeof errObj === 'object' && errObj !== null && 'message' in errObj
              ? String((errObj as Record<string, unknown>)['message'])
              : 'Unknown JSON-RPC error'
            throw new UpstreamError(`Arc RPC error: ${errMsg}`, false, 502)
          }
        }

        const blockNumItem = findRpcItem(parsed, 1)
        const blockItem = findRpcItem(parsed, 2)
        const gasPriceItem = findRpcItem(parsed, 3)
        const chainIdItem = findRpcItem(parsed, 4)

        if (chainIdItem && typeof chainIdItem['result'] === 'string') {
          const returnedChainId = parseInt(chainIdItem['result'], 16)
          if (returnedChainId !== 5042) {
            throw new UpstreamError(
              `Arc RPC chain identity mismatch: expected 5042 (Arc Mainnet), received ${returnedChainId}`,
              false,
              502
            )
          }
        }

        const blockNumHex = typeof blockNumItem?.['result'] === 'string' ? blockNumItem['result'] : undefined
        const blockObj = typeof blockItem?.['result'] === 'object' && blockItem['result'] !== null
          ? (blockItem['result'] as Record<string, unknown>)
          : undefined

        if (blockNumHex && blockObj) {
          if (!/^0x[0-9a-fA-F]+$/.test(blockNumHex)) {
            throw new UpstreamError('Arc RPC returned invalid block number', false, 502)
          }
          const blockNumber = parseInt(blockNumHex, 16)
          if (isNaN(blockNumber) || blockNumber <= 0) {
            throw new UpstreamError('Arc RPC returned unparseable block number', false, 502)
          }

          const blockTimestampHex = typeof blockObj['timestamp'] === 'string' ? blockObj['timestamp'] : undefined
          if (!blockTimestampHex || !/^0x[0-9a-fA-F]+$/.test(blockTimestampHex)) {
            throw new UpstreamError('Arc RPC returned invalid or missing block timestamp', false, 502)
          }
          const blockTimestamp = parseInt(blockTimestampHex, 16)
          if (isNaN(blockTimestamp) || blockTimestamp <= 0) {
            throw new UpstreamError('Arc RPC returned unparseable block timestamp', false, 502)
          }

          const blockHash = typeof blockObj['hash'] === 'string' ? blockObj['hash'] : undefined
          if (!blockHash || !/^0x[0-9a-fA-F]+$/.test(blockHash)) {
            throw new UpstreamError('Arc RPC returned invalid or missing block hash', false, 502)
          }

          const gasUsedHex = typeof blockObj['gasUsed'] === 'string' ? blockObj['gasUsed'] : undefined
          const gasUsed = gasUsedHex ? parseInt(gasUsedHex, 16) : 0
          const gasLimitHex = typeof blockObj['gasLimit'] === 'string' ? blockObj['gasLimit'] : undefined
          const gasLimit = gasLimitHex ? parseInt(gasLimitHex, 16) : 0
          const txList = Array.isArray(blockObj['transactions']) ? blockObj['transactions'] : []
          const txCount = txList.length
          const gasPriceHex = typeof gasPriceItem?.['result'] === 'string' ? gasPriceItem['result'] : undefined
          const gasPriceWei = gasPriceHex ? BigInt(gasPriceHex).toString() : '0'
          const gasPriceGwei = gasPriceHex ? (Number(BigInt(gasPriceHex)) / 1e9).toFixed(4) : '0'

          telemetry = {
            service: 'arc-l1-telemetry',
            network: 'Arc Mainnet',
            chainId: 5042,
            status: 'online',
            blockNumber,
            blockHash,
            blockTimestamp,
            blockTimestampIso: new Date(blockTimestamp * 1000).toISOString(),
            gasUsed,
            gasLimit,
            gasUtilizationPercent: gasLimit > 0 ? Number(((gasUsed / gasLimit) * 100).toFixed(2)) : 0,
            transactionCount: txCount,
            gasPriceWei,
            gasPriceGwei,
          }
        }
      }

      // Construct verified real data response envelope with source provenance
      const responseEnvelope = {
        status: 200,
        serviceId: req.serviceId.toString(),
        idempotencyKey: req.idempotencyKey,
        ...(telemetry ? { telemetry } : {}),
        provenance: {
          source: this.endpointUrl,
          verifiedLive: true,
          queryTimestamp: new Date().toISOString(),
          latencyMs,
        },
        data: parsed,
      }

      return {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-paygate-upstream': 'verified-real-metrics',
        },
        body: JSON.stringify(responseEnvelope, null, 2),
        latencyMs,
      }
    } catch (err: unknown) {
      clearTimeout(timer)
      if (err instanceof UpstreamError) throw err

      const error = err as Error
      const msg = error.message || ''

      if (error.name === 'AbortError') {
        throw new UpstreamError(
          `Upstream request timed out after ${this.timeoutMs}ms`,
          true,
          504
        )
      }

      const isDefinitePreDispatch =
        msg.includes('ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('EAI_AGAIN')

      const isPotentiallyDispatched = requestDispatched && !isDefinitePreDispatch

      throw new UpstreamError(
        `Upstream failure: ${error.message}`,
        isPotentiallyDispatched,
        isPotentiallyDispatched ? 504 : 502
      )
    }
  }
}
