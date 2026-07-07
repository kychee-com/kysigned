import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePdfHash, decodePdfBase64, fetchPdfFromUrl, PdfUrlError } from './hash.js';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
const publicLookup = async () => ['93.184.216.34'];
const okFetch = (bytes = PDF) => (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;

describe('fetchPdfFromUrl — SSRF guard (F-16.7 / AC-140)', () => {
  it('fetches a normal public https PDF (guard passes)', async () => {
    let calledInit: RequestInit | undefined;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => { calledInit = init; return new Response(PDF, { status: 200 }); }) as unknown as typeof fetch;
    const out = await fetchPdfFromUrl('https://cdn.example.com/doc.pdf', { fetchImpl, lookup: publicLookup });
    assert.deepEqual(out, PDF);
    assert.equal(calledInit?.redirect, 'error', 'host-changing redirects are refused at the fetch layer');
  });

  it('refuses http:// (non-TLS) before any fetch', async () => {
    let fetched = false;
    await assert.rejects(
      () => fetchPdfFromUrl('http://cdn.example.com/x.pdf', { fetchImpl: (async () => { fetched = true; return new Response(PDF); }) as unknown as typeof fetch, lookup: publicLookup }),
      PdfUrlError,
    );
    assert.equal(fetched, false, 'no network on a blocked URL');
  });

  it('refuses a literal private/loopback/metadata host before any fetch', async () => {
    for (const url of ['https://10.0.0.5/x.pdf', 'https://127.0.0.1/x.pdf', 'https://169.254.169.254/latest/meta-data/']) {
      let fetched = false;
      await assert.rejects(
        () => fetchPdfFromUrl(url, { fetchImpl: (async () => { fetched = true; return new Response(PDF); }) as unknown as typeof fetch, lookup: publicLookup }),
        PdfUrlError, `must refuse ${url}`,
      );
      assert.equal(fetched, false);
    }
  });

  it('refuses a PUBLIC hostname that RESOLVES to a private address (no fetch)', async () => {
    let fetched = false;
    await assert.rejects(
      () => fetchPdfFromUrl('https://sneaky.example.com/x.pdf', {
        fetchImpl: (async () => { fetched = true; return new Response(PDF); }) as unknown as typeof fetch,
        lookup: async () => ['169.254.169.254'],
      }),
      PdfUrlError,
    );
    assert.equal(fetched, false, 'DNS-resolved private target is blocked before the request');
  });

  it('maps a redirect / network / timeout rejection to PdfUrlError', async () => {
    await assert.rejects(
      () => fetchPdfFromUrl('https://cdn.example.com/x.pdf', {
        fetchImpl: (async () => { throw new TypeError('unexpected redirect'); }) as unknown as typeof fetch,
        lookup: publicLookup,
      }),
      PdfUrlError,
    );
  });

  it('rejects an oversize download (declared content-length over the cap)', async () => {
    const fetchImpl = (async () => new Response(PDF, { status: 200, headers: { 'content-length': String(999_999_999) } })) as unknown as typeof fetch;
    await assert.rejects(() => fetchPdfFromUrl('https://cdn.example.com/big.pdf', { fetchImpl, lookup: publicLookup, maxBytes: 1024 }), PdfUrlError);
  });

  it('rejects an oversize STREAMED body even without content-length', async () => {
    const big = new Uint8Array(5000);
    const fetchImpl = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(() => fetchPdfFromUrl('https://cdn.example.com/big.pdf', { fetchImpl, lookup: publicLookup, maxBytes: 1024 }), PdfUrlError);
  });

  it('maps a non-2xx response to PdfUrlError', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(() => fetchPdfFromUrl('https://cdn.example.com/missing.pdf', { fetchImpl, lookup: publicLookup }), PdfUrlError);
  });
});

describe('computePdfHash', () => {
  it('should compute SHA-256 of bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = computePdfHash(bytes);
    assert.equal(hash.length, 64); // 32 bytes = 64 hex chars
    assert.ok(/^[0-9a-f]+$/.test(hash));
  });

  it('should be deterministic', () => {
    const bytes = new Uint8Array([10, 20, 30]);
    assert.equal(computePdfHash(bytes), computePdfHash(bytes));
  });

  it('should produce different hashes for different inputs', () => {
    const a = computePdfHash(new Uint8Array([1]));
    const b = computePdfHash(new Uint8Array([2]));
    assert.notEqual(a, b);
  });
});

describe('decodePdfBase64', () => {
  it('should decode base64 to Uint8Array', () => {
    const original = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const base64 = Buffer.from(original).toString('base64');
    const decoded = decodePdfBase64(base64);
    assert.deepEqual(decoded, original);
  });
});
