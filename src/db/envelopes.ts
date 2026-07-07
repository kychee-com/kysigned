import { randomUUID, randomBytes } from 'node:crypto';
// randomBytes is used by generateToken (signing tokens).
import type { DbPool } from './pool.js';
import type { Envelope, EnvelopeSigner, CreateEnvelopeInput } from './types.js';

const TOKEN_EXPIRY_DAYS = 30;

// -----------------------------------------------------------------------
// Row rehydration (DD-10 HttpDbPool compatibility)
// -----------------------------------------------------------------------
//
// Local-dev uses node `pg.Pool` which auto-parses TIMESTAMPTZ columns into
// `Date` instances via pg's built-in type parsers. Production uses
// `HttpDbPool` (the operator's private repo) which wraps run402's HTTP SQL surface —
// that returns JSON, so TIMESTAMPTZ columns come back as ISO strings.
//
// Callers expect `Date` instances (they call `.toISOString()`, `.getTime()`,
// etc.), so every DAO read function passes rows through `rehydrate*` to
// convert known timestamp columns back to `Date`. Idempotent — if a value
// is already a Date, it's passed through untouched.
//
// If you add a new timestamp column to either table, add it to the
// appropriate list below.

const ENVELOPE_TIMESTAMP_COLS = [
  'created_at',
  'completed_at',
  'expiry_at',
  'pdf_deleted_at',
  'completion_distributed_at',
] as const;

const SIGNER_TIMESTAMP_COLS = [
  'signed_at',
  'token_expires_at',
  'last_reminder_at',
  'completion_email_delivered_at',
  'completion_email_bounced_at',
  'undeliverable_at',
  'acceptance_notified_at',
] as const;

function toDate(v: unknown): Date | null | undefined {
  if (v == null) return v as null | undefined;
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Exported (F-014) so the retention SWEEP, which runs its OWN raw `SELECT *` scan
// rather than going through the getEnvelope/getEnvelopeSigners DAO reads, can
// rehydrate its rows through the exact same coercion. Without this, the sweep's
// rows carried string timestamps and shouldDeletePdf crashed on `.getTime()`.
export function rehydrateEnvelope(row: unknown): Envelope {
  if (row == null || typeof row !== 'object') return row as Envelope;
  const r = row as Record<string, unknown>;
  for (const col of ENVELOPE_TIMESTAMP_COLS) {
    if (col in r) r[col] = toDate(r[col]);
  }
  return r as unknown as Envelope;
}

export function rehydrateSigner(row: unknown): EnvelopeSigner {
  if (row == null || typeof row !== 'object') return row as EnvelopeSigner;
  const r = row as Record<string, unknown>;
  for (const col of SIGNER_TIMESTAMP_COLS) {
    if (col in r) r[col] = toDate(r[col]);
  }
  return r as unknown as EnvelopeSigner;
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export interface CreateEnvelopeResult {
  envelope: Envelope;
  signers: Array<EnvelopeSigner & { signing_link: string }>;
}

/**
 * Create an envelope with N signers in a single atomic SQL call.
 *
 * DD-10 (see run402/docs/plans/kysigned-plan.md): kysigned runs over run402's
 * HTTP DB surface (`@run402/functions` `db.sql()`), which cannot hold a
 * cross-call `pg` transaction. Instead of BEGIN/INSERT/INSERT/COMMIT over
 * multiple round-trips, we build ONE multi-CTE statement that inserts the
 * envelope + all signers + returns both as a single JSON row. The run402
 * gateway wraps each `db.sql()` call in its own server-side BEGIN/COMMIT
 * (see run402/packages/gateway/src/routes/admin.ts), so atomicity is
 * preserved on the server.
 *
 * All ids are generated client-side (envelopeId via `randomUUID()`, tokens
 * via `randomBytes`), so there is no read-after-write dependency — every
 * parameter is known before the SQL runs.
 */
export async function createEnvelope(
  pool: DbPool,
  input: CreateEnvelopeInput,
  baseUrl: string
): Promise<CreateEnvelopeResult> {
  if (input.signers.length === 0) {
    throw new Error('createEnvelope requires at least one signer');
  }

  // F22.1 / 2F.L3.2 — envelope creator may pre-generate the envelopeId so it
  // can be baked into the canonical PDF's cover page BEFORE the row is
  // persisted (the docHash on the row is the SHA-256 of that canonical PDF).
  const envelopeId = input.envelope_id ?? randomUUID();
  const expiryAt = input.expiry_at ?? new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  // Pre-generate every per-signer value client-side. The signing_token is the
  // stable identifier we use downstream to reattach signing_link to the
  // returned signer rows, independent of DB order.
  const signerRows = input.signers.map((s) => ({
    email: s.email,
    // F-3.2 — a blank signer name falls back to the email address as the
    // identifier, so the NOT NULL `name` column always has a value.
    name: s.name?.trim() || s.email,
    // F-22.2 — optional "signing on behalf of" organisation; NULL when absent.
    on_behalf_of: s.on_behalf_of?.trim() || null,
    // Family B (F-3.3 / DD-9) — this signer's P_i hash, computed by the create
    // handler before persisting; NULL when not supplied (legacy/non-Family-B).
    sent_pdf_hash: s.sent_pdf_hash ?? null,
    verification_level: s.verification_level ?? 2,
    signing_token: generateToken(),
  }));

  // Build the VALUES rows for the signer INSERT. Each signer contributes 6
  // unique params (email, name, verification_level, signing_token, on_behalf_of,
  // sent_pdf_hash). envelope_id ($1) and token_expires_at ($5, reused from
  // expiry_at) come from the envelope params.
  //
  // Layout: envelope params $1..$6 (source_hash at $6), then per-signer params
  // $7..$(6 + 6N). Family B (DD-9): document_hash is now H_D = SHA-256 of the
  // shared document D (== source_hash); each signer's sent_pdf_hash is SHA-256
  // of their own P_i = cover_i ++ D (the per-signer F-6.4 target).
  const signerValuesRows = signerRows.map((_, i) => {
    const base = 7 + i * 6;
    return `($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $5, $${base + 4}, $${base + 5})`;
  }).join(',\n        ');

  const sql = `
    WITH env_ins AS (
      INSERT INTO envelopes (
        id, sender_email,
        document_name, document_hash,
        expiry_at,
        source_hash,
        consent_language_version
      )
      VALUES ($1, $2, $3, $4, $5, $6, '1.0')
      RETURNING *
    ),
    sig_ins AS (
      INSERT INTO envelope_signers (
        envelope_id, email, name, verification_level,
        signing_token, token_expires_at, on_behalf_of, sent_pdf_hash
      )
      VALUES
        ${signerValuesRows}
      RETURNING *
    )
    SELECT
      (SELECT row_to_json(env_ins.*) FROM env_ins) AS envelope,
      (SELECT COALESCE(json_agg(row_to_json(sig_ins.*)), '[]'::json) FROM sig_ins) AS signers
  `;

  const envelopeParams: unknown[] = [
    envelopeId,
    input.sender_email,
    input.document_name,
    input.document_hash,
    expiryAt,
    input.source_hash ?? null,
  ];

  const signerParams: unknown[] = signerRows.flatMap((s) => [
    s.email,
    s.name,
    s.verification_level,
    s.signing_token,
    s.on_behalf_of,
    s.sent_pdf_hash,
  ]);

  const result = await pool.query(sql, [...envelopeParams, ...signerParams]);

  if (result.rows.length !== 1) {
    throw new Error(`createEnvelope: expected 1 row, got ${result.rows.length}`);
  }

  const row = result.rows[0] as { envelope: Envelope; signers: EnvelopeSigner[] };
  // Rehydrate timestamps — when HttpDbPool is the underlying transport,
  // row_to_json() returns dates as ISO strings; rehydrate brings them back
  // to Date instances so downstream .toISOString()/.getTime() calls work.
  const envelope = rehydrateEnvelope(row.envelope);
  const returnedSigners = (row.signers ?? []).map(rehydrateSigner);

  // Match returned signers to the client-generated signing_tokens so we can
  // attach the signing_link in INPUT order — the CTE's json_agg does not
  // guarantee ordering.
  const signers: Array<EnvelopeSigner & { signing_link: string }> = signerRows.map((row) => {
    const returned = returnedSigners.find((s) => s.signing_token === row.signing_token);
    if (!returned) {
      throw new Error(`createEnvelope: signer with token not returned from DB (email=${row.email})`);
    }
    return {
      ...returned,
      signing_link: `${baseUrl}/v1/sign/${envelopeId}/${row.signing_token}`,
    };
  });

  return { envelope, signers };
}

export async function getEnvelope(pool: DbPool, id: string): Promise<Envelope | null> {
  const result = await pool.query('SELECT * FROM envelopes WHERE id = $1', [id]);
  if (!result.rows[0]) return null;
  return rehydrateEnvelope(result.rows[0]);
}

export async function getEnvelopeSigners(pool: DbPool, envelopeId: string): Promise<EnvelopeSigner[]> {
  const result = await pool.query(
    'SELECT * FROM envelope_signers WHERE envelope_id = $1 ORDER BY name',
    [envelopeId]
  );
  return result.rows.map(rehydrateSigner);
}

/** Look up one signer by its row id — the F-29 `reminder_send` durable-run handler
 *  loads the target signer to re-check its live state (still pending?) before nudging. */
export async function getSignerById(pool: DbPool, id: string): Promise<EnvelopeSigner | null> {
  const result = await pool.query('SELECT * FROM envelope_signers WHERE id = $1', [id]);
  if (!result.rows[0]) return null;
  return rehydrateSigner(result.rows[0]);
}

/**
 * Look up a signer by (envelope, email), case-insensitive — the inbound
 * membership gate's "is this From an invited signer?" check (F3.3.6.10(c),
 * 2F.SG.2). Mirrors the proven SQL the legacy synchronous inboundHandler runs
 * inline; this is the shared DAO home the async reconciler gate calls.
 * (inboundHandler — superseded by the async path — keeps its own inline copy.)
 */
export async function getSignerByEnvelopeAndEmail(
  pool: DbPool,
  envelopeId: string,
  email: string,
): Promise<EnvelopeSigner | null> {
  const result = await pool.query(
    'SELECT * FROM envelope_signers WHERE envelope_id = $1 AND LOWER(email) = LOWER($2)',
    [envelopeId, email]
  );
  if (!result.rows[0]) return null;
  return rehydrateSigner(result.rows[0]);
}

export async function getSignerByToken(pool: DbPool, token: string): Promise<EnvelopeSigner | null> {
  const result = await pool.query(
    'SELECT * FROM envelope_signers WHERE signing_token = $1',
    [token]
  );
  if (!result.rows[0]) return null;
  return rehydrateSigner(result.rows[0]);
}

/**
 * Mark a signer `signed` by (envelope_id, email) — the reply-to-sign flip the async
 * reconciler applies when a per-signer forward signature is recorded (F7.4 / 2F.CD.1).
 * Idempotent: the `status <> 'signed'` guard makes a re-driven tick a no-op (returns
 * false). Email match is case-insensitive. Returns true iff a row was flipped this
 * call.
 */
export async function markSignerSignedByEmail(
  pool: DbPool,
  envelopeId: string,
  email: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE envelope_signers
       SET status = 'signed', signed_at = now(), signing_method = 'email'
     WHERE envelope_id = $1 AND LOWER(email) = LOWER($2) AND status <> 'signed'
     RETURNING id`,
    [envelopeId, email]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * F-7.3 / F-29.6 — claim the acceptance-ack send for a signer EXACTLY once. Sets
 * `acceptance_notified_at` iff still NULL and returns true only when THIS call
 * claimed it, so a single email-trigger run sends the ack while a duplicate email
 * or a run retry gets false (no re-send). Replaces the inbound_replies `notified`
 * state. Looked up by (envelope, email) since that's what `processForward` returns.
 */
export async function markSignerAcceptanceNotified(
  pool: DbPool,
  envelopeId: string,
  email: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE envelope_signers SET acceptance_notified_at = now()
     WHERE envelope_id = $1 AND LOWER(email) = LOWER($2) AND acceptance_notified_at IS NULL
     RETURNING id`,
    [envelopeId, email],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateSignerDeclined(pool: DbPool, signerId: string): Promise<EnvelopeSigner> {
  const result = await pool.query(
    `UPDATE envelope_signers SET status = 'declined' WHERE id = $1 RETURNING *`,
    [signerId]
  );
  return rehydrateSigner(result.rows[0]);
}

/**
 * F-23.1 / DD-10 — add ONE signer to an existing open envelope (recipient
 * editing). Mirrors the per-signer columns of the createEnvelope batch insert;
 * the caller supplies the pre-generated `signing_token` (so it can store the
 * signer's `cover-<token>.pdf` and email P_i) and the computed `sent_pdf_hash`
 * (this signer's F-6.4 return-what-we-sent target). Returns the row + its
 * signing_link.
 */
export async function addSignerToEnvelope(
  pool: DbPool,
  envelopeId: string,
  signer: {
    email: string;
    name: string;
    on_behalf_of: string | null;
    verification_level: 1 | 2 | 5;
    signing_token: string;
    sent_pdf_hash: string;
    token_expires_at?: Date;
  },
  baseUrl: string,
): Promise<EnvelopeSigner & { signing_link: string }> {
  const tokenExpiresAt =
    signer.token_expires_at ?? new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const result = await pool.query(
    `INSERT INTO envelope_signers (
       envelope_id, email, name, verification_level,
       signing_token, token_expires_at, on_behalf_of, sent_pdf_hash
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      envelopeId,
      signer.email,
      signer.name,
      signer.verification_level,
      signer.signing_token,
      tokenExpiresAt,
      signer.on_behalf_of,
      signer.sent_pdf_hash,
    ],
  );
  const row = rehydrateSigner(result.rows[0]);
  return { ...row, signing_link: `${baseUrl}/v1/sign/${envelopeId}/${signer.signing_token}` };
}

/**
 * F-23.1 / F-23.2 / DD-10 — apply a recipient EDIT: new name / on-behalf-of org +
 * the regenerated P_i hash, plus the resulting status. An edit NEVER yields
 * `signed` — a previously-signed signer becomes `superseded` (re-requested), the
 * rest `pending` — so the prior signature is dropped (`signed_at` /
 * `signing_method` cleared) and the reminder + undeliverable state reset for the
 * fresh request.
 */
export async function updateSignerForEdit(
  pool: DbPool,
  signerId: string,
  fields: { name: string; on_behalf_of: string | null; sent_pdf_hash: string; status: 'pending' | 'superseded' },
): Promise<EnvelopeSigner> {
  const result = await pool.query(
    `UPDATE envelope_signers
        SET name = $2, on_behalf_of = $3, sent_pdf_hash = $4, status = $5,
            signed_at = NULL, signing_method = NULL, undeliverable_at = NULL,
            reminder_count = 0, last_reminder_at = NULL
      WHERE id = $1
      RETURNING *`,
    [signerId, fields.name, fields.on_behalf_of, fields.sent_pdf_hash, fields.status],
  );
  return rehydrateSigner(result.rows[0]);
}

/**
 * F-23.3 / F-23.4 — remove a signer from an envelope (a delete, or the delete-old
 * half of an email change). The handler sends the cancellation email + frees the
 * stored cover; this just drops the row.
 */
export async function deleteSigner(pool: DbPool, signerId: string): Promise<void> {
  await pool.query(`DELETE FROM envelope_signers WHERE id = $1`, [signerId]);
}

/**
 * F-3.7 — flag an envelope internal-test (set after creation so the batched
 * create INSERT param layout is untouched). No credit was deducted; downstream
 * metrics (GA4) exclude internal-test envelopes by reading this flag.
 */
export async function markEnvelopeInternalTest(pool: DbPool, envelopeId: string): Promise<void> {
  await pool.query(`UPDATE envelopes SET internal_test = true WHERE id = $1`, [envelopeId]);
}

/**
 * F-24.3 — set the envelope's auto-close flag (the create-flow toggle; editable
 * while the envelope is open). The schema default is `true`, so a create only
 * writes this when the creator opts into manual seal (`false`). Set after create
 * to keep the batched create-INSERT param layout untouched.
 */
export async function setEnvelopeAutoClose(pool: DbPool, envelopeId: string, autoClose: boolean): Promise<void> {
  await pool.query(`UPDATE envelopes SET auto_close = $2 WHERE id = $1`, [envelopeId, autoClose]);
}

/**
 * F-9.8/AC-50 — stamp a signer undeliverable when their signing-request email
 * hard-bounced. Idempotent (only stamps a still-pending, not-yet-stamped row).
 * Returns the signer (for the creator notice) or null if no row matched.
 */
export async function markSignerUndeliverable(
  pool: DbPool,
  envelopeId: string,
  email: string,
): Promise<EnvelopeSigner | null> {
  const result = await pool.query(
    `UPDATE envelope_signers SET undeliverable_at = now()
     WHERE envelope_id = $1 AND LOWER(email) = LOWER($2) AND status = 'pending' AND undeliverable_at IS NULL
     RETURNING *`,
    [envelopeId, email],
  );
  if (!result.rows[0]) return null;
  return rehydrateSigner(result.rows[0]);
}

/**
 * F-9.8 / AC-50 — active envelopes where `email` is still a PENDING signer. The
 * `bounced` mailbox webhook (a hard-bounced signing-request) maps to these so each
 * is marked undeliverable + its creator notified. A permanently-bad address is
 * undeliverable in every open envelope, so all matching active envelopes are
 * returned (the common case is one).
 */
export async function getActiveEnvelopesWithPendingSigner(
  pool: DbPool,
  email: string,
): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT e.id
       FROM envelopes e
       JOIN envelope_signers s ON s.envelope_id = e.id
      WHERE e.status = 'active' AND s.status = 'pending' AND LOWER(s.email) = LOWER($1)`,
    [email],
  );
  return result.rows.map((r) => (r as { id: string }).id);
}

export async function voidEnvelope(pool: DbPool, envelopeId: string): Promise<Envelope> {
  const result = await pool.query(
    `UPDATE envelopes SET status = 'voided' WHERE id = $1 AND status = 'active' RETURNING *`,
    [envelopeId]
  );
  if (result.rows.length === 0) throw new Error('Envelope not found or not active');
  return rehydrateEnvelope(result.rows[0]);
}

/**
 * F8.6 / F-9.3 / F-013 — stamp the envelope's ephemeral-retention marker. This is
 * the terminal-state record ("no blob is kept past retention") and it MUST be set
 * before purgeEnvelopeBlobs runs, because the shared-document guard reads it to
 * decide whether this envelope is the last one still referencing document D.
 * Idempotent (`WHERE pdf_deleted_at IS NULL`); returns true iff it stamped now.
 */
export async function markEnvelopePdfDeleted(
  pool: DbPool,
  envelopeId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE envelopes SET pdf_deleted_at = $2 WHERE id = $1 AND pdf_deleted_at IS NULL`,
    [envelopeId, at],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Bundle-model completion (F-9.1): mark the envelope `completed` with a STABLE
 * completed_at — `COALESCE(completed_at, now())` keeps the FIRST stamp across
 * re-runs, so the bundle's deterministic `completedAt` and the retention 30-day
 * clock never move under an idempotent re-distribution.
 */
export async function completeEnvelopeForBundle(pool: DbPool, envelopeId: string): Promise<Envelope> {
  const result = await pool.query(
    `UPDATE envelopes SET status = 'completed', completed_at = COALESCE(completed_at, now())
     WHERE id = $1 RETURNING *`,
    [envelopeId],
  );
  return rehydrateEnvelope(result.rows[0]);
}

/**
 * 2F.CD.3 (F7.5) — stamp the all-party completion distribution as finished (the
 * creator email is sent last, so this marker ⟺ everyone has been emailed).
 * Idempotent: `WHERE completion_distributed_at IS NULL` makes a re-run a no-op.
 * Returns true iff it stamped on this call.
 */
export async function markCompletionDistributed(pool: DbPool, envelopeId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE envelopes SET completion_distributed_at = now()
     WHERE id = $1 AND completion_distributed_at IS NULL
     RETURNING id`,
    [envelopeId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function checkAllSigned(pool: DbPool, envelopeId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'signed') as signed
     FROM envelope_signers WHERE envelope_id = $1`,
    [envelopeId]
  );
  const { total, signed } = result.rows[0] as { total: string; signed: string };
  return parseInt(total) > 0 && total === signed;
}

/**
 * 2F.CD.5 / F-24.1 — the "needs AUTO completion backstop" predicate over
 * `envelopes e`: every signer has signed but the all-party completion
 * distribution hasn't finished (`completion_distributed_at` NULL). Covers BOTH a
 * missed push (status='active' + all-signed) AND a crash mid-distribution
 * (status='completed' + marker NULL). **Gated to `auto_close = true`** — a manual
 * (`auto_close = false`) envelope never auto-distributes; it parks in
 * `awaiting_seal` and waits for the creator's explicit seal (F-24.2,
 * `getEnvelopesAwaitingSeal`). Only `getEnvelopesNeedingCompletion` consumes this.
 */
export const ENVELOPES_NEEDING_COMPLETION_WHERE = `e.completion_distributed_at IS NULL
       AND e.auto_close = true
       AND e.status IN ('active', 'completed')
       AND EXISTS (SELECT 1 FROM envelope_signers s WHERE s.envelope_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM envelope_signers s WHERE s.envelope_id = e.id AND s.status <> 'signed')`;

/**
 * 2F.CD.5 — envelopes matching ENVELOPES_NEEDING_COMPLETION_WHERE (see above).
 * The reconciler cron backstop runs `finalizeEnvelope` on each — idempotent,
 * so re-running a partially-distributed one finishes it without double-sending.
 */
export async function getEnvelopesNeedingCompletion(
  pool: DbPool,
  limit = 50,
): Promise<Array<{ id: string }>> {
  const result = await pool.query(
    `SELECT e.id FROM envelopes e
     WHERE ${ENVELOPES_NEEDING_COMPLETION_WHERE}
     ORDER BY e.created_at
     LIMIT $1`,
    [limit]
  );
  return (result.rows as Array<{ id: string }>).map((r) => ({ id: r.id }));
}

/**
 * F-24.2 — manual-seal candidates: `active` envelopes with `auto_close = false`
 * whose signers have ALL signed. The completion backstop emails the creator
 * ("review & seal") and parks each in `awaiting_seal`. The active→awaiting_seal
 * transition is itself the idempotency gate — once parked an envelope no longer
 * matches `status = 'active'`, so the notice fires exactly once.
 */
export async function getEnvelopesAwaitingSeal(
  pool: DbPool,
  limit = 50,
): Promise<Array<{ id: string }>> {
  const result = await pool.query(
    `SELECT e.id FROM envelopes e
      WHERE e.status = 'active' AND e.auto_close = false
        AND EXISTS (SELECT 1 FROM envelope_signers s WHERE s.envelope_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM envelope_signers s WHERE s.envelope_id = e.id AND s.status <> 'signed')
      ORDER BY e.created_at
      LIMIT $1`,
    [limit],
  );
  return (result.rows as Array<{ id: string }>).map((r) => ({ id: r.id }));
}

/**
 * F-24.2 — park a manual envelope in `awaiting_seal` (the creator must seal it).
 * Idempotent: flips ONLY an `active` envelope and returns the row when it flipped
 * on this call, null otherwise (already parked / not active) — so the caller emails
 * the "review & seal" notice exactly once.
 */
export async function transitionToAwaitingSeal(pool: DbPool, envelopeId: string): Promise<Envelope | null> {
  const result = await pool.query(
    `UPDATE envelopes SET status = 'awaiting_seal' WHERE id = $1 AND status = 'active' RETURNING *`,
    [envelopeId],
  );
  if (!result.rows[0]) return null;
  return rehydrateEnvelope(result.rows[0]);
}

/**
 * F-24.2 — revert an `awaiting_seal` envelope to `active`: an edit de-completed it
 * (a signed signer was superseded / an email-change added a pending signer), so it
 * is collecting signatures again and is no longer "ready to seal". Idempotent: flips
 * ONLY an awaiting_seal row. The completion-backstop cron re-parks it once the
 * re-requested signer signs.
 */
export async function reactivateAwaitingSeal(pool: DbPool, envelopeId: string): Promise<void> {
  await pool.query(
    `UPDATE envelopes SET status = 'active' WHERE id = $1 AND status = 'awaiting_seal'`,
    [envelopeId],
  );
}

/** F-29 — atomically claim ONE past-deadline envelope for its deferred
 *  `envelope_expire` run: flips `active` → `expired` only if it is still active AND
 *  actually past its deadline. A completed / voided / not-yet-due (or unknown)
 *  envelope returns null, so the run no-ops (the deadline moved / it was finished). */
export async function claimExpiredEnvelope(pool: DbPool, id: string): Promise<Envelope | null> {
  const result = await pool.query(
    `UPDATE envelopes SET status = 'expired'
     WHERE id = $1 AND status = 'active' AND expiry_at IS NOT NULL AND expiry_at <= now()
     RETURNING *`,
    [id],
  );
  if (!result.rows[0]) return null;
  return rehydrateEnvelope(result.rows[0]);
}

/**
 * Force-expire an active envelope (admin action for e2e/ops).
 * Sets status to 'expired' and expiry_at to now() regardless of the original TTL.
 */
export async function forceExpireEnvelope(pool: DbPool, envelopeId: string): Promise<Envelope> {
  const result = await pool.query(
    `UPDATE envelopes SET status = 'expired', expiry_at = now()
     WHERE id = $1 AND status = 'active'
     RETURNING *`,
    [envelopeId]
  );
  if (result.rows.length === 0) throw new Error('Envelope not found or not active');
  return rehydrateEnvelope(result.rows[0]);
}

/**
 * Envelopes created by `senderEmail` (the creator identity is email-only),
 * newest first.
 */
export async function getEnvelopesBySender(
  pool: DbPool,
  senderEmail: string
): Promise<Envelope[]> {
  const result = await pool.query(
    `SELECT * FROM envelopes WHERE sender_email = $1 ORDER BY created_at DESC`,
    [senderEmail]
  );
  return result.rows.map(rehydrateEnvelope);
}

export async function updateSignerReminder(pool: DbPool, signerId: string): Promise<void> {
  await pool.query(
    `UPDATE envelope_signers SET reminder_count = reminder_count + 1, last_reminder_at = now() WHERE id = $1`,
    [signerId]
  );
}

/**
 * Signers with an OUTSTANDING signature request — `pending` (never signed) OR
 * `superseded` (signed, then re-requested after a creator edit). Both still owe a
 * signature, so both are who manual reminders nudge and who a void notifies. (A
 * superseded signer is reset to reminder_count 0 on edit, so it's freshly eligible.)
 */
export async function getOutstandingSigners(pool: DbPool, envelopeId: string): Promise<EnvelopeSigner[]> {
  const result = await pool.query(
    `SELECT * FROM envelope_signers WHERE envelope_id = $1 AND status IN ('pending', 'superseded') ORDER BY name`,
    [envelopeId]
  );
  return result.rows.map(rehydrateSigner);
}

// getReminderCandidates / ReminderCandidate (the reminder-sweep query) were removed
// with the sweep in F-29 — reminders are deferred durable runs scheduled at send.

/**
 * DD-12: stamp the signer row with the email provider's message id when the
 * completion email is sent. The SES webhook handler uses this id to correlate
 * delivery/bounce events back to (envelope_id, email).
 *
 * Returns true if a row was updated, false if signer_id was not found.
 */
export async function markCompletionEmailSent(
  pool: DbPool,
  signer_id: string,
  provider_msg_id: string
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE envelope_signers
     SET completion_email_provider_msg_id = $2
     WHERE id = $1
     RETURNING id`,
    [signer_id, provider_msg_id]
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

/**
 * DD-12: webhook correlation lookup — given the email provider's message id,
 * return the signer row (so the webhook handler can extract envelope_id + email
 * and call markCompletionEmailDelivered / markCompletionEmailBounced).
 *
 * Returns null when no signer has been stamped with this provider msg id.
 */
// ─── F16.B: Multi-Envelope Document Grouping ─────────────────────────

export interface DocumentGroup {
  documentHash: string;
  documentName: string;
  totalSigners: number;
  signedCount: number;
  envelopes: Envelope[];
}

/**
 * Get documents owned by a sender, grouped by source upload (F16.5).
 *
 * v0.19.x: groups by `COALESCE(source_hash, document_hash)`. Under v0.19.0+
 * each envelope's canonical PDF bakes per-envelope metadata into the cover,
 * so document_hash differs per envelope even for the same source. We group
 * by source_hash (SHA-256 of pre-assembly source bytes) so the dashboard
 * still shows ONE row per unique source PDF with all envelopes underneath.
 * Legacy pre-v0.19.0 rows have source_hash = NULL and fall back to
 * document_hash for grouping — they still appear correctly with their
 * historical grouping behavior.
 */
export async function getDocumentsByOwner(
  pool: DbPool,
  senderIdentity: string
): Promise<DocumentGroup[]> {
  // Get all envelopes for this creator (identity is email-only).
  const envelopeResult = await pool.query(
    `SELECT * FROM envelopes WHERE sender_email = $1 ORDER BY created_at DESC`,
    [senderIdentity]
  );
  const envelopes = envelopeResult.rows.map(rehydrateEnvelope);

  if (envelopes.length === 0) return [];

  // Group envelopes by source_hash (v0.19.x) with COALESCE fallback to
  // document_hash for legacy rows. The map key is the GROUPING hash; the
  // DocumentGroup.documentHash field surfaces it for the API contract.
  const groups = new Map<string, Envelope[]>();
  for (const env of envelopes) {
    const groupKey = env.source_hash ?? env.document_hash;
    const existing = groups.get(groupKey) ?? [];
    existing.push(env);
    groups.set(groupKey, existing);
  }

  // For each group, collect signer stats
  const results: DocumentGroup[] = [];
  for (const [hash, envs] of groups) {
    let totalSigners = 0;
    let signedCount = 0;

    for (const env of envs) {
      const signerResult = await pool.query(
        'SELECT * FROM envelope_signers WHERE envelope_id = $1 ORDER BY name',
        [env.id]
      );
      const signers = signerResult.rows.map(rehydrateSigner);
      totalSigners += signers.length;
      signedCount += signers.filter(s => s.status === 'signed').length;
    }

    results.push({
      documentHash: hash,
      documentName: envs[0].document_name,
      totalSigners,
      signedCount,
      envelopes: envs,
    });
  }

  return results;
}

/**
 * Get signers who have NOT signed across any envelope for a document (F16.C).
 * Returns unique signers by email — if the same email appears in multiple
 * envelopes but signed in at least one, they are excluded.
 */
export async function getIncompleteSigners(
  pool: DbPool,
  documentHash: string,
  senderIdentity: string
): Promise<Array<{ email: string; name: string }>> {
  const documents = await getDocumentsByOwner(pool, senderIdentity);
  // v0.19.x lookup tolerance: documentHash arg may be a source_hash (group
  // key) OR a canonical document_hash from a single envelope. Match both.
  const docGroup = documents.find(d =>
    d.documentHash === documentHash ||
    d.envelopes.some(e => e.document_hash === documentHash),
  );
  if (!docGroup) return [];

  // Collect all signers across all envelopes, tracking signed emails
  const signedEmails = new Set<string>();
  const allSigners: Array<{ email: string; name: string; status: string }> = [];

  for (const env of docGroup.envelopes) {
    const signers = await getEnvelopeSigners(pool, env.id);
    for (const s of signers) {
      allSigners.push({ email: s.email, name: s.name, status: s.status });
      if (s.status === 'signed') signedEmails.add(s.email);
    }
  }

  // Return unique incomplete signers (not signed in ANY envelope)
  const seen = new Set<string>();
  return allSigners
    .filter(s => !signedEmails.has(s.email) && !seen.has(s.email) && (seen.add(s.email), true))
    .map(s => ({ email: s.email, name: s.name }));
}

export async function findSignerByCompletionEmailId(
  pool: DbPool,
  provider_msg_id: string
): Promise<EnvelopeSigner | null> {
  const result = await pool.query(
    `SELECT * FROM envelope_signers
     WHERE completion_email_provider_msg_id = $1
     LIMIT 1`,
    [provider_msg_id]
  );
  if (!result.rows[0]) return null;
  return rehydrateSigner(result.rows[0]);
}
