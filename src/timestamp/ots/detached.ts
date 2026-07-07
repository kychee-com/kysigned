/**
 * OTS detached timestamp file (`.ots`) — F-5 / AC-9.
 *
 * Wire form: 31-byte header magic, major version (varuint), the file-hash op tag,
 * the file digest, then the timestamp tree rooted at that digest.
 */
import { hexToBytes } from '@noble/hashes/utils.js';
import { Reader, Writer } from './serialization.js';
import { deserializeTimestamp, serializeTimestamp, type Timestamp } from './timestamp.js';

/** `\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94` (31 bytes). */
export const OTS_MAGIC = hexToBytes('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294');

const MAJOR_VERSION = 1;

export type FileHashOp = 'sha256' | 'ripemd160' | 'sha1';
const HASH_OP_TAG: Record<FileHashOp, number> = { sha256: 0x08, ripemd160: 0x03, sha1: 0x02 };
const HASH_OP_LEN: Record<FileHashOp, number> = { sha256: 32, ripemd160: 20, sha1: 20 };
const TAG_TO_HASH_OP: Record<number, FileHashOp> = { 0x08: 'sha256', 0x03: 'ripemd160', 0x02: 'sha1' };

export interface DetachedTimestamp {
  hashOp: FileHashOp;
  digest: Uint8Array;
  timestamp: Timestamp;
}

export function serializeDetached(d: DetachedTimestamp): Uint8Array {
  const w = new Writer();
  w.writeBytes(OTS_MAGIC);
  w.writeVaruint(MAJOR_VERSION);
  w.writeByte(HASH_OP_TAG[d.hashOp]);
  w.writeBytes(d.digest);
  serializeTimestamp(d.timestamp, w);
  return w.getBytes();
}

export function parseDetached(bytes: Uint8Array): DetachedTimestamp {
  const r = new Reader(bytes);
  const magic = r.readBytes(OTS_MAGIC.length);
  for (let i = 0; i < OTS_MAGIC.length; i++) {
    if (magic[i] !== OTS_MAGIC[i]) {
      throw new Error('not an OpenTimestamps proof (bad header magic)');
    }
  }
  const version = r.readVaruint();
  if (version !== MAJOR_VERSION) throw new Error(`unsupported OTS major version ${version}`);
  const tag = r.readByte();
  const hashOp = TAG_TO_HASH_OP[tag];
  if (!hashOp) throw new Error(`unknown OTS file-hash op tag 0x${tag.toString(16).padStart(2, '0')}`);
  const digest = r.readBytes(HASH_OP_LEN[hashOp]).slice();
  const timestamp = deserializeTimestamp(r, digest);
  if (!r.atEnd()) throw new Error('trailing bytes after OTS proof');
  return { hashOp, digest, timestamp };
}
