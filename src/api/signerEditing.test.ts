/**
 * Recipient editing (F-23 / AC-72, AC-73) — handler tests.
 *
 * While an envelope is OPEN (active or awaiting_seal), the creator edits the
 * signer set in place (DD-10): per-signer edit (regenerate P_i + resend),
 * delete (cancellation email + remove), add. Each signer is an independent
 * package off the shared document D, so editing one never disturbs another's
 * binding. Changing an email is delete-old + add-new. Seal freezes the set (409).
 *
 * Focused in-memory mock (only the SQL these handlers touch) + a storage mock
 * whose `document.pdf` is a real PDF so buildSignerCanonicalPdf can assemble P_i.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { handleAddSigner, handleEditSigner, handleDeleteSigner } from './envelope.js';
import type { SignerEditCtx } from './envelope.js';
import type { DbPool } from '../db/pool.js';
import type { EmailProvider, EmailMessage } from '../email/types.js';
import type { Envelope, EnvelopeSigner } from '../db/types.js';
import { decodePdfBase64, computePdfHash } from '../pdf/hash.js';

// Minimal real PDF (pdf-lib-parseable) — D, the shared document.
const TEST_FIXTURE_PDF_B64 =
  'JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDc0MDA2NTAwNzMwMDc0MDAyRDAwNjYwMDY5MDA3ODAwNzQwMDc1MDA3MjAwNjU+Ci9Nb2REYXRlIChEOjIwMjAwMTAxMDAwMDAwWikKL0NyZWF0b3IgPEZFRkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyMDAwMjgwMDY4MDA3NDAwNzQwMDcwMDA3MzAwM0EwMDJGMDAyRjAwNjcwMDY5MDA3NDAwNjgwMDc1MDA2MjAwMkUwMDYzMDA2RjAwNkQwMDJGMDA0ODAwNkYwMDcwMDA2NDAwNjkwMDZFMDA2NzAwMkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyOT4KL0NyZWF0aW9uRGF0ZSAoRDoyMDIwMDEwMTAwMDAwMFopCi9UaXRsZSA8RkVGRjAwNzQwMDY1MDA3MzAwNzQ+Cj4+CmVuZG9iagoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0hlbHZldGljYS03MDk4NDgwNzg5IDUgMCBSCj4+Ci9YT2JqZWN0IDw8Cj4+Ci9FeHRHU3RhdGUgPDwKPj4KPj4KL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXQovQW5ub3RzIFsgXQovQ29udGVudHMgWyA2IDAgUiBdCj4+CmVuZG9iagoKNSAwIG9iago8PAovVHlwZSAvRm9udAovU3VidHlwZSAvVHlwZTEKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCgo2IDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggOTYKPj4Kc3RyZWFtCnicK+RyCuEyUADBonQufY/UnLLUkszkRF1zA0sLEwsDcwtLBSMThZA0LhDpw2UIVgohQ3K5bMxNzEzNjc1NjAzMzMwszS3MTcxNzY3MTO0UQrK4QrS4XEO4ArkAobMWLQplbmRzdHJlYW0KZW5kb2JqCgp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTYgMDAwMDAgbiAKMDAwMDAwMDA3NiAwMDAwMCBuIAowMDAwMDAwMTI2IDAwMDAwIG4gCjAwMDAwMDA0OTggMDAwMDAgbiAKMDAwMDAwMDY5MyAwMDAwMCBuIAowMDAwMDAwNzkxIDAwMDAwIG4gCgp0cmFpbGVyCjw8Ci9TaXplIDcKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKPj4KCnN0YXJ0eHJlZgo5NTkKJSVFT0Y=';

const D_BYTES = decodePdfBase64(TEST_FIXTURE_PDF_B64);
const H_D = computePdfHash(D_BYTES);
const DOC_KEY = `envelopes/${H_D}/document.pdf`;

/** Decompress a pdf-lib PDF's flate streams and return the visible reading text
 *  (space-joined hex text-show tokens) so we can assert what a regenerated cover
 *  actually renders. Mirrors coverPage.test.ts's wrap-tolerant extractor. */
function pdfVisibleText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf);
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const s = raw.indexOf(Buffer.from('stream', 'latin1'), i);
    if (s === -1) break;
    let start = s + 6;
    if (raw[start] === 0x0d) start++;
    if (raw[start] === 0x0a) start++;
    const e = raw.indexOf(Buffer.from('endstream', 'latin1'), start);
    if (e === -1) break;
    try {
      const inflated = inflateSync(raw.subarray(start, e)).toString('latin1');
      for (const m of inflated.matchAll(/<([0-9A-Fa-f]+)>/g)) {
        const hex = m[1]!;
        if (hex.length % 2) continue;
        let t = '';
        for (let j = 0; j < hex.length; j += 2) t += String.fromCharCode(parseInt(hex.slice(j, j + 2), 16));
        out.push(t);
      }
    } catch {
      /* non-flate stream (e.g. embedded font) */
    }
    i = e + 9;
  }
  return out.join(' ');
}

function mockEmail(): EmailProvider & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(msg: EmailMessage) {
      sent.push(msg);
      return { messageId: `msg-${sent.length}` };
    },
  };
}

function mockStorage() {
  const store = new Map<string, Uint8Array>([[DOC_KEY, D_BYTES]]);
  const deleted: string[] = [];
  return {
    store,
    deleted,
    getPdf: async (k: string) => store.get(k) ?? null,
    storePdf: async (k: string, d: Uint8Array) => {
      store.set(k, d);
    },
    deletePdf: async (k: string) => {
      store.delete(k);
      deleted.push(k);
    },
  };
}

function signer(over: Partial<EnvelopeSigner>): EnvelopeSigner {
  return {
    id: `sg-${over.email}`,
    envelope_id: 'env-1',
    email: over.email!,
    name: over.name ?? over.email!,
    on_behalf_of: over.on_behalf_of ?? null,
    sent_pdf_hash: over.sent_pdf_hash ?? 'seed-hash-' + over.email,
    verification_level: 2,
    signing_method: over.signing_method ?? null,
    status: over.status ?? 'pending',
    signing_token: over.signing_token ?? `tok-${over.email}`,
    token_expires_at: new Date(Date.now() + 86400000),
    signed_at: over.signed_at ?? null,
    reminder_count: 0,
    last_reminder_at: null,
    completion_email_delivered_at: null,
    completion_email_bounced_at: null,
    completion_email_provider_msg_id: null,
    undeliverable_at: null,
  };
}

function mockDb(envStatus: Envelope['status'], signers: EnvelopeSigner[]) {
  const envelope: Envelope = {
    id: 'env-1',
    sender_email: 'creator@kychee.com',
    document_name: 'Agreement',
    document_hash: H_D,
    source_hash: H_D,
    status: envStatus,
    auto_close: true,
    created_at: new Date(),
    completed_at: null,
    pdf_storage_key: DOC_KEY,
    expiry_at: null,
    pdf_deleted_at: null,
    consent_language_version: '1.0',
    completion_distributed_at: null,
    internal_test: false,
  };
  const rows = [...signers];
  let nextId = 100;
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];
      if (text.includes('SELECT * FROM envelopes WHERE id =')) {
        return { rows: envelope.id === v[0] ? [envelope] : [], rowCount: envelope.id === v[0] ? 1 : 0 } as any;
      }
      if (text.includes('SELECT * FROM envelope_signers WHERE envelope_id = $1 AND LOWER(email)')) {
        const s = rows.find((r) => r.envelope_id === v[0] && r.email.toLowerCase() === String(v[1]).toLowerCase());
        return { rows: s ? [s] : [], rowCount: s ? 1 : 0 } as any;
      }
      if (text.includes('SELECT * FROM envelope_signers WHERE envelope_id = $1 ORDER BY name')) {
        const list = rows.filter((r) => r.envelope_id === v[0]).sort((a, b) => a.name.localeCompare(b.name));
        return { rows: [...list], rowCount: list.length } as any;
      }
      if (text.includes('INSERT INTO envelope_signers')) {
        // ($1 envelope_id,$2 email,$3 name,$4 verification_level,$5 signing_token,$6 token_expires_at,$7 on_behalf_of,$8 sent_pdf_hash)
        const row = signer({
          email: v[1],
          name: v[2],
          signing_token: v[4],
          on_behalf_of: v[6] ?? null,
          sent_pdf_hash: v[7] ?? null,
        });
        row.id = `ins-${nextId++}`;
        row.token_expires_at = v[5];
        rows.push(row);
        return { rows: [row], rowCount: 1 } as any;
      }
      if (text.includes('UPDATE envelope_signers') && text.includes('SET name')) {
        const s = rows.find((r) => r.id === v[0]);
        if (!s) return { rows: [], rowCount: 0 } as any;
        s.name = v[1];
        s.on_behalf_of = v[2] ?? null;
        s.sent_pdf_hash = v[3] ?? null;
        s.status = v[4];
        s.signed_at = null;
        s.signing_method = null;
        s.undeliverable_at = null;
        s.reminder_count = 0;
        s.last_reminder_at = null;
        return { rows: [s], rowCount: 1 } as any;
      }
      if (text.includes('DELETE FROM envelope_signers')) {
        const i = rows.findIndex((r) => r.id === v[0]);
        if (i >= 0) rows.splice(i, 1);
        return { rows: [], rowCount: i >= 0 ? 1 : 0 } as any;
      }
      if (text.includes("UPDATE envelopes SET status = 'active'") && text.includes("status = 'awaiting_seal'")) {
        if (envelope.id === v[0] && envelope.status === 'awaiting_seal') envelope.status = 'active';
        return { rows: [], rowCount: 1 } as any;
      }
      throw new Error(`unmocked SQL: ${text}`);
    },
  } as any;
  return { pool, envelope, rows };
}

function ctxFor(pool: DbPool, email: EmailProvider, storage: ReturnType<typeof mockStorage>): SignerEditCtx {
  return {
    pool,
    emailProvider: email,
    baseUrl: 'https://app.example.com',
    operatorDomain: 'kysigned.com',
    getPdf: storage.getPdf,
    storePdf: storage.storePdf,
    deletePdf: storage.deletePdf,
  };
}

const CREATOR = 'creator@kychee.com';

describe('F-23 recipient editing — edit (AC-72)', () => {
  it('regenerates the edited signer P_i + resends, without touching any other signer', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'pending' });
    const bob = signer({ email: 'bob@x.com', name: 'Bob', status: 'pending' });
    const { pool, rows } = mockDb('active', [alice, bob]);
    const email = mockEmail();
    const ctx = ctxFor(pool, email, mockStorage());

    const aliceBefore = alice.sent_pdf_hash;
    const bobBefore = bob.sent_pdf_hash;
    const res = await handleEditSigner(ctx, 'env-1', CREATOR, 'alice@x.com', { name: 'Alice Smith' });

    assert.equal(res.status, 200);
    const aliceAfter = rows.find((r) => r.email === 'alice@x.com')!;
    assert.equal(aliceAfter.name, 'Alice Smith');
    assert.notEqual(aliceAfter.sent_pdf_hash, aliceBefore); // regenerated P_i
    assert.match(aliceAfter.sent_pdf_hash!, /^[0-9a-f]{64}$/); // real hash
    assert.equal(aliceAfter.status, 'pending');
    // Bob untouched: same P_i, no email.
    const bobAfter = rows.find((r) => r.email === 'bob@x.com')!;
    assert.equal(bobAfter.sent_pdf_hash, bobBefore);
    assert.equal(email.sent.length, 1);
    assert.equal(email.sent[0]!.to, 'alice@x.com');
  });

  it('adding on-behalf-of via edit puts the authority affirmation on the REGENERATED, resent cover', async () => {
    // Barry QA: edited a signer to add on-behalf — the dashboard reflected it but
    // "no sign of it on the new cover page". This asserts the regenerated P_i that
    // gets RESENT actually carries the on-behalf affirmation (not just the DB row).
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'pending', on_behalf_of: null });
    const { pool, rows } = mockDb('active', [alice]);
    const email = mockEmail();
    const ctx = ctxFor(pool, email, mockStorage());

    const res = await handleEditSigner(ctx, 'env-1', CREATOR, 'alice@x.com', { name: 'Alice', on_behalf_of: 'Kychee Inc' });
    assert.equal(res.status, 200);
    // DB reflects it (what the dashboard reads back).
    assert.equal(rows.find((r) => r.email === 'alice@x.com')!.on_behalf_of, 'Kychee Inc');
    // ...AND the regenerated, resent PDF cover carries the authority affirmation.
    const att = email.sent[0]!.attachments?.[0]?.content as Uint8Array;
    assert.ok(att, 'resent signing request carries the regenerated P_i');
    const text = pdfVisibleText(att);
    assert.match(text, /on behalf of Kychee Inc/i, 'authority affirmation rendered on the resent cover');
    assert.match(text, /authorised to sign on its behalf/i, 'authority clause rendered');
  });

  it('a re-send after an edit gets an "(updated …)" subject marker so it does not thread under the original (Barry QA)', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'pending' });
    const { pool } = mockDb('active', [alice]);
    const email = mockEmail();
    const ctx = ctxFor(pool, email, mockStorage());
    await handleEditSigner(ctx, 'env-1', CREATOR, 'alice@x.com', { name: 'Alice Smith' });
    assert.equal(email.sent.length, 1);
    const subject = email.sent[0]!.subject!;
    assert.match(subject, /\(updated [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC\)/, 'resend subject carries the updated marker');
    // marker sits BEFORE the [ksgn-] routing token, which stays at the very end.
    assert.match(subject, /\(updated [^)]+\) \[ksgn-[^\]]+\]\s*$/, 'the [ksgn-] routing token still survives at the end');
  });

  it('editing a signer who already SIGNED supersedes them and drops the old signature', async () => {
    const bob = signer({ email: 'bob@x.com', name: 'Bob', status: 'signed', signed_at: new Date(), signing_method: 'email' });
    const { pool, rows } = mockDb('active', [bob]);
    const email = mockEmail();
    const ctx = ctxFor(pool, email, mockStorage());

    const res = await handleEditSigner(ctx, 'env-1', CREATOR, 'bob@x.com', { name: 'Bob Jones' });
    assert.equal(res.status, 200);
    const after = rows.find((r) => r.email === 'bob@x.com')!;
    assert.equal(after.status, 'superseded');
    assert.equal(after.signed_at, null); // signature dropped
    assert.equal(email.sent.length, 1);
    assert.equal(email.sent[0]!.to, 'bob@x.com');
  });
});

describe('F-23 recipient editing — delete (AC-72)', () => {
  it('emails the deleted signer a cancellation and removes them', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'pending' });
    const bob = signer({ email: 'bob@x.com', name: 'Bob', status: 'pending' });
    const { pool, rows } = mockDb('active', [alice, bob]);
    const email = mockEmail();
    const ctx = ctxFor(pool, email, mockStorage());

    const res = await handleDeleteSigner(ctx, 'env-1', CREATOR, 'alice@x.com');
    assert.equal(res.status, 200);
    assert.equal(rows.some((r) => r.email === 'alice@x.com'), false); // removed
    assert.equal(rows.some((r) => r.email === 'bob@x.com'), true); // bob kept
    assert.equal(email.sent.length, 1);
    assert.equal(email.sent[0]!.to, 'alice@x.com');
    assert.match(email.sent[0]!.subject, /cancel/i); // "your signing request was cancelled"
  });
});

describe('F-23 recipient editing — add (AC-72)', () => {
  it('adds a new signer with a fresh P_i + signing-request email (with attachment)', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'pending' });
    const { pool, rows } = mockDb('active', [alice]);
    const email = mockEmail();
    const ctx = ctxFor(pool, email, mockStorage());

    const res = await handleAddSigner(ctx, 'env-1', CREATOR, { email: 'carol@x.com', name: 'Carol' });
    assert.equal(res.status, 201);
    const carol = rows.find((r) => r.email === 'carol@x.com');
    assert.ok(carol, 'carol added');
    assert.equal(carol!.status, 'pending');
    assert.match(carol!.sent_pdf_hash!, /^[0-9a-f]{64}$/);
    assert.equal(email.sent.length, 1);
    assert.equal(email.sent[0]!.to, 'carol@x.com');
    assert.ok((email.sent[0]!.attachments ?? []).length === 1, 'P_i attached');
    // First send to a brand-new signer → NO "(updated …)" marker (nothing to un-thread from).
    assert.doesNotMatch(email.sent[0]!.subject!, /\(updated /, 'a first send carries no updated marker');
  });
});

describe('F-23 add — send-failure resilience (F-9.9 / AC-124)', () => {
  it('a TRANSIENT send failure on add schedules a delivery_backstop, does NOT 500, leaves the signer pending', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'pending' });
    const { pool, rows } = mockDb('active', [alice]);
    const throwing: EmailProvider = { async send() { throw new Error('Internal server error (HTTP 500)'); } };
    const runs: Array<Record<string, unknown>> = [];
    const ctx: SignerEditCtx = {
      ...ctxFor(pool, throwing, mockStorage()),
      createRun: async (o) => { runs.push(o as unknown as Record<string, unknown>); return { runId: 'r', deduplicated: false }; },
      deliveryBackstop: '24h',
    };
    const res = await handleAddSigner(ctx, 'env-1', CREATOR, { email: 'carol@x.com', name: 'Carol' });
    // The row is already inserted, so a deliverability problem must NOT 500 the add.
    assert.equal(res.status, 201);
    const carol = rows.find((r) => r.email === 'carol@x.com');
    assert.ok(carol, 'carol added despite the send failure');
    assert.equal(carol!.status, 'pending'); // transient → still pending, not undeliverable
    assert.equal(carol!.undeliverable_at ?? null, null);
    // …but a delivery_backstop is scheduled so she can't sit pending forever (AC-124).
    const backstop = runs.find((r) => r.eventType === 'delivery_backstop');
    assert.ok(backstop, 'a delivery_backstop run is scheduled for the added signer');
    assert.equal(backstop!.delay, '24h');
    assert.match(backstop!.idempotencyKey as string, /:delivery-backstop$/);
  });
});

describe('F-3.2a / #96 — add + email-change also enforce no-alias / no-same-inbox', () => {
  it('rejects ADDING a plus-alias signer with a 400 (AC-89)', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'pending' });
    const { pool } = mockDb('active', [alice]);
    const ctx = ctxFor(pool, mockEmail(), mockStorage());
    const res = await handleAddSigner(ctx, 'env-1', CREATOR, { email: 'bob+tag@x.com', name: 'Bob' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /plus-alias/i);
  });

  it('rejects ADDING a signer that collapses to an existing inbox — Gmail dots (AC-88)', async () => {
    const n = signer({ email: 'name@gmail.com', name: 'N', status: 'pending' });
    const { pool } = mockDb('active', [n]);
    const ctx = ctxFor(pool, mockEmail(), mockStorage());
    const res = await handleAddSigner(ctx, 'env-1', CREATOR, { email: 'n.a.me@gmail.com', name: 'N2' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /same inbox/i);
  });

  it('rejects an email-CHANGE to a plus-alias with a 400 (AC-89)', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'pending' });
    const { pool } = mockDb('active', [alice]);
    const ctx = ctxFor(pool, mockEmail(), mockStorage());
    const res = await handleEditSigner(ctx, 'env-1', CREATOR, 'alice@x.com', { new_email: 'alice+x@x.com' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /plus-alias/i);
  });

  it('rejects an email-CHANGE that collapses to another signer inbox (AC-88)', async () => {
    const n = signer({ email: 'name@gmail.com', name: 'N', status: 'pending' });
    const bob = signer({ email: 'bob@x.com', name: 'Bob', status: 'pending' });
    const { pool } = mockDb('active', [n, bob]);
    const ctx = ctxFor(pool, mockEmail(), mockStorage());
    const res = await handleEditSigner(ctx, 'env-1', CREATOR, 'bob@x.com', { new_email: 'n.a.me@gmail.com' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /same inbox/i);
  });
});

describe('F-23 recipient editing — email change = delete + add (AC-73)', () => {
  it('changing an email deletes the old (cancellation) and adds a new (request)', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'pending' });
    const { pool, rows } = mockDb('active', [alice]);
    const email = mockEmail();
    const ctx = ctxFor(pool, email, mockStorage());

    const res = await handleEditSigner(ctx, 'env-1', CREATOR, 'alice@x.com', { new_email: 'alice2@x.com' });
    assert.equal(res.status, 200);
    assert.equal(rows.some((r) => r.email === 'alice@x.com'), false); // old removed
    assert.equal(rows.some((r) => r.email === 'alice2@x.com'), true); // new added
    // two emails: cancellation to old, signing request to new.
    const toOld = email.sent.find((m) => m.to === 'alice@x.com');
    const toNew = email.sent.find((m) => m.to === 'alice2@x.com');
    assert.ok(toOld, 'cancellation to old address');
    assert.match(toOld!.subject, /cancel/i);
    assert.ok(toNew, 'signing request to new address');
    assert.ok((toNew!.attachments ?? []).length === 1, 'new P_i attached');
  });
});

describe('F-23 recipient editing — seal freezes the set (AC-73, 409)', () => {
  it('rejects edit / delete / add once the envelope is sealed (completed)', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'signed', signed_at: new Date() });
    const { pool } = mockDb('completed', [alice]);
    const email = mockEmail();
    const ctx = ctxFor(pool, email, mockStorage());

    assert.equal((await handleEditSigner(ctx, 'env-1', CREATOR, 'alice@x.com', { name: 'X' })).status, 409);
    assert.equal((await handleDeleteSigner(ctx, 'env-1', CREATOR, 'alice@x.com')).status, 409);
    assert.equal((await handleAddSigner(ctx, 'env-1', CREATOR, { email: 'z@x.com' })).status, 409);
    assert.equal(email.sent.length, 0);
  });

  it('allows editing while awaiting_seal (manual-mode review window, F-24.2)', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'signed', signed_at: new Date() });
    const { pool } = mockDb('awaiting_seal', [alice]);
    const email = mockEmail();
    const ctx = ctxFor(pool, email, mockStorage());
    const res = await handleAddSigner(ctx, 'env-1', CREATOR, { email: 'late@x.com', name: 'Late' });
    assert.equal(res.status, 201);
  });

  it('editing a SIGNED signer in an awaiting_seal envelope reverts it to active (Barry QA)', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'signed', signed_at: new Date() });
    const { pool, envelope } = mockDb('awaiting_seal', [alice]);
    const ctx = ctxFor(pool, mockEmail(), mockStorage());
    const res = await handleEditSigner(ctx, 'env-1', CREATOR, 'alice@x.com', { name: 'Alice Smith' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'superseded'); // the edited signer must re-sign
    assert.equal(envelope.status, 'active'); // de-completed → collecting again (Seal hides)
  });

  it('adding a signer to an awaiting_seal envelope reverts it to active (Barry QA)', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'signed', signed_at: new Date() });
    const { pool, envelope } = mockDb('awaiting_seal', [alice]);
    const ctx = ctxFor(pool, mockEmail(), mockStorage());
    const res = await handleAddSigner(ctx, 'env-1', CREATOR, { email: 'late@x.com', name: 'Late' });
    assert.equal(res.status, 201);
    assert.equal(envelope.status, 'active');
  });
});

describe('F-23 recipient editing — creator-scoping', () => {
  it('404 for an unknown envelope, 403 for a non-owner', async () => {
    const alice = signer({ email: 'alice@x.com', name: 'Alice', status: 'pending' });
    const { pool } = mockDb('active', [alice]);
    const email = mockEmail();
    const ctx = ctxFor(pool, email, mockStorage());

    assert.equal((await handleDeleteSigner(ctx, 'does-not-exist', CREATOR, 'alice@x.com')).status, 404);
    assert.equal((await handleDeleteSigner(ctx, 'env-1', 'intruder@evil.com', 'alice@x.com')).status, 403);
  });
});
