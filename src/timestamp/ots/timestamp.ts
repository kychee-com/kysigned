/**
 * OTS timestamp tree — F-5 / AC-9.
 *
 * A node carries a message and a list of branches; each branch is either an
 * attestation leaf or an op edge to a child whose message is `applyOp(op, msg)`.
 * On the wire, every branch except the last is prefixed with 0xff ("more
 * follows"); an attestation branch is marked 0x00, an op branch by its op tag.
 * Branch order is preserved verbatim so canonical proofs round-trip byte-for-byte.
 */
import { Reader, Writer } from './serialization.js';
import { applyOp, parseOp, serializeOp, type Op } from './ops.js';
import { parseAttestation, serializeAttestation, type Attestation } from './attestation.js';

export type Branch =
  | { type: 'attestation'; attestation: Attestation }
  | { type: 'op'; op: Op; child: Timestamp };

export interface Timestamp {
  /** The message bytes at this node (recomputed from the parent on parse). */
  msg: Uint8Array;
  branches: Branch[];
}

export function serializeTimestamp(ts: Timestamp, w: Writer): void {
  const n = ts.branches.length;
  for (let i = 0; i < n; i++) {
    const br = ts.branches[i];
    if (i < n - 1) w.writeByte(0xff);
    if (br.type === 'attestation') {
      w.writeByte(0x00);
      serializeAttestation(br.attestation, w);
    } else {
      serializeOp(br.op, w);
      serializeTimestamp(br.child, w);
    }
  }
}

export function deserializeTimestamp(r: Reader, msg: Uint8Array): Timestamp {
  const branches: Branch[] = [];
  const readBranch = (tag: number): void => {
    if (tag === 0x00) {
      branches.push({ type: 'attestation', attestation: parseAttestation(r) });
    } else {
      const op = parseOp(tag, r);
      const child = deserializeTimestamp(r, applyOp(op, msg));
      branches.push({ type: 'op', op, child });
    }
  };
  let tag = r.readByte();
  while (tag === 0xff) {
    readBranch(r.readByte());
    tag = r.readByte();
  }
  readBranch(tag);
  return { msg, branches };
}

/**
 * Flatten the tree to (attestation, committed-message) pairs. For a Bitcoin
 * attestation the message is the value the verifier matches against the block's
 * merkle root.
 */
export function collectAttestations(
  ts: Timestamp,
): Array<{ attestation: Attestation; msg: Uint8Array }> {
  const out: Array<{ attestation: Attestation; msg: Uint8Array }> = [];
  const walk = (node: Timestamp): void => {
    for (const br of node.branches) {
      if (br.type === 'attestation') out.push({ attestation: br.attestation, msg: node.msg });
      else walk(br.child);
    }
  };
  walk(ts);
  return out;
}
