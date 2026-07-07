/**
 * verification-tools/verify-independent.mjs (F-26) — an INDEPENDENT reproduction of
 * the kysigned bundle verifier.
 *
 * It re-orchestrates the documented verification algorithm (F-10.3) itself and does
 * NOT import the canonical engine (`src/bundle/verify.ts` / `verifyWeb.ts` /
 * `verifyCli.ts` / `hashCheck.ts`). So when its verdict matches the web and CLI
 * verifiers on the same bundle (the F-10.10 / AC-107 parity harness), that agreement
 * is a genuine cross-implementation check that the algorithm is completely and
 * correctly specified (DD-21) — not the same code run twice.
 *
 * It uses the SAME third-party-vetted primitives the canonical verifier uses — NO
 * self-rolled crypto:
 *   - `mailauth`                      DKIM signature verification
 *   - RFC-3161 / OpenTimestamps verify (pkijs + @noble + a public Bitcoin source)
 *   - `node:crypto`                   SHA-256
 *   - `pdf-lib` (via the format helpers `extract` + `assembleCanonicalPdf`)
 * The format helpers DEFINE the bundle layout (how files are embedded; how a
 * signer's canonical PDF is assembled) and so MUST be shared, not reinvented — an
 * independent verifier following the spec produces byte-identical results. What this
 * file reproduces independently is the VERDICT ORCHESTRATION: the fingerprint
 * computation, the per-signer reconstruction + hash compares, A, the intent check,
 * and how they combine into PROVEN / FAILED.
 *
 * Run:  node --import tsx scripts/verification-tools/verify-independent.mjs <bundle.pdf>
 * Self-test:  node --import tsx scripts/verification-tools/self-test.mjs
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
// Format primitives (NOT the verifier orchestrator):
import { extractEmbeddedFileMap } from '../../src/bundle/extract.ts';
import { assembleCanonicalPdf } from '../../src/pdf/assembleCanonicalPdf.ts';
import { orderedEvidence, signerIndices } from '../../src/bundle/evidenceOrder.ts';
// Vetted crypto / parsing primitives:
import { verifyDkim } from '../../src/api/signing/dkimVerify.ts';
import { evaluateDkimPolicy } from '../../src/api/signing/dkimPolicy.ts';
import { extractSigningText, extractPdfAttachments } from '../../src/api/signing/mimeExtract.ts';
import { validateSigningIntent, firstIntentLineVerbatim } from '../../src/api/signing/signingIntent.ts';
import { verifyWith } from '../../src/timestamp/contract.ts';
import { createRfc3161Provider } from '../../src/timestamp/rfc3161/provider.ts';

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');

/** DKIM key lookup resolver backed by the bundle's embedded keys.json (offline). */
function resolverFromKeys(keys) {
  return async (name, rrtype) => {
    const m = /^([^.]+)\._domainkey\.(.+)$/.exec(name);
    if (String(rrtype).toLowerCase() === 'txt' && m) {
      const rec = keys.keys.find((k) => k.selector === m[1] && k.domain === m[2]);
      if (rec?.record) return [[rec.record]];
    }
    const err = new Error('ENOTFOUND');
    err.code = 'ENOTFOUND';
    throw err;
  };
}

function parseFromEmail(emlStr) {
  const m = /^From:\s*(.*)$/im.exec(emlStr);
  if (!m) return null;
  const addr = /<([^>]+)>/.exec(m[1]);
  return (addr ? addr[1] : m[1]).trim() || null;
}

/**
 * The F-8.2 fingerprint, recomputed independently: SHA-256 over the embedded
 * evidence concatenated in the documented order (F-8.4). The order helper is shared
 * (it is part of the format spec); the concatenation + hash here are this tool's own.
 */
function computeFingerprint(files) {
  const ev = orderedEvidence(files);
  const h = createHash('sha256');
  for (const f of ev) h.update(f.bytes);
  return h.digest('hex');
}

/** Every 64-hex token rendered on the PDF pages (the printed fingerprint is one). */
function renderedHexTokens(pdfBytes) {
  const raw = Buffer.from(pdfBytes);
  const tokens = new Set();
  let i = 0;
  for (;;) {
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
        .replace(/<([0-9A-Fa-f]+)>/g, (_m, hx) => {
          let t = '';
          for (let k = 0; k + 1 < hx.length; k += 2) t += String.fromCharCode(parseInt(hx.slice(k, k + 2), 16));
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

/** Verify the forwarded PDF attachment hashes to `wantHex` (the reconstruction). */
function attachmentMatches(emlStr, wantHex) {
  let parts;
  try {
    parts = extractPdfAttachments(emlStr);
  } catch {
    return false;
  }
  return parts.some((p) => sha256hex(p.bytes) === wantHex);
}

/**
 * Independently verify a bundle PDF. Returns a verdict whose offline core
 * (proven + per-signer checks + A + fingerprint) is directly comparable to the
 * canonical web/CLI verdict (the AC-107 parity harness). The additive ONLINE
 * indicators (Bitcoin anchor, key-archive presence) are documented in the README as
 * separate steps; they never gate `proven`, so the offline core is the parity unit.
 */
export async function verifyBundleIndependently(pdfBytes) {
  const errors = [];
  // F-007-obs: a corrupted / undecompressable embedded stream (Z_DATA_ERROR from
  // inflate, or an unparseable bundle) must surface as a NAMED FAILED verdict via
  // the errors[] channel — never an uncaught throw that crashes the toolkit.
  let files;
  try {
    files = await extractEmbeddedFileMap(pdfBytes);
  } catch {
    errors.push('bundle file appears damaged: could not decompress embedded data');
    return {
      proven: false,
      fingerprint: { computed: '', matchesPrinted: false },
      originalDocSha256: null,
      signers: [],
      errors,
    };
  }

  const docBytes = files.get('document-original.pdf');
  if (!docBytes) errors.push('missing document-original.pdf');
  // A (F-10.9): SHA-256 of the shared original document.
  const originalDocSha256 = docBytes ? sha256hex(docBytes) : null;

  let keys = null;
  const keysBytes = files.get('keys.json');
  if (!keysBytes) errors.push('missing keys.json');
  else {
    try {
      keys = JSON.parse(Buffer.from(keysBytes).toString());
    } catch {
      errors.push('keys.json is not valid JSON');
    }
  }

  const computed = computeFingerprint(files);
  const matchesPrinted = renderedHexTokens(pdfBytes).has(computed);

  const nums = signerIndices(files);
  if (nums.length === 0) errors.push('no signer-<n>.eml evidence found');

  const rfc3161 = createRfc3161Provider({});
  const signers = [];

  for (const n of nums) {
    const emlBytes = files.get(`signer-${n}.eml`);
    const emlStr = Buffer.from(emlBytes).toString('latin1');
    const reasons = [];

    // 1. DKIM against keys.json (mailauth), offline.
    let dkimOk = false;
    let signingDomain = null;
    if (keys) {
      const dkim = evaluateDkimPolicy(await verifyDkim(emlStr, { resolver: resolverFromKeys(keys) }));
      dkimOk = dkim.ok;
      signingDomain = dkim.ok ? dkim.signingDomain : null;
      if (!dkim.ok) reasons.push(`dkim ${dkim.reason}`);
    } else {
      reasons.push('no keys.json');
    }

    // 2. Reconstruct P_i = cover-<n> ++ document-original and require the attachment
    //    to byte-match it (proves they signed document A).
    let attOk = false;
    const coverBytes = files.get(`cover-${n}.pdf`);
    if (!docBytes) reasons.push('no document-original.pdf');
    else if (!coverBytes) reasons.push(`no cover-${n}.pdf`);
    else {
      const reconstructed = await assembleCanonicalPdf(coverBytes, docBytes);
      attOk = attachmentMatches(emlStr, sha256hex(reconstructed));
      if (!attOk) reasons.push('attachment does not match cover ++ document-original');
    }

    // 3. Verbatim intent line (text/plain, or text/html for HTML-only forwards).
    const part = extractSigningText(emlStr);
    const intent = validateSigningIntent(part?.content ?? '', part?.cte, part?.isHtml ?? false);
    const verbatimIntent = part ? firstIntentLineVerbatim(part.content, part.cte, part.isHtml) : null;
    if (!intent.valid) reasons.push(`intent ${intent.reason ?? 'invalid'}`);

    // 4. Timestamp: the RFC-3161 .tsr must commit to SHA-256(.eml), offline.
    const emlHash = createHash('sha256').update(emlBytes).digest();
    let tsOk = false;
    let signingTimeSec = null;
    const tsr = files.get(`proofs/signer-${n}.tsr`);
    if (tsr) {
      try {
        const res = await verifyWith(
          [rfc3161],
          { provider: 'rfc3161', version: 1, status: 'complete', data: Buffer.from(tsr).toString('base64') },
          emlHash,
        );
        tsOk = res.ok;
        if (res.ok && res.timeSec) signingTimeSec = res.timeSec;
      } catch {
        /* proof failed */
      }
    }
    if (!tsOk) reasons.push('no valid timestamp proof');

    const proven = dkimOk && attOk && intent.valid && tsOk;
    signers.push({
      index: n,
      proven,
      email: parseFromEmail(emlStr),
      signingDomain,
      verbatimIntent,
      signingTimeSec,
      originalDocSha256,
      checks: { dkim: dkimOk, attachment: attOk, intent: intent.valid, timestamp: tsOk },
      reasons,
    });
  }

  const proven = errors.length === 0 && matchesPrinted && signers.length > 0 && signers.every((s) => s.proven);
  return { proven, fingerprint: { computed, matchesPrinted }, originalDocSha256, signers, errors };
}

/** Human-readable report (mirrors the CLI's intent, independently formatted). */
export function formatReport(v) {
  const lines = ['kysigned independent verification', '================================='];
  if (v.errors.length) lines.push('STRUCTURAL ERRORS:', ...v.errors.map((e) => `  - ${e}`), '');
  lines.push(`Verification code: ${v.fingerprint.computed} (${v.fingerprint.matchesPrinted ? 'MATCHES' : 'DOES NOT MATCH'} printed)`);
  lines.push(`Original document (SHA-256): ${v.originalDocSha256 ?? '(none)'}`, '');
  for (const s of v.signers) {
    lines.push(`Signer ${s.index} (${s.email ?? '?'}): ${s.proven ? 'PROVEN' : 'FAILED'}`);
    lines.push(`  checks: dkim=${s.checks.dkim} attachment=${s.checks.attachment} intent=${s.checks.intent} timestamp=${s.checks.timestamp}`);
    lines.push(`  Original document (SHA-256): ${s.originalDocSha256 ?? '(none)'}`);
    if (!s.proven) lines.push(...s.reasons.map((r) => `    - ${r}`));
  }
  lines.push('', `OVERALL: ${v.proven ? 'PROVEN' : 'FAILED'}`);
  return lines.join('\n');
}

// CLI entry: verify a bundle file, print the report, exit 0 (PROVEN) / 1 (FAILED).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify-independent.mjs')) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node --import tsx scripts/verification-tools/verify-independent.mjs <bundle.pdf>');
    process.exit(2);
  }
  const { readFileSync } = await import('node:fs');
  const v = await verifyBundleIndependently(new Uint8Array(readFileSync(path)));
  console.log(formatReport(v));
  process.exit(v.proven ? 0 : 1);
}
