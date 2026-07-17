import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleHealth, handleDeepHealth } from './health.js';

describe('handleHealth — GET /v1/health (AC-32)', () => {
  it('returns 200 ok with no auth required', () => {
    const r = handleHealth(new Date('2026-06-14T00:00:00.000Z'));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.service, 'kysigned');
    assert.equal(r.body.ts, '2026-06-14T00:00:00.000Z');
    assert.ok(!('checks' in r.body), 'the bare liveness body is UNCHANGED (forker verify.http)');
  });
});

describe('handleDeepHealth — GET /v1/health?deep=1 (#146 readiness)', () => {
  const ok = async () => {};
  const boom = async () => {
    throw new Error('connection refused');
  };
  const hang = () => new Promise<void>(() => {});

  it('db + mailbox both pass → 200 ok with named checks', async () => {
    const r = await handleDeepHealth({ checkDb: ok, checkMailbox: ok, now: new Date('2026-07-17T00:00:00.000Z') });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.service, 'kysigned');
    assert.deepEqual(r.body.checks, { db: 'ok', mailbox: 'ok' });
    assert.equal(r.body.ts, '2026-07-17T00:00:00.000Z');
  });

  it('a dead DB → 503 degraded with the FAILING CHECK NAMED (mailbox still reported)', async () => {
    const r = await handleDeepHealth({ checkDb: boom, checkMailbox: ok });
    assert.equal(r.status, 503);
    assert.equal(r.body.status, 'degraded');
    assert.equal(r.body.checks.db, 'fail');
    assert.equal(r.body.checks.mailbox, 'ok');
  });

  it('a suspended/unreachable mailbox → 503 degraded naming the mailbox check', async () => {
    const r = await handleDeepHealth({ checkDb: ok, checkMailbox: boom });
    assert.equal(r.status, 503);
    assert.equal(r.body.checks.db, 'ok');
    assert.equal(r.body.checks.mailbox, 'fail');
  });

  it('a HANGING check is bounded by the timeout → 503 with that check marked timeout', async () => {
    const started = Date.now();
    const r = await handleDeepHealth({ checkDb: hang, checkMailbox: ok, timeoutMs: 30 });
    assert.ok(Date.now() - started < 1_000, 'returns promptly — the probe never hangs the endpoint');
    assert.equal(r.status, 503);
    assert.equal(r.body.checks.db, 'timeout');
    assert.equal(r.body.checks.mailbox, 'ok');
  });

  it('check results never leak internal error detail (public unauthenticated endpoint)', async () => {
    const r = await handleDeepHealth({
      checkDb: async () => {
        throw new Error('password authentication failed for user "kysigned_admin" at 10.0.3.7');
      },
      checkMailbox: ok,
    });
    assert.doesNotMatch(JSON.stringify(r.body), /password|10\.0\.3\.7|kysigned_admin/);
    assert.equal(r.body.checks.db, 'fail');
  });
});
