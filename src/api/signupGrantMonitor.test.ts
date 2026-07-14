/**
 * signupGrantMonitor tests — trial-credit abuse monitor + operator alert
 * (F-16.6 / AC-97, Phase 25).
 *
 * The monitor reads grant issuance + grant-funded envelope volume from the
 * credit_ledger over a rolling window and emails the operator when issuance
 * exceeds a configured rate, so a free-envelope-farming spike is visible and the
 * operator can disable the grant (KYSIGNED_SIGNUP_GRANT_CREDITS=0 + redeploy).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSignupGrantStats,
  exceedsGrantRate,
  runSignupGrantMonitor,
  type SignupGrantStats,
} from './signupGrantMonitor.js';
import type { DbPool } from '../db/pool.js';
import type { EmailMessage, EmailProvider } from '../email/types.js';

const NOW = new Date('2026-06-29T12:00:00Z');
const within = new Date('2026-06-29T06:00:00Z'); // 6h ago (inside a 24h window)
const old = new Date('2026-06-27T00:00:00Z'); // >24h ago (outside)

// Ledger-backed pool that answers the monitor's two COUNT queries.
function statsPool(ledger: Array<{ email: string; source: string; created_at: Date }>): DbPool {
  const grantEmails = new Set(ledger.filter((r) => r.source === 'signup_grant').map((r) => r.email));
  return {
    async query(text: string, values?: unknown[]) {
      const since = new Date((values ?? [])[0] as string);
      if (/source = 'signup_grant' AND created_at >= \$1/.test(text)) {
        const n = ledger.filter((r) => r.source === 'signup_grant' && r.created_at >= since).length;
        return { rows: [{ n }], rowCount: 1 } as never;
      }
      if (/source = 'envelope' AND created_at >= \$1[\s\S]*signup_grant/.test(text)) {
        const n = ledger.filter((r) => r.source === 'envelope' && r.created_at >= since && grantEmails.has(r.email)).length;
        return { rows: [{ n }], rowCount: 1 } as never;
      }
      throw new Error(`Unexpected query: ${text.trim()}`);
    },
    async end() {},
  };
}

function captureEmail() {
  const sent: EmailMessage[] = [];
  const provider: EmailProvider = { async send(m) { sent.push(m); return { messageId: 'm1' }; } };
  return { provider, sent };
}

describe('exceedsGrantRate', () => {
  it('true only when issuance strictly exceeds a positive threshold', () => {
    const s = (n: number): SignupGrantStats => ({ issuanceCount: n, grantFundedEnvelopeCount: 0 });
    assert.equal(exceedsGrantRate(s(101), 100), true);
    assert.equal(exceedsGrantRate(s(100), 100), false);
    assert.equal(exceedsGrantRate(s(50), 100), false);
  });
  it('a threshold of 0 (or less) disables alerting', () => {
    assert.equal(exceedsGrantRate({ issuanceCount: 9999, grantFundedEnvelopeCount: 0 }, 0), false);
  });
});

describe('getSignupGrantStats', () => {
  it('counts signup_grant issuance + grant-funded envelopes inside the window only', async () => {
    const pool = statsPool([
      { email: 'a@x.com', source: 'signup_grant', created_at: within },
      { email: 'b@x.com', source: 'signup_grant', created_at: within },
      { email: 'c@x.com', source: 'signup_grant', created_at: old }, // outside window → excluded
      { email: 'a@x.com', source: 'envelope', created_at: within }, // grant-recipient envelope → counted
      { email: 'z@x.com', source: 'envelope', created_at: within }, // purchaser (no grant) → not counted
    ]);
    const since = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const stats = await getSignupGrantStats(pool, since);
    assert.equal(stats.issuanceCount, 2, 'two grants inside the window');
    assert.equal(stats.grantFundedEnvelopeCount, 1, 'only the grant-recipient envelope counts');
  });
});

describe('runSignupGrantMonitor', () => {
  it('emails the operator when issuance exceeds the threshold', async () => {
    const ledger = Array.from({ length: 5 }, (_, i) => ({ email: `u${i}@x.com`, source: 'signup_grant', created_at: within }));
    const pool = statsPool(ledger);
    const { provider, sent } = captureEmail();
    const r = await runSignupGrantMonitor(pool, { emailProvider: provider, operatorDomain: 'kysigned.com', alertThreshold: 3, now: NOW });
    assert.equal(r.alerted, true);
    assert.equal(r.stats.issuanceCount, 5);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'info@kysigned.com');
    assert.match(sent[0]!.from!, /^notifications@kysigned\.com$/);
    assert.match(sent[0]!.subject, /5/);
    assert.match(sent[0]!.text, /KYSIGNED_SIGNUP_GRANT_CREDITS=0/);
  });

  it('routes the alert to the configured operator alert address when set (interim external routing, #149)', async () => {
    const ledger = Array.from({ length: 5 }, (_, i) => ({ email: `u${i}@x.com`, source: 'signup_grant', created_at: within }));
    const { provider, sent } = captureEmail();
    const r = await runSignupGrantMonitor(statsPool(ledger), {
      emailProvider: provider,
      operatorDomain: 'kysigned.com',
      alertEmail: 'barry@kychee.com',
      alertThreshold: 3,
      now: NOW,
    });
    assert.equal(r.alerted, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'barry@kychee.com');
    assert.match(sent[0]!.from!, /^notifications@kysigned\.com$/, 'the sender mailbox is unchanged');
  });

  it('does NOT email when issuance is within the threshold', async () => {
    const pool = statsPool([{ email: 'u@x.com', source: 'signup_grant', created_at: within }]);
    const { provider, sent } = captureEmail();
    const r = await runSignupGrantMonitor(pool, { emailProvider: provider, operatorDomain: 'kysigned.com', alertThreshold: 100, now: NOW });
    assert.equal(r.alerted, false);
    assert.equal(sent.length, 0);
  });

  it('never alerts when the threshold is 0 (monitor still reports the metric)', async () => {
    const ledger = Array.from({ length: 50 }, (_, i) => ({ email: `u${i}@x.com`, source: 'signup_grant', created_at: within }));
    const { provider, sent } = captureEmail();
    const r = await runSignupGrantMonitor(statsPool(ledger), { emailProvider: provider, operatorDomain: 'kysigned.com', alertThreshold: 0, now: NOW });
    assert.equal(r.alerted, false);
    assert.equal(sent.length, 0);
    assert.equal(r.stats.issuanceCount, 50, 'metric is still computed for the logs');
  });
});
