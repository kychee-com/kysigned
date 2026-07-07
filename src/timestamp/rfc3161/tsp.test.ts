import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeStampReq, parseTimeStampReq } from './tsp.js';

const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('RFC 3161 TimeStampReq', () => {
  it('builds a request carrying the sha256 messageImprint', () => {
    const hash = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
    const der = buildTimeStampReq(hash);
    assert.ok(der.length > 0);
    const parsed = parseTimeStampReq(der);
    assert.equal(parsed.hashAlgoOid, SHA256_OID);
    assert.equal(hex(parsed.hashedMessage), hex(hash));
  });

  it('round-trips different hashes', () => {
    const hash = Uint8Array.from(Array.from({ length: 32 }, () => 0xab));
    assert.equal(hex(parseTimeStampReq(buildTimeStampReq(hash)).hashedMessage), hex(hash));
  });
});
