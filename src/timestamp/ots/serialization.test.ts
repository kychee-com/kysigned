import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reader, Writer } from './serialization.js';

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

describe('OTS serialization primitives', () => {
  it('encodes varuint per the documented LEB128 form', () => {
    const cases: Array<[number, string]> = [
      [0, '00'],
      [1, '01'],
      [127, '7f'],
      [128, '8001'],
      [255, 'ff01'],
      [16384, '808001'],
      [1000000, 'c0843d'],
    ];
    for (const [n, expected] of cases) {
      const w = new Writer();
      w.writeVaruint(n);
      assert.equal(hex(w.getBytes()), expected, `varuint(${n})`);
    }
  });

  it('round-trips varuint across a wide range', () => {
    for (const n of [0, 1, 2, 127, 128, 300, 16383, 16384, 2_000_000, 0xffffffff]) {
      const w = new Writer();
      w.writeVaruint(n);
      const r = new Reader(w.getBytes());
      assert.equal(r.readVaruint(), n, `round-trip ${n}`);
      assert.ok(r.atEnd());
    }
  });

  it('rejects a negative or non-integer varuint', () => {
    assert.throws(() => new Writer().writeVaruint(-1));
    assert.throws(() => new Writer().writeVaruint(1.5));
  });

  it('round-trips varbytes (length-prefixed)', () => {
    const payload = Uint8Array.from([1, 2, 3, 250, 255]);
    const w = new Writer();
    w.writeVarbytes(payload);
    // 05 (len prefix) then the 5 payload bytes
    assert.equal(hex(w.getBytes()), '05' + '010203faff');
    const r = new Reader(w.getBytes());
    assert.deepEqual(r.readVarbytes(), payload);
  });

  it('reads fixed bytes and tracks offset', () => {
    const r = new Reader(Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]));
    assert.equal(hex(r.readBytes(2)), 'aabb');
    assert.equal(r.offset, 2);
    assert.equal(r.readByte(), 0xcc);
    assert.equal(r.remaining, 1);
  });

  it('throws on reading past the end of the stream', () => {
    const r = new Reader(Uint8Array.from([0x01]));
    r.readByte();
    assert.throws(() => r.readByte(), /end of OTS stream/);
    assert.throws(() => new Reader(Uint8Array.from([0x05, 0x00])).readVarbytes(), /end of OTS stream/);
  });
});
