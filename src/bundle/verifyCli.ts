/**
 * Reference CLI verifier (F-10.2 / F-10.4 / AC-29) — human-first verdict rendering
 * + exit codes over the shared `verifyBundle` engine. `exit 0` + PROVEN for a valid
 * bundle, nonzero + named reasons for any tamper. Verdict language leads with the
 * plain-English claim; technical detail follows.
 */
import { verifyBundle, type BundleVerdict, type SignerVerdict, type VerifyBundleDeps } from './verify.js';
import { confirmKeyArchiveWeb, type ConfirmKeyArchiveDeps } from './confirmKeyArchive.js';
import { confirmBitcoinAnchorsWeb, type ConfirmBitcoinDeps } from './confirmBitcoin.js';

function fmtTime(sec: number | null): string {
  if (!sec) return 'time pending online confirmation';
  // Deterministic UTC, no locale.
  const d = new Date(sec * 1000);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

// The key-archive registration time (ISO-8601 → UTC date+minute), for the confirmed line.
function fmtIso(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** A distinct line for the DKIM key-archive presence (F-10.7) — additive, no failed state. */
function keyArchiveNote(s: SignerVerdict): string {
  if (s.checks.keyAuthenticity === 'archive-confirmed') {
    const when = fmtIso(s.keyObservedAt);
    return `\n  Key archive: confirmed${when ? ` (registered ${when})` : ''}`;
  }
  return '\n  Key archive: pending (run online to confirm)';
}

/** A distinct line for the OpenTimestamps Bitcoin anchor (F-10.6) — additive. */
function bitcoinNote(s: SignerVerdict): string {
  const a = s.bitcoinAnchor;
  if (a.status === 'confirmed') {
    const where = a.blockHeight ? ` (block ${a.blockHeight}${a.timeSec ? `, ${fmtTime(a.timeSec)}` : ''})` : '';
    return `\n  Bitcoin timestamp: confirmed${where}`;
  }
  if (a.status === 'pending') return '\n  Bitcoin timestamp: pending (run online to confirm)';
  return ''; // absent → no line
}

/** The original document `A` this signer signed (F-10.9) — the shared document-original. */
function originalDocNote(s: SignerVerdict): string {
  return s.originalDocSha256 ? `\n  Original document (SHA-256): ${s.originalDocSha256}` : '';
}

function formatSigner(s: SignerVerdict): string {
  const head = `Signer ${s.index}: ${s.proven ? 'PROVEN' : 'FAILED'}`;
  if (s.proven) {
    return (
      `${head}\n` +
      `  A sender authenticated by ${s.signingDomain} as ${s.email} sent\n` +
      `  "${s.verbatimIntent}" with exactly this document attached, at ${fmtTime(s.signingTimeSec)}.` +
      originalDocNote(s) +
      keyArchiveNote(s) +
      bitcoinNote(s)
    );
  }
  const reasons = s.reasons.length ? s.reasons.map((r) => `    - ${r}`).join('\n') : '    - (unspecified)';
  return `${head}\n  Failing checks:\n${reasons}${originalDocNote(s)}${keyArchiveNote(s)}${bitcoinNote(s)}`;
}

/** Human-first verdict report (F-10.4). */
export function formatVerdict(v: BundleVerdict): string {
  const lines: string[] = [];
  lines.push('kysigned: signing record verification');
  lines.push('========================================');
  if (v.errors.length) {
    lines.push('STRUCTURAL ERRORS:');
    for (const e of v.errors) lines.push(`  - ${e}`);
    lines.push('');
  }
  lines.push(`Verification code: ${v.fingerprint.computed}`);
  lines.push(
    `  ${v.fingerprint.matchesPrinted ? 'MATCHES' : 'DOES NOT MATCH'} the value printed on the signature page` +
      (v.fingerprint.matchesPrinted ? '.' : '. The signing record was altered after assembly.'),
  );
  lines.push('');
  lines.push(`Original document (SHA-256): ${v.originalDocSha256 ?? '(none embedded)'}`);
  lines.push('  Every signer signed this exact document — each .eml reconstruction is checked against it.');
  lines.push('');
  for (const s of v.signers) lines.push(formatSigner(s), '');
  lines.push(`OVERALL: ${v.proven ? 'PROVEN' : 'FAILED'}`);
  if (!v.proven) {
    lines.push('(kysigned is not part of the trust set — this verdict comes only from the embedded evidence.)');
  }
  return lines.join('\n');
}

/** Map a verdict to a process exit code: 0 = PROVEN, 1 = FAILED. */
export function exitCodeFor(v: BundleVerdict): number {
  return v.proven ? 0 : 1;
}

/** Verify a bundle and return the report + exit code (the CLI's pure core). */
export async function runVerifyCli(
  pdfBytes: Uint8Array,
  opts: VerifyBundleDeps & {
    offline?: boolean;
    archiveDeps?: ConfirmKeyArchiveDeps;
    bitcoinDeps?: ConfirmBitcoinDeps;
  } = {},
): Promise<{ exitCode: number; report: string; verdict: BundleVerdict }> {
  const { offline, archiveDeps, bitcoinDeps, ...deps } = opts;
  // The engine verifies the RFC-3161 `.tsr` (offline-capable). The Bitcoin anchor and
  // the key-archive presence are the SEPARATE online step below — IDENTICAL to the web
  // verifier's auto-run (`confirmBitcoinAnchorsWeb` + `confirmKeyArchiveWeb`), so /verify
  // and the CLI always agree (web ≡ CLI). `--offline` skips that step, leaving both
  // anchors `pending` like the offline-first web verifier.
  if (!deps.verifyTimestamp) {
    const { createRfc3161Provider } = await import('../timestamp/rfc3161/provider.js');
    const { verifyWith } = await import('../timestamp/contract.js');
    deps.verifyTimestamp = (proof, hash) => verifyWith([createRfc3161Provider({})], proof, hash);
  }
  const verdict = await verifyBundle(pdfBytes, deps);
  if (!offline) {
    // Real defaults (DD-17): the OTS calendar/Bitcoin source AND the archive lookup run
    // for real unless a test injects a fake. Both additive — neither gates the verdict.
    const [anchors, keys] = await Promise.all([
      confirmBitcoinAnchorsWeb(pdfBytes, bitcoinDeps ?? {}),
      confirmKeyArchiveWeb(pdfBytes, archiveDeps ?? {}),
    ]);
    for (const s of verdict.signers) {
      if (anchors[s.index]) s.bitcoinAnchor = anchors[s.index];
      const k = keys[s.index];
      if (k) {
        s.checks.keyAuthenticity = k.keyAuthenticity;
        s.keyObservedAt = k.observedAt;
      }
    }
  }
  return { exitCode: exitCodeFor(verdict), report: formatVerdict(verdict), verdict };
}
