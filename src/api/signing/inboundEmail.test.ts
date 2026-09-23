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
import { emitAppEvent } from '../../integrations/appEvents.js';
import { createInternalSubjectGate } from '../../integrations/internalSubject.js';
import { RetryableRunError, PermanentRunError, type CreateRunOptions } from '../../functions/runs.js';
import type { DbPool } from '../../db/pool.js';
import type { EmailMessage } from '../../email/types.js';
import type { ForwardOutcome } from './processForward.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInboundRepliesMemoryPool } from '../../db/inboundReplies.testpool.js';
import type { DkimResolver } from './dkimVerify.js';

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

// F-45 (spec 0.72.0) — a rejected forward picks the provider bounce when diagnosed,
// records the signer's latest problem, and tells the creator once per kind of problem.
describe('inboundEmail — rejection visibility (F-45.2 / F-45.3 / F-45.5)', () => {
  type Q = { text: string; values: unknown[] };
  function recordingPool(answers: Array<{ match: string; rows?: unknown[]; throws?: boolean }>) {
    const queries: Q[] = [];
    const pool: DbPool = {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values: values ?? [] });
        for (const a of answers) {
          if (!text.includes(a.match)) continue;
          if (a.throws) throw new Error('db down');
          return { rows: a.rows ?? [], rowCount: (a.rows ?? []).length } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };
    return { pool, queries };
  }
  const PENDING = [{ id: 's-1', envelope_id: 'env-1', email: 'alice@x.com', name: 'Alice', status: 'pending' }];
  const RECORD = 'SET last_rejection_class';
  const CLAIM = 'array_append(rejection_notice_classes';
  const baseAnswers = (claimed: boolean) => [
    { match: 'FROM envelopes WHERE id', rows: ENV_ROWS },
    { match: 'ORDER BY name', rows: PENDING },
    { match: RECORD, rows: [{ id: 's-1' }] },
    { match: CLAIM, rows: claimed ? [{ id: 's-1' }] : [] },
  ];
  const rejectedWith = (extra: Partial<Extract<ForwardOutcome, { outcome: 'rejected' }>>): ForwardOutcome => ({
    outcome: 'rejected', code: 'misaligned', reason: 'x', envelopeId: 'env-1', signerEmail: 'alice@x.com', ...extra,
  });
  const classOf = (qs: Q[], match: string) => qs.filter((q) => q.text.includes(match)).map((q) => q.values[2]);

  it('Google Workspace diagnosis → provider bounce to the signer + provider notice to the creator (AC-271/272/273)', async () => {
    const r = recorder();
    const { pool, queries } = recordingPool(baseAnswers(true));
    const out = await handleReplyReceived(ctxWith(pool, r, rejectedWith({ providerNoDkim: 'google_workspace' })), { event: { message_id: 'msg-1' } });
    assert.equal(out.action, 'rejected');
    assert.equal(r.sent.length, 2);
    assert.equal(r.sent[0].to, 'alice@x.com');
    assert.match(r.sent[0].html ?? '', /Google Workspace/);
    assert.match(r.sent[0].html ?? '', /faq#email-setup-google/);
    assert.match(r.sent[0].html ?? '', /creator@x\.com/, 'the sign-sooner line names the sender');
    assert.equal(r.sent[1].to, 'creator@x.com');
    assert.match(r.sent[1].subject ?? '', /Alice can.t sign "Doc" until their email is set up/);
    assert.match(r.sent[1].html ?? '', /dashboard\/envelope\/env-1/);
    assert.deepEqual(classOf(queries, RECORD), ['google_workspace_no_dkim']);
    assert.deepEqual(classOf(queries, CLAIM), ['google_workspace_no_dkim']);
  });

  it('Microsoft 365 diagnosis → the Microsoft versions (AC-278)', async () => {
    const r = recorder();
    const { pool, queries } = recordingPool(baseAnswers(true));
    await handleReplyReceived(ctxWith(pool, r, rejectedWith({ providerNoDkim: 'microsoft_365' })), { event: { message_id: 'msg-1' } });
    assert.match(r.sent[0].html ?? '', /Microsoft 365/);
    assert.match(r.sent[0].html ?? '', /faq#email-setup-microsoft/);
    assert.match(r.sent[1].html ?? '', /Microsoft Defender portal/);
    assert.deepEqual(classOf(queries, RECORD), ['microsoft_365_no_dkim']);
  });

  it('a misaligned forward WITHOUT a diagnosis keeps the generic bounce, and the creator gets the general notice', async () => {
    const r = recorder();
    const { pool, queries } = recordingPool(baseAnswers(true));
    await handleReplyReceived(ctxWith(pool, r, rejectedWith({})), { event: { message_id: 'msg-1' } });
    assert.match(r.sent[0].html ?? '', /verify your email/i);
    assert.doesNotMatch(r.sent[0].html ?? '', /Google Workspace|Microsoft 365/);
    assert.match(r.sent[1].subject ?? '', /Alice.s signature on "Doc" wasn.t accepted/);
    assert.deepEqual(classOf(queries, RECORD), ['dkim_unverifiable']);
  });

  it('wrong_phrase → generic bounce + general creator notice with its reason line (AC-277)', async () => {
    const r = recorder();
    const { pool, queries } = recordingPool(baseAnswers(true));
    await handleReplyReceived(ctxWith(pool, r, rejectedWith({ code: 'wrong_phrase' })), { event: { message_id: 'msg-1' } });
    assert.match(r.sent[0].html ?? '', /Your forward needs the exact signing line/);
    assert.equal(r.sent[1].to, 'creator@x.com');
    assert.match(r.sent[1].html ?? '', /first line of their forward/);
    assert.deepEqual(classOf(queries, CLAIM), ['wrong_phrase']);
  });

  it('the same problem again (claim not granted) → only the signer bounce, no second creator notice', async () => {
    const r = recorder();
    const { pool } = recordingPool(baseAnswers(false));
    await handleReplyReceived(ctxWith(pool, r, rejectedWith({ providerNoDkim: 'google_workspace' })), { event: { message_id: 'msg-2' } });
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].to, 'alice@x.com');
  });

  it('the signer IS the creator → no creator notice and no claim', async () => {
    const r = recorder();
    const { pool, queries } = recordingPool([
      { match: 'FROM envelopes WHERE id', rows: [{ ...ENV_ROWS[0], sender_email: 'alice@x.com' }] },
      { match: 'ORDER BY name', rows: PENDING },
      { match: RECORD, rows: [{ id: 's-1' }] },
      { match: CLAIM, rows: [{ id: 's-1' }] },
    ]);
    await handleReplyReceived(ctxWith(pool, r, rejectedWith({ code: 'wrong_phrase' })), { event: { message_id: 'msg-1' } });
    assert.equal(r.sent.length, 1);
    assert.deepEqual(classOf(queries, CLAIM), []);
    assert.deepEqual(classOf(queries, RECORD), ['wrong_phrase'], 'the dashboard still shows it');
  });

  it('envelope_inactive → the terminal note only: no state write, no creator notice', async () => {
    const r = recorder();
    const { pool, queries } = recordingPool(baseAnswers(true));
    await handleReplyReceived(ctxWith(pool, r, rejectedWith({ code: 'envelope_inactive' })), { event: { message_id: 'msg-1' } });
    assert.equal(r.sent.length, 1);
    assert.match(r.sent[0].html ?? '', /no longer active/);
    assert.deepEqual(classOf(queries, RECORD), []);
    assert.deepEqual(classOf(queries, CLAIM), []);
  });

  it('never sends the creator a progress email for a rejection (AC-54)', async () => {
    const r = recorder();
    const { pool } = recordingPool(baseAnswers(true));
    await handleReplyReceived(ctxWith(pool, r, rejectedWith({ code: 'attachment_missing' })), { event: { message_id: 'msg-1' } });
    assert.ok(!r.sent.some((m) => /complete|signed "Doc"/i.test(m.subject ?? '')), 'no progress email');
  });

  it('a failing creator send or state write never fails the run (best-effort)', async () => {
    const r = recorder();
    const flaky = { send: async (m: EmailMessage) => { if (m.to === 'creator@x.com') throw new Error('smtp down'); r.sent.push(m); return { messageId: 'm' }; } };
    const { pool } = recordingPool(baseAnswers(true));
    const out = await handleReplyReceived({ ...ctxWith(pool, r, rejectedWith({ code: 'wrong_phrase' })), emailProvider: flaky as never }, { event: { message_id: 'msg-1' } });
    assert.equal(out.action, 'rejected');
    const broken = recordingPool([{ match: 'FROM envelopes WHERE id', rows: ENV_ROWS }, { match: 'ORDER BY name', rows: PENDING }, { match: RECORD, throws: true }]);
    const out2 = await handleReplyReceived(ctxWith(broken.pool, recorder(), rejectedWith({ code: 'wrong_phrase' })), { event: { message_id: 'msg-2' } });
    assert.equal(out2.action, 'rejected');
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

describe('inboundEmail — F-36 app events (60.3)', () => {
  function eventsRecorder() {
    const events: Array<{ type: string; ids: readonly string[]; payload: Record<string, unknown> }> = [];
    return {
      events,
      emitAppEvent: async (type: string, ids: readonly string[], payload: Record<string, unknown>) => {
        events.push({ type, ids, payload });
      },
    };
  }

  it('signed: emits exactly one signature_completed keyed (envelope, message) — ids only', async () => {
    const r = recorder();
    const e = eventsRecorder();
    const pool = fakePool([
      { match: 'UPDATE envelope_signers SET acceptance_notified_at', rows: [{ id: 's-1' }] },
      { match: 'FROM envelopes WHERE id', rows: ENV_ROWS },
      { match: 'ORDER BY name', rows: SIGNER_ROWS },
      { match: 'COUNT(*)', rows: [{ total: '2', signed: '1' }] },
    ]);
    const ctx: InboundEmailCtx = { ...ctxWith(pool, r, signedOutcome), emitAppEvent: e.emitAppEvent as never };
    await handleReplyReceived(ctx, { event: { message_id: 'msg-1' } });
    assert.deepEqual(e.events, [
      {
        type: 'signature_completed',
        ids: ['env-1', 'msg-1'],
        payload: { envelope_id: 'env-1', message_id: 'msg-1' },
      },
    ]);
  });

  it('a run retry landing on already_signed emits nothing (AC-194 — no double-emit)', async () => {
    const r = recorder();
    const e = eventsRecorder();
    const pool = fakePool([
      { match: 'UPDATE envelope_signers SET acceptance_notified_at', rows: [] },
      { match: 'COUNT(*)', rows: [{ total: '2', signed: '1' }] },
    ]);
    const ctx: InboundEmailCtx = {
      ...ctxWith(pool, r, { outcome: 'already_signed', envelopeId: 'env-1', signerEmail: 'alice@x.com' }),
      emitAppEvent: e.emitAppEvent as never,
    };
    await handleReplyReceived(ctx, { event: { message_id: 'msg-1' } });
    assert.equal(e.events.length, 0);
  });

  it('rejected: emits exactly one signer_declined carrying the rejection-code enum — no addresses', async () => {
    const r = recorder();
    const e = eventsRecorder();
    const rejected: ForwardOutcome = {
      outcome: 'rejected',
      code: 'wrong_phrase',
      reason: 'intent line mismatch',
      envelopeId: 'env-1',
      signerEmail: 'alice@x.com',
    };
    const ctx: InboundEmailCtx = { ...ctxWith(fakePool(), r, rejected), emitAppEvent: e.emitAppEvent as never };
    await handleReplyReceived(ctx, { event: { message_id: 'msg-2' } });
    assert.deepEqual(e.events, [
      {
        type: 'signer_declined',
        ids: ['env-1', 'msg-2'],
        payload: { envelope_id: 'env-1', message_id: 'msg-2', code: 'wrong_phrase' },
      },
    ]);
  });

  it('F-36/AC-196: signing completes when the events surface fails (real seam, throwing runtime emitter)', async () => {
    const r = recorder();
    const logs: string[] = [];
    const failingSeam = ((type: never, ids: readonly string[], payload: never) =>
      emitAppEvent(
        {
          emitRuntimeEvent: async () => {
            throw Object.assign(new Error('gateway 500'), { status: 500 });
          },
          log: (m: string) => void logs.push(m),
        },
        type,
        ids,
        payload,
      )) as never;
    const pool = fakePool([
      { match: 'UPDATE envelope_signers SET acceptance_notified_at', rows: [{ id: 's-1' }] },
      { match: 'FROM envelopes WHERE id', rows: ENV_ROWS },
      { match: 'ORDER BY name', rows: SIGNER_ROWS },
      { match: 'COUNT(*)', rows: [{ total: '2', signed: '1' }] },
    ]);
    const ctx: InboundEmailCtx = { ...ctxWith(pool, r, signedOutcome), emitAppEvent: failingSeam };
    const out = await handleReplyReceived(ctx, { event: { message_id: 'msg-1' } });
    assert.equal(out.action, 'signed', 'the transition is never gated by an emit failure');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /signature_completed/);
    assert.match(logs[0], /500/);
  });

  // ── F-36.6 / AC-211 — internal-envelope suppression (66.3). The gate's ONE
  // SELECT is answered by a specific matcher placed before the generic
  // envelope read (first match wins in the fake pool).
  const INTERNAL_ENV_MATCH = {
    match: 'SELECT internal_test, sender_email FROM envelopes',
    rows: [{ internal_test: false, sender_email: 'redteam-pilot@kysigned.com' }],
  };

  function internalGateWith(lines: string[], pool: DbPool) {
    return createInternalSubjectGate({
      pool,
      internalIdentities: ['redteam-*@kysigned.com'],
      log: (m: string) => void lines.push(m),
    });
  }

  it('F-36.6/AC-211: a signature on an INTERNAL envelope acks + completes but emits nothing', async () => {
    const r = recorder();
    const e = eventsRecorder();
    const lines: string[] = [];
    const pool = fakePool([
      { match: 'UPDATE envelope_signers SET acceptance_notified_at', rows: [{ id: 's-1' }] },
      INTERNAL_ENV_MATCH,
      { match: 'FROM envelopes WHERE id', rows: ENV_ROWS },
      { match: 'ORDER BY name', rows: SIGNER_ROWS },
      { match: 'COUNT(*)', rows: [{ total: '2', signed: '1' }] },
    ]);
    const ctx: InboundEmailCtx = {
      ...ctxWith(pool, r, signedOutcome),
      emitAppEvent: e.emitAppEvent as never,
      internalGate: internalGateWith(lines, pool),
    };
    const out = await handleReplyReceived(ctx, { event: { message_id: 'msg-1' } });
    assert.equal(out.action, 'signed', 'suppression changes emission ONLY — the ack/record path is untouched');
    assert.ok(r.sent.some((m) => m.to === 'alice@x.com'), 'acceptance ack still sent');
    assert.equal(e.events.length, 0, 'internal envelope emits nothing');
    assert.deepEqual(lines, ['app-event signature_completed [env-1:msg-1] suppressed: internal identity']);
  });

  it('F-36.6/AC-211: a decline on an INTERNAL envelope still sends the corrective bounce but emits nothing', async () => {
    const r = recorder();
    const e = eventsRecorder();
    const lines: string[] = [];
    const rejected: ForwardOutcome = {
      outcome: 'rejected',
      code: 'wrong_phrase',
      reason: 'intent line mismatch',
      envelopeId: 'env-1',
      signerEmail: 'alice@x.com',
    };
    const pool = fakePool([INTERNAL_ENV_MATCH, { match: 'FROM envelopes WHERE id', rows: ENV_ROWS }]);
    const ctx: InboundEmailCtx = {
      ...ctxWith(pool, r, rejected),
      emitAppEvent: e.emitAppEvent as never,
      internalGate: internalGateWith(lines, pool),
    };
    const out = await handleReplyReceived(ctx, { event: { message_id: 'msg-2' } });
    assert.equal(out.action, 'rejected');
    assert.equal(r.sent.length, 1, 'corrective bounce still sent');
    assert.equal(e.events.length, 0, 'internal envelope emits nothing');
    assert.deepEqual(lines, ['app-event signer_declined [env-1:msg-2] suppressed: internal identity']);
  });

  it('F-36.6/AC-213: a THROWING classification lookup fails OPEN — the transition completes AND the event emits', async () => {
    const r = recorder();
    const e = eventsRecorder();
    const lines: string[] = [];
    // The gate shares the handler pool in prod, so fault-inject ONLY the
    // classification SELECT; every other query answers normally.
    const base = fakePool([
      { match: 'UPDATE envelope_signers SET acceptance_notified_at', rows: [{ id: 's-1' }] },
      { match: 'FROM envelopes WHERE id', rows: ENV_ROWS },
      { match: 'ORDER BY name', rows: SIGNER_ROWS },
      { match: 'COUNT(*)', rows: [{ total: '2', signed: '1' }] },
    ]);
    const pool: DbPool = {
      query: (text: string, v?: unknown[]) =>
        text.includes('SELECT internal_test, sender_email')
          ? Promise.reject(new Error('db blip'))
          : base.query(text, v),
      end: async () => {},
    };
    const ctx: InboundEmailCtx = {
      ...ctxWith(pool, r, signedOutcome),
      emitAppEvent: e.emitAppEvent as never,
      internalGate: createInternalSubjectGate({
        pool,
        internalIdentities: ['redteam-*@kysigned.com'],
        log: (m: string) => void lines.push(m),
      }),
    };
    const out = await handleReplyReceived(ctx, { event: { message_id: 'msg-1' } });
    assert.equal(out.action, 'signed', 'a classification failure never gates the transition');
    assert.equal(e.events.length, 1, 'fail-open: the event EMITS when classification is unavailable');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /internal-classification failed/);
    assert.match(lines[0]!, /db blip/);
  });
});

/**
 * End to end on the GENERATED corporate Microsoft 365 forward (spec 0.73.1, AC-279): the
 * REAL processForward (no outcome stub) over one in-memory database, with the handler's
 * own `dkimResolver` serving the mock's stand-in seal key. See `fixtures/README.md`.
 */
describe('inboundEmail — the GENERATED Microsoft 365 corporate forward, end to end (F-45.1, spec 0.73.1, AC-279)', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const MOCK_EML = readFileSync(join(FIXTURES, 'm365-corporate-no-dkim.GENERATED.eml'), 'utf8');
  const MOCK = JSON.parse(readFileSync(join(FIXTURES, 'm365-corporate-no-dkim.GENERATED.json'), 'utf8')) as {
    envelope: { id: string; documentName: string; creator: { email: string } };
    signer: { name: string; email: string; domain: string };
    attachment: { sha256: string };
    standInKeys: Record<string, string>;
  };

  it("a generated Microsoft 365 corporate forward runs end to end: Microsoft bounce + the creator's Microsoft notice (AC-279)", async () => {
    const db = createInboundRepliesMemoryPool();
    db.envelopes.push({
      id: MOCK.envelope.id,
      status: 'active',
      sender_email: MOCK.envelope.creator.email,
      document_name: MOCK.envelope.documentName,
      document_hash: MOCK.attachment.sha256,
      auto_close: true,
    });
    db.signers.push({
      id: 's-mock',
      envelope_id: MOCK.envelope.id,
      email: MOCK.signer.email,
      name: MOCK.signer.name,
      status: 'pending',
      sent_pdf_hash: MOCK.attachment.sha256,
      rejection_notice_classes: [],
    });
    // The in-memory pool models every statement on this path except the envelope's
    // signer list, which the notices read for the signer's name.
    const pool: DbPool = {
      query: async (text: string, v?: unknown[]) => {
        if (text.includes('FROM envelope_signers WHERE envelope_id = $1 ORDER BY name')) {
          const rows = db.signers.filter((s) => s.envelope_id === v?.[0]).map((s) => ({ ...s }));
          return { rows, rowCount: rows.length } as never;
        }
        return db.pool.query(text, v);
      },
      end: async () => {},
    };
    const standIn: DkimResolver = async (name, rrtype) => {
      const txt = MOCK.standInKeys[String(name)];
      if (String(rrtype).toLowerCase() === 'txt' && txt) return [[txt]];
      const e = new Error('ENOTFOUND') as Error & { code?: string };
      e.code = 'ENOTFOUND';
      throw e;
    };
    const r = recorder();
    const ctx: InboundEmailCtx = {
      pool,
      emailProvider: r.emailProvider,
      operatorDomain: 'kysigned.com',
      baseUrl: 'https://kysigned.com',
      fetchRawMime: async () => MOCK_EML,
      createRun: r.createRun,
      dkimResolver: standIn,
    };

    const out = await handleReplyReceived(ctx, { event: { message_id: 'msg-m365-mock' } });

    assert.equal(out.action, 'rejected');
    assert.equal(out.rejectionClass, 'microsoft_365_no_dkim');
    assert.equal(r.sent.length, 2, 'the signer bounce and one creator notice');
    const [bounce, notice] = r.sent;
    assert.equal(bounce.to, MOCK.signer.email);
    assert.match(bounce.html ?? '', /Microsoft 365/);
    assert.match(bounce.html ?? '', new RegExp(MOCK.signer.domain.replaceAll('.', '\\.')), 'names the signer domain');
    assert.match(bounce.html ?? '', /faq#email-setup-microsoft/);
    assert.equal(notice.to, MOCK.envelope.creator.email);
    assert.match(notice.subject ?? '', /Dana Cohen can.t sign "Mock Services Agreement \(GENERATED TEST\)" until their email is set up/);
    assert.match(notice.html ?? '', /Microsoft Defender portal/);
    assert.equal(db.signers[0].status, 'pending', 'nothing is recorded signed');
    assert.equal(db.signers[0].last_rejection_class, 'microsoft_365_no_dkim', 'the dashboard and API see the problem');
    assert.deepEqual(db.signers[0].rejection_notice_classes, ['microsoft_365_no_dkim'], 'the creator is told once');
    assert.equal(r.runs.length, 0, 'no completion run');
  });
});
