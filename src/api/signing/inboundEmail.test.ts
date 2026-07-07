/**
 * inboundEmail — F-29.6 email-trigger inbound handlers.
 *
 * Tests the ORCHESTRATION (getRaw → outcome → ack/bounce/completion) with the
 * validation core (`processForward`) injected, so the DKIM fixture rig lives in
 * processForward's own tests. DB reads are answered by a tiny query-matcher pool.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleReplyReceived, handleBounce, readReceiptVerdicts, type InboundEmailCtx } from './inboundEmail.js';
import { RetryableRunError, PermanentRunError, type CreateRunOptions } from '../../functions/runs.js';
import type { DbPool } from '../../db/pool.js';
import type { EmailMessage } from '../../email/types.js';
import type { ForwardOutcome } from './processForward.js';

// A tiny query-matcher pool: first matching SQL-substring wins; default = empty.
function fakePool(answers: Array<{ match: string; rows: unknown[] }> = []): DbPool {
  return {
    async query(text: string) {
      for (const a of answers) if (text.includes(a.match)) return { rows: a.rows, rowCount: a.rows.length } as never;
      return { rows: [], rowCount: 0 } as never;
    },
    async end() {},
  };
}

function recorder() {
  const sent: EmailMessage[] = [];
  const runs: CreateRunOptions[] = [];
  return {
    sent,
    runs,
    emailProvider: { send: async (m: EmailMessage) => { sent.push(m); return { messageId: `m-${sent.length}` }; } } as never,
    createRun: async (o: CreateRunOptions) => { runs.push(o); return { runId: 'r', deduplicated: false }; },
  };
}

// A tokenless raw so the (real) receipt-ack membership check drops without querying.
const RAW = 'From: alice@x.com\r\nSubject: Fwd doc\r\n\r\nbody';

function ctxWith(pool: DbPool, r: ReturnType<typeof recorder>, outcome: ForwardOutcome): InboundEmailCtx {
  return {
    pool,
    emailProvider: r.emailProvider,
    operatorDomain: 'kysigned.com',
    baseUrl: 'https://kysigned.com',
    fetchRawMime: async () => RAW,
    createRun: r.createRun,
    runProcessForward: async () => outcome,
  };
}

const ENV_ROWS = [{ id: 'env-1', sender_email: 'creator@x.com', document_name: 'Doc', auto_close: true, status: 'active' }];
const SIGNER_ROWS = [{ id: 's-1', envelope_id: 'env-1', email: 'alice@x.com', name: 'Alice', status: 'signed' }];
const signedOutcome: ForwardOutcome = { outcome: 'signed', envelopeId: 'env-1', signerEmail: 'alice@x.com', signingDomain: 'x.com', selector: 'sel', verdicts: {} };

describe('inboundEmail — handleReplyReceived (F-29.6)', () => {
  it('signed + all-signed: sends the acceptance ack and enqueues the completion run', async () => {
    const r = recorder();
    const pool = fakePool([
      { match: 'UPDATE envelope_signers SET acceptance_notified_at', rows: [{ id: 's-1' }] }, // claimed
      { match: 'FROM envelopes WHERE id', rows: ENV_ROWS },
      { match: 'ORDER BY name', rows: SIGNER_ROWS },
      { match: 'COUNT(*)', rows: [{ total: '1', signed: '1' }] }, // all signed
    ]);
    const out = await handleReplyReceived(ctxWith(pool, r, signedOutcome), { event: { message_id: 'msg-1' } });
    assert.equal(out.action, 'signed');
    assert.ok(r.sent.some((m) => m.to === 'alice@x.com'), 'acceptance ack to the signer');
    // F-7.4 removed: no "we received your email, reviewing" receipt ack among the sent mail.
    assert.ok(!r.sent.some((m) => /received your email|reviewing your signature/i.test(m.subject ?? '')), 'no receipt ack');
    assert.equal(r.runs.length, 1);
    assert.equal(r.runs[0].eventType, 'completion_distribute');
    // Namespaced (gh-566 layer 2): the bare envelopeId was already claimed by the
    // send-time envelope_expire run, so this create 409'd and completion_distribute
    // was never enqueued.
    assert.equal(r.runs[0].idempotencyKey, 'env-1:completion');
  });

  it('signed but NOT all-signed: acks, no completion run', async () => {
    const r = recorder();
    const pool = fakePool([
      { match: 'UPDATE envelope_signers SET acceptance_notified_at', rows: [{ id: 's-1' }] },
      { match: 'FROM envelopes WHERE id', rows: ENV_ROWS },
      { match: 'ORDER BY name', rows: SIGNER_ROWS },
      { match: 'COUNT(*)', rows: [{ total: '2', signed: '1' }] }, // not all signed
    ]);
    const out = await handleReplyReceived(ctxWith(pool, r, signedOutcome), { event: { message_id: 'msg-1' } });
    assert.equal(out.action, 'signed');
    assert.equal(r.runs.length, 0);
  });

  it('threads the SES receipt verdicts from the reply_received event into processForward (AC-62 / F-6.2a, run402-private #542)', async () => {
    const r = recorder();
    const pool = fakePool([
      { match: 'UPDATE envelope_signers SET acceptance_notified_at', rows: [{ id: 's-1' }] },
      { match: 'FROM envelopes WHERE id', rows: ENV_ROWS },
      { match: 'ORDER BY name', rows: SIGNER_ROWS },
      { match: 'COUNT(*)', rows: [{ total: '2', signed: '1' }] },
    ]);
    let seen: { verdicts?: unknown } | undefined;
    const ctx: InboundEmailCtx = {
      ...ctxWith(pool, r, signedOutcome),
      // Capture the ctx processForward is called with (the seam ctxWith stubs).
      runProcessForward: (async (_raw: string, c: { verdicts?: unknown }) => { seen = c; return signedOutcome; }) as never,
    };
    await handleReplyReceived(ctx, {
      event: {
        message_id: 'msg-1',
        sender_trust: { spf_verdict: 'PASS', dkim_verdict: 'PASS', dmarc_verdict: 'FAIL', spam_verdict: 'PASS' },
      },
    });
    assert.deepEqual(seen?.verdicts, { spf: 'PASS', dkim: 'PASS', dmarc: 'FAIL' });
  });

  it('acceptance ack is exactly-once: a duplicate (marker already set) does not re-send', async () => {
    const r = recorder();
    const pool = fakePool([
      { match: 'UPDATE envelope_signers SET acceptance_notified_at', rows: [] }, // NOT claimed (already acked)
      { match: 'COUNT(*)', rows: [{ total: '1', signed: '1' }] },
    ]);
    const out = await handleReplyReceived(ctxWith(pool, r, { ...signedOutcome, outcome: 'already_signed' } as ForwardOutcome), { event: { message_id: 'msg-1' } });
    assert.equal(out.action, 'already_signed');
    assert.equal(r.sent.length, 0, 'no re-ack');
    assert.equal(r.runs.length, 1, 'completion still re-enqueued (dedup by envelope id)');
  });

  it('rejected: sends the corrective bounce, no completion', async () => {
    const r = recorder();
    const pool = fakePool([
      { match: 'FROM envelopes WHERE id', rows: ENV_ROWS },
      { match: 'ORDER BY name', rows: SIGNER_ROWS },
    ]);
    const rejected: ForwardOutcome = { outcome: 'rejected', code: 'wrong_phrase', reason: 'nope', envelopeId: 'env-1', signerEmail: 'alice@x.com' };
    const out = await handleReplyReceived(ctxWith(pool, r, rejected), { event: { message_id: 'msg-1' } });
    assert.equal(out.action, 'rejected');
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].to, 'alice@x.com');
    assert.equal(r.runs.length, 0);
  });

  it('dropped: silent — no email, no run (AC-16)', async () => {
    const r = recorder();
    const dropped: ForwardOutcome = { outcome: 'dropped', reason: 'not_a_signer', signerEmail: 'mallory@evil.com' };
    const out = await handleReplyReceived(ctxWith(fakePool(), r, dropped), { event: { message_id: 'msg-1' } });
    assert.equal(out.action, 'dropped');
    assert.equal(r.sent.length, 0);
    assert.equal(r.runs.length, 0);
  });

  it('raw not yet available → RetryableRunError (run402 retries)', async () => {
    const r = recorder();
    const ctx: InboundEmailCtx = { ...ctxWith(fakePool(), r, signedOutcome), fetchRawMime: async () => null };
    await assert.rejects(() => handleReplyReceived(ctx, { event: { message_id: 'msg-1' } }), RetryableRunError);
  });

  it('missing message_id → PermanentRunError', async () => {
    const r = recorder();
    await assert.rejects(() => handleReplyReceived(ctxWith(fakePool(), r, signedOutcome), { event: {} }), PermanentRunError);
  });
});

describe('inboundEmail — handleBounce (F-9.8 / F-29.6)', () => {
  it('a permanent bounce processes (marks undeliverable across active envelopes)', async () => {
    const r = recorder();
    const out = await handleBounce({ pool: fakePool(), emailProvider: r.emailProvider, operatorDomain: 'kysigned.com', baseUrl: 'https://kysigned.com', fetchRawMime: async () => null }, { event: { to_address: 'gone@x.com', bounce_type: 'Permanent' } });
    assert.equal(out.action, 'bounced');
    assert.equal(out.marked, 0); // no active envelopes in the fake pool
  });

  it('a transient bounce is ignored (may still deliver on SES retry)', async () => {
    const r = recorder();
    const out = await handleBounce({ pool: fakePool(), emailProvider: r.emailProvider, operatorDomain: 'kysigned.com', baseUrl: 'https://kysigned.com', fetchRawMime: async () => null }, { event: { to_address: 'gone@x.com', bounce_type: 'Transient' } });
    assert.equal(out.action, 'ignored_transient');
  });

  it('missing to_address → PermanentRunError', async () => {
    const r = recorder();
    await assert.rejects(() => handleBounce({ pool: fakePool(), emailProvider: r.emailProvider, operatorDomain: 'kysigned.com', baseUrl: 'https://kysigned.com', fetchRawMime: async () => null }, { event: {} }), PermanentRunError);
  });
});

describe('inboundEmail — readReceiptVerdicts (AC-62 / run402-private #542)', () => {
  it('maps sender_trust snake_case verdicts to ReceiptVerdicts (from event or event.data)', () => {
    assert.deepEqual(
      readReceiptVerdicts({ event: { sender_trust: { spf_verdict: 'PASS', dkim_verdict: 'GRAY', dmarc_verdict: 'FAIL', spam_verdict: 'PASS' } } }),
      { spf: 'PASS', dkim: 'GRAY', dmarc: 'FAIL' },
    );
    assert.deepEqual(
      readReceiptVerdicts({ event: { data: { sender_trust: { spf_verdict: 'FAIL' } } } }),
      { spf: 'FAIL', dkim: null, dmarc: null },
    );
  });

  it('returns empty verdicts when sender_trust is absent (older gateway / bounce event)', () => {
    assert.deepEqual(readReceiptVerdicts({ event: { message_id: 'm' } }), {});
    assert.deepEqual(readReceiptVerdicts({}), {});
  });
});
