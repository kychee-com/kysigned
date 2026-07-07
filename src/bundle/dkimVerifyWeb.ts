/**
 * Browser-compatible DKIM verifier (F-10.1) — WebCrypto only, no Node deps.
 *
 * The web verifier (AC-27) must verify DKIM fully client-side, but `mailauth`
 * cannot bundle for the browser (it transitively needs node:dns/net). This module
 * does the verification using ONLY web-standard APIs — `crypto.subtle` (the
 * browser's vendor-audited RSASSA-PKCS1-v1_5 / SHA-256), `atob`, `Uint8Array`,
 * `TextEncoder` — so it runs unchanged in the browser AND in Node (Node ≥18 has
 * `globalThis.crypto`).
 *
 * The actual signature math is NOT self-rolled — it is the platform's WebCrypto.
 * What this file implements is the RFC 6376 canonicalization (deterministic text
 * normalization, like base64/MIME parsing) plus the tag plumbing. To guarantee it
 * is equivalent to the mainstream verifier, `dkimVerifyWeb.test.ts` is a
 * DIFFERENTIAL test: it must return the same verdict as `mailauth` for a valid
 * message and for every tamper. A divergence fails the build.
 *
 * Scope: rsa-sha256 (the dominant provider algorithm — Gmail/Outlook/Yahoo),
 * relaxed + simple canonicalization, single-instance signed headers. l= (partial
 * body) is rejected per F-6.2(c).
 */
import { evaluateDkimPolicy, type DkimSignatureDescriptor } from '../api/signing/dkimPolicy.js';

export interface DkimWebResult {
  ok: boolean;
  /** d= of the verified signature (lowercased), or null. */
  signingDomain: string | null;
  /** Failure reason mirroring the policy reasons used by the Node path. */
  reason?:
    | 'no_signature'
    | 'body_length_tag'
    | 'misaligned'
    | 'weak_algorithm'
    | 'missing_key'
    | 'invalid_signature';
}

/** Returns the DKIM TXT record (`v=DKIM1; … p=…`) for a (domain, selector), or null. */
export type WebKeyLookup = (domain: string, selector: string) => string | null | Promise<string | null>;

// ── byte helpers (latin1 in/out — DKIM operates on bytes, the .eml is latin1) ──
function latin1ToBytes(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}

function b64ToBytes(b64: string): Uint8Array {
  // Lenient (drop non-alphabet chars + re-pad) so a corrupted b=/p= value decodes
  // to wrong bytes (→ signature fails) rather than throwing in strict atob.
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

// ── header parsing (preserves raw form for simple canonicalization + folding) ──
interface RawHeader {
  name: string;
  /** Raw value as it appeared (without the final CRLF), including folded lines. */
  value: string;
}

function splitMessage(raw: string): { headers: RawHeader[]; body: string } {
  const sep = raw.search(/\r?\n\r?\n/);
  const headerBlock = sep === -1 ? raw : raw.slice(0, sep);
  const body = sep === -1 ? '' : raw.slice(sep).replace(/^\r?\n\r?\n/, '');
  // Unfold field boundaries: a new field starts on a line NOT beginning with WSP.
  const lines = headerBlock.split(/\r?\n/);
  const headers: RawHeader[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1].value += '\r\n' + line; // continuation (folded)
    } else {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      headers.push({ name: line.slice(0, idx), value: line.slice(idx + 1) });
    }
  }
  return { headers, body };
}

function parseTags(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// ── RFC 6376 canonicalization ─────────────────────────────────────────────────
function canonBodyRelaxed(body: string): string {
  let lines = body.split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, ' ').replace(/ +$/, ''));
  let out = lines.join('\r\n').replace(/(\r\n)+$/, '');
  if (out.length > 0) out += '\r\n';
  return out;
}

function canonBodySimple(body: string): string {
  let b = body.replace(/\r?\n/g, '\r\n').replace(/(\r\n)+$/, '');
  return b + '\r\n'; // simple: at least one CRLF; trailing empty lines collapsed to one
}

function canonHeaderRelaxed(h: RawHeader): string {
  const name = h.name.toLowerCase().trim();
  let v = h.value.replace(/\r\n([ \t])/g, '$1'); // unfold
  v = v.replace(/[ \t]+/g, ' ').trim(); // collapse WSP, trim
  return `${name}:${v}`;
}

function canonHeaderSimple(h: RawHeader): string {
  return `${h.name}:${h.value}`; // verbatim
}

/** The DKIM-Signature header with its b= value emptied (for the signature input). */
function stripB(value: string): string {
  return value.replace(/(\bb=)[^;]*/s, '$1');
}

function fromDomain(headers: RawHeader[]): string | null {
  const from = headers.find((h) => h.name.toLowerCase() === 'from');
  if (!from) return null;
  const m = /<([^>]+)>/.exec(from.value) ?? /([^\s<>]+@[^\s<>]+)/.exec(from.value);
  const addr = m ? m[1] : from.value.trim();
  const at = addr.lastIndexOf('@');
  return at === -1 ? null : addr.slice(at + 1).toLowerCase().trim();
}

/** Verify ONE DKIM-Signature header to a {@link DkimSignatureDescriptor.result}.
 *  'pass' = body hash + signature verify; 'fail' = a definite crypto failure
 *  (body tampered / forged sig); 'neutral' = unverifiable here (no usable key, or
 *  a non-rsa-sha256 algorithm) → the policy treats it as keyless. */
async function verifyOneSignature(
  headers: RawHeader[],
  body: string,
  sigHeader: RawHeader,
  tags: Record<string, string>,
  lookupKey: WebKeyLookup,
): Promise<DkimSignatureDescriptor['result']> {
  // This engine verifies rsa-sha256 only (the dominant algorithm). Others stay
  // 'neutral' so a mixed message still passes on its rsa-sha256 signature.
  if ((tags.a ?? '').toLowerCase() !== 'rsa-sha256') return 'neutral';

  const [hc, bc] = (tags.c ?? 'simple/simple').toLowerCase().split('/');
  const bodyCanon = (bc === 'relaxed' ? canonBodyRelaxed : canonBodySimple)(body);
  const computedBh = bytesToB64(await sha256(latin1ToBytes(bodyCanon)));
  if (computedBh !== (tags.bh ?? '').replace(/\s+/g, '')) return 'fail'; // body mismatch/tamper

  // Build the signed header string: each header in h= (single instance), then the
  // DKIM-Signature header with b= emptied, NO trailing CRLF on the last one.
  const headerCanon = hc === 'relaxed' ? canonHeaderRelaxed : canonHeaderSimple;
  const wanted = (tags.h ?? '').split(':').map((n) => n.trim().toLowerCase()).filter(Boolean);
  const used = new Set<RawHeader>();
  const parts: string[] = [];
  for (const name of wanted) {
    const h = [...headers].reverse().find((x) => x.name.toLowerCase() === name && !used.has(x));
    if (!h) continue; // a header listed but absent is skipped (signs "non-existence")
    used.add(h);
    parts.push(headerCanon(h) + '\r\n');
  }
  parts.push(headerCanon({ name: sigHeader.name, value: stripB(sigHeader.value) })); // no trailing CRLF
  const signedData = latin1ToBytes(parts.join(''));

  const record = await lookupKey((tags.d ?? '').toLowerCase(), tags.s ?? '');
  const p = record ? parseTags(record).p : null;
  if (!p) return 'neutral'; // no usable key for THIS signature (keyless → missing_key)

  try {
    const key = await crypto.subtle.importKey(
      'spki',
      b64ToBytes(p) as BufferSource,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64ToBytes(tags.b ?? '') as BufferSource,
      signedData as BufferSource,
    );
    return valid ? 'pass' : 'fail';
  } catch {
    return 'fail';
  }
}

export async function verifyDkimWeb(rawEml: string, lookupKey: WebKeyLookup): Promise<DkimWebResult> {
  const { headers, body } = splitMessage(rawEml);
  const sigHeaders = headers.filter((h) => h.name.toLowerCase() === 'dkim-signature');
  if (sigHeaders.length === 0) return { ok: false, signingDomain: null, reason: 'no_signature' };

  // Evaluate EVERY DKIM-Signature, not just one. Real provider mail (anything via
  // Amazon SES, etc.) carries the sending-domain signature AND the provider's own
  // d=amazonses.com signature (whose key is not in keys.json). Each becomes a
  // descriptor and the SHARED evaluateDkimPolicy makes the same From-aligned-
  // passing decision as the Node path — so the two engines cannot diverge on
  // multi-signature mail (the failure that single-signature handling caused).
  const fromDom = fromDomain(headers);
  const descriptors: DkimSignatureDescriptor[] = [];
  let anyBodyLengthTag = false;

  for (const sigHeader of sigHeaders) {
    const tags = parseTags(sigHeader.value.replace(/\r\n[ \t]/g, ''));
    if (tags.l != null) anyBodyLengthTag = true;
    const d = (tags.d ?? '').toLowerCase();
    descriptors.push({
      signingDomain: d,
      selector: tags.s ?? '',
      result: await verifyOneSignature(headers, body, sigHeader, tags, lookupKey),
      alignedDomain: d || null, // evaluateDkimPolicy decides alignment vs From
      algorithm: (tags.a ?? '').toLowerCase(),
    });
  }

  const policy = evaluateDkimPolicy({ fromDomain: fromDom ?? '', signatures: descriptors, anyBodyLengthTag });
  return policy.ok
    ? { ok: true, signingDomain: policy.signingDomain }
    : { ok: false, signingDomain: null, reason: policy.reason };
}
