/**
 * userCredits — per-email credit balance + audit ledger (spec F9.8 full).
 *
 * 2F.X15 full F9.8 (DD-28). Migration 007 ships the schema. Two tables:
 *   user_credits  — materialized running balance per email (fast reads).
 *   credit_ledger — append-only audit trail with UNIQUE(source, external_ref)
 *                   for idempotency. A provider's at-least-once webhook retries
 *                   (source, external_ref) can't double-credit.
 *
 * All operations are atomic per call (run402 wraps each db.sql() in
 * BEGIN/COMMIT). The idempotency check + balance mutation happen in a single
 * INSERT ... ON CONFLICT DO NOTHING followed by a single UPSERT. If the
 * ledger insert is a duplicate, the upsert is skipped.
 */
import type { DbPool } from './pool.js';

// The credit model's OWN ledger sources. The public template is PAYMENT-AGNOSTIC: it never
// names a payment provider. A provider top-up is proprietary `[service]` code
// that passes its own provider source string; `(string & {})` accepts any provider source
// while keeping autocomplete for the known first-party values.
export type CreditLedgerSource =
  | 'envelope'
  | 'admin_credit'
  | 'admin_debit'
  | 'refund'
  | 'signup_grant'
  | (string & {});

export interface CreditUserOpts {
  email: string;
  amountUsdMicros: bigint;
  source: CreditLedgerSource;
  externalRef: string;
  description: string | null;
}

export interface DebitUserOpts {
  email: string;
  amountUsdMicros: bigint;
  envelopeId: string;
}

export interface CreditResult {
  ok: boolean;
  balanceUsdMicros: bigint;
  deduplicated: boolean;
}

export interface DebitResult {
  ok: boolean;
  balanceUsdMicros: bigint;
  deduplicated: boolean;
  error?: 'INSUFFICIENT_BALANCE';
}

export interface LedgerEntry {
  id: string;
  deltaUsdMicros: bigint;
  source: CreditLedgerSource;
  externalRef: string;
  description: string | null;
  createdAt: Date;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') return BigInt(v);
  if (typeof v === 'number') return BigInt(v);
  return 0n;
}

export async function getCreditBalance(pool: DbPool, email: string): Promise<bigint> {
  const normalized = normalizeEmail(email);
  const result = await pool.query(
    `SELECT balance_usd_micros FROM user_credits WHERE email = $1`,
    [normalized],
  );
  if (result.rows.length === 0) return 0n;
  return toBigInt((result.rows[0] as { balance_usd_micros: string | number | bigint }).balance_usd_micros);
}

async function ledgerEntryExists(
  pool: DbPool,
  source: CreditLedgerSource,
  externalRef: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT id FROM credit_ledger WHERE source = $1 AND external_ref = $2`,
    [source, externalRef],
  );
  return result.rows.length > 0;
}

export async function creditUser(pool: DbPool, opts: CreditUserOpts): Promise<CreditResult> {
  const email = normalizeEmail(opts.email);
  if (opts.amountUsdMicros <= 0n) {
    throw new Error(`creditUser: amountUsdMicros must be positive (got ${opts.amountUsdMicros})`);
  }

  // Idempotency + balance mutation in ONE atomic statement — no check-then-insert
  // race (#71). The ledger INSERT is ON CONFLICT (source, external_ref) DO NOTHING,
  // so two concurrent provider webhook deliveries of the same session can't both pass a
  // pre-check and then collide on the UNIQUE constraint: the duplicate inserts 0
  // ledger rows → the upsert's SELECT FROM new_ledger is empty → the balance is
  // untouched → 0 rows come back (read as deduplicated). run402 wraps each call in
  // BEGIN/COMMIT, so both side-effects happen together or neither. (Credits are
  // always positive, so the user_credits CHECK is fine on the UPSERT insert path.)
  const result = await pool.query(
    `WITH new_ledger AS (
       INSERT INTO credit_ledger (email, delta_usd_micros, source, external_ref, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source, external_ref) DO NOTHING
       RETURNING delta_usd_micros
     ),
     upserted AS (
       INSERT INTO user_credits (email, balance_usd_micros, updated_at)
       SELECT $1, delta_usd_micros, now() FROM new_ledger
       ON CONFLICT (email)
       DO UPDATE SET balance_usd_micros = user_credits.balance_usd_micros + EXCLUDED.balance_usd_micros,
                     updated_at = now()
       RETURNING balance_usd_micros
     )
     SELECT balance_usd_micros FROM upserted`,
    [email, opts.amountUsdMicros.toString(), opts.source, opts.externalRef, opts.description],
  );

  // 0 rows ⇒ the ledger insert hit the UNIQUE(source, external_ref) conflict and
  // did nothing ⇒ a duplicate delivery. Re-read the (unchanged) balance.
  if (result.rows.length === 0) {
    const balance = await getCreditBalance(pool, email);
    return { ok: true, balanceUsdMicros: balance, deduplicated: true };
  }

  return {
    ok: true,
    balanceUsdMicros: toBigInt((result.rows[0] as { balance_usd_micros: string | number | bigint }).balance_usd_micros),
    deduplicated: false,
  };
}

export async function debitUser(pool: DbPool, opts: DebitUserOpts): Promise<DebitResult> {
  const email = normalizeEmail(opts.email);
  if (opts.amountUsdMicros <= 0n) {
    throw new Error(`debitUser: amountUsdMicros must be positive (got ${opts.amountUsdMicros})`);
  }

  // Idempotency check on (source=envelope, externalRef=envelopeId).
  if (await ledgerEntryExists(pool, 'envelope', opts.envelopeId)) {
    const balance = await getCreditBalance(pool, email);
    return { ok: true, balanceUsdMicros: balance, deduplicated: true };
  }

  // Atomic single-statement debit. The UPDATE only runs when
  // balance_usd_micros >= amount, so the CHECK constraint never sees a
  // negative would-be row. The ledger INSERT runs only when the UPDATE
  // succeeded (SELECT FROM updated returns 0 rows if balance insufficient).
  // run402 wraps the whole call in BEGIN/COMMIT, so either both side-effects
  // happen or neither — no orphan ledger entries on insufficient balance.
  //
  // PRIOR BUG: a UPSERT with a negative proposed-INSERT row triggered the
  // CHECK constraint BEFORE the ON CONFLICT DO UPDATE path resolved (CHECK
  // is evaluated on the would-be INSERT tuple per PostgreSQL semantics).
  const result = await pool.query(
    `WITH updated AS (
       UPDATE user_credits
       SET balance_usd_micros = balance_usd_micros - $2,
           updated_at = now()
       WHERE email = $1 AND balance_usd_micros >= $2
       RETURNING balance_usd_micros
     ),
     new_ledger AS (
       INSERT INTO credit_ledger (email, delta_usd_micros, source, external_ref, description)
       SELECT $1, -$2, 'envelope', $3, $4
       FROM updated
       RETURNING id
     )
     SELECT balance_usd_micros FROM updated`,
    [
      email,
      opts.amountUsdMicros.toString(),
      opts.envelopeId,
      `kysigned envelope ${opts.envelopeId}`,
    ],
  );

  if (result.rows.length === 0) {
    // UPDATE matched no rows → either email has no user_credits row at all,
    // or balance < amount. Re-read the current balance for the caller's error
    // payload.
    const current = await getCreditBalance(pool, email);
    return {
      ok: false,
      balanceUsdMicros: current,
      deduplicated: false,
      error: 'INSUFFICIENT_BALANCE',
    };
  }

  return {
    ok: true,
    balanceUsdMicros: toBigInt((result.rows[0] as { balance_usd_micros: string | number | bigint }).balance_usd_micros),
    deduplicated: false,
  };
}

export async function getRecentLedgerEntries(
  pool: DbPool,
  email: string,
  limit: number,
): Promise<LedgerEntry[]> {
  const normalized = normalizeEmail(email);
  const result = await pool.query(
    `SELECT id, delta_usd_micros, source, external_ref, description, created_at
     FROM credit_ledger WHERE email = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [normalized, limit],
  );
  return (result.rows as Array<{
    id: string;
    delta_usd_micros: string | number | bigint;
    source: CreditLedgerSource;
    external_ref: string;
    description: string | null;
    created_at: string | Date;
  }>).map((r) => ({
    id: r.id,
    deltaUsdMicros: toBigInt(r.delta_usd_micros),
    source: r.source,
    externalRef: r.external_ref,
    description: r.description,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
  }));
}
