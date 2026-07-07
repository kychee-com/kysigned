/**
 * F-3.1 / F-3.6 / F-13 — create-gate verdict tests (evidence-bundle model).
 *
 * The gate is the EARLY box that DEFINES the seams later phases implement:
 *   - the credit balance comes from an injected `getCreditBalance` callback
 *     (the local credit store lands in Phase 13);
 *   - the cookie-session 401 is enforced in the deployed Lambda (Phase 12),
 *     but the handler still guards a missing creator identity here.
 *
 * Contract (AC-5): no creator -> 401; on an allowlist that excludes them -> 403;
 * authenticated but under the per-envelope price -> 402; funded -> ok (201).
 * Pricing is FLAT $0.25/envelope (F-13.1) — no per-signer surcharge.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCreateGate, DEFAULT_ENVELOPE_COST_USD_MICROS } from './createGate.ts';

describe('evaluateCreateGate — F-3.1/F-3.6/F-13 (AC-5)', () => {
  it('default per-envelope cost is $0.25 (250_000 micros, F-13.1)', () => {
    assert.equal(DEFAULT_ENVELOPE_COST_USD_MICROS, 250_000);
  });

  it('401 when there is no authenticated creator identity', async () => {
    for (const identity of ['', '   ', undefined as unknown as string]) {
      const v = await evaluateCreateGate({ senderIdentity: identity });
      assert.equal(v.ok, false);
      assert.equal(v.status, 401);
    }
  });

  it('403 when an allowedCreators allowlist is configured and excludes the creator (F-3.6)', async () => {
    const v = await evaluateCreateGate({
      senderIdentity: 'mallory@evil.com',
      allowedCreators: ['alice@kychee.com', 'bob@kychee.com'],
    });
    assert.equal(v.ok, false);
    assert.equal(v.status, 403);
  });

  it('allows a listed creator (allowlist match is case-insensitive)', async () => {
    const v = await evaluateCreateGate({
      senderIdentity: 'ALICE@kychee.com',
      allowedCreators: ['alice@kychee.com'],
    });
    assert.equal(v.ok, true);
  });

  it('allows exact-domain wildcard creators such as *@example.com', async () => {
    const v = await evaluateCreateGate({
      senderIdentity: 'Owner@Example.com',
      allowedCreators: ['alice@kychee.com', '*@example.com'],
    });
    assert.equal(v.ok, true);
  });

  it('does not let *@example.com match subdomains', async () => {
    const v = await evaluateCreateGate({
      senderIdentity: 'owner@sub.example.com',
      allowedCreators: ['*@example.com'],
    });
    assert.equal(v.ok, false);
    assert.equal(v.status, 403);
  });

  it('empty/absent allowedCreators = any authenticated funded creator (F-3.6)', async () => {
    const v = await evaluateCreateGate({ senderIdentity: 'anyone@x.com', allowedCreators: [] });
    assert.equal(v.ok, true);
  });

  it('402 when the credit balance is below the per-envelope cost (F-13)', async () => {
    const v = await evaluateCreateGate({
      senderIdentity: 'alice@x.com',
      getCreditBalance: async () => 100_000, // < 250_000
    });
    assert.equal(v.ok, false);
    assert.equal(v.status, 402);
  });

  it('the 402 message reads in dollars, never raw USD micros (Barry QA 2026-06-16)', async () => {
    // The message is surfaced verbatim to the SPA (envelope.ts -> { error }).
    // Showing "need 250000" confused the creator ("what is that number?"); it
    // must read as "$0.25".
    const v = await evaluateCreateGate({
      senderIdentity: 'alice@x.com',
      getCreditBalance: async () => 0,
    });
    assert.equal(v.status, 402);
    assert.match(v.error!, /\$0\.00/, 'balance shown in dollars');
    assert.match(v.error!, /\$0\.25/, 'per-envelope cost shown in dollars');
    assert.doesNotMatch(v.error!, /250000|250_000/, 'no raw micro amount');
  });

  it('201-eligible when funded at or above the cost', async () => {
    const exact = await evaluateCreateGate({
      senderIdentity: 'alice@x.com',
      getCreditBalance: async () => 250_000,
    });
    assert.equal(exact.ok, true);
    assert.equal(exact.cost, 250_000);
  });

  it('no credit seam configured (self-host / tests) = credit check skipped', async () => {
    const v = await evaluateCreateGate({ senderIdentity: 'alice@x.com' });
    assert.equal(v.ok, true);
  });

  it('cost is FLAT regardless of signer count (no per-signer surcharge, F-13.1)', async () => {
    let balanceProbe = -1;
    const v = await evaluateCreateGate({
      senderIdentity: 'alice@x.com',
      signerCount: 9,
      getCreditBalance: async () => { balanceProbe = 250_000; return 250_000; },
    });
    assert.equal(v.ok, true);
    assert.equal(v.cost, 250_000, 'cost does not scale with signer count');
    assert.equal(balanceProbe, 250_000);
  });

  it('honors an operator-config cost override', async () => {
    const v = await evaluateCreateGate({
      senderIdentity: 'alice@x.com',
      envelopeCostUsdMicros: 500_000,
      getCreditBalance: async () => 400_000, // below the override
    });
    assert.equal(v.ok, false);
    assert.equal(v.status, 402);
    assert.equal(v.cost, 500_000);
  });
});
