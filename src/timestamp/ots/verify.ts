/**
 * OTS verification against the real Bitcoin chain — F-6 / AC-10, AC-11.
 *
 * Walk the proof from the file hash, re-applying each op to derive the commitment
 * at every Bitcoin attestation (so a tampered op-tree or planted message can't
 * pass). Fetch that block's header and check the commitment equals its merkle
 * root (the proof commitment is internal/LE order; explorers show display/BE, so
 * we reverse). On a match the timestamp is the block header's time — never the
 * proof's self-claimed value.
 */
import { VERIFY_FAILED, type VerifyResult } from '../contract.js';
import { applyOp } from './ops.js';
import type { Timestamp } from './timestamp.js';
import type { DetachedTimestamp } from './detached.js';
import { createExplorerHeaderSource, type HeaderSource } from './header.js';
import { hexToBytes } from '@noble/hashes/utils.js';

export interface VerifyOtsDeps {
  headerSource?: HeaderSource;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fromHex(h: string): Uint8Array {
  return hexToBytes(h.toLowerCase());
}

function reverse(b: Uint8Array): Uint8Array {
  return Uint8Array.from([...b].reverse());
}

/** Re-derive (height, commitment) for every Bitcoin attestation, applying ops from `msg`. */
function collectBitcoinCommitments(
  ts: Timestamp,
  msg: Uint8Array,
  out: Array<{ height: number; commitment: Uint8Array }>,
): void {
  for (const br of ts.branches) {
    if (br.type === 'attestation') {
      if (br.attestation.kind === 'bitcoin') out.push({ height: br.attestation.height, commitment: msg });
    } else {
      collectBitcoinCommitments(br.child, applyOp(br.op, msg), out);
    }
  }
}

export async function verifyOts(
  detached: DetachedTimestamp,
  hash: Uint8Array,
  deps?: VerifyOtsDeps,
): Promise<VerifyResult> {
  // The proof must be for exactly this hash.
  if (hash.length !== 32 || !bytesEqual(detached.digest, hash)) return { ...VERIFY_FAILED };

  const commitments: Array<{ height: number; commitment: Uint8Array }> = [];
  collectBitcoinCommitments(detached.timestamp, hash, commitments);
  if (commitments.length === 0) return { ...VERIFY_FAILED }; // pending / not anchored

  const headerSource = deps?.headerSource ?? createExplorerHeaderSource();
  for (const { height, commitment } of commitments) {
    let header;
    try {
      header = await headerSource.getBlockHeader(height);
    } catch {
      continue; // try the next attestation / explorer
    }
    const internalRoot = reverse(fromHex(header.merkleRoot));
    if (bytesEqual(commitment, internalRoot)) {
      return { ok: true, timeSec: header.timeSec, anchor: `bitcoin:block:${height}:${header.blockHash}` };
    }
  }
  return { ...VERIFY_FAILED };
}
