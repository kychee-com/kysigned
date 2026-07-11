/**
 * Bundle verifier engine — F-10.3 (the documented verification algorithm).
 *
 * The canonical, offline-capable implementation shared by the CLI (F-10.2) and the
 * web verifier (F-10.1). Given a bundle PDF it:
 *   1. extracts the embedded files (the five classes),
 *   2. recomputes the F-8.2 fingerprint over the evidence and reports match/mismatch
 *      against the value printed on the signature page (AC-64),
 *   3. for each `signer-<n>.eml`: DKIM-verifies against `keys.json` (full body hash,
 *      no l=, From-aligned), requires the attachment byte-identical to
 *      `document-original.pdf`, requires the verbatim intent line, and validates the
 *      timestamp proof commits to SHA-256(`.eml`),
 *   4. performs the key-authenticity join (F-1.4 / AC-59): the archive's
 *      Bitcoin-timestamped observation window for (domain, selector, key) must
 *      contain the proven signing time T — when an archive resolver is supplied;
 *      offline, the verdict notes "pending online cross-check".
 *
 * kysigned is NOT in the trust set (it appears nowhere here). The verdict is
 * derived from the embedded `.eml`, never the rendered page (AC-28e). DKIM runs
 * against `keys.json` so the whole thing works with the network disabled (AC-27).
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { extractEmbeddedFileMap } from './extract.js';
import { computeBundleFingerprint } from './fingerprint.js';
import type { EmbeddedFile } from './types.js';
import type { KeysJson } from './keysJson.js';
import { verifyDkim, type DkimResolver } from '../api/signing/dkimVerify.js';
import { evaluateDkimPolicy } from '../api/signing/dkimPolicy.js';
import { checkForwardedAttachment, sha256Hex } from '../api/signing/attachmentCheck.js';
import { assembleCanonicalPdf } from '../pdf/assembleCanonicalPdf.js';
import { extractSigningText } from '../api/signing/mimeExtract.js';
import { validateSigningIntent, firstIntentLineVerbatim } from '../api/signing/signingIntent.js';
import { verifyWith, type TimestampProof, type VerifyResult } from '../timestamp/contract.js';
import type { KeyAuthStatus, BitcoinAnchor, SignerVerdict, BundleVerdict, VerifyBundleDeps } from './verifyTypes.js';
import { computeSignerTier, computeBundleTier, classifyTimestampDurability, type AssuranceDimensions } from './assuranceTier.js';
import { orderedEvidence, signerIndices } from './evidenceOrder.js';

// Re-export the shared verdict types (defined in verifyTypes.ts so the browser
// engine can share them without importing this mailauth-bound module).
export type { KeyAuthStatus, BitcoinAnchorStatus, BitcoinAnchor, SignerVerdict, BundleVerdict, VerifyBundleDeps } from './verifyTypes.js';

/** Default timestamp verification: lazily route to the real providers (prod/e2e). */
async function defaultVerifyTimestamp(proof: TimestampProof, hash: Uint8Array): Promise<VerifyResult> {
  const { createOtsProvider } = await import('../timestamp/ots/provider.js');
  const { createRfc3161Provider } = await import('../timestamp/rfc3161/provider.js');
  return verifyWith([createOtsProvider({}), createRfc3161Provider({})], proof, hash);
}

function resolverFromKeys(keys: KeysJson): DkimResolver {
  return async (name, rrtype) => {
    const m = /^([^.]+)\._domainkey\.(.+)$/.exec(name);
    if (String(rrtype).toLowerCase() === 'txt' && m) {
      const rec = keys.keys.find((k) => k.selector === m[1] && k.domain === m[2]);
      if (rec?.record) return [[rec.record]];
    }
    const err = new Error('ENOTFOUND') as Error & { code?: string };
    err.code = 'ENOTFOUND';
    throw err;
  };
}

function parseFromEmail(emlStr: string): string | null {
  const m = /^From:\s*(.*)$/im.exec(emlStr);
  if (!m) return null;
  const addr = /<([^>]+)>/.exec(m[1]);
  return (addr ? addr[1] : m[1]).trim() || null;
}

/** Rebuild the F-8.4 evidence order from extracted files (excludes VERIFY-README). */
/** Every 64-hex token rendered on the PDF pages (the printed fingerprint is one). */
function renderedHexTokens(pdfBytes: Uint8Array): Set<string> {
  const raw = Buffer.from(pdfBytes);
  const tokens = new Set<string>();
  let i = 0;
  while (i < raw.length) {
    const s = raw.indexOf(Buffer.from('stream', 'latin1'), i);
    if (s === -1) break;
    let start = s + 6;
    if (raw[start] === 0x0d) start++;
    if (raw[start] === 0x0a) start++;
    const e = raw.indexOf(Buffer.from('endstream', 'latin1'), start);
    if (e === -1) break;
    try {
      const text = inflateSync(raw.subarray(start, e))
        .toString('latin1')
        .replace(/<([0-9A-Fa-f]+)>/g, (_m, h: string) => {
          let t = '';
          for (let k = 0; k + 1 < h.length; k += 2) t += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
          return t;
        });
      for (const m of text.matchAll(/[0-9a-f]{64}/g)) tokens.add(m[0]);
    } catch {
      /* non-flate stream */
    }
    i = e + 9;
  }
  return tokens;
}

function reconstructProof(path: string, bytes: Uint8Array): TimestampProof {
  return {
    provider: path.endsWith('.ots') ? 'ots' : 'rfc3161',
    version: 1,
    status: 'complete',
    data: Buffer.from(bytes).toString('base64'),
  };
}

export async function verifyBundle(pdfBytes: Uint8Array, deps: VerifyBundleDeps = {}): Promise<BundleVerdict> {
  const verifyTimestamp = deps.verifyTimestamp ?? defaultVerifyTimestamp;
  const errors: string[] = [];
  // F-007-obs: a corrupted / undecompressable embedded stream (Z_DATA_ERROR from
  // inflate, or an unparseable bundle) must surface as a NAMED FAILED verdict via
  // the errors[] channel — never an uncaught throw that crashes the verifier.
  let files: Map<string, Uint8Array>;
  try {
    files = await extractEmbeddedFileMap(pdfBytes);
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
  // A (F-10.9): SHA-256 of the shared original document. Every signer's
  // reconstruction is checked against these exact bytes, so a match proves they
  // signed document A; surfaced explicitly in the verdict (per signer + envelope).
  const originalDocSha256 = docBytes ? sha256Hex(docBytes) : null;
  const keysBytes = files.get('keys.json');
  let keys: KeysJson | null = null;
  if (!keysBytes) {
    errors.push('missing keys.json');
  } else {
    try {
      keys = JSON.parse(Buffer.from(keysBytes).toString()) as KeysJson;
    } catch {
      errors.push('keys.json is not valid JSON');
    }
  }

  // Fingerprint recompute + match against the printed value (AC-64).
  const computed = computeBundleFingerprint(orderedEvidence(files));
  const matchesPrinted = renderedHexTokens(pdfBytes).has(computed);

  const nums = signerIndices(files);
  if (nums.length === 0) errors.push('no signer-<n>.eml evidence found');

  const signers: SignerVerdict[] = [];

  for (const n of nums) {
    const emlBytes = files.get(`signer-${n}.eml`)!;
    const emlStr = Buffer.from(emlBytes).toString('latin1');
    const reasons: string[] = [];

    // DKIM against keys.json (offline-capable).
    let dkimOk = false;
    let signingDomain: string | null = null;
    if (keys) {
      const dkim = evaluateDkimPolicy(await verifyDkim(emlStr, { resolver: resolverFromKeys(keys) }));
      dkimOk = dkim.ok;
      signingDomain = dkim.ok ? dkim.signingDomain : null;
      if (!dkim.ok) reasons.push(`DKIM ${dkim.reason}`);
    } else {
      reasons.push('no keys.json to verify DKIM against');
    }

    // Family B (F-10.3): reconstruct THIS signer's P_i = cover-<n> ++
    // document-original and require the .eml attachment to byte-match it. Every
    // signer reconstructs against the SAME document-original, which also proves
    // they all signed the same document D — a per-signer doc-swap mismatches here.
    let attOk = false;
    const coverBytes = files.get(`cover-${n}.pdf`);
    if (!docBytes) {
      reasons.push('attachment missing (no document-original.pdf)');
    } else if (!coverBytes) {
      reasons.push(`attachment missing (no cover-${n}.pdf)`);
    } else {
      const reconstructed = await assembleCanonicalPdf(coverBytes, docBytes);
      const att = checkForwardedAttachment(emlStr, sha256Hex(reconstructed));
      attOk = att.ok;
      if (!att.ok) reasons.push(`attachment ${att.reason}`);
    }

    // Verbatim intent line (text/plain, or the text/html part for HTML-only forwards).
    const part = extractSigningText(emlStr);
    const intent = validateSigningIntent(part?.content ?? '', part?.cte, part?.isHtml ?? false);
    const verbatimIntent = part ? firstIntentLineVerbatim(part.content, part.cte, part.isHtml) : null;
    if (!intent.valid) reasons.push(`intent ${intent.reason ?? 'invalid'}`);

    // Timestamp: a proof must commit to SHA-256(.eml).
    const emlHash = createHash('sha256').update(emlBytes).digest();
    let tsOk = false;
    let tsrOk = false; // the RFC-3161 (.tsr) proof specifically — the provisional leg (F-32.2)
    let tsrTimeSec: number | null = null;
    let bitcoinTimeSec: number | null = null;
    let signingTimeSec: number | null = null;
    // Bitcoin anchor (F-10.6 / F-32.2): `confirmed` ONLY when the `.ots` proof
    // commits to a REAL Bitcoin block (not merely a calendar/verifying proof) — a
    // block-anchored time is what durable assurance rests on. Otherwise pending.
    let bitcoinAnchor: BitcoinAnchor = { status: files.has(`proofs/signer-${n}.ots`) ? 'pending' : 'absent' };
    for (const ext of ['tsr', 'ots'] as const) {
      const proofBytes = files.get(`proofs/signer-${n}.${ext}`);
      if (!proofBytes) continue;
      try {
        const res = await verifyTimestamp(reconstructProof(`proofs/signer-${n}.${ext}`, proofBytes), emlHash);
        if (res.ok) {
          tsOk = true;
          if (res.timeSec) signingTimeSec = signingTimeSec == null ? res.timeSec : Math.min(signingTimeSec, res.timeSec);
          if (ext === 'tsr') {
            tsrOk = true;
            tsrTimeSec = res.timeSec ?? null;
          }
          if (ext === 'ots') {
            const m = /bitcoin:block:(\d+):/.exec(res.anchor);
            if (m) {
              // A real Bitcoin block → confirmed anchor (durable-eligible).
              bitcoinTimeSec = res.timeSec ?? null;
              bitcoinAnchor = {
                status: 'confirmed',
                ...(res.timeSec ? { timeSec: res.timeSec } : {}),
                blockHeight: Number(m[1]),
              };
            }
            // else: the .ots verifies but is not yet block-anchored → stays pending.
          }
        }
      } catch {
        /* this proof failed to verify */
      }
    }
    if (!tsOk) reasons.push('no valid timestamp proof');

    // Key-archive presence (F-10.7): the OFFLINE engine reports `pending-online`; the
    // ONLINE archive lookup (confirmKeyArchive) upgrades it to `archive-confirmed`.
    // Additive — there is NO failed/red key state, so the key check NEVER gates
    // `proven` (DD-16 presence-not-window, DD-17).
    const keyAuth: KeyAuthStatus = 'pending-online';

    // F-32 assurance dimensions. In this phase (A/B) the OFFLINE engine can settle
    // integrity + timestamp durability; provider-key provenance (F-32.3, Phase C)
    // and the authenticated key-validity window (F-32.4, Phase D) have no embedded
    // artifact yet, so they are honestly pending/inconclusive — capping the tier at
    // INTEGRITY VERIFIED. Live archive presence never grants provenance (DD-33).
    // Durable timestamp assurance (F-32.2) requires BOTH a confirmed Bitcoin anchor
    // AND the RFC-3161 token (each already checked to commit to SHA-256(.eml)).
    const assurance: AssuranceDimensions = {
      keyProvenance: 'pending',
      timestampDurability: classifyTimestampDurability({
        tsrOk,
        bitcoinConfirmed: bitcoinAnchor.status === 'confirmed',
        tsrTimeSec,
        bitcoinTimeSec,
      }),
      keyValidity: 'inconclusive',
    };
    const hard = { dkim: dkimOk, attachment: attOk, intent: intent.valid, timestamp: tsOk };
    const tier = computeSignerTier(hard, assurance);
    const proven = tier !== 'FAILED';
    signers.push({
      index: n,
      proven,
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

  // Bundle-level: a structural failure (extraction error, fingerprint mismatch, no
  // signers) is FAILED; otherwise the bundle tier is the WEAKEST signer's tier.
  const structurallySound = errors.length === 0 && matchesPrinted && signers.length > 0;
  const tier = structurallySound ? computeBundleTier(signers.map((s) => s.tier)) : 'FAILED';
  const proven = tier !== 'FAILED';
  return { proven, tier, fingerprint: { computed, matchesPrinted }, originalDocSha256, signers, errors };
}
