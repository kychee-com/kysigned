/**
 * withCreateIdempotency — Idempotency-Key semantics for envelope creation
 * (spec F-30.3 / AC-136).
 *
 * Response-replay shape (the industry standard): the FIRST create under a key
 * reserves the (creator, key) row, runs the real create, and stores the 201
 * response; a retry with the same key + same payload replays that stored
 * response byte-for-byte — the create never runs twice, so exactly one
 * envelope and one debit exist no matter how often an agent retries. A
 * different payload under the same key is a client bug → 409
 * `idempotency_key_reuse`; a concurrent duplicate while the first is still
 * running → 409 `idempotency_in_flight`; a non-201 outcome releases the
 * reservation so the retry re-attempts for real (failures are never cached).
 *
 * Scoped per creator (PRIMARY KEY (creator_email, idempotency_key)) — two
 * creators can use the same key value independently.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { DbPool } from '../db/pool.js';

export interface IdempotencyCtx {
  pool: DbPool;
}

export interface CreateResult {
  status: number;
  body: unknown;
}

const KEY_MAX = 200;

export async function withCreateIdempotency(
  ctx: IdempotencyCtx,
  creatorEmail: string,
  idempotencyKey: string | null,
  requestPayload: string,
  run: () => Promise<CreateResult>,
  depth = 0,
): Promise<CreateResult> {
  // No header → exactly today's behavior.
  if (idempotencyKey == null || idempotencyKey.trim() === '') return run();

  const key = idempotencyKey.trim();
  if (key.length > KEY_MAX) {
    return {
      status: 400,
      body: { error: `Idempotency-Key exceeds ${KEY_MAX} characters`, code: 'validation_idempotency_key' },
    };
  }

  const requestHash = bytesToHex(sha256(utf8ToBytes(requestPayload)));

  // Reserve. ON CONFLICT DO NOTHING makes the race explicit: exactly one
  // caller wins the INSERT; everyone else sees rowCount 0 and reads the row.
  const reserved = await ctx.pool.query(
    `INSERT INTO idempotency_keys (creator_email, idempotency_key, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (creator_email, idempotency_key) DO NOTHING
     RETURNING creator_email`,
    [creatorEmail, key, requestHash],
  );

  if ((reserved.rowCount ?? reserved.rows.length) === 0) {
    // Someone holds this key — replay, reject, or report in-flight.
    const existing = await ctx.pool.query(
      `SELECT request_hash, response_status, response_body
         FROM idempotency_keys
        WHERE creator_email = $1 AND idempotency_key = $2`,
      [creatorEmail, key],
    );
    const row = existing.rows[0] as
      | { request_hash: string; response_status: number | null; response_body: unknown }
      | undefined;
    if (!row) {
      // Reservation vanished between INSERT and SELECT (a failed first attempt
      // released it). Retry the whole flow ONCE; a second miss means something
      // is systematically wrong (e.g. a lookup that can never see the row) —
      // report in-flight rather than loop.
      if (depth >= 1) {
        return {
          status: 409,
          body: {
            error: 'A request with this Idempotency-Key is still in flight — retry shortly',
            code: 'idempotency_in_flight',
          },
        };
      }
      return withCreateIdempotency(ctx, creatorEmail, key, requestPayload, run, depth + 1);
    }
    if (row.request_hash !== requestHash) {
      return {
        status: 409,
        body: {
          error: 'This Idempotency-Key was already used with a different payload',
          code: 'idempotency_key_reuse',
        },
      };
    }
    if (row.response_status == null) {
      return {
        status: 409,
        body: {
          error: 'A request with this Idempotency-Key is still in flight — retry shortly',
          code: 'idempotency_in_flight',
        },
      };
    }
    // Replay. jsonb can arrive as an object OR a serialized string (prod
    // HttpDbPool wire shape) — tolerate both.
    const body =
      typeof row.response_body === 'string' ? (JSON.parse(row.response_body) as unknown) : row.response_body;
    return { status: row.response_status, body };
  }

  // We hold the reservation — run the real create.
  let result: CreateResult;
  try {
    result = await run();
  } catch (err) {
    // The create THREW — release the reservation so a retry re-attempts.
    await releaseQuietly(ctx.pool, creatorEmail, key);
    throw err;
  }

  if (result.status === 201) {
    await ctx.pool.query(
      `UPDATE idempotency_keys
          SET response_status = $1, response_body = $2
        WHERE creator_email = $3 AND idempotency_key = $4`,
      [result.status, JSON.stringify(result.body), creatorEmail, key],
    );
  } else {
    // Failures are never cached — the retry should re-attempt for real.
    await releaseQuietly(ctx.pool, creatorEmail, key);
  }
  return result;
}

async function releaseQuietly(pool: DbPool, creatorEmail: string, key: string): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM idempotency_keys WHERE creator_email = $1 AND idempotency_key = $2`,
      [creatorEmail, key],
    );
  } catch {
    /* best-effort — an orphaned unfilled reservation reads as in-flight until cleaned */
  }
}
