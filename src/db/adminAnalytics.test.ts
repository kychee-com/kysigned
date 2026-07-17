/**
 * adminAnalytics.test — F-34 operator-console analytics DAOs.
 *
 * The DAOs fetch the (small) tables and do all window / band / classification
 * arithmetic in JS, so these tests seed known rows through the memory pool and
 * assert every KPI matches a direct hand-count of the same rows for the same
 * window (AC-183). Timestamps are ISO strings to match the prod HttpDbPool wire
 * shape.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getOverview, getAccounts, getEnvelopeFunnel, getSignals } from './adminAnalytics.js';
import { createAdminAnalyticsMemoryPool } from './adminAnalytics.testpool.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');
const D = 24 * 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SINCE_30D = new Date(NOW.getTime() - 30 * D); // the page window bound

describe('getOverview — F-34.2 / AC-183', () => {
  const seed = {
    userCredits: [
      { email: 'a@x.com', balance_usd_micros: 750000, created_at: ago(5 * D) }, // in 30d
      { email: 'b@x.com', balance_usd_micros: 0, created_at: ago(40 * D) }, // out of 30d
    ],
    envelopes: [
      { sender_email: 'a@x.com', status: 'completed', created_at: ago(5 * D), completed_at: ago(4 * D) },
      { sender_email: 'c@x.com', status: 'active', created_at: ago(10 * D), completed_at: null },
      { sender_email: 'w@x.com', status: 'voided', created_at: ago(2 * D), completed_at: null },
      { sender_email: 'z@x.com', status: 'completed', created_at: ago(40 * D), completed_at: ago(39 * D) }, // out of 30d
      { sender_email: 'i@x.com', status: 'active', created_at: ago(1 * D), internal_test: true }, // excluded
    ],
    creditLedger: [
      { email: 'a@x.com', source: 'signup_grant', delta_usd_micros: 1000000, created_at: ago(5 * D) },
      { email: 'a@x.com', source: 'x402', delta_usd_micros: 250000, created_at: ago(3 * D) },
      { email: 'a@x.com', source: 'envelope', delta_usd_micros: -250000, created_at: ago(3 * D) },
      { email: 'b@x.com', source: 'stripe', delta_usd_micros: 500000, created_at: ago(40 * D) }, // out of 30d
    ],
    authSessions: [
      { email: 'a@x.com', last_used_at: ago(2 * 3_600_000) }, // 2h → DAU
      { email: 'c@x.com', last_used_at: ago(3 * D) }, // 3d → WAU
      { email: 'd@x.com', last_used_at: ago(20 * D) }, // 20d → MAU
    ],
  };

  it('reports window-scoped KPIs matching a direct hand-count', async () => {
    const { pool } = createAdminAnalyticsMemoryPool(seed);
    const ov = await getOverview(pool, { since: SINCE_30D, now: NOW });

    // accounts opened in the 30d window: only a@x.com (b is 40d old)
    assert.equal(ov.accountsOpened, 1);

    // envelope cohort by created_at in window (internal-test excluded): a(completed), c(active), w(voided)
    assert.deepEqual(ov.envelopes, { created: 3, completed: 1, inProcess: 1 });

    // credits in window (micros as strings): paid-in = x402 250000 (stripe is 40d, out);
    // granted = signup_grant 1000000; consumed = -(envelope -250000) = 250000
    assert.equal(ov.credits.paidInUsdMicros, '250000');
    assert.equal(ov.credits.grantedUsdMicros, '1000000');
    assert.equal(ov.credits.consumedUsdMicros, '250000');

    // active users on the FIXED bands (independent of the page window):
    // DAU(24h)=a; WAU(7d)=a,c + w(created 2d, no session); MAU(30d)=+d
    assert.deepEqual(ov.activeUsers, { dau: 1, wau: 3, mau: 4 });
  });

  it('all-time window (since = null) counts everything', async () => {
    const { pool } = createAdminAnalyticsMemoryPool(seed);
    const ov = await getOverview(pool, { since: null, now: NOW });
    assert.equal(ov.accountsOpened, 2); // both a and b
    assert.equal(ov.envelopes.created, 4); // a,c,w,z (internal-test still excluded)
    assert.equal(ov.credits.paidInUsdMicros, '750000'); // x402 250000 + stripe 500000
  });
});

describe('getAccounts — F-34.3 / AC-184, AC-185', () => {
  const seed = {
    userCredits: [
      { email: 'h@x.com', balance_usd_micros: 750000, created_at: ago(5 * D) },
      { email: 'w@x.com', balance_usd_micros: 250000, created_at: ago(3 * D) },
      { email: 'hb@x.com', balance_usd_micros: 100000, created_at: ago(4 * D) },
      { email: 'p@x.com', balance_usd_micros: 900000, created_at: ago(6 * D) },
      { email: 'old@x.com', balance_usd_micros: 0, created_at: ago(40 * D) },
    ],
    envelopes: [
      { sender_email: 'h@x.com', status: 'completed', created_at: ago(5 * D), completed_at: ago(4 * D) },
      { sender_email: 'w@x.com', status: 'active', created_at: ago(3 * D), completed_at: null },
      { sender_email: 'hb@x.com', status: 'completed', created_at: ago(4 * D), completed_at: ago(3 * D) },
      { sender_email: 'p@x.com', status: 'active', created_at: ago(6 * D), completed_at: null },
      { sender_email: 'old@x.com', status: 'completed', created_at: ago(40 * D), completed_at: ago(39 * D) },
    ],
    creditLedger: [
      { email: 'h@x.com', source: 'signup_grant', delta_usd_micros: 1000000, created_at: ago(5 * D) },
      { email: 'w@x.com', source: 'x402', delta_usd_micros: 250000, created_at: ago(3 * D) },
      { email: 'hb@x.com', source: 'x402', delta_usd_micros: 100000, created_at: ago(4 * D) },
      { email: 'p@x.com', source: 'signup_grant', delta_usd_micros: 1000000, created_at: ago(6 * D) },
    ],
    authSessions: [
      { email: 'h@x.com', last_used_at: ago(2 * 3_600_000) },
      { email: 'hb@x.com', last_used_at: ago(1 * D) },
      { email: 'p@x.com', last_used_at: ago(6 * D) },
      { email: 'old@x.com', last_used_at: ago(40 * D) },
    ],
    apiKeys: [
      { creator_email: 'p@x.com', revoked_at: null },
      { creator_email: 'h@x.com', revoked_at: ago(1 * D) }, // revoked → NOT programmatic
    ],
  };

  it('classifies each identity active in the window (Human/Agent/wallet-funded/Programmatic) with per-identity counts', async () => {
    const { pool } = createAdminAnalyticsMemoryPool(seed);
    const rows = await getAccounts(pool, { since: SINCE_30D, now: NOW });
    const by = Object.fromEntries(rows.map((r) => [r.email, r]));

    // old@x.com is 40d old on every signal → NOT active in the 30d window
    assert.equal(rows.length, 4);
    assert.equal(by['old@x.com'], undefined);

    // pure human: session + signup_grant, no x402, revoked key → not programmatic
    assert.equal(by['h@x.com'].kind, 'human');
    assert.equal(by['h@x.com'].walletFunded, false);
    assert.equal(by['h@x.com'].programmatic, false);
    assert.equal(by['h@x.com'].balanceUsdMicros, '750000');
    assert.deepEqual(by['h@x.com'].envelopes, { created: 1, completed: 1, inProcess: 0 });

    // pure wallet agent: x402 + NO session
    assert.equal(by['w@x.com'].kind, 'agent');
    assert.equal(by['w@x.com'].walletFunded, true);
    assert.equal(by['w@x.com'].lastSeen, null);
    assert.deepEqual(by['w@x.com'].envelopes, { created: 1, completed: 0, inProcess: 1 });

    // both: session + x402 → Human, wallet-funded
    assert.equal(by['hb@x.com'].kind, 'human');
    assert.equal(by['hb@x.com'].walletFunded, true);

    // programmatic human: non-revoked api key
    assert.equal(by['p@x.com'].kind, 'human');
    assert.equal(by['p@x.com'].programmatic, true);
  });
});

describe('getEnvelopeFunnel — F-34.4 / AC-186', () => {
  const seed = {
    envelopes: [
      { id: 'e1', sender_email: 'a@x.com', document_name: 'd1', status: 'completed', created_at: ago(5 * D), completed_at: ago(4 * D) }, // 1d
      { id: 'e2', sender_email: 'a@x.com', document_name: 'd2', status: 'completed', created_at: ago(10 * D), completed_at: ago(7 * D) }, // 3d
      { id: 'e3', sender_email: 'b@x.com', document_name: 'd3', status: 'active', created_at: ago(2 * D), completed_at: null }, // aging 1-3d
      { id: 'e4', sender_email: 'b@x.com', document_name: 'd4', status: 'awaiting_seal', created_at: ago(6 * D), completed_at: null }, // aging 3-7d
      { id: 'e5', sender_email: 'c@x.com', document_name: 'd5', status: 'active', created_at: ago(12 * 3_600_000), completed_at: null }, // aging <1d
      { id: 'e6', sender_email: 'c@x.com', document_name: 'd6', status: 'voided', created_at: ago(3 * D), completed_at: null },
      { id: 'e7', sender_email: 'c@x.com', document_name: 'd7', status: 'expired', created_at: ago(8 * D), completed_at: null },
      { id: 'e8', sender_email: 'a@x.com', document_name: 'd8', status: 'completed', created_at: ago(40 * D), completed_at: ago(39 * D) }, // out of window
      { id: 'e9', sender_email: 'i@x.com', document_name: 'd9', status: 'completed', created_at: ago(1 * D), completed_at: ago(1 * D), internal_test: true }, // excluded
    ],
  };

  it('computes the funnel, avg time-to-complete, aging buckets, and void/expire counts for the window', async () => {
    const { pool } = createAdminAnalyticsMemoryPool(seed);
    const f = await getEnvelopeFunnel(pool, { since: SINCE_30D, now: NOW });

    assert.equal(f.created, 7); // e1..e7 (e8 out of window, e9 internal-test)
    assert.equal(f.completed, 2); // e1, e2
    assert.equal(Math.round(f.completionRate * 100), 29); // 2/7
    assert.equal(f.avgTimeToCompleteMs, ((1 + 3) / 2) * D); // (1d + 3d)/2 = 2d
    assert.deepEqual(f.aging, { lt1d: 1, d1to3: 1, d3to7: 1, gt7d: 0 }); // e5, e3, e4
    assert.equal(f.voided, 1); // e6
    assert.equal(f.expired, 1); // e7
    assert.equal(f.list.length, 7);
    assert.ok(f.list.every((r) => r.id && r.status));
  });
});

describe('getSignals — F-34.5 / AC-187', () => {
  const seed = {
    envelopes: [
      { id: 'e1', sender_email: 'w@x.com', status: 'active', created_at: ago(5 * D) }, // wallet creator, in window
      { id: 'e2', sender_email: 'h@x.com', status: 'active', created_at: ago(10 * D) }, // human creator, in window
      { id: 'e3', sender_email: 'w@x.com', status: 'completed', created_at: ago(40 * D) }, // out of window
    ],
    creditLedger: [
      { email: 'w@x.com', source: 'x402', delta_usd_micros: 250000, created_at: ago(5 * D) },
      { email: 'h@x.com', source: 'signup_grant', delta_usd_micros: 1000000, created_at: ago(10 * D) },
    ],
    signers: [
      { envelope_id: 'e1', status: 'signed', undeliverable_at: null },
      { envelope_id: 'e1', status: 'pending', undeliverable_at: ago(4 * D) }, // hard bounce
      { envelope_id: 'e2', status: 'signed', undeliverable_at: null },
      { envelope_id: 'e3', status: 'signed', undeliverable_at: null }, // parent out of window → excluded
    ],
    apiKeys: [
      { creator_email: 'p@x.com', revoked_at: null },
      { creator_email: 'q@x.com', revoked_at: ago(1 * D) }, // revoked → not counted
    ],
  };

  it('reports signer deliverability and agent-adoption signals for the window', async () => {
    const { pool } = createAdminAnalyticsMemoryPool(seed);
    const s = await getSignals(pool, { since: SINCE_30D, now: NOW });
    // deliverability over signers of in-window envelopes (e1, e2): invited 3, signed 2, undeliverable 1
    assert.deepEqual(s.deliverability, { invited: 3, signed: 2, undeliverable: 1 });
    // agent adoption: e1 creator has x402 → wallet; e2 → human; api-key holders = 1 (p; q revoked)
    assert.deepEqual(s.agentAdoption, { walletCreates: 1, humanCreates: 1, apiKeyHolders: 1 });
  });
});

describe('F-35 exclude-internal — the operator-view toggle (AC-188/189)', () => {
  // An internal_test envelope, an internal-IDENTITY set (staff@kychee.com — matched
  // by the @kychee.com rule) with its own account/ledger/session/key, and an
  // external set (ext@customer.com) that must survive both toggle states.
  const RULES = ['@kychee.com'];
  const seed = {
    userCredits: [
      { email: 'ext@customer.com', balance_usd_micros: 500000, created_at: ago(5 * D) },
      { email: 'staff@kychee.com', balance_usd_micros: 0, created_at: ago(5 * D) },
    ],
    envelopes: [
      { sender_email: 'ext@customer.com', status: 'completed', created_at: ago(5 * D), completed_at: ago(4 * D) },
      { sender_email: 'staff@kychee.com', status: 'active', created_at: ago(4 * D), completed_at: null }, // internal identity
      { sender_email: 'ext@customer.com', status: 'active', created_at: ago(3 * D), completed_at: null, internal_test: true }, // internal_test flag
    ],
    creditLedger: [
      { email: 'ext@customer.com', source: 'x402', delta_usd_micros: 250000, created_at: ago(5 * D) },
      { email: 'staff@kychee.com', source: 'signup_grant', delta_usd_micros: 1000000, created_at: ago(5 * D) },
    ],
    authSessions: [
      { email: 'ext@customer.com', last_used_at: ago(2 * 3_600_000) },
      { email: 'staff@kychee.com', last_used_at: ago(2 * 3_600_000) },
    ],
    apiKeys: [{ creator_email: 'staff@kychee.com', revoked_at: null }],
  };

  it('toggle ON → Overview reflects only the external records (identity + internal_test excluded)', async () => {
    const { pool } = createAdminAnalyticsMemoryPool(seed);
    const ov = await getOverview(pool, { since: SINCE_30D, now: NOW, excludeInternal: true, internalIdentities: RULES });
    assert.equal(ov.accountsOpened, 1); // only ext@ (staff excluded by identity)
    assert.deepEqual(ov.envelopes, { created: 1, completed: 1, inProcess: 0 }); // ext completed only
    assert.equal(ov.credits.paidInUsdMicros, '250000'); // ext x402
    assert.equal(ov.credits.grantedUsdMicros, '0'); // staff's grant excluded
    assert.deepEqual(ov.activeUsers, { dau: 1, wau: 1, mau: 1 }); // ext session only
  });

  it('toggle OFF → Overview additionally includes the internal records', async () => {
    const { pool } = createAdminAnalyticsMemoryPool(seed);
    const ov = await getOverview(pool, { since: SINCE_30D, now: NOW, excludeInternal: false, internalIdentities: RULES });
    assert.equal(ov.accountsOpened, 2); // ext + staff
    assert.deepEqual(ov.envelopes, { created: 3, completed: 1, inProcess: 2 }); // all three
    assert.equal(ov.credits.grantedUsdMicros, '1000000'); // staff's grant now counted
    assert.deepEqual(ov.activeUsers, { dau: 2, wau: 2, mau: 2 });
  });

  it('Accounts / Envelopes / Signals honor the toggle; the external identity survives both', async () => {
    const { pool } = createAdminAnalyticsMemoryPool(seed);

    const accOn = await getAccounts(pool, { since: SINCE_30D, now: NOW, excludeInternal: true, internalIdentities: RULES });
    const accOff = await getAccounts(pool, { since: SINCE_30D, now: NOW, excludeInternal: false, internalIdentities: RULES });
    assert.deepEqual(accOn.map((r) => r.email).sort(), ['ext@customer.com']);
    assert.ok(accOff.map((r) => r.email).includes('staff@kychee.com'));
    assert.ok(accOn.map((r) => r.email).includes('ext@customer.com'));
    assert.ok(accOff.map((r) => r.email).includes('ext@customer.com')); // external never excluded

    const fOn = await getEnvelopeFunnel(pool, { since: SINCE_30D, now: NOW, excludeInternal: true, internalIdentities: RULES });
    const fOff = await getEnvelopeFunnel(pool, { since: SINCE_30D, now: NOW, excludeInternal: false, internalIdentities: RULES });
    assert.equal(fOn.created, 1);
    assert.equal(fOff.created, 3);

    const sigOn = await getSignals(pool, { since: SINCE_30D, excludeInternal: true, internalIdentities: RULES });
    const sigOff = await getSignals(pool, { since: SINCE_30D, excludeInternal: false, internalIdentities: RULES });
    assert.equal(sigOn.agentAdoption.apiKeyHolders, 0); // staff's key excluded
    assert.equal(sigOff.agentAdoption.apiKeyHolders, 1);
  });
});
