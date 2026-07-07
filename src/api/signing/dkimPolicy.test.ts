/**
 * DKIM acceptance policy tests — F-6.2 / AC-17 (spec v0.4.0).
 *
 * The policy decides acceptance from a cryptographic verdict (produced by mailauth
 * in dkimVerify.ts) plus the message-level l= flag. Each failure mode gets a
 * distinct reason so the inbound log and the bounce can name it (AC-17).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateDkimPolicy,
  orgAligned,
  type DkimSignatureDescriptor,
} from './dkimPolicy.js';

const passAligned: DkimSignatureDescriptor = {
  signingDomain: 'example.com',
  selector: 'sel',
  result: 'pass',
  alignedDomain: 'example.com',
  algorithm: 'rsa-sha256',
};

describe('evaluateDkimPolicy — F-6.2 acceptance (AC-17)', () => {
  it('accepts a passing, From-aligned, rsa-sha256 signature with no l=', () => {
    const r = evaluateDkimPolicy({
      fromDomain: 'example.com',
      signatures: [passAligned],
      anyBodyLengthTag: false,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.signingDomain, 'example.com');
      assert.equal(r.algorithm, 'rsa-sha256');
    }
  });

  it('accepts when the signing subdomain is org-aligned with From (mail.example.com vs example.com)', () => {
    const r = evaluateDkimPolicy({
      fromDomain: 'example.com',
      signatures: [{ ...passAligned, signingDomain: 'mail.example.com', alignedDomain: 'mail.example.com' }],
      anyBodyLengthTag: false,
    });
    assert.equal(r.ok, true);
  });

  it('rejects when there is no DKIM signature at all', () => {
    const r = evaluateDkimPolicy({ fromDomain: 'example.com', signatures: [], anyBodyLengthTag: false });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no_signature');
  });

  it('rejects any message carrying an l= body-length tag (even with an otherwise valid sig)', () => {
    const r = evaluateDkimPolicy({
      fromDomain: 'example.com',
      signatures: [passAligned],
      anyBodyLengthTag: true,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'body_length_tag');
  });

  it('rejects a passing signature that is NOT aligned with From (misaligned)', () => {
    const r = evaluateDkimPolicy({
      fromDomain: 'example.com',
      signatures: [{ ...passAligned, signingDomain: 'mailer.other.com', alignedDomain: null }],
      anyBodyLengthTag: false,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'misaligned');
  });

  it('rejects a passing signature aligned to a DIFFERENT org-domain than From', () => {
    const r = evaluateDkimPolicy({
      fromDomain: 'example.com',
      signatures: [{ ...passAligned, signingDomain: 'evil.com', alignedDomain: 'evil.com' }],
      anyBodyLengthTag: false,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'misaligned');
  });

  it('rejects a passing, aligned signature that uses rsa-sha1 (weak algorithm)', () => {
    const r = evaluateDkimPolicy({
      fromDomain: 'example.com',
      signatures: [{ ...passAligned, algorithm: 'rsa-sha1' }],
      anyBodyLengthTag: false,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'weak_algorithm');
  });

  it('rejects a cryptographic failure as invalid_signature', () => {
    const r = evaluateDkimPolicy({
      fromDomain: 'example.com',
      signatures: [{ ...passAligned, result: 'fail' }],
      anyBodyLengthTag: false,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'invalid_signature');
  });

  it('reports a missing DNS key (neutral / no key) as missing_key', () => {
    const r = evaluateDkimPolicy({
      fromDomain: 'example.com',
      signatures: [{ ...passAligned, result: 'neutral' }],
      anyBodyLengthTag: false,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'missing_key');
  });

  it('reports a DNS temperror as missing_key', () => {
    const r = evaluateDkimPolicy({
      fromDomain: 'example.com',
      signatures: [{ ...passAligned, result: 'temperror' }],
      anyBodyLengthTag: false,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'missing_key');
  });

  it('prefers invalid_signature over missing_key when a real fail is present', () => {
    const r = evaluateDkimPolicy({
      fromDomain: 'example.com',
      signatures: [
        { ...passAligned, result: 'neutral', alignedDomain: null },
        { ...passAligned, result: 'fail', alignedDomain: null },
      ],
      anyBodyLengthTag: false,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'invalid_signature');
  });

  it('picks the aligned-passing signature among several (forwarder + sender sigs)', () => {
    const r = evaluateDkimPolicy({
      fromDomain: 'example.com',
      signatures: [
        { signingDomain: 'sendgrid.net', selector: 's1', result: 'pass', alignedDomain: null, algorithm: 'rsa-sha256' },
        passAligned,
      ],
      anyBodyLengthTag: false,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.signingDomain, 'example.com');
  });
});

describe('orgAligned helper', () => {
  it('treats subdomains as aligned to the org domain', () => {
    assert.equal(orgAligned('mail.example.com', 'example.com'), true);
    assert.equal(orgAligned('example.com', 'example.com'), true);
  });
  it('treats different org domains as unaligned', () => {
    assert.equal(orgAligned('evil.com', 'example.com'), false);
  });
});
