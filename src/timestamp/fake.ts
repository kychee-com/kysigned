/**
 * Fake/in-memory provider — F-1 / AC-4.
 *
 * A deterministic, fully offline `TimestampProvider` for tests and the offline
 * e2e (AC-24). It binds the hash and a fixed time into the proof so `verify`
 * genuinely checks the hash (a different hash fails), demonstrating that the
 * contract is usable without any network or real anchor.
 */
import { assertHash32 } from './hash.js';
import { PROOF_VERSION, VERIFY_FAILED, type TimestampProvider } from './contract.js';

export interface FakeProviderOptions {
  /** Fixed attested time in unix seconds (default 1_700_000_000). */
  timeSec?: number;
}

export function createFakeProvider(opts: FakeProviderOptions = {}): TimestampProvider {
  const timeSec = opts.timeSec ?? 1_700_000_000;
  return {
    id: 'fake',
    trustModel: 'fake',
    async stamp(hash) {
      assertHash32(hash);
      const payload = JSON.stringify({ hash: Buffer.from(hash).toString('hex'), timeSec });
      return {
        provider: 'fake',
        version: PROOF_VERSION,
        status: 'complete',
        data: Buffer.from(payload, 'utf8').toString('base64'),
      };
    },
    async verify(proof, hash) {
      if (proof.provider !== 'fake') return { ...VERIFY_FAILED };
      let parsed: { hash?: unknown; timeSec?: unknown };
      try {
        parsed = JSON.parse(Buffer.from(proof.data, 'base64').toString('utf8'));
      } catch {
        return { ...VERIFY_FAILED };
      }
      if (parsed.hash !== Buffer.from(hash).toString('hex')) return { ...VERIFY_FAILED };
      if (typeof parsed.timeSec !== 'number') return { ...VERIFY_FAILED };
      return { ok: true, timeSec: parsed.timeSec, anchor: 'fake' };
    },
  };
}
