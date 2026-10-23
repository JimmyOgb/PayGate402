/**
 * Gateway Database Manager & Store Abstraction
 * Supports dual-mode architecture:
 * 1. SqliteGatewayStore (local embedded node:sqlite for deterministic, offline testing)
 * 2. LibSqlGatewayStore (remote libSQL / Turso Cloud adapter stub for production)
 */
import { createClient, type Client } from '@libsql/client'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import type { Address, Hex } from 'viem'
import {
  GatewayConfigurationError,
  PaymentStateTransitionError,
  type AcquireLockResult,
  type AcquirePaymentLockParams,
  type GatewayStore,
  type PaymentChallenge,
  type PaymentRecord,
  type PaymentState,
  type StartupRecoveryResult,
} from './types.ts'

export class SqliteGatewayStore implements GatewayStore {
  private db: DatabaseSync
  private initialized = false
  public readonly instanceId: string

  constructor(dbPath: string = ':memory:', instanceId?: string) {
    this.instanceId = instanceId ?? `pg402-${process.pid}-${randomBytes(8).toString('hex')}`
    this.db = new DatabaseSync(dbPath)
    this.initSync()
  }

  private initSync(): void {
    if (this.initialized) return
    try {
      this.db.exec('PRAGMA journal_mode = WAL;')
      this.db.exec('PRAGMA busy_timeout = 5000;')
    } catch {
      // In-memory or environments where WAL pragma is ignored
    }
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS challenges (
        request_id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        payer TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        body_digest TEXT NOT NULL,
        quoted_price TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ISSUED', 'CONSUMED', 'EXPIRED'))
      );

      CREATE TABLE IF NOT EXISTS payments (
        tx_hash TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES challenges(request_id),
        service_id TEXT NOT NULL,
        caller TEXT NOT NULL,
        amount_paid TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('PENDING', 'VERIFYING', 'RESERVED', 'DISPATCHING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN')),
        cached_response TEXT,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        consumed_at INTEGER,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        lease_token TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_challenges_payer ON challenges(payer);
      CREATE INDEX IF NOT EXISTS idx_payments_request ON payments(request_id);
    `)

    // Migration for existing tables created prior to Gate 3:
    try {
      const tableInfo = this.db.prepare(`PRAGMA table_info(payments)`).all() as Array<{ name: string }>
      const columnNames = new Set(tableInfo.map(col => col.name))
      if (!columnNames.has('lease_owner')) {
        this.db.exec('ALTER TABLE payments ADD COLUMN lease_owner TEXT;')
      }
      if (!columnNames.has('lease_expires_at')) {
        this.db.exec('ALTER TABLE payments ADD COLUMN lease_expires_at INTEGER;')
      }
      if (!columnNames.has('lease_token')) {
        this.db.exec('ALTER TABLE payments ADD COLUMN lease_token TEXT;')
      }
    } catch {
      // Ignore if table doesn't exist or already migrated
    }

    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_payments_lease_expiry ON payments(lease_expires_at);')
    } catch {
      // Ignore
    }

    this.initialized = true
  }

  public async init(): Promise<void> {
    this.initSync()
  }

  /**
   * Persists a server-issued challenge bound to the caller's request metadata.
   */
  public async createChallenge(challenge: PaymentChallenge): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO challenges (
        request_id, service_id, payer, method, path, body_digest,
        quoted_price, chain_id, created_at, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      challenge.requestId.toLowerCase(),
      challenge.serviceId.toString(),
      challenge.payer.toLowerCase(),
      challenge.method.toUpperCase(),
      challenge.path,
      challenge.bodyDigest.toLowerCase(),
      challenge.quotedPrice.toString(),
      challenge.chainId,
      challenge.createdAt,
      challenge.expiresAt,
      challenge.status
    )
  }

  /**
   * Retrieves a challenge by request ID.
   */
  public async getChallenge(requestId: Hex): Promise<PaymentChallenge | null> {
    const stmt = this.db.prepare(`SELECT * FROM challenges WHERE request_id = ?`)
    const row = stmt.get(requestId.toLowerCase()) as Record<string, unknown> | undefined

    if (!row) return null

    return {
      requestId: row.request_id as Hex,
      serviceId: BigInt(row.service_id as string),
      payer: (row.payer as string) as Address,
      method: row.method as string,
      path: row.path as string,
      bodyDigest: row.body_digest as Hex,
      quotedPrice: BigInt(row.quoted_price as string),
      chainId: Number(row.chain_id),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      status: row.status as 'ISSUED' | 'CONSUMED' | 'EXPIRED',
    }
  }

  /**
   * Marks a challenge as consumed.
   */
  public async markChallengeConsumed(requestId: Hex): Promise<void> {
    const stmt = this.db.prepare(`UPDATE challenges SET status = 'CONSUMED' WHERE request_id = ?`)
    stmt.run(requestId.toLowerCase())
  }

  /**
   * Atomically acquires a lock on the transaction hash and request ID with lease fencing.
   * Prevents two concurrent requests from unlocking the payment twice.
   */
  public async tryAcquirePaymentLock(params: AcquirePaymentLockParams): Promise<AcquireLockResult> {
    const now = Date.now()
    const normTxHash = params.txHash.toLowerCase()
    const normRequestId = params.requestId.toLowerCase()
    const normCaller = params.caller.toLowerCase()
    const leaseOwner = params.leaseOwner ?? this.instanceId
    const leaseTtlMs = params.leaseTtlMs ?? 30000
    const leaseExpiresAt = now + leaseTtlMs
    const newLeaseToken = `0x${randomBytes(16).toString('hex')}`

    // Query existing payment by tx_hash
    const checkTxStmt = this.db.prepare(
      `SELECT state, cached_response, request_id, caller, lease_owner, lease_expires_at, lease_token FROM payments WHERE tx_hash = ?`
    )
    const existingTx = checkTxStmt.get(normTxHash) as
      | {
          state: PaymentState
          cached_response: string | null
          request_id: string
          caller: string
          lease_owner: string | null
          lease_expires_at: number | null
          lease_token: string | null
        }
      | undefined

    if (existingTx) {
      if (existingTx.state === 'SUCCEEDED') {
        if (existingTx.request_id === normRequestId) {
          return {
            acquired: false,
            reason: 'ALREADY_SUCCEEDED',
            cachedResponse: existingTx.cached_response ?? undefined,
            caller: existingTx.caller as Address,
          }
        }
        return {
          acquired: false,
          reason: 'PAYMENT_ALREADY_CONSUMED',
        }
      }
      if (existingTx.state === 'UNCERTAIN') {
        return { acquired: false, reason: 'UNCERTAIN_LOCKED' }
      }
      if (existingTx.state === 'FAILED') {
        // Atomic update to RESERVED with fresh lease
        const updateStmt = this.db.prepare(`
          UPDATE payments SET 
            state = 'RESERVED',
            failure_reason = NULL,
            lease_owner = ?,
            lease_expires_at = ?,
            lease_token = ?,
            updated_at = ?
          WHERE tx_hash = ? AND state = 'FAILED'
        `)
        const updateRes = updateStmt.run(leaseOwner, leaseExpiresAt, newLeaseToken, now, normTxHash)
        if (updateRes.changes === 0) {
          // Lost race condition to concurrent retry attempt
          return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
        }
        return { acquired: true, leaseToken: newLeaseToken, leaseExpiresAt }
      }

      // State is RESERVED, VERIFYING, or DISPATCHING:
      const existingExpiry = existingTx.lease_expires_at ? Number(existingTx.lease_expires_at) : 0
      const isLeaseActive = existingExpiry > now

      if (isLeaseActive) {
        return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
      }

      // Lease has EXPIRED:
      if (existingTx.state === 'DISPATCHING') {
        // Dispatched upstream: Ambiguous external side-effect!
        // Lock to UNCERTAIN to prevent duplicate operations (Invariants D & E)
        const updateUncertain = this.db.prepare(`
          UPDATE payments SET
            state = 'UNCERTAIN',
            failure_reason = 'Dispatched upstream lease expired; locked to UNCERTAIN to prevent duplicate operations',
            updated_at = ?
          WHERE tx_hash = ? AND state = 'DISPATCHING' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        `)
        updateUncertain.run(now, normTxHash, now)
        return { acquired: false, reason: 'UNCERTAIN_LOCKED' }
      }

      // Pre-dispatch reservation expired (RESERVED or VERIFYING): Reclaim atomically
      const reclaimStmt = this.db.prepare(`
        UPDATE payments SET
          state = 'RESERVED',
          failure_reason = 'Previous pre-dispatch lease expired; reclaimed by new instance',
          lease_owner = ?,
          lease_expires_at = ?,
          lease_token = ?,
          updated_at = ?
        WHERE tx_hash = ? AND state IN ('RESERVED', 'VERIFYING') AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      `)
      const reclaimRes = reclaimStmt.run(leaseOwner, leaseExpiresAt, newLeaseToken, now, normTxHash, now)
      if (reclaimRes.changes === 0) {
        return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
      }
      return { acquired: true, leaseToken: newLeaseToken, leaseExpiresAt }
    }

    // Check if request_id has already been locked by a different tx_hash
    const checkReqStmt = this.db.prepare(`SELECT tx_hash, state, cached_response, caller FROM payments WHERE request_id = ?`)
    const existingReq = checkReqStmt.get(normRequestId) as
      | { tx_hash: string; state: PaymentState; cached_response: string | null; caller: string }
      | undefined

    if (existingReq) {
      if (existingReq.state === 'SUCCEEDED') {
        return {
          acquired: false,
          reason: 'ALREADY_SUCCEEDED',
          cachedResponse: existingReq.cached_response ?? undefined,
          caller: existingReq.caller as Address,
        }
      }
      return { acquired: false, reason: 'REQUEST_ID_ALREADY_USED' }
    }

    // Insert new payment lock with state 'RESERVED' and lease metadata
    try {
      const insertStmt = this.db.prepare(`
        INSERT INTO payments (
          tx_hash, request_id, service_id, caller, amount_paid,
          state, created_at, updated_at, lease_owner, lease_expires_at, lease_token
        ) VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?)
      `)
      insertStmt.run(
        normTxHash,
        normRequestId,
        params.serviceId.toString(),
        normCaller,
        params.amountPaid.toString(),
        now,
        now,
        leaseOwner,
        leaseExpiresAt,
        newLeaseToken
      )
      return { acquired: true, leaseToken: newLeaseToken, leaseExpiresAt }
    } catch {
      // Unique constraint violation due to race condition
      return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
    }
  }

  /**
   * Transitions payment state with optimistic verification and optional fencing token check.
   */
  public async transitionState(
    txHash: Hex,
    fromState: PaymentState,
    toState: PaymentState,
    leaseToken?: string
  ): Promise<boolean> {
    const now = Date.now()
    if (leaseToken !== undefined) {
      const stmt = this.db.prepare(`
        UPDATE payments SET state = ?, updated_at = ?
        WHERE tx_hash = ? AND state = ? AND lease_token = ?
      `)
      const res = stmt.run(toState, now, txHash.toLowerCase(), fromState, leaseToken)
      return res.changes > 0
    }
    const stmt = this.db.prepare(`
      UPDATE payments SET state = ?, updated_at = ?
      WHERE tx_hash = ? AND state = ?
    `)
    const res = stmt.run(toState, now, txHash.toLowerCase(), fromState)
    return res.changes > 0
  }

  /**
   * Extends the lease for long-running operations while lease is currently active.
   */
  public async renewLease(
    txHash: Hex,
    leaseToken: string,
    additionalTtlMs: number = 30000
  ): Promise<boolean> {
    const now = Date.now()
    const newExpiresAt = now + additionalTtlMs
    const stmt = this.db.prepare(`
      UPDATE payments SET lease_expires_at = ?, updated_at = ?
      WHERE tx_hash = ? AND lease_token = ? AND lease_expires_at > ?
    `)
    const res = stmt.run(newExpiresAt, now, txHash.toLowerCase(), leaseToken, now)
    return res.changes > 0
  }

  /**
   * Recovers lingering in-flight states whose lease has demonstrably expired.
   * Unexpired leases (active on other nodes) are strictly untouched (Invariant C).
   */
  public async recoverStartupStates(cutoffTime: number = Date.now()): Promise<StartupRecoveryResult> {
    return this.recoverExpiredLeases(cutoffTime)
  }

  /**
   * Sweeps expired leases across distributed nodes.
   */
  public async recoverExpiredLeases(cutoffTime: number = Date.now()): Promise<StartupRecoveryResult> {
    const now = Date.now()
    const stmtDispatching = this.db.prepare(`
      UPDATE payments SET
        state = 'UNCERTAIN',
        failure_reason = 'Upstream dispatch lease expired; locked to UNCERTAIN to prevent duplicate operations',
        updated_at = ?
      WHERE state = 'DISPATCHING' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `)
    const resDispatch = stmtDispatching.run(now, cutoffTime)

    const stmtPreDispatch = this.db.prepare(`
      UPDATE payments SET
        state = 'FAILED',
        failure_reason = 'Pre-dispatch reservation lease expired; reset for safe retry',
        updated_at = ?
      WHERE state IN ('RESERVED', 'VERIFYING') AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `)
    const resPreDispatch = stmtPreDispatch.run(now, cutoffTime)

    return {
      recoveredUncertain: Number(resDispatch.changes),
      recoveredFailed: Number(resPreDispatch.changes),
    }
  }

  /**
   * Records a successful upstream execution and caches response.
   * Guarded: Mutation succeeds ONLY when the current state is 'DISPATCHING' and lease_token matches.
   * Requires exactly one affected row. Throws PaymentStateTransitionError if state or token changed.
   */
  public async recordSuccess(
    txHash: Hex,
    cachedResponse: string,
    verifiedCaller?: Address,
    leaseToken?: string
  ): Promise<void> {
    const now = Date.now()
    let stmt
    let res

    if (leaseToken !== undefined) {
      if (verifiedCaller) {
        stmt = this.db.prepare(`
          UPDATE payments SET 
            state = 'SUCCEEDED',
            caller = ?,
            cached_response = ?,
            consumed_at = ?,
            updated_at = ?
          WHERE tx_hash = ? AND state = 'DISPATCHING' AND lease_token = ?
        `)
        res = stmt.run(verifiedCaller.toLowerCase(), cachedResponse, now, now, txHash.toLowerCase(), leaseToken)
      } else {
        stmt = this.db.prepare(`
          UPDATE payments SET 
            state = 'SUCCEEDED',
            cached_response = ?,
            consumed_at = ?,
            updated_at = ?
          WHERE tx_hash = ? AND state = 'DISPATCHING' AND lease_token = ?
        `)
        res = stmt.run(cachedResponse, now, now, txHash.toLowerCase(), leaseToken)
      }
    } else {
      if (verifiedCaller) {
        stmt = this.db.prepare(`
          UPDATE payments SET 
            state = 'SUCCEEDED',
            caller = ?,
            cached_response = ?,
            consumed_at = ?,
            updated_at = ?
          WHERE tx_hash = ? AND state = 'DISPATCHING'
        `)
        res = stmt.run(verifiedCaller.toLowerCase(), cachedResponse, now, now, txHash.toLowerCase())
      } else {
        stmt = this.db.prepare(`
          UPDATE payments SET 
            state = 'SUCCEEDED',
            cached_response = ?,
            consumed_at = ?,
            updated_at = ?
          WHERE tx_hash = ? AND state = 'DISPATCHING'
        `)
        res = stmt.run(cachedResponse, now, now, txHash.toLowerCase())
      }
    }

    if (res.changes !== 1) {
      throw new PaymentStateTransitionError(
        `Failed to record success for txHash ${txHash.toLowerCase()}: expected state 'DISPATCHING' with valid lease token and 1 affected row, got ${res.changes} affected rows.`
      )
    }
  }

  /**
   * Records a definite failure (e.g. failed before dispatch) with optional lease fencing.
   */
  public async recordFailed(txHash: Hex, reason: string, leaseToken?: string): Promise<void> {
    const now = Date.now()
    if (leaseToken !== undefined) {
      const stmt = this.db.prepare(`
        UPDATE payments SET 
          state = 'FAILED',
          failure_reason = ?,
          updated_at = ?
        WHERE tx_hash = ? AND lease_token = ?
      `)
      stmt.run(reason, now, txHash.toLowerCase(), leaseToken)
    } else {
      const stmt = this.db.prepare(`
        UPDATE payments SET 
          state = 'FAILED',
          failure_reason = ?,
          updated_at = ?
        WHERE tx_hash = ?
      `)
      stmt.run(reason, now, txHash.toLowerCase())
    }
  }

  /**
   * Records an uncertain outcome (e.g. upstream timeout after possible dispatch).
   * Payment is locked closed to prevent double execution.
   */
  public async recordUncertain(txHash: Hex, reason: string, leaseToken?: string): Promise<void> {
    const now = Date.now()
    if (leaseToken !== undefined) {
      const stmt = this.db.prepare(`
        UPDATE payments SET 
          state = 'UNCERTAIN',
          failure_reason = ?,
          updated_at = ?
        WHERE tx_hash = ? AND (lease_token = ? OR lease_token IS NULL)
      `)
      stmt.run(reason, now, txHash.toLowerCase(), leaseToken)
    } else {
      const stmt = this.db.prepare(`
        UPDATE payments SET 
          state = 'UNCERTAIN',
          failure_reason = ?,
          updated_at = ?
        WHERE tx_hash = ?
      `)
      stmt.run(reason, now, txHash.toLowerCase())
    }
  }

  /**
   * Retrieves a payment record by transaction hash.
   */
  public async getPayment(txHash: Hex): Promise<PaymentRecord | null> {
    const stmt = this.db.prepare(`SELECT * FROM payments WHERE tx_hash = ?`)
    const row = stmt.get(txHash.toLowerCase()) as Record<string, unknown> | undefined

    if (!row) return null

    return {
      txHash: row.tx_hash as Hex,
      requestId: row.request_id as Hex,
      serviceId: BigInt(row.service_id as string),
      caller: row.caller as Address,
      amountPaid: BigInt(row.amount_paid as string),
      state: row.state as PaymentState,
      cachedResponse: row.cached_response as string | null,
      failureReason: row.failure_reason as string | null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      consumedAt: row.consumed_at ? Number(row.consumed_at) : null,
      leaseOwner: (row.lease_owner as string) ?? null,
      leaseExpiresAt: row.lease_expires_at ? Number(row.lease_expires_at) : null,
      leaseToken: (row.lease_token as string) ?? null,
    }
  }

  /**
   * Health check / readiness ping.
   */
  public async ping(): Promise<boolean> {
    try {
      const stmt = this.db.prepare('SELECT 1 as alive')
      const row = stmt.get() as { alive?: number } | undefined
      return row?.alive === 1
    } catch {
      return false
    }
  }

  public async close(): Promise<void> {
    this.db.close()
  }
}

const req = createRequire(import.meta.url)
let _libSqlAvailableOverride: boolean | null = null

export function setLibSqlAvailableForTesting(available: boolean | null): void {
  _libSqlAvailableOverride = available
}

export function isLibSqlAvailable(): boolean {
  if (_libSqlAvailableOverride !== null) return _libSqlAvailableOverride
  try {
    req.resolve('@libsql/client')
    return true
  } catch {
    return false
  }
}

/**
 * Sanitizes a database URL for safe logging and error messages,
 * ensuring sensitive credentials (passwords, auth tokens, queries) are never exposed.
 */
export function sanitizeDatabaseUrl(rawUrl: string): string {
  if (!rawUrl) return ''
  const trimmed = rawUrl.trim()
  if (trimmed === ':memory:' || trimmed.startsWith('file:')) {
    return trimmed.split('?')[0] || trimmed
  }
  try {
    const parsed = new URL(trimmed)
    parsed.password = ''
    parsed.username = ''
    parsed.search = ''
    return parsed.toString()
  } catch {
    return trimmed.split('?')[0] || trimmed
  }
}

/**
 * Validates database URL schemes and configuration without exposing credentials.
 */
export function validateDatabaseUrl(rawUrl: string, authToken?: string): void {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new GatewayConfigurationError(
      'Database URL is empty or missing. A valid database URL is required when remote storage is configured.'
    )
  }

  const trimmed = rawUrl.trim()
  if (trimmed === ':memory:' || trimmed.startsWith('file:')) {
    return
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new GatewayConfigurationError(
      `Invalid database URL format: "${sanitizeDatabaseUrl(trimmed)}". Expected a valid URL with scheme libsql://, https://, http://, or file:.`
    )
  }

  const allowedSchemes = ['libsql:', 'https:', 'http:', 'file:']
  if (!allowedSchemes.includes(parsed.protocol)) {
    throw new GatewayConfigurationError(
      `Unsupported database URL scheme "${parsed.protocol}" in "${sanitizeDatabaseUrl(trimmed)}". Supported schemes are: libsql://, https://, http://, file:.`
    )
  }

  if (parsed.hostname.endsWith('turso.io') && (!authToken || !authToken.trim())) {
    throw new GatewayConfigurationError(
      `Turso Cloud database URL "${sanitizeDatabaseUrl(trimmed)}" requires an authentication token (TURSO_AUTH_TOKEN).`
    )
  }
}

/**
 * Remote libSQL Store Adapter for Turso Cloud integration and distributed multi-instance deployment.
 * Supports WebSocket (libsql://), HTTP (https://), and local file/in-memory (file:) connections.
 * Enforces atomic locks, lease fencing, fail-closed state machines, and safe idempotent caching.
 */
export class LibSqlGatewayStore implements GatewayStore {
  public readonly url: string
  public readonly authToken?: string
  public readonly instanceId: string
  private client: Client
  private initialized = false

  constructor(config: { url: string; authToken?: string; instanceId?: string }) {
    if (!isLibSqlAvailable()) {
      throw new GatewayConfigurationError(
        '@libsql/client is not installed in the workspace. Remote database operations (libsql:// or https://) require installing @libsql/client in a separately authorized stage.'
      )
    }

    validateDatabaseUrl(config.url, config.authToken)

    this.url = config.url.trim()
    this.authToken = config.authToken
    this.instanceId = config.instanceId ?? `pg402-libsql-${process.pid}-${randomBytes(8).toString('hex')}`

    this.client = createClient({
      url: this.url,
      authToken: this.authToken,
    })
  }

  public async init(): Promise<void> {
    if (this.initialized) return

    // Enable foreign keys if supported by the connection
    try {
      await this.client.execute('PRAGMA foreign_keys = ON;')
    } catch {
      // Some remote HTTP setups may not support PRAGMA or enforce foreign keys at database level
    }

    await this.client.batch(
      [
        `CREATE TABLE IF NOT EXISTS challenges (
          request_id TEXT PRIMARY KEY,
          service_id TEXT NOT NULL,
          payer TEXT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          body_digest TEXT NOT NULL,
          quoted_price TEXT NOT NULL,
          chain_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('ISSUED', 'CONSUMED', 'EXPIRED'))
        );`,
        `CREATE TABLE IF NOT EXISTS payments (
          tx_hash TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE REFERENCES challenges(request_id),
          service_id TEXT NOT NULL,
          caller TEXT NOT NULL,
          amount_paid TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('PENDING', 'VERIFYING', 'RESERVED', 'DISPATCHING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN')),
          cached_response TEXT,
          failure_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          consumed_at INTEGER,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          lease_token TEXT
        );`,
        `CREATE INDEX IF NOT EXISTS idx_challenges_payer ON challenges(payer);`,
        `CREATE INDEX IF NOT EXISTS idx_payments_request ON payments(request_id);`,
      ],
      'write'
    )

    // Migration for existing tables created prior to Gate 3 (lease columns):
    try {
      const tableInfo = await this.client.execute('PRAGMA table_info(payments);')
      const columnNames = new Set(tableInfo.rows.map(col => String(col.name)))
      if (!columnNames.has('lease_owner')) {
        await this.client.execute('ALTER TABLE payments ADD COLUMN lease_owner TEXT;')
      }
      if (!columnNames.has('lease_expires_at')) {
        await this.client.execute('ALTER TABLE payments ADD COLUMN lease_expires_at INTEGER;')
      }
      if (!columnNames.has('lease_token')) {
        await this.client.execute('ALTER TABLE payments ADD COLUMN lease_token TEXT;')
      }
    } catch {
      // Ignore if table_info pragma is unsupported or table does not exist
    }

    try {
      await this.client.execute('CREATE INDEX IF NOT EXISTS idx_payments_lease_expiry ON payments(lease_expires_at);')
    } catch {
      // Ignore
    }

    this.initialized = true
  }

  /**
   * Persists a server-issued challenge bound to the caller's request metadata.
   */
  public async createChallenge(challenge: PaymentChallenge): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO challenges (
        request_id, service_id, payer, method, path, body_digest,
        quoted_price, chain_id, created_at, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        challenge.requestId.toLowerCase(),
        challenge.serviceId.toString(),
        challenge.payer.toLowerCase(),
        challenge.method.toUpperCase(),
        challenge.path,
        challenge.bodyDigest.toLowerCase(),
        challenge.quotedPrice.toString(),
        challenge.chainId,
        challenge.createdAt,
        challenge.expiresAt,
        challenge.status,
      ],
    })
  }

  /**
   * Retrieves a challenge by request ID.
   */
  public async getChallenge(requestId: Hex): Promise<PaymentChallenge | null> {
    const result = await this.client.execute({
      sql: `SELECT * FROM challenges WHERE request_id = ?`,
      args: [requestId.toLowerCase()],
    })

    if (result.rows.length === 0) return null
    const row = result.rows[0]!

    return {
      requestId: row.request_id as Hex,
      serviceId: BigInt(row.service_id as string),
      payer: (row.payer as string) as Address,
      method: row.method as string,
      path: row.path as string,
      bodyDigest: row.body_digest as Hex,
      quotedPrice: BigInt(row.quoted_price as string),
      chainId: Number(row.chain_id),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      status: row.status as 'ISSUED' | 'CONSUMED' | 'EXPIRED',
    }
  }

  /**
   * Marks a challenge as consumed.
   */
  public async markChallengeConsumed(requestId: Hex): Promise<void> {
    await this.client.execute({
      sql: `UPDATE challenges SET status = 'CONSUMED' WHERE request_id = ?`,
      args: [requestId.toLowerCase()],
    })
  }

  /**
   * Atomically acquires a lock on the transaction hash and request ID with lease fencing.
   * Prevents two concurrent requests from unlocking the payment twice across distributed instances.
   */
  public async tryAcquirePaymentLock(params: AcquirePaymentLockParams): Promise<AcquireLockResult> {
    const now = Date.now()
    const normTxHash = params.txHash.toLowerCase()
    const normRequestId = params.requestId.toLowerCase()
    const normCaller = params.caller.toLowerCase()
    const leaseOwner = params.leaseOwner ?? this.instanceId
    const leaseTtlMs = params.leaseTtlMs ?? 30000
    const leaseExpiresAt = now + leaseTtlMs
    const newLeaseToken = `0x${randomBytes(16).toString('hex')}`

    let tx
    try {
      tx = await this.client.transaction('write')
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
      if (
        msg.includes('sqlite_busy') ||
        msg.includes('database is locked') ||
        msg.includes('busy') ||
        msg.includes('conflict') ||
        msg.includes('cannot start a transaction')
      ) {
        return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
      }
      throw err
    }

    try {
      // 1. Query existing payment by tx_hash
      const checkTxRes = await tx.execute({
        sql: `SELECT state, cached_response, request_id, caller, lease_owner, lease_expires_at, lease_token FROM payments WHERE tx_hash = ?`,
        args: [normTxHash],
      })

      if (checkTxRes.rows.length > 0) {
        const existingTx = checkTxRes.rows[0]!
        const existingState = existingTx.state as PaymentState

        if (existingState === 'SUCCEEDED') {
          if (existingTx.request_id === normRequestId) {
            await tx.rollback()
            return {
              acquired: false,
              reason: 'ALREADY_SUCCEEDED',
              cachedResponse: (existingTx.cached_response as string | null) ?? undefined,
              caller: existingTx.caller as Address,
            }
          }
          await tx.rollback()
          return {
            acquired: false,
            reason: 'PAYMENT_ALREADY_CONSUMED',
          }
        }

        if (existingState === 'UNCERTAIN') {
          await tx.rollback()
          return { acquired: false, reason: 'UNCERTAIN_LOCKED' }
        }

        if (existingState === 'FAILED') {
          // Atomic update to RESERVED with fresh lease
          const updateRes = await tx.execute({
            sql: `UPDATE payments SET 
              state = 'RESERVED',
              failure_reason = NULL,
              lease_owner = ?,
              lease_expires_at = ?,
              lease_token = ?,
              updated_at = ?
            WHERE tx_hash = ? AND state = 'FAILED'`,
            args: [leaseOwner, leaseExpiresAt, newLeaseToken, now, normTxHash],
          })

          if (updateRes.rowsAffected === 0) {
            await tx.rollback()
            return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
          }

          await tx.commit()
          return { acquired: true, leaseToken: newLeaseToken, leaseExpiresAt }
        }

        // State is RESERVED, VERIFYING, or DISPATCHING:
        const existingExpiry = existingTx.lease_expires_at ? Number(existingTx.lease_expires_at) : 0
        const isLeaseActive = existingExpiry > now

        if (isLeaseActive) {
          await tx.rollback()
          return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
        }

        // Lease has EXPIRED:
        if (existingState === 'DISPATCHING') {
          // Dispatched upstream: Ambiguous external side-effect!
          // Lock to UNCERTAIN to prevent duplicate operations (Invariants D & E)
          await tx.execute({
            sql: `UPDATE payments SET
              state = 'UNCERTAIN',
              failure_reason = 'Dispatched upstream lease expired; locked to UNCERTAIN to prevent duplicate operations',
              updated_at = ?
            WHERE tx_hash = ? AND state = 'DISPATCHING' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
            args: [now, normTxHash, now],
          })
          await tx.commit()
          return { acquired: false, reason: 'UNCERTAIN_LOCKED' }
        }

        // Pre-dispatch reservation expired (RESERVED or VERIFYING): Reclaim atomically
        const reclaimRes = await tx.execute({
          sql: `UPDATE payments SET
            state = 'RESERVED',
            failure_reason = 'Previous pre-dispatch lease expired; reclaimed by new instance',
            lease_owner = ?,
            lease_expires_at = ?,
            lease_token = ?,
            updated_at = ?
          WHERE tx_hash = ? AND state IN ('RESERVED', 'VERIFYING') AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
          args: [leaseOwner, leaseExpiresAt, newLeaseToken, now, normTxHash, now],
        })

        if (reclaimRes.rowsAffected === 0) {
          await tx.rollback()
          return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
        }

        await tx.commit()
        return { acquired: true, leaseToken: newLeaseToken, leaseExpiresAt }
      }

      // 2. Check if request_id has already been locked by a different tx_hash
      const checkReqRes = await tx.execute({
        sql: `SELECT tx_hash, state, cached_response, caller FROM payments WHERE request_id = ?`,
        args: [normRequestId],
      })

      if (checkReqRes.rows.length > 0) {
        const existingReq = checkReqRes.rows[0]!
        if (existingReq.state === 'SUCCEEDED') {
          await tx.rollback()
          return {
            acquired: false,
            reason: 'ALREADY_SUCCEEDED',
            cachedResponse: (existingReq.cached_response as string | null) ?? undefined,
            caller: existingReq.caller as Address,
          }
        }
        await tx.rollback()
        return { acquired: false, reason: 'REQUEST_ID_ALREADY_USED' }
      }

      // 3. Insert new payment lock with state 'RESERVED' and lease metadata
      await tx.execute({
        sql: `INSERT INTO payments (
          tx_hash, request_id, service_id, caller, amount_paid,
          state, created_at, updated_at, lease_owner, lease_expires_at, lease_token
        ) VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?)`,
        args: [
          normTxHash,
          normRequestId,
          params.serviceId.toString(),
          normCaller,
          params.amountPaid.toString(),
          now,
          now,
          leaseOwner,
          leaseExpiresAt,
          newLeaseToken,
        ],
      })

      await tx.commit()
      return { acquired: true, leaseToken: newLeaseToken, leaseExpiresAt }
    } catch (err: unknown) {
      if (!tx.closed) {
        await tx.rollback().catch(() => {})
      }

      // Blocker 4: Idempotency Reconciliation on Ambiguous Commit / Network Socket Loss
      // If tx.commit() was transmitted but network dropped before acknowledgment,
      // verify whether this attempt's leaseToken was actually committed remotely.
      try {
        const reconcileRes = await this.client.execute({
          sql: `SELECT state, request_id, cached_response, caller, lease_token, lease_expires_at FROM payments WHERE tx_hash = ?`,
          args: [normTxHash],
        })
        if (reconcileRes.rows.length > 0) {
          const row = reconcileRes.rows[0]!
          const rowState = row.state as PaymentState
          // If the payment is RESERVED with our specific newLeaseToken, commit actually succeeded!
          if (rowState === 'RESERVED' && row.lease_token === newLeaseToken) {
            return {
              acquired: true,
              leaseToken: newLeaseToken,
              leaseExpiresAt: Number(row.lease_expires_at) || leaseExpiresAt,
            }
          }
          // If the payment is already SUCCEEDED for this request_id, recover cached response
          if (rowState === 'SUCCEEDED' && row.request_id === normRequestId) {
            return {
              acquired: false,
              reason: 'ALREADY_SUCCEEDED',
              cachedResponse: (row.cached_response as string | null) ?? undefined,
              caller: row.caller as Address,
            }
          }
        }
      } catch {
        // Reconciliation check could not complete (e.g. database fully unreachable); proceed to error mapping
      }

      // Blocker 3: Catch SQLITE_BUSY and serialization errors and map to CONCURRENT_CONFLICT
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
      if (
        msg.includes('unique constraint') ||
        msg.includes('sqlite_constraint') ||
        msg.includes('sqlite_busy') ||
        msg.includes('database is locked') ||
        msg.includes('busy') ||
        msg.includes('conflict') ||
        msg.includes('cannot start a transaction')
      ) {
        return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
      }
      throw err
    } finally {
      tx.close()
    }
  }

  /**
   * Transitions payment state with optimistic verification and optional fencing token check.
   */
  public async transitionState(
    txHash: Hex,
    fromState: PaymentState,
    toState: PaymentState,
    leaseToken?: string
  ): Promise<boolean> {
    const now = Date.now()
    try {
      let result
      if (leaseToken !== undefined) {
        result = await this.client.execute({
          sql: `UPDATE payments SET state = ?, updated_at = ?
                WHERE tx_hash = ? AND state = ? AND lease_token = ?`,
          args: [toState, now, txHash.toLowerCase(), fromState, leaseToken],
        })
      } else {
        result = await this.client.execute({
          sql: `UPDATE payments SET state = ?, updated_at = ?
                WHERE tx_hash = ? AND state = ?`,
          args: [toState, now, txHash.toLowerCase(), fromState],
        })
      }
      return result.rowsAffected > 0
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
      if (
        msg.includes('sqlite_busy') ||
        msg.includes('database is locked') ||
        msg.includes('busy') ||
        msg.includes('conflict')
      ) {
        return false // Serialization contention prevents state transition; fail closed
      }
      throw err
    }
  }

  /**
   * Renews lease for active long-running in-flight operations.
   */
  public async renewLease(
    txHash: Hex,
    leaseToken: string,
    additionalTtlMs: number = 30000
  ): Promise<boolean> {
    const now = Date.now()
    const newExpiresAt = now + additionalTtlMs
    const result = await this.client.execute({
      sql: `UPDATE payments SET lease_expires_at = ?, updated_at = ?
            WHERE tx_hash = ? AND lease_token = ? AND lease_expires_at > ?`,
      args: [newExpiresAt, now, txHash.toLowerCase(), leaseToken, now],
    })
    return result.rowsAffected > 0
  }

  /**
   * Recovers lingering in-flight states whose lease has demonstrably expired.
   */
  public async recoverStartupStates(cutoffTime: number = Date.now()): Promise<StartupRecoveryResult> {
    return this.recoverExpiredLeases(cutoffTime)
  }

  /**
   * Sweeps expired leases across distributed nodes.
   */
  public async recoverExpiredLeases(cutoffTime: number = Date.now()): Promise<StartupRecoveryResult> {
    const now = Date.now()
    const resDispatch = await this.client.execute({
      sql: `UPDATE payments SET
        state = 'UNCERTAIN',
        failure_reason = 'Upstream dispatch lease expired; locked to UNCERTAIN to prevent duplicate operations',
        updated_at = ?
      WHERE state = 'DISPATCHING' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      args: [now, cutoffTime],
    })

    const resPreDispatch = await this.client.execute({
      sql: `UPDATE payments SET
        state = 'FAILED',
        failure_reason = 'Pre-dispatch reservation lease expired; reset for safe retry',
        updated_at = ?
      WHERE state IN ('RESERVED', 'VERIFYING') AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      args: [now, cutoffTime],
    })

    return {
      recoveredUncertain: Number(resDispatch.rowsAffected),
      recoveredFailed: Number(resPreDispatch.rowsAffected),
    }
  }

  /**
   * Records a successful upstream execution and caches response.
   * Guarded: Mutation succeeds ONLY when the current state is 'DISPATCHING' and lease_token matches.
   * Throws PaymentStateTransitionError if state or token changed.
   */
  public async recordSuccess(
    txHash: Hex,
    cachedResponse: string,
    verifiedCaller?: Address,
    leaseToken?: string
  ): Promise<void> {
    const now = Date.now()
    let result

    if (leaseToken !== undefined) {
      if (verifiedCaller) {
        result = await this.client.execute({
          sql: `UPDATE payments SET 
            state = 'SUCCEEDED',
            caller = ?,
            cached_response = ?,
            consumed_at = ?,
            updated_at = ?
          WHERE tx_hash = ? AND state = 'DISPATCHING' AND lease_token = ?`,
          args: [verifiedCaller.toLowerCase(), cachedResponse, now, now, txHash.toLowerCase(), leaseToken],
        })
      } else {
        result = await this.client.execute({
          sql: `UPDATE payments SET 
            state = 'SUCCEEDED',
            cached_response = ?,
            consumed_at = ?,
            updated_at = ?
          WHERE tx_hash = ? AND state = 'DISPATCHING' AND lease_token = ?`,
          args: [cachedResponse, now, now, txHash.toLowerCase(), leaseToken],
        })
      }
    } else {
      if (verifiedCaller) {
        result = await this.client.execute({
          sql: `UPDATE payments SET 
            state = 'SUCCEEDED',
            caller = ?,
            cached_response = ?,
            consumed_at = ?,
            updated_at = ?
          WHERE tx_hash = ? AND state = 'DISPATCHING'`,
          args: [verifiedCaller.toLowerCase(), cachedResponse, now, now, txHash.toLowerCase()],
        })
      } else {
        result = await this.client.execute({
          sql: `UPDATE payments SET 
            state = 'SUCCEEDED',
            cached_response = ?,
            consumed_at = ?,
            updated_at = ?
          WHERE tx_hash = ? AND state = 'DISPATCHING'`,
          args: [cachedResponse, now, now, txHash.toLowerCase()],
        })
      }
    }

    if (result.rowsAffected === 0) {
      throw new PaymentStateTransitionError(
        `Failed to record success for txHash ${txHash}: state was not DISPATCHING or lease token expired/mismatched.`
      )
    }
  }

  /**
   * Records failure reason and transitions state to 'FAILED' for safe retry.
   */
  public async recordFailed(txHash: Hex, reason: string, leaseToken?: string): Promise<void> {
    const now = Date.now()
    if (leaseToken !== undefined) {
      await this.client.execute({
        sql: `UPDATE payments SET 
          state = 'FAILED',
          failure_reason = ?,
          updated_at = ?
        WHERE tx_hash = ? AND (lease_token = ? OR lease_token IS NULL)`,
        args: [reason, now, txHash.toLowerCase(), leaseToken],
      })
    } else {
      await this.client.execute({
        sql: `UPDATE payments SET 
          state = 'FAILED',
          failure_reason = ?,
          updated_at = ?
        WHERE tx_hash = ?`,
        args: [reason, now, txHash.toLowerCase()],
      })
    }
  }

  /**
   * Permanently locks payment state to 'UNCERTAIN' (fail-closed) on timeout.
   */
  public async recordUncertain(txHash: Hex, reason: string, leaseToken?: string): Promise<void> {
    const now = Date.now()
    if (leaseToken !== undefined) {
      await this.client.execute({
        sql: `UPDATE payments SET 
          state = 'UNCERTAIN',
          failure_reason = ?,
          updated_at = ?
        WHERE tx_hash = ? AND (lease_token = ? OR lease_token IS NULL)`,
        args: [reason, now, txHash.toLowerCase(), leaseToken],
      })
    } else {
      await this.client.execute({
        sql: `UPDATE payments SET 
          state = 'UNCERTAIN',
          failure_reason = ?,
          updated_at = ?
        WHERE tx_hash = ?`,
        args: [reason, now, txHash.toLowerCase()],
      })
    }
  }

  /**
   * Retrieves a payment record by transaction hash.
   */
  public async getPayment(txHash: Hex): Promise<PaymentRecord | null> {
    const result = await this.client.execute({
      sql: `SELECT * FROM payments WHERE tx_hash = ?`,
      args: [txHash.toLowerCase()],
    })

    if (result.rows.length === 0) return null
    const row = result.rows[0]!

    return {
      txHash: row.tx_hash as Hex,
      requestId: row.request_id as Hex,
      serviceId: BigInt(row.service_id as string),
      caller: row.caller as Address,
      amountPaid: BigInt(row.amount_paid as string),
      state: row.state as PaymentState,
      cachedResponse: (row.cached_response as string | null) ?? null,
      failureReason: (row.failure_reason as string | null) ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      consumedAt: row.consumed_at ? Number(row.consumed_at) : null,
      leaseOwner: (row.lease_owner as string | null) ?? null,
      leaseExpiresAt: row.lease_expires_at ? Number(row.lease_expires_at) : null,
      leaseToken: (row.lease_token as string | null) ?? null,
    }
  }

  /**
   * Health check / readiness ping.
   */
  public async ping(): Promise<boolean> {
    try {
      const result = await this.client.execute('SELECT 1 as alive;')
      return result.rows.length > 0 && result.rows[0]?.alive === 1
    } catch {
      return false
    }
  }

  /**
   * Closes database connection.
   */
  public async close(): Promise<void> {
    await this.client.close()
  }
}

/**
 * Store Factory: instantiates appropriate storage adapter based on configuration.
 */
export function createGatewayStore(config: {
  dbPath?: string
  remoteUrl?: string
  databaseUrl?: string
  remoteStore?: boolean
  authToken?: string
  instanceId?: string
}): GatewayStore {
  const remoteUrl = config.remoteUrl ?? config.databaseUrl
  if (config.remoteStore || remoteUrl) {
    if (!remoteUrl) {
      throw new GatewayConfigurationError(
        'Remote storage is configured (remoteStore=true), but no database URL was provided (DATABASE_URL / TURSO_DATABASE_URL). Refusing to silently fall back to ephemeral local SQLite.'
      )
    }
    return new LibSqlGatewayStore({
      url: remoteUrl,
      authToken: config.authToken,
      instanceId: config.instanceId,
    })
  }
  return new SqliteGatewayStore(config.dbPath ?? ':memory:', config.instanceId)
}

// Backward-compatibility alias
export const GatewayDb = SqliteGatewayStore
export type GatewayDb = SqliteGatewayStore
