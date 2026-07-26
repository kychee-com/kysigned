/**
 * googleCeremonies.test.ts — F-41 (AC-244/AC-249/AC-252), the server-side
 * ceremony row behind "Continue with Google" (DD-59).
 *
 * One short-TTL row per started ceremony holds everything that must NOT ride
 * the URL: the PKCE verifier, the pending-send handle, the attribution rider,
 * the link intent, and the funnel gate trigger. run402's `client_state` carries
 * ONLY the row's opaque id, which comes back in the callback hash on success
 * AND failure — and an id alone reads nothing (F-40.6 parity: consuming it
 * without holding the row's contents yields the caller no secret material it
 * did not already have).
 *
 * Invariants under test:
 *   - the ceremony is consumed by EXACTLY ONE exchange (single-winner UPDATE,
 *     same pattern as the pending-send claim);
 *   - expired / already-consumed / unknown ids all read the same: null;
 *   - the TTL covers run402's own OAuth transaction window (10 minutes);
 *   - PKCE S256 material is RFC 7636-shaped and the challenge derives from the
 *     verifier by base64url(sha256).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DbPool } from './pool.js';
import {
  GOOGLE_CEREMONY_TTL_MS,
  createGoogleCeremony,
  consumeGoogleCeremony,
  deleteFinishedGoogleCeremonies,
  mintPkceVerifier,
  pkceChallengeS256,
} from './googleCeremonies.js';

interface Captured {
  text: string;
  values: unknown[];
}

function capturePool(handler: (text: string, values: unknown[]) => { rows: unknown[]; rowCount: number } | null) {
  const queries: Captured[] = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as unknown[];
      queries.push({ text, values: v });
      return (handler(text, v) ?? { rows: [], rowCount: 0 }) as never;
    },
    async end() {},
  };
  return { pool, queries };
}

function ceremonyRow(over: Record<string, unknown> = {}) {
  return {
    id: 'gc_1',
    pkce_verifier: 'v'.repeat(43),
    draft_handle: null,
    gclid: null,
    link_email: null,
    gate_trigger: null,
    created_at: '2026-07-26T10:00:00.000Z',
    expires_at: '2026-07-26T10:10:00.000Z',
    consumed_at: null,
    ...over,
  };
}

describe('ceremony TTL (DD-59)', () => {
  it('covers the whole run402 OAuth transaction window (10 minutes)', () => {
    // run402's own transaction expires in 600s (`expires_in: 600`, routes/auth.ts
    // read at 414cc643); a shorter row would kill valid callbacks, a much longer
    // one holds gclid/link context for no reason.
    assert.equal(GOOGLE_CEREMONY_TTL_MS, 10 * 60 * 1000);
  });
});

describe('createGoogleCeremony', () => {
  it('stores the server-side context and returns ONLY the opaque id', async () => {
    const now = new Date('2026-07-26T10:00:00.000Z');
    const { pool, queries } = capturePool(() => ({ rows: [], rowCount: 1 }));
    const id = await createGoogleCeremony(pool, {
      pkceVerifier: 'v'.repeat(43),
      draftHandle: 'ps_00000000-0000-4000-8000-000000000000.' + 'S'.repeat(43),
      gclid: { gclid: 'Cj0Test', captured_at: '2026-07-26T09:00:00.000Z', consent: 'unknown' },
      gateTrigger: 'send',
    }, { now });
    assert.match(id, /^gc_[0-9a-f-]{36}$/, 'opaque id, mintable client_state payload');
    const insert = queries.find((q) => q.text.includes('INSERT INTO google_signin_ceremonies'));
    assert.ok(insert, 'wrote the ceremony row');
    assert.equal(insert!.values[0], id);
    assert.equal(insert!.values[1], 'v'.repeat(43), 'verifier stays server-side');
    const expiresAt = insert!.values[6];
    assert.equal(expiresAt, new Date(now.getTime() + GOOGLE_CEREMONY_TTL_MS).toISOString());
  });

  it('link ceremonies record the initiating session address; sign-in ones record null', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [], rowCount: 1 }));
    await createGoogleCeremony(pool, { pkceVerifier: 'v'.repeat(43), linkEmail: 'Owner@Example.com' });
    const insert = queries.find((q) => q.text.includes('INSERT INTO google_signin_ceremonies'));
    assert.equal(insert!.values[4], 'owner@example.com', 'lowercased, one canonical form');
  });
});

describe('consumeGoogleCeremony — exactly-once (AC-252 exactly-once rests on it)', () => {
  it('consumes with a single-winner UPDATE guarded on unconsumed + unexpired', async () => {
    const { pool, queries } = capturePool((text) =>
      text.startsWith('UPDATE google_signin_ceremonies')
        ? { rows: [ceremonyRow({ consumed_at: '2026-07-26T10:05:00.000Z' })], rowCount: 1 }
        : null,
    );
    const record = await consumeGoogleCeremony(pool, 'gc_1', { now: new Date('2026-07-26T10:05:00.000Z') });
    assert.ok(record, 'a live ceremony consumes');
    assert.equal(record!.pkceVerifier, 'v'.repeat(43));
    const update = queries.find((q) => q.text.startsWith('UPDATE google_signin_ceremonies'));
    assert.ok(update!.text.includes('consumed_at IS NULL'), 'the winner is decided in the WHERE clause');
    assert.ok(update!.text.includes('expires_at >'), 'an expired ceremony cannot be consumed');
  });

  it('a second consume, an expired id, and an unknown id all read the same: null', async () => {
    const { pool } = capturePool(() => ({ rows: [], rowCount: 0 }));
    assert.equal(await consumeGoogleCeremony(pool, 'gc_1'), null);
  });

  it('hands back the draft handle, gclid rider, link email and gate trigger it held', async () => {
    const handle = 'ps_00000000-0000-4000-8000-000000000000.' + 'S'.repeat(43);
    const { pool } = capturePool(() => ({
      rows: [ceremonyRow({
        draft_handle: handle,
        gclid: { gclid: 'Cj0Test', captured_at: '2026-07-26T09:00:00.000Z', consent: 'unknown' },
        link_email: 'owner@example.com',
        gate_trigger: 'send',
      })],
      rowCount: 1,
    }));
    const record = await consumeGoogleCeremony(pool, 'gc_1');
    assert.equal(record!.draftHandle, handle);
    assert.equal((record!.gclid as { gclid?: string }).gclid, 'Cj0Test');
    assert.equal(record!.linkEmail, 'owner@example.com');
    assert.equal(record!.gateTrigger, 'send');
  });

  it('parses a gclid rider the HTTP pool hands back as TEXT (jsonb wire shape)', async () => {
    const { pool } = capturePool(() => ({
      rows: [ceremonyRow({ gclid: '{"gclid":"Cj0Test","captured_at":"2026-07-26T09:00:00.000Z","consent":"unknown"}' })],
      rowCount: 1,
    }));
    const record = await consumeGoogleCeremony(pool, 'gc_1');
    assert.equal((record!.gclid as { gclid?: string }).gclid, 'Cj0Test');
  });
});

describe('deleteFinishedGoogleCeremonies (the reaper)', () => {
  it('deletes consumed-or-expired rows and nothing else', async () => {
    const { pool, queries } = capturePool(() => ({ rows: [], rowCount: 3 }));
    const n = await deleteFinishedGoogleCeremonies(pool, new Date('2026-07-26T11:00:00.000Z'));
    assert.equal(n, 3);
    const del = queries.find((q) => q.text.includes('DELETE FROM google_signin_ceremonies'));
    assert.ok(del!.text.includes('consumed_at IS NOT NULL'), 'consumed rows go');
    assert.ok(del!.text.includes('expires_at <='), 'expired rows go');
  });
});

describe('PKCE S256 material (RFC 7636)', () => {
  it('mints a base64url verifier in the 43..128 length window', () => {
    const v = mintPkceVerifier();
    assert.match(v, /^[A-Za-z0-9_-]{43,128}$/);
    assert.notEqual(mintPkceVerifier(), v, 'random, not constant');
  });

  it('derives the challenge as base64url(sha256(verifier))', () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = createHash('sha256').update(v).digest('base64url');
    assert.equal(pkceChallengeS256(v), expected);
  });
});
