/**
 * Bundle verifier engine (browser) — F-10.1 / F-10.3, the fully client-side path.
 *
 * Mirrors the Node engine (`verify.ts`) EXACTLY in logic and verdict shape, but
 * uses ONLY web-standard APIs so it runs in the browser with the network disabled
 * (AC-27): `crypto.subtle` for SHA-256, the WebCrypto DKIM verifier
 * (`verifyDkimWeb`, differential-tested equivalent to mailauth), `DecompressionStream`
 * for FlateDecode, and the isomorphic MIME extractor. `verifyWeb.test.ts` asserts
 * this engine returns the IDENTICAL verdict to `verify.ts` on a real bundle and on
 * every tamper — so the browser path is provably equivalent to the vetted one.
 *
 * kysigned is absent from the trust set; the verdict is derived from the embedded
 * `.eml`, never the rendered page.
 */
import { extractEmbeddedFileMapWeb } from './extractWeb.js';
import { orderedEvidence, signerIndices } from './evidenceOrder.js';
import type { BundleVerdict, KeyAuthStatus, BitcoinAnchor, SignerVerdict, VerifyBundleDeps } from './verifyTypes.js';
import { computeSignerTier, computeBundleTier, TIER_LABEL, type AssuranceDimensions } from './assuranceTier.js';
import type { KeysJson } from './keysJson.js';
import { verifyDkimWeb } from './dkimVerifyWeb.js';
import { extractSigningText, extractPdfAttachments } from '../api/signing/mimeExtract.js';
import { assembleCanonicalPdf } from '../pdf/assembleCanonicalPdf.js';
import { validateSigningIntent, firstIntentLineVerbatim } from '../api/signing/signingIntent.js';
import type { TimestampProof, VerifyResult } from '../timestamp/contract.js';

// Re-export the verdict types so the SPA imports everything from this one
// browser-safe entry point (never reaching the mailauth-bound verify.ts).
export type { BundleVerdict, SignerVerdict, KeyAuthStatus, BitcoinAnchorStatus, BitcoinAnchor, VerifyBundleDeps } from './verifyTypes.js';
export { TIER_LABEL } from './assuranceTier.js';
export type { AssuranceTier, AssuranceDimensions, DimensionState } from './assuranceTier.js';

// The explicit "Confirm on Bitcoin" action (F-10.6) — offline-first: called only
// when the user clicks confirm, so the default page load stays fully offline.
export { confirmBitcoinAnchorsWeb, confirmOtsAnchor } from './confirmBitcoin.js';
export type { ConfirmBitcoinDeps } from './confirmBitcoin.js';
// Online key-archive presence (F-10.7) — auto-run on load like the Bitcoin confirm.
export { confirmKeyArchive, confirmKeyArchiveWeb } from './confirmKeyArchive.js';
export type { ConfirmKeyArchiveDeps, KeyArchiveConfirmation } from './confirmKeyArchive.js';
// Original-document hash-check (F-25) — the /hashcheck tool reuses this engine + the
// web embedded-file extractor, both browser-safe (pdf-lib + @noble + DecompressionStream).
export { checkOriginalInArtifact, normalizeDocPages } from './hashCheck.js';
export type { HashCheckResult, HashCheckKind, HashCheckGuarantee, ExtractMap } from './hashCheck.js';
export { extractEmbeddedFileMapWeb } from './extractWeb.js';

/**
 * Default browser timestamp verification: verify the embedded RFC 3161 `.tsr`
 * offline (pkijs/WebCrypto, fully browser-safe — `tsp.ts` is isomorphic). The
 * OpenTimestamps Bitcoin anchor needs the network; offline, the TSA token alone
 * establishes the timestamp commitment, which is enough to catch a tampered proof.
 */
async function defaultVerifyTimestampWeb(proof: TimestampProof, hash: Uint8Array): Promise<VerifyResult> {
  const { createRfc3161Provider } = await import('../timestamp/rfc3161/provider.js');
  const { verifyWith } = await import('../timestamp/contract.js');
  return verifyWith([createRfc3161Provider({})], proof, hash);
}

function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return s;
}
function bytesToB64(bytes: Uint8Array): string {
  return btoa(bytesToLatin1(bytes));
}
function toHex(bytes: Uint8Array): string {
  let h = '';
  for (const b of bytes) h += b.toString(16).padStart(2, '0');
  return h;
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  // Blob → DecompressionStream → Response: all errors (incl. a non-flate stream)
  // surface through the single awaited promise, so the caller's try/catch sees them.
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseFromEmail(emlStr: string): string | null {
  const m = /^From:\s*(.*)$/im.exec(emlStr);
  if (!m) return null;
  const addr = /<([^>]+)>/.exec(m[1]);
  return (addr ? addr[1] : m[1]).trim() || null;
}

function reconstructProof(path: string, bytes: Uint8Array): TimestampProof {
  return { provider: path.endsWith('.ots') ? 'ots' : 'rfc3161', version: 1, status: 'complete', data: bytesToB64(bytes) };
}

async function fingerprintWeb(files: Map<string, Uint8Array>): Promise<string> {
  const ev = orderedEvidence(files);
  let total = 0;
  for (const f of ev) total += f.bytes.length;
  const all = new Uint8Array(total);
  let o = 0;
  for (const f of ev) { all.set(f.bytes, o); o += f.bytes.length; }
  return toHex(await sha256(all));
}

/** Every 64-hex token rendered on the PDF pages (the printed fingerprint is one). */
async function renderedHexTokensWeb(pdfBytes: Uint8Array): Promise<Set<string>> {
  const text = bytesToLatin1(pdfBytes);
  const tokens = new Set<string>();
  let i = 0;
  for (;;) {
    const s = text.indexOf('stream', i);
    if (s === -1) break;
    let start = s + 6;
    if (text.charCodeAt(start) === 0x0d) start++;
    if (text.charCodeAt(start) === 0x0a) start++;
    const e = text.indexOf('endstream', start);
    if (e === -1) break;
    let end = e;
    if (text.charCodeAt(end - 1) === 0x0a) end--;
    if (text.charCodeAt(end - 1) === 0x0d) end--;
    try {
      const inflated = await inflate(pdfBytes.subarray(start, end));
      const decoded = bytesToLatin1(inflated).replace(/<([0-9A-Fa-f]+)>/g, (_m, h: string) => {
        let t = '';
        for (let k = 0; k + 1 < h.length; k += 2) t += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
        return t;
      });
      for (const m of decoded.matchAll(/[0-9a-f]{64}/g)) tokens.add(m[0]);
    } catch {
      /* non-flate stream */
    }
    i = e + 9;
  }
  return tokens;
}

async function attachmentOk(emlStr: string, docHashHex: string): Promise<{ ok: boolean; reason?: 'missing' | 'modified' }> {
  // A corrupted forward can yield malformed base64; the browser decoder (atob) is
  // strict and throws where Node's Buffer is lenient. Treat a decode failure as a
  // MODIFIED attachment so the web verdict matches the Node engine (differential).
  let parts: ReturnType<typeof extractPdfAttachments>;
  try {
    parts = extractPdfAttachments(emlStr);
  } catch {
    return { ok: false, reason: 'modified' };
  }
  if (parts.length === 0) return { ok: false, reason: 'missing' };
  for (const p of parts) {
    if (toHex(await sha256(p.bytes)) === docHashHex) return { ok: true };
  }
  return { ok: false, reason: 'modified' };
}

export async function verifyBundleWeb(pdfBytes: Uint8Array, deps: VerifyBundleDeps = {}): Promise<BundleVerdict> {
  const verifyTimestamp = deps.verifyTimestamp ?? defaultVerifyTimestampWeb;
  const errors: string[] = [];
  // F-007-obs: a corrupted / undecompressable embedded stream (a DecompressionStream
  // error, or an unparseable bundle) must surface as a NAMED FAILED verdict via the
  // errors[] channel — never an uncaught throw that crashes the browser verifier.
  let files: Map<string, Uint8Array>;
  try {
    files = await extractEmbeddedFileMapWeb(pdfBytes);
  } catch {
    errors.push('bundle file appears damaged: could not decompress embedded data');
    return {
      proven: false,
      tier: 'FAILED',
      fingerprint: { computed: '', matchesPrinted: false },
      originalDocSha256: null,
      signers: [],
      errors,
    };
  }

  const docBytes = files.get('document-original.pdf');
  if (!docBytes) errors.push('missing document-original.pdf');
  // A (F-10.9): SHA-256 of the shared original document, surfaced explicitly in the
  // verdict (per signer + envelope) — the exact bytes every signer's reconstruction
  // is checked against. Same value the Node engine emits (differential parity).
  const originalDocSha256 = docBytes ? toHex(await sha256(docBytes)) : null;
  const keysBytes = files.get('keys.json');
  let keys: KeysJson | null = null;
  if (!keysBytes) {
    errors.push('missing keys.json');
  } else {
    try {
      keys = JSON.parse(bytesToLatin1(keysBytes)) as KeysJson;
    } catch {
      errors.push('keys.json is not valid JSON');
    }
  }

  const computed = await fingerprintWeb(files);
  const matchesPrinted = (await renderedHexTokensWeb(pdfBytes)).has(computed);

  const nums = signerIndices(files);
  if (nums.length === 0) errors.push('no signer-<n>.eml evidence found');

  const signers: SignerVerdict[] = [];

  for (const n of nums) {
    const emlBytes = files.get(`signer-${n}.eml`)!;
    const emlStr = bytesToLatin1(emlBytes);
    const reasons: string[] = [];

    let dkimOk = false;
    let signingDomain: string | null = null;
    if (keys) {
      const lookup = (domain: string, selector: string) =>
        keys!.keys.find((k) => k.domain === domain && k.selector === selector)?.record ?? null;
      const r = await verifyDkimWeb(emlStr, lookup);
      dkimOk = r.ok;
      signingDomain = r.ok ? r.signingDomain : null;
      if (!r.ok) reasons.push(`DKIM ${r.reason}`);
    } else {
      reasons.push('no keys.json to verify DKIM against');
    }

    // Family B (F-10.3): reconstruct P_i = cover-<n> ++ document-original and
    // require the .eml attachment to byte-match it (same shared document-original
    // for every signer ⇒ they all signed the same document D).
    let attOk = false;
    const coverBytes = files.get(`cover-${n}.pdf`);
    if (!docBytes) {
      reasons.push('attachment missing (no document-original.pdf)');
    } else if (!coverBytes) {
      reasons.push(`attachment missing (no cover-${n}.pdf)`);
    } else {
      const reconstructed = await assembleCanonicalPdf(coverBytes, docBytes);
      const att = await attachmentOk(emlStr, toHex(await sha256(reconstructed)));
      attOk = att.ok;
      if (!att.ok) reasons.push(`attachment ${att.reason}`);
    }

    // text/plain, or the text/html part for HTML-only (iPhone) forwards.
    const part = extractSigningText(emlStr);
    const intent = validateSigningIntent(part?.content ?? '', part?.cte, part?.isHtml ?? false);
    const verbatimIntent = part ? firstIntentLineVerbatim(part.content, part.cte, part.isHtml) : null;
    if (!intent.valid) reasons.push(`intent ${intent.reason ?? 'invalid'}`);

    const emlHash = await sha256(emlBytes);
    let tsOk = false;
    let tsrOk = false; // RFC-3161 specifically — needed for durable timestamp assurance (F-32.2)
    let signingTimeSec: number | null = null;
    // Bitcoin anchor (F-10.6): OFFLINE-FIRST — the web verifier reports `pending`
    // (no network on load); the explicit "Confirm on Bitcoin" action (26.3)
    // upgrades a signer to `confirmed`. `proven` never depends on it (additive).
    const bitcoinAnchor: BitcoinAnchor = { status: files.has(`proofs/signer-${n}.ots`) ? 'pending' : 'absent' };
    for (const ext of ['tsr', 'ots'] as const) {
      const pb = files.get(`proofs/signer-${n}.${ext}`);
      if (!pb) continue;
      try {
        const res = await verifyTimestamp(reconstructProof(`proofs/signer-${n}.${ext}`, pb), emlHash);
        if (res.ok) {
          tsOk = true;
          if (ext === 'tsr') tsrOk = true;
          if (res.timeSec) signingTimeSec = signingTimeSec == null ? res.timeSec : Math.min(signingTimeSec, res.timeSec);
        }
      } catch {
        /* this proof failed to verify */
      }
    }
    if (!tsOk) reasons.push('no valid timestamp proof');

    // Key-archive presence (F-10.7): OFFLINE-first → `pending-online`; the ONLINE
    // archive lookup (confirmKeyArchive) upgrades it to `archive-confirmed`. Additive,
    // no failed/red state, never gates `proven` (DD-16 presence-not-window, DD-17).
    const keyAuth: KeyAuthStatus = 'pending-online';

    // F-32 assurance dimensions (mirrors verify.ts). Offline-first: key provenance
    // (F-32.3, gated online by the archive in Phase C) and the key-validity window
    // (F-32.4, Phase D) are pending/inconclusive here; timestamp durability needs a
    // confirmed Bitcoin anchor, which the web verifier only settles online — so it is
    // `pending` on load and upgrades with the "Confirm on Bitcoin" step. Tier therefore
    // caps at INTEGRITY VERIFIED offline, honestly (DD-33/DD-34).
    const assurance: AssuranceDimensions = {
      keyProvenance: 'pending',
      timestampDurability: bitcoinAnchor.status === 'confirmed' && tsrOk ? 'confirmed' : 'pending',
      keyValidity: 'inconclusive',
    };
    const tier = computeSignerTier({ dkim: dkimOk, attachment: attOk, intent: intent.valid, timestamp: tsOk }, assurance);
    signers.push({
      index: n,
      proven: tier !== 'FAILED',
      tier,
      assurance,
      email: parseFromEmail(emlStr),
      signingDomain,
      verbatimIntent,
      signingTimeSec,
      originalDocSha256,
      checks: { dkim: dkimOk, attachment: attOk, intent: intent.valid, timestamp: tsOk, keyAuthenticity: keyAuth },
      bitcoinAnchor,
      reasons,
    });
  }

  const structurallySound = errors.length === 0 && matchesPrinted && signers.length > 0;
  const tier = structurallySound ? computeBundleTier(signers.map((s) => s.tier)) : 'FAILED';
  return { proven: tier !== 'FAILED', tier, fingerprint: { computed, matchesPrinted }, originalDocSha256, signers, errors };
}
