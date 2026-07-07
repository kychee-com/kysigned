/**
 * Observed DKIM key resolution — F-6.7.
 *
 * At signing time, while the signer's provider DKIM key is still live in DNS, the
 * operator records what it observed (domain, selector, key bytes, observation time)
 * so the bundle carries an independent, timestamped record of the live key. This
 * resolves the key via a DNS TXT lookup of `<selector>._domainkey.<domain>`.
 * Injectable so tests run offline; the default never throws (a lookup failure → null,
 * so a transient DNS hiccup never blocks recording the signature).
 */
import { createHash } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';

export interface ObservedDkimKey {
  /** The DKIM TXT value, e.g. "v=DKIM1; k=rsa; p=...". */
  value: string;
  /** When we read it from DNS. */
  observedAt: Date;
}

export type ResolveDkimKey = (
  domain: string,
  selector: string,
) => Promise<ObservedDkimKey | null>;

/** Default resolver: a live DNS TXT lookup of `<selector>._domainkey.<domain>`. */
export function resolveDkimKeyViaDns(now: () => Date = () => new Date()): ResolveDkimKey {
  return async (domain, selector) => {
    try {
      const records = await resolveTxt(`${selector}._domainkey.${domain}`);
      // Each TXT record may be split into chunks; join, then pick the DKIM one.
      const joined = records.map((chunks) => chunks.join(''));
      const dkim = joined.find((v) => /(?:^|;)\s*(?:v=DKIM1|k=|p=)/i.test(v)) ?? joined[0];
      return dkim ? { value: dkim, observedAt: now() } : null;
    } catch {
      return null;
    }
  };
}

/**
 * 32-byte digest of an observed-key record (domain, selector, key value) — the input
 * to the key-observation timestamp (F-6.7). Stable canonical form so a verifier can
 * recompute it from the bundle's observed-key entry.
 */
export function keyRecordDigest(domain: string, selector: string, value: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`${domain}\n${selector}\n${value}`).digest());
}
