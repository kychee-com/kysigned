/**
 * OTS attestations — F-5 / AC-9.
 *
 * A leaf of the proof tree: either a `PendingAttestation` (a calendar URL — the
 * proof is not yet Bitcoin-anchored) or a `BitcoinBlockHeaderAttestation` (the
 * commitment is the merkle root of a specific block). Unknown tags (other chains)
 * are kept verbatim so proofs round-trip byte-for-byte.
 *
 * Wire form: 8-byte tag, then varbytes(payload).
 *   pending payload  = varbytes(utf8 uri)
 *   bitcoin payload  = varuint(height)
 */
import { Reader, Writer } from './serialization.js';

export type Attestation =
  | { kind: 'pending'; uri: string }
  | { kind: 'bitcoin'; height: number }
  | { kind: 'unknown'; tag: Uint8Array; payload: Uint8Array };

export const PENDING_TAG = Uint8Array.from([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]);
export const BITCOIN_TAG = Uint8Array.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);

const MAX_PAYLOAD = 8192;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function tagEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function serializeAttestation(att: Attestation, w: Writer): void {
  if (att.kind === 'pending') {
    w.writeBytes(PENDING_TAG);
    const pw = new Writer();
    pw.writeVarbytes(encoder.encode(att.uri));
    w.writeVarbytes(pw.getBytes());
  } else if (att.kind === 'bitcoin') {
    w.writeBytes(BITCOIN_TAG);
    const pw = new Writer();
    pw.writeVaruint(att.height);
    w.writeVarbytes(pw.getBytes());
  } else {
    w.writeBytes(att.tag);
    w.writeVarbytes(att.payload);
  }
}

export function parseAttestation(r: Reader): Attestation {
  const tag = r.readBytes(8).slice();
  const payload = r.readVarbytes(MAX_PAYLOAD);
  if (tagEquals(tag, PENDING_TAG)) {
    return { kind: 'pending', uri: decoder.decode(new Reader(payload).readVarbytes()) };
  }
  if (tagEquals(tag, BITCOIN_TAG)) {
    return { kind: 'bitcoin', height: new Reader(payload).readVaruint() };
  }
  return { kind: 'unknown', tag, payload: payload.slice() };
}
