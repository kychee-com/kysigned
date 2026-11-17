/**
 * confirmKeyArchive — the online DKIM key-archive PRESENCE check (F-10.7 / AC-101 /
 * AC-102). Mirrors confirmBitcoin: given a signer's (domain, selector, key), look the
 * key up in the public archive (archive.prove.email) and return `archive-confirmed`
 * (the EXACT key is present, with its registration time) or `pending-online` (absent
 * or unreachable). The real archive lookup is the DEFAULT (DD-17); these tests inject
 * a fake fetch. Never throws and never gates the verdict (additive).
 *
 * Key-value match: `keys.json` stores the full TXT (`v=DKIM1; k=rsa; p=<b64>`); the
 * archive returns `p=<b64>` (live shape, 2026-06-29). The check compares the extracted
 * `p=` public key, so the two representations match and a DIFFERENT key never confirms.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { confirmKeyArchive } from './confirmKeyArchive.js';

const KEY_B64 = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtestkeyvalueAB==';
const EMBEDDED = `v=DKIM1; k=rsa; p=${KEY_B64}`; // keys.json record (full TXT)
const ARCHIVE_VALUE = `p=${KEY_B64}`; // archive `value` (p= only, per the live shape)

function fakeFetch(handler: (url: string) => { status: number; body?: unknown }) {
  return (async (url: string) => {
    const { status, body } = handler(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
}

const record = (over: Record<string, unknown> = {}) => ({
  domain: 'kysigned.com',
  selector: 'sel',
  value: ARCHIVE_VALUE,
  firstSeenAt: '2026-06-29T11:42:02.820Z',
  lastSeenAt: '2026-06-29T11:42:02.820Z',
  ...over,
});

describe('confirmKeyArchive — online key-archive presence (F-10.7 / AC-101 / AC-102)', () => {
  it('the EXACT key present in the archive → archive-confirmed with the registration time', async () => {
    const r = await confirmKeyArchive('kysigned.com', 'sel', EMBEDDED, {
      fetchFn: fakeFetch((url) => {
        assert.match(url, /\/api\/key\/domain\?/);
        assert.match(url, /domain=kysigned\.com/);
        return { status: 200, body: [record()] };
      }),
    });
    assert.equal(r.keyAuthenticity, 'archive-confirmed');
    assert.equal(r.observedAt, '2026-06-29T11:42:02.820Z');
  });

  it('a DIFFERENT key value at the same selector → pending-online (no false confirm)', async () => {
    const r = await confirmKeyArchive('kysigned.com', 'sel', EMBEDDED, {
      fetchFn: fakeFetch(() => ({ status: 200, body: [record({ value: 'p=DIFFERENTKEYvalueAAAB==' })] })),
    });
    assert.equal(r.keyAuthenticity, 'pending-online');
    assert.equal(r.observedAt, null);
  });

  it('key absent from the archive (404) → pending-online (never failed)', async () => {
    const r = await confirmKeyArchive('absent.com', 'sel', EMBEDDED, {
      fetchFn: fakeFetch(() => ({ status: 404 })),
    });
    assert.equal(r.keyAuthenticity, 'pending-online');
    assert.equal(r.observedAt, null);
  });

  it('archive unreachable (5xx) → pending-online, never throws', async () => {
    const r = await confirmKeyArchive('x.com', 'sel', EMBEDDED, {
      fetchFn: fakeFetch(() => ({ status: 503 })),
    });
    assert.equal(r.keyAuthenticity, 'pending-online');
  });

  it('a network error → pending-online, never throws', async () => {
    const throwing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await confirmKeyArchive('x.com', 'sel', EMBEDDED, { fetchFn: throwing });
    assert.equal(r.keyAuthenticity, 'pending-online');
  });
});

// F-10.8a (spec 0.77.0, #102, DD-85): the proxy may answer from memory. When that
// answer has records for the pair but none with the bundle's exact key (a provider
// rotated the key under a selector the proxy already remembers), the web verifier
// asks again with fresh=1, so the result is the one the archive itself would give.
describe('F-10.8a — the web verifier asks again fresh (AC-309)', () => {
  const PROXY = { baseUrl: '', path: '/v1/key-archive' };
  const OLD = record({ value: 'p=OLDROTATEDKEYvalueAAAB==' });

  it('F-10.8a a remembered answer without the exact key is asked again fresh and confirms', async () => {
    const urls: string[] = [];
    const r = await confirmKeyArchive('kysigned.com', 'sel', EMBEDDED, {
      ...PROXY,
      retryFresh: true,
      fetchFn: fakeFetch((url) => {
        urls.push(url);
        // The remembered answer holds only the old key; the archive now lists both.
        return /fresh=1/.test(url)
          ? { status: 200, body: [OLD, record()] }
          : { status: 200, body: [OLD] };
      }),
    });
    assert.equal(urls.length, 2, 'exactly one retry');
    assert.doesNotMatch(urls[0]!, /fresh=1/);
    assert.match(urls[1]!, /^\/v1\/key-archive\?domain=kysigned\.com&selector=sel&fresh=1$/);
    assert.equal(r.keyProvenance, 'confirmed', 'confirmed, never FAILED');
    assert.equal(r.keyAuthenticity, 'archive-confirmed');
  });

  it('a fresh retry that still lacks the key is FAILED, as the archive itself says', async () => {
    const r = await confirmKeyArchive('kysigned.com', 'sel', EMBEDDED, {
      ...PROXY,
      retryFresh: true,
      fetchFn: fakeFetch(() => ({ status: 200, body: [OLD] })),
    });
    assert.equal(r.keyProvenance, 'failed');
  });

  it('a fresh retry that fails (archive outage) is pending, never FAILED', async () => {
    const r = await confirmKeyArchive('kysigned.com', 'sel', EMBEDDED, {
      ...PROXY,
      retryFresh: true,
      fetchFn: fakeFetch((url) => (/fresh=1/.test(url) ? { status: 502 } : { status: 200, body: [OLD] })),
    });
    assert.equal(r.keyProvenance, 'pending');
  });

  it('without retryFresh (the CLI, direct to the archive) there is no retry', async () => {
    let calls = 0;
    const r = await confirmKeyArchive('kysigned.com', 'sel', EMBEDDED, {
      fetchFn: fakeFetch(() => { calls++; return { status: 200, body: [OLD] }; }),
    });
    assert.equal(calls, 1);
    assert.equal(r.keyProvenance, 'failed');
  });

  it('a matching first answer makes no retry', async () => {
    let calls = 0;
    await confirmKeyArchive('kysigned.com', 'sel', EMBEDDED, {
      ...PROXY,
      retryFresh: true,
      fetchFn: fakeFetch(() => { calls++; return { status: 200, body: [record()] }; }),
    });
    assert.equal(calls, 1);
  });
});
