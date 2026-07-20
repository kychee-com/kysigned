/**
 * internalSubject — the F-36.6 internal-subject classifier (DD-49): the ONE
 * classification every identity-bearing app-event emit site consults before
 * emitting.
 *
 * The app-events feed carries EXTERNAL usage only. "Internal" means exactly
 * what the operator console's exclude-internal toggle means (F-35.4): the
 * account email matches the operator's configured internal-identity rules
 * (`KYSIGNED_INTERNAL_IDENTITIES` — empty on a fresh fork, so it matches
 * nobody), or the subject envelope is `internal_test` / has a rule-matched
 * creator. The gate owns the two disciplines the sites would otherwise copy:
 *
 *  - **The suppression log line.** One uniform line per suppressed emit
 *    (`app-event <type> [subject] suppressed: internal identity`) — the live
 *    observable that suppression, not breakage, is why the feed is quiet.
 *  - **Fail-open classification (AC-213).** The envelope form may need one
 *    SELECT; a failing lookup classifies EXTERNAL (the event emits) and logs.
 *    Availability of real events outranks perfect suppression, and the
 *    classification path must never gate a business transition (F-36.3).
 */
import { isInternalIdentity } from '../api/auth/internalIdentity.js';

/** The two envelope columns the console's envelope classification reads. */
export interface EnvelopeInternalFields {
  internal_test?: boolean | null;
  sender_email?: string | null;
}

/** Structural pool slice — `pg.QueryResult`'s `rows` is all the gate reads. */
export interface InternalSubjectPool {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface InternalSubjectGateDeps {
  /** Absent on email-only consumers (the private Stripe webhook). */
  pool?: InternalSubjectPool;
  /** The F-35.4 rule list (`AppDeps.internalIdentities`); empty matches nobody. */
  internalIdentities: readonly string[];
  log: (message: string) => void;
}

export interface InternalSubjectGate {
  /** Account form — pure F-35.4 predicate over the configured rules. */
  account(email: string | null | undefined): boolean;
  /** Envelope form — classify a provided row, else ONE SELECT; fails open. */
  envelope(envelopeId: string, row?: EnvelopeInternalFields): Promise<boolean>;
  /** The one uniform suppression line every gated site logs. */
  logSuppressed(type: string, subjectIds: readonly string[]): void;
}

/** The console's envelope classification: `internal_test` OR rule-matched creator. */
export function isInternalEnvelopeRow(
  row: EnvelopeInternalFields,
  rules: readonly string[],
): boolean {
  return Boolean(row.internal_test) || isInternalIdentity(row.sender_email, rules);
}

export function createInternalSubjectGate(deps: InternalSubjectGateDeps): InternalSubjectGate {
  return {
    account: (email) => isInternalIdentity(email, deps.internalIdentities),

    envelope: async (envelopeId, row) => {
      if (row) return isInternalEnvelopeRow(row, deps.internalIdentities);
      if (!deps.pool) return false; // nothing to look up with → fail open
      try {
        const r = await deps.pool.query(
          `SELECT internal_test, sender_email FROM envelopes WHERE id = $1`,
          [envelopeId],
        );
        const found = r.rows[0] as EnvelopeInternalFields | undefined;
        return found ? isInternalEnvelopeRow(found, deps.internalIdentities) : false;
      } catch (err) {
        deps.log(
          `app-event internal-classification failed for envelope [${envelopeId}], failing open: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    },

    logSuppressed: (type, subjectIds) => {
      deps.log(`app-event ${type} [${subjectIds.join(':')}] suppressed: internal identity`);
    },
  };
}
