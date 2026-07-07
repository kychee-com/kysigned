/**
 * One-off: fetch a REAL RFC 3161 token from freeTSA for a fixed hash and save it
 * as an offline test fixture. The token is reference-produced (freeTSA's TSA),
 * independent of our code. Run: `node --import tsx scripts/gen-rfc3161-fixture.ts`
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildTimeStampReq } from '../src/timestamp/rfc3161/tsp.js';

const content = Buffer.from('kysigned-timestamp-module-rfc3161-fixture-2026-06-14');
const hash = new Uint8Array(createHash('sha256').update(content).digest());
const req = buildTimeStampReq(hash);

const res = await fetch('https://freetsa.org/tsr', {
  method: 'POST',
  headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' },
  body: Buffer.from(req),
});
console.log('HTTP', res.status, res.headers.get('content-type'));
const resp = new Uint8Array(await res.arrayBuffer());
const dir = 'src/timestamp/rfc3161/fixtures';
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/freetsa-resp.der`, Buffer.from(resp));
writeFileSync(`${dir}/hash.hex`, Buffer.from(hash).toString('hex'));
console.log('saved resp bytes:', resp.length, 'hash:', Buffer.from(hash).toString('hex'));
