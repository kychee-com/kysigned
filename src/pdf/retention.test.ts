/**
 * Ephemeral retention rule tests — from spec F8.6.
 *
 * shouldDeletePdf is a pure function: given an envelope, its signers, and the
 * current time, return whether the PDF should be deleted now.
 *
 * F8.6 rules:
 *   active / awaiting_seal                                  → KEEP
 *   voided / expired                                        → DELETE immediately
 *   completed, NOT all completion emails delivered yet      → KEEP
 *   completed, ALL completion emails delivered              → DELETE
 *   completed, ANY bounced, < 7 days since completion       → KEEP (sender notified)
 *   completed, ANY bounced, ≥ 7 days since completion       → DELETE (fallback)
 *   completed, ≥ 30 days since completion                   → DELETE (hard cap)
 *   pdf_deleted_at already set                              → already deleted, no-op
 *
 * F-013 regression note: the decision must NOT depend on `pdf_storage_key`. That
 * column is NEVER written on create, so the old `if (!pdf_storage_key) return
 * false` made every rule dead — blobs (at their real document_hash/token keys)
 * were never deleted. These tests fix `pdf_storage_key: null` on the fixtures to
 * prove the terminal-state rules fire regardless of that column.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldDeletePdf } from './retention.js';
import type { Envelope, EnvelopeSigner } from '../db/types.js';

const NOW = new Date('2026-04-15T12:00:00Z');

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: 'env-1',
    sender_email: 'sender@test.com',
    document_name: 'NDA',
    document_hash: 'a'.repeat(64),
    source_hash: null,
    status: 'completed',
    consent_language_version: '1.0',
    created_at: new Date('2026-04-10T00:00:00Z'),
    completed_at: new Date('2026-04-14T00:00:00Z'), // 1 day before NOW
    // F-013: pdf_storage_key is NULL in production (never written on create). The
    // fixture pins it null so every rule below proves it fires without that column.
    pdf_storage_key: null,
    expiry_at: null,
    pdf_deleted_at: null,
    completion_distributed_at: null,
    internal_test: false,
    ...overrides,
  };
}

function signer(overrides: Partial<EnvelopeSigner> = {}): EnvelopeSigner {
  return {
    id: 's-1',
    envelope_id: 'env-1',
    email: 'a@t.com',
    name: 'A',
    on_behalf_of: null,
    verification_level: 2,
    signing_method: 'email',
    status: 'signed',
    signing_token: 't',
    token_expires_at: NOW,
    signed_at: new Date('2026-04-13T00:00:00Z'),
    reminder_count: 0,
    last_reminder_at: null,
    completion_email_delivered_at: null,
    completion_email_bounced_at: null,
    completion_email_provider_msg_id: null,
    undeliverable_at: null,
    ...overrides,
  };
}

describe('shouldDeletePdf — F8.6 ephemeral retention rules', () => {
  it('keeps PDF for active envelopes', () => {
    const e = envelope({ status: 'active', completed_at: null });
    assert.equal(shouldDeletePdf(e, [signer()], NOW), false);
  });

  it('deletes PDF immediately for voided envelopes', () => {
    const e = envelope({ status: 'voided' });
    assert.equal(shouldDeletePdf(e, [signer()], NOW), true);
  });

  it('deletes PDF immediately for expired envelopes', () => {
    const e = envelope({ status: 'expired' });
    assert.equal(shouldDeletePdf(e, [signer()], NOW), true);
  });

  it('keeps PDF when completed but no delivery confirmation yet', () => {
    const e = envelope();
    const s = signer({ completion_email_delivered_at: null });
    assert.equal(shouldDeletePdf(e, [s], NOW), false);
  });

  it('keeps PDF when only some signers have delivery confirmation', () => {
    const e = envelope();
    const s1 = signer({ id: 's-1', completion_email_delivered_at: new Date('2026-04-14T01:00:00Z') });
    const s2 = signer({ id: 's-2', completion_email_delivered_at: null });
    assert.equal(shouldDeletePdf(e, [s1, s2], NOW), false);
  });

  it('deletes PDF when ALL signers have delivery confirmation', () => {
    const e = envelope();
    const s1 = signer({ id: 's-1', completion_email_delivered_at: new Date('2026-04-14T01:00:00Z') });
    const s2 = signer({ id: 's-2', completion_email_delivered_at: new Date('2026-04-14T02:00:00Z') });
    assert.equal(shouldDeletePdf(e, [s1, s2], NOW), true);
  });

  it('keeps PDF for 7-day grace when a completion email bounced (just bounced)', () => {
    const e = envelope({ completed_at: new Date('2026-04-14T00:00:00Z') }); // 1 day ago
    const s1 = signer({ id: 's-1', completion_email_delivered_at: new Date('2026-04-14T01:00:00Z') });
    const s2 = signer({ id: 's-2', completion_email_bounced_at: new Date('2026-04-14T02:00:00Z') });
    assert.equal(shouldDeletePdf(e, [s1, s2], NOW), false);
  });

  it('deletes PDF after 7-day bounce fallback elapses', () => {
    const e = envelope({ completed_at: new Date('2026-04-07T00:00:00Z') }); // 8 days ago
    const s1 = signer({ id: 's-1', completion_email_delivered_at: new Date('2026-04-07T01:00:00Z') });
    const s2 = signer({ id: 's-2', completion_email_bounced_at: new Date('2026-04-07T02:00:00Z') });
    assert.equal(shouldDeletePdf(e, [s1, s2], NOW), true);
  });

  it('deletes PDF at the 30-day hard cap regardless of delivery state', () => {
    const e = envelope({ completed_at: new Date('2026-03-15T00:00:00Z') }); // 31 days ago
    const s = signer({ completion_email_delivered_at: null });
    assert.equal(shouldDeletePdf(e, [s], NOW), true);
  });

  it('does not redelete an already-deleted PDF', () => {
    const e = envelope({ pdf_deleted_at: new Date('2026-04-14T05:00:00Z') });
    assert.equal(shouldDeletePdf(e, [signer()], NOW), false);
  });

  it('keeps the PDF while the envelope is awaiting a manual seal', () => {
    const e = envelope({ status: 'awaiting_seal', completed_at: null });
    assert.equal(shouldDeletePdf(e, [signer({ status: 'signed' })], NOW), false);
  });

  it('F-013: DELETES a voided envelope even though pdf_storage_key is null', () => {
    // The exact bug: the old rule returned false for a null pdf_storage_key, so a
    // voided envelope's blob was never purged. Now voided → delete, regardless.
    const e = envelope({ status: 'voided', pdf_storage_key: null });
    assert.equal(shouldDeletePdf(e, [], NOW), true);
  });

  it('F-013: DELETES a completed+all-delivered envelope even though pdf_storage_key is null', () => {
    const e = envelope({ pdf_storage_key: null });
    const s = signer({ completion_email_delivered_at: new Date('2026-04-14T01:00:00Z') });
    assert.equal(shouldDeletePdf(e, [s], NOW), true);
  });
});

describe('shouldDeletePdf — F-014: DB rows arrive with STRING timestamps (HttpDbPool)', () => {
  // Production HttpDbPool returns TIMESTAMPTZ columns as ISO strings (the run402
  // HTTP DB surface serializes rows via row_to_json → JSON, so a Date becomes a
  // string on the wire). The DAO reads (getEnvelope, getEnvelopeSigners) rehydrate
  // those back to Date, but the retention SWEEP's raw `SELECT *` scan did not — so
  // shouldDeletePdf received a string completed_at and crashed on `.getTime()`
  // (TypeError: completed_at.getTime is not a function). That crash took the 30-day
  // hard-cap backstop down (F-014). These fixtures pass the timestamp columns as ISO
  // strings — the real production shape — to prove shouldDeletePdf tolerates them and
  // still decides correctly. The `as unknown as Date` cast documents that the field
  // is typed Date but arrives as a string over the wire.
  const iso = (s: string) => s as unknown as Date;

  it('does NOT crash and deletes at the 30-day hard cap when completed_at is an ISO string', () => {
    const e = envelope({ completed_at: iso('2026-03-15T00:00:00.000Z') }); // 31 days before NOW
    const s = signer({ completion_email_delivered_at: null });
    assert.equal(shouldDeletePdf(e, [s], NOW), true);
  });

  it('does NOT crash and KEEPS a within-cap completed envelope (string completed_at, no delivery yet)', () => {
    // The exact Cycle-12 repro: a just-completed envelope whose blob is still pending
    // (no delivery confirmation). Must not crash and must not prematurely delete.
    const e = envelope({ completed_at: iso('2026-04-14T00:00:00.000Z') }); // 1 day before NOW
    const s = signer({ completion_email_delivered_at: null });
    assert.equal(shouldDeletePdf(e, [s], NOW), false);
  });

  it('deletes a string-timestamp completed envelope when all signers delivered (string markers too)', () => {
    const e = envelope({ completed_at: iso('2026-04-14T00:00:00.000Z') });
    const s = signer({ completion_email_delivered_at: iso('2026-04-14T01:00:00.000Z') });
    assert.equal(shouldDeletePdf(e, [s], NOW), true);
  });

  it('honors the 7-day bounce fallback with string completed_at (string bounce marker)', () => {
    const e = envelope({ completed_at: iso('2026-04-07T00:00:00.000Z') }); // 8 days before NOW
    const s1 = signer({ id: 's-1', completion_email_delivered_at: iso('2026-04-07T01:00:00.000Z') });
    const s2 = signer({ id: 's-2', completion_email_bounced_at: iso('2026-04-07T02:00:00.000Z') });
    assert.equal(shouldDeletePdf(e, [s1, s2], NOW), true);
  });
});
