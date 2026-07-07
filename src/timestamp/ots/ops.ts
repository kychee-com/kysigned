/**
 * OTS operations — F-5 / AC-9.
 *
 * The hash-op tree edges. Binary ops (append/prepend) carry an argument; unary
 * crypto ops (sha256/ripemd160) transform the message. Tags are the documented
 * OTS values. ripemd160 + sha256 are the pair Bitcoin's commitment path uses.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { Reader, Writer } from './serialization.js';

export type Op =
  | { kind: 'append'; arg: Uint8Array }
  | { kind: 'prepend'; arg: Uint8Array }
  | { kind: 'sha256' }
  | { kind: 'ripemd160' };

export const OP_TAG = {
  append: 0xf0,
  prepend: 0xf1,
  sha256: 0x08,
  ripemd160: 0x03,
} as const;

/** Bound on an op argument's length (matches the reference impl's safety cap). */
const MAX_OP_ARG = 4096;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Apply an op to a message, producing the next message in the chain. */
export function applyOp(op: Op, msg: Uint8Array): Uint8Array {
  switch (op.kind) {
    case 'append':
      return concat(msg, op.arg);
    case 'prepend':
      return concat(op.arg, msg);
    case 'sha256':
      return sha256(msg);
    case 'ripemd160':
      return ripemd160(msg);
  }
}

/** Serialize an op: its tag, plus a varbytes argument for binary ops. */
export function serializeOp(op: Op, w: Writer): void {
  w.writeByte(OP_TAG[op.kind]);
  if (op.kind === 'append' || op.kind === 'prepend') {
    w.writeVarbytes(op.arg);
  }
}

/** Parse an op given its already-read tag byte; reads the argument for binary ops. */
export function parseOp(tag: number, r: Reader): Op {
  switch (tag) {
    case OP_TAG.append:
      return { kind: 'append', arg: r.readVarbytes(MAX_OP_ARG) };
    case OP_TAG.prepend:
      return { kind: 'prepend', arg: r.readVarbytes(MAX_OP_ARG) };
    case OP_TAG.sha256:
      return { kind: 'sha256' };
    case OP_TAG.ripemd160:
      return { kind: 'ripemd160' };
    default:
      throw new Error(`unknown OTS op tag 0x${tag.toString(16).padStart(2, '0')}`);
  }
}
