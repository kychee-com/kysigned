/**
 * Online Bitcoin-anchor confirmation (F-10.6) — the offline-first web verifier's
 * explicit "Confirm on Bitcoin" action. Best-effort UPGRADE of a signer's `.ots`
 * via the OTS calendar, then VERIFY against a Bitcoin block header → `confirmed`
 * (block height + time) or `pending`. Browser-safe (the OTS module is isomorphic
 * after 26.1; hashing via WebCrypto). NEVER throws and is purely ADDITIVE — the
 * per-signer PROVEN/FAILED verdict never depends on this.
 */
import { parseDetached } from '../timestamp/ots/detached.js';
import { upgradeTimestamp } from '../timestamp/ots/calendar.js';
import { verifyOts } from '../timestamp/ots/verify.js';
import type { HeaderSource } from '../timestamp/ots/header.js';
import { extractEmbeddedFileMapWeb } from './extractWeb.js';
import { signerIndices } from './evidenceOrder.js';
import type { BitcoinAnchor } from './verifyTypes.js';

export interface ConfirmBitcoinDeps {
  /** Bitcoin header source (default: public block explorers). */
  headerSource?: HeaderSource;
  /** Injectable fetch for the calendar upgrade (default: global fetch). */
  fetchFn?: typeof fetch;
}

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
}

function confirmedFrom(res: { timeSec: number; anchor: string }): BitcoinAnchor {
  const m = /bitcoin:block:(\d+):/.exec(res.anchor);
  return {
    status: 'confirmed',
    ...(res.timeSec ? { timeSec: res.timeSec } : {}),
    ...(m ? { blockHeight: Number(m[1]) } : {}),
  };
}

/** Confirm one signer's `.ots` against Bitcoin. Returns `confirmed` or `pending`; never throws. */
export async function confirmOtsAnchor(
  otsBytes: Uint8Array,
  emlHash: Uint8Array,
  deps: ConfirmBitcoinDeps = {},
): Promise<BitcoinAnchor> {
  try {
    let detached = parseDetached(otsBytes);
    // Best-effort: ask the calendar to advance a still-pending proof to Bitcoin.
    try {
      const { timestamp } = await upgradeTimestamp(detached.timestamp, { fetchFn: deps.fetchFn });
      detached = { ...detached, timestamp };
    } catch {
      /* keep the embedded proof; it may already be complete */
    }
    const res = await verifyOts(detached, emlHash, { headerSource: deps.headerSource });
    if (res.ok) return confirmedFrom(res);
  } catch {
    /* fall through to pending — confirmation is additive, never fatal */
  }
  return { status: 'pending' };
}

/** Confirm every signer's Bitcoin anchor in a bundle PDF → `{ signerIndex: BitcoinAnchor }`. */
export async function confirmBitcoinAnchorsWeb(
  pdfBytes: Uint8Array,
  deps: ConfirmBitcoinDeps = {},
): Promise<Record<number, BitcoinAnchor>> {
  const files = await extractEmbeddedFileMapWeb(pdfBytes);
  const out: Record<number, BitcoinAnchor> = {};
  for (const n of signerIndices(files)) {
    const ots = files.get(`proofs/signer-${n}.ots`);
    const eml = files.get(`signer-${n}.eml`);
    if (ots && eml) out[n] = await confirmOtsAnchor(ots, await sha256(eml), deps);
  }
  return out;
}
