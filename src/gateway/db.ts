/**
 * Gateway Database Manager using Node.js Native SQLite (DatabaseSync)
 * Provides ACID state management, atomic locking, and replay prevention.
 */
import { DatabaseSync } from 'node:sqlite'
import type { Address, Hex } from 'viem'
import type { PaymentChallenge, PaymentRecord, PaymentState } from './types.ts'

export class GatewayDb {
  private db: DatabaseSync

  constructor(dbPath: string = ':memory:') {
    this.db = new DatabaseSync(dbPath)
    this.init()
  }

  private init(): void {
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
        consumed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_challenges_payer ON challenges(payer);
      CREATE INDEX IF NOT EXISTS idx_payments_request ON payments(request_id);
    `)
  }

  /**
   * Persists a server-issued challenge bound to the caller's request metadata.
   */
  public createChallenge(challenge: PaymentChallenge): void {
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
  public getChallenge(requestId: Hex): PaymentChallenge | null {
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
  public markChallengeConsumed(requestId: Hex): void {
    const stmt = this.db.prepare(`UPDATE challenges SET status = 'CONSUMED' WHERE request_id = ?`)
    stmt.run(requestId.toLowerCase())
  }

  /**
   * Atomically acquires a lock on the transaction hash and request ID.
   * Prevents two concurrent requests from unlocking the payment twice.
   */
  public tryAcquirePaymentLock(params: {
    txHash: Hex
    requestId: Hex
    serviceId: bigint
    caller: Address
    amountPaid: bigint
  }):
    | { acquired: true }
    | {
        acquired: false
        reason: 'ALREADY_SUCCEEDED' | 'CONCURRENT_CONFLICT' | 'UNCERTAIN_LOCKED' | 'REQUEST_ID_ALREADY_USED' | 'PAYMENT_ALREADY_CONSUMED'
        cachedResponse?: string
      } {
    const now = Date.now()
    const normTxHash = params.txHash.toLowerCase()
    const normRequestId = params.requestId.toLowerCase()
    const normCaller = params.caller.toLowerCase()

    // Query existing payment by tx_hash
    const checkTxStmt = this.db.prepare(`SELECT state, cached_response, request_id FROM payments WHERE tx_hash = ?`)
    const existingTx = checkTxStmt.get(normTxHash) as
      | { state: PaymentState; cached_response: string | null; request_id: string }
      | undefined

    if (existingTx) {
      if (existingTx.state === 'SUCCEEDED') {
        if (existingTx.request_id === normRequestId) {
          return {
            acquired: false,
            reason: 'ALREADY_SUCCEEDED',
            cachedResponse: existingTx.cached_response ?? undefined,
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
      if (existingTx.state === 'VERIFYING' || existingTx.state === 'RESERVED' || existingTx.state === 'DISPATCHING') {
        return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
      }
      // If FAILED, we atomically update to RESERVED for retry
      const updateStmt = this.db.prepare(`
        UPDATE payments SET 
          state = 'RESERVED',
          updated_at = ?,
          failure_reason = NULL
        WHERE tx_hash = ? AND state = 'FAILED'
      `)
      const updateRes = updateStmt.run(now, normTxHash)
      if (updateRes.changes === 0) {
        // Lost race condition to concurrent retry attempt
        return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
      }
      return { acquired: true }
    }

    // Check if request_id has already been locked by a different tx_hash
    const checkReqStmt = this.db.prepare(`SELECT tx_hash, state, cached_response FROM payments WHERE request_id = ?`)
    const existingReq = checkReqStmt.get(normRequestId) as
      | { tx_hash: string; state: PaymentState; cached_response: string | null }
      | undefined

    if (existingReq) {
      if (existingReq.state === 'SUCCEEDED') {
        return {
          acquired: false,
          reason: 'ALREADY_SUCCEEDED',
          cachedResponse: existingReq.cached_response ?? undefined,
        }
      }
      return { acquired: false, reason: 'REQUEST_ID_ALREADY_USED' }
    }

    // Insert new payment lock with state 'RESERVED'
    try {
      const insertStmt = this.db.prepare(`
        INSERT INTO payments (
          tx_hash, request_id, service_id, caller, amount_paid,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?)
      `)
      insertStmt.run(
        normTxHash,
        normRequestId,
        params.serviceId.toString(),
        normCaller,
        params.amountPaid.toString(),
        now,
        now
      )
      return { acquired: true }
    } catch {
      // Unique constraint violation due to race condition
      return { acquired: false, reason: 'CONCURRENT_CONFLICT' }
    }
  }

  /**
   * Transitions payment state with optimistic verification.
   */
  public transitionState(txHash: Hex, fromState: PaymentState, toState: PaymentState): boolean {
    const now = Date.now()
    const stmt = this.db.prepare(`
      UPDATE payments SET state = ?, updated_at = ?
      WHERE tx_hash = ? AND state = ?
    `)
    const res = stmt.run(toState, now, txHash.toLowerCase(), fromState)
    return res.changes > 0
  }

  /**
   * Conservative startup recovery:
   * 1. In-flight DISPATCHING: might have executed upstream -> lock to UNCERTAIN (fail-closed).
   * 2. In-flight RESERVED or VERIFYING: crashed before dispatch commenced -> mark FAILED (safe to retry).
   */
  public recoverStartupStates(): { recoveredUncertain: number; recoveredFailed: number } {
    const now = Date.now()
    const stmtDispatching = this.db.prepare(`
      UPDATE payments SET
        state = 'UNCERTAIN',
        failure_reason = 'Process restarted while upstream dispatch was in-flight; locked to UNCERTAIN to prevent duplicate operations',
        updated_at = ?
      WHERE state = 'DISPATCHING'
    `)
    const resDispatch = stmtDispatching.run(now)

    const stmtPreDispatch = this.db.prepare(`
      UPDATE payments SET
        state = 'FAILED',
        failure_reason = 'Process restarted before dispatch commenced; payment reservation reset for safe retry',
        updated_at = ?
      WHERE state IN ('RESERVED', 'VERIFYING')
    `)
    const resPreDispatch = stmtPreDispatch.run(now)

    return {
      recoveredUncertain: Number(resDispatch.changes),
      recoveredFailed: Number(resPreDispatch.changes),
    }
  }

  /**
   * Records a successful upstream execution and caches response.
   */
  public recordSuccess(txHash: Hex, cachedResponse: string, verifiedCaller?: Address): void {
    const now = Date.now()
    if (verifiedCaller) {
      const stmt = this.db.prepare(`
        UPDATE payments SET 
          state = 'SUCCEEDED',
          caller = ?,
          cached_response = ?,
          consumed_at = ?,
          updated_at = ?
        WHERE tx_hash = ?
      `)
      stmt.run(verifiedCaller.toLowerCase(), cachedResponse, now, now, txHash.toLowerCase())
    } else {
      const stmt = this.db.prepare(`
        UPDATE payments SET 
          state = 'SUCCEEDED',
          cached_response = ?,
          consumed_at = ?,
          updated_at = ?
        WHERE tx_hash = ?
      `)
      stmt.run(cachedResponse, now, now, txHash.toLowerCase())
    }
  }

  /**
   * Records a definite failure (e.g. failed before dispatch).
   */
  public recordFailed(txHash: Hex, reason: string): void {
    const now = Date.now()
    const stmt = this.db.prepare(`
      UPDATE payments SET 
        state = 'FAILED',
        failure_reason = ?,
        updated_at = ?
      WHERE tx_hash = ?
    `)
    stmt.run(reason, now, txHash.toLowerCase())
  }

  /**
   * Records an uncertain outcome (e.g. upstream timeout after possible dispatch).
   * Payment is locked closed to prevent double execution.
   */
  public recordUncertain(txHash: Hex, reason: string): void {
    const now = Date.now()
    const stmt = this.db.prepare(`
      UPDATE payments SET 
        state = 'UNCERTAIN',
        failure_reason = ?,
        updated_at = ?
      WHERE tx_hash = ?
    `)
    stmt.run(reason, now, txHash.toLowerCase())
  }

  /**
   * Retrieves a payment record by transaction hash.
   */
  public getPayment(txHash: Hex): PaymentRecord | null {
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
    }
  }

  public close(): void {
    this.db.close()
  }
}
