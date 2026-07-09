/**
 * x402Create tests — F-30.2 (spec 0.39.0, AC-134/AC-141): the dedicated
 * always-priced create route's orchestration.
 *
 * The gateway settles the payment BEFORE the function runs and forwards the
 * confirmed context (platform-owned `x-run402-payment-*` headers, stripped
 * from clients at the gateway — routed-invoke.ts). This module trusts the
 * PARSED context handed to it by the dispatch, cross-checks it against the
 * operator config (amount, optional payTo), credits the ledger exactly-once
 * keyed on the stable payment id, and runs the standard create with the
 * payment id as the create idempotency key — one credit, one debit, one
 * envelope, no matter how often the same settled proof is retried.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RoutedHttpPaymentContextV1 } from '@run402/functions';
import { handleX402CreateEnvelope, defaultX402Seams, type X402CreateSeams } from './x402Create.js';
import type { DbPool } from '../db/pool.js';

const PAYMENT: RoutedHttpPaymentContextV1 = {
  scheme: 'x402',
  paymentId: 'pay_abc123',
  amountUsdMicros: 250_000,
  payer: '0x1111111111111111111111111111111111111111',
  network: 'base',
  asset: '0x2222222222222222222222222222222222222222',
  payTo: '0x8d671cd12ecf69e0b049a6b55c5b318097b4bc35',
  transaction: '0xtx',
  settledAt: '2026-07-08T10:00:00.000Z',
};

const CONFIG = { priceUsdMicros: 250_000 };

const BODY = {
  creator_email: 'Agent@Example.com',
  pdf_base64: 'JVBERi0=',
  document_name: 'Paid doc',
  signers: [{ email: 'signer@example.com' }],
};

function recordingSeams(over: Partial<X402CreateSeams> = {}) {
  const credited: Array<{ email: string; paymentId: string }> = [];
  const created: Array<{ email: string; key: string; body: Record<string, unknown> }> = [];
  const seams: X402CreateSeams = {
    creditPayment: async (email, payment) => {
      credited.push({ email, paymentId: payment.paymentId });
    },
    runCreate: async (email, key, body) => {
      created.push({ email, key, body });
      return { status: 201, body: { id: 'env-1' } };
    },
    ...over,
  };
  return { credited, created, seams };
}

describe('handleX402CreateEnvelope — guards (F-30.2)', () => {
  it('NO payment context (config on, gateway did not settle) → 503 payment_x402_unavailable, nothing runs', async () => {
    const { credited, created, seams } = recordingSeams();
    const r = await handleX402CreateEnvelope(CONFIG, null, seams, { ...BODY });
    assert.equal(r.status, 503);
    assert.equal((r.body as { code: string }).code, 'payment_x402_unavailable');
    assert.equal(credited.length, 0);
    assert.equal(created.length, 0);
  });

  it('settled amount ≠ configured price → 409 payment_x402_mismatch, nothing runs (fail-closed on misconfig)', async () => {
    const { credited, created, seams } = recordingSeams();
    const r = await handleX402CreateEnvelope(
      CONFIG,
      { ...PAYMENT, amountUsdMicros: 100_000 },
      seams,
      { ...BODY },
    );
    assert.equal(r.status, 409);
    assert.equal((r.body as { code: string }).code, 'payment_x402_mismatch');
    assert.equal(credited.length + created.length, 0);
  });

  it('configured expectedPayTo ≠ settled payTo → 409 payment_x402_mismatch', async () => {
    const { seams } = recordingSeams();
    const r = await handleX402CreateEnvelope(
      { ...CONFIG, expectedPayTo: '0x9999999999999999999999999999999999999999' },
      PAYMENT,
      seams,
      { ...BODY },
    );
    assert.equal(r.status, 409);
    assert.equal((r.body as { code: string }).code, 'payment_x402_mismatch');
  });

  it('expectedPayTo matches case-insensitively (checksummed config vs lowercased context)', async () => {
    const { seams } = recordingSeams();
    const r = await handleX402CreateEnvelope(
      { ...CONFIG, expectedPayTo: '0x8D671Cd12ecf69e0B049a6B55c5b318097b4bc35' },
      PAYMENT,
      seams,
      { ...BODY },
    );
    assert.equal(r.status, 201);
  });

  it('missing creator_email → 400 validation_creator_email, no credit', async () => {
    const { credited, seams } = recordingSeams();
    const { creator_email: _drop, ...noEmail } = BODY;
    const r = await handleX402CreateEnvelope(CONFIG, PAYMENT, seams, noEmail);
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, 'validation_creator_email');
    assert.equal(credited.length, 0);
  });

  it('malformed creator_email → 400 validation_creator_email', async () => {
    const { seams } = recordingSeams();
    for (const bad of ['nope', 'a@b', 'has space@x.com', 42]) {
      const r = await handleX402CreateEnvelope(CONFIG, PAYMENT, seams, { ...BODY, creator_email: bad });
      assert.equal(r.status, 400, `creator_email=${String(bad)}`);
      assert.equal((r.body as { code: string }).code, 'validation_creator_email');
    }
  });
});

describe('handleX402CreateEnvelope — orchestration (F-30.2 / AC-134 / AC-141)', () => {
  it('happy path: credits FIRST (normalized email + payment id), then creates with the x402:<paymentId> key and a creator_email-free body', async () => {
    const { credited, created, seams } = recordingSeams();
    const r = await handleX402CreateEnvelope(CONFIG, PAYMENT, seams, { ...BODY });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { id: 'env-1' });

    // Zero-onboarding: the creator record identity is the normalized supplied
    // email — that is what a later dashboard sign-in (AC-141) resolves to.
    assert.deepEqual(credited, [{ email: 'agent@example.com', paymentId: 'pay_abc123' }]);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.email, 'agent@example.com');
    assert.equal(created[0]!.key, 'x402:pay_abc123');
    // The standard create never sees the x402-only field.
    assert.equal('creator_email' in created[0]!.body, false);
    assert.equal(created[0]!.body.document_name, 'Paid doc');
  });

  it('honors a caller-supplied idempotency key as the create key (agent retry control), else falls back to payment_id', async () => {
    // #128 — run402 paid-function idempotency: an agent can send Idempotency-Key
    // so its retry framework dedupes the create by its own spending-intent key,
    // not only by the settled payment_id. The ledger credit stays payment_id-keyed.
    const withKey = recordingSeams();
    await handleX402CreateEnvelope(CONFIG, PAYMENT, withKey.seams, { ...BODY }, 'agent-intent-42');
    assert.equal(withKey.created[0]!.key, 'x402:idem:agent-intent-42');
    // money dedupe is still per settled payment
    assert.deepEqual(withKey.credited, [{ email: 'agent@example.com', paymentId: 'pay_abc123' }]);

    const noKey = recordingSeams();
    await handleX402CreateEnvelope(CONFIG, PAYMENT, noKey.seams, { ...BODY });
    assert.equal(noKey.created[0]!.key, 'x402:pay_abc123');

    // blank / whitespace key is ignored (falls back to payment_id)
    const blank = recordingSeams();
    await handleX402CreateEnvelope(CONFIG, PAYMENT, blank.seams, { ...BODY }, '   ');
    assert.equal(blank.created[0]!.key, 'x402:pay_abc123');
  });

  it('credit failure → 500 internal_x402_credit and the create NEVER runs', async () => {
    const { created, seams } = recordingSeams({
      creditPayment: async () => {
        throw new Error('ledger down');
      },
    });
    const r = await handleX402CreateEnvelope(CONFIG, PAYMENT, seams, { ...BODY });
    assert.equal(r.status, 500);
    assert.equal((r.body as { code: string }).code, 'internal_x402_credit');
    assert.equal(created.length, 0);
  });

  it('a non-201 from the inner create passes through verbatim — the credit stays on the ledger for the corrected retry', async () => {
    const { credited, seams } = recordingSeams({
      runCreate: async () => ({ status: 400, body: { error: 'bad pdf', code: 'validation_pdf' } }),
    });
    const r = await handleX402CreateEnvelope(CONFIG, PAYMENT, seams, { ...BODY });
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, 'validation_pdf');
    // Money is preserved: the payment was settled on-chain, so the credit row
    // stays; a corrected retry with the SAME proof dedups the credit and the
    // gate then sees the balance.
    assert.equal(credited.length, 1);
  });
});

// ── defaultX402Seams — the real wiring over creditUser + withCreateIdempotency ──

/** Emulates ONLY the SQL the default seams touch, in prod wire shape. */
function makeSeamPool() {
  const ledger: Array<{ source: string; external_ref: string; email: string; delta: string }> = [];
  const idem = new Map<string, { request_hash: string; response_status: number | null; response_body: string | null }>();
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as string[];
      if (text.includes('INSERT INTO credit_ledger') && text.includes('upserted')) {
        // creditUser CTE — dedup on (source, external_ref).
        const dup = ledger.some((l) => l.source === v[2] && l.external_ref === v[3]);
        if (dup) return { rows: [], rowCount: 0 } as never;
        ledger.push({ email: v[0]!, delta: v[1]!, source: v[2]!, external_ref: v[3]! });
        return { rows: [{ balance_usd_micros: v[1] }], rowCount: 1 } as never;
      }
      if (text.includes('SELECT balance_usd_micros FROM user_credits')) {
        const total = ledger
          .filter((l) => l.email === v[0])
          .reduce((sum, l) => sum + BigInt(l.delta), 0n);
        return { rows: [{ balance_usd_micros: total.toString() }], rowCount: 1 } as never;
      }
      if (text.includes('INSERT INTO idempotency_keys')) {
        const key = `${v[0]} ${v[1]}`;
        if (idem.has(key)) return { rows: [], rowCount: 0 } as never;
        idem.set(key, { request_hash: v[2]!, response_status: null, response_body: null });
        return { rows: [{ creator_email: v[0] }], rowCount: 1 } as never;
      }
      if (text.includes('SELECT request_hash, response_status, response_body')) {
        const row = idem.get(`${v[0]} ${v[1]}`);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } as never;
      }
      if (text.includes('UPDATE idempotency_keys')) {
        const row = idem.get(`${v[2]} ${v[3]}`);
        if (row) {
          row.response_status = Number(v[0]);
          row.response_body = v[1]!; // stored serialized — replay sees the prod string shape
        }
        return { rows: [], rowCount: row ? 1 : 0 } as never;
      }
      if (text.includes('DELETE FROM idempotency_keys')) {
        idem.delete(`${v[0]} ${v[1]}`);
        return { rows: [], rowCount: 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
    async end() {},
  };
  return { pool, ledger };
}

describe('defaultX402Seams — real creditUser + withCreateIdempotency composition', () => {
  it('creditPayment writes the x402 ledger row once and dedups the same payment id (exactly-once, AC-134)', async () => {
    const { pool, ledger } = makeSeamPool();
    const seams = defaultX402Seams(pool, CONFIG, () => ({}) as never, async () => ({ status: 201, body: { id: 'e' } }));
    await seams.creditPayment('agent@example.com', PAYMENT);
    await seams.creditPayment('agent@example.com', PAYMENT);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.source, 'x402');
    assert.equal(ledger[0]!.external_ref, 'pay_abc123');
    assert.equal(ledger[0]!.delta, '250000');
  });

  it('runCreate replays the stored 201 for the same key + payload (create runs ONCE) and 409s a different payload', async () => {
    const { pool } = makeSeamPool();
    let runs = 0;
    const ctxSeen: string[] = [];
    const seams = defaultX402Seams(
      pool,
      CONFIG,
      (email) => {
        ctxSeen.push(email);
        return {} as never;
      },
      async () => {
        runs += 1;
        return { status: 201, body: { id: `env-${runs}` } };
      },
    );
    const first = await seams.runCreate('agent@example.com', 'x402:pay_abc123', { a: 1 });
    const replay = await seams.runCreate('agent@example.com', 'x402:pay_abc123', { a: 1 });
    assert.equal(first.status, 201);
    assert.deepEqual(replay, first, 'same proof + same body replays the SAME envelope');
    assert.equal(runs, 1, 'the real create ran exactly once');
    assert.deepEqual(ctxSeen, ['agent@example.com'], 'ctx built for the creator on the single real run');

    const conflict = await seams.runCreate('agent@example.com', 'x402:pay_abc123', { a: 2 });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as { code: string }).code, 'idempotency_key_reuse');
  });
});
