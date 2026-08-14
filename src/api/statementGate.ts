/**
 * statementGate.ts — F-32.10: the bounded statement wait at sealing (spec 0.71.0,
 * zkemail/archive#46).
 *
 * Sealing gates on each signed signer's archive-statement capture (F-32.9). The
 * typical path adds zero latency (statements issue synchronously at receipt); when
 * capture is blocked — archive outage, a pair with no live-DNS observation yet, a
 * reused-selector rotation inside the archive's refresh throttle — the envelope
 * enters a bounded wait: capture re-attempts ride self-rescheduled delayed runs
 * (the F-9.3 chain pattern), the creator gets ONE interim "finalizing" email
 * (only-when-waiting, AC-270), and at bound expiry the envelope seals WITHOUT the
 * missing statements (live-fallback semantics + retroactive self-heal, AC-269)
 * with ONE aggregated operator alert. Receipt/acceptance is never delayed
 * (AC-163) — this gate runs only on the distribution path.
 */
import type { DbPool } from '../db/pool.js';
import type { Envelope, SignatureArtifact } from '../db/types.js';
import type { TimestampProvider } from '../timestamp/contract.js';
import type { EmailProvider } from '../email/types.js';
import type { CreateRun } from '../functions/runs.js';
import type { ArchiveJwks } from '../bundle/archiveStatement.js';
import type { DkimArchiveDeps } from './signing/dkimArchive.js';
import { listEnvelopeSignatureArtifacts, updateArtifactArchiveStatement } from '../db/signatureArtifacts.js';
import { setFinalizingSince, markFinalizingEmailSent, markStatementWaived } from '../db/envelopes.js';
import { captureArchiveStatement, DEFAULT_ASSEMBLY_TIMEOUTS_MS } from './signing/artifactAssembly.js';
import { templates } from '../email/templates.js';

export const STATEMENT_WAIT_DEFAULT_HOURS = 24;
/** First re-check lands quickly (a fresh custom-domain pair often propagates fast). */
export const STATEMENT_RECHECK_INITIAL_DELAY = '30m';
/** Subsequent re-checks hourly (the archive's known-selector refetch throttle is 1h). */
export const STATEMENT_RECHECK_RETRY_DELAY = '1h';

export interface StatementGateDeps {
  timestampProvider: TimestampProvider;
  tsaProvider?: TimestampProvider;
  archive?: DkimArchiveDeps;
  /** Test override; unset = the pinned production JWKS (DD-17 real-default). */
  statementJwks?: ArchiveJwks;
  emailProvider: EmailProvider;
  operatorDomain: string;
  /** Operator alert address (default `info@<operatorDomain>` — the F-32.7 channel). */
  alertEmail?: string;
  createRun?: CreateRun;
  /** Bound in hours (default 24; kysigned.com: env `KYSIGNED_STATEMENT_WAIT_HOURS`). */
  waitHours?: number;
  timeoutsMs?: { statement?: number; stamp?: number };
  now?: () => Date;
}

export type StatementGateAction =
  | 'ready' // every capturable artifact has its statement (or the envelope is waived) — distribute
  | 'waiting' // capture blocked, bound open — a re-check is scheduled, do NOT distribute yet
  | 'waived'; // bound expired THIS call — alert sent, distribute without the missing statements

export interface StatementGateResult {
  action: StatementGateAction;
  /** Artifacts still lacking a statement after this evaluation (waiting/waived). */
  missing: number;
}

/** Signed artifacts that CAN capture (have a selector + observed key) but haven't. */
export function capturableMissing(artifacts: SignatureArtifact[]): SignatureArtifact[] {
  return artifacts.filter(
    (a) => a.archive_statement == null && a.dkim_selector != null && a.dkim_key != null,
  );
}

/** Schedule the next re-check link (idempotency = one run per hour slot). Best-effort. */
async function scheduleStatementRecheck(
  createRun: CreateRun | undefined,
  envelopeId: string,
  slot: number,
  delay: string,
): Promise<void> {
  if (!createRun) return;
  try {
    await createRun({
      eventType: 'statement_wait_recheck',
      idempotencyKey: `${envelopeId}:stmt-wait:${slot}`,
      payload: { envelopeId, slot },
      delay,
    });
  } catch (err) {
    console.error(`statement_wait_recheck schedule failed (${envelopeId} #${slot}):`, err);
  }
}

export async function evaluateStatementGate(
  pool: DbPool,
  envelope: Envelope,
  deps: StatementGateDeps,
): Promise<StatementGateResult> {
  // An already-waived envelope proceeds with whatever was captured (AC-269) —
  // never a second wait, never a second alert.
  if (envelope.statement_waived_at) return { action: 'ready', missing: 0 };

  const artifacts = await listEnvelopeSignatureArtifacts(pool, envelope.id);
  let missing = capturableMissing(artifacts);
  if (missing.length === 0) return { action: 'ready', missing: 0 };

  // Re-attempt capture NOW — the pair may have propagated / left the refresh
  // throttle / recovered from the outage since receipt.
  const budgets = {
    statement: deps.timeoutsMs?.statement ?? DEFAULT_ASSEMBLY_TIMEOUTS_MS.statement,
    stamp: deps.timeoutsMs?.stamp ?? DEFAULT_ASSEMBLY_TIMEOUTS_MS.stamp,
  };
  const still: SignatureArtifact[] = [];
  for (const a of missing) {
    const cap = await captureArchiveStatement(a.dkim_domain ?? '', a.dkim_selector!, a.dkim_key!, deps, budgets);
    if (cap) {
      await updateArtifactArchiveStatement(pool, a.id, cap);
    } else {
      still.push(a);
    }
  }
  missing = still;
  if (missing.length === 0) return { action: 'ready', missing: 0 };

  const now = deps.now?.() ?? new Date();
  const since = envelope.finalizing_since ?? (await setFinalizingSince(pool, envelope.id, now));
  const elapsedMs = now.getTime() - since.getTime();
  const boundMs = (deps.waitHours ?? STATEMENT_WAIT_DEFAULT_HOURS) * 3_600_000;

  if (elapsedMs >= boundMs) {
    // Bound expired: waive (once) → ONE aggregated operator alert → proceed with
    // what was captured. The live-fallback + retroactive self-heal semantics of
    // the pre-statement era apply to the missing signers (AC-269).
    const claimed = await markStatementWaived(pool, envelope.id);
    if (claimed) {
      const lines = missing.map(
        (a) =>
          `- envelope ${a.envelope_id} / signer ${a.signer_email} — ` +
          `${a.dkim_domain ?? '?'}/${a.dkim_selector ?? '?'} (receipt confirmation: ${a.archive_confirmation ?? 'unknown'})`,
      );
      const text =
        `Envelope ${envelope.id} ("${envelope.document_name}") sealed WITHOUT ${missing.length} archive ` +
        `statement(s) after the ${deps.waitHours ?? STATEMENT_WAIT_DEFAULT_HOURS}h bounded wait (F-32.10).\n\n` +
        `${lines.join('\n')}\n\n` +
        `The bundle was delivered and verifies via the live archive fallback; it self-heals to full ` +
        `provenance once the archive observes the key. If the provider rotated the key away before any ` +
        `observation, the affected signature is capped below PROVEN (DURABLE) permanently — asking the ` +
        `customer to re-sign (optionally with a credit grant) is YOUR call; nothing here contacts customers.`;
      try {
        await deps.emailProvider.send({
          to: deps.alertEmail ?? `info@${deps.operatorDomain}`,
          from: `notifications@${deps.operatorDomain}`,
          subject: `kysigned: envelope sealed without ${missing.length} archive statement(s) after the bounded wait`,
          text,
          html: `<pre>${text}</pre>`,
        });
      } catch (err) {
        // The waive stands (the customer's delivery is not hostage to the alert);
        // the F-32.7 sweep still surfaces the non-clean confirmations daily.
        console.error(`statement-waive alert send failed (${envelope.id}):`, err);
      }
    }
    return { action: 'waived', missing: missing.length };
  }

  // Bound open: interim creator email (at most once, only-when-waiting — AC-270;
  // mark-first = at-most-once, a lost email is acceptable, the dashboard shows
  // finalizing) + the next re-check link (one per hour slot).
  const claimedEmail = await markFinalizingEmailSent(pool, envelope.id);
  if (claimedEmail) {
    const t = templates.finalizingWait({
      recipientName: envelope.sender_email,
      documentName: envelope.document_name,
      signerCount: artifacts.length,
      operatorDomain: deps.operatorDomain,
    });
    try {
      await deps.emailProvider.send({
        to: envelope.sender_email,
        subject: t.subject,
        html: t.html,
        text: t.text,
        from: t.from,
        replyTo: t.replyTo,
      });
    } catch (err) {
      console.error(`finalizing interim email send failed (${envelope.id}):`, err);
    }
  }

  const slot = Math.floor(elapsedMs / 3_600_000) + 1;
  const delay = elapsedMs < 30 * 60_000 ? STATEMENT_RECHECK_INITIAL_DELAY : STATEMENT_RECHECK_RETRY_DELAY;
  await scheduleStatementRecheck(deps.createRun, envelope.id, slot, delay);
  return { action: 'waiting', missing: missing.length };
}
