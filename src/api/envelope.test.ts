/**
 * Envelope API tests — written from spec acceptance criteria F1, F6, F7.
 *
 * Tests the API handler logic with mock DB and email provider.
 *
 * v0.19.0 / 2F.L3.2: handleCreateEnvelope now assembles a canonical PDF
 * (cover + source) via pdf-lib per F22.1, so the source `pdf_base64` MUST
 * be a real PDF byte sequence (pdf-lib's `PDFDocument.load()` rejects
 * garbage bytes). Use TEST_FIXTURE_PDF_B64 below for all envelope-create
 * tests.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleCreateEnvelope,
  handleGetEnvelope,
  handleVoidEnvelope,
  handleRemind,
  handleListEnvelopes,
  handleListDocuments,
  notifyEnvelopeExpired,  handleResendToMissing,
  handleUndeliverableSigningRequest,
  isUndeliverableRecipientError,
  deliveryStatus,
  unsubscribeHeader,
} from './envelope.js';
import type { DbPool } from '../db/pool.js';
import { emitAppEvent as seamEmitAppEvent } from '../integrations/appEvents.js';
import type { EmailProvider, EmailMessage } from '../email/types.js';
import type { Envelope, EnvelopeSigner } from '../db/types.js';

describe('unsubscribeHeader — List-Unsubscribe is operator-configurable (F-19 / AC-39 forkability)', () => {
  it('uses the configured mailto (kysigned.com pins legal@kychee.com)', () => {
    assert.deepEqual(
      unsubscribeHeader({ unsubscribeMailto: 'legal@kychee.com' } as any),
      { 'List-Unsubscribe': '<mailto:legal@kychee.com>' },
    );
  });
  it('a forker that sets nothing derives legal@<operatorDomain> — no Kychee address baked in', () => {
    assert.deepEqual(
      unsubscribeHeader({ operatorDomain: 'sign.lawfirmx.example' } as any),
      { 'List-Unsubscribe': '<mailto:legal@sign.lawfirmx.example>' },
    );
  });
});

/**
 * Minimal valid PDF for envelope-create tests under v0.19.0 (F22.1
 * canonical-PDF assembly requires a parseable PDF source). Pre-computed
 * via pdf-lib so tests stay synchronous at the module-loading boundary.
 */
const TEST_FIXTURE_PDF_B64 =
  'JVBERi0xLjcKJYGBgYEKCjEgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFsgNCAwIFIgXQovQ291bnQgMQo+PgplbmRvYmoKCjIgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCj4+CmVuZG9iagoKMyAwIG9iago8PAovUHJvZHVjZXIgPEZFRkYwMDc0MDA2NTAwNzMwMDc0MDAyRDAwNjYwMDY5MDA3ODAwNzQwMDc1MDA3MjAwNjU+Ci9Nb2REYXRlIChEOjIwMjAwMTAxMDAwMDAwWikKL0NyZWF0b3IgPEZFRkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyMDAwMjgwMDY4MDA3NDAwNzQwMDcwMDA3MzAwM0EwMDJGMDAyRjAwNjcwMDY5MDA3NDAwNjgwMDc1MDA2MjAwMkUwMDYzMDA2RjAwNkQwMDJGMDA0ODAwNkYwMDcwMDA2NDAwNjkwMDZFMDA2NzAwMkYwMDcwMDA2NDAwNjYwMDJEMDA2QzAwNjkwMDYyMDAyOT4KL0NyZWF0aW9uRGF0ZSAoRDoyMDIwMDEwMTAwMDAwMFopCi9UaXRsZSA8RkVGRjAwNzQwMDY1MDA3MzAwNzQ+Cj4+CmVuZG9iagoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9SZXNvdXJjZXMgPDwKL0ZvbnQgPDwKL0hlbHZldGljYS03MDk4NDgwNzg5IDUgMCBSCj4+Ci9YT2JqZWN0IDw8Cj4+Ci9FeHRHU3RhdGUgPDwKPj4KPj4KL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXQovQW5ub3RzIFsgXQovQ29udGVudHMgWyA2IDAgUiBdCj4+CmVuZG9iagoKNSAwIG9iago8PAovVHlwZSAvRm9udAovU3VidHlwZSAvVHlwZTEKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCgo2IDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggOTYKPj4Kc3RyZWFtCnicK+RyCuEyUADBonQufY/UnLLUkszkRF1zA0sLEwsDcwtLBSMThZA0LhDpw2UIVgohQ3K5bMxNzEzNjc1NjAzMzMwszS3MTcxNzY3MTO0UQrK4QrS4XEO4ArkAobMWLQplbmRzdHJlYW0KZW5kb2JqCgp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTYgMDAwMDAgbiAKMDAwMDAwMDA3NiAwMDAwMCBuIAowMDAwMDAwMTI2IDAwMDAwIG4gCjAwMDAwMDA0OTggMDAwMDAgbiAKMDAwMDAwMDY5MyAwMDAwMCBuIAowMDAwMDAwNzkxIDAwMDAwIG4gCgp0cmFpbGVyCjw8Ci9TaXplIDcKL1Jvb3QgMiAwIFIKL0luZm8gMyAwIFIKPj4KCnN0YXJ0eHJlZgo5NTkKJSVFT0Y=';

// --- Mocks ---

function createMockEmailProvider(): EmailProvider & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(msg: EmailMessage) {
      sent.push(msg);
      return { messageId: `msg-${sent.length}` };
    },
  };
}

// Simple in-memory DB mock for envelope operations
function createMockDb() {
  const envelopes: Envelope[] = [];
  const signers: EnvelopeSigner[] = [];
  const allowed: any[] = [];
  const usage: any[] = [];
  const artifacts: any[] = [];
  // SS.2 / DD-97: captures the creator's saved-name upserts (account_email -> display_name).
  const creatorProfiles = new Map<string, string>();

  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];
      // --- allowed_senders / usage (F2.8) ---
      if (text.includes('INSERT INTO allowed_senders')) {
        const existing = allowed.find((a) => a.identity_type === v[0] && a.identity === v[1]);
        if (existing) {
          existing.quota_per_month = v[2]; existing.added_by = v[3]; existing.note = v[4];
          return { rows: [existing], rowCount: 1 } as any;
        }
        const row = { id: `as-${allowed.length + 1}`, identity_type: v[0], identity: v[1],
          quota_per_month: v[2], added_by: v[3], note: v[4], added_at: new Date() };
        allowed.push(row);
        return { rows: [row], rowCount: 1 } as any;
      }
      if (text.includes("identity_type = 'email_domain'")) {
        const email = v[0] as string;
        const domain = v[1] as string;
        const exact = allowed.find((a) => a.identity_type === 'email' && a.identity === email);
        if (exact) return { rows: [exact], rowCount: 1 } as any;
        const dom = allowed.find((a) => a.identity_type === 'email_domain' && a.identity === domain);
        return { rows: dom ? [dom] : [], rowCount: dom ? 1 : 0 } as any;
      }
      if (text.includes('SELECT * FROM allowed_senders WHERE identity_type')) {
        const row = allowed.find((a) => a.identity_type === v[0] && a.identity === v[1]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } as any;
      }
      if (text.includes('INSERT INTO allowed_sender_usage')) {
        const existing = usage.find((u) => u.identity_type === v[0] && u.identity === v[1] && u.period === v[2]);
        if (existing) { existing.count += 1; return { rows: [existing], rowCount: 1 } as any; }
        const row = { identity_type: v[0], identity: v[1], period: v[2], count: 1 };
        usage.push(row);
        return { rows: [row], rowCount: 1 } as any;
      }
      if (text.includes('FROM allowed_sender_usage')) {
        const row = usage.find((u) => u.identity_type === v[0] && u.identity === v[1] && u.period === v[2]);
        return { rows: row ? [{ count: String(row.count) }] : [{ count: '0' }] } as any;
      }
      // DD-10: createEnvelope now issues a single multi-CTE statement.
      // Params layout: envelope $1..$10, then signer batches of 8 at $11+
      // (F-22 added on_behalf_of as the 8th per-signer param).
      // F-3.7 — markEnvelopeInternalTest UPDATE.
      if (text.includes('SET internal_test = true')) {
        const e = envelopes.find((x: any) => x.id === values![0]);
        if (e) { (e as any).internal_test = true; return { rows: [], rowCount: 1 } as any; }
        return { rows: [], rowCount: 0 } as any;
      }
      // F-24.3 — setEnvelopeAutoClose UPDATE.
      if (text.includes('SET auto_close = $2')) {
        const e = envelopes.find((x: any) => x.id === values![0]);
        if (e) { (e as any).auto_close = values![1]; return { rows: [], rowCount: 1 } as any; }
        return { rows: [], rowCount: 0 } as any;
      }
      // F-9.8 — markSignerUndeliverable UPDATE (pending + not-yet-stamped only).
      if (text.includes('SET undeliverable_at = now()')) {
        const [envId, email] = values as [string, string];
        const s = signers.find((x: any) =>
          x.envelope_id === envId &&
          String(x.email).toLowerCase() === String(email).toLowerCase() &&
          x.status === 'pending' && x.undeliverable_at == null);
        if (s) { (s as any).undeliverable_at = new Date(); return { rows: [s], rowCount: 1 } as any; }
        return { rows: [], rowCount: 0 } as any;
      }
      // Returns one row { envelope, signers } instead of separate insert results.
      // Params layout: envelope $1..$6 (id, sender_email, document_name,
      // document_hash, expiry_at, source_hash), then per-signer batches of 5 at
      // $7+ (email, name, verification_level, signing_token, on_behalf_of).
      // token_expires_at reuses $5 (expiry_at).
      if (text.includes('WITH env_ins AS')) {
        const vv = values!;
        const env: Envelope = {
          id: vv[0] as string,
          sender_email: vv[1] as any,
          document_name: vv[2] as string,
          document_hash: vv[3] as string,
          expiry_at: vv[4] as any,
          source_hash: (vv[5] as string | null) ?? null,
          status: 'active',
          auto_close: true,
          created_at: new Date(),
          completed_at: null,
          pdf_storage_key: null,
          pdf_deleted_at: null,
          consent_language_version: '1.0',
          completion_distributed_at: null,
          internal_test: false,
        };
        envelopes.push(env);

        const signerCount = (vv.length - 6) / 6;
        const createdSigners: EnvelopeSigner[] = [];
        for (let i = 0; i < signerCount; i++) {
          const base = 6 + i * 6;
          const s: EnvelopeSigner = {
            id: `signer-${signers.length + 1}`,
            envelope_id: vv[0] as string,
            email: vv[base] as string,
            name: vv[base + 1] as string,
            verification_level: vv[base + 2] as any,
            signing_token: vv[base + 3] as string,
            on_behalf_of: (vv[base + 4] as string | null) ?? null,
            sent_pdf_hash: (vv[base + 5] as string | null) ?? null,
            token_expires_at: vv[4] as any,
            signing_method: null,
            status: 'pending',
            signed_at: null,
            reminder_count: 0,
            last_reminder_at: null,
            completion_email_delivered_at: null,
            completion_email_bounced_at: null,
            completion_email_provider_msg_id: null,
            undeliverable_at: null,
          };
          signers.push(s);
          createdSigners.push(s);
        }
        return { rows: [{ envelope: env, signers: createdSigners }], rowCount: 1 } as any;
      }
      // DD-16: getExpiredEnvelopes — UPDATE active envelopes past expiry to 'expired'
      if (text.includes("SET status = 'expired'")) {
        const now = new Date();
        const expired: Envelope[] = [];
        for (const e of envelopes) {
          if (e.status === 'active' && e.expiry_at && new Date(e.expiry_at) < now) {
            e.status = 'expired';
            expired.push(e);
          }
        }
        return { rows: expired, rowCount: expired.length } as any;
      }
      // SELECT envelope by id
      if (text.includes('FROM envelopes WHERE id')) {
        const found = envelopes.find(e => e.id === values![0]);
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 } as any;
      }
      // SELECT outstanding signers (pending OR superseded) — manual remind / void notify.
      if (text.includes('FROM envelope_signers WHERE envelope_id') && text.includes("status IN ('pending', 'superseded')")) {
        const found = signers.filter(s => s.envelope_id === values![0] && (s.status === 'pending' || s.status === 'superseded'));
        return { rows: found, rowCount: found.length } as any;
      }
      // SELECT signers by envelope (unfiltered)
      if (text.includes('FROM envelope_signers WHERE envelope_id') && !text.includes('status')) {
        const found = signers.filter(s => s.envelope_id === values![0]);
        return { rows: found, rowCount: found.length } as any;
      }
      // SELECT pending signers (legacy single-status filter)
      if (text.includes("status = 'pending'")) {
        const found = signers.filter(s => s.envelope_id === values![0] && s.status === 'pending');
        return { rows: found, rowCount: found.length } as any;
      }
      // UPDATE void
      if (text.includes("status = 'voided'")) {
        const env = envelopes.find(e => e.id === values![0] && e.status === 'active');
        if (env) { env.status = 'voided'; return { rows: [env], rowCount: 1 } as any; }
        return { rows: [], rowCount: 0 } as any;
      }
      // UPDATE pdf_deleted_at
      if (text.includes('pdf_deleted_at = $2')) {
        const env = envelopes.find(e => e.id === values![0]);
        if (env) { (env as any).pdf_deleted_at = values![1]; return { rows: [env], rowCount: 1 } as any; }
        return { rows: [], rowCount: 0 } as any;
      }
      // UPDATE reminder
      if (text.includes('reminder_count = reminder_count + 1')) {
        const s = signers.find(s => s.id === values![0]);
        if (s) { s.reminder_count++; s.last_reminder_at = new Date(); }
        return { rows: [], rowCount: 0 } as any;
      }
      // F16.B / getEnvelopesBySender / getDocumentsByOwner — by sender_email (email-only creator).
      if (text.includes('FROM envelopes WHERE sender_email')) {
        const found = envelopes.filter(e => (e as any).sender_email === values![0]);
        return { rows: found, rowCount: found.length } as any;
      }
      // SS.2 / DD-97: capture the creator's saved-name upsert.
      if (text.includes('INSERT INTO creator_profiles')) {
        creatorProfiles.set(v[0] as string, v[1] as string);
        return { rows: [], rowCount: 1 } as any;
      }
      // Dashboard evidence join (listEnvelopeSignatureArtifacts).
      if (text.includes('FROM signature_artifacts WHERE envelope_id')) {
        const found = artifacts.filter((a) => a.envelope_id === values![0]);
        return { rows: found, rowCount: found.length } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };

  return { pool, envelopes, signers, creatorProfiles, artifacts };
}

// --- Tests ---

describe('Envelope API — from spec acceptance criteria', () => {
  let db: ReturnType<typeof createMockDb>;
  let email: ReturnType<typeof createMockEmailProvider>;

  beforeEach(() => {
    db = createMockDb();
    email = createMockEmailProvider();
  });

  // F1: "Sender creates an envelope with a PDF and 1-5 signers; receives envelope_id, status_url, verify_url, and individual signing links per signer"
  describe('POST /v1/envelope', () => {
    it('should create envelope and return envelope_id, status_url, verify_url, signing_links', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          document_name: 'NDA',
          pdf_base64: TEST_FIXTURE_PDF_B64,
          signers: [
            { email: 'alice@example.com', name: 'Alice' },
            { email: 'bob@example.com', name: 'Bob' },
          ],
        }
      );

      assert.equal(result.status, 201);
      assert.ok(result.body.envelope_id);
      assert.ok(result.body.status_url);
      assert.ok(result.body.verify_url);
      assert.ok(result.body.signing_links);
      assert.equal(result.body.signing_links!.length, 2);
      assert.ok(result.body.document_hash); // SHA-256 computed
    });

    // F-017 (system-test Cycle 14): a fetched/decoded blob that is NOT a valid PDF
    // must be a clean, taxonomy-coded 400 — never the uncoded 500 that pdf-lib's
    // PDFDocument.load throws deep in per-signer assembly. NOT an SSRF case.
    it('rejects a non-PDF pdf_url with a coded 400 (validation_pdf_url), not an uncoded 500 (F-017)', async () => {
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender',
          // A successful fetch of a real, public, non-PDF resource (e.g. a README).
          fetchPdf: async () => new TextEncoder().encode('# Not a PDF\n\nJust markdown.\n'),
        },
        {
          document_name: 'NDA',
          pdf_url: 'https://raw.githubusercontent.com/kychee-com/kysigned/main/README.md',
          signers: [{ email: 'a@b.com', name: 'A' }],
        }
      );
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'validation_pdf_url');
    });

    it('rejects a non-PDF pdf_base64 with a coded 400 (validation_pdf), not an uncoded 500 (F-017)', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          document_name: 'NDA',
          pdf_base64: Buffer.from('this is plainly not a pdf').toString('base64'),
          signers: [{ email: 'a@b.com', name: 'A' }],
        }
      );
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'validation_pdf');
    });

    // F1: "API response includes a list of individual signing links per signer"
    it('should return unique signing links per signer', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          document_name: 'Contract',
          pdf_base64: TEST_FIXTURE_PDF_B64,
          signers: [
            { email: 'a@test.com', name: 'A' },
            { email: 'b@test.com', name: 'B' },
          ],
        }
      );

      const links = result.body.signing_links!.map((s: any) => s.link);
      assert.equal(new Set(links).size, 2); // All unique
      // `link` stays the programmatic signer-token API base (GET /v1/sign/:id/:token/info + POST-to-sign).
      assert.ok(links.every((l: string) => l.includes('/v1/sign/')));
      // F-011: each entry ALSO carries a browser-openable review_link (/review/:id/:token), so a
      // creator who copies a link out-of-band hands the signer a working URL, not the 404-in-browser API base.
      const reviewLinks = result.body.signing_links!.map((s: any) => s.review_link);
      assert.equal(new Set(reviewLinks).size, 2); // unique per signer
      assert.ok(reviewLinks.every((l: string) => typeof l === 'string' && l.includes('/review/')));
      assert.ok(reviewLinks.every((l: string) => !l.includes('/v1/sign/')));
    });

    // F-3.2a / #96: same-inbox + plus-alias signer guard (AC-88 / AC-89)
    it('rejects a plus-alias signer address at creation with a 400 (AC-89)', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          document_name: 'NDA',
          pdf_base64: TEST_FIXTURE_PDF_B64,
          signers: [
            { email: 'user@example.com', name: 'User' },
            { email: 'user+tester@example.com', name: 'User (alias)' },
          ],
        }
      );
      assert.equal(result.status, 400);
      assert.match(result.body.error, /user\+tester@example\.com/);
      assert.match(result.body.error, /plus-alias/i);
    });

    it('rejects two signers that resolve to the same inbox with a 400 (AC-88)', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          document_name: 'NDA',
          pdf_base64: TEST_FIXTURE_PDF_B64,
          signers: [
            { email: 'Alice@example.com', name: 'Alice' },
            { email: 'alice@example.com', name: 'Alice 2' },
          ],
        }
      );
      assert.equal(result.status, 400);
      assert.match(result.body.error, /same inbox/i);
    });

    // #110: the cover draws names in an embedded Unicode font (Latin/Greek/Cyrillic/
    // Hebrew/Arabic). Those scripts now render; only a char the font can't draw (CJK,
    // Japanese, Korean) is rejected — a clean 400 with the supported-languages FAQ
    // pointer, never the opaque 500 the old WinAnsi throw produced. These full-create
    // tests also exercise the real cover-render path (a font failure would 500).
    it('#110: ACCEPTS a Hebrew document name → 201 (was a hard reject pre-#110)', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          document_name: 'הסכם סודיות', // Hebrew (contains ו U+05D5 — the #110 repro)
          pdf_base64: TEST_FIXTURE_PDF_B64,
          signers: [{ email: 'signer@example.com', name: 'Alice' }],
        }
      );
      assert.equal(result.status, 201);
    });

    it('#110: ACCEPTS Cyrillic + Hebrew signer names → 201', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          document_name: 'NDA',
          pdf_base64: TEST_FIXTURE_PDF_B64,
          signers: [
            { email: 'a@example.com', name: 'Александр Солженицын' },
            { email: 'b@example.com', name: 'דוד כהן' },
          ],
        }
      );
      assert.equal(result.status, 201);
    });

    it('#110: rejects a CJK DOCUMENT name → clean 400 naming the char + FAQ (not 500)', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          document_name: '契約書', // CJK — the embedded font has no glyph for these
          pdf_base64: TEST_FIXTURE_PDF_B64,
          signers: [{ email: 'signer@example.com', name: 'Alice' }],
        }
      );
      assert.equal(result.status, 400);
      assert.match(result.body.error, /document name/i);
      assert.match(result.body.error, /Chinese, Japanese, and Korean/);
      assert.match(result.body.error, /FAQ/i);
    });

    it('#110: rejects a CJK signer name → clean 400 naming the field + FAQ (not 500)', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          document_name: 'NDA',
          pdf_base64: TEST_FIXTURE_PDF_B64,
          signers: [{ email: 'lei@example.com', name: '李雷' }], // 李雷 (CJK)
        }
      );
      assert.equal(result.status, 400);
      assert.match(result.body.error, /name/i);
      assert.match(result.body.error, /FAQ/i);
    });

    it('still accepts a WinAnsi-encodable accented name like "José" (no over-rejection)', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          document_name: 'NDA',
          pdf_base64: TEST_FIXTURE_PDF_B64,
          signers: [{ email: 'jose@example.com', name: 'José' }], // é is WinAnsi (0xE9)
        }
      );
      assert.equal(result.status, 201);
    });

    // F7: "Signing request email received by signer"
    it('should send signing request email to each signer (parallel)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'sender@acme.com' },
        {
          document_name: 'NDA',
          pdf_base64: TEST_FIXTURE_PDF_B64,
          signers: [
            { email: 'alice@test.com', name: 'Alice' },
            { email: 'bob@test.com', name: 'Bob' },
          ],
        }
      );

      // The creator (email-only) also receives one "Envelope created" confirmation;
      // assert specifically on the signing-request emails sent to the signers.
      const requests = email.sent.filter((m) => /^Signature requested:/.test(m.subject ?? ''));
      assert.equal(requests.length, 2);
      assert.equal(requests[0].to, 'alice@test.com');
      assert.equal(requests[1].to, 'bob@test.com');
    });

    // Family B (DD-9): each signer signs their OWN canonical PDF P_i = cover_i ++ D
    // (the cover names them), so the two signing requests carry DIFFERENT attachments.
    it('Family B: each signer receives their own per-signer canonical PDF (different attachments)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'sender@acme.com' },
        {
          document_name: 'NDA',
          pdf_base64: TEST_FIXTURE_PDF_B64,
          signers: [
            { email: 'alice@test.com', name: 'Alice' },
            { email: 'bob@test.com', name: 'Bob', on_behalf_of: 'Acme Corp' },
          ],
        }
      );
      const requests = email.sent.filter((m) => /^Signature requested:/.test(m.subject ?? ''));
      const att = (to: string) =>
        requests.find((m) => m.to === to)?.attachments?.[0]?.content as Uint8Array | undefined;
      const aliceAtt = att('alice@test.com');
      const bobAtt = att('bob@test.com');
      assert.ok(aliceAtt && bobAtt, 'both signing requests carry a PDF attachment');
      assert.notEqual(
        Buffer.from(aliceAtt).toString('hex'),
        Buffer.from(bobAtt).toString('hex'),
        'each signer receives their own per-signer P_i (cover names them)',
      );
    });

    it('should reject request with no PDF', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0x1' },
        { document_name: 'NDA', signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      assert.equal(result.status, 400);
    });

    it('should reject request with no signers', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0x1' },
        { document_name: 'NDA', pdf_base64: 'abc', signers: [] }
      );
      assert.equal(result.status, 400);
    });

    it('should reject an envelope with more than 20 signers (MAX_SIGNERS_PER_ENVELOPE)', async () => {
      const signers = Array.from({ length: 21 }, (_, i) => ({ email: `s${i}@b.com`, name: `S${i}` }));
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0x1' },
        { document_name: 'NDA', pdf_base64: 'abc', signers },
      );
      assert.equal(result.status, 400);
      assert.match(String((result.body as { error?: string }).error), /at most 20 signers/i);
    });

    // v0.4.0 create gate (F-3.1 / F-3.6 / F-13, AC-5) — 401 / 403 / 402 / 201.
    it('403 when allowedCreators is configured and excludes the creator (F-3.6)', async () => {
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://x.com',
          senderIdentity: 'mallory@evil.com',
          allowedCreators: ['alice@kychee.com'],
        },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      assert.equal(result.status, 403);
      assert.match(String(result.body.error), /allowlist/i);
      assert.equal(db.envelopes.length, 0);
      assert.equal(email.sent.length, 0);
    });

    it('201 for a creator on the allowedCreators allowlist', async () => {
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://x.com',
          senderIdentity: 'alice@kychee.com',
          allowedCreators: ['alice@kychee.com'],
        },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      assert.equal(result.status, 201);
    });

    it('201 when no allowlist is configured — any authenticated funded creator (F-3.6)', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: 'anyone@x.com' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      assert.equal(result.status, 201);
    });

    it('401 when there is no authenticated creator identity (F-3.1)', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '   ' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      assert.equal(result.status, 401);
      assert.equal(db.envelopes.length, 0);
    });

    it('402 when the creator has insufficient envelope credit (F-13)', async () => {
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com',
          senderIdentity: 'broke@x.com',
          senderGate: { getCreditBalance: async () => 0 },
        },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      assert.equal(result.status, 402);
      assert.equal(db.envelopes.length, 0);
      assert.equal(email.sent.length, 0);
    });

    // F-3.5 / AC-7 — size guard at creation.
    it('413 when the estimated bundle exceeds the ceiling, naming the math (F-3.5/AC-7)', async () => {
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://x.com',
          senderIdentity: 'alice@x.com',
          bundleSizeCeilingBytes: 100, // tiny ceiling — any real document exceeds it
        },
        { document_name: 'Big', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      assert.equal(result.status, 413);
      assert.match(String(result.body.error), /too large/i);
      assert.ok(result.body.estimated_bundle_bytes > result.body.ceiling_bytes, 'estimate over ceiling');
      assert.equal(result.body.signer_count, 1);
      assert.equal(db.envelopes.length, 0, 'no envelope created when oversize');
      assert.equal(email.sent.length, 0, 'no email sent when oversize');
    });

    // F-004 (system-test cycle 3) / F-3.5a / AC-7 — BACKEND upload-size guard.
    // The frontend pdfSize.ts caps pdf_base64 at 3 MB, but API/agent clients bypass
    // it. A 3-6 MiB pdf_base64 reaches kysigned-api and CRASHES it (502) during PDF
    // processing instead of a clean 400. The guard must check the RAW DECODED bytes
    // against MAX_PDF_BYTES (3,000,000) BEFORE any PDF parsing/assembly.
    it('400 (sized message), not a crash, when pdf_base64 decodes over the 3 MB upload cap (F-004)', async () => {
      // ~3.5 MiB of bytes — NOT a valid PDF on purpose: if the guard runs BEFORE
      // parsing (as required), invalid-but-oversize bytes still yield a clean 400.
      // A small bundle ceiling is irrelevant here; this must be the UPLOAD guard,
      // not the 413 bundle-ceiling, so we leave the default 15 MiB ceiling in place.
      const oversize = Buffer.alloc(3_548_000, 0x41).toString('base64');
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com',
          senderIdentity: 'alice@x.com',
          // ZERO credit: proves the upload guard fires BEFORE the 402 credit gate —
          // an oversize upload is a malformed-input 400 regardless of balance.
          senderGate: { getCreditBalance: async () => 0 },
        },
        { document_name: 'Too big', pdf_base64: oversize, signers: [{ email: 'a@b.com', name: 'A' }] },
      );
      assert.equal(result.status, 400, 'a clean 400 (upload guard before the 402/413/crash)');
      assert.match(String(result.body.error), /too large/i);
      assert.match(String(result.body.error), /3 MB/, 'states the 3 MB maximum');
      assert.equal(db.envelopes.length, 0, 'no envelope created');
      assert.equal(email.sent.length, 0, 'no email sent');
    });

    it('a pdf_base64 just under the 3 MB cap is NOT rejected by the upload guard', async () => {
      // Just under MAX_PDF_BYTES: the upload guard must pass it through (it will
      // fail later on PDF parsing since these aren't real PDF bytes, but NOT with
      // the "too large" upload message — proving the guard's boundary is correct).
      const underCap = Buffer.alloc(2_900_000, 0x41).toString('base64');
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'alice@x.com' },
        { document_name: 'Under cap', pdf_base64: underCap, signers: [{ email: 'a@b.com', name: 'A' }] },
      ).catch((e) => ({ status: 0, body: { error: String(e) } }));
      assert.doesNotMatch(String(result.body.error ?? ''), /maximum is 3 MB/, 'under-cap must not hit the upload guard');
    });

    // F-3.7 / AC-8 — internal-test envelopes.
    it('403 when a non-internal account requests an internal-test envelope (AC-8)', async () => {
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://x.com',
          senderIdentity: 'outsider@external.com',
          internalTestDomains: ['kychee.com'],
        },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, internal_test: true, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      assert.equal(result.status, 403);
      assert.match(String(result.body.error), /internal/i);
      assert.equal(db.envelopes.length, 0);
    });

    it('an internal account\'s internal-test envelope deducts no credit and is marked (AC-8)', async () => {
      let deductCalled = false;
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com',
          senderIdentity: 'qa@kychee.com',
          internalTestDomains: ['kychee.com'],
          senderGate: {
            getCreditBalance: async () => 0, // zero balance — would 402 for a normal envelope
            deductCredit: async () => { deductCalled = true; return { ok: true }; },
          },
        },
        { document_name: 'Internal', pdf_base64: TEST_FIXTURE_PDF_B64, internal_test: true, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      assert.equal(result.status, 201, 'internal-test bypasses the 402 credit gate');
      assert.equal(deductCalled, false, 'no credit deducted for internal-test');
      const env = db.envelopes.find((e) => e.id === result.body.envelope_id);
      assert.ok(env?.internal_test, 'envelope marked internal_test');
    });

    // F-005 (system-test cycle 4): a create request that OMITS document_name (a raw
    // API/agent client bypassing the typed SPA) crashed the cover-page renderer
    // (`wrapToWidth(undefined).split` → 500), not the spec's clean 400. The Red Team
    // hit this on internal_test:true (the only path a $0 @kychee.com account reaches
    // past the gate). A missing/blank/non-string document_name must be a clean 400.
    it('400 (not a 500 crash) when document_name is missing — internal_test:true path (F-005)', async () => {
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com',
          senderIdentity: 'qa@kychee.com', internalTestDomains: ['kychee.com'],
          senderGate: { getCreditBalance: async () => 0 },
        },
        // No document_name — a raw client may omit it; the handler must reject 400.
        { pdf_base64: TEST_FIXTURE_PDF_B64, internal_test: true, signers: [{ email: 'a@b.com', name: 'A' }] } as never,
      ).catch((e) => ({ status: 500, body: { error: `THREW: ${e}` } }));
      assert.equal(result.status, 400, `missing document_name must be 400, got ${result.status} (${JSON.stringify(result.body)})`);
      assert.match(String(result.body.error), /document/i);
      assert.equal(db.envelopes.length, 0, 'no envelope created');
    });

    it('400 when document_name is a non-string (e.g. number) — F-005 class', async () => {
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com',
          senderIdentity: 'qa@kychee.com', internalTestDomains: ['kychee.com'],
          senderGate: { getCreditBalance: async () => 0 },
        },
        { document_name: 123 as never, pdf_base64: TEST_FIXTURE_PDF_B64, internal_test: true, signers: [{ email: 'a@b.com', name: 'A' }] } as never,
      ).catch((e) => ({ status: 500, body: { error: `THREW: ${e}` } }));
      assert.equal(result.status, 400, `non-string document_name must be 400, got ${result.status}`);
    });

    // F7: "Spam notice displayed to sender"
    it('should include spam notice in response', async () => {
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0x1' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      assert.ok(result.body.spam_notice);
      assert.ok(result.body.spam_notice.toLowerCase().includes('spam'));
    });

    // F-13 — flat per-envelope credit debit after a successful create.
    it('debits a flat $0.25 (250_000 micros) after creation (F-13.1)', async () => {
      let deductedAmount = 0;
      let deductedEnvelopeId = '';
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com',
          senderIdentity: 'alice@example.com',
          senderGate: {
            getCreditBalance: async () => 1_000_000,
            deductCredit: async (_identity, amount, envId) => {
              deductedAmount = amount; deductedEnvelopeId = envId; return { ok: true };
            },
          },
        },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'Credit Test', signers: [{ email: 'bob@t.com', name: 'Bob' }] },
      );
      assert.equal(result.status, 201);
      assert.equal(deductedAmount, 250_000);
      assert.ok(deductedEnvelopeId.length > 0);
    });

    it('debits the SAME flat $0.25 regardless of signer count — no surcharge (F-13.1)', async () => {
      let deducted = 0;
      const result = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com',
          senderIdentity: 'alice@example.com',
          senderGate: {
            getCreditBalance: async () => 10_000_000,
            deductCredit: async (_id, amount) => { deducted = amount; return { ok: true }; },
          },
        },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: '5-signer pricing', signers: [
          { email: 'a@t.com', name: 'A' }, { email: 'b@t.com', name: 'B' }, { email: 'c@t.com', name: 'C' },
          { email: 'd@t.com', name: 'D' }, { email: 'e@t.com', name: 'E' },
        ] },
      );
      assert.equal(result.status, 201);
      assert.equal(deducted, 250_000); // flat — no per-signer surcharge
    });

    // v0.30.0 — F7.8 / Issue 10 / DD-96: creator creation-confirmation email + canonical PDF.
    it('sends the email-creator a creation email with the canonical PDF attached', async () => {
      const fresh = createMockEmailProvider();
      const result = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: fresh, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@acme.com' },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'Creation Email Test', signers: [{ email: 'bob@t.com', name: 'Bob' }] },
      );
      assert.equal(result.status, 201);
      const created = fresh.sent.filter((m) => /Envelope created/i.test(m.subject ?? '') && m.to === 'creator@acme.com');
      assert.equal(created.length, 1, 'exactly one creation email to the creator');
      const att = created[0]!.attachments;
      assert.ok(att && att.length === 1, 'one PDF attachment');
      assert.equal(att![0]!.contentType, 'application/pdf');
      assert.ok(att![0]!.content, 'PDF bytes present');
    });

    // F-5.1 / AC-10 — the SIGNER's signing-request email must carry the canonical
    // PDF attached so the signer can forward it back (the attachment IS what they sign).
    it('attaches the canonical PDF to each signer\'s signing-request email (AC-10)', async () => {
      const fresh = createMockEmailProvider();
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: fresh, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@acme.com' },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'Signer Attach', signers: [{ email: 'bob@t.com', name: 'Bob' }] },
      );
      const toSigner = fresh.sent.find((m) => m.to === 'bob@t.com');
      assert.ok(toSigner, 'signer received a signing-request email');
      const att = toSigner!.attachments;
      assert.ok(att && att.length === 1, 'signing-request carries one PDF attachment');
      assert.equal(att![0]!.contentType, 'application/pdf');
      assert.ok(att![0]!.content, 'canonical PDF bytes present');
    });

    it('sends the creator a creation email (the email-only creator always has an inbox)', async () => {
      const fresh = createMockEmailProvider();
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: fresh, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@acme.com' },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'Wallet Create', signers: [{ email: 'bob@t.com', name: 'Bob' }] },
      );
      const created = fresh.sent.filter((m) => /Envelope created/i.test(m.subject ?? ''));
      assert.equal(created.length, 1);
      assert.equal(created[0]!.to, 'creator@acme.com');
    });

    // F16.10: auto-detection when SOURCE PDF matches existing document with
    // incomplete signers. v0.19.x rework — matches by source_hash (SHA-256
    // of pre-assembly source bytes) instead of document_hash (canonical
    // PDF hash, which differs per envelope under F22.9 semantic).
    it('should return suggestion when source PDF matches an existing document with incomplete signers (F16.10)', async () => {
      // First envelope with signer A (pending)
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'Agreement', signers: [{ email: 'a@t.com', name: 'A' }] },
      );

      // Second envelope with same SOURCE PDF — should get a suggestion
      // (canonical docHash differs per envelope, but source_hash matches)
      const second = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'Agreement', signers: [{ email: 'b@t.com', name: 'B' }] },
      );
      assert.equal(second.status, 201);
      assert.ok(second.body.suggestion, 'Should have a suggestion when same SOURCE PDF was used previously');
      assert.equal(typeof second.body.suggestion.signed_count, 'number');
      assert.equal(typeof second.body.suggestion.total_count, 'number');
      assert.ok(Array.isArray(second.body.suggestion.missing_signers));
    });
  });

  // F1: "GET /v1/envelope/:id — return envelope status, signer statuses, tx hashes"
  describe('GET /v1/envelope/:id', () => {
    it('should return 404 for non-existent envelope', async () => {
      const result = await handleGetEnvelope({ pool: db.pool, baseUrl: 'https://x.com' }, 'nonexistent', '0x1');
      assert.equal(result.status, 404);
    });

    it('should return envelope with signers after creation', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0x1' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );

      const envId = db.envelopes[0].id;
      const result = await handleGetEnvelope({ pool: db.pool, baseUrl: 'https://x.com' }, envId, '0x1');
      assert.equal(result.status, 200);
      assert.equal(result.body.document_name, 'NDA');
      assert.equal(result.body.signers!.length, 1);
      assert.equal(result.body.signers![0].status, 'pending');
    });

    it('404s for a different creator — no IDOR on the signer roster (PII)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: 'owner@x.com' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      const envId = db.envelopes[0].id;
      const result = await handleGetEnvelope({ pool: db.pool, baseUrl: 'https://x.com' }, envId, 'stranger@x.com');
      assert.equal(result.status, 404); // not the owner → looks like it doesn't exist
    });

    it('returns auto_close + per-signer on_behalf_of/undeliverable_at (F-23/F-24 dashboard fields)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: 'owner@x.com' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A', on_behalf_of: 'Acme' }] },
      );
      const envId = db.envelopes[0].id;
      const result = await handleGetEnvelope({ pool: db.pool, baseUrl: 'https://x.com' }, envId, 'owner@x.com');
      assert.equal(result.status, 200);
      assert.equal(result.body.auto_close, true);
      assert.equal(result.body.signers![0].on_behalf_of, 'Acme');
      assert.equal(result.body.signers![0].undeliverable_at, null);
    });

    it('exposes a per-signer delivery_status distinct from the signing status (F-12.3 / AC-125)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: 'owner@x.com' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [
          { email: 'pending@b.com', name: 'P' },
          { email: 'bounced@b.com', name: 'B' },
          { email: 'signed@b.com', name: 'S' },
        ] },
      );
      const envId = db.envelopes[0].id;
      db.signers.find((s) => s.email === 'bounced@b.com')!.undeliverable_at = new Date();
      const signedRow = db.signers.find((s) => s.email === 'signed@b.com')!;
      signedRow.status = 'signed';
      signedRow.signed_at = new Date();
      const result = await handleGetEnvelope({ pool: db.pool, baseUrl: 'https://x.com' }, envId, 'owner@x.com');
      assert.equal(result.status, 200);
      const byEmail = (e: string) => result.body.signers!.find((x: any) => x.email === e)!;
      // The agent-native distinction: a hard-bounced invite reads undeliverable without the dashboard.
      assert.equal(byEmail('pending@b.com').delivery_status, 'pending');
      assert.equal(byEmail('bounced@b.com').delivery_status, 'undeliverable');
      assert.equal(byEmail('signed@b.com').delivery_status, 'delivered');
      // …and it is DISTINCT from the signing status enum (still 'pending' for the bounced signer).
      assert.equal(byEmail('bounced@b.com').status, 'pending');
    });

    it('returns per-signer evidence (provider domain+selector + .eml hash) for signed signers (F-11)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: 'owner@x.com' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] },
      );
      const envId = db.envelopes[0].id;
      db.signers[0].status = 'signed';
      db.artifacts.push({
        id: 'art-1', envelope_id: envId, signer_email: 'a@b.com',
        sha256_eml: 'abc123def', dkim_domain: 'gmail.com', dkim_selector: '20251104',
        ts_status: 'complete', created_at: new Date(), updated_at: new Date(),
      });
      const result = await handleGetEnvelope({ pool: db.pool, baseUrl: 'https://x.com' }, envId, 'owner@x.com');
      const s = result.body.signers!.find((x: any) => x.email === 'a@b.com')!;
      assert.equal(s.signing_domain, 'gmail.com');
      assert.equal(s.signing_selector, '20251104');
      assert.equal(s.eml_sha256, 'abc123def');
    });

    it('persists an autoClose=false (manual-seal) choice at creation (F-24.3)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: 'owner@x.com' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, auto_close: false, signers: [{ email: 'a@b.com', name: 'A' }] },
      );
      const envId = db.envelopes[0].id;
      const result = await handleGetEnvelope({ pool: db.pool, baseUrl: 'https://x.com' }, envId, 'owner@x.com');
      assert.equal(result.body.auto_close, false);
    });
  });

  // F1: "Sender voids an active envelope; all pending signers receive a cancellation notice"
  describe('POST /v1/envelope/:id/void', () => {
    it('should void envelope and notify pending signers', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0xSender' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      email.sent.length = 0; // clear creation emails

      const envId = db.envelopes[0].id;
      const result = await handleVoidEnvelope(
        { pool: db.pool, emailProvider: email },
        envId,
        '0xSender'
      );

      assert.equal(result.status, 200);
      assert.equal(result.body.status, 'voided');
      assert.equal(email.sent.length, 1); // void notification
    });

    // F-015 (system-test Cycle 14, AC-137): voiding an ALREADY-voided envelope
    // must be a clean, taxonomy-coded 409 — not the uncoded 500 that
    // `voidEnvelope`'s `WHERE status='active'` 0-row throw used to surface.
    it('returns a coded 409 (never an uncoded 500) when voiding an already-voided envelope (F-015 / AC-137)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0xSender' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      const envId = db.envelopes[0].id;
      const first = await handleVoidEnvelope({ pool: db.pool, emailProvider: email }, envId, '0xSender');
      assert.equal(first.status, 200, 'first void succeeds');
      assert.equal(first.body.status, 'voided');
      // Second void: MUST return a clean coded 409, not throw an uncoded 500.
      const second = await handleVoidEnvelope({ pool: db.pool, emailProvider: email }, envId, '0xSender');
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'state_not_active', 'carries a state_* taxonomy code');
    });

    it('returns a coded 409 when voiding an already-terminal (expired / completed) envelope (F-015 / AC-137)', async () => {
      for (const status of ['expired', 'completed'] as const) {
        await handleCreateEnvelope(
          { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0xSender' },
          { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
        );
        const env = db.envelopes[db.envelopes.length - 1];
        env.status = status;
        const result = await handleVoidEnvelope({ pool: db.pool, emailProvider: email }, env.id, '0xSender');
        assert.equal(result.status, 409, `${status} → 409`);
        assert.equal(result.body.code, 'state_not_active', `${status} → state_not_active`);
      }
    });

    it('rejects (409) cancelling an AUTO-close envelope once everyone has signed (F-24.1, Barry QA)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0xSender' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }, { email: 'c@d.com', name: 'C' }] }
      );
      const envId = db.envelopes[0].id;
      for (const s of db.signers) s.status = 'signed'; // all signed → complete-pending (auto_close defaults true)
      email.sent.length = 0;
      const result = await handleVoidEnvelope({ pool: db.pool, emailProvider: email }, envId, '0xSender');
      assert.equal(result.status, 409);
      assert.match(result.body.error, /can no longer be cancelled/i);
      assert.equal(db.envelopes[0].status, 'active', 'still active — not voided');
      assert.equal(email.sent.length, 0, 'no cancellation emails sent');
    });

    // F8.6: voided envelopes delete the PDF immediately (no party will sign or
    // receive a completion email, so there's no reason to keep it on disk).
    it('immediately purges the document + covers from storage when voiding (F-013)', async () => {
      const stored: Record<string, Uint8Array> = {};
      const deleted: string[] = [];
      await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://x.com',
          senderIdentity: '0xSender',
          storePdf: async (k, d) => { stored[k] = d; },
        },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );

      const env = db.envelopes[0];
      await handleVoidEnvelope(
        {
          pool: db.pool,
          emailProvider: email,
          deletePdf: async (k: string) => { deleted.push(k); },
        } as any,
        env.id,
        '0xSender'
      );

      assert.ok(db.envelopes[0].pdf_deleted_at, 'pdf_deleted_at should be set');
      // F-013: the REAL blob keys are purged (shared document D + the one signer's
      // cover), derived from document_hash + signing_token — NOT the always-null
      // pdf_storage_key column the old code gated on (so nothing was ever deleted).
      assert.ok(deleted.includes(`envelopes/${env.document_hash}/document.pdf`), 'document D purged');
      assert.equal(deleted.length, 2, 'document + one cover');
      for (const k of deleted) assert.ok(k in stored, `${k} was actually stored at create`);
    });

    it('should reject void from non-sender', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0xSender' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );

      const envId = db.envelopes[0].id;
      const result = await handleVoidEnvelope(
        { pool: db.pool, emailProvider: email },
        envId,
        '0xOtherPerson'
      );
      assert.equal(result.status, 403);
    });

    // F-9.7 / AC-49 — "Void & start a corrected copy": refund-if-unsigned.
    it('refunds the flat credit when voiding a FULLY-UNSIGNED envelope (AC-49)', async () => {
      let refundedAmount = 0;
      await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://x.com',
          senderIdentity: 'creator@x.com',
          senderGate: { getCreditBalance: async () => 1_000_000, deductCredit: async () => ({ ok: true }) },
        },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      const envId = db.envelopes[0].id;
      const result = await handleVoidEnvelope(
        {
          pool: db.pool, emailProvider: email,
          senderGate: { refundCredit: async (_id, amt) => { refundedAmount = amt; return { ok: true }; } },
        },
        envId,
        'creator@x.com'
      );
      assert.equal(result.status, 200);
      assert.equal(result.body.refunded, true);
      assert.equal(refundedAmount, 250_000); // flat $0.25 refunded
    });

    it('does NOT refund when a signer has already signed (AC-49)', async () => {
      let refundCalled = false;
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: 'creator@x.com' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }, { email: 'b@b.com', name: 'B' }] }
      );
      db.signers[0].status = 'signed'; // one signed, one still pending → value delivered, voidable (not complete-pending), no refund
      const envId = db.envelopes[0].id;
      const result = await handleVoidEnvelope(
        {
          pool: db.pool, emailProvider: email,
          senderGate: { refundCredit: async () => { refundCalled = true; return { ok: true }; } },
        },
        envId,
        'creator@x.com'
      );
      assert.equal(result.status, 200);
      assert.equal(result.body.refunded, false);
      assert.equal(refundCalled, false);
    });

    // F-004 (system-test Fix Cycle 1) — voiding must survive a hard-bounced /
    // suppressed OUTSTANDING signer. The void-notice send is now best-effort per
    // signer (try/catch) AND skips signers already stamped undeliverable_at, so a
    // suppressed recipient can no longer turn a void into a 500.
    it('does not 500 when the void-notice send throws for a hard-bounced signer (F-004, best-effort)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0xSender' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      const envId = db.envelopes[0].id;
      // Provider hard-rejects the outstanding signer (suppressed / prior hard bounce).
      const throwingEmail: EmailProvider = {
        async send() {
          throw new Error('554 Recipient address suppressed (previous hard bounce)');
        },
      };
      const result = await handleVoidEnvelope(
        { pool: db.pool, emailProvider: throwingEmail },
        envId,
        '0xSender'
      );
      assert.equal(result.status, 200, 'void must succeed even when the void-notice send throws');
      assert.equal(result.body.status, 'voided');
    });

    it('skips notifying a signer already marked undeliverable_at — no send attempted (F-004)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0xSender' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      const envId = db.envelopes[0].id;
      db.signers[0].undeliverable_at = new Date(); // known-undeliverable, still pending/outstanding
      let sendCalls = 0;
      const countingEmail: EmailProvider = {
        async send() {
          sendCalls++;
          throw new Error('should not be called for an undeliverable signer');
        },
      };
      const result = await handleVoidEnvelope(
        { pool: db.pool, emailProvider: countingEmail },
        envId,
        '0xSender'
      );
      assert.equal(result.status, 200);
      assert.equal(sendCalls, 0, 'no void-notice send attempted for an undeliverable_at signer');
    });
  });

  // F-9.8 / AC-50 — undeliverable signing request.
  describe('handleUndeliverableSigningRequest', () => {
    it('F-36: emits exactly one envelope_undeliverable (ids only, dated key); a re-fired bounce emits nothing', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@acme.com' },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'UndelivEvt', signers: [{ email: 'bounce2@nope.com', name: 'Bo' }] }
      );
      const envId = db.envelopes[db.envelopes.length - 1].id;
      const signerId = db.signers.find((s) => s.email === 'bounce2@nope.com')!.id;
      const events: Array<{ type: string; ids: readonly string[]; payload: Record<string, unknown> }> = [];
      const emitAppEvent = (async (type: string, ids: readonly string[], payload: Record<string, unknown>) => {
        events.push({ type, ids, payload });
      }) as never;
      const ctx = { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', emitAppEvent };

      const r = await handleUndeliverableSigningRequest(ctx, envId, 'bounce2@nope.com');
      assert.equal(r.body.marked, true);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'envelope_undeliverable');
      assert.deepEqual(events[0].payload, { envelope_id: envId, signer_id: signerId });
      assert.deepEqual(events[0].ids.slice(0, 2), [envId, signerId]);
      assert.match(String(events[0].ids[2]), /^\d{4}-\d{2}-\d{2}$/, 'dated key component — forever-dedup must not swallow a genuine later recurrence');

      const r2 = await handleUndeliverableSigningRequest(ctx, envId, 'bounce2@nope.com');
      assert.equal(r2.body.marked, false);
      assert.equal(events.length, 1, 'unmarked re-fire emits nothing');
    });

    it('F-36/AC-196: the undeliverable mark completes when the events surface fails (real seam)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@acme.com' },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'UndelivFault', signers: [{ email: 'bounce3@nope.com', name: 'Bo' }] }
      );
      const envId = db.envelopes[db.envelopes.length - 1].id;
      const logs: string[] = [];
      const failingSeam = (async (type: never, ids: readonly string[], payload: never) =>
        seamEmitAppEvent(
          {
            emitRuntimeEvent: async () => {
              throw new Error('socket hang up');
            },
            log: (m: string) => void logs.push(m),
          },
          type,
          ids,
          payload,
        )) as never;
      const r = await handleUndeliverableSigningRequest(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', emitAppEvent: failingSeam },
        envId,
        'bounce3@nope.com',
      );
      assert.equal(r.body.marked, true, 'the mark is never gated by an emit failure');
      assert.equal(logs.length, 1);
      assert.match(logs[0], /envelope_undeliverable/);
    });

    it('marks the signer undeliverable and notifies the creator; idempotent (AC-50)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@acme.com' },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'Undeliv', signers: [{ email: 'bounce@nope.com', name: 'Bo' }] }
      );
      const envId = db.envelopes[0].id;
      email.sent.length = 0;
      const r = await handleUndeliverableSigningRequest(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com' },
        envId, 'bounce@nope.com',
      );
      assert.equal(r.body.marked, true);
      assert.ok(db.signers.find((s) => s.email === 'bounce@nope.com')?.undeliverable_at, 'signer stamped undeliverable');
      const notice = email.sent.find((m) => m.to === 'creator@acme.com' && /couldn.t deliver/i.test(m.subject ?? ''));
      assert.ok(notice, 'creator notified');
      // A re-fired bounce is a no-op.
      const again = await handleUndeliverableSigningRequest(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com' }, envId, 'bounce@nope.com',
      );
      assert.equal(again.body.marked, false);
    });
  });

  // F7: "Manual reminder triggered by sender; signer receives new notification"
  describe('POST /v1/envelope/:id/remind', () => {
    it('should send reminders to pending signers', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0xS' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }, { email: 'b@b.com', name: 'B' }] }
      );
      email.sent.length = 0;

      const envId = db.envelopes[0].id;
      const result = await handleRemind(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com' },
        envId,
        '0xS'
      );

      assert.equal(result.status, 200);
      assert.equal(result.body.reminded, 2);
      assert.equal(email.sent.length, 2);
    });

    it('reminds an outstanding (superseded) signer on an awaiting_seal envelope — does NOT 400 "not active" (Barry QA)', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0xS' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }, { email: 'b@b.com', name: 'B' }] }
      );
      const env = db.envelopes[0];
      env.status = 'awaiting_seal'; // all-signed then a signed signer was edited (superseded)
      const sgnrs = db.signers.filter((s: any) => s.envelope_id === env.id);
      sgnrs[0].status = 'signed';
      sgnrs[1].status = 'superseded';
      email.sent.length = 0;

      const result = await handleRemind(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com' },
        env.id,
        '0xS'
      );

      assert.equal(result.status, 200); // NOT 400 "Envelope is not active"
      assert.equal(result.body.reminded, 1); // only the outstanding (superseded) signer
      assert.equal(email.sent.length, 1);
    });

    it('rejects reminders on a frozen (completed) envelope', async () => {
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com', senderIdentity: '0xS' },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] }
      );
      db.envelopes[0].status = 'completed';
      const result = await handleRemind(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://x.com' },
        db.envelopes[0].id,
        '0xS'
      );
      assert.equal(result.status, 400);
    });
  });

  // DD-16: envelope expiration handler — notify parties + delete PDF per F8.6
  describe('notifyEnvelopeExpired (F-29 / DD-16 — the expiry notice)', () => {
    // The batch sweep + claim is gone (expiry is now the `envelope_expire` durable run,
    // which claims via claimExpiredEnvelope then calls this). These test the notice.
    async function createExpiredEnvelopeWith2Of3Signed() {
      const createResult = await handleCreateEnvelope(
        {
          pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com',
          senderIdentity: 'sam@sender.co',
        },
        {
          document_name: 'NDA',
          pdf_base64: TEST_FIXTURE_PDF_B64,
          expiry_days: -1, // already past deadline
          signers: [
            { email: 'alice@t.com', name: 'Alice' },
            { email: 'bob@t.com', name: 'Bob' },
            { email: 'carol@t.com', name: 'Carol' },
          ],
        }
      );
      const envelopeId = createResult.body.envelope_id;
      for (const env of db.envelopes) {
        if (env.id === envelopeId) env.pdf_storage_key = `envelopes/${env.document_hash}/original.pdf`;
      }
      const envSigners = db.signers.filter((s: any) => s.envelope_id === envelopeId);
      envSigners[0]!.status = 'signed';
      envSigners[1]!.status = 'signed';
      email.sent.length = 0; // ignore the signing-request emails from create
      return db.envelopes.find((e: any) => e.id === envelopeId);
    }

    it('emails the sender an envelopeExpired notice with the signer breakdown', async () => {
      const envelope = await createExpiredEnvelopeWith2Of3Signed();
      await notifyEnvelopeExpired(db.pool, envelope, email, { async deletePdf(_: string) {} });

      const senderMail = email.sent.find((m: any) => m.to === 'sam@sender.co');
      assert.ok(senderMail, 'sender should receive an envelopeExpired email');
      assert.match(senderMail!.subject, /expired/i);
      assert.ok(senderMail!.html.includes('NDA'));
      assert.ok(senderMail!.html.includes('2 of 3'));
      assert.ok(senderMail!.html.includes('Alice') && senderMail!.html.includes('Bob') && senderMail!.html.includes('Carol'));
    });

    it('notifies pending signers, not already-signed ones', async () => {
      const envelope = await createExpiredEnvelopeWith2Of3Signed();
      await notifyEnvelopeExpired(db.pool, envelope, email, { async deletePdf(_: string) {} });
      assert.ok(email.sent.find((m: any) => m.to === 'carol@t.com'), 'Carol (pending) should be notified');
      assert.ok(!email.sent.find((m: any) => m.to === 'alice@t.com'), 'Alice (signed) should NOT be notified');
      assert.ok(!email.sent.find((m: any) => m.to === 'bob@t.com'), 'Bob (signed) should NOT be notified');
    });

    it('purges the document + covers via the storage adapter (F8.6 / F-013)', async () => {
      const envelope = await createExpiredEnvelopeWith2Of3Signed();
      const deletedKeys: string[] = [];
      await notifyEnvelopeExpired(db.pool, envelope, email, { async deletePdf(key: string) { deletedKeys.push(key); } });
      // F-013: real keys — the shared document D + one cover per signer (3 here) —
      // NOT the always-null pdf_storage_key the old code gated on.
      assert.ok(deletedKeys.includes(`envelopes/${envelope.document_hash}/document.pdf`), 'document D purged');
      assert.equal(deletedKeys.length, 4, 'document + 3 covers');
      assert.ok(db.envelopes.find((e: any) => e.id === envelope.id)?.pdf_deleted_at, 'pdf_deleted_at stamped');
    });

    it('still emails the sender with no storage adapter (PDF delete is best-effort)', async () => {
      const envelope = await createExpiredEnvelopeWith2Of3Signed();
      await notifyEnvelopeExpired(db.pool, envelope, email); // no storage
      assert.ok(email.sent.find((m: any) => m.to === 'sam@sender.co'));
    });
  });

  // F16.7: Dashboard document view — documents grouped by hash
  describe('handleListDocuments', () => {
    it('should return documents grouped by hash with combined signer status', async () => {
      // Create two envelopes with the same hash
      const hash = 'a'.repeat(64);
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'Doc', signers: [{ email: 'a@t.com', name: 'A' }] },
      );
      // The hash is computed from the PDF content, so the second envelope has the same hash
      // if the PDF content is the same
      await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        { pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'Doc', signers: [{ email: 'b@t.com', name: 'B' }] },
      );

      const result = await handleListDocuments({ pool: db.pool }, '0xSender');
      assert.equal(result.status, 200);
      // Should be grouped by document_hash — 1 document with 2 envelopes
      assert.ok(Array.isArray(result.body));
      // At least one document returned
      assert.ok(result.body.length >= 1);
      const doc = result.body[0];
      assert.ok(doc.documentHash);
      assert.ok(doc.documentName);
      assert.ok(typeof doc.totalSigners === 'number');
      assert.ok(typeof doc.signedCount === 'number');
      assert.ok(Array.isArray(doc.envelopes));
    });

    it('should return empty array for unknown sender', async () => {
      const result = await handleListDocuments({ pool: db.pool }, '0xNobody');
      assert.equal(result.status, 200);
      assert.equal(result.body.length, 0);
    });
  });

  // F16.C: Resend to missing signers
  describe('handleResendToMissing', () => {
    it('should create a new envelope with only incomplete signers', async () => {
      // Create an envelope with 2 signers, one signed
      const createResult = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          pdf_base64: TEST_FIXTURE_PDF_B64,
          document_name: 'Resend Doc',
          signers: [{ email: 'a@t.com', name: 'A' }, { email: 'b@t.com', name: 'B' }],
        },
      );
      assert.equal(createResult.status, 201);
      const hash = createResult.body.document_hash;

      // Simulate A signed
      const signersList = db.signers;
      const signerA = signersList.find((s: any) => s.email === 'a@t.com');
      if (signerA) (signerA as any).status = 'signed';

      const resendResult = await handleResendToMissing(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        hash,
      );
      assert.equal(resendResult.status, 201);
      assert.ok(resendResult.body.envelope_id);
      // Only B should be in the new envelope's signers
      assert.equal(resendResult.body.signers.length, 1);
      assert.equal(resendResult.body.signers[0].email, 'b@t.com');
    });

    it('should return 400 when no incomplete signers exist', async () => {
      // Create an envelope with 1 signer, mark as signed
      const createResult = await handleCreateEnvelope(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        {
          pdf_base64: TEST_FIXTURE_PDF_B64,
          document_name: 'All Done',
          signers: [{ email: 'done@t.com', name: 'Done' }],
        },
      );
      const hash = createResult.body.document_hash;
      const signer = db.signers.find((s: any) => s.email === 'done@t.com');
      if (signer) (signer as any).status = 'signed';

      const resendResult = await handleResendToMissing(
        { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: '0xSender' },
        hash,
      );
      assert.equal(resendResult.status, 400);
    });
  });
});

// SS.2 / DD-97 / F1.11 — remember the ENVELOPE CREATOR's own name (our
// customer's name), keyed by their login email, when they add themselves as a
// signer. NOT a store of signer/recipient names.
describe('Creator name memory on send (SS.2 / F1.11)', () => {
  it("saves the creator's own name when they also sign (sender-as-signer)", async () => {
    const db = createMockDb();
    const email = createMockEmailProvider();
    await handleCreateEnvelope(
      { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@example.com' },
      {
        pdf_base64: TEST_FIXTURE_PDF_B64,
        document_name: 'Self-sign',
        signers: [
          { email: 'creator@example.com', name: 'Jordan R' }, // the creator, as a signer
          { email: 'cosigner@example.com', name: 'Casey Lee' },
        ],
      },
    );
    assert.equal(db.creatorProfiles.get('creator@example.com'), 'Jordan R');
  });

  it('does NOT save a name when the creator is not among the signers', async () => {
    const db = createMockDb();
    const email = createMockEmailProvider();
    await handleCreateEnvelope(
      { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@example.com' },
      {
        pdf_base64: TEST_FIXTURE_PDF_B64,
        document_name: 'Others only',
        signers: [{ email: 'someoneelse@example.com', name: 'Somebody Else' }],
      },
    );
    assert.equal(db.creatorProfiles.size, 0);
  });

  it('overwrites the saved name on a later create (the typo-fix path)', async () => {
    const db = createMockDb();
    const email = createMockEmailProvider();
    const ctx = { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@example.com' };
    await handleCreateEnvelope(ctx, {
      pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'First', signers: [{ email: 'creator@example.com', name: 'Jordan R' }],
    });
    await handleCreateEnvelope(ctx, {
      pdf_base64: TEST_FIXTURE_PDF_B64, document_name: 'Second', signers: [{ email: 'creator@example.com', name: 'Jordan Rivera' }],
    });
    assert.equal(db.creatorProfiles.get('creator@example.com'), 'Jordan Rivera');
    assert.equal(db.creatorProfiles.size, 1);
  });
});

// ── 36.1 / 35.5 / AC-124 — undeliverable classifier PREFERS a typed permanence
// signal over string-matching the provider error text (which can drift). run402
// exposes no typed signal today, so the regex stays the live path; these guard the
// forward-compatible typed-signal consumption + the unchanged text fallback.
describe('isUndeliverableRecipientError — typed-signal-preferred classification (36.1 / AC-124)', () => {
  it('a PERMANENT typed signal classifies undeliverable even when the text does NOT match the regex', () => {
    // A provider error whose wording the regex would miss, but that carries a
    // structured permanence flag → must be caught as undeliverable (not stranded).
    assert.equal(
      isUndeliverableRecipientError(Object.assign(new Error('delivery abandoned: policy 7731'), { permanent: true })),
      true,
    );
    assert.equal(
      isUndeliverableRecipientError(Object.assign(new Error('mailbox policy rejection'), { bounceType: 'Permanent' })),
      true,
    );
    assert.equal(
      isUndeliverableRecipientError(Object.assign(new Error('gateway said no'), { statusCode: 550 })),
      true,
    );
    assert.equal(
      isUndeliverableRecipientError(Object.assign(new Error('enhanced status'), { code: '5.1.1' })),
      true,
    );
  });

  it('a TRANSIENT typed signal classifies recoverable even when the text WOULD match the regex', () => {
    // The typed classification wins over the text: "bounce"/"suppress" in the message
    // must NOT strand a signal the provider explicitly marked transient.
    assert.equal(
      isUndeliverableRecipientError(Object.assign(new Error('temporary bounce, will retry'), { permanent: false })),
      false,
    );
    assert.equal(
      isUndeliverableRecipientError(Object.assign(new Error('recipient suppressed momentarily'), { bounceType: 'Transient' })),
      false,
    );
    assert.equal(
      isUndeliverableRecipientError(Object.assign(new Error('bounce'), { statusCode: 421 })),
      false,
    );
  });

  it('with NO typed signal falls back to the text regex (unchanged behavior)', () => {
    // The live path today: plain Errors, classified exactly as before.
    assert.equal(
      isUndeliverableRecipientError(new Error('Recipient address is suppressed while sending email (HTTP 400)')),
      true,
    );
    assert.equal(isUndeliverableRecipientError(new Error('No such user here')), true);
    assert.equal(isUndeliverableRecipientError(new Error('Internal server error (HTTP 500)')), false);
    assert.equal(isUndeliverableRecipientError(new Error('throttled, try again')), false);
    // An 'Undetermined' bounce carries no decision → text fallback (here: no match → transient).
    assert.equal(
      isUndeliverableRecipientError(Object.assign(new Error('temporary glitch'), { bounceType: 'Undetermined' })),
      false,
    );
  });
});

// ── 36.3 / AC-125 / F-12.3 — machine-readable per-signer delivery_status, a
// DERIVED projection distinct from the signing `status` enum (which has no
// 'undeliverable' value). Agents poll this to tell a bounced invite from a normal pending.
describe('deliveryStatus — machine-readable per-signer delivery state (36.3 / AC-125)', () => {
  it('maps undeliverable_at → undeliverable, signed → delivered, else pending', () => {
    assert.equal(deliveryStatus({ undeliverable_at: new Date(), signed_at: null, status: 'pending' }), 'undeliverable');
    assert.equal(deliveryStatus({ undeliverable_at: null, signed_at: new Date(), status: 'signed' }), 'delivered');
    assert.equal(deliveryStatus({ undeliverable_at: null, signed_at: null, status: 'pending' }), 'pending');
    // A signer flagged by status but not signed_at still reads delivered (delivery is proven by the signature).
    assert.equal(deliveryStatus({ undeliverable_at: null, signed_at: null, status: 'signed' }), 'delivered');
    // undeliverable takes precedence over any signed signal (shouldn't co-occur, but defined).
    assert.equal(deliveryStatus({ undeliverable_at: new Date(), signed_at: new Date(), status: 'signed' }), 'undeliverable');
  });
});

// ── Send-failure resilience: the crash + ordering fix (2026-06-21 outage triage)
//
// Regression guard. A suppressed/undeliverable recipient made the signing-request
// send THROW; the throw was UNCAUGHT, so the run402 runtime wrapped it as an
// opaque "Internal function error" (HTTP 500) — AFTER the envelope was persisted
// and a credit debited (a half-created, already-charged envelope the user never
// saw an id for). A deliverability problem must instead: (a) never abort the
// create, (b) mark that signer undeliverable + notify the creator (F-9.8
// synchronous path), (c) still charge exactly once, debited AFTER the sends.
describe('handleCreateEnvelope — send-failure resilience (crash + ordering)', () => {
  // Email provider that throws a chosen error for specific recipients.
  function throwingEmail(failures: Record<string, string>): EmailProvider & { sent: EmailMessage[] } {
    const sent: EmailMessage[] = [];
    return {
      sent,
      async send(msg: EmailMessage) {
        const reason = failures[msg.to];
        if (reason) throw new Error(reason);
        sent.push(msg);
        return { messageId: `msg-${sent.length}` };
      },
    };
  }

  it('a SUPPRESSED recipient does not crash the create — signer marked undeliverable, creator notified, others delivered (F-9.8 synchronous path)', async () => {
    const db = createMockDb();
    const email = throwingEmail({
      'bad@example.com': 'Recipient address is suppressed while sending email (HTTP 400)',
    });
    const result = await handleCreateEnvelope(
      { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@kychee.com' },
      {
        document_name: 'NDA',
        pdf_base64: TEST_FIXTURE_PDF_B64,
        signers: [
          { email: 'good@example.com', name: 'Good' },
          { email: 'bad@example.com', name: 'Bad' },
        ],
      },
    );

    // (a) create still succeeds — envelope persisted, no opaque 500
    assert.equal(result.status, 201);
    assert.ok(result.body.envelope_id);
    // (b) per-signer delivery outcome is reported
    assert.deepEqual(result.body.delivery, { sent: 1, undeliverable: ['bad@example.com'], failed: [] });
    // (c) the bad signer is marked undeliverable; the good one is untouched (F-9.8)
    assert.ok(db.signers.find((s) => s.email === 'bad@example.com')?.undeliverable_at, 'bad signer stamped undeliverable_at');
    assert.equal(db.signers.find((s) => s.email === 'good@example.com')?.undeliverable_at, null, 'good signer untouched');
    // (d) the creator got the "couldn't deliver" notice; (e) the good signer got their request
    assert.ok(email.sent.find((m) => m.to === 'creator@kychee.com' && /couldn.t deliver/i.test(m.subject)), 'creator notified');
    assert.ok(email.sent.some((m) => m.to === 'good@example.com'), 'good signer emailed');
  });

  it('a TRANSIENT send failure does not crash and does NOT strand the signer as undeliverable', async () => {
    const db = createMockDb();
    const email = throwingEmail({ 'flaky@example.com': 'Internal server error (HTTP 500)' });
    const result = await handleCreateEnvelope(
      { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@kychee.com' },
      { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'flaky@example.com', name: 'Flaky' }] },
    );
    assert.equal(result.status, 201);
    assert.deepEqual(result.body.delivery, { sent: 0, undeliverable: [], failed: ['flaky@example.com'] });
    // A transient failure must NOT mark the signer undeliverable (recoverable via reminder).
    assert.equal(db.signers.find((s) => s.email === 'flaky@example.com')?.undeliverable_at, null, 'transient leaves signer pending');
  });

  it('a TRANSIENT send failure schedules a delivery_backstop run ONLY for the failed signer (F-9.9 / AC-124)', async () => {
    const db = createMockDb();
    const email = throwingEmail({ 'flaky@example.com': 'Internal server error (HTTP 500)' });
    const runs: Array<Record<string, unknown>> = [];
    const result = await handleCreateEnvelope(
      {
        pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@kychee.com',
        createRun: async (o) => { runs.push(o as unknown as Record<string, unknown>); return { runId: 'r', deduplicated: false }; },
        deliveryBackstop: '24h',
      },
      {
        document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64,
        signers: [{ email: 'good@example.com', name: 'Good' }, { email: 'flaky@example.com', name: 'Flaky' }],
      },
    );
    assert.equal(result.status, 201);
    // transient still leaves the signer pending at create (unchanged F-9.8 behavior)
    assert.equal(db.signers.find((s) => s.email === 'flaky@example.com')?.undeliverable_at, null, 'transient leaves signer pending');
    // …but a delivery_backstop run is now scheduled — for the flaky signer ONLY (the
    // delivered signer is never a backstop target).
    const backstops = runs.filter((r) => r.eventType === 'delivery_backstop');
    assert.equal(backstops.length, 1, 'exactly one backstop, for the transiently-failed signer');
    assert.equal((backstops[0].payload as { envelopeId: string }).envelopeId, result.body.envelope_id);
    assert.equal(backstops[0].delay, '24h');
    assert.match(backstops[0].idempotencyKey as string, /:delivery-backstop$/);
  });

  it('F-37/AC-207: a create by a click-attributed creator enqueues ONE envelope_created conversion; an organic creator enqueues none', async () => {
    const mkPools = (attributed: boolean) => {
      const db = createMockDb();
      const pool: typeof db.pool = {
        query: async (text: string, values?: unknown[]) =>
          text.includes('FROM creator_attribution')
            ? ((attributed
                ? { rows: [{ gclid: 'Cj0Kenv', captured_at: '2026-07-18T09:30:00.000Z', consent_state: null }], rowCount: 1 }
                : { rows: [], rowCount: 0 }) as never)
            : db.pool.query(text, values),
        end: async () => {},
      };
      return pool;
    };
    for (const attributed of [true, false]) {
      const runs: Array<Record<string, unknown>> = [];
      const result = await handleCreateEnvelope(
        {
          pool: mkPools(attributed), emailProvider: createMockEmailProvider(), baseUrl: 'https://kysigned.com',
          senderIdentity: 'creator@kychee.com',
          createRun: async (o) => { runs.push(o as unknown as Record<string, unknown>); return { runId: 'r', deduplicated: false }; },
          adsUploadFunction: 'kysigned-billing',
        },
        { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'signer@example.com', name: 'Signer' }] },
      );
      assert.equal(result.status, 201);
      const ads = runs.filter((r) => r.eventType === 'ads_conversion_upload');
      if (attributed) {
        assert.equal(ads.length, 1, 'one conversion enqueue for the attributed creator');
        assert.equal(ads[0]!.targetFunction, 'kysigned-billing');
        assert.match(ads[0]!.idempotencyKey as string, /^ads:envelope_created:[0-9a-f]{32}$/);
        assert.equal((ads[0]!.payload as { gclid: string }).gclid, 'Cj0Kenv');
      } else {
        assert.equal(ads.length, 0, 'organic creator enqueues nothing');
      }
    }
  });

  it('a failing CREATOR-confirmation send never fails the create (best-effort)', async () => {
    const db = createMockDb();
    const email = throwingEmail({ 'creator@kychee.com': 'Internal server error (HTTP 500)' });
    const result = await handleCreateEnvelope(
      { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@kychee.com' },
      { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'signer@example.com', name: 'Signer' }] },
    );
    assert.equal(result.status, 201);
    assert.deepEqual(result.body.delivery, { sent: 1, undeliverable: [], failed: [] });
    assert.ok(!('delivered' in (result.body.delivery as object)), 'AC-200: the create summary never claims delivered');
  });

  it('charges exactly one credit, debited AFTER the signer sends (ordering fix), even when a recipient is suppressed', async () => {
    const db = createMockDb();
    const order: string[] = [];
    let debits = 0;
    const email: EmailProvider = {
      async send(msg: EmailMessage) {
        order.push(`send:${msg.to}`);
        if (msg.to === 'bad@example.com') throw new Error('Recipient address is suppressed while sending email (HTTP 400)');
        return { messageId: 'm-1' };
      },
    };
    const senderGate = {
      async deductCredit() {
        debits++;
        order.push('debit');
        return { ok: true as const };
      },
    };
    const result = await handleCreateEnvelope(
      { pool: db.pool, emailProvider: email, baseUrl: 'https://kysigned.com', senderIdentity: 'creator@kychee.com', senderGate },
      { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'bad@example.com', name: 'Bad' }] },
    );
    assert.equal(result.status, 201);
    assert.equal(debits, 1, 'charged exactly once');
    assert.ok(order.indexOf('debit') > order.indexOf('send:bad@example.com'), 'debit comes after the signer send attempt');
  });
});

// ── F-30.2 (spec 0.39.0) — the credit-gate 402 discovery pointer (46.4) ─────
// With operator x402 config present the standard create's 402 NAMES the paid
// route + price so an unfunded agent learns where to pay; without config the
// body is exactly today's (fork regression). The pointer is plain JSON — the
// standard route never emits an x402 protocol challenge (AC-135).
describe('credit-gate 402 discovery pointer (F-30.2 / AC-134 / AC-135)', () => {
  const brokeCtx = (db: ReturnType<typeof createMockDb>, email: ReturnType<typeof createMockEmailProvider>, extra: Record<string, unknown> = {}) => ({
    pool: db.pool,
    emailProvider: email,
    baseUrl: 'https://kysigned.com',
    senderIdentity: 'broke@x.com',
    senderGate: { getCreditBalance: async () => 0 },
    ...extra,
  });
  const POINTER_BODY = { document_name: 'NDA', pdf_base64: TEST_FIXTURE_PDF_B64, signers: [{ email: 'a@b.com', name: 'A' }] };

  it('with x402 config: 402 carries x402_route + x402_price_usd_micros alongside the unchanged code/message', async () => {
    const db = createMockDb();
    const email = createMockEmailProvider();
    const r = await handleCreateEnvelope(
      brokeCtx(db, email, { x402Discovery: { priceUsdMicros: 250_000 } }) as never,
      POINTER_BODY,
    );
    assert.equal(r.status, 402);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.code, 'payment_required');
    assert.match(String(body.error), /Insufficient credit/);
    assert.equal(body.x402_route, '/v1/x402/envelope');
    assert.equal(body.x402_price_usd_micros, 250_000);
  });

  it('WITHOUT config the 402 body is byte-identical to today (code + error only — fork regression)', async () => {
    const db = createMockDb();
    const email = createMockEmailProvider();
    const r = await handleCreateEnvelope(brokeCtx(db, email) as never, POINTER_BODY);
    assert.equal(r.status, 402);
    assert.deepEqual(Object.keys(r.body as object).sort(), ['code', 'error']);
  });

  it('the pointer rides ONLY the 402 — a 403 allowlist miss with config on carries no x402 fields', async () => {
    const db = createMockDb();
    const email = createMockEmailProvider();
    const r = await handleCreateEnvelope(
      brokeCtx(db, email, {
        allowedCreators: ['someoneelse@x.com'],
        x402Discovery: { priceUsdMicros: 250_000 },
      }) as never,
      POINTER_BODY,
    );
    assert.equal(r.status, 403);
    assert.equal('x402_route' in (r.body as object), false);
  });

  it('the standard 402 is never an x402 protocol challenge — no `accepts` payload, config on or off (AC-135)', async () => {
    const db = createMockDb();
    const email = createMockEmailProvider();
    for (const extra of [{}, { x402Discovery: { priceUsdMicros: 250_000 } }]) {
      const r = await handleCreateEnvelope(brokeCtx(db, email, extra) as never, POINTER_BODY);
      assert.equal(r.status, 402);
      assert.equal('accepts' in (r.body as object), false, 'plain JSON 402, not an x402 challenge');
    }
  });
});
