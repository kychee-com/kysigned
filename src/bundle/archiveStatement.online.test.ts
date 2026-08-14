/**
 * archiveStatement.online.test.ts (F-32.8 / AC-167, zkemail/archive#46) — LIVE interop:
 * the verifier accepts what the archive ACTUALLY signs in production.
 *
 * The hermetic suites prove the verifier against committed vectors; this leg proves the
 * production boundary — the archive's real JWKS and a real freshly-signed statement set
 * for a pair kysigned's own evidence trail depends on. Assertions are verdict/shape
 * ONLY: statements are freshly signed per request (new `iat` every response), so
 * byte-level expectations can never hold here — the vectors file owns byte locks.
 *
 * Gated on KYSIGNED_ONLINE_E2E=1 (run via `npm run test:live`) so an archive outage
 * can never redden the mandatory tier. The statement endpoint rate-limits bursts
 * (429 + Retry-After, ~seconds), so each fetch carries one bounded retry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyArchiveStatement, type ArchiveJwks } from './archiveStatement.js';

const skip =
  process.env.KYSIGNED_ONLINE_E2E === '1'
    ? false
    : 'set KYSIGNED_ONLINE_E2E=1 to run (hits the live archive statement endpoint)';

const HOST = 'https://archive.zk.email';
const PAIR = { domain: 'gmail.com', selector: '20251104' };

/** One bounded 429 retry honoring Retry-After (clamped to [1s, 30s]). */
async function fetchWithOneRetry(url: string): Promise<Response> {
  const first = await fetch(url);
  if (first.status !== 429) return first;
  const retryAfter = Number(first.headers.get('retry-after') ?? '5');
  const waitS = Math.min(Math.max(retryAfter, 1), 30);
  await new Promise((r) => setTimeout(r, waitS * 1000));
  return fetch(url);
}

describe('live archive statements — production interop (zkemail/archive#46)', () => {
  it('a real production statement set verifies against the real published JWKS', { skip }, async () => {
    const jwksRes = await fetchWithOneRetry(`${HOST}/.well-known/dkim-archive-jwks.json`);
    assert.equal(jwksRes.status, 200, 'JWKS endpoint reachable');
    const jwks = (await jwksRes.json()) as ArchiveJwks;
    assert.ok(Array.isArray(jwks.keys) && jwks.keys.length > 0, 'published JWKS carries keys');

    const stRes = await fetchWithOneRetry(
      `${HOST}/api/key/statement?domain=${PAIR.domain}&selector=${PAIR.selector}`,
    );
    assert.equal(stRes.status, 200, 'statement endpoint reachable');
    const statements = (await stRes.json()) as string[];
    assert.ok(
      Array.isArray(statements) && statements.length > 0,
      `the archive issues at least one statement for ${PAIR.domain}/${PAIR.selector}`,
    );

    for (const jws of statements) {
      const v = await verifyArchiveStatement(jws, jwks);
      assert.equal(v.ok, true, `production statement rejected: ${v.ok ? '' : v.reason}`);
      if (!v.ok) continue;
      assert.ok(
        jwks.keys.some((k) => k.kid === v.kid),
        'statement kid resolves in the published JWKS',
      );
      assert.equal(v.record.domain, PAIR.domain);
      assert.equal(v.record.selector, PAIR.selector);
      assert.equal(v.record.source, 'live_dns', 'only live_dns observations are signed');
      assert.ok(Number.isInteger(v.iat), 'statement carries an integer iat');
    }
  });
});
