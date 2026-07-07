/**
 * DKIM archive client tests — F-6.7 / AC-60 (spec v0.4.0).
 *
 * Offline against a fake fetch matching the proven-live archive.prove.email shapes
 * (docs/research/dkim-archive-verification.md). Asserts: exact-match lookup,
 * contribute-if-missing, idempotent re-contribute, and — critically — that an
 * archive outage NEVER throws and NEVER blocks (ensureKeyArchived returns
 * outage:true, archived:false).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupArchivedKey,
  contributeKey,
  ensureKeyArchived,
} from './dkimArchive.js';

/** Build a fake fetch from a handler returning { status, body }. */
function fakeFetch(handler: (url: string, init?: any) => { status: number; body?: any } | Promise<{ status: number; body?: any }>) {
  return (async (url: string, init?: any) => {
    const { status, body } = await handler(String(url), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
}

const RECORD = {
  domain: 'kychee.com',
  selector: 'google',
  firstSeenAt: '2026-06-13T08:38:15.767Z',
  lastSeenAt: '2026-06-13T08:38:15.767Z',
  value: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...IDAQAB',
};

describe('lookupArchivedKey — GET /api/key/domain', () => {
  it('finds an archived key (exact-match record)', async () => {
    const r = await lookupArchivedKey('kychee.com', 'google', {
      fetchFn: fakeFetch((url) => {
        assert.match(url, /\/api\/key\/domain\?/);
        assert.match(url, /domain=kychee\.com/);
        assert.match(url, /selector=google/);
        return { status: 200, body: RECORD };
      }),
    });
    assert.equal(r.found, true);
    assert.equal(r.records[0].value, RECORD.value);
  });

  it('handles an array response shape', async () => {
    const r = await lookupArchivedKey('a.com', 's', { fetchFn: fakeFetch(() => ({ status: 200, body: [RECORD] })) });
    assert.equal(r.found, true);
    assert.equal(r.records.length, 1);
  });

  it('reports not-found for an empty/records:0 body', async () => {
    const r = await lookupArchivedKey('absent.com', 's', { fetchFn: fakeFetch(() => ({ status: 200, body: { records: 0 } })) });
    assert.equal(r.found, false);
    assert.equal(r.records.length, 0);
  });

  it('reports not-found on 404', async () => {
    const r = await lookupArchivedKey('absent.com', 's', { fetchFn: fakeFetch(() => ({ status: 404 })) });
    assert.equal(r.found, false);
  });

  it('uses the same-origin proxy path when configured (web verifier reaches the archive past CORS; F-10.8)', async () => {
    let calledUrl = '';
    await lookupArchivedKey('kysigned.com', 'sel', {
      baseUrl: '',
      path: '/v1/key-archive',
      fetchFn: fakeFetch((url) => {
        calledUrl = url;
        return { status: 200, body: [RECORD] };
      }),
    });
    assert.equal(calledUrl, '/v1/key-archive?domain=kysigned.com&selector=sel');
  });

  it('defaults to the direct archive.prove.email endpoint (CLI; no proxy)', async () => {
    let calledUrl = '';
    await lookupArchivedKey('kysigned.com', 'sel', {
      fetchFn: fakeFetch((url) => {
        calledUrl = url;
        return { status: 200, body: [RECORD] };
      }),
    });
    assert.match(calledUrl, /^https:\/\/archive\.prove\.email\/api\/key\/domain\?domain=kysigned\.com&selector=sel$/);
  });
});

describe('contributeKey — POST /api/dsp', () => {
  it('adds a new key (HTTP 201, addResult.added)', async () => {
    const r = await contributeKey('kychee.com', 'google', {
      fetchFn: fakeFetch((url, init) => {
        assert.match(url, /\/api\/dsp$/);
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(init.body), { domain: 'kychee.com', selector: 'google' });
        return { status: 201, body: { addResult: { already_in_db: false, added: true } } };
      }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.added, true);
    assert.equal(r.alreadyPresent, false);
  });

  it('is idempotent on re-contribute (HTTP 200, already_in_db)', async () => {
    const r = await contributeKey('kychee.com', 'google', {
      fetchFn: fakeFetch(() => ({ status: 200, body: { already_in_db: true, added: false } })),
    });
    assert.equal(r.ok, true);
    assert.equal(r.added, false);
    assert.equal(r.alreadyPresent, true);
  });

  it('reports a non-success status', async () => {
    const r = await contributeKey('x.com', 's', { fetchFn: fakeFetch(() => ({ status: 500 })) });
    assert.equal(r.ok, false);
    assert.equal(r.status, 500);
  });
});

describe('ensureKeyArchived — check-and-contribute-on-receipt (AC-60)', () => {
  it('no-ops (no POST) when the key is already archived', async () => {
    let posted = false;
    const r = await ensureKeyArchived('gmail.com', '20251104', {
      fetchFn: fakeFetch((url) => {
        if (url.includes('/api/dsp')) posted = true;
        return { status: 200, body: RECORD };
      }),
    });
    assert.equal(r.archived, true);
    assert.equal(r.contributed, false);
    assert.equal(r.outage, false);
    assert.equal(posted, false, 'must not contribute an already-present key');
  });

  it('contributes a missing key, then reports archived+contributed', async () => {
    const r = await ensureKeyArchived('kychee.com', 'google', {
      fetchFn: fakeFetch((url) => {
        if (url.includes('/api/dsp')) return { status: 201, body: { addResult: { added: true, already_in_db: false } } };
        return { status: 200, body: { records: 0 } }; // lookup: absent
      }),
    });
    assert.equal(r.archived, true);
    assert.equal(r.contributed, true);
    assert.equal(r.outage, false);
  });

  it('handles a contribute race (lookup absent, POST says already_in_db)', async () => {
    const r = await ensureKeyArchived('kychee.com', 'google', {
      fetchFn: fakeFetch((url) => {
        if (url.includes('/api/dsp')) return { status: 200, body: { already_in_db: true, added: false } };
        return { status: 200, body: { records: 0 } };
      }),
    });
    assert.equal(r.archived, true);
    assert.equal(r.contributed, false);
  });

  it('AC-60: an archive 5xx on lookup is a non-blocking outage (no throw)', async () => {
    const r = await ensureKeyArchived('x.com', 's', { fetchFn: fakeFetch(() => ({ status: 503 })) });
    assert.equal(r.outage, true);
    assert.equal(r.archived, false);
  });

  it('AC-60: a network error never throws (outage)', async () => {
    const throwingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await ensureKeyArchived('x.com', 's', { fetchFn: throwingFetch });
    assert.equal(r.outage, true);
    assert.equal(r.archived, false);
  });

  it('AC-60: lookup-absent + contribute-fails is a non-blocking outage', async () => {
    const r = await ensureKeyArchived('x.com', 's', {
      fetchFn: fakeFetch((url) => (url.includes('/api/dsp') ? { status: 500 } : { status: 200, body: { records: 0 } })),
    });
    assert.equal(r.outage, true);
    assert.equal(r.archived, false);
  });
});
