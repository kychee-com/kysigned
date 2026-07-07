/**
 * checkReplyMembership tests — 2F.SG.4 (spec F3.3.6.10 / F3.3.9.7).
 *
 * The membership composition: parse subject tokens + extract From + look up the
 * envelope and signer, returning the two-tier verdict the reconciler branches on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkReplyMembership } from './checkReplyMembership.js';
import { createInboundRepliesMemoryPool } from '../../db/inboundReplies.testpool.js';

const DOC = 'aaa5da8c662efd41fcb59d89b0ae2db3c91b5c372251a8f5ea7ddd0d0611badc';
const ENV_HEX = '18267982ca7645dca294e86039a6343d';
const ENV_UUID = '18267982-ca76-45dc-a294-e86039a6343d';

/** Build a raw single-part text/plain forward with the given From + Subject. */
function rawReply(opts: { from?: string; subject?: string; body?: string } = {}): string {
  const from = opts.from ?? 'Alice Example <alice@test.com>';
  const subject = opts.subject ?? `Fwd: Sign "acme" [ksgn-${ENV_HEX}]`;
  const body = opts.body ?? 'I sign this document';
  return [
    `From: ${from}`,
    `To: reply-to-sign@kysigned.com`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
    '',
  ].join('\r\n');
}

function seed(opts: { envelopeStatus?: string; signerStatus?: string; signerEmail?: string } = {}) {
  const pool = createInboundRepliesMemoryPool();
  pool.envelopes.push({ id: ENV_UUID, status: opts.envelopeStatus ?? 'active', document_name: 'acme', document_hash: DOC });
  if (opts.signerEmail !== null) {
    pool.signers.push({
      id: 's-1', envelope_id: ENV_UUID,
      email: opts.signerEmail ?? 'alice@test.com',
      status: opts.signerStatus ?? 'pending',
    });
  }
  return pool;
}

describe('checkReplyMembership', () => {
  it('member:false (no_subject_tokens) when the subject has no [ksgn-<id>] token', async () => {
    const { pool } = seed();
    const m = await checkReplyMembership(pool, rawReply({ subject: 'Re: please sign this' }));
    assert.equal(m.member, false);
    assert.equal(m.member === false && m.reason, 'no_subject_tokens');
  });

  it('member:false (envelope_not_found) when the parsed envelopeId matches no envelope', async () => {
    const { pool } = createInboundRepliesMemoryPool(); // nothing seeded
    const m = await checkReplyMembership(pool, rawReply());
    assert.equal(m.member, false);
    assert.equal(m.member === false && m.reason, 'envelope_not_found');
    assert.equal(m.member === false && m.envelopeId, ENV_UUID); // parsed id recorded for observability
  });

  it('member:false (not_a_signer) when From is not an invited signer on the envelope', async () => {
    const { pool } = seed({ signerEmail: 'alice@test.com' });
    const m = await checkReplyMembership(pool, rawReply({ from: 'mallory@evil.com' }));
    assert.equal(m.member, false);
    assert.equal(m.member === false && m.reason, 'not_a_signer');
    assert.equal(m.member === false && m.signerEmail, 'mallory@evil.com');
  });

  it('member:true (active, not signed) for an invited signer on an active envelope', async () => {
    const { pool } = seed();
    const m = await checkReplyMembership(pool, rawReply());
    assert.equal(m.member, true);
    if (m.member) {
      assert.equal(m.envelopeId, ENV_UUID);
      assert.equal(m.signerEmail, 'alice@test.com');
      assert.equal(m.envelopeOpen, true);
      assert.equal(m.alreadySigned, false);
      assert.equal(m.documentHash, DOC);
    }
  });

  it('member:true + envelopeOpen:false for a CLOSED envelope (completed/expired/voided)', async () => {
    for (const status of ['completed', 'expired', 'voided']) {
      const { pool } = seed({ envelopeStatus: status });
      const m = await checkReplyMembership(pool, rawReply());
      assert.equal(m.member, true);
      assert.equal(m.member === true && m.envelopeOpen, false);
      assert.equal(m.member === true && m.envelopeStatus, status);
    }
  });

  it('member:true + envelopeOpen:true for an OPEN envelope — active OR awaiting_seal (a superseded signer re-signs onto awaiting_seal, Barry QA)', async () => {
    for (const status of ['active', 'awaiting_seal']) {
      const { pool } = seed({ envelopeStatus: status });
      const m = await checkReplyMembership(pool, rawReply());
      assert.equal(m.member === true && m.envelopeOpen, true, `${status} should be open for signing`);
    }
  });

  it('member:true with alreadySigned:true when the signer has already signed', async () => {
    const { pool } = seed({ signerStatus: 'signed' });
    const m = await checkReplyMembership(pool, rawReply());
    assert.equal(m.member, true);
    assert.equal(m.member === true && m.alreadySigned, true);
  });

  it('lowercases the From address and matches the signer case-insensitively', async () => {
    const { pool } = seed({ signerEmail: 'alice@test.com' });
    const m = await checkReplyMembership(pool, rawReply({ from: 'ALICE@TEST.COM' }));
    assert.equal(m.member, true);
    assert.equal(m.member === true && m.signerEmail, 'alice@test.com');
  });

  it('extracts the bare address from an RFC-5322 comment From (no angle brackets) — a real signer must not be silently dropped', async () => {
    const { pool } = seed({ signerEmail: 'alice@test.com' });
    // `From: alice@test.com (Alice)` is RFC-legal and has no <...>; the bare
    // address must still be extracted so the invited signer matches.
    const m = await checkReplyMembership(pool, rawReply({ from: 'alice@test.com (Alice)' }));
    assert.equal(m.member, true);
    assert.equal(m.member === true && m.signerEmail, 'alice@test.com');
  });
});
