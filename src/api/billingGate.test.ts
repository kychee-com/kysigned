/**
 * billingGate tests — F-13 `[service]` credit-gate activation (AC-5/AC-33/AC-49).
 *
 * `resolveSenderGate('hosted')` wires the createGate/envelope.ts credit seam to
 * the kysigned-local ledger (userCredits) so creation enforces the 402 (AC-5),
 * debits one flat credit on success (AC-33), and refunds a voided-unsigned
 * envelope (AC-49). Any other mode leaves the seam unwired — a forker gates by
 * the F-3.6 allowlist instead (no service-to-user payment).
 *
 * The in-memory pool mirrors the proven pattern in userCredits.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSenderGate,
  buildHostedSenderGate,
  HOSTED_BILLING_MODE,
} from './billingGate.js';
import type { DbPool } from '../db/pool.js';

function createInMemoryPool(): DbPool & {
  _credits: Map<string, bigint>;
  _ledger: Array<{ source: string; external_ref: string }>;
} {
  const credits = new Map<string, bigint>();
  const ledger: Array<{ source: string; external_ref: string }> = [];

  return {
    _credits: credits,
    _ledger: ledger,
    async query(text: string, values?: unknown[]) {
      const v = values ?? [];
      const t = text.trim();

      if (/SELECT balance_usd_micros FROM user_credits WHERE email = \$1/.test(t)) {
        const email = v[0] as string;
        const bal = credits.get(email);
        return {
          rows: bal !== undefined ? [{ balance_usd_micros: bal.toString() }] : [],
          rowCount: bal !== undefined ? 1 : 0,
        } as never;
      }

      if (/SELECT id FROM credit_ledger WHERE source = \$1 AND external_ref = \$2/.test(t)) {
        const [source, externalRef] = v as [string, string];
        const hit = ledger.find((r) => r.source === source && r.external_ref === externalRef);
        return { rows: hit ? [{ id: 'led' }] : [], rowCount: hit ? 1 : 0 } as never;
      }

      // creditUser CTE (credit/refund): ledger insert + balance upsert.
      if (/WITH new_ledger AS[\s\S]*INSERT INTO credit_ledger[\s\S]*INSERT INTO user_credits[\s\S]*ON CONFLICT/.test(t)) {
        const [email, delta, source, externalRef] = v as [string, string, string, string];
        const deltaBig = BigInt(delta);
        ledger.push({ source, external_ref: externalRef });
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
        ledger.push({ source: 'envelope', external_ref: externalRef });
        return { rows: [{ balance_usd_micros: next.toString() }], rowCount: 1 } as never;
      }

      throw new Error(`Unexpected query: ${t}`);
    },
    async end() {},
  };
}

describe('billingGate.resolveSenderGate — mode gating', () => {
  const pool = createInMemoryPool();

  it('returns undefined when billing mode is unset (forker → allowlist)', () => {
    assert.equal(resolveSenderGate(undefined, pool, 250_000), undefined);
  });

  it('returns undefined for the allowlist / self-host modes', () => {
    assert.equal(resolveSenderGate('allowlist', pool, 250_000), undefined);
    assert.equal(resolveSenderGate('', pool, 250_000), undefined);
    assert.equal(resolveSenderGate('none', pool, 250_000), undefined);
  });

  it('returns a wired gate for hosted mode (case- and whitespace-insensitive)', () => {
    assert.ok(resolveSenderGate('hosted', pool, 250_000));
    assert.ok(resolveSenderGate('HOSTED', pool, 250_000));
    assert.ok(resolveSenderGate('  Hosted ', pool, 250_000));
  });

  it('passes the per-envelope cost through to the gate', () => {
    const gate = resolveSenderGate(HOSTED_BILLING_MODE, pool, 250_000)!;
    assert.equal(gate.costUsdMicros, 250_000);
  });
});

describe('billingGate hosted gate — credit operations', () => {
  it('getCreditBalance reads the local ledger balance as a number', async () => {
    const pool = createInMemoryPool();
    pool._credits.set('alice@example.com', 1_000_000n);
    const gate = buildHostedSenderGate(pool, 250_000);
    assert.equal(await gate.getCreditBalance!('alice@example.com'), 1_000_000);
  });

  it('getCreditBalance returns 0 for an unknown creator (drives the 402 in createGate)', async () => {
    const pool = createInMemoryPool();
    const gate = buildHostedSenderGate(pool, 250_000);
    assert.equal(await gate.getCreditBalance!('nobody@example.com'), 0);
  });

  it('deductCredit debits one flat credit on sufficient balance (AC-33)', async () => {
    const pool = createInMemoryPool();
    pool._credits.set('alice@example.com', 1_000_000n);
    const gate = buildHostedSenderGate(pool, 250_000);
    const r = await gate.deductCredit!('alice@example.com', 250_000, 'env-1');
    assert.deepEqual(r, { ok: true });
    assert.equal(pool._credits.get('alice@example.com'), 750_000n);
  });

  it('deductCredit returns ok:false on insufficient balance', async () => {
    const pool = createInMemoryPool();
    pool._credits.set('bob@example.com', 100_000n);
    const gate = buildHostedSenderGate(pool, 250_000);
    const r = await gate.deductCredit!('bob@example.com', 250_000, 'env-2');
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  it('refundCredit credits the envelope cost back (AC-49)', async () => {
    const pool = createInMemoryPool();
    pool._credits.set('alice@example.com', 750_000n);
    const gate = buildHostedSenderGate(pool, 250_000);
    const r = await gate.refundCredit!('alice@example.com', 250_000, 'env-1');
    assert.deepEqual(r, { ok: true });
    assert.equal(pool._credits.get('alice@example.com'), 1_000_000n);
  });

  it('debit then refund nets to zero (distinct ledger sources, no idempotency clash)', async () => {
    const pool = createInMemoryPool();
    pool._credits.set('alice@example.com', 1_000_000n);
    const gate = buildHostedSenderGate(pool, 250_000);
    await gate.deductCredit!('alice@example.com', 250_000, 'env-1');
    await gate.refundCredit!('alice@example.com', 250_000, 'env-1');
    assert.equal(pool._credits.get('alice@example.com'), 1_000_000n);
  });
});
