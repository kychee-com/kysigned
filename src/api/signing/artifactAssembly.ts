/**
 * Signature-artifact assembly — F-6.5/6.6 (the timestamp half of Phase 7 wiring).
 *
 * Called by the forward reconciler on a `signed` outcome, once the signature is
 * already recorded (markSignerSignedByEmail). Computes `sha256(raw .eml)`, obtains
 * the dual timestamps over it from the injected providers, and persists the durable
 * `signature_artifacts` row (idempotent). The observed-key log + archive (F-6.7)
 * are layered on in a follow-up step.
 *
 * **Fail-proof (F-6.9):** the signature is already durable, so a timestamp outage
 * must NEVER lose it — a stamp error degrades to a null proof and `ts_status`
 * stays `pending`, and the OTS-upgrade reconciler stamps/upgrades it later.
 */
import { createHash } from 'node:crypto';
import type { DbPool } from '../../db/pool.js';
import { upsertSignatureArtifact } from '../../db/signatureArtifacts.js';
import type { SignatureArtifact } from '../../db/types.js';
import type { TimestampProof, TimestampProvider } from '../../timestamp/contract.js';
import type { ReceiptVerdicts } from './senderAuthGate.js';
import {
  confirmKeyAtSigning,
  extractPublicKey,
  fetchArchiveStatements,
  type DkimArchiveDeps,
  type SigningKeyConfirmation,
} from './dkimArchive.js';
import { keyRecordDigest, type ResolveDkimKey } from './dkimKeyResolver.js';
import { verifyArchiveStatement, type ArchiveJwks } from '../../bundle/archiveStatement.js';
import { ARCHIVE_STATEMENT_JWKS } from '../../bundle/archiveStatementJwks.js';

/**
 * Per-call deadlines (ms) for the fail-proof external tail. F-6.9 degrades a
 * provider ERROR to a null proof — but a provider that HANGS (stuck socket, no
 * response) used to hold the whole reply_received durable run past run402's
 * worker lease (2026-07-05 incident: FUNCTION_RUN_LEASE_EXPIRED ×5 attempts →
 * completion_distribute never enqueued → auto-close envelopes stuck `active`).
 * Every external call is therefore raced against a deadline; a timeout degrades
 * EXACTLY like an error (null proof / null key / archive outage) and the
 * OTS-upgrade reconciler catches the artifact up later. Worst-case tail
 * (OTS + TSA + key DNS + key-obs TSA + archive) ≈ 26s — well inside the 60s lease.
 */
export const DEFAULT_ASSEMBLY_TIMEOUTS_MS = {
  /** Each timestamp stamp() call — OTS calendars / RFC 3161 TSA. */
  stamp: 6_000,
  /** The observed-key DNS resolution (F-6.7). */
  resolveKey: 4_000,
  /** The archive.prove.email check-and-contribute (F-6.7 / AC-60). */
  archive: 4_000,
  /**
   * The statement fetch + verify + select envelope (F-32.9) — bounds the whole
   * capture pipe except the two anchor stamps, which run in PARALLEL under one
   * `stamp` budget after it. Worst-case assembly tail stays ≈40s, inside the 60s
   * run lease (the 2026-07-05 incident's constraint).
   */
  statement: 8_000,
} as const;

export type AssemblyTimeoutsMs = Partial<Record<keyof typeof DEFAULT_ASSEMBLY_TIMEOUTS_MS, number>>;

export interface ArtifactAssemblyDeps {
  /** OTS provider — the primary Bitcoin-math timestamp (prod: createOtsProvider()). */
  timestampProvider: TimestampProvider;
  /** Optional second provider — the RFC 3161 TSA token (F-6.6). kysigned wires both. */
  tsaProvider?: TimestampProvider;
  /** Resolve the observed DKIM key for (domain, selector) — F-6.7. Omit to skip the observed-key log. */
  resolveDkimKey?: ResolveDkimKey;
  /** archive.prove.email deps — check-and-contribute-on-receipt (F-6.7 / AC-60). Omit to skip. */
  archive?: DkimArchiveDeps;
  /**
   * Statement-verification key set override (tests sign with throwaway keys).
   * Real-default DI (DD-17): unset runs the PINNED production set — the trust
   * anchor is always the verifier's committed keys, never caller data.
   */
  statementJwks?: ArchiveJwks;
  /** Override the external-call deadlines (tests use tiny budgets). */
  timeoutsMs?: AssemblyTimeoutsMs;
}

export interface AssembleArtifactInput {
  envelopeId: string;
  signerEmail: string;
  /** The inbound forward's stable id (raw `.eml` lives in run402's store). */
  messageId: string;
  /** The raw RFC-822 `.eml` — the signature artifact. */
  rawEml: string;
  /** The accepted DKIM signing domain (F-6.2). */
  signingDomain: string;
  /** The accepted DKIM selector — the observed-key lookup key (F-6.7). */
  selector: string;
  /** SES receipt verdicts (F-6.2a / AC-62). */
  verdicts: ReceiptVerdicts;
}

/** Lowercase hex SHA-256 + the raw 32-byte digest of the `.eml`. */
export function sha256Eml(rawEml: string): { hex: string; digest: Uint8Array } {
  const h = createHash('sha256').update(rawEml).digest();
  return { hex: h.toString('hex'), digest: new Uint8Array(h) };
}

/**
 * Resolve to `p`'s value, or to `fallback` if `p` rejects OR does not settle
 * within `ms`. The losing promise is left dangling by design (no socket/timer
 * handle of ours keeps the runtime alive; the Lambda context freezes on return).
 */
function settleWithin<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Stamp without ever throwing OR hanging — an error/timeout degrades to a null proof. */
function safeStamp(
  provider: TimestampProvider,
  digest: Uint8Array,
  deadlineMs: number,
): Promise<TimestampProof | null> {
  return settleWithin(provider.stamp(digest), deadlineMs, null);
}

/** A captured archive statement: the EXACT bytes + the operator's two anchors (F-32.9). */
export interface StatementCapture {
  statement: string;
  tsa: TimestampProof | null;
  ots: TimestampProof | null;
  capturedAt: Date;
}

/**
 * Fetch + verify + select + anchor the signer's archive statement (F-32.9). Selects
 * the statement whose record matches the EXACT observed key bytes (the DD-36
 * canonical `p=` compare) for the signer's pair, verified against the pinned
 * archive JWKS BEFORE anchoring; then dual-anchors `sha256(utf8(jws))` with the
 * two providers in parallel (each fail-proof — a null proof mirrors the `.eml`
 * anchors' degradation; the OTS-upgrade reconciler advances it later). Returns
 * null when nothing captures (GCD-only pair, outage, no match, deadline) — the
 * F-32.10 wait path retries via this same function. Never throws.
 */
export async function captureArchiveStatement(
  domain: string,
  selector: string,
  observedKey: string,
  deps: Pick<ArtifactAssemblyDeps, 'timestampProvider' | 'tsaProvider' | 'archive' | 'statementJwks'>,
  budgets: { statement: number; stamp: number },
): Promise<StatementCapture | null> {
  const jwks = deps.statementJwks ?? ARCHIVE_STATEMENT_JWKS;
  const want = extractPublicKey(observedKey);
  if (!want) return null;
  const picked = await settleWithin(
    (async () => {
      const res = await fetchArchiveStatements(domain, selector, deps.archive);
      for (const jws of res.statements) {
        const v = await verifyArchiveStatement(jws, jwks);
        if (!v.ok) continue;
        if (v.record.domain !== domain.toLowerCase() || v.record.selector !== selector.toLowerCase()) continue;
        if (extractPublicKey(v.record.value) !== want) continue;
        return jws;
      }
      return null;
    })(),
    budgets.statement,
    null,
  );
  if (!picked) return null;
  const digest = new Uint8Array(createHash('sha256').update(picked, 'utf8').digest());
  const [tsa, ots] = await Promise.all([
    deps.tsaProvider ? safeStamp(deps.tsaProvider, digest, budgets.stamp) : Promise.resolve<TimestampProof | null>(null),
    safeStamp(deps.timestampProvider, digest, budgets.stamp),
  ]);
  return { statement: picked, tsa, ots, capturedAt: new Date() };
}

export async function assembleSignatureArtifact(
  pool: DbPool,
  input: AssembleArtifactInput,
  deps: ArtifactAssemblyDeps,
): Promise<SignatureArtifact> {
  const { hex, digest } = sha256Eml(input.rawEml);
  const budgets = { ...DEFAULT_ASSEMBLY_TIMEOUTS_MS, ...deps.timeoutsMs };

  const otsProof = await safeStamp(deps.timestampProvider, digest, budgets.stamp);
  const tsaToken = deps.tsaProvider ? await safeStamp(deps.tsaProvider, digest, budgets.stamp) : null;

  // pending if the OTS proof is missing (stamp failed) or not yet Bitcoin-confirmed.
  const otsPending = !otsProof || otsProof.status === 'pending';
  const tsStatus: 'pending' | 'complete' = otsPending ? 'pending' : 'complete';

  // F-6.7 — observed-key log: record the live DKIM key, timestamp the observation,
  // and check-and-contribute it to the public archive. All fail-proof: a DNS/archive
  // hiccup never blocks recording the signature (the .eml + its timestamps stand).
  let dkimSelector: string | null = null;
  let dkimKey: string | null = null;
  let dkimObservedAt: Date | null = null;
  let keyObsProof: TimestampProof | null = null;
  let keyObsOtsProof: TimestampProof | null = null;
  let archiveStatus: string | null = null;

  if (deps.resolveDkimKey && input.selector) {
    dkimSelector = input.selector;
    const observed = await settleWithin(
      deps.resolveDkimKey(input.signingDomain, input.selector),
      budgets.resolveKey,
      null,
    );
    if (observed) {
      dkimKey = observed.value;
      dkimObservedAt = observed.observedAt;
      // F-6.7.1 / AC-169 — anchor the observation with BOTH anchors over the same
      // key-record digest: the RFC 3161 token AND OpenTimestamps (Bitcoin). The old
      // TSA-only rationale ("the key's Bitcoin/math anchor is the archive's witness.co
      // record") is VOID: the archive runs no chain timestamping (it dropped that path
      // in its rebuild — confirmed by the archive team 2026-07-15, zkemail/archive#46),
      // so the first-party observation must carry its own un-backdatable anchor.
      // Both stamps are fail-proof + deadline-bounded like the `.eml` anchors.
      const keyDigest = keyRecordDigest(input.signingDomain, input.selector, observed.value);
      if (deps.tsaProvider) {
        keyObsProof = await safeStamp(deps.tsaProvider, keyDigest, budgets.stamp);
      }
      keyObsOtsProof = await safeStamp(deps.timestampProvider, keyDigest, budgets.stamp);
    }
  }

  // F-32.6 (AC-163): the receipt-time check runs at VERIFIER PARITY — exact observed
  // key bytes present in the archive with a usable last-seen (confirmKeyAtSigning
  // shares the verifier's extractPublicKey predicate), contributing whenever the
  // selector's records lack the observed key. Still fail-proof + deadline-bounded:
  // any outcome (incl. outage) lets receipt proceed (AC-164).
  let archiveConfirmation: SigningKeyConfirmation | null = null;
  if (deps.archive && input.selector) {
    archiveConfirmation = await settleWithin(
      confirmKeyAtSigning(input.signingDomain, input.selector, dkimKey, deps.archive),
      budgets.archive,
      { outcome: 'outage', lastSeenAt: null, nudged: false, detail: 'archive call exceeded deadline' },
    );
    archiveStatus =
      archiveConfirmation.outcome === 'outage'
        ? 'outage'
        : archiveConfirmation.nudged
          ? 'contributed'
          : 'archived';
  }

  // F-32.9 — capture the archive's signed statement for the signer's exact key at
  // receipt (the typical path: a just-contributed pair is statement-issuable
  // immediately, so sealing gains zero latency). Fail-proof + deadline-bounded like
  // everything above; a miss here is retried by the F-32.10 wait path.
  let statementCapture: StatementCapture | null = null;
  if (deps.archive && input.selector && dkimKey) {
    statementCapture = await captureArchiveStatement(
      input.signingDomain,
      input.selector,
      dkimKey,
      deps,
      { statement: budgets.statement, stamp: budgets.stamp },
    );
  }

  const { artifact } = await upsertSignatureArtifact(pool, {
    envelope_id: input.envelopeId,
    signer_email: input.signerEmail,
    message_id: input.messageId,
    sha256_eml: hex,
    spf_verdict: input.verdicts.spf ?? null,
    dkim_verdict: input.verdicts.dkim ?? null,
    dmarc_verdict: input.verdicts.dmarc ?? null,
    dkim_domain: input.signingDomain,
    dkim_selector: dkimSelector,
    dkim_key: dkimKey,
    dkim_observed_at: dkimObservedAt,
    ots_proof: otsProof,
    tsa_token: tsaToken,
    key_obs_proof: keyObsProof,
    key_obs_ots_proof: keyObsOtsProof,
    archive_status: archiveStatus,
    archive_statement: statementCapture?.statement ?? null,
    archive_statement_tsa: statementCapture?.tsa ?? null,
    archive_statement_ots: statementCapture?.ots ?? null,
    archive_statement_captured_at: statementCapture?.capturedAt ?? null,
    archive_confirmation: archiveConfirmation?.outcome ?? null,
    archive_confirmation_checked_at: archiveConfirmation ? new Date() : null,
    ts_status: tsStatus,
  });
  return artifact;
}
