/**
 * Auto-close vs manual seal (F-24 / AC-74, AC-75) — handler + sweep tests.
 *
 * Auto-close (default true) distributes automatically on the last signature
 * (the existing completion backstop, now gated to auto_close=true). Manual
 * (auto_close=false) instead notifies the creator ("all signed — review & seal")
 * and parks the envelope in `awaiting_seal`; the creator's "Seal & send" action
 * then assembles + distributes exactly once and freezes the envelope.
 *
 * Focused in-memory pool (reuses the distributeBundle mock shape) + a fake email
 * provider + a stub prepareBundle.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { notifyEnvelopeAwaitingSeal, handleSealEnvelope } from './sealEnvelope.js';
import type { DistributeBundleDeps, PreparedBundle } from './distributeBundle.js';
import type { DbPool } from '../db/pool.js';
import type { EmailMessage, EmailProvider } from '../email/types.js';

const ENV = 'e8a1f0c2-0000-4000-8000-000000000099';
const CREATOR = 'carol@kychee.com';
const BUNDLE = new Uint8Array(Buffer.from('%PDF-1.7\nbundle\n%%EOF\n'));
const FINGERPRINT = 'a'.repeat(64);

function makePool(seed: {
  autoClose: boolean;
  status?: string;
  signers: Array<{ id: string; email: string; name: string; status?: string }>;
  completedDistributed?: boolean;
}) {
  const envelope: any = {
    id: ENV,
    sender_email: CREATOR,
    document_name: 'Mutual NDA',
    document_hash: 'd'.repeat(64),
    status: seed.status ?? 'active',
    auto_close: seed.autoClose,
    completed_at: null,
    completion_distributed_at: seed.completedDistributed ? new Date() : null,
  };
  const signers: any[] = seed.signers.map((s) => ({
    id: s.id,
    envelope_id: ENV,
    email: s.email,
    name: s.name,
    status: s.status ?? 'signed',
    completion_email_provider_msg_id: null,
  }));

  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];
      if (text.includes("SET status = 'awaiting_seal'")) {
        // transitionToAwaitingSeal — only flips an active envelope.
        if (envelope.id === v[0] && envelope.status === 'active') {
          envelope.status = 'awaiting_seal';
          return { rows: [{ ...envelope }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      }
      if (text.includes("UPDATE envelopes SET status = 'completed'")) {
        if (envelope.id === v[0]) {
          envelope.status = 'completed';
          envelope.completed_at = envelope.completed_at ?? new Date(1700000000000);
        }
        return { rows: [{ ...envelope }], rowCount: 1 } as any;
      }
      if (text.includes('completion_distributed_at = now()')) {
        if (envelope.id === v[0] && envelope.completion_distributed_at == null) {
          envelope.completion_distributed_at = new Date();
        }
        return { rows: [{ id: envelope.id }], rowCount: 1 } as any;
      }
      if (text.includes('completion_email_provider_msg_id = $2')) {
        const s = signers.find((x) => x.id === v[0]);
        if (s) s.completion_email_provider_msg_id = v[1];
        return { rows: s ? [{ id: s.id }] : [], rowCount: s ? 1 : 0 } as any;
      }
      if (text.includes('SELECT * FROM envelopes WHERE id')) {
        return { rows: envelope.id === v[0] ? [{ ...envelope }] : [], rowCount: envelope.id === v[0] ? 1 : 0 } as any;
      }
      if (text.includes('FROM envelope_signers WHERE envelope_id')) {
        const out = signers.filter((s) => s.envelope_id === v[0]).map((s) => ({ ...s }));
        return { rows: out, rowCount: out.length } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  } as any;
  return { pool, envelope, signers };
}

function fakeEmail() {
  const sent: EmailMessage[] = [];
  const provider: EmailProvider = {
    async send(m) {
      sent.push(m);
      return { messageId: `msg-${sent.length}` };
    },
  };
  return { provider, sent };
}

function distDeps(emailProvider: EmailProvider): DistributeBundleDeps {
  return {
    emailProvider,
    operatorDomain: 'kysigned.com',
    verifierBaseUrl: 'https://kysigned.com',
    dashboardBaseUrl: 'https://kysigned.com',
    prepareBundle: async (): Promise<PreparedBundle> => ({ bytes: BUNDLE, fingerprint: FINGERPRINT }),
  };
}

describe('F-24 manual seal — notifyEnvelopeAwaitingSeal (AC-75)', () => {
  it('emails the creator "review & seal" and parks the envelope in awaiting_seal', async () => {
    const { pool, envelope } = makePool({
      autoClose: false,
      signers: [{ id: 's1', email: 'a@x.com', name: 'Alice' }, { id: 's2', email: 'b@x.com', name: 'Bob' }],
    });
    const { provider, sent } = fakeEmail();
    const r = await notifyEnvelopeAwaitingSeal(pool, ENV, { emailProvider: provider, operatorDomain: 'kysigned.com', dashboardBaseUrl: 'https://kysigned.com' });

    assert.equal(r.action, 'notified');
    assert.equal(envelope.status, 'awaiting_seal'); // parked
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, CREATOR); // creator only — NOT the signers
    assert.match(sent[0]!.subject, /seal/i);
    // No bundle is distributed yet.
    assert.equal(envelope.completion_distributed_at, null);
  });

  it('is idempotent — a second pass on an already-parked envelope sends nothing', async () => {
    const { pool } = makePool({
      autoClose: false,
      status: 'awaiting_seal',
      signers: [{ id: 's1', email: 'a@x.com', name: 'Alice' }],
    });
    const { provider, sent } = fakeEmail();
    const r = await notifyEnvelopeAwaitingSeal(pool, ENV, { emailProvider: provider, operatorDomain: 'kysigned.com', dashboardBaseUrl: 'https://kysigned.com' });
    assert.equal(r.action, 'skipped');
    assert.equal(sent.length, 0);
  });
});

describe('F-24 manual seal — handleSealEnvelope (AC-75)', () => {
  it('assembles + distributes the bundle exactly once and freezes the envelope', async () => {
    const { pool, envelope } = makePool({
      autoClose: false,
      status: 'awaiting_seal',
      signers: [{ id: 's1', email: 'a@x.com', name: 'Alice' }, { id: 's2', email: 'b@x.com', name: 'Bob' }],
    });
    const { provider, sent } = fakeEmail();
    const res = await handleSealEnvelope(pool, ENV, CREATOR, distDeps(provider));

    assert.equal(res.status, 200);
    assert.equal(res.body.action, 'distributed');
    assert.equal(envelope.status, 'completed'); // frozen
    assert.ok(envelope.completion_distributed_at); // distributed exactly once
    assert.equal(sent.length, 3); // 2 signers + creator, each with the bundle
    for (const m of sent) assert.equal(m.attachments?.length, 1);
  });

  it('rejects sealing when not all signers have signed (409)', async () => {
    const { pool } = makePool({
      autoClose: false,
      signers: [{ id: 's1', email: 'a@x.com', name: 'Alice', status: 'signed' }, { id: 's2', email: 'b@x.com', name: 'Bob', status: 'pending' }],
    });
    const { provider } = fakeEmail();
    const res = await handleSealEnvelope(pool, ENV, CREATOR, distDeps(provider));
    assert.equal(res.status, 409);
  });

  it('is idempotent — sealing an already-distributed envelope reports already-sealed', async () => {
    const { pool } = makePool({
      autoClose: false,
      status: 'completed',
      completedDistributed: true,
      signers: [{ id: 's1', email: 'a@x.com', name: 'Alice' }],
    });
    const { provider, sent } = fakeEmail();
    const res = await handleSealEnvelope(pool, ENV, CREATOR, distDeps(provider));
    assert.equal(res.status, 200);
    assert.equal(res.body.already_sealed, true);
    assert.equal(sent.length, 0); // no re-distribution
  });

  it('is creator-scoped — 404 unknown envelope, 403 for a non-owner', async () => {
    const { pool } = makePool({ autoClose: false, signers: [{ id: 's1', email: 'a@x.com', name: 'Alice' }] });
    const { provider } = fakeEmail();
    assert.equal((await handleSealEnvelope(pool, 'no-such-env', CREATOR, distDeps(provider))).status, 404);
    assert.equal((await handleSealEnvelope(pool, ENV, 'intruder@evil.com', distDeps(provider))).status, 403);
  });
});
