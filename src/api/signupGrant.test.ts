/**
 * signupGrant tests — new-account trial credit (F-13.4 / F-13.6 / F-13.7, Phase 25).
 *
 * The grant credits a new account a fixed amount of envelope credits ($1.00 = 4
 * envelopes on kysigned.com) at its first magic-link-confirmed sign-in. It rides
 * the existing credit_ledger idempotency UNIQUE(source, external_ref): with
 * source='signup_grant' and external_ref the NORMALIZED inbox (F-3.2a), the
 * constraint enforces BOTH at-most-one grant per normalized address (AC-94) and
 * once-only across repeat sign-ins (AC-93). Granted credits are ordinary credits
 * — fungible, debitable, never-expiring (AC-96).
 *
 * In-memory pool models credit_ledger UNIQUE(source, external_ref) + the
 * user_credits balance (same pattern as userCredits.test.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { grantSignupCreditIfEligible } from './signupGrant.js';
import { getCreditBalance, debitUser } from '../db/userCredits.js';
import type { DbPool } from '../db/pool.js';

function createInMemoryPool(): DbPool & {
  _credits: Map<string, bigint>;
  _ledger: Array<{ email: string; delta: bigint; source: string; external_ref: string }>;
} {
  const credits = new Map<string, bigint>();
  const ledger: Array<{ email: string; delta: bigint; source: string; external_ref: string }> = [];
  return {
    _credits: credits,
    _ledger: ledger,
    async query(text: string, values?: unknown[]) {
      const v = values ?? [];
      const t = text.trim();

      if (/SELECT balance_usd_micros FROM user_credits WHERE email = \$1/.test(t)) {
        const bal = credits.get(v[0] as string);
        return { rows: bal !== undefined ? [{ balance_usd_micros: bal.toString() }] : [], rowCount: bal !== undefined ? 1 : 0 } as never;
      }

      if (/SELECT id FROM credit_ledger WHERE source = \$1 AND external_ref = \$2/.test(t)) {
        const [source, externalRef] = v as [string, string];
        const hit = ledger.find((r) => r.source === source && r.external_ref === externalRef);
        return { rows: hit ? [{ id: 'x' }] : [], rowCount: hit ? 1 : 0 } as never;
      }

      // creditUser CTE: ledger insert (ON CONFLICT (source, external_ref) DO NOTHING) + balance upsert.
      if (/WITH new_ledger AS[\s\S]*INSERT INTO credit_ledger[\s\S]*ON CONFLICT \(source, external_ref\) DO NOTHING[\s\S]*INSERT INTO user_credits[\s\S]*ON CONFLICT \(email\)/.test(t)) {
        const [email, delta, source, externalRef] = v as [string, string, string, string];
        if (ledger.some((r) => r.source === source && r.external_ref === externalRef)) {
          return { rows: [], rowCount: 0 } as never; // UNIQUE conflict → no-op (deduplicated)
        }
        const deltaBig = BigInt(delta);
        ledger.push({ email, delta: deltaBig, source, external_ref: externalRef });
        const next = (credits.get(email) ?? 0n) + deltaBig;
        if (next < 0n) throw new Error('user_credits_balance_nonneg violation');
        credits.set(email, next);
        return { rows: [{ balance_usd_micros: next.toString() }], rowCount: 1 } as never;
      }

      // debitUser CTE: conditional UPDATE then ledger insert.
      if (/WITH updated AS[\s\S]*UPDATE user_credits[\s\S]*INSERT INTO credit_ledger/.test(t)) {
        const [email, amount, externalRef] = v as [string, string, string];
        const amountBig = BigInt(amount);
        const cur = credits.get(email) ?? 0n;
        if (cur < amountBig) return { rows: [], rowCount: 0 } as never;
        const next = cur - amountBig;
        credits.set(email, next);
        ledger.push({ email, delta: -amountBig, source: 'envelope', external_ref: externalRef });
        return { rows: [{ balance_usd_micros: next.toString() }], rowCount: 1 } as never;
      }

      throw new Error(`Unexpected query: ${t}`);
    },
    async end() {},
  };
}

const GRANT = { grantUsdMicros: 1_000_000n }; // 4 credits × $0.25 = $1.00

describe('grantSignupCreditIfEligible — disabled', () => {
  it('grants nothing when the configured amount is 0 (forker default)', async () => {
    const pool = createInMemoryPool();
    const r = await grantSignupCreditIfEligible(pool, 'new@example.com', { grantUsdMicros: 0n });
    assert.equal(r.granted, false);
    assert.equal(r.reason, 'disabled');
    assert.equal(pool._ledger.length, 0);
    assert.equal(await getCreditBalance(pool, 'new@example.com'), 0n);
  });
});

describe('grantSignupCreditIfEligible — first confirmed sign-in (AC-93)', () => {
  it('grants the configured amount exactly once and writes a signup_grant ledger entry', async () => {
    const pool = createInMemoryPool();
    const r = await grantSignupCreditIfEligible(pool, 'new@example.com', GRANT);
    assert.equal(r.granted, true);
    assert.equal(r.reason, 'granted');
    assert.equal(r.balanceUsdMicros, 1_000_000n);
    assert.equal(await getCreditBalance(pool, 'new@example.com'), 1_000_000n);
    assert.equal(pool._ledger.length, 1);
    assert.equal(pool._ledger[0]!.source, 'signup_grant');
  });

  it('is idempotent across repeat sign-ins — a second call grants nothing more (AC-93 once)', async () => {
    const pool = createInMemoryPool();
    const first = await grantSignupCreditIfEligible(pool, 'new@example.com', GRANT);
    const second = await grantSignupCreditIfEligible(pool, 'new@example.com', GRANT);
    assert.equal(first.granted, true);
    assert.equal(second.granted, false);
    assert.equal(second.reason, 'already_granted');
    assert.equal(await getCreditBalance(pool, 'new@example.com'), 1_000_000n, 'balance must not double');
    assert.equal(pool._ledger.length, 1, 'only one signup_grant ledger row');
  });
});

describe('grantSignupCreditIfEligible — per-normalized-email dedupe (AC-94)', () => {
  it('refuses a second grant whose email normalizes to an already-granted address (gmail dot / +tag / googlemail)', async () => {
    const pool = createInMemoryPool();
    await grantSignupCreditIfEligible(pool, 'user@gmail.com', GRANT);
    // Each resolves to user@gmail.com under normalizeInbox → no second grant.
    // (These three also have a DISTINCT normalizeEmail balance row, so it stays 0;
    // a pure case variant would share the original row and is asserted separately.)
    for (const variant of ['u.s.e.r@gmail.com', 'user+promo@gmail.com', 'USER@googlemail.com']) {
      const r = await grantSignupCreditIfEligible(pool, variant, GRANT);
      assert.equal(r.granted, false, `${variant} should not re-grant`);
      assert.equal(r.reason, 'already_granted');
      assert.equal(await getCreditBalance(pool, variant.trim().toLowerCase()), 0n, `${variant} balance stays 0`);
    }
    // A pure case variant collides too (granted:false); it shares the original's balance row.
    const caseVariant = await grantSignupCreditIfEligible(pool, 'User@Gmail.com', GRANT);
    assert.equal(caseVariant.granted, false, 'case variant should not re-grant');
    assert.equal(pool._ledger.length, 1, 'still exactly one signup_grant ledger row');
    assert.equal(pool._ledger[0]!.external_ref, 'user@gmail.com', 'dedupe key is the normalized inbox');
  });

  it('grants a genuinely distinct primary address', async () => {
    const pool = createInMemoryPool();
    await grantSignupCreditIfEligible(pool, 'alice@example.com', GRANT);
    const r = await grantSignupCreditIfEligible(pool, 'bob@example.com', GRANT);
    assert.equal(r.granted, true);
    assert.equal(pool._ledger.length, 2);
  });

  // F-006 regression (system-test Fix Cycle 1). Every OTHER dedupe test above uses a
  // gmail address, where gmail's dot-strip + googlemail-unify could mask a broken
  // pure-lowercase step. For a NON-gmail domain, dedupe relies SOLELY on the
  // lowercase normalization in normalizeInbox — so a pure case variant of a
  // non-gmail inbox must still collide on UNIQUE(source, external_ref) and grant
  // nothing. (The prod double-grant was investigated as deploy/DB drift, NOT a
  // normalizer bug — the constraint is applied in prod and refs are normalized;
  // this test locks in the non-gmail case-fold behavior the normalizer must keep.)
  it('a pure CASE variant of a NON-gmail address does not re-grant (AC-94)', async () => {
    const pool = createInMemoryPool();
    const first = await grantSignupCreditIfEligible(pool, 'redteam-normcheck@example.com', GRANT);
    const second = await grantSignupCreditIfEligible(pool, 'redteam-NormCheck@Example.com', GRANT);
    assert.equal(first.granted, true);
    assert.equal(second.granted, false, 'case-variant of a non-gmail inbox must dedupe');
    assert.equal(second.reason, 'already_granted');
    assert.equal(pool._ledger.length, 1, 'exactly one signup_grant ledger row for the inbox');
    assert.equal(
      pool._ledger[0]!.external_ref,
      'redteam-normcheck@example.com',
      'dedup key is the lowercased inbox (no gmail dot-strip involved)',
    );
    assert.equal(await getCreditBalance(pool, 'redteam-normcheck@example.com'), 1_000_000n, 'balance not doubled');
  });
});

describe('grantSignupCreditIfEligible — fungible + never-expiring (AC-96)', () => {
  it('a granted credit spends on an envelope exactly like a purchased credit', async () => {
    const pool = createInMemoryPool();
    await grantSignupCreditIfEligible(pool, 'new@example.com', GRANT); // balance 1_000_000 (4 credits)
    const debit = await debitUser(pool, { email: 'new@example.com', amountUsdMicros: 250_000n, envelopeId: 'env_1' });
    assert.equal(debit.ok, true);
    assert.equal(debit.balanceUsdMicros, 750_000n, 'one $0.25 envelope debits the granted balance to 3 credits');
  });
});

describe('grantSignupCreditIfEligible — disposable-domain exclusion (AC-95)', () => {
  it('grants nothing to a disposable / throwaway email domain (no credit write)', async () => {
    const pool = createInMemoryPool();
    for (const email of ['nope@mailinator.com', 'throwaway@10minutemail.com']) {
      const r = await grantSignupCreditIfEligible(pool, email, GRANT);
      assert.equal(r.granted, false, `${email} should not be granted`);
      assert.equal(r.reason, 'disposable_domain');
    }
    assert.equal(pool._ledger.length, 0, 'no signup_grant written for disposable domains');
  });

  it('still grants a normal (non-disposable) domain', async () => {
    const pool = createInMemoryPool();
    const r = await grantSignupCreditIfEligible(pool, 'real@example.com', GRANT);
    assert.equal(r.granted, true);
    assert.equal(pool._ledger.length, 1);
  });
});
