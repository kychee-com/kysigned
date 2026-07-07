/**
 * runHandlers — the durable-run event handlers (F-29).
 *
 * Tests the completion_distribute handler's ORCHESTRATION: auto vs manual
 * branching + the retry-marker mapping (deferred/partial → RetryableRunError).
 * The distribute / notify operations are injected fakes — their internals are
 * covered by distributeBundle.test.ts / sealEnvelope.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunHandlers, RetryableRunError, PermanentRunError, type RunHandlerDeps } from './runHandlers.js';
import { createInboundRepliesMemoryPool } from '../db/inboundReplies.testpool.js';
import { TIMESTAMP_UPGRADE_MAX_ATTEMPTS } from '../api/signing/timestampSchedule.js';
import { RETENTION_MAX_FAST_ATTEMPTS } from '../api/retentionSchedule.js';
import type { DistributeResult } from '../api/distributeBundle.js';
import type { AwaitingSealAction } from '../api/sealEnvelope.js';
import type { DbPool } from '../db/pool.js';

function depsWith(
  pool: RunHandlerDeps['pool'],
  createRun: RunHandlerDeps['createRun'] = async () => ({ runId: 'r', deduplicated: false }),
): RunHandlerDeps {
  // The dep factories are unused by the injected fakes below (they ignore them).
  return {
    pool,
    distributeDeps: () => ({}) as never,
    inboundEmailCtx: () => ({}) as never,
    reminderSendCtx: () => ({}) as never,
    emailProvider: {} as never,
    operatorDomain: 'kysigned.com',
    expirationStorage: () => ({}) as never,
    timestampProvider: () => ({}) as never,
    createRun,
    signupGrantAlertThreshold: 100,
  };
}

describe('runHandlers — completion_distribute (F-29 / F-24)', () => {
  it('auto-close: distributes and returns the auto summary', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'active', auto_close: true });
    let seen = '';
    const handlers = buildRunHandlers(depsWith(h.pool), {
      distribute: async (_p, id): Promise<DistributeResult> => {
        seen = id;
        return { envelopeId: id, action: 'distributed', recipients: 2, sent: 2 };
      },
    });
    const out = await handlers.completion_distribute({ envelopeId: 'env-1' });
    assert.equal(seen, 'env-1');
    assert.equal(out.mode, 'auto');
    assert.equal(out.action, 'distributed');
    assert.equal(out.sent, 2);
  });

  it('auto-close: a deferred distribute throws RetryableRunError (run402 retries)', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'active', auto_close: true });
    const handlers = buildRunHandlers(depsWith(h.pool), {
      distribute: async (_p, id): Promise<DistributeResult> => ({ envelopeId: id, action: 'deferred', recipients: 0, sent: 0 }),
    });
    await assert.rejects(() => handlers.completion_distribute({ envelopeId: 'env-1' }), RetryableRunError);
  });

  it('auto-close: a partial distribute throws RetryableRunError', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'active', auto_close: true });
    const handlers = buildRunHandlers(depsWith(h.pool), {
      distribute: async (_p, id): Promise<DistributeResult> => ({ envelopeId: id, action: 'partial', recipients: 2, sent: 1 }),
    });
    await assert.rejects(() => handlers.completion_distribute({ envelopeId: 'env-1' }), RetryableRunError);
  });

  it('manual (auto_close=false): notifies + parks, returns the manual summary', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-2', status: 'active', auto_close: false });
    let notified = false;
    const handlers = buildRunHandlers(depsWith(h.pool), {
      notifySeal: async (_p, id): Promise<{ envelopeId: string; action: AwaitingSealAction }> => {
        notified = true;
        return { envelopeId: id, action: 'notified' };
      },
    });
    const out = await handlers.completion_distribute({ envelopeId: 'env-2' });
    assert.ok(notified);
    assert.equal(out.mode, 'manual');
    assert.equal(out.action, 'notified');
  });

  it('manual: a deferred seal-notify throws RetryableRunError', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-2', status: 'active', auto_close: false });
    const handlers = buildRunHandlers(depsWith(h.pool), {
      notifySeal: async (_p, id): Promise<{ envelopeId: string; action: AwaitingSealAction }> => ({ envelopeId: id, action: 'deferred' }),
    });
    await assert.rejects(() => handlers.completion_distribute({ envelopeId: 'env-2' }), RetryableRunError);
  });

  it('a missing envelopeId is a permanent error (no retry)', async () => {
    const h = createInboundRepliesMemoryPool();
    const handlers = buildRunHandlers(depsWith(h.pool), {});
    await assert.rejects(() => handlers.completion_distribute({}), PermanentRunError);
  });

  it('a vanished envelope is terminal — no distribute, no throw', async () => {
    const h = createInboundRepliesMemoryPool();
    let called = false;
    const handlers = buildRunHandlers(depsWith(h.pool), {
      distribute: async (_p, id): Promise<DistributeResult> => {
        called = true;
        return { envelopeId: id, action: 'distributed', recipients: 0, sent: 0 };
      },
    });
    const out = await handlers.completion_distribute({ envelopeId: 'does-not-exist' });
    assert.equal(called, false);
    assert.equal(out.action, 'gone');
  });
});

describe('runHandlers — reminder_send (F-29 / F-5.5)', () => {
  it('sends the reminder for a still-pending signer on an active envelope', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'active', sender_email: 'creator@x.com' });
    let reminded = '';
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadSigner: async () => ({ id: 'sig-1', status: 'pending', reminder_count: 0 }) as never,
      remind: async (_ctx, _env, signer) => { reminded = signer.id; },
    });
    const out = await handlers.reminder_send({ envelopeId: 'env-1', signerId: 'sig-1', reminderNumber: 1 });
    assert.equal(reminded, 'sig-1');
    assert.equal(out.action, 'reminded');
  });

  it('no-ops when the envelope is no longer active', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'completed' });
    let called = false;
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadSigner: async () => ({ id: 'sig-1', status: 'pending', reminder_count: 0 }) as never,
      remind: async () => { called = true; },
    });
    const out = await handlers.reminder_send({ envelopeId: 'env-1', signerId: 'sig-1', reminderNumber: 1 });
    assert.equal(called, false);
    assert.equal(out.action, 'skipped_inactive');
  });

  it('no-ops when the signer already signed', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'active' });
    let called = false;
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadSigner: async () => ({ id: 'sig-1', status: 'signed', reminder_count: 0 }) as never,
      remind: async () => { called = true; },
    });
    const out = await handlers.reminder_send({ envelopeId: 'env-1', signerId: 'sig-1', reminderNumber: 1 });
    assert.equal(called, false);
    assert.equal(out.action, 'skipped_not_pending');
  });

  it('is idempotent within a reminder number (reminder_count >= number → already_sent)', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'active' });
    let called = false;
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadSigner: async () => ({ id: 'sig-1', status: 'pending', reminder_count: 1 }) as never,
      remind: async () => { called = true; },
    });
    const out = await handlers.reminder_send({ envelopeId: 'env-1', signerId: 'sig-1', reminderNumber: 1 });
    assert.equal(called, false);
    assert.equal(out.action, 'already_sent');
  });

  it('a failed send throws RetryableRunError', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'active' });
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadSigner: async () => ({ id: 'sig-1', status: 'pending', reminder_count: 0 }) as never,
      remind: async () => { throw new Error('SES down'); },
    });
    await assert.rejects(() => handlers.reminder_send({ envelopeId: 'env-1', signerId: 'sig-1', reminderNumber: 1 }), RetryableRunError);
  });

  it('no-ops when the signer is already marked undeliverable (36.2 — the backstop fired first)', async () => {
    // A backstop-marked signer keeps status:pending (undeliverability is undeliverable_at,
    // not a status enum value), so reminders would otherwise still nudge a dead address.
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'active' });
    let called = false;
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadSigner: async () => ({ id: 'sig-1', status: 'pending', reminder_count: 0, undeliverable_at: new Date() }) as never,
      remind: async () => { called = true; },
    });
    const out = await handlers.reminder_send({ envelopeId: 'env-1', signerId: 'sig-1', reminderNumber: 1 });
    assert.equal(called, false);
    assert.equal(out.action, 'skipped_undeliverable');
  });

  it('missing payload fields → PermanentRunError', async () => {
    const h = createInboundRepliesMemoryPool();
    const handlers = buildRunHandlers(depsWith(h.pool), {});
    await assert.rejects(() => handlers.reminder_send({ envelopeId: 'env-1' }), PermanentRunError);
  });
});

describe('runHandlers — delivery_backstop (F-29 / F-9.9 / AC-124)', () => {
  it('marks the signer undeliverable + notifies the creator when the window closes with it still pending', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'active' });
    let marked = '';
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadSigner: async () => ({ id: 'sig-1', status: 'pending', email: 'bad@x.com', undeliverable_at: null }) as never,
      handleUndeliverable: async (_ctx, envId, email) => { marked = `${envId}:${email}`; return { status: 200, body: { marked: true } }; },
    });
    const out = await handlers.delivery_backstop({ envelopeId: 'env-1', signerId: 'sig-1' });
    assert.equal(marked, 'env-1:bad@x.com'); // envelope-scoped mark + notice
    assert.equal(out.action, 'undeliverable_timeout');
  });

  it('no-ops when the signer already signed (delivery obviously succeeded)', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'active' });
    let called = false;
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadSigner: async () => ({ id: 'sig-1', status: 'signed', email: 'ok@x.com', undeliverable_at: null }) as never,
      handleUndeliverable: async () => { called = true; return { status: 200, body: { marked: true } }; },
    });
    const out = await handlers.delivery_backstop({ envelopeId: 'env-1', signerId: 'sig-1' });
    assert.equal(called, false);
    assert.equal(out.action, 'skipped_not_pending');
  });

  it('no-ops when the signer is already marked undeliverable (idempotent)', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'active' });
    let called = false;
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadSigner: async () => ({ id: 'sig-1', status: 'pending', email: 'bad@x.com', undeliverable_at: new Date() }) as never,
      handleUndeliverable: async () => { called = true; return { status: 200, body: { marked: true } }; },
    });
    const out = await handlers.delivery_backstop({ envelopeId: 'env-1', signerId: 'sig-1' });
    assert.equal(called, false);
    assert.equal(out.action, 'already_undeliverable');
  });

  it('no-ops when the envelope is no longer active (voided/completed/expired)', async () => {
    const h = createInboundRepliesMemoryPool();
    h.envelopes.push({ id: 'env-1', status: 'voided' });
    let called = false;
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadSigner: async () => ({ id: 'sig-1', status: 'pending', email: 'bad@x.com', undeliverable_at: null }) as never,
      handleUndeliverable: async () => { called = true; return { status: 200, body: { marked: true } }; },
    });
    const out = await handlers.delivery_backstop({ envelopeId: 'env-1', signerId: 'sig-1' });
    assert.equal(called, false);
    assert.equal(out.action, 'skipped_inactive');
  });

  it('missing payload fields → PermanentRunError (no retry)', async () => {
    const h = createInboundRepliesMemoryPool();
    const handlers = buildRunHandlers(depsWith(h.pool), {});
    await assert.rejects(() => handlers.delivery_backstop({ envelopeId: 'env-1' }), PermanentRunError);
  });
});

describe('runHandlers — envelope_expire (F-29 / DD-16)', () => {
  it('claims + notifies a past-deadline envelope', async () => {
    const h = createInboundRepliesMemoryPool();
    let notified = '';
    const handlers = buildRunHandlers(depsWith(h.pool), {
      claimExpired: async (_p, id) => ({ id, status: 'expired' }) as never,
      notifyExpired: async (_p, env) => { notified = env.id; },
    });
    const out = await handlers.envelope_expire({ envelopeId: 'env-1' });
    assert.equal(notified, 'env-1');
    assert.equal(out.action, 'expired');
  });

  it('no-ops when the envelope can no longer be claimed (completed/voided/not yet due)', async () => {
    const h = createInboundRepliesMemoryPool();
    let notified = false;
    const handlers = buildRunHandlers(depsWith(h.pool), {
      claimExpired: async () => null,
      notifyExpired: async () => { notified = true; },
    });
    const out = await handlers.envelope_expire({ envelopeId: 'env-1' });
    assert.equal(notified, false);
    assert.equal(out.action, 'skipped');
  });

  it('still reports expired when the notice send fails (best-effort, not retried)', async () => {
    const h = createInboundRepliesMemoryPool();
    const handlers = buildRunHandlers(depsWith(h.pool), {
      claimExpired: async (_p, id) => ({ id, status: 'expired' }) as never,
      notifyExpired: async () => { throw new Error('SES down'); },
    });
    const out = await handlers.envelope_expire({ envelopeId: 'env-1' });
    assert.equal(out.action, 'expired'); // did not throw / retry
  });

  it('missing envelopeId → PermanentRunError', async () => {
    const h = createInboundRepliesMemoryPool();
    const handlers = buildRunHandlers(depsWith(h.pool), {});
    await assert.rejects(() => handlers.envelope_expire({}), PermanentRunError);
  });
});

describe('runHandlers — timestamp_upgrade (F-29 / F-6.6, self-rescheduling)', () => {
  it('marks complete + terminates when the proof confirms', async () => {
    const h = createInboundRepliesMemoryPool();
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadArtifact: async () => ({ id: 'art-1', ts_status: 'pending' }) as never,
      upgradeArtifact: async () => 'upgraded',
    });
    const out = await handlers.timestamp_upgrade({ artifactId: 'art-1', attempt: 1 });
    assert.equal(out.action, 'upgraded');
  });

  it('self-reschedules the next attempt while still pending', async () => {
    const h = createInboundRepliesMemoryPool();
    const calls: Array<{ idempotencyKey: string }> = [];
    const deps = depsWith(h.pool, async (o) => { calls.push(o); return { runId: 'r', deduplicated: false }; });
    const handlers = buildRunHandlers(deps, {
      loadArtifact: async () => ({ id: 'art-1', ts_status: 'pending' }) as never,
      upgradeArtifact: async () => 'still_pending',
    });
    const out = await handlers.timestamp_upgrade({ artifactId: 'art-1', attempt: 1 });
    assert.equal(out.action, 'rescheduled');
    assert.equal(out.attempt, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].idempotencyKey, 'art-1:tsup:2');
  });

  it('terminates (no upgrade) when the artifact is already complete / gone', async () => {
    const h = createInboundRepliesMemoryPool();
    let upgraded = false;
    const handlers = buildRunHandlers(depsWith(h.pool), {
      loadArtifact: async () => ({ id: 'art-1', ts_status: 'complete' }) as never,
      upgradeArtifact: async () => { upgraded = true; return 'upgraded'; },
    });
    const out = await handlers.timestamp_upgrade({ artifactId: 'art-1', attempt: 1 });
    assert.equal(upgraded, false);
    assert.equal(out.action, 'done');
  });

  it('gives up at the reschedule cap (no further reschedule)', async () => {
    const h = createInboundRepliesMemoryPool();
    const calls: unknown[] = [];
    const deps = depsWith(h.pool, async (o) => { calls.push(o); return { runId: 'r', deduplicated: false }; });
    const handlers = buildRunHandlers(deps, {
      loadArtifact: async () => ({ id: 'art-1', ts_status: 'pending' }) as never,
      upgradeArtifact: async () => 'still_pending',
    });
    const out = await handlers.timestamp_upgrade({ artifactId: 'art-1', attempt: TIMESTAMP_UPGRADE_MAX_ATTEMPTS });
    assert.equal(out.action, 'gave_up');
    assert.equal(calls.length, 0);
  });

  it('missing artifactId → PermanentRunError', async () => {
    const h = createInboundRepliesMemoryPool();
    const handlers = buildRunHandlers(depsWith(h.pool), {});
    await assert.rejects(() => handlers.timestamp_upgrade({}), PermanentRunError);
  });
});

describe('runHandlers — signup_grant_monitor (F-29 / F-16.6)', () => {
  it('runs the daily monitor and returns its stats; no alert below the threshold', async () => {
    // The monitor's two COUNT queries both return 0 grants → below the 100 threshold.
    const pool = { async query() { return { rows: [{ n: 0 }], rowCount: 1 }; }, async end() {} } as never;
    const sent: unknown[] = [];
    const deps = {
      ...depsWith(pool),
      emailProvider: { send: async (m: unknown) => { sent.push(m); return { messageId: 'm' }; } } as never,
    };
    const handlers = buildRunHandlers(deps);
    const out = await handlers.signup_grant_monitor({});
    assert.equal(sent.length, 0, 'no operator alert when issuance is below threshold');
    assert.ok(out && typeof out === 'object', 'returns the monitor stats');
  });
});

// ── F-9.3 / F-013 — ephemeral-retention runs (completion_retention + sweep) ──────

const DOC = (h: string) => `envelopes/${h}/document.pdf`;
const COVER = (h: string, t: string) => `envelopes/${h}/cover-${t}.pdf`;

/** A focused pool over (envelopes × signers) that answers getEnvelope,
 *  getEnvelopeSigners, the pdf_deleted_at stamp, purgeEnvelopeBlobs' guard, and
 *  the sweep candidate query. */
function retentionPool(envelopes: any[], signers: any[]) {
  const stamped: string[] = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];
      if (text.includes('FROM envelopes') && text.includes('document_hash')) {
        const [docHash, selfId] = v;
        const sib = envelopes.find((e) => e.document_hash === docHash && e.id !== selfId && !e.pdf_deleted_at);
        return { rows: sib ? [{ one: 1 }] : [] } as any;
      }
      if (text.includes('FROM envelopes') && text.includes('status IN')) {
        return { rows: envelopes.filter((e) => !e.pdf_deleted_at && ['voided', 'expired', 'completed'].includes(e.status)) } as any;
      }
      if (text.includes('FROM envelopes WHERE id')) {
        const e = envelopes.find((x) => x.id === v[0]);
        return { rows: e ? [e] : [] } as any;
      }
      if (text.includes('FROM envelope_signers WHERE envelope_id')) {
        return { rows: signers.filter((s) => s.envelope_id === v[0]) } as any;
      }
      if (text.includes('SET pdf_deleted_at')) {
        const e = envelopes.find((x) => x.id === v[0]);
        if (e && !e.pdf_deleted_at) { e.pdf_deleted_at = v[1]; stamped.push(v[0] as string); return { rows: [], rowCount: 1 } as any; }
        return { rows: [], rowCount: 0 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };
  return { pool, stamped };
}

function retentionDeps(pool: DbPool, storage: { deletePdf(k: string): Promise<void> }, createRun: RunHandlerDeps['createRun']): RunHandlerDeps {
  return {
    pool,
    distributeDeps: () => ({}) as never,
    inboundEmailCtx: () => ({}) as never,
    reminderSendCtx: () => ({}) as never,
    emailProvider: {} as never,
    operatorDomain: 'kysigned.com',
    expirationStorage: () => storage as never,
    timestampProvider: () => ({}) as never,
    createRun,
    signupGrantAlertThreshold: 100,
  };
}

describe('runHandlers — completion_retention (F-9.3 / F-013)', () => {
  it('purges the document + covers once every completion email is delivered', async () => {
    const envelopes = [{ id: 'e1', document_hash: 'h1', status: 'completed', completed_at: new Date('2026-04-14T00:00:00Z'), pdf_deleted_at: null }];
    const signers = [{ envelope_id: 'e1', signing_token: 't1', status: 'signed', completion_email_delivered_at: new Date('2026-04-14T01:00:00Z'), completion_email_bounced_at: null }];
    const { pool, stamped } = retentionPool(envelopes, signers);
    const deleted: string[] = [];
    const handlers = buildRunHandlers(retentionDeps(pool, { async deletePdf(k) { deleted.push(k); } }, async () => ({ runId: 'r', deduplicated: false })));

    const out = await handlers.completion_retention({ envelopeId: 'e1', attempt: 1 });
    assert.equal(out.action, 'purged');
    assert.deepEqual(deleted.sort(), [COVER('h1', 't1'), DOC('h1')].sort());
    assert.deepEqual(stamped, ['e1']);
  });

  it('reschedules the fast chain while still awaiting delivery confirmation', async () => {
    const envelopes = [{ id: 'e1', document_hash: 'h1', status: 'completed', completed_at: new Date(), pdf_deleted_at: null }];
    const signers = [{ envelope_id: 'e1', signing_token: 't1', status: 'signed', completion_email_delivered_at: null, completion_email_bounced_at: null }];
    const { pool } = retentionPool(envelopes, signers);
    const scheduled: any[] = [];
    const deleted: string[] = [];
    const handlers = buildRunHandlers(retentionDeps(pool, { async deletePdf(k) { deleted.push(k); } }, async (o) => { scheduled.push(o); return { runId: 'r', deduplicated: false }; }));

    const out = await handlers.completion_retention({ envelopeId: 'e1', attempt: 1 });
    assert.equal(out.action, 'rescheduled');
    assert.equal(out.attempt, 2);
    assert.equal(deleted.length, 0, 'nothing purged while waiting');
    assert.equal(scheduled[0].eventType, 'completion_retention');
    assert.equal(scheduled[0].idempotencyKey, 'e1:retention:2');
  });

  it('stops rescheduling at the fast-attempt cap (hands the tail to the daily sweep)', async () => {
    const envelopes = [{ id: 'e1', document_hash: 'h1', status: 'completed', completed_at: new Date(), pdf_deleted_at: null }];
    const signers = [{ envelope_id: 'e1', signing_token: 't1', status: 'signed', completion_email_delivered_at: null, completion_email_bounced_at: null }];
    const { pool } = retentionPool(envelopes, signers);
    const scheduled: any[] = [];
    const handlers = buildRunHandlers(retentionDeps(pool, { async deletePdf() {} }, async (o) => { scheduled.push(o); return { runId: 'r', deduplicated: false }; }));

    const out = await handlers.completion_retention({ envelopeId: 'e1', attempt: RETENTION_MAX_FAST_ATTEMPTS });
    assert.equal(out.action, 'deferred_to_sweep');
    assert.equal(scheduled.length, 0, 'no further reschedule past the cap');
  });

  it('is idempotent — an already-purged envelope is a terminal no-op', async () => {
    const envelopes = [{ id: 'e1', document_hash: 'h1', status: 'completed', completed_at: new Date('2026-04-14T00:00:00Z'), pdf_deleted_at: new Date() }];
    const { pool } = retentionPool(envelopes, []);
    const deleted: string[] = [];
    const handlers = buildRunHandlers(retentionDeps(pool, { async deletePdf(k) { deleted.push(k); } }, async () => ({ runId: 'r', deduplicated: false })));
    const out = await handlers.completion_retention({ envelopeId: 'e1' });
    assert.equal(out.action, 'already_purged');
    assert.equal(deleted.length, 0);
  });

  it('a missing envelopeId is a permanent error (no retry)', async () => {
    const { pool } = retentionPool([], []);
    const handlers = buildRunHandlers(retentionDeps(pool, { async deletePdf() {} }, async () => ({ runId: 'r', deduplicated: false })));
    await assert.rejects(() => handlers.completion_retention({}), PermanentRunError);
  });
});

describe('runHandlers — retention_sweep (F-9.3 / F-013 backstop)', () => {
  it('purges every due terminal-state envelope and reports counts', async () => {
    const envelopes = [
      { id: 'v1', document_hash: 'hv', status: 'voided', completed_at: null, pdf_deleted_at: null },
      { id: 'a1', document_hash: 'ha', status: 'active', completed_at: null, pdf_deleted_at: null }, // excluded
    ];
    const signers = [{ envelope_id: 'v1', signing_token: 'tv', status: 'pending', completion_email_delivered_at: null, completion_email_bounced_at: null }];
    const { pool, stamped } = retentionPool(envelopes, signers);
    const deleted: string[] = [];
    const handlers = buildRunHandlers(retentionDeps(pool, { async deletePdf(k) { deleted.push(k); } }, async () => ({ runId: 'r', deduplicated: false })));

    const out = await handlers.retention_sweep({});
    assert.equal(out.scanned, 1); // only the voided one is a candidate
    assert.equal(out.deleted, 1);
    assert.deepEqual(stamped, ['v1']);
    assert.ok(deleted.includes(DOC('hv')) && deleted.includes(COVER('hv', 'tv')));
  });
});

describe('runHandlers — completion_delivery / completion_bounced (F-013 registration)', () => {
  it('dispatches a delivery event and no-ops when nothing matches', async () => {
    const { pool } = retentionPool([], []);
    const handlers = buildRunHandlers(retentionDeps(pool, { async deletePdf() {} }, async () => ({ runId: 'r', deduplicated: false })));
    assert.equal(typeof handlers.completion_delivery, 'function');
    assert.equal(typeof handlers.completion_bounced, 'function');
    const out = await handlers.completion_delivery({ event: { to_address: 'nobody@t.com', message_id: 'x' } });
    assert.equal(out.action, 'no_match');
  });
});
