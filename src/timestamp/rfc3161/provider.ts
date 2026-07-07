/**
 * RFC 3161 TSA provider — F-8 / AC-15, AC-16, AC-17, AC-23.
 *
 * Stamps by POSTing a TimeStampReq to a TSA and keeping the returned token; verifies
 * the token's signature + imprint. Its trust model is an honestly-labelled trusted
 * third party (the TSA + its CA), distinct from OTS's Bitcoin/math anchor.
 */
import { PROOF_VERSION, VERIFY_FAILED, type TimestampProof, type TimestampProvider } from '../contract.js';
import { assertHash32 } from '../hash.js';
import { buildTimeStampReq, extractToken, verifyToken } from './tsp.js';

/** Default free, documented TSA. */
export const DEFAULT_TSA_URL = 'https://freetsa.org/tsr';

export interface Rfc3161ProviderOptions {
  /** TSA endpoint (default freeTSA). */
  tsaUrl?: string;
  /** Injectable fetch (tests). */
  fetchFn?: typeof fetch;
}

function resolveFetch(fetchFn?: typeof fetch): typeof fetch {
  const f = fetchFn ?? (globalThis.fetch as typeof fetch | undefined);
  if (!f) throw new Error('rfc3161: no fetch available (provide fetchFn)');
  return f;
}

export function createRfc3161Provider(opts: Rfc3161ProviderOptions = {}): TimestampProvider {
  const tsaUrl = opts.tsaUrl ?? DEFAULT_TSA_URL;

  return {
    id: 'rfc3161',
    trustModel: 'trusted-third-party',
    async stamp(hash) {
      assertHash32(hash);
      const req = buildTimeStampReq(hash);
      const res = await resolveFetch(opts.fetchFn)(tsaUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/timestamp-query',
          Accept: 'application/timestamp-reply',
        },
        // TS 5.7 `Uint8Array<ArrayBufferLike>` no longer matches `BodyInit` in an
        // overload context; fetch accepts the bytes at runtime.
        body: req as BodyInit,
      });
      if (!res.ok) throw new Error(`TSA ${tsaUrl} returned HTTP ${res.status}`);
      const token = extractToken(new Uint8Array(await res.arrayBuffer()));
      return {
        provider: 'rfc3161',
        version: PROOF_VERSION,
        status: 'complete',
        data: bytesToB64(token),
        meta: { tsaUrl, trustModel: 'trusted-third-party' },
      } satisfies TimestampProof;
    },
    async verify(proof, hash) {
      if (proof.provider !== 'rfc3161') return { ...VERIFY_FAILED };
      let token: Uint8Array;
      try {
        token = b64ToBytes(proof.data);
      } catch {
        return { ...VERIFY_FAILED };
      }
      const r = await verifyToken(token, hash);
      if (!r.ok) return { ...VERIFY_FAILED };
      return { ok: true, timeSec: r.genTimeSec, anchor: `rfc3161:${r.tsaName}` };
    },
  };
}

// Base64 ↔ bytes via atob/btoa (isomorphic — modern Node AND the browser). `verify`
// runs in the /verify SPA (verifyBundleWeb verifies the embedded .tsr offline), where
// Node `Buffer` is undefined; a Buffer here threw inside the verify try/catch and
// surfaced as "no valid timestamp proof" for every signer (Barry QA). tsp.ts (asn1js/
// pkijs/WebCrypto) is already browser-safe, so this base64 decode was the last gap.
function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
