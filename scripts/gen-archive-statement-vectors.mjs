/**
 * gen-archive-statement-vectors.mjs (F-32.8 / AC-168, zkemail/archive#46) —
 * generate docs/test-assets/archive-statement-vectors.json.
 *
 * The interop reference kit for the signed archive-observation format kysigned
 * proposed upstream. It writes a test JWKS public key plus a set of compact-JWS
 * statements (valid EdDSA + ES256, and each reject class) with the outcome our
 * verifier must produce. The archive team can diff a prototype signer against these,
 * and our suite (archiveStatementVectors.test.ts) round-trips every vector through
 * `verifyArchiveStatement` to its committed outcome.
 *
 * TEST-ONLY KEYS. The private JWKs below are throwaway keys minted once for this
 * fixture; they sign nothing real, control nothing, and are safe to commit — the
 * same posture as the self-minted keys in the malicious-operator fixture. They exist
 * so the EdDSA vectors are byte-for-byte reproducible (Ed25519 signing is
 * deterministic, RFC 8032). ES256 signing is randomized (ECDSA), so the single ES256
 * vector is committed once and checked by OUTCOME, not bytes (the test excludes it
 * from the byte-reproduce lock and marks it `deterministic: false`).
 *
 * Run:  node --input-type=module scripts/gen-archive-statement-vectors.mjs
 */
import { CompactSign, importJWK, exportJWK, generateKeyPair } from 'jose';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'test-assets', 'archive-statement-vectors.json');

// TEST-ONLY throwaway keys (see header). kid pins them in the JWKS.
const ED = {
  kid: 'test-ed25519-1',
  priv: { crv: 'Ed25519', d: 'MtN5wHuovtseRDb6BIGmveuHsaeYQ5dafjD9qrvqH3A', x: 'RF7Uk0Q0Tl5ZuTOE_Qbf92pukea6JejVjNDQz4uB3OI', kty: 'OKP' },
};
const ES = {
  kid: 'test-es256-1',
  priv: { kty: 'EC', crv: 'P-256', x: 'S-l9ihmzlukIJaadHpFWaeMRjCLWx5oT6asm4m3p-M0', y: 'WgHIGihuWSoiELg7IQYQ6jZcg6QX2ntPOnmpPAPD9H4', d: '4-DZUcSWpPZicFhny0_JtlPO2DMPIpJpEqrQvVeuvqA' },
};

const RECORD = {
  id: 'rec-1',
  domain: 'example.com',
  selector: 'mail2026',
  value: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0example...IDAQAB',
  source: 'live_dns',
  first_seen_at: '2026-06-01T00:00:00Z',
  last_seen_at: '2026-07-15T08:00:00Z',
};
const STATEMENT = { v: 1, iss: 'archive.prove.email', iat: 1789000000, record: RECORD };

/** Sign an object as a compact JWS with the given key material + alg. */
async function sign(priv, alg, kid, payloadObj) {
  const key = await importJWK(priv, alg);
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payloadObj)))
    .setProtectedHeader({ alg, kid })
    .sign(key);
}

/** base64url of a UTF-8 string (browser/Node-safe, no Buffer). */
const b64u = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function buildVectors() {
  // The pinned JWKS = the public halves only (the private JWK minus `d`).
  const pub = (priv, kid, alg) => {
    const { d, ...rest } = priv;
    return { ...rest, kid, alg, use: 'sig' };
  };
  const jwks = { keys: [pub(ED.priv, ED.kid, 'EdDSA'), pub(ES.priv, ES.kid, 'ES256')] };

  const vectors = [];

  // ── accept ──
  vectors.push({ name: 'valid-eddsa', deterministic: true, jws: await sign(ED.priv, 'EdDSA', ED.kid, STATEMENT), expect: { ok: true, kid: ED.kid, domain: 'example.com', source: 'live_dns' } });
  const gcd = { ...STATEMENT, record: { ...RECORD, id: undefined, source: 'gcd_recovered' } };
  delete gcd.record.id;
  vectors.push({ name: 'valid-eddsa-gcd-no-id', deterministic: true, jws: await sign(ED.priv, 'EdDSA', ED.kid, gcd), expect: { ok: true, kid: ED.kid, domain: 'example.com', source: 'gcd_recovered' } });
  vectors.push({ name: 'valid-es256', deterministic: false, jws: await sign(ES.priv, 'ES256', ES.kid, STATEMENT), expect: { ok: true, kid: ES.kid, domain: 'example.com', source: 'live_dns' } });

  // ── reject (all EdDSA-signed or hand-built → deterministic) ──
  // unknown-key: valid signature by a key whose kid is not in the JWKS (minted fresh → deterministic:false).
  const strangerKp = await generateKeyPair('EdDSA', { extractable: true });
  const strangerPriv = await exportJWK(strangerKp.privateKey);
  vectors.push({ name: 'reject-unknown-key', deterministic: false, jws: await sign(strangerPriv, 'EdDSA', 'not-pinned-kid', STATEMENT), expect: { ok: false, reason: 'unknown-key' } });

  // bad-signature: flip a payload byte after signing.
  const good = await sign(ED.priv, 'EdDSA', ED.kid, STATEMENT);
  const [h, p, s] = good.split('.');
  const tamperedPayload = new TextDecoder().decode(Uint8Array.from(atob(p.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))).replace('example.com', 'evil.com');
  vectors.push({ name: 'reject-bad-signature-tampered', deterministic: true, jws: `${h}.${b64u(tamperedPayload)}.${s}`, expect: { ok: false, reason: 'bad-signature' } });

  // unsupported-alg: hand-built HS256 + none headers.
  vectors.push({ name: 'reject-unsupported-alg-hs256', deterministic: true, jws: `${b64u(JSON.stringify({ alg: 'HS256', kid: ED.kid }))}.${b64u(JSON.stringify(STATEMENT))}.AAAA`, expect: { ok: false, reason: 'unsupported-alg' } });
  vectors.push({ name: 'reject-alg-none', deterministic: true, jws: `${b64u(JSON.stringify({ alg: 'none', kid: ED.kid }))}.${b64u(JSON.stringify(STATEMENT))}.`, expect: { ok: false, reason: 'unsupported-alg' } });

  // malformed-jws.
  vectors.push({ name: 'reject-malformed-jws', deterministic: true, jws: 'not-a-jws', expect: { ok: false, reason: 'malformed-jws' } });

  // malformed-shape variants (all EdDSA-signed → deterministic).
  vectors.push({ name: 'reject-shape-unknown-source', deterministic: true, jws: await sign(ED.priv, 'EdDSA', ED.kid, { ...STATEMENT, record: { ...RECORD, source: 'made_up' } }), expect: { ok: false, reason: 'malformed-shape' } });
  vectors.push({ name: 'reject-shape-bad-time', deterministic: true, jws: await sign(ED.priv, 'EdDSA', ED.kid, { ...STATEMENT, record: { ...RECORD, last_seen_at: '2026-07-15 08:00:00' } }), expect: { ok: false, reason: 'malformed-shape' } });
  vectors.push({ name: 'reject-shape-non-integer-iat', deterministic: true, jws: await sign(ED.priv, 'EdDSA', ED.kid, { ...STATEMENT, iat: 1789000000.5 }), expect: { ok: false, reason: 'malformed-shape' } });
  const missing = { ...STATEMENT, record: { ...RECORD } };
  delete missing.record.selector;
  vectors.push({ name: 'reject-shape-missing-field', deterministic: true, jws: await sign(ED.priv, 'EdDSA', ED.kid, missing), expect: { ok: false, reason: 'malformed-shape' } });

  return {
    note: 'Interop reference vectors for the archive signed-observation format (zkemail/archive#46). TEST-ONLY keys. EdDSA vectors are byte-reproducible; the ES256 and unknown-key vectors are randomized (deterministic:false) and checked by outcome only. Regenerate with scripts/gen-archive-statement-vectors.mjs.',
    jwks,
    statementShape: STATEMENT,
    vectors,
  };
}

const built = await buildVectors();
writeFileSync(OUT, JSON.stringify(built, null, 2) + '\n');
console.log(`wrote ${built.vectors.length} vectors → ${OUT}`);
