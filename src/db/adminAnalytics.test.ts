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
import { getOverview } from './adminAnalytics.js';
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
