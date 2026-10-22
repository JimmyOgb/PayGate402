/**
 * PayGate402 HTTP Gateway Server
 * Production-minded, zero-framework HTTP server built with node:http.
 * Enforces HTTP 402 challenges, receipt verification, EIP-712 auth, atomic consumption, and safe retries.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import {
  buildEip712Domain,
  PAYGATE_EIP712_TYPES,
  type GatewayConfig,
  type PaymentChallenge,
} from './types.ts'
import { GatewayDb } from './db.ts'
import { BlockchainVerifier, VerificationError, type RpcClientInterface } from './verifier.ts'
import { UpstreamError, fetchArcMainnetTelemetry, type UpstreamAdapter } from './upstream.ts'

export interface ServerInstance {
  server: Server
  port: number
  close: () => Promise<void>
}

export class PayloadTooLargeError extends Error {
  constructor(message: string = 'Request payload exceeds size limit (413 Payload Too Large)') {
    super(message)
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * Single-process in-memory challenge rate limiter with bounded storage.
 * Enforces per-IP / per-payer request limits to protect database storage from flooding.
 */
export class ChallengeRateLimiter {
  private readonly windowMs: number
  private readonly maxChallenges: number
  private readonly hits = new Map<string, { count: number; windowStart: number }>()
  private lastCleanup = Date.now()

  constructor(windowMs: number = 60_000, maxChallenges: number = 60) {
    this.windowMs = windowMs
    this.maxChallenges = maxChallenges
  }

  public checkRateLimit(key: string): boolean {
    const now = Date.now()
    if (now - this.lastCleanup > this.windowMs) {
      this.cleanup(now)
    }

    const record = this.hits.get(key)
    if (!record || now - record.windowStart > this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now })
      return true
    }

    if (record.count >= this.maxChallenges) {
      return false
    }

    record.count++
    return true
  }

  private cleanup(now: number) {
    this.lastCleanup = now
    for (const [key, record] of this.hits.entries()) {
      if (now - record.windowStart > this.windowMs) {
        this.hits.delete(key)
      }
    }
  }

  public reset() {
    this.hits.clear()
    this.lastCleanup = Date.now()
  }
}

export function createGatewayServer(opts: {
  config: GatewayConfig
  db: GatewayDb
  verifier: BlockchainVerifier
  upstream: UpstreamAdapter
  rpc: RpcClientInterface
}): Server & { rateLimiter: ChallengeRateLimiter } {
  const { config, db, verifier, upstream, rpc } = opts
  const maxBodySize = config.maxBodySizeBytes ?? 1024 * 1024 // 1 MiB default
  const rateLimiter = new ChallengeRateLimiter(
    config.rateLimitWindowMs ?? 60_000,
    config.maxChallengesPerWindow ?? 60
  )

  // Conservative startup recovery: recover lingering in-flight states from prior process crashes
  const recoveryStats = db.recoverStartupStates()
  if (recoveryStats.recoveredUncertain > 0 || recoveryStats.recoveredFailed > 0) {
    process.stdout.write(
      `[PayGate402] Startup recovery executed: ${recoveryStats.recoveredUncertain} in-flight dispatch(es) locked to UNCERTAIN, ${recoveryStats.recoveredFailed} pre-dispatch reservation(s) reset to FAILED.\n`
    )
  }

  const sendJson = (res: ServerResponse, statusCode: number, data: unknown, extraHeaders: Record<string, string> = {}) => {
    const payload = JSON.stringify(data)
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Payment-TxHash, X-Payment-RequestId, X-Payment-Signature, X-Payment-Payer',
      ...extraHeaders,
    })
    res.end(payload)
  }

  const logStructured = (method: string, path: string, status: number, latencyMs: number, meta?: Record<string, unknown>) => {
    const sanitizedMeta = meta
      ? Object.fromEntries(
          Object.entries(meta).map(([k, v]) => [
            k,
            typeof v === 'string' && v.length > 132 && k.toLowerCase().includes('sig')
              ? `${v.slice(0, 10)}...[REDACTED]`
              : v,
          ])
        )
      : undefined
    const record = {
      timestamp: new Date().toISOString(),
      method,
      path,
      status,
      latencyMs,
      ...(sanitizedMeta ? sanitizedMeta : {}),
    }
    process.stdout.write(`[PayGate402] ${JSON.stringify(record)}\n`)
  }

  const parseRequestBody = async (req: IncomingMessage, maxBytes: number = maxBodySize): Promise<string> => {
    return new Promise((resolve, reject) => {
      let totalBytes = 0
      const chunks: Buffer[] = []
      let destroyed = false

      const onData = (chunk: Buffer | Uint8Array | string) => {
        if (destroyed) return
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        totalBytes += buf.byteLength
        if (totalBytes > maxBytes) {
          destroyed = true
          req.removeListener('data', onData)
          req.resume()
          reject(new PayloadTooLargeError(`Request payload exceeds maximum allowed size of ${maxBytes} bytes`))
          return
        }
        chunks.push(buf)
      }

      req.on('data', onData)
      req.on('end', () => {
        if (!destroyed) {
          resolve(Buffer.concat(chunks).toString('utf-8'))
        }
      })
      req.on('error', err => {
        if (!destroyed) reject(err)
      })
    })
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const startTime = Date.now()
    const method = req.method?.toUpperCase() || 'GET'
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = parsedUrl.pathname

    // Handle CORS Pre-Flight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Payment-TxHash, X-Payment-RequestId, X-Payment-Signature, X-Payment-Payer',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }

    try {
      // 1. Health Endpoint
      if (pathname === '/health' || pathname === '/v1/health') {
        const chainId = await rpc.getChainId().catch(() => config.chainId)
        const blockNumber = await rpc.getBlockNumber().catch(() => 0n)
        sendJson(res, 200, {
          status: 'healthy',
          network: 'Arc Testnet',
          chainId,
          currentBlock: blockNumber.toString(),
          contract: config.contractAddress,
          usdcToken: config.usdcAddress,
          minConfirmations: config.minConfirmations,
          upstreamMode: config.upstreamMode,
          mockRpc: Boolean(config.mockRpc || process.env.MOCK_RPC === 'true'),
          demoNotice: config.mockRpc || process.env.MOCK_RPC === 'true' ? 'SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED' : undefined,
          uptimeSec: Math.floor(process.uptime()),
          timestamp: Date.now(),
        })
        logStructured(method, pathname, 200, Date.now() - startTime)
        return
      }

      // 1B. Mock Fixture Registration Endpoint (Only available when mockRpc is active)
      if (pathname === '/v1/mock/register-payment' && method === 'POST') {
        if (!config.mockRpc && process.env.MOCK_RPC !== 'true') {
          sendJson(res, 403, { error: 'Mock endpoints disabled when not in mock mode', code: 'MOCK_DISABLED' })
          return
        }
        const bodyStr = await parseRequestBody(req)
        const payload = JSON.parse(bodyStr || '{}') as {
          txHash?: Hex
          serviceId?: string
          requestId?: Hex
          caller?: Address
          amountPaid?: string
          status?: 'success' | 'reverted'
          blockNumber?: string
        }
        if (!payload.txHash || !payload.requestId || !payload.caller) {
          sendJson(res, 400, { error: 'txHash, requestId, and caller are required', code: 'INVALID_REQUEST' })
          return
        }
        if ('registerValidPayment' in rpc && typeof (rpc as { registerValidPayment: unknown }).registerValidPayment === 'function') {
          (rpc as unknown as { registerValidPayment: (p: unknown) => void }).registerValidPayment({
            txHash: payload.txHash,
            serviceId: BigInt(payload.serviceId ?? '0'),
            requestId: payload.requestId,
            caller: payload.caller,
            amountPaid: BigInt(payload.amountPaid ?? '100000'),
            status: payload.status ?? 'success',
            blockNumber: payload.blockNumber ? BigInt(payload.blockNumber) : undefined,
          })
          sendJson(res, 200, {
            status: 'registered',
            simulated: true,
            notice: 'SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED',
            txHash: payload.txHash,
            requestId: payload.requestId,
          })
          return
        }
        sendJson(res, 500, { error: 'RPC client does not support fixture registration', code: 'UNSUPPORTED' })
        return
      }

      // 1C. Public / Direct Arc Telemetry Endpoint: GET /v1/telemetry/arc-mainnet
      if (pathname === '/v1/telemetry/arc-mainnet' && method === 'GET') {
        try {
          const telemetryData = await fetchArcMainnetTelemetry({
            endpointUrl: 'https://rpc.mainnet.arc.io',
            timeoutMs: 5000,
            maxResponseSizeBytes: 65536,
          })
          sendJson(res, 200, telemetryData, {
            'x-paygate-upstream': 'verified-arc-telemetry',
            'cache-control': 'no-cache, no-store, must-revalidate',
          })
          logStructured(method, pathname, 200, Date.now() - startTime)
          return
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          sendJson(res, 502, { error: `Arc Telemetry RPC error: ${msg}`, code: 'UPSTREAM_RPC_ERROR' })
          logStructured(method, pathname, 502, Date.now() - startTime, { error: msg })
          return
        }
      }

      // 2. Explicit Verification Endpoint: POST /v1/gateway/verify-payment
      if (pathname === '/v1/gateway/verify-payment' && method === 'POST') {
        const bodyStr = await parseRequestBody(req)
        const payload = JSON.parse(bodyStr || '{}') as {
          txHash?: string
          requestId?: string
          signature?: string
        }

        if (!payload.txHash || !payload.requestId || !payload.signature) {
          sendJson(res, 400, {
            error: 'Missing required fields: txHash, requestId, signature are required',
            code: 'INVALID_REQUEST_BODY',
          })
          logStructured(method, pathname, 400, Date.now() - startTime)
          return
        }

        const challenge = db.getChallenge(payload.requestId as Hex)
        if (!challenge) {
          sendJson(res, 404, {
            error: 'Payment challenge not found for given requestId',
            code: 'CHALLENGE_NOT_FOUND',
          })
          logStructured(method, pathname, 404, Date.now() - startTime)
          return
        }

        const verification = await verifier.verifyPayment({
          txHash: payload.txHash as Hex,
          challenge,
          signature: payload.signature as Hex,
          currentPath: challenge.path,
          currentMethod: challenge.method,
          currentBodyDigest: challenge.bodyDigest,
        })

        sendJson(res, 200, {
          status: 'verified',
          serviceId: challenge.serviceId.toString(),
          requestId: challenge.requestId,
          txHash: payload.txHash,
          caller: verification.verifiedCaller,
          amountPaid: verification.amountPaid.toString(),
          blockNumber: verification.blockNumber.toString(),
        })
        logStructured(method, pathname, 200, Date.now() - startTime, { txHash: payload.txHash })
        return
      }

      // 3. Protected Proxy Endpoint: /v1/gateway/:serviceId/*
      const gatewayPrefix = '/v1/gateway/'
      if (pathname.startsWith(gatewayPrefix)) {
        const remainder = pathname.slice(gatewayPrefix.length)
        const slashIdx = remainder.indexOf('/')
        const serviceIdStr = slashIdx === -1 ? remainder : remainder.slice(0, slashIdx)
        const subPath = slashIdx === -1 ? '/' : remainder.slice(slashIdx)

        if (!/^\d+$/.test(serviceIdStr)) {
          sendJson(res, 400, { error: 'Invalid serviceId in path; must be an integer', code: 'INVALID_SERVICE_ID' })
          logStructured(method, pathname, 400, Date.now() - startTime)
          return
        }

        const serviceId = BigInt(serviceIdStr)
        const bodyStr = await parseRequestBody(req)
        const bodyDigest = keccak256(toHex(bodyStr || ''))

        // Extract payment headers
        const txHash = (req.headers['x-payment-txhash'] || req.headers['x-payment-tx-hash']) as Hex | undefined
        const requestId = (req.headers['x-payment-requestid'] || req.headers['x-payment-request-id']) as Hex | undefined
        const signature = (req.headers['x-payment-signature'] || req.headers['x-payment-sig']) as Hex | undefined
        const payerHeader = (req.headers['x-payment-payer'] as Address | undefined) || ''

        // 3A. CHALLENGE MODE: Missing payment headers -> Return HTTP 402
        if (!txHash || !requestId || !signature) {
          // Check challenge rate limiting (per IP/payer)
          const clientIp = req.socket.remoteAddress || 'unknown'
          const rateKey = payerHeader ? `${clientIp}:${payerHeader.toLowerCase()}` : clientIp
          if (!rateLimiter.checkRateLimit(rateKey)) {
            sendJson(
              res,
              429,
              {
                error: 'Too many challenge requests. Rate limit exceeded. Please wait before requesting another challenge.',
                code: 'RATE_LIMIT_EXCEEDED',
              },
              { 'Retry-After': '60' }
            )
            logStructured(method, pathname, 429, Date.now() - startTime, { rateKey })
            return
          }

          // Validate service on-chain and retrieve quoted price
          let quotedPrice: bigint
          try {
            quotedPrice = await rpc.getServicePrice(serviceId)
          } catch (err: unknown) {
            if (err instanceof VerificationError) {
              sendJson(res, err.statusCode, { error: err.message, code: err.code })
              logStructured(method, pathname, err.statusCode, Date.now() - startTime, {
                error: err.message,
                code: err.code,
                serviceId: serviceId.toString(),
              })
              return
            }
            const msg = err instanceof Error ? err.message : String(err)
            sendJson(res, 503, { error: `Blockchain RPC failure: ${msg}`, code: 'RPC_UNAVAILABLE' })
            logStructured(method, pathname, 503, Date.now() - startTime, { error: msg })
            return
          }

          const newRequestId: Hex = `0x${randomBytes(32).toString('hex')}`
          const createdAt = Date.now()
          const expiresAt = createdAt + config.challengeTtlMs

          const challenge: PaymentChallenge = {
            requestId: newRequestId,
            serviceId,
            payer: payerHeader ? payerHeader.toLowerCase() as Address : '',
            method,
            path: subPath,
            bodyDigest,
            quotedPrice,
            chainId: config.chainId,
            createdAt,
            expiresAt,
            status: 'ISSUED',
          }

          db.createChallenge(challenge)

          const authHeader = `PayGate402 serviceId=${serviceId.toString()}, chainId=${config.chainId}, requestId=${newRequestId}`
          sendJson(
            res,
            402,
            {
              error: 'HTTP 402 Payment Required',
              message: `On-chain payment required. Invoke payForAccess(serviceId, requestId) on ${config.chainId === 5042 ? 'Arc Mainnet' : 'Arc Testnet'}.`,
              challenge: {
                serviceId: serviceId.toString(),
                requestId: newRequestId,
                quotedPrice: quotedPrice.toString(),
                quotedPriceFormatted: `${(Number(quotedPrice) / 1_000_000).toFixed(6)} USDC`,
                chainId: config.chainId,
                contract: config.contractAddress,
                usdcToken: config.usdcAddress,
                method,
                path: subPath,
                bodyDigest,
                expiresAt,
                eip712Domain: buildEip712Domain(config.chainId, config.contractAddress),
                eip712Types: PAYGATE_EIP712_TYPES,
              },
            },
            {
              'WWW-Authenticate': authHeader,
              'X-Payment-Contract': config.contractAddress,
              'X-Payment-Token': config.usdcAddress,
              'X-Required-Amount': quotedPrice.toString(),
              'X-Payment-RequestId': newRequestId,
              'X-Payment-Expires': expiresAt.toString(),
            }
          )
          logStructured(method, pathname, 402, Date.now() - startTime, {
            serviceId: serviceId.toString(),
            requestId: newRequestId,
          })
          return
        }

        // 3B. VERIFICATION & CONSUMPTION MODE: Payment headers present
        const challenge = db.getChallenge(requestId)
        if (!challenge) {
          sendJson(res, 400, {
            error: 'Specified requestId was not found or was not generated by this gateway',
            code: 'CHALLENGE_NOT_FOUND',
          })
          logStructured(method, pathname, 400, Date.now() - startTime, { requestId })
          return
        }

        // Attempt Atomic Payment Lock in SQLite
        const lockResult = db.tryAcquirePaymentLock({
          txHash,
          requestId,
          serviceId,
          caller: payerHeader ? (payerHeader.toLowerCase() as Address) : '0x0000000000000000000000000000000000000000',
          amountPaid: challenge.quotedPrice,
        })

        if (!lockResult.acquired) {
          if (lockResult.reason === 'ALREADY_SUCCEEDED') {
            // Legitimate idempotent retry: return cached response
            const cachedBody = lockResult.cachedResponse || '{}'
            sendJson(
              res,
              200,
              JSON.parse(cachedBody),
              {
                'X-PayGate-Status': 'VERIFIED_ONCHAIN_CACHED',
                'X-PayGate-Cached': 'true',
                'X-PayGate-TxHash': txHash,
                'X-PayGate-RequestId': requestId,
              }
            )
            logStructured(method, pathname, 200, Date.now() - startTime, {
              cached: true,
              txHash,
              requestId,
            })
            return
          }

          if (lockResult.reason === 'CONCURRENT_CONFLICT') {
            sendJson(res, 409, {
              error: 'Payment transaction is currently being processed by another concurrent request',
              code: 'CONCURRENT_REQUEST_CONFLICT',
            })
            logStructured(method, pathname, 409, Date.now() - startTime, { txHash, requestId })
            return
          }

          if (lockResult.reason === 'UNCERTAIN_LOCKED') {
            sendJson(res, 409, {
              error: 'Payment is locked in UNCERTAIN state due to prior upstream timeout. Manual recovery required.',
              code: 'PAYMENT_LOCKED_UNCERTAIN',
            })
            logStructured(method, pathname, 409, Date.now() - startTime, { txHash, requestId })
            return
          }

          sendJson(res, 409, {
            error: 'Request ID or transaction hash has already been consumed for another request',
            code: 'PAYMENT_ALREADY_CONSUMED',
          })
          logStructured(method, pathname, 409, Date.now() - startTime, { txHash, requestId })
          return
        }

        // Lock Acquired -> Move to VERIFYING state
        db.transitionState(txHash, 'RESERVED', 'VERIFYING')

        let verificationResult
        try {
          verificationResult = await verifier.verifyPayment({
            txHash,
            challenge,
            signature,
            currentPath: subPath,
            currentMethod: method,
            currentBodyDigest: bodyDigest,
          })
        } catch (err: unknown) {
          if (err instanceof VerificationError) {
            db.recordFailed(txHash, err.message)
            sendJson(res, err.statusCode, { error: err.message, code: err.code })
            logStructured(method, pathname, err.statusCode, Date.now() - startTime, {
              error: err.message,
              code: err.code,
              txHash,
            })
            return
          }
          // Unexpected RPC error
          const msg = err instanceof Error ? err.message : String(err)
          db.recordFailed(txHash, msg)
          sendJson(res, 503, { error: `Blockchain RPC failure: ${msg}`, code: 'RPC_UNAVAILABLE' })
          logStructured(method, pathname, 503, Date.now() - startTime, { error: msg, txHash })
          return
        }

        // Verification Passed -> Move to DISPATCHING state
        db.transitionState(txHash, 'VERIFYING', 'DISPATCHING')

        let upstreamRes
        try {
          upstreamRes = await upstream.dispatch({
            serviceId,
            method,
            path: subPath,
            body: bodyStr,
            idempotencyKey: requestId,
          })
        } catch (err: unknown) {
          if (err instanceof UpstreamError) {
            if (err.isTimeoutAfterDispatch) {
              // Upstream timeout after execution started: lock state to UNCERTAIN (fail closed)
              db.recordUncertain(txHash, err.message)
              sendJson(res, 504, {
                error: 'Upstream timed out after dispatch commenced. Payment locked to UNCERTAIN to prevent duplicate operations.',
                code: 'UPSTREAM_TIMEOUT_UNCERTAIN',
              })
              logStructured(method, pathname, 504, Date.now() - startTime, { error: err.message, state: 'UNCERTAIN' })
              return
            }

            // Connection failed before execution: mark FAILED (retriable)
            db.recordFailed(txHash, err.message)
            sendJson(res, 502, {
              error: `Upstream dispatch error: ${err.message}`,
              code: 'UPSTREAM_DISPATCH_FAILED',
            })
            logStructured(method, pathname, 502, Date.now() - startTime, { error: err.message, state: 'FAILED' })
            return
          }

          const msg = err instanceof Error ? err.message : String(err)
          db.recordUncertain(txHash, msg)
          sendJson(res, 500, { error: `Internal execution error: ${msg}`, code: 'INTERNAL_ERROR' })
          logStructured(method, pathname, 500, Date.now() - startTime, { error: msg })
          return
        }

        // Upstream Succeeded -> Record SUCCEEDED, cache payload, consume challenge
        db.recordSuccess(txHash, upstreamRes.body, verificationResult.verifiedCaller)
        db.markChallengeConsumed(requestId)

        // Return verified response to client
        let parsedBody: unknown
        try {
          parsedBody = JSON.parse(upstreamRes.body)
        } catch {
          parsedBody = upstreamRes.body
        }

        sendJson(
          res,
          upstreamRes.status,
          parsedBody,
          {
            'X-PayGate-Status': 'VERIFIED_ONCHAIN_SUCCESS',
            'X-PayGate-TxHash': txHash,
            'X-PayGate-RequestId': requestId,
            'X-PayGate-Caller': verificationResult.verifiedCaller,
            'X-PayGate-Amount-Paid': verificationResult.amountPaid.toString(),
            'X-PayGate-Block-Number': verificationResult.blockNumber.toString(),
            ...(upstreamRes.headers || {}),
          }
        )
        logStructured(method, pathname, upstreamRes.status, Date.now() - startTime, {
          txHash,
          requestId,
          caller: verificationResult.verifiedCaller,
          amountPaid: verificationResult.amountPaid.toString(),
        })
        return
      }

      // Default 404
      sendJson(res, 404, { error: `Route ${pathname} not found`, code: 'NOT_FOUND' })
      logStructured(method, pathname, 404, Date.now() - startTime)
    } catch (err: unknown) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message, code: 'PAYLOAD_TOO_LARGE' }, { 'Connection': 'close' })
        logStructured(method, pathname, 413, Date.now() - startTime)
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: `Internal Gateway Exception: ${msg}`, code: 'SERVER_EXCEPTION' })
      logStructured(method, pathname, 500, Date.now() - startTime, { error: msg })
    }
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res)
  }) as Server & { rateLimiter: ChallengeRateLimiter }
  server.rateLimiter = rateLimiter

  return server
}
