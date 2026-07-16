/**
 * archiveStatement.test.ts (F-32.8 / AC-167) — the accept/reject matrix for the
 * archive observation-statement verifier (zkemail/archive#46 pre-integration).
 *
 * Signs statements inline with self-minted keys (the committed reference vectors +
 * their generator are AC-168, archiveStatementVectors.test.ts). Every reject class
 * gets a distinct machine-readable reason; the happy path returns the parsed record
 * normalized to our internal camelCase shape. Browser-safety (no Node-only APIs) is
 * pinned by a source guard at the bottom.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CompactSign, generateKeyPair, exportJWK } from 'jose';
import { verifyArchiveStatement, type ArchiveJwks } from './archiveStatement.js';

// ── inline signer (the AC-168 generator persists the equivalent as committed vectors) ──
type Signer = { kid: string; sign: (payloadObj: unknown, alg?: string) => Promise<string> };

async function makeSigner(kid: string, alg: 'EdDSA' | 'ES256'): Promise<{ signer: Signer; jwk: Record<string, unknown> }> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } as Record<string, unknown>;
  const signer: Signer = {
    kid,
    sign: async (payloadObj, a = alg) =>
      new CompactSign(new TextEncoder().encode(JSON.stringify(payloadObj)))
        .setProtectedHeader({ alg: a, kid })
        .sign(privateKey),
  };
  return { signer, jwk };
}

const RECORD = {
  id: 'rec-1',
  domain: 'example.com',
  selector: 'mail2026',
  value: 'v=DKIM1; k=rsa; p=MIIBIjANBgkq...IDAQAB',
  source: 'live_dns',
  first_seen_at: '2026-06-01T00:00:00Z',
  last_seen_at: '2026-07-15T08:00:00Z',
};
const STATEMENT = { v: 1, iss: 'archive.prove.email', iat: 1789000000, record: RECORD };

let ed: Signer, es: Signer, jwks: ArchiveJwks;

before(async () => {
  const a = await makeSigner('arch-ed-1', 'EdDSA');
  const b = await makeSigner('arch-es-1', 'ES256');
  ed = a.signer;
  es = b.signer;
  jwks = { keys: [a.jwk, b.jwk] } as ArchiveJwks;
});

describe('verifyArchiveStatement — accept', () => {
  it('accepts a well-formed EdDSA statement signed by a pinned key; returns the parsed record (normalized)', async () => {
    const r = await verifyArchiveStatement(await ed.sign(STATEMENT), jwks);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.kid, 'arch-ed-1');
    assert.equal(r.iat, 1789000000);
    assert.equal(r.record.domain, 'example.com');
    assert.equal(r.record.selector, 'mail2026');
    assert.equal(r.record.value, RECORD.value);
    assert.equal(r.record.source, 'live_dns');
    // normalized to internal camelCase (matches ArchiveKeyRecord for the later integration)
    assert.equal(r.record.firstSeenAt, '2026-06-01T00:00:00Z');
    assert.equal(r.record.lastSeenAt, '2026-07-15T08:00:00Z');
    assert.equal(r.record.id, 'rec-1');
  });

  it('accepts ES256 too (the alternative the archive may prefer)', async () => {
    const r = await verifyArchiveStatement(await es.sign(STATEMENT), jwks);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.kid, 'arch-es-1');
  });

  it('accepts a gcd_recovered record and an absent optional id', async () => {
    const rec = { ...RECORD, source: 'gcd_recovered' };
    delete (rec as Record<string, unknown>).id;
    const r = await verifyArchiveStatement(await ed.sign({ ...STATEMENT, record: rec }), jwks);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.record.source, 'gcd_recovered');
      assert.equal(r.record.id, undefined);
    }
  });
});

/** Assert a reject with an exact machine-readable reason. */
async function rejectsWith(jws: string, reason: string, keys = jwks) {
  const r = await verifyArchiveStatement(jws, keys);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, reason);
}

describe('verifyArchiveStatement — reject matrix (distinct reasons)', () => {
  it('unknown-key: signed by a different key whose kid is not pinned', async () => {
    const { signer } = await makeSigner('attacker-1', 'EdDSA');
    await rejectsWith(await signer.sign(STATEMENT), 'unknown-key');
  });

  it('bad-signature: a valid statement whose payload byte was flipped after signing', async () => {
    const jws = await ed.sign(STATEMENT);
    const [h, p, s] = jws.split('.');
    const tampered = Buffer.from(p, 'base64url').toString('utf8').replace('example.com', 'evil.com');
    const forged = `${h}.${Buffer.from(tampered).toString('base64url')}.${s}`;
    await rejectsWith(forged, 'bad-signature');
  });

  it('bad-signature: a pinned kid reused but signed with a different key', async () => {
    // Attacker mints their own key but stamps the header with a pinned kid.
    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(STATEMENT)))
      .setProtectedHeader({ alg: 'EdDSA', kid: 'arch-ed-1' })
      .sign(privateKey);
    await rejectsWith(jws, 'bad-signature');
  });

  it('unsupported-alg: HS256 (symmetric / alg-confusion) is refused before any key lookup', async () => {
    // Hand-craft a compact JWS with a disallowed alg header.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'arch-ed-1' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(STATEMENT)).toString('base64url');
    await rejectsWith(`${header}.${payload}.AAAA`, 'unsupported-alg');
  });

  it('unsupported-alg: the "none" alg is refused', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'arch-ed-1' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(STATEMENT)).toString('base64url');
    await rejectsWith(`${header}.${payload}.`, 'unsupported-alg');
  });

  it('malformed-jws: not three base64url segments', async () => {
    await rejectsWith('not-a-jws', 'malformed-jws');
    await rejectsWith('only.two', 'malformed-jws');
  });

  it('malformed-shape: unknown source enum', async () => {
    await rejectsWith(await ed.sign({ ...STATEMENT, record: { ...RECORD, source: 'made_up' } }), 'malformed-shape');
  });

  it('malformed-shape: non-RFC-3339 / non-UTC times', async () => {
    await rejectsWith(await ed.sign({ ...STATEMENT, record: { ...RECORD, last_seen_at: '2026-07-15 08:00:00' } }), 'malformed-shape');
    await rejectsWith(await ed.sign({ ...STATEMENT, record: { ...RECORD, first_seen_at: '2026-06-01T00:00:00+02:00' } }), 'malformed-shape');
  });

  it('malformed-shape: missing a required record field', async () => {
    const rec = { ...RECORD } as Record<string, unknown>;
    delete rec.selector;
    await rejectsWith(await ed.sign({ ...STATEMENT, record: rec }), 'malformed-shape');
  });

  it('malformed-shape: non-integer iat', async () => {
    await rejectsWith(await ed.sign({ ...STATEMENT, iat: 1789000000.5 }), 'malformed-shape');
  });

  it('malformed-shape: wrong version or issuer', async () => {
    await rejectsWith(await ed.sign({ ...STATEMENT, v: 2 }), 'malformed-shape');
    await rejectsWith(await ed.sign({ ...STATEMENT, iss: 'evil.example' }), 'malformed-shape');
  });
});

describe('archiveStatement.ts — browser-safety (AC-167)', () => {
  it('imports no Node-only APIs (no `node:` imports, no require/Buffer/process)', () => {
    const src = readFileSync(fileURLToPath(new URL('./archiveStatement.ts', import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:/, 'no node: imports');
    assert.doesNotMatch(src, /\brequire\s*\(/, 'no require()');
    assert.doesNotMatch(src, /\bBuffer\b/, 'no Buffer (Node-only)');
    assert.doesNotMatch(src, /\bprocess\./, 'no process.*');
  });
});
