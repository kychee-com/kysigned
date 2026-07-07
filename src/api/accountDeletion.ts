/**
 * Account deletion automation — DPA Section 11.
 *
 * Hard contractual commitment: a customer's personal data is deleted in full
 * within 30 days of their deletion request. The creator identity is an email
 * address (the only identity kysigned holds). This procedure deletes:
 *
 *   - Every envelope where the creator is this email
 *   - Every envelope_signers row attached to those envelopes
 *   - Every stored blob for each envelope — the shared document D AND each
 *     per-signer cover, at their real document_hash/signing_token keys (F-013),
 *     skipping any already-ephemerally-deleted via the F-9.3 retention sweep, and
 *     retaining a content-addressed document still shared by another creator
 *   - The identity's row in allowed_senders (if present)
 *   - The identity's per-month usage counter rows
 *
 * The one thing deletion cannot reach is an evidence bundle already delivered to
 * the parties' own inboxes — once an email leaves, the recipients hold their own
 * copies, the same as any sent document. We delete everything we hold; the
 * delivered bundles live with the people who received them. This limitation is
 * disclosed up front and reflected in the Privacy Policy's erasure section.
 *
 * The procedure returns a DeletionReport with counts. Use verifyDeletion()
 * separately to assert that nothing was missed (you should always call both
 * during a real deletion request — see the operator's incident-response runbook).
 */
import type { DbPool } from '../db/pool.js';
import { purgeEnvelopeBlobs } from '../pdf/blobPurge.js';

export interface DeletionStorage {
  deletePdf(key: string): Promise<void>;
}

export interface DeletionReport {
  envelopes_deleted: number;
  signers_deleted: number;
  pdfs_deleted: number;
  pdf_delete_failures: number;
  allowed_sender_rows_deleted: number;
  usage_rows_deleted: number;
}

export interface DeletionVerification {
  ok: boolean;
  envelopes_remaining: number;
  signers_remaining: number;
  allowed_sender_rows_remaining: number;
  usage_rows_remaining: number;
}

function normalize(identity: string): string {
  return identity.trim().toLowerCase();
}

export async function deleteAccount(
  pool: DbPool,
  storage: DeletionStorage,
  identity_type: 'email',
  identity: string
): Promise<DeletionReport> {
  const normalized = normalize(identity);

  // Step 1: gather every envelope owned by this identity (creator = email-only).
  const envResult = await pool.query(
    `SELECT * FROM envelopes WHERE sender_email = $1`,
    [normalized]
  );
  const envelopes = envResult.rows as any[];
  const envIds = envelopes.map((e) => e.id);

  // Step 2: gather each envelope's signers up front — their signing_tokens key
  // the per-signer cover blobs (F-013), and we must read them BEFORE deleting the
  // signer rows below.
  const signersByEnv = new Map<string, { signing_token: string }[]>();
  if (envIds.length > 0) {
    const sres = await pool.query(
      `SELECT envelope_id, signing_token FROM envelope_signers WHERE envelope_id = ANY($1::uuid[])`,
      [envIds]
    );
    for (const row of sres.rows as any[]) {
      const list = signersByEnv.get(row.envelope_id) ?? [];
      list.push({ signing_token: row.signing_token });
      signersByEnv.set(row.envelope_id, list);
    }
  }

  // Step 3: delete the signer rows for those envelopes.
  let signersDeleted = 0;
  if (envIds.length > 0) {
    const r = await pool.query(
      `DELETE FROM envelope_signers WHERE envelope_id = ANY($1::uuid[])`,
      [envIds]
    );
    signersDeleted = r.rowCount ?? 0;
  }

  // Step 4: delete the envelope rows.
  let envelopesDeleted = 0;
  if (envIds.length > 0) {
    const r = await pool.query(
      `DELETE FROM envelopes WHERE id = ANY($1::uuid[])`,
      [envIds]
    );
    envelopesDeleted = r.rowCount ?? 0;
  }

  // Step 4b: purge each envelope's stored blobs at their REAL keys — document D +
  // every per-signer cover (F-013), NOT the always-null `pdf_storage_key` (whose
  // nullness meant account deletion NEVER purged the document blob either). Run
  // AFTER the rows are gone so purgeEnvelopeBlobs' shared-document guard counts
  // only surviving OTHER envelopes (e.g. a different creator who uploaded the same
  // file → same content-addressed D). Skip anything already freed by the F-9.3
  // retention sweep (pdf_deleted_at set).
  let pdfsDeleted = 0;
  let pdfFailures = 0;
  for (const env of envelopes) {
    if (env.pdf_deleted_at) continue;
    const signers = signersByEnv.get(env.id) ?? [];
    const r = await purgeEnvelopeBlobs(pool, storage, env, signers);
    pdfsDeleted += r.deleted;
    pdfFailures += r.failed;
  }

  // Step 5: drop the allowlist row (if any).
  const allowResult = await pool.query(
    `DELETE FROM allowed_senders WHERE identity = $1 AND identity_type = $2`,
    [normalized, identity_type]
  );
  const allowDeleted = allowResult.rowCount ?? 0;

  // Step 6: drop the per-month usage counters.
  const usageResult = await pool.query(
    `DELETE FROM allowed_sender_usage WHERE identity = $1 AND identity_type = $2`,
    [normalized, identity_type]
  );
  const usageDeleted = usageResult.rowCount ?? 0;

  return {
    envelopes_deleted: envelopesDeleted,
    signers_deleted: signersDeleted,
    pdfs_deleted: pdfsDeleted,
    pdf_delete_failures: pdfFailures,
    allowed_sender_rows_deleted: allowDeleted,
    usage_rows_deleted: usageDeleted,
  };
}

export async function verifyDeletion(
  pool: DbPool,
  identity_type: 'email',
  identity: string
): Promise<DeletionVerification> {
  const normalized = normalize(identity);

  const envCount = await pool.query(
    `SELECT COUNT(*) FROM envelopes WHERE sender_email = $1`,
    [normalized]
  );
  const sigCount = await pool.query(
    `SELECT COUNT(*) FROM envelope_signers WHERE envelope_id IN (SELECT id FROM envelopes WHERE sender_email = $1)`,
    [normalized]
  );
  const allowCount = await pool.query(
    `SELECT COUNT(*) FROM allowed_senders WHERE identity = $1 AND identity_type = $2`,
    [normalized, identity_type]
  );
  const usageCount = await pool.query(
    `SELECT COUNT(*) FROM allowed_sender_usage WHERE identity = $1 AND identity_type = $2`,
    [normalized, identity_type]
  );

  const envelopes = parseInt((envCount.rows[0] as any).count, 10);
  const signers = parseInt((sigCount.rows[0] as any).count, 10);
  const allowed = parseInt((allowCount.rows[0] as any).count, 10);
  const usage = parseInt((usageCount.rows[0] as any).count, 10);

  return {
    ok: envelopes === 0 && signers === 0 && allowed === 0 && usage === 0,
    envelopes_remaining: envelopes,
    signers_remaining: signers,
    allowed_sender_rows_remaining: allowed,
    usage_rows_remaining: usage,
  };
}
