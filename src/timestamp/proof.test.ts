import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializeProof, deserializeProof, isTimestampProof } from './proof.js';
import type { TimestampProof } from './contract.js';

const proof: TimestampProof = {
  provider: 'ots',
  version: 1,
  status: 'pending',
  data: Buffer.from([0, 1, 2, 250, 255]).toString('base64'),
  meta: { calendars: ['https://a.pool.opentimestamps.org'] },
};

describe('proof serialize/deserialize', () => {
  it('round-trips a proof losslessly through a string (persist now, verify later)', () => {
    const s = serializeProof(proof);
    assert.equal(typeof s, 'string');
    const back = deserializeProof(s);
    assert.deepEqual(back, proof);
  });

  it('round-trips a proof without meta', () => {
    const p: TimestampProof = { provider: 'rfc3161', version: 1, status: 'complete', data: 'AAEC' };
    assert.deepEqual(deserializeProof(serializeProof(p)), p);
  });

  it('deserialize rejects malformed JSON and non-proof JSON', () => {
    assert.throws(() => deserializeProof('not json'));
    assert.throws(() => deserializeProof('{"foo":1}'));
  });

  it('isTimestampProof guards the runtime shape', () => {
    assert.equal(isTimestampProof(proof), true);
    assert.equal(isTimestampProof({}), false);
    assert.equal(isTimestampProof({ provider: 'x', version: 1, status: 'bogus', data: '' }), false);
    assert.equal(isTimestampProof(null), false);
  });
});
