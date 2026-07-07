/**
 * Key-archive lookup proxy (F-10.8 / AC-104) — the operator forwards the web
 * verifier's PUBLIC `(domain, selector)` DKIM-key lookup to archive.prove.email
 * server-side (the archive serves no CORS headers, so the browser can't call it
 * cross-origin). It returns the archive's records ARRAY (same shape the archive
 * returns) so the same-origin web verifier parses it identically; forwards ONLY
 * `(domain, selector)` (public DNS facts); never touches the bundle/file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleKeyArchiveLookup } from './keyArchiveProxy.js';

function fakeFetch(handler: (url: string) => { status: number; body?: unknown }) {
  return (async (url: string) => {
    const { status, body } = handler(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
}

const RECORD = { domain: 'kysigned.com', selector: 'sel', value: 'p=ABCKEY', firstSeenAt: '2026-06-29T11:42:02.820Z' };

describe('handleKeyArchiveLookup — operator key-archive proxy (F-10.8 / AC-104)', () => {
  it('forwards (domain, selector) to the archive and returns its records array', async () => {
    const archive = {
      fetchFn: fakeFetch((url) => {
        assert.match(url, /\/api\/key\/domain\?/);
        assert.match(url, /domain=kysigned\.com/);
        assert.match(url, /selector=sel/);
        return { status: 200, body: [RECORD] };
      }),
    };
    const r = await handleKeyArchiveLookup({ archive }, 'kysigned.com', 'sel');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body), 'body is the records array');
    assert.equal((r.body as typeof RECORD[])[0].value, 'p=ABCKEY');
  });

  it('200 + empty array for an absent key (archive 404) — the web treats it as pending', async () => {
    const archive = { fetchFn: fakeFetch(() => ({ status: 404 })) };
    const r = await handleKeyArchiveLookup({ archive }, 'absent.com', 'sel');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  it('400 when domain or selector is missing', async () => {
    assert.equal((await handleKeyArchiveLookup({}, null, 'sel')).status, 400);
    assert.equal((await handleKeyArchiveLookup({}, 'kysigned.com', '')).status, 400);
  });

  it('400 on a malformed domain or selector (defense-in-depth)', async () => {
    assert.equal((await handleKeyArchiveLookup({}, 'bad domain!', 'sel')).status, 400);
    assert.equal((await handleKeyArchiveLookup({}, 'kysigned.com', 'bad selector!')).status, 400);
  });

  it('502 when the archive errors (the web verifier treats it as pending)', async () => {
    const archive = { fetchFn: fakeFetch(() => ({ status: 503 })) };
    const r = await handleKeyArchiveLookup({ archive }, 'x.com', 'sel');
    assert.equal(r.status, 502);
  });
});
