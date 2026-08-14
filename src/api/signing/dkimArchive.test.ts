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
  confirmKeyAtSigning,
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

describe('confirmKeyAtSigning — receipt-time verifier-parity confirmation (F-32.6 / AC-163)', () => {
  const OTHER_KEY = 'v=DKIM1; k=rsa; p=DIFFERENTKEYBYTESZZZZZZZZZZZZZZZZZZZZZZ';

  it('confirmed: the archive holds the EXACT observed key with a usable last-seen (no POST)', async () => {
    let posted = false;
    const r = await confirmKeyAtSigning('kychee.com', 'google', RECORD.value, {
      fetchFn: fakeFetch((url) => {
        if (url.includes('/api/dsp')) posted = true;
        return { status: 200, body: [RECORD] };
      }),
    });
    assert.equal(r.outcome, 'confirmed');
    assert.equal(r.lastSeenAt, RECORD.lastSeenAt);
    assert.equal(r.nudged, false);
    assert.equal(posted, false, 'a confirmed key needs no contribute POST');
  });

  it('parity matches on key bytes, not raw TXT formatting (whitespace/order-insensitive p= compare)', async () => {
    const reformatted = `k=rsa; v=DKIM1; p=${/p=([^;]*)/i.exec(RECORD.value)![1].replace(/(.{10})/g, '$1 ')}`;
    const r = await confirmKeyAtSigning('kychee.com', 'google', reformatted, {
      fetchFn: fakeFetch(() => ({ status: 200, body: [RECORD] })),
    });
    assert.equal(r.outcome, 'confirmed');
  });

  it('rotation under a reused selector: records exist but lack the observed key → POSTs the nudge, unconfirmed (the old flow skipped this POST)', async () => {
    let posted = false;
    const r = await confirmKeyAtSigning('outlook.com', 'selector1', RECORD.value, {
      fetchFn: fakeFetch((url) => {
        if (url.includes('/api/dsp')) {
          posted = true;
          return { status: 200, body: { already_in_db: true, added: false } };
        }
        return { status: 200, body: [{ ...RECORD, value: OTHER_KEY }] };
      }),
    });
    assert.equal(r.outcome, 'unconfirmed');
    assert.equal(r.nudged, true);
    assert.equal(posted, true, 'must contribute even when the selector already has (stale) records');
  });

  it('exact key present but NO usable time → nudges and stays unconfirmed', async () => {
    let posted = false;
    const noTimes = { domain: RECORD.domain, selector: RECORD.selector, value: RECORD.value };
    const r = await confirmKeyAtSigning('kychee.com', 'google', RECORD.value, {
      fetchFn: fakeFetch((url) => {
        if (url.includes('/api/dsp')) {
          posted = true;
          return { status: 200, body: { already_in_db: true, added: false } };
        }
        return { status: 200, body: [noTimes] };
      }),
    });
    assert.equal(r.outcome, 'unconfirmed');
    assert.equal(posted, true);
  });

  it('absent selector → contributes; contributed-now is UNCONFIRMED (read path may lag; the sweep heals it)', async () => {
    const r = await confirmKeyAtSigning('kychee.com', 'google', RECORD.value, {
      fetchFn: fakeFetch((url) => {
        if (url.includes('/api/dsp')) return { status: 201, body: { addResult: { added: true, already_in_db: false } } };
        return { status: 200, body: { records: 0 } };
      }),
    });
    assert.equal(r.outcome, 'unconfirmed');
    assert.equal(r.nudged, true);
    assert.equal(r.lastSeenAt, null);
  });

  it('no observed key to compare (resolveDkimKey failed) → parity not evaluable: unconfirmed, no nudge when records exist', async () => {
    let posted = false;
    const r = await confirmKeyAtSigning('kychee.com', 'google', null, {
      fetchFn: fakeFetch((url) => {
        if (url.includes('/api/dsp')) posted = true;
        return { status: 200, body: [RECORD] };
      }),
    });
    assert.equal(r.outcome, 'unconfirmed');
    assert.equal(posted, false);
  });

  it('archive outage on lookup → outage, never throws (receipt proceeds; AC-163)', async () => {
    const r = await confirmKeyAtSigning('x.com', 's', RECORD.value, {
      fetchFn: fakeFetch(() => ({ status: 503 })),
    });
    assert.equal(r.outcome, 'outage');
  });

  it('network error → outage, never throws', async () => {
    const throwingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await confirmKeyAtSigning('x.com', 's', RECORD.value, { fetchFn: throwingFetch });
    assert.equal(r.outcome, 'outage');
  });

  it('absent selector + failed contribute → outage', async () => {
    const r = await confirmKeyAtSigning('x.com', 's', RECORD.value, {
      fetchFn: fakeFetch((url) => (url.includes('/api/dsp') ? { status: 500 } : { status: 200, body: { records: 0 } })),
    });
    assert.equal(r.outcome, 'outage');
  });
});

// ── F-32.9/F-32.4 live-shape client (spec 0.71.0, zkemail/archive#46 live 2026-08) ──

const OBS_LIVE = { source: 'live_dns', firstSeenAt: '2026-03-25T16:30:56.769Z', lastSeenAt: '2026-08-09T20:03:36.763Z' };
const OBS_GCD = { source: 'gcd_recovered', firstSeenAt: '2024-01-01T00:00:00.000Z', lastSeenAt: '2026-07-01T00:00:00.000Z' };

describe('liveLastSeenAt — the F-32.4 live-only window input (#147-A)', () => {
  it('takes the live_dns channel lastSeenAt when observations are present', async () => {
    const mod = (await import('./dkimArchive.js')) as Record<string, unknown>;
    const liveLastSeenAt = mod.liveLastSeenAt as ((r: unknown) => string | null) | undefined;
    assert.ok(liveLastSeenAt, 'liveLastSeenAt is exported');
    assert.equal(liveLastSeenAt!({ ...RECORD, observations: [OBS_LIVE, OBS_GCD] }), OBS_LIVE.lastSeenAt);
  });

  it('a record with observations but NO live_dns channel has no usable live window', async () => {
    const { liveLastSeenAt } = (await import('./dkimArchive.js')) as any;
    assert.equal(liveLastSeenAt({ ...RECORD, observations: [OBS_GCD] }), null);
    assert.equal(liveLastSeenAt({ ...RECORD, observations: [] }), null);
  });

  it('falls back to the single-channel top-level times when observations are absent (fixtures/back-compat)', async () => {
    const { liveLastSeenAt } = (await import('./dkimArchive.js')) as any;
    assert.equal(liveLastSeenAt(RECORD), RECORD.lastSeenAt);
  });
});

describe('confirmKeyAtSigning — live-only parity (a GCD-only window never confirms)', () => {
  it('a record whose only observations are gcd_recovered is unconfirmed (nudged), not confirmed', async () => {
    let nudged = false;
    const r = await confirmKeyAtSigning('kychee.com', 'google', RECORD.value, {
      fetchFn: fakeFetch((url) => {
        if (url.includes('/api/dsp')) { nudged = true; return { status: 200, body: { addResult: { already_in_db: true, added: false } } }; }
        return { status: 200, body: { ...RECORD, observations: [OBS_GCD] } };
      }),
    });
    assert.equal(r.outcome, 'unconfirmed');
    assert.equal(r.lastSeenAt, null);
    assert.equal(nudged, true, 'a no-live-window record still nudges a fresh observation');
  });

  it('a live_dns-observed record still confirms with the live bound', async () => {
    const r = await confirmKeyAtSigning('kychee.com', 'google', RECORD.value, {
      fetchFn: fakeFetch(() => ({ status: 200, body: { ...RECORD, observations: [OBS_LIVE] } })),
    });
    assert.equal(r.outcome, 'confirmed');
    assert.equal(r.lastSeenAt, OBS_LIVE.lastSeenAt);
  });
});

describe('normalizeRecords hardening — a record led by id without top-level domain still parses', () => {
  it('single-object response with value but no domain field is a record, not []', async () => {
    const { domain: _drop, ...noDomain } = RECORD as Record<string, unknown>;
    const r = await lookupArchivedKey('kychee.com', 'google', {
      fetchFn: fakeFetch(() => ({ status: 200, body: { id: 1428710, ...noDomain } })),
    });
    assert.equal(r.found, true);
    assert.equal(r.records[0]?.value, RECORD.value);
  });
});

describe('fetchArchiveStatements — GET /api/key/statement (F-32.9)', () => {
  function fakeFetchH(seq: Array<{ status: number; body?: unknown; retryAfter?: string }>) {
    let i = 0;
    const calls: string[] = [];
    const fn = (async (url: string) => {
      calls.push(String(url));
      const step = seq[Math.min(i++, seq.length - 1)];
      return {
        ok: step.status >= 200 && step.status < 300,
        status: step.status,
        headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? step.retryAfter ?? null : null) },
        json: async () => step.body,
      };
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it('returns the JWS array on 200', async () => {
    const mod = (await import('./dkimArchive.js')) as any;
    assert.ok(mod.fetchArchiveStatements, 'fetchArchiveStatements is exported');
    const { fn, calls } = fakeFetchH([{ status: 200, body: ['eyJ.a.b', 'eyJ.c.d'] }]);
    const r = await mod.fetchArchiveStatements('gmail.com', '20251104', { fetchFn: fn });
    assert.deepEqual(r.statements, ['eyJ.a.b', 'eyJ.c.d']);
    assert.equal(r.outage, false);
    assert.match(calls[0], /\/api\/key\/statement\?domain=gmail\.com&selector=20251104/);
  });

  it('a GCD-only pair returns 200 [] — empty capture, no outage', async () => {
    const { fn } = fakeFetchH([{ status: 200, body: [] }]);
    const { fetchArchiveStatements } = (await import('./dkimArchive.js')) as any;
    const r = await fetchArchiveStatements('gcd-only.com', 's', { fetchFn: fn });
    assert.deepEqual(r.statements, []);
    assert.equal(r.outage, false);
  });

  it('honors one bounded Retry-After on 429, then succeeds', async () => {
    const { fn, calls } = fakeFetchH([{ status: 429, retryAfter: '0' }, { status: 200, body: ['eyJ.a.b'] }]);
    const { fetchArchiveStatements } = (await import('./dkimArchive.js')) as any;
    const r = await fetchArchiveStatements('gmail.com', '20251104', { fetchFn: fn });
    assert.deepEqual(r.statements, ['eyJ.a.b']);
    assert.equal(calls.length, 2);
  });

  it('429 twice → outage (retriable later); 5xx → outage; network throw → outage; non-array body → []', async () => {
    const { fetchArchiveStatements } = (await import('./dkimArchive.js')) as any;
    const twice429 = fakeFetchH([{ status: 429, retryAfter: '0' }, { status: 429, retryAfter: '0' }]);
    assert.equal((await fetchArchiveStatements('a.com', 's', { fetchFn: twice429.fn })).outage, true);
    const five = fakeFetchH([{ status: 503 }]);
    assert.equal((await fetchArchiveStatements('a.com', 's', { fetchFn: five.fn })).outage, true);
    const thrower = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    assert.equal((await fetchArchiveStatements('a.com', 's', { fetchFn: thrower })).outage, true);
    const junk = fakeFetchH([{ status: 200, body: { not: 'an array' } }]);
    assert.deepEqual((await fetchArchiveStatements('a.com', 's', { fetchFn: junk.fn })).statements, []);
  });
});
