/**
 * archiveReconciliation — the F-32.7 daily operator backstop (spec 0.44.0,
 * AC-165/AC-166, DD-36, #147; interim surface for #148/#149).
 *
 * Signing-time archive confirmation (F-32.6) can legitimately be unclean at
 * receipt: the archive was down, the pair was contributed just now (read path
 * lags), or a reused selector's records were stale. None of that damages the
 * sealed bundle — verification is a live archive lookup, so the artifact
 * SELF-HEALS the moment the archive observes the key. What needs an operator is
 * the one unrecoverable case: the provider rotates the key away before the
 * archive ever observes it, permanently capping the bundle below the durable
 * tier. This sweep separates the two, 24-48h after receipt (at least a full day
 * for the archive to settle; every artifact is in-window for exactly one daily
 * run, which also bounds re-alerting):
 *
 *   - re-evaluate the SAME verifier-parity predicate used at receipt
 *     (confirmKeyAtSigning — exact key bytes + usable last-seen, contributing
 *     again where still absent);
 *   - healed → record confirmed + healed_at, SILENTLY (no notification);
 *   - still failing → ONE aggregated email to the operator (info@, From
 *     notifications@) naming the affected envelopes/signers.
 *
 * The sweep NEVER emails signers or creators (AC-166): whether a customer is
 * asked to re-sign (optionally with a credit grant) is a HUMAN decision taken
 * after reading the alert — early archive hiccups must never spam customers.
 * Confirmation state lives on the artifact rows (the #148 dashboard reads the
 * same fields); this email is the interim alert channel until #149.
 */
import type { DbPool } from '../../db/pool.js';
import type { EmailProvider } from '../../email/types.js';
import type { SignatureArtifact } from '../../db/types.js';
import {
  listArtifactsForArchiveReconciliation,
  updateArtifactArchiveConfirmation,
} from '../../db/signatureArtifacts.js';
import { confirmKeyAtSigning, type DkimArchiveDeps, type SigningConfirmOutcome } from './dkimArchive.js';
import type { EmitAppEvent } from '../../integrations/appEvents.js';

export interface ArchiveReconciliationDeps {
  emailProvider: EmailProvider;
  operatorDomain: string;
  /**
   * Operator alert recipient. Default `info@<operatorDomain>` — but the
   * in-project mailboxes are store-only (nothing forwards externally), so
   * kysigned.com routes this to a real inbox via KYSIGNED_OPERATOR_ALERT_EMAIL
   * (interim until the #149 alerts mechanism).
   */
  alertEmail?: string;
  /** Archive client deps (tests inject a fake fetch; omit for the real archive). */
  archive?: DkimArchiveDeps;
  /** Injected for tests; defaults to the call time. */
  now?: Date;
  /** F-36 — the DD-43 app-events seam (never throws). Prod (runHandlers) wires it. */
  emitAppEvent?: EmitAppEvent;
  /** Sweep window override (defaults 24-48h — see the DAO). */
  window?: { minAgeHours?: number; maxAgeHours?: number };
}

export interface ArchiveReconciliationResult {
  /** Artifacts in the window with non-clean confirmation state. */
  swept: number;
  /** Re-checks that came back confirmed (recorded silently). */
  healed: number;
  /** Re-checks still not confirmed (aggregated into the operator alert). */
  stillFailing: number;
  /** An operator alert email was sent this run. */
  alerted: boolean;
}

interface FailingEntry {
  artifact: SignatureArtifact;
  outcome: SigningConfirmOutcome;
  detail?: string;
}

/** One unit of daily backstop work — invoked by the `archive_reconciliation_sweep` schedule trigger. */
export async function runArchiveReconciliation(
  pool: DbPool,
  deps: ArchiveReconciliationDeps,
): Promise<ArchiveReconciliationResult> {
  const now = deps.now ?? new Date();
  const due = await listArtifactsForArchiveReconciliation(pool, now, deps.window);

  let healed = 0;
  const failing: FailingEntry[] = [];
  for (const artifact of due) {
    if (!artifact.dkim_domain || !artifact.dkim_selector) continue; // defensive; the DAO already requires a selector
    const check = await confirmKeyAtSigning(artifact.dkim_domain, artifact.dkim_selector, artifact.dkim_key, deps.archive);
    if (check.outcome === 'confirmed') {
      healed += 1;
      await updateArtifactArchiveConfirmation(pool, artifact.id, {
        confirmation: 'confirmed',
        checkedAt: now,
        healedAt: now,
      });
    } else {
      failing.push({ artifact, outcome: check.outcome, detail: check.detail });
      await updateArtifactArchiveConfirmation(pool, artifact.id, {
        confirmation: check.outcome,
        checkedAt: now,
      });
    }
  }

  const alerted = failing.length > 0;
  if (alerted) {
    const lines = failing.map(
      ({ artifact, outcome, detail }) =>
        `- envelope ${artifact.envelope_id} / signer ${artifact.signer_email} — ` +
        `${artifact.dkim_domain}/${artifact.dkim_selector}: ${outcome}${detail ? ` (${detail})` : ''}`,
    );
    const text =
      `${failing.length} signature artifact(s) still lack third-party archive confirmation ` +
      `24-48h after signing (F-32.7 sweep; healed this run: ${healed}).\n\n` +
      `${lines.join('\n')}\n\n` +
      `The sealed bundles remain valid and self-heal if the archive observes the key while it is ` +
      `still live in DNS. If a provider rotated the key away before any observation, the affected ` +
      `bundle is capped below PROVEN (DURABLE) permanently — deciding whether to ask the customer ` +
      `to re-sign (optionally with a credit grant) is YOUR call; this sweep never contacts customers.`;
    await deps.emailProvider.send({
      to: deps.alertEmail ?? `info@${deps.operatorDomain}`,
      from: `notifications@${deps.operatorDomain}`,
      subject: `kysigned: ${failing.length} archive confirmation(s) still failing after 24h`,
      text,
      html: `<pre>${text}</pre>`,
    });
    // F-36 — sweep_anomaly with a DATED key: each day's still-failing outcome is
    // its own fact (the gateway's forever-dedup would swallow tomorrow's real
    // anomaly under an undated key). Counts + enum only — never signer emails.
    await deps.emitAppEvent?.('sweep_anomaly', ['archive-reconciliation', now.toISOString().slice(0, 10)], {
      monitor: 'archive_reconciliation',
      still_failing: failing.length,
      healed,
    });
  }

  return { swept: due.length, healed, stillFailing: failing.length, alerted };
}
