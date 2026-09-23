/**
 * Signer rejection state + claim-first creator notices — F-45.3 / F-45.5 / F-45.6
 * (spec 0.72.0, DD-70; AC-273, AC-275, AC-276, AC-277).
 *
 * The in-memory table applies a clause (status filter, clearing, re-arming, the
 * atomic claim) ONLY when the DAO's SQL actually carries it, so a DAO that forgets
 * one fails here. Rows come back in the production wire shape (timestamps as ISO
 * strings, like run402's HTTP DB) so the DAO's rehydration is exercised.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSignerToEnvelope,
  claimRejectionNotice,
  deleteSigner,
  getEnvelopeSigners,
  markSignerSignedByEmail,
  recordSignerRejection,
  updateSignerForEdit,
} from './envelopes.js';
import type { DbPool } from './pool.js';

const ENV = 'env-1';

function wire(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row, rejection_notice_classes: [...(row.rejection_notice_classes as string[])] };
  for (const [k, v] of Object.entries(out)) if (v instanceof Date) out[k] = v.toISOString();
  return out;
}

function createSignersPool() {
  const signers: Array<Record<string, any>> = [];
  let seq = 0;
  const find = (envelopeId: unknown, email: unknown) =>
    signers.filter((s) => s.envelope_id === envelopeId && String(s.email).toLowerCase() === String(email).toLowerCase());

  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];
      if (text.includes('INSERT INTO envelope_signers')) {
        const row = {
          id: `s-${++seq}`, envelope_id: v[0], email: v[1], name: v[2], verification_level: v[3],
          signing_token: v[4], token_expires_at: v[5], on_behalf_of: v[6], sent_pdf_hash: v[7],
          status: 'pending', signed_at: null, signing_method: null, undeliverable_at: null,
          reminder_count: 0, last_reminder_at: null, acceptance_notified_at: null,
          last_rejection_class: null, last_rejection_at: null, rejection_notice_classes: [] as string[],
        };
        signers.push(row);
        return { rows: [wire(row)], rowCount: 1 } as any;
      }
      if (text.includes('FROM envelope_signers WHERE envelope_id') && text.includes('ORDER BY name')) {
        return { rows: signers.filter((s) => s.envelope_id === v[0]).map(wire), rowCount: 0 } as any;
      }
      if (text.includes('UPDATE envelope_signers') && text.includes('SET last_rejection_class')) {
        const statusFiltered = /status IN \('pending', 'superseded'\)/.test(text);
        const hits = find(v[0], v[1]).filter((s) => !statusFiltered || s.status === 'pending' || s.status === 'superseded');
        for (const s of hits) { s.last_rejection_class = v[2]; s.last_rejection_at = new Date(); }
        return { rows: hits.map((s) => ({ id: s.id })), rowCount: hits.length } as any;
      }
      if (text.includes('UPDATE envelope_signers') && text.includes('array_append(rejection_notice_classes')) {
        const guarded = text.includes('ANY(rejection_notice_classes)');
        const hits = find(v[0], v[1]).filter((s) => !guarded || !s.rejection_notice_classes.includes(v[2]));
        for (const s of hits) s.rejection_notice_classes.push(v[2]);
        return { rows: hits.map((s) => ({ id: s.id })), rowCount: hits.length } as any;
      }
      if (text.includes('UPDATE envelope_signers') && text.includes("status = 'signed'")) {
        const hits = find(v[0], v[1]).filter((s) => s.status !== 'signed');
        for (const s of hits) {
          s.status = 'signed'; s.signed_at = new Date(); s.signing_method = 'email';
          if (text.includes('last_rejection_class = NULL')) s.last_rejection_class = null;
          if (text.includes('last_rejection_at = NULL')) s.last_rejection_at = null;
        }
        return { rows: hits.map((s) => ({ id: s.id })), rowCount: hits.length } as any;
      }
      if (text.includes('UPDATE envelope_signers') && text.includes('SET name = $2')) {
        const s = signers.find((x) => x.id === v[0]);
        if (!s) return { rows: [], rowCount: 0 } as any;
        s.name = v[1]; s.on_behalf_of = v[2]; s.sent_pdf_hash = v[3]; s.status = v[4];
        s.signed_at = null; s.signing_method = null; s.undeliverable_at = null;
        s.reminder_count = 0; s.last_reminder_at = null;
        if (text.includes('last_rejection_class = NULL')) s.last_rejection_class = null;
        if (text.includes('last_rejection_at = NULL')) s.last_rejection_at = null;
        if (text.includes("rejection_notice_classes = '{}'")) s.rejection_notice_classes = [];
        return { rows: [wire(s)], rowCount: 1 } as any;
      }
      if (text.includes('DELETE FROM envelope_signers WHERE id = $1')) {
        const i = signers.findIndex((x) => x.id === v[0]);
        if (i >= 0) signers.splice(i, 1);
        return { rows: [], rowCount: i >= 0 ? 1 : 0 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };
  return { pool, signers };
}

async function seed(email = 'Alice@Example.com') {
  const h = createSignersPool();
  await addSignerToEnvelope(
    h.pool,
    ENV,
    { email, name: 'Alice', on_behalf_of: null, verification_level: 2, signing_token: 'tok', sent_pdf_hash: 'a'.repeat(64) },
    'https://kysigned.com',
  );
  return h;
}

describe('recordSignerRejection (F-45.5 / DD-70)', () => {
  it('records the latest class on a pending signer, case-insensitive email, and rehydrates the time', async () => {
    const h = await seed();
    assert.equal(await recordSignerRejection(h.pool, ENV, 'alice@example.com', 'wrong_phrase'), true);
    assert.equal(await recordSignerRejection(h.pool, ENV, 'alice@example.com', 'google_workspace_no_dkim'), true);
    const [s] = await getEnvelopeSigners(h.pool, ENV);
    assert.equal(s.last_rejection_class, 'google_workspace_no_dkim');
    assert.ok(s.last_rejection_at instanceof Date, 'last_rejection_at rehydrates to a Date');
  });

  it('records on a superseded signer (they still owe a signature)', async () => {
    const h = await seed();
    h.signers[0].status = 'superseded';
    assert.equal(await recordSignerRejection(h.pool, ENV, 'alice@example.com', 'attachment_missing'), true);
    assert.equal(h.signers[0].last_rejection_class, 'attachment_missing');
  });

  it('never touches a signed signer', async () => {
    const h = await seed();
    h.signers[0].status = 'signed';
    assert.equal(await recordSignerRejection(h.pool, ENV, 'alice@example.com', 'wrong_phrase'), false);
    assert.equal(h.signers[0].last_rejection_class, null);
  });
});

describe('claimRejectionNotice (F-45.3 / DD-70) — claim-first, once per class', () => {
  it('claims a class exactly once; a different class claims again', async () => {
    const h = await seed();
    assert.equal(await claimRejectionNotice(h.pool, ENV, 'ALICE@example.com', 'wrong_phrase'), true);
    assert.equal(await claimRejectionNotice(h.pool, ENV, 'alice@example.com', 'wrong_phrase'), false);
    assert.equal(await claimRejectionNotice(h.pool, ENV, 'alice@example.com', 'attachment_missing'), true);
    assert.deepEqual(h.signers[0].rejection_notice_classes, ['wrong_phrase', 'attachment_missing']);
  });

  it('is false for an unknown signer', async () => {
    const h = await seed();
    assert.equal(await claimRejectionNotice(h.pool, ENV, 'nobody@example.com', 'wrong_phrase'), false);
  });
});

describe('clearing (F-45.5): sign, edit, and delete + add', () => {
  it('signing clears the rejection state', async () => {
    const h = await seed();
    await recordSignerRejection(h.pool, ENV, 'alice@example.com', 'wrong_phrase');
    assert.equal(await markSignerSignedByEmail(h.pool, ENV, 'alice@example.com'), true);
    assert.equal(h.signers[0].last_rejection_class, null);
    assert.equal(h.signers[0].last_rejection_at, null);
  });

  it('an edit clears the state AND re-arms the creator notices', async () => {
    const h = await seed();
    await recordSignerRejection(h.pool, ENV, 'alice@example.com', 'microsoft_365_no_dkim');
    await claimRejectionNotice(h.pool, ENV, 'alice@example.com', 'microsoft_365_no_dkim');
    await updateSignerForEdit(h.pool, h.signers[0].id, { name: 'Alice B', on_behalf_of: null, sent_pdf_hash: 'b'.repeat(64), status: 'pending' });
    assert.equal(h.signers[0].last_rejection_class, null);
    assert.equal(h.signers[0].last_rejection_at, null);
    assert.equal(await claimRejectionNotice(h.pool, ENV, 'alice@example.com', 'microsoft_365_no_dkim'), true);
  });

  it('an address change (delete + add) starts from a clean row', async () => {
    const h = await seed();
    await recordSignerRejection(h.pool, ENV, 'alice@example.com', 'wrong_phrase');
    await claimRejectionNotice(h.pool, ENV, 'alice@example.com', 'wrong_phrase');
    await deleteSigner(h.pool, h.signers[0].id);
    await addSignerToEnvelope(
      h.pool,
      ENV,
      { email: 'alice@example.com', name: 'Alice', on_behalf_of: null, verification_level: 2, signing_token: 'tok2', sent_pdf_hash: 'c'.repeat(64) },
      'https://kysigned.com',
    );
    const [s] = await getEnvelopeSigners(h.pool, ENV);
    assert.equal(s.last_rejection_class, null);
    assert.equal(await claimRejectionNotice(h.pool, ENV, 'alice@example.com', 'wrong_phrase'), true);
  });
});
