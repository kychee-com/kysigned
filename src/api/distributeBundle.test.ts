/**
 * distributeEnvelopeBundle tests — F-9.1 / AC-4 / AC-24 (Phase 10).
 *
 * Offline against a focused in-memory pool + a fake email provider + a stub
 * prepareBundle. Asserts: the bundle is attached to every party with role-scoped
 * bodies (creator dashboard link, signers none); creator==signer is deduped to one
 * email; idempotency (already-distributed no-op, per-signer send guard); and
 * fail-proof partial-then-retry (a failed send leaves it undistributed and never
 * double-sends the succeeded signer).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  distributeEnvelopeBundle,
  type DistributeBundleDeps,
  type PreparedBundle,
} from './distributeBundle.js';
import type { DbPool } from '../db/pool.js';
import type { EmailMessage, EmailProvider } from '../email/types.js';

const ENV = 'e8a1f0c2-0000-4000-8000-000000000001';
const BUNDLE = new Uint8Array(Buffer.from('%PDF-1.7\nbundle\n%%EOF\n'));
const FINGERPRINT = 'a'.repeat(64);

function makePool(seed: {
  senderEmail: string | null;
  signers: Array<{ id: string; email: string; name: string; status?: string; sentMsgId?: string | null }>;
  completedDistributed?: boolean;
}) {
  const envelopes: any[] = [
    {
      id: ENV,
      sender_email: seed.senderEmail,
      document_name: 'Mutual NDA',
      document_hash: 'd'.repeat(64),
      status: 'active',
      completed_at: null,
      completion_distributed_at: seed.completedDistributed ? new Date() : null,
    },
  ];
  const signers: any[] = seed.signers.map((s, i) => ({
    id: s.id,
    envelope_id: ENV,
    email: s.email,
    name: s.name,
    status: s.status ?? 'signed',
    completion_email_provider_msg_id: s.sentMsgId ?? null,
  }));

  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];
      if (text.includes("UPDATE envelopes SET status = 'completed'")) {
        const e = envelopes.find((x) => x.id === v[0]);
        if (e) { e.status = 'completed'; e.completed_at = e.completed_at ?? new Date(1700000000000); }
        return { rows: e ? [{ ...e }] : [], rowCount: e ? 1 : 0 } as any;
      }
      if (text.includes('completion_distributed_at = now()')) {
        const e = envelopes.find((x) => x.id === v[0] && x.completion_distributed_at == null);
        if (e) e.completion_distributed_at = new Date();
        return { rows: e ? [{ id: e.id }] : [], rowCount: e ? 1 : 0 } as any;
      }
      if (text.includes('completion_email_provider_msg_id = $2')) {
        const s = signers.find((x) => x.id === v[0]);
        if (s) s.completion_email_provider_msg_id = v[1];
        return { rows: s ? [{ id: s.id }] : [], rowCount: s ? 1 : 0 } as any;
      }
      if (text.includes('SELECT * FROM envelopes WHERE id')) {
        const e = envelopes.find((x) => x.id === v[0]);
        return { rows: e ? [{ ...e }] : [], rowCount: e ? 1 : 0 } as any;
      }
      if (text.includes('FROM envelope_signers WHERE envelope_id')) {
        const out = signers.filter((s) => s.envelope_id === v[0]).map((s) => ({ ...s }));
        return { rows: out, rowCount: out.length } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };
  return { pool, envelopes, signers };
}

function fakeEmail(failFor?: string) {
  const sent: EmailMessage[] = [];
  const provider: EmailProvider = {
    async send(m) {
      if (failFor && m.to === failFor) throw new Error('SES throttled');
      sent.push(m);
      return { messageId: `msg-${sent.length}` };
    },
  };
  return { provider, sent };
}

function deps(over: Partial<DistributeBundleDeps> = {}): DistributeBundleDeps {
  return {
    emailProvider: over.emailProvider ?? fakeEmail().provider,
    operatorDomain: 'kysigned.com',
    verifierBaseUrl: 'https://kysigned.com',
    dashboardBaseUrl: 'https://kysigned.com',
    prepareBundle:
      over.prepareBundle ?? (async (): Promise<PreparedBundle> => ({ bytes: BUNDLE, fingerprint: FINGERPRINT })),
    ...(over.createRun ? { createRun: over.createRun } : {}),
    ...(over.emitAppEvent ? { emitAppEvent: over.emitAppEvent } : {}),
  };
}

describe('distributeEnvelopeBundle — F-9.1 / AC-4 / AC-24', () => {
  it('emails the bundle to every party, role-scoped, and marks distributed', async () => {
    const { pool, envelopes } = makePool({
      senderEmail: 'carol@acme.com',
      signers: [
        { id: 's1', email: 'alice@x.com', name: 'Alice' },
        { id: 's2', email: 'bob@y.com', name: 'Bob' },
      ],
    });
    const { provider, sent } = fakeEmail();
    const r = await distributeEnvelopeBundle(pool, ENV, deps({ emailProvider: provider }));

    assert.equal(r.action, 'distributed');
    assert.equal(r.recipients, 3); // 2 signers + creator
    assert.equal(sent.length, 3);
    // Every email carries the bundle as an attachment (AC-4).
    for (const m of sent) {
      assert.equal(m.attachments?.length, 1);
      assert.match(m.attachments![0].filename, /evidence-bundle\.pdf$/);
      assert.deepEqual(m.attachments![0].content, BUNDLE);
      assert.equal(m.from, 'notifications@kysigned.com');
    }
    // Role-scoped (AC-24): only the creator's email has a dashboard link.
    const creator = sent.find((m) => m.to === 'carol@acme.com')!;
    const signee = sent.find((m) => m.to === 'alice@x.com')!;
    assert.match(creator.html, /\/dashboard\/envelope\//);
    assert.ok(!/\/dashboard\//.test(signee.html), 'signer gets no dashboard link');
    // Completion stamped.
    assert.ok(envelopes[0].completion_distributed_at);
    assert.equal(envelopes[0].status, 'completed');
  });

  it('F-013: schedules the completion_retention run when distribution completes', async () => {
    const { pool } = makePool({
      senderEmail: 'carol@acme.com',
      signers: [{ id: 's1', email: 'alice@x.com', name: 'Alice' }],
    });
    const scheduled: any[] = [];
    const r = await distributeEnvelopeBundle(pool, ENV, deps({
      createRun: async (o) => { scheduled.push(o); return { runId: 'r', deduplicated: false }; },
    }));
    assert.equal(r.action, 'distributed');
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].eventType, 'completion_retention');
    assert.equal(scheduled[0].idempotencyKey, `${ENV}:retention:1`);
    assert.equal(scheduled[0].payload.envelopeId, ENV);
  });

  it('F-30.3: schedules the webhook_deliver run on distribution when a webhook row exists', async () => {
    const { pool } = makePool({
      senderEmail: 'carol@acme.com',
      signers: [{ id: 's1', email: 'alice@x.com', name: 'Alice' }],
    });
    // Wrap the pool so the envelope_webhooks lookup finds a row.
    const wrapped: typeof pool = {
      async query(text: string, values?: unknown[]) {
        if (/FROM envelope_webhooks/i.test(text)) {
          return {
            rows: [{ envelope_id: ENV, url: 'https://agent.example.com/h', secret: 'whs_x', created_at: new Date().toISOString() }],
            rowCount: 1,
          } as never;
        }
        return pool.query(text, values);
      },
      async end() {},
    };
    const scheduled: any[] = [];
    const r = await distributeEnvelopeBundle(wrapped, ENV, deps({
      createRun: async (o) => { scheduled.push(o); return { runId: 'r', deduplicated: false }; },
    }));
    assert.equal(r.action, 'distributed');
    const hook = scheduled.find((o) => o.eventType === 'webhook_deliver');
    assert.ok(hook, 'webhook_deliver run scheduled alongside retention');
    assert.equal(hook.idempotencyKey, `webhook-completed:${ENV}`);
    assert.deepEqual(hook.payload, { envelopeId: ENV });
  });

  it('F-013: does NOT schedule retention on a partial (undistributed) send', async () => {
    const { pool } = makePool({
      senderEmail: 'carol@acme.com',
      signers: [{ id: 's1', email: 'alice@x.com', name: 'Alice' }],
    });
    const scheduled: any[] = [];
    const { provider } = fakeEmail('carol@acme.com'); // the creator send throws → partial
    const r = await distributeEnvelopeBundle(pool, ENV, deps({
      emailProvider: provider,
      createRun: async (o) => { scheduled.push(o); return { runId: 'r', deduplicated: false }; },
    }));
    assert.equal(r.action, 'partial');
    assert.equal(scheduled.length, 0, 'retention scheduled only on full distribution');
  });

  it('dedups creator==signer to ONE email (creator variant) — AC-24', async () => {
    const { pool } = makePool({
      senderEmail: 'alice@x.com', // creator is also signer s1
      signers: [
        { id: 's1', email: 'alice@x.com', name: 'Alice' },
        { id: 's2', email: 'bob@y.com', name: 'Bob' },
      ],
    });
    const { provider, sent } = fakeEmail();
    const r = await distributeEnvelopeBundle(pool, ENV, deps({ emailProvider: provider }));

    assert.equal(r.recipients, 2); // not 3 — creator merged with signer
    assert.equal(sent.length, 2);
    const alice = sent.find((m) => m.to === 'alice@x.com')!;
    assert.match(alice.html, /\/dashboard\/envelope\//, 'creator==signer gets the creator variant');
  });

  it('is idempotent: already-distributed envelope is a no-op', async () => {
    const { pool } = makePool({
      senderEmail: 'carol@acme.com',
      signers: [{ id: 's1', email: 'alice@x.com', name: 'Alice' }],
      completedDistributed: true,
    });
    const { provider, sent } = fakeEmail();
    const r = await distributeEnvelopeBundle(pool, ENV, deps({ emailProvider: provider }));
    assert.equal(r.action, 'already_distributed');
    assert.equal(sent.length, 0);
  });

  it('is not_ready when a signer has not signed', async () => {
    const { pool } = makePool({
      senderEmail: 'carol@acme.com',
      signers: [
        { id: 's1', email: 'alice@x.com', name: 'Alice', status: 'signed' },
        { id: 's2', email: 'bob@y.com', name: 'Bob', status: 'pending' },
      ],
    });
    const r = await distributeEnvelopeBundle(pool, ENV, deps());
    assert.equal(r.action, 'not_ready');
  });

  it('defers (no distribution mark) when the bundle inputs are not ready', async () => {
    const { pool, envelopes } = makePool({
      senderEmail: 'carol@acme.com',
      signers: [{ id: 's1', email: 'alice@x.com', name: 'Alice' }],
    });
    const r = await distributeEnvelopeBundle(pool, ENV, deps({ prepareBundle: async () => null }));
    assert.equal(r.action, 'deferred');
    assert.equal(envelopes[0].completion_distributed_at, null); // retried by the backstop
  });

  it('fail-proof: a failed send → partial, then a retry resends only the failed party (no double-send)', async () => {
    const { pool, signers, envelopes } = makePool({
      senderEmail: 'carol@acme.com',
      signers: [
        { id: 's1', email: 'alice@x.com', name: 'Alice' },
        { id: 's2', email: 'bob@y.com', name: 'Bob' },
      ],
    });
    // First pass: bob's send fails.
    const fail = fakeEmail('bob@y.com');
    const r1 = await distributeEnvelopeBundle(pool, ENV, deps({ emailProvider: fail.provider }));
    assert.equal(r1.action, 'partial');
    assert.equal(envelopes[0].completion_distributed_at, null);
    // alice (signer) recorded a msg id; bob did not.
    assert.ok(signers.find((s) => s.id === 's1').completion_email_provider_msg_id);
    assert.equal(signers.find((s) => s.id === 's2').completion_email_provider_msg_id, null);

    // Retry with a working provider: alice is skipped (already sent), bob + creator sent.
    const ok = fakeEmail();
    const r2 = await distributeEnvelopeBundle(pool, ENV, deps({ emailProvider: ok.provider }));
    assert.equal(r2.action, 'distributed');
    assert.ok(!ok.sent.some((m) => m.to === 'alice@x.com'), 'no double-send to the already-emailed signer');
    assert.ok(ok.sent.some((m) => m.to === 'bob@y.com'), 'failed signer re-sent');
    assert.ok(envelopes[0].completion_distributed_at);
  });
});

describe('distributeBundle — F-36 app events (60.3)', () => {
  it('deferred run emits nothing; full distribution emits envelope_completed; a re-run carries the SAME event identity', async () => {
    const events: Array<{ type: string; ids: readonly string[]; payload: Record<string, unknown> }> = [];
    const emitAppEvent = (async (type: string, ids: readonly string[], payload: Record<string, unknown>) => {
      events.push({ type, ids, payload });
    }) as never;

    const { pool } = makePool({
      senderEmail: 'carol@acme.com',
      signers: [
        { id: 's1', email: 'alice@x.com', name: 'Alice' },
        { id: 's2', email: 'bob@y.com', name: 'Bob' },
      ],
    });

    // Bundle not ready → deferred: no event.
    const r0 = await distributeEnvelopeBundle(pool, ENV, deps({ emitAppEvent, prepareBundle: async () => null }));
    assert.notEqual(r0.action, 'distributed');
    assert.equal(events.length, 0, 'no emit before distribution succeeds');

    // Full distribution → exactly one envelope_completed, ids-only payload + count.
    const r1 = await distributeEnvelopeBundle(pool, ENV, deps({ emitAppEvent }));
    assert.equal(r1.action, 'distributed');
    assert.deepEqual(events, [
      { type: 'envelope_completed', ids: [ENV], payload: { envelope_id: ENV, recipients: 3 } },
    ]);

    // Idempotent re-run: any duplicate call carries the IDENTICAL (type, ids)
    // → the same idempotency key → the gateway's forever-dedup stores one event.
    await distributeEnvelopeBundle(pool, ENV, deps({ emitAppEvent }));
    for (const e of events.slice(1)) {
      assert.deepEqual({ type: e.type, ids: e.ids }, { type: events[0].type, ids: events[0].ids });
    }
  });
});
