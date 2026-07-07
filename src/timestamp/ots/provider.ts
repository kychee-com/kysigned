/**
 * OpenTimestamps provider — F-2 / AC-5, AC-23.
 *
 * Wires the calendar client, the `.ots` codec, upgrade, and chain verification
 * into the `TimestampProvider` contract (id = "ots"). Entirely our own code over
 * `fetch` + the runtime hash primitives — no `opentimestamps` dependency. The
 * proof envelope's `data` is base64 of the standard `.ots` artifact, so it is
 * interchangeable with any reference OTS tool.
 */
import { PROOF_VERSION, VERIFY_FAILED, type TimestampProof, type TimestampProvider } from '../contract.js';
import { assertHash32 } from '../hash.js';
import { parseDetached, serializeDetached, type DetachedTimestamp } from './detached.js';
import { stampWithCalendars, upgradeTimestamp, type StampDeps } from './calendar.js';
import { collectAttestations } from './timestamp.js';
import { verifyOts } from './verify.js';
import type { HeaderSource } from './header.js';

/** Public OTS calendars (verify the live list at stamping time). */
export const DEFAULT_CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://alice.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
];

export interface OtsProviderOptions {
  /** Calendar URLs to submit to (default: the public pool, ≥2). */
  calendars?: string[];
  /** Bitcoin header source for verification (default: block-explorer API). */
  headerSource?: HeaderSource;
  /** Injectable fetch (tests). */
  fetchFn?: typeof fetch;
  /** Injectable nonce RNG (tests). */
  randomBytes?: (n: number) => Uint8Array;
}

function proofStatus(detached: DetachedTimestamp): 'pending' | 'complete' {
  return collectAttestations(detached.timestamp).some((a) => a.attestation.kind === 'bitcoin')
    ? 'complete'
    : 'pending';
}

function encode(detached: DetachedTimestamp, calendars: string[]): TimestampProof {
  return {
    provider: 'ots',
    version: PROOF_VERSION,
    status: proofStatus(detached),
    data: Buffer.from(serializeDetached(detached)).toString('base64'),
    meta: { calendars },
  };
}

function decode(proof: TimestampProof): DetachedTimestamp {
  return parseDetached(Uint8Array.from(Buffer.from(proof.data, 'base64')));
}

export function createOtsProvider(opts: OtsProviderOptions = {}): TimestampProvider {
  const calendars = opts.calendars ?? DEFAULT_CALENDARS;
  const stampDeps: StampDeps = { fetchFn: opts.fetchFn, randomBytes: opts.randomBytes };

  return {
    id: 'ots',
    trustModel: 'bitcoin-math',
    async stamp(hash) {
      assertHash32(hash);
      const timestamp = await stampWithCalendars(hash, calendars, stampDeps);
      return encode({ hashOp: 'sha256', digest: hash, timestamp }, calendars);
    },
    async verify(proof, hash) {
      if (proof.provider !== 'ots') return { ...VERIFY_FAILED };
      let detached: DetachedTimestamp;
      try {
        detached = decode(proof);
      } catch {
        return { ...VERIFY_FAILED };
      }
      return verifyOts(detached, hash, { headerSource: opts.headerSource });
    },
    async upgrade(proof) {
      const detached = decode(proof);
      const { timestamp } = await upgradeTimestamp(detached.timestamp, stampDeps);
      const cals = (proof.meta?.calendars as string[] | undefined) ?? calendars;
      return encode({ ...detached, timestamp }, cals);
    },
  };
}
