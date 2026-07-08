/**
 * userCredits tests — Phase 2F.X15 full F9.8 (DD-28).
 *
 * The credit ledger has two invariants tested here:
 *   1. user_credits.balance_usd_micros = SUM(credit_ledger.delta_usd_micros) for
 *      the same email. Recompute always matches the materialized balance.
 *   2. (source, external_ref) is unique → Stripe webhook retries can't double-credit.
 *
 * Tests use an in-memory mock pool matching the pattern from envelopes.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCreditBalance,
  creditUser,
  debitUser,
  getRecentLedgerEntries,
} from './userCredits.js';
import type { DbPool } from './pool.js';

function createInMemoryPool(): DbPool & {
  _credits: Map<string, bigint>;
  _ledger: Array<{
    id: string;
    email: string;
    delta_usd_micros: bigint;
    source: string;
    external_ref: string;
    description: string | null;
    created_at: Date;
  }>;
} {
  const credits = new Map<string, bigint>();
  const ledger: Array<{
    id: string;
    email: string;
    delta_usd_micros: bigint;
    source: string;
    external_ref: string;
    description: string | null;
    created_at: Date;
  }> = [];

  return {
    _credits: credits,
    _ledger: ledger,
    async query(text: string, values?: unknown[]) {
      const v = values ?? [];
      const t = text.trim();

      // SELECT balance
      if (/SELECT balance_usd_micros FROM user_credits WHERE email = \$1/.test(t)) {
        const email = v[0] as string;
        const bal = credits.get(email);
        return { rows: bal !== undefined ? [{ balance_usd_micros: bal.toString() }] : [], rowCount: bal !== undefined ? 1 : 0 } as any;
      }

      // Idempotency check: SELECT FROM credit_ledger WHERE (source, external_ref) = ($1,$2)
      if (/SELECT id FROM credit_ledger WHERE source = \$1 AND external_ref = \$2/.test(t)) {
        const [source, externalRef] = v as [string, string];
        const hit = ledger.find(r => r.source === source && r.external_ref === externalRef);
        return { rows: hit ? [{ id: hit.id }] : [], rowCount: hit ? 1 : 0 } as any;
      }

      // creditUser CTE: ledger insert (ON CONFLICT (source, external_ref) DO
      // NOTHING) + balance upsert, in one atomic statement (#71). A duplicate
      // ledger insert writes 0 rows → the upsert's SELECT FROM new_ledger is
      // empty → no balance change → 0 rows returned (the caller reads that as
      // deduplicated). This models the UNIQUE(source, external_ref) constraint.
      if (/WITH new_ledger AS[\s\S]*INSERT INTO credit_ledger[\s\S]*ON CONFLICT \(source, external_ref\) DO NOTHING[\s\S]*INSERT INTO user_credits[\s\S]*ON CONFLICT \(email\)/.test(t)) {
        const [email, delta, source, externalRef, description] = v as [string, string, string, string, string | null];
        if (ledger.some((r) => r.source === source && r.external_ref === externalRef)) {
          return { rows: [], rowCount: 0 } as any; // ON CONFLICT DO NOTHING → no-op
        }
        const deltaBig = BigInt(delta);
        const newId = `led_${ledger.length + 1}`;
        ledger.push({
          id: newId,
          email,
          delta_usd_micros: deltaBig,
          source,
          external_ref: externalRef,
          description,
          created_at: new Date(),
        });
        const cur = credits.get(email) ?? 0n;
        const next = cur + deltaBig;
        if (next < 0n) throw new Error('user_credits_balance_nonneg violation');
        credits.set(email, next);
        return { rows: [{ balance_usd_micros: next.toString() }], rowCount: 1 } as any;
      }

      // debitUser CTE: conditional UPDATE then ledger insert
      if (/WITH updated AS[\s\S]*UPDATE user_credits[\s\S]*INSERT INTO credit_ledger/.test(t)) {
        const [email, amount, externalRef, description] = v as [string, string, string, string];
        const amountBig = BigInt(amount);
        const cur = credits.get(email) ?? 0n;
        if (cur < amountBig) {
          // UPDATE matches no rows because of WHERE balance >= amount
          return { rows: [], rowCount: 0 } as any;
        }
        const next = cur - amountBig;
        credits.set(email, next);
        const newId = `led_${ledger.length + 1}`;
        ledger.push({
          id: newId,
          email,
          delta_usd_micros: -amountBig,
          source: 'envelope',
          external_ref: externalRef,
          description,
          created_at: new Date(),
        });
        return { rows: [{ balance_usd_micros: next.toString() }], rowCount: 1 } as any;
      }

      // SELECT recent ledger entries (multiline query — use the [\s\S]* trick instead of .* to match newlines)
      if (/SELECT[\s\S]*FROM credit_ledger WHERE email = \$1/.test(t)) {
        const [email, limit] = v as [string, number];
        const rows = ledger
          .filter(r => r.email === email)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
          .slice(0, limit)
          .map(r => ({
            id: r.id,
            delta_usd_micros: r.delta_usd_micros.toString(),
            source: r.source,
            external_ref: r.external_ref,
            description: r.description,
            created_at: r.created_at,
          }));
        return { rows, rowCount: rows.length } as any;
      }

      throw new Error(`Unexpected query: ${t}`);
    },
    async end() {},
  };
}

describe('userCredits.getCreditBalance', () => {
  it('returns 0 for an unknown email', async () => {
    const pool = createInMemoryPool();
    const balance = await getCreditBalance(pool, 'unknown@example.com');
    assert.equal(balance, 0n);
  });

  it('returns the stored balance for a known email', async () => {
    const pool = createInMemoryPool();
    pool._credits.set('alice@example.com', 5_000_000n);
    const balance = await getCreditBalance(pool, 'alice@example.com');
    assert.equal(balance, 5_000_000n);
  });

  it('normalizes email case before lookup', async () => {
    const pool = createInMemoryPool();
    pool._credits.set('alice@example.com', 1_500_000n);
    const balance = await getCreditBalance(pool, 'Alice@Example.COM');
    assert.equal(balance, 1_500_000n);
  });
});

describe('userCredits.creditUser', () => {
  it('credits a new user and creates a ledger entry', async () => {
    const pool = createInMemoryPool();
    const result = await creditUser(pool, {
      email: 'alice@example.com',
      amountUsdMicros: 10_000_000n,
      source: 'stripe',
      externalRef: 'cs_test_abc123',
      description: '$10 credit pack',
    });

    assert.equal(result.ok, true);
    assert.equal(result.balanceUsdMicros, 10_000_000n);
    assert.equal(result.deduplicated, false);
    assert.equal(pool._ledger.length, 1);
    assert.equal(pool._ledger[0]!.source, 'stripe');
    assert.equal(pool._ledger[0]!.external_ref, 'cs_test_abc123');
    assert.equal(pool._ledger[0]!.delta_usd_micros, 10_000_000n);
  });

  it('is idempotent — second call with same (source, externalRef) does NOT double-credit', async () => {
    const pool = createInMemoryPool();
    const first = await creditUser(pool, {
      email: 'alice@example.com',
      amountUsdMicros: 10_000_000n,
      source: 'stripe',
      externalRef: 'cs_test_abc123',
      description: 'first',
    });
    const second = await creditUser(pool, {
      email: 'alice@example.com',
      amountUsdMicros: 10_000_000n,
      source: 'stripe',
      externalRef: 'cs_test_abc123',
      description: 'duplicate',
    });

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.balanceUsdMicros, 10_000_000n, 'balance should NOT double');
    assert.equal(pool._ledger.length, 1, 'ledger should only have one entry');
  });

  it('dedups atomically via ON CONFLICT — no check-then-insert pre-SELECT (race-safe) (#71)', async () => {
    const pool = createInMemoryPool();
    // creditUser must NOT pre-check with a separate SELECT (that SELECT-then-
    // INSERT is the race two concurrent Stripe deliveries hit). Make the pre-
    // check explode so the test fails if creditUser still relies on it.
    const origQuery = pool.query.bind(pool);
    (pool as { query: DbPool['query'] }).query = async (text: string, values?: unknown[]) => {
      if (/SELECT id FROM credit_ledger WHERE source = \$1 AND external_ref = \$2/.test(text.trim())) {
        throw new Error('creditUser must not pre-check via SELECT — dedup must be atomic (#71)');
      }
      return origQuery(text, values);
    };
    const first = await creditUser(pool, {
      email: 'race@example.com', amountUsdMicros: 10_000_000n, source: 'stripe', externalRef: 'cs_race', description: 'first',
    });
    const second = await creditUser(pool, {
      email: 'race@example.com', amountUsdMicros: 10_000_000n, source: 'stripe', externalRef: 'cs_race', description: 'duplicate delivery',
    });
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true, 'a duplicate delivery is a clean noop, not a throw');
    assert.equal(second.balanceUsdMicros, 10_000_000n, 'balance must not double');
    assert.equal(pool._ledger.length, 1, 'only one ledger row for the duplicate ref');
  });

  it('accumulates multiple distinct credits', async () => {
    const pool = createInMemoryPool();
    await creditUser(pool, { email: 'alice@example.com', amountUsdMicros: 10_000_000n, source: 'stripe', externalRef: 'cs_1', description: null });
    await creditUser(pool, { email: 'alice@example.com', amountUsdMicros: 5_000_000n, source: 'stripe', externalRef: 'cs_2', description: null });
    const balance = await getCreditBalance(pool, 'alice@example.com');
    assert.equal(balance, 15_000_000n);
  });

  it('normalizes email case', async () => {
    const pool = createInMemoryPool();
    await creditUser(pool, { email: 'Alice@Example.COM', amountUsdMicros: 10_000_000n, source: 'stripe', externalRef: 'cs_x', description: null });
    const balance = await getCreditBalance(pool, 'alice@example.com');
    assert.equal(balance, 10_000_000n);
  });
});

describe('userCredits.debitUser', () => {
  it('debits when balance is sufficient', async () => {
    const pool = createInMemoryPool();
    pool._credits.set('alice@example.com', 10_000_000n);
    const result = await debitUser(pool, {
      email: 'alice@example.com',
      amountUsdMicros: 390_000n,
      envelopeId: 'env_abc',
    });
    assert.equal(result.ok, true);
    assert.equal(result.balanceUsdMicros, 9_610_000n);
  });

  it('returns ok=false when balance is insufficient (does not debit)', async () => {
    const pool = createInMemoryPool();
    pool._credits.set('alice@example.com', 100_000n);
    const result = await debitUser(pool, {
      email: 'alice@example.com',
      amountUsdMicros: 390_000n,
      envelopeId: 'env_abc',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INSUFFICIENT_BALANCE');
    assert.equal(result.balanceUsdMicros, 100_000n, 'balance unchanged');
    assert.equal(pool._ledger.length, 0, 'no ledger entry on failed debit');
  });

  it('is idempotent per (source=envelope, externalRef=envelopeId)', async () => {
    const pool = createInMemoryPool();
    pool._credits.set('alice@example.com', 10_000_000n);
    const first = await debitUser(pool, { email: 'alice@example.com', amountUsdMicros: 390_000n, envelopeId: 'env_abc' });
    const second = await debitUser(pool, { email: 'alice@example.com', amountUsdMicros: 390_000n, envelopeId: 'env_abc' });
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.balanceUsdMicros, 9_610_000n);
    assert.equal(pool._ledger.length, 1);
  });
});

describe('userCredits.getRecentLedgerEntries', () => {
  it('returns ledger entries ordered by most recent first', async () => {
    const pool = createInMemoryPool();
    await creditUser(pool, { email: 'alice@example.com', amountUsdMicros: 10_000_000n, source: 'stripe', externalRef: 'cs_1', description: 'first' });
    await new Promise(r => setTimeout(r, 5));
    await creditUser(pool, { email: 'alice@example.com', amountUsdMicros: 5_000_000n, source: 'stripe', externalRef: 'cs_2', description: 'second' });

    const recent = await getRecentLedgerEntries(pool, 'alice@example.com', 10);
    assert.equal(recent.length, 2);
    assert.equal(recent[0]!.externalRef, 'cs_2');
    assert.equal(recent[1]!.externalRef, 'cs_1');
  });
});

// ── F-13.7 / AC-135 (spec 0.39.0, 46.5) — wallet-sourced credits are fungible ──
// The x402 rail writes `source='x402'` rows; nothing downstream may treat them
// differently from Stripe/trial/admin credits. Pins: debit consumes them, the
// void refund coexists with the envelope debit, and the same payment id can
// never credit twice regardless of interleaved activity.
describe('F-13.7 — x402 wallet-sourced credits debit/refund like any credits (AC-135)', () => {
  it('credit(x402) → debit(envelope) → refund → duplicate x402 credit dedups', async () => {
    const pool = createInMemoryPool();
    const credit = await creditUser(pool, {
      email: 'agent@x.com', amountUsdMicros: 250_000n,
      source: 'x402', externalRef: 'pay_1', description: 'x402 payment pay_1',
    });
    assert.equal(credit.deduplicated, false);
    assert.equal(await getCreditBalance(pool, 'agent@x.com'), 250_000n);

    const debit = await debitUser(pool, { email: 'agent@x.com', amountUsdMicros: 250_000n, envelopeId: 'env-1' });
    assert.equal(debit.ok, true);
    assert.equal(await getCreditBalance(pool, 'agent@x.com'), 0n);

    const refund = await creditUser(pool, {
      email: 'agent@x.com', amountUsdMicros: 250_000n,
      source: 'refund', externalRef: 'env-1', description: 'Refund — voided unsigned envelope env-1',
    });
    assert.equal(refund.deduplicated, false);
    assert.equal(await getCreditBalance(pool, 'agent@x.com'), 250_000n);

    const dup = await creditUser(pool, {
      email: 'agent@x.com', amountUsdMicros: 250_000n,
      source: 'x402', externalRef: 'pay_1', description: 'retry',
    });
    assert.equal(dup.deduplicated, true, 'the same payment id can never credit twice');
    assert.equal(await getCreditBalance(pool, 'agent@x.com'), 250_000n);
  });
});
