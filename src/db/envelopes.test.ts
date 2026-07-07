/**
 * Database layer tests — from spec F1 (Envelope Management).
 *
 * Tests the data access functions with a mock pool.
 * Real DB integration tests would use a test PostgreSQL instance.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEnvelope,
  getEnvelope,
  getEnvelopeSigners,
  getSignerByToken,
  getSignerByEnvelopeAndEmail,
  markSignerSignedByEmail,
  voidEnvelope,
  checkAllSigned,
  getEnvelopesBySender,
  markCompletionEmailSent,
  findSignerByCompletionEmailId,
  getDocumentsByOwner,
  getIncompleteSigners,
  forceExpireEnvelope,
} from './envelopes.js';
import type { DbPool } from './pool.js';
import type { Envelope, EnvelopeSigner } from './types.js';

// In-memory mock that tracks inserts and supports basic queries
function createInMemoryPool() {
  const envelopes: Record<string, any> = {};
  const signers: any[] = [];

  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      // DD-10: createEnvelope issues a single multi-CTE statement.
      // Params layout: envelope $1..$6 (id, sender_email, document_name,
      // document_hash, expiry_at, source_hash), then per-signer batches of 5
      // at $7+ (email, name, verification_level, signing_token, on_behalf_of).
      // token_expires_at reuses $5 (expiry_at).
      if (text.includes('WITH env_ins AS')) {
        const v = values!;
        const env = {
          id: v[0], sender_email: v[1],
          document_name: v[2], document_hash: v[3],
          expiry_at: v[4],
          source_hash: (v[5] as string | null) ?? null,
          status: 'active',
          created_at: new Date(), completed_at: null, pdf_storage_key: null,
          internal_test: false,
        };
        envelopes[env.id as string] = env;

        const signerCount = (v.length - 6) / 6;
        const createdSigners: any[] = [];
        for (let i = 0; i < signerCount; i++) {
          const base = 6 + i * 6;
          const s = {
            id: `s-${signers.length + 1}`, envelope_id: v[0],
            email: v[base], name: v[base + 1],
            verification_level: v[base + 2],
            signing_token: v[base + 3], token_expires_at: v[4],
            on_behalf_of: (v[base + 4] as string | null) ?? null,
            sent_pdf_hash: (v[base + 5] as string | null) ?? null,
            signing_method: null, status: 'pending', signed_at: null,
            reminder_count: 0, last_reminder_at: null,
          };
          signers.push(s);
          createdSigners.push(s);
        }
        return { rows: [{ envelope: env, signers: createdSigners }], rowCount: 1 } as any;
      }
      if (text.includes('FROM envelopes WHERE id')) {
        const e = envelopes[values![0] as string];
        return { rows: e ? [e] : [], rowCount: e ? 1 : 0 } as any;
      }
      if (text.includes('FROM envelope_signers WHERE envelope_id') && text.includes('ORDER BY name') && !text.includes("status = 'pending'") && !text.includes('LIMIT')) {
        return { rows: signers.filter(s => s.envelope_id === values![0]) } as any;
      }
      if (text.includes('FROM envelope_signers WHERE signing_token')) {
        const s = signers.find(s => s.signing_token === values![0]);
        return { rows: s ? [s] : [] } as any;
      }
      // 2F.SG.2: getSignerByEnvelopeAndEmail — envelope_id + case-insensitive email, no ORDER BY.
      if (text.includes('FROM envelope_signers WHERE envelope_id') && text.includes('LOWER(email)')) {
        const [envelopeId, email] = values as [string, string];
        const s = signers.find(
          (s: any) => s.envelope_id === envelopeId && String(s.email).toLowerCase() === String(email).toLowerCase(),
        );
        return { rows: s ? [s] : [], rowCount: s ? 1 : 0 } as any;
      }
      if (text.includes('SET internal_test = true')) {
        const e = envelopes[values![0] as string];
        if (e) { e.internal_test = true; return { rows: [], rowCount: 1 } as any; }
        return { rows: [], rowCount: 0 } as any;
      }
      if (text.includes("status = 'voided'")) {
        const e = envelopes[values![0] as string];
        if (e && e.status === 'active') { e.status = 'voided'; return { rows: [e], rowCount: 1 } as any; }
        return { rows: [], rowCount: 0 } as any;
      }
      if (text.includes("status = 'expired'") && text.includes('WHERE id = $1')) {
        const e = envelopes[values![0] as string];
        if (e && e.status === 'active') { e.status = 'expired'; e.expiry_at = new Date(); return { rows: [e], rowCount: 1 } as any; }
        return { rows: [], rowCount: 0 } as any;
      }
      if (text.includes('COUNT(*)')) {
        const envSigners = signers.filter(s => s.envelope_id === values![0]);
        return { rows: [{ total: String(envSigners.length), signed: String(envSigners.filter((s: any) => s.status === 'signed').length) }] } as any;
      }
      if (text.includes('FROM envelopes WHERE sender_email = $1')) {
        const found = Object.values(envelopes).filter((e: any) => e.sender_email === values![0]);
        return { rows: found } as any;
      }
      // DD-12: mark completion email provider msg id on a signer row
      if (text.includes('SET completion_email_provider_msg_id')) {
        const signer = signers.find((s: any) => s.id === values![0]);
        if (signer) {
          signer.completion_email_provider_msg_id = values![1];
          return { rows: [signer], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      }
      // DD-12: lookup signer by provider msg id (webhook correlation)
      // Use two independent substring checks because the SELECT has a newline
      // between `envelope_signers` and `WHERE` so a contiguous substring fails.
      if (text.includes('envelope_signers') && text.includes('WHERE completion_email_provider_msg_id')) {
        const signer = signers.find((s: any) => s.completion_email_provider_msg_id === values![0]);
        return { rows: signer ? [signer] : [], rowCount: signer ? 1 : 0 } as any;
      }
      // 2F.CD.1: markSignerSignedByEmail — flip signer by envelope_id + email,
      // idempotent via the `status <> 'signed'` guard (re-run = no row matched).
      if (text.includes('UPDATE envelope_signers') && text.includes("status = 'signed'") && text.includes('LOWER(email)')) {
        const [envelopeId, email] = values as [string, string];
        const s = signers.find(
          (s: any) => s.envelope_id === envelopeId &&
            String(s.email).toLowerCase() === String(email).toLowerCase() &&
            s.status !== 'signed',
        );
        if (s) {
          s.status = 'signed'; s.signed_at = new Date(); s.signing_method = 'email';
          return { rows: [{ id: s.id }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };

  return { pool, envelopes, signers };
}

describe('markSignerSignedByEmail (2F.CD.1) — reply-to-sign signer flip', () => {
  async function seed() {
    const { pool, signers } = createInMemoryPool();
    await createEnvelope(pool, {
      sender_email: 'creator@test.com',
      document_name: 'NDA', document_hash: 'c'.repeat(64),
      signers: [{ email: 'Alice@Test.com', name: 'Alice' }],
    }, 'https://kysigned.com');
    return { pool, signers };
  }

  it('flips a pending signer to signed (idempotent UPDATE), case-insensitive email', async () => {
    const { pool, signers } = await seed();
    const flipped = await markSignerSignedByEmail(pool, signers[0].envelope_id, 'alice@test.com');
    assert.equal(flipped, true);
    assert.equal(signers[0].status, 'signed');
    assert.equal(signers[0].signing_method, 'email');
    assert.ok(signers[0].signed_at);
  });

  it('is a no-op (false) when the signer is already signed', async () => {
    const { pool, signers } = await seed();
    await markSignerSignedByEmail(pool, signers[0].envelope_id, 'alice@test.com');
    const again = await markSignerSignedByEmail(pool, signers[0].envelope_id, 'alice@test.com');
    assert.equal(again, false);
    assert.equal(signers[0].status, 'signed');
  });

  it('is a no-op (false) for an unknown signer email', async () => {
    const { pool, signers } = await seed();
    const flipped = await markSignerSignedByEmail(pool, signers[0].envelope_id, 'nobody@test.com');
    assert.equal(flipped, false);
  });
});

describe('DB Envelopes — from spec F1', () => {
  // F1: "Sender creates an envelope with a PDF and 1-5 signers"
  describe('createEnvelope', () => {
    it('should create envelope with signers and return signing links', async () => {
      const { pool } = createInMemoryPool();
      const result = await createEnvelope(pool, {
        sender_email: '0xSender@w.test',
        document_name: 'NDA',
        document_hash: 'a'.repeat(64),
        signers: [
          { email: 'alice@test.com', name: 'Alice' },
          { email: 'bob@test.com', name: 'Bob' },
        ],
      }, 'https://kysigned.com');

      assert.ok(result.envelope.id);
      assert.equal(result.envelope.status, 'active');
      assert.equal(result.signers.length, 2);
      assert.ok(result.signers[0].signing_link.includes('/v1/sign/'));
      assert.ok(result.signers[1].signing_link.includes('/v1/sign/'));
      // Unique tokens
      assert.notEqual(result.signers[0].signing_token, result.signers[1].signing_token);
    });

    // F-22.2 — per-signer "signing on behalf of" organisation.
    it('persists per-signer on_behalf_of (F-22.2); null when absent or blank', async () => {
      const { pool } = createInMemoryPool();
      const result = await createEnvelope(pool, {
        sender_email: 'creator@test.com',
        document_name: 'MSA', document_hash: 'a'.repeat(64),
        signers: [
          { email: 'alice@test.com', name: 'Alice', on_behalf_of: 'Acme Corp' },
          { email: 'bob@test.com', name: 'Bob' },
          { email: 'carol@test.com', name: 'Carol', on_behalf_of: '   ' },
        ],
      }, 'https://kysigned.com');

      const by = (e: string) => result.signers.find((s) => s.email === e)!;
      assert.equal(by('alice@test.com').on_behalf_of, 'Acme Corp');
      assert.equal(by('bob@test.com').on_behalf_of, null, 'absent → null');
      assert.equal(by('carol@test.com').on_behalf_of, null, 'whitespace-only → null');
    });

    // F-3.2 — a blank/missing signer name falls back to the email address.
    it('falls back a blank or missing signer name to the email address (F-3.2)', async () => {
      const { pool } = createInMemoryPool();
      const result = await createEnvelope(pool, {
        sender_email: 'creator@test.com',
        document_name: 'Doc', document_hash: 'b'.repeat(64),
        signers: [
          { email: 'noname@test.com', name: '   ' },
          { email: 'alsomissing@test.com' },
          { email: 'named@test.com', name: 'Dana' },
        ],
      }, 'https://kysigned.com');

      const by = (e: string) => result.signers.find((s) => s.email === e)!;
      assert.equal(by('noname@test.com').name, 'noname@test.com', 'whitespace name → email');
      assert.equal(by('alsomissing@test.com').name, 'alsomissing@test.com', 'missing name → email');
      assert.equal(by('named@test.com').name, 'Dana', 'provided name preserved');
    });
  });

  describe('getSignerByToken', () => {
    it('should find signer by token', async () => {
      const { pool } = createInMemoryPool();
      const created = await createEnvelope(pool, {
        sender_email: '0x1@w.test',
        document_name: 'Doc', document_hash: 'c'.repeat(64),
        signers: [{ email: 'a@t.com', name: 'A' }],
      }, 'https://x.com');

      const token = created.signers[0].signing_token;
      const found = await getSignerByToken(pool, token);
      assert.ok(found);
      assert.equal(found.email, 'a@t.com');
    });

    it('should return null for non-existent token', async () => {
      const { pool } = createInMemoryPool();
      const found = await getSignerByToken(pool, 'nonexistent');
      assert.equal(found, null);
    });
  });

  // 2F.SG.2 / F3.3.6.10(c): inbound membership gate — "is this From an invited signer?"
  describe('getSignerByEnvelopeAndEmail', () => {
    async function seed() {
      const { pool } = createInMemoryPool();
      const created = await createEnvelope(pool, {
        sender_email: '0x1@w.test',
        document_name: 'Doc', document_hash: 'e'.repeat(64),
        signers: [
          { email: 'alice@test.com', name: 'Alice' },
          { email: 'bob@test.com', name: 'Bob' },
        ],
      }, 'https://x.com');
      return { pool, envelopeId: created.envelope.id };
    }

    it('finds an invited signer by exact email', async () => {
      const { pool, envelopeId } = await seed();
      const s = await getSignerByEnvelopeAndEmail(pool, envelopeId, 'alice@test.com');
      assert.ok(s);
      assert.equal(s.email, 'alice@test.com');
      assert.equal(s.status, 'pending'); // returns the full row incl. status (used by F3.7 dup-check)
    });

    it('matches email case-insensitively', async () => {
      const { pool, envelopeId } = await seed();
      const s = await getSignerByEnvelopeAndEmail(pool, envelopeId, 'ALICE@TEST.COM');
      assert.ok(s);
      assert.equal(s.email, 'alice@test.com');
    });

    it('returns null when the email is not an invited signer on this envelope', async () => {
      const { pool, envelopeId } = await seed();
      const s = await getSignerByEnvelopeAndEmail(pool, envelopeId, 'carol@test.com');
      assert.equal(s, null);
    });

    it('returns null when the signer exists but on a DIFFERENT envelope', async () => {
      const { pool } = await seed();
      const s = await getSignerByEnvelopeAndEmail(pool, 'no-such-envelope-id', 'alice@test.com');
      assert.equal(s, null);
    });
  });

  // F1: "Sender voids an active envelope"
  describe('voidEnvelope', () => {
    it('should void an active envelope', async () => {
      const { pool } = createInMemoryPool();
      const created = await createEnvelope(pool, {
        sender_email: '0x1@w.test',
        document_name: 'Doc', document_hash: 'd'.repeat(64),
        signers: [{ email: 'a@t.com', name: 'A' }],
      }, 'https://x.com');

      const voided = await voidEnvelope(pool, created.envelope.id);
      assert.equal(voided.status, 'voided');
    });

    it('should reject voiding a non-active envelope', async () => {
      const { pool, envelopes } = createInMemoryPool();
      const created = await createEnvelope(pool, {
        sender_email: '0x1@w.test',
        document_name: 'Doc', document_hash: 'e'.repeat(64),
        signers: [{ email: 'a@t.com', name: 'A' }],
      }, 'https://x.com');

      await voidEnvelope(pool, created.envelope.id);
      // Try voiding again
      await assert.rejects(() => voidEnvelope(pool, created.envelope.id), /not.*active/i);
    });
  });

  describe('checkAllSigned', () => {
    it('should return false when signers are pending', async () => {
      const { pool } = createInMemoryPool();
      const created = await createEnvelope(pool, {
        sender_email: '0x1@w.test',
        document_name: 'Doc', document_hash: 'f'.repeat(64),
        signers: [{ email: 'a@t.com', name: 'A' }, { email: 'b@t.com', name: 'B' }],
      }, 'https://x.com');

      const result = await checkAllSigned(pool, created.envelope.id);
      assert.equal(result, false);
    });
  });

  describe('getEnvelopesBySender', () => {
    it('should return envelopes for a sender (by email)', async () => {
      const { pool } = createInMemoryPool();
      await createEnvelope(pool, {
        sender_email: '0xMyWallet@w.test',
        document_name: 'Doc1', document_hash: 'g'.repeat(64),
        signers: [{ email: 'a@t.com', name: 'A' }],
      }, 'https://x.com');
      await createEnvelope(pool, {
        sender_email: '0xOther@w.test',
        document_name: 'Doc2', document_hash: 'h'.repeat(64),
        signers: [{ email: 'b@t.com', name: 'B' }],
      }, 'https://x.com');

      const result = await getEnvelopesBySender(pool, '0xMyWallet@w.test');
      assert.equal(result.length, 1);
      assert.equal(result[0].document_name, 'Doc1');
    });
  });

  // DD-12: webhook correlation — stamp the signer row with the email provider's
  // message id at send time, and look it up at webhook-receive time so the
  // webhook handler knows which (envelope_id, email) to mark delivered/bounced.
  describe('markCompletionEmailSent', () => {
    it('should stamp completion_email_provider_msg_id on a known signer and return true', async () => {
      const { pool } = createInMemoryPool();
      const created = await createEnvelope(pool, {
        sender_email: '0x1@w.test',
        document_name: 'Doc', document_hash: 'j'.repeat(64),
        signers: [{ email: 'a@t.com', name: 'A' }],
      }, 'https://x.com');

      const signerId = created.signers[0].id;
      const ok = await markCompletionEmailSent(pool, signerId, 'run402_msg_abc123');
      assert.equal(ok, true);

      // Confirm the row was updated
      const found = await findSignerByCompletionEmailId(pool, 'run402_msg_abc123');
      assert.ok(found);
      assert.equal(found.id, signerId);
      assert.equal(found.completion_email_provider_msg_id, 'run402_msg_abc123');
    });

    it('should return false when signer_id does not exist', async () => {
      const { pool } = createInMemoryPool();
      const ok = await markCompletionEmailSent(pool, 'nonexistent-id', 'run402_msg_xyz');
      assert.equal(ok, false);
    });
  });

  describe('findSignerByCompletionEmailId', () => {
    it('should return the signer row when the provider msg id matches', async () => {
      const { pool } = createInMemoryPool();
      const created = await createEnvelope(pool, {
        sender_email: '0x1@w.test',
        document_name: 'Doc', document_hash: 'k'.repeat(64),
        signers: [{ email: 'b@t.com', name: 'B' }],
      }, 'https://x.com');
      const signerId = created.signers[0].id;
      await markCompletionEmailSent(pool, signerId, 'run402_msg_lookup_1');

      const found = await findSignerByCompletionEmailId(pool, 'run402_msg_lookup_1');
      assert.ok(found);
      assert.equal(found.email, 'b@t.com');
      assert.equal(found.envelope_id, created.envelope.id);
    });

    it('should return null when the provider msg id is not stamped on any signer', async () => {
      const { pool } = createInMemoryPool();
      const found = await findSignerByCompletionEmailId(pool, 'run402_msg_never_sent');
      assert.equal(found, null);
    });
  });

  // F16.B: multi-envelope aggregation — documents grouped by (document_hash, sender_identity)
  describe('getDocumentsByOwner', () => {
    it('should group envelopes by document_hash for the same sender', async () => {
      const { pool } = createInMemoryPool();
      const hash = 'x'.repeat(64);
      // Two envelopes with same doc hash, same sender
      await createEnvelope(pool, {
        sender_email: '0xSender@w.test',
        document_name: 'Contract', document_hash: hash,
        signers: [{ email: 'a@t.com', name: 'A' }],
      }, 'https://x.com');
      await createEnvelope(pool, {
        sender_email: '0xSender@w.test',
        document_name: 'Contract', document_hash: hash,
        signers: [{ email: 'b@t.com', name: 'B' }],
      }, 'https://x.com');

      const docs = await getDocumentsByOwner(pool, '0xSender@w.test');
      assert.equal(docs.length, 1); // One document
      assert.equal(docs[0].documentHash, hash);
      assert.equal(docs[0].envelopes.length, 2);
      assert.equal(docs[0].totalSigners, 2);
    });

    it('should separate different document hashes', async () => {
      const { pool } = createInMemoryPool();
      await createEnvelope(pool, {
        sender_email: '0xSender@w.test',
        document_name: 'Doc A', document_hash: 'a'.repeat(64),
        signers: [{ email: 'a@t.com', name: 'A' }],
      }, 'https://x.com');
      await createEnvelope(pool, {
        sender_email: '0xSender@w.test',
        document_name: 'Doc B', document_hash: 'b'.repeat(64),
        signers: [{ email: 'b@t.com', name: 'B' }],
      }, 'https://x.com');

      const docs = await getDocumentsByOwner(pool, '0xSender@w.test');
      assert.equal(docs.length, 2);
    });

    it('should return empty array for unknown sender', async () => {
      const { pool } = createInMemoryPool();
      const docs = await getDocumentsByOwner(pool, '0xNobody@w.test');
      assert.equal(docs.length, 0);
    });

    it('should count signed vs total signers across envelopes', async () => {
      const { pool, signers: signerStore } = createInMemoryPool();
      const hash = 'y'.repeat(64);
      await createEnvelope(pool, {
        sender_email: '0xSender@w.test',
        document_name: 'Doc', document_hash: hash,
        signers: [{ email: 'a@t.com', name: 'A' }, { email: 'b@t.com', name: 'B' }],
      }, 'https://x.com');
      // Simulate A signed
      signerStore[0].status = 'signed';

      const docs = await getDocumentsByOwner(pool, '0xSender@w.test');
      assert.equal(docs.length, 1);
      assert.equal(docs[0].totalSigners, 2);
      assert.equal(docs[0].signedCount, 1);
    });
  });

  // F16.C: getIncompleteSigners — signers who have NOT signed across any envelope
  describe('getIncompleteSigners', () => {
    it('should return signers who have not signed', async () => {
      const { pool, signers: signerStore } = createInMemoryPool();
      const hash = 'z'.repeat(64);
      await createEnvelope(pool, {
        sender_email: '0xSender@w.test',
        document_name: 'Doc', document_hash: hash,
        signers: [{ email: 'a@t.com', name: 'A' }, { email: 'b@t.com', name: 'B' }],
      }, 'https://x.com');
      // A signed, B still pending
      signerStore[0].status = 'signed';

      const incomplete = await getIncompleteSigners(pool, hash, '0xSender@w.test');
      assert.equal(incomplete.length, 1);
      assert.equal(incomplete[0].email, 'b@t.com');
    });

    it('should return empty when all signers have signed', async () => {
      const { pool, signers: signerStore } = createInMemoryPool();
      const hash = 'w'.repeat(64);
      await createEnvelope(pool, {
        sender_email: '0xSender@w.test',
        document_name: 'Doc', document_hash: hash,
        signers: [{ email: 'a@t.com', name: 'A' }],
      }, 'https://x.com');
      signerStore[0].status = 'signed';

      const incomplete = await getIncompleteSigners(pool, hash, '0xSender@w.test');
      assert.equal(incomplete.length, 0);
    });

    it('should deduplicate signers across multiple envelopes', async () => {
      const { pool } = createInMemoryPool();
      const hash = 'v'.repeat(64);
      // Two envelopes with same signer b@t.com — both pending
      await createEnvelope(pool, {
        sender_email: '0xSender@w.test',
        document_name: 'Doc', document_hash: hash,
        signers: [{ email: 'b@t.com', name: 'B' }],
      }, 'https://x.com');
      await createEnvelope(pool, {
        sender_email: '0xSender@w.test',
        document_name: 'Doc', document_hash: hash,
        signers: [{ email: 'b@t.com', name: 'B' }],
      }, 'https://x.com');

      const incomplete = await getIncompleteSigners(pool, hash, '0xSender@w.test');
      // b@t.com appears in both envelopes but should be returned only once
      assert.equal(incomplete.length, 1);
      assert.equal(incomplete[0].email, 'b@t.com');
    });
  });

  // P4B.33: force-expire for admin/e2e
  describe('forceExpireEnvelope', () => {
    it('should force-expire an active envelope', async () => {
      const { pool } = createInMemoryPool();
      const created = await createEnvelope(pool, {
        sender_email: '0x1@w.test',
        document_name: 'Doc', document_hash: 'q'.repeat(64),
        signers: [{ email: 'a@t.com', name: 'A' }],
      }, 'https://x.com');

      const expired = await forceExpireEnvelope(pool, created.envelope.id);
      assert.equal(expired.status, 'expired');
    });

    it('should reject force-expire on a non-active envelope', async () => {
      const { pool } = createInMemoryPool();
      const created = await createEnvelope(pool, {
        sender_email: '0x1@w.test',
        document_name: 'Doc', document_hash: 'r'.repeat(64),
        signers: [{ email: 'a@t.com', name: 'A' }],
      }, 'https://x.com');
      await voidEnvelope(pool, created.envelope.id);

      await assert.rejects(() => forceExpireEnvelope(pool, created.envelope.id), /not.*active/i);
    });
  });
});
