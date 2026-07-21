/**
 * Regression — the printed-fingerprint scrapers must tolerate FlateDecode streams
 * whose COMPRESSED bytes end in 0x0d/0x0a. The zlib Adler-32 tail is arbitrary, so
 * ~1/256 of signature pages end that way; the web scraper used to blind-trim up to
 * one LF + one CR before `endstream`, chopping a real data byte in that case. The
 * truncated stream made DecompressionStream throw, the fingerprint token went
 * unseen, and a VALID bundle flaked to matchesPrinted=false / tier FAILED
 * (verifyWeb.test.ts:133, CI run 28853931179 — node PROVEN, web FAILED).
 *
 * The node scraper (inflateSync, tolerant of trailing bytes) is asserted alongside
 * as the parity baseline: both engines must see the token in every layout.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { renderedHexTokens } from './verify.js';
import { renderedHexTokensWeb } from './verifyWeb.js';

const HEX = 'deadbeef'.repeat(8);

/** Deflate payloads containing HEX until the compressed bytes end in `lastByte`. */
function deflateEndingIn(lastByte: number): Buffer {
  for (let i = 0; i < 50_000; i++) {
    const z = deflateSync(Buffer.from(`BT (fp ${HEX} pad ${i}) Tj ET`, 'latin1'));
    if (z[z.length - 1] === lastByte) return z;
  }
  throw new Error(`no deflate stream ending 0x${lastByte.toString(16)} within 50k tries`);
}

/** Minimal PDF-shaped bytes: one FlateDecode stream with the given writer EOL. */
function pdfWith(streamBytes: Buffer, writerEol: string): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`, 'latin1'),
      streamBytes,
      Buffer.from(`${writerEol}endstream\nendobj\n%%EOF\n`, 'latin1'),
    ]),
  );
}

describe('printed-fingerprint scrapers — CR/LF-tailed deflate streams', () => {
  const tails: Array<[string, number]> = [
    ['0x0d (CR)', 0x0d],
    ['0x0a (LF)', 0x0a],
  ];
  const eols: Array<[string, string]> = [
    ['\\n (pdf-lib)', '\n'],
    ['\\r\\n', '\r\n'],
    ['none', ''],
  ];
  for (const [tailName, tail] of tails) {
    for (const [eolName, eol] of eols) {
      it(`data ending ${tailName}, writer EOL ${eolName}: both engines see the token`, async () => {
        const bytes = pdfWith(deflateEndingIn(tail), eol);
        assert.ok(renderedHexTokens(bytes).has(HEX), 'node scraper must find the token');
        assert.ok((await renderedHexTokensWeb(bytes)).has(HEX), 'web scraper must find the token');
      });
    }
  }

  it('data ending in a non-EOL byte, writer EOL \\n: both engines see the token (control)', async () => {
    let z: Buffer | null = null;
    for (let i = 0; i < 50_000 && !z; i++) {
      const c = deflateSync(Buffer.from(`BT (fp ${HEX} pad ${i}) Tj ET`, 'latin1'));
      const last = c[c.length - 1];
      if (last !== 0x0a && last !== 0x0d) z = c;
    }
    assert.ok(z, 'found a control stream');
    const bytes = pdfWith(z, '\n');
    assert.ok(renderedHexTokens(bytes).has(HEX));
    assert.ok((await renderedHexTokensWeb(bytes)).has(HEX));
  });
});
