/**
 * Email delivery webhook handler tests — F8.6.
 *
 * The handlers are pure & provider-agnostic: the deploying service translates
 * SES (or whatever provider) webhook payloads into:
 *   markCompletionEmailDelivered(envelope_id, recipient_email)
 *   markCompletionEmailBounced(envelope_id, recipient_email)
 *
 * They are matched by (envelope_id, lowercased recipient email) to the
 * envelope_signers row.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  markCompletionEmailDelivered,
  markCompletionEmailBounced,
  readCompletionEmailEvent,
  resolveCompletionSigner,
  handleCompletionDelivered,
  handleCompletionBounced,
} from './emailWebhook.js';
import type { DbPool } from '../db/pool.js';

function createMockPool() {
  const signers: any[] = [
    {
      id: 's-1', envelope_id: 'env-1', email: 'alice@test.com',
      completion_email_delivered_at: null, completion_email_bounced_at: null,
    },
    {
      id: 's-2', envelope_id: 'env-1', email: 'bob@test.com',
      completion_email_delivered_at: null, completion_email_bounced_at: null,
    },
  ];

  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];
      if (text.includes('UPDATE envelope_signers') && text.includes('completion_email_delivered_at')) {
        const s = signers.find((x) => x.envelope_id === v[0] && x.email === v[1]);
        if (s) {
          s.completion_email_delivered_at = v[2];
          return { rows: [s], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      }
      if (text.includes('UPDATE envelope_signers') && text.includes('completion_email_bounced_at')) {
        const s = signers.find((x) => x.envelope_id === v[0] && x.email === v[1]);
        if (s) {
          s.completion_email_bounced_at = v[2];
          return { rows: [s], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };
  return { pool, signers };
}

describe('Email completion-webhook handlers — F8.6', () => {
  describe('markCompletionEmailDelivered', () => {
    it('marks the matching signer delivered', async () => {
      const { pool, signers } = createMockPool();
      const at = new Date('2026-04-15T10:00:00Z');
      const ok = await markCompletionEmailDelivered(pool, 'env-1', 'alice@test.com', at);
      assert.equal(ok, true);
      assert.equal(signers[0].completion_email_delivered_at, at);
      assert.equal(signers[1].completion_email_delivered_at, null);
    });

    it('matches case-insensitively on email', async () => {
      const { pool, signers } = createMockPool();
      const at = new Date();
      const ok = await markCompletionEmailDelivered(pool, 'env-1', 'ALICE@Test.com', at);
      assert.equal(ok, true);
      assert.ok(signers[0].completion_email_delivered_at);
    });

    it('returns false when no signer matches', async () => {
      const { pool } = createMockPool();
      const ok = await markCompletionEmailDelivered(pool, 'env-1', 'unknown@test.com', new Date());
      assert.equal(ok, false);
    });
  });

  describe('markCompletionEmailBounced', () => {
    it('marks the matching signer bounced', async () => {
      const { pool, signers } = createMockPool();
      const at = new Date('2026-04-15T10:00:00Z');
      const ok = await markCompletionEmailBounced(pool, 'env-1', 'bob@test.com', at);
      assert.equal(ok, true);
      assert.equal(signers[1].completion_email_bounced_at, at);
    });

    it('returns false when no signer matches', async () => {
      const { pool } = createMockPool();
      const ok = await markCompletionEmailBounced(pool, 'env-1', 'unknown@test.com', new Date());
      assert.equal(ok, false);
    });
  });
});

// ── F-9.3 / F-013 — the LIVE outbound-event route (completion delivery/bounce) ──

/** A mock pool modelling the resolveCompletionSigner JOIN + the two UPDATE writes,
 *  over an in-memory (envelopes × signers) set. */
function createEventPool(
  envelopes: any[], // { id, status, completed_at }
  signers: any[],   // { envelope_id, email, completion_email_provider_msg_id, completion_email_delivered_at, completion_email_bounced_at }
) {
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];
      // resolveCompletionSigner
      if (text.includes('FROM envelope_signers es') && text.includes('JOIN envelopes e')) {
        const [msgId, to] = v as [string, string];
        const eligible = signers.filter((s) => {
          const e = envelopes.find((x) => x.id === s.envelope_id);
          return e && e.status === 'completed'
            && s.completion_email_provider_msg_id != null
            && s.completion_email_delivered_at == null
            && s.completion_email_bounced_at == null
            && (s.completion_email_provider_msg_id === msgId || String(s.email).toLowerCase() === to);
        });
        eligible.sort((a, b) => {
          const am = a.completion_email_provider_msg_id === msgId ? 1 : 0;
          const bm = b.completion_email_provider_msg_id === msgId ? 1 : 0;
          if (am !== bm) return bm - am; // exact msg-id match first
          const ae = envelopes.find((x) => x.id === a.envelope_id)!.completed_at.getTime();
          const be = envelopes.find((x) => x.id === b.envelope_id)!.completed_at.getTime();
          return ae - be; // oldest first
        });
        const hit = eligible[0];
        return { rows: hit ? [{ envelope_id: hit.envelope_id, email: hit.email }] : [] } as any;
      }
      // UPDATE delivered / bounced
      if (text.includes('UPDATE envelope_signers') && text.includes('completion_email_delivered_at')) {
        const s = signers.find((x) => x.envelope_id === v[0] && String(x.email).toLowerCase() === v[1]);
        if (s) { s.completion_email_delivered_at = v[2]; return { rows: [s], rowCount: 1 } as any; }
        return { rows: [], rowCount: 0 } as any;
      }
      if (text.includes('UPDATE envelope_signers') && text.includes('completion_email_bounced_at')) {
        const s = signers.find((x) => x.envelope_id === v[0] && String(x.email).toLowerCase() === v[1]);
        if (s) { s.completion_email_bounced_at = v[2]; return { rows: [s], rowCount: 1 } as any; }
        return { rows: [], rowCount: 0 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };
  return pool;
}

describe('readCompletionEmailEvent — F-013', () => {
  it('reads the canonical payload.event fields (snake_case)', () => {
    const ev = readCompletionEmailEvent({ event: { message_id: 'm1', to_address: 'a@t.com', bounce_type: 'Permanent' } });
    assert.deepEqual(ev, { messageId: 'm1', toAddress: 'a@t.com', bounceType: 'Permanent' });
  });
  it('reads root-level camelCase + event.data too', () => {
    const ev = readCompletionEmailEvent({ event: { data: { messageId: 'm2', toAddress: 'b@t.com' } } });
    assert.equal(ev.messageId, 'm2');
    assert.equal(ev.toAddress, 'b@t.com');
  });
});

describe('resolveCompletionSigner — F-013', () => {
  const envelopes = [
    { id: 'e1', status: 'completed', completed_at: new Date('2026-04-10T00:00:00Z') },
    { id: 'e2', status: 'completed', completed_at: new Date('2026-04-11T00:00:00Z') },
    { id: 'e3', status: 'active', completed_at: new Date('2026-04-12T00:00:00Z') },
  ];
  function signerSet() {
    return [
      { envelope_id: 'e1', email: 'alice@t.com', completion_email_provider_msg_id: 'msg-e1', completion_email_delivered_at: null, completion_email_bounced_at: null },
      { envelope_id: 'e2', email: 'alice@t.com', completion_email_provider_msg_id: 'msg-e2', completion_email_delivered_at: null, completion_email_bounced_at: null },
      { envelope_id: 'e3', email: 'carol@t.com', completion_email_provider_msg_id: 'msg-e3', completion_email_delivered_at: null, completion_email_bounced_at: null },
    ];
  }

  it('prefers the exact provider-message-id match', async () => {
    const pool = createEventPool(envelopes, signerSet());
    const r = await resolveCompletionSigner(pool, { providerMsgId: 'msg-e2', toAddress: 'alice@t.com' });
    assert.deepEqual(r, { envelope_id: 'e2', email: 'alice@t.com' });
  });

  it('falls back to recipient (oldest completed envelope) when the id does not match', async () => {
    const pool = createEventPool(envelopes, signerSet());
    const r = await resolveCompletionSigner(pool, { providerMsgId: 'unknown-id', toAddress: 'alice@t.com' });
    assert.deepEqual(r, { envelope_id: 'e1', email: 'alice@t.com' }); // e1 completed first
  });

  it('ignores non-completed envelopes (an active-envelope recipient never matches)', async () => {
    const pool = createEventPool(envelopes, signerSet());
    const r = await resolveCompletionSigner(pool, { providerMsgId: 'x', toAddress: 'carol@t.com' });
    assert.equal(r, null);
  });

  it('returns null for an unknown recipient with no id match (a non-completion status email)', async () => {
    const pool = createEventPool(envelopes, signerSet());
    const r = await resolveCompletionSigner(pool, { providerMsgId: 'x', toAddress: 'nobody@t.com' });
    assert.equal(r, null);
  });
});

describe('handleCompletionDelivered / handleCompletionBounced — F-013 live handlers', () => {
  const envelopes = [{ id: 'e1', status: 'completed', completed_at: new Date('2026-04-10T00:00:00Z') }];

  it('stamps delivered for the resolved signer', async () => {
    const signers = [{ envelope_id: 'e1', email: 'alice@t.com', completion_email_provider_msg_id: 'm1', completion_email_delivered_at: null, completion_email_bounced_at: null }];
    const pool = createEventPool(envelopes, signers);
    const r = await handleCompletionDelivered(pool, { event: { message_id: 'm1', to_address: 'alice@t.com' } });
    assert.equal(r.action, 'delivered');
    assert.ok(signers[0].completion_email_delivered_at);
  });

  it('no-ops when the event is for a non-completion message', async () => {
    const signers = [{ envelope_id: 'e1', email: 'alice@t.com', completion_email_provider_msg_id: 'm1', completion_email_delivered_at: null, completion_email_bounced_at: null }];
    const pool = createEventPool(envelopes, signers);
    const r = await handleCompletionDelivered(pool, { event: { message_id: 'x', to_address: 'reminder-recipient@t.com' } });
    assert.equal(r.action, 'no_match');
    assert.equal(signers[0].completion_email_delivered_at, null);
  });

  it('stamps bounced on a PERMANENT bounce', async () => {
    const signers = [{ envelope_id: 'e1', email: 'bob@t.com', completion_email_provider_msg_id: 'm2', completion_email_delivered_at: null, completion_email_bounced_at: null }];
    const pool = createEventPool(envelopes, signers);
    const r = await handleCompletionBounced(pool, { event: { message_id: 'm2', to_address: 'bob@t.com', bounce_type: 'Permanent' } });
    assert.equal(r.action, 'bounced');
    assert.ok(signers[0].completion_email_bounced_at);
  });

  it('ignores a TRANSIENT bounce (may still deliver on retry)', async () => {
    const signers = [{ envelope_id: 'e1', email: 'bob@t.com', completion_email_provider_msg_id: 'm2', completion_email_delivered_at: null, completion_email_bounced_at: null }];
    const pool = createEventPool(envelopes, signers);
    const r = await handleCompletionBounced(pool, { event: { message_id: 'm2', to_address: 'bob@t.com', bounce_type: 'Transient' } });
    assert.equal(r.action, 'ignored_transient');
    assert.equal(signers[0].completion_email_bounced_at, null);
  });
});
