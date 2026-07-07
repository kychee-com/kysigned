import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyOp, serializeOp, parseOp, type Op } from './ops.js';
import { Reader, Writer } from './serialization.js';

const msg = Uint8Array.from([0x11, 0x22, 0x33]);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('OTS ops', () => {
  it('append/prepend concatenate the argument', () => {
    assert.deepEqual(
      applyOp({ kind: 'append', arg: Uint8Array.from([0xaa, 0xbb]) }, msg),
      Uint8Array.from([0x11, 0x22, 0x33, 0xaa, 0xbb]),
    );
    assert.deepEqual(
      applyOp({ kind: 'prepend', arg: Uint8Array.from([0xaa]) }, msg),
      Uint8Array.from([0xaa, 0x11, 0x22, 0x33]),
    );
  });

  it('sha256/ripemd160 match node crypto', () => {
    assert.equal(hex(applyOp({ kind: 'sha256' }, msg)), createHash('sha256').update(msg).digest('hex'));
    assert.equal(hex(applyOp({ kind: 'ripemd160' }, msg)), createHash('ripemd160').update(msg).digest('hex'));
  });

  it('serialize/parse round-trips each op with the documented tag', () => {
    const cases: Array<[Op, string]> = [
      [{ kind: 'append', arg: Uint8Array.from([1, 2]) }, 'f0020102'],
      [{ kind: 'prepend', arg: Uint8Array.from([9]) }, 'f10109'],
      [{ kind: 'sha256' }, '08'],
      [{ kind: 'ripemd160' }, '03'],
    ];
    for (const [op, expected] of cases) {
      const w = new Writer();
      serializeOp(op, w);
      assert.equal(hex(w.getBytes()), expected, JSON.stringify(op));
      const r = new Reader(w.getBytes());
      assert.deepEqual(parseOp(r.readByte(), r), op);
    }
  });

  it('parseOp throws on an unknown op tag', () => {
    assert.throws(() => parseOp(0x99, new Reader(new Uint8Array())), /unknown OTS op/i);
  });
});
