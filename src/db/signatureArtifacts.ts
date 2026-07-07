/**
 * signature_artifacts DAO — F-6.5/6.6/6.7 (migration 020).
 *
 * The durable evidence record assembled at receipt, one row per signed signer.
 * Created idempotently by the forward reconciler on a `signed` outcome (Phase 7
 * wiring), read by the bundle assembler (Phase 9), and advanced pending→complete
 * by the OTS-upgrade reconciler.
 *
 * JSONB proof columns follow the repo convention: `JSON.stringify` on write + a
 * `::jsonb` cast in SQL; on read we coerce object-or-string (node-pg returns JSON
 * columns as parsed objects; a stringified form from HttpDbPool is tolerated).
 */
import type { DbPool } from './pool.js';
import type { SignatureArtifact, CreateSignatureArtifactInput } from './types.js';
import type { TimestampProof } from '../timestamp/contract.js';

function coerceDate(v: unknown): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v as string);
}

function coerceProof(v: unknown): TimestampProof | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as TimestampProof;
    } catch {
      return null;
    }
  }
  return v as TimestampProof;
}

/** Serialize a proof envelope for a `::jsonb` param (null stays null). */
function jsonParam(v: unknown): string | null {
  return v == null ? null : JSON.stringify(v);
}

type Row = Record<string, unknown>;

function mapRow(r: Row): SignatureArtifact {
  return {
    id: String(r.id),
    envelope_id: String(r.envelope_id),
    signer_email: String(r.signer_email),
    message_id: (r.message_id as string | null) ?? null,
    sha256_eml: String(r.sha256_eml),
    spf_verdict: (r.spf_verdict as string | null) ?? null,
    dkim_verdict: (r.dkim_verdict as string | null) ?? null,
    dmarc_verdict: (r.dmarc_verdict as string | null) ?? null,
    dkim_domain: (r.dkim_domain as string | null) ?? null,
    dkim_selector: (r.dkim_selector as string | null) ?? null,
    dkim_key: (r.dkim_key as string | null) ?? null,
    dkim_observed_at: coerceDate(r.dkim_observed_at),
    ots_proof: coerceProof(r.ots_proof),
    tsa_token: coerceProof(r.tsa_token),
    key_obs_proof: coerceProof(r.key_obs_proof),
    archive_status: (r.archive_status as string | null) ?? null,
    ts_status: r.ts_status as 'pending' | 'complete',
    created_at: coerceDate(r.created_at) ?? new Date(0),
    updated_at: coerceDate(r.updated_at) ?? new Date(0),
  };
}

/**
 * Create the artifact for a signed signer, idempotently. A duplicate forward (or a
 * racing reconciler) does NOT overwrite — `ON CONFLICT (envelope_id, signer_email)
 * DO NOTHING` keeps the first assembly. Returns `{ created: false }` with the
 * existing row in that case.
 */
export async function upsertSignatureArtifact(
  pool: DbPool,
  input: CreateSignatureArtifactInput,
): Promise<{ artifact: SignatureArtifact; created: boolean }> {
  const res = await pool.query(
    `INSERT INTO signature_artifacts
       (envelope_id, signer_email, message_id, sha256_eml,
        spf_verdict, dkim_verdict, dmarc_verdict,
        dkim_domain, dkim_selector, dkim_key, dkim_observed_at,
        ots_proof, tsa_token, key_obs_proof, archive_status, ts_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             $12::jsonb,$13::jsonb,$14::jsonb,$15,COALESCE($16,'pending'))
     ON CONFLICT (envelope_id, signer_email) DO NOTHING
     RETURNING *`,
    [
      input.envelope_id, input.signer_email, input.message_id ?? null, input.sha256_eml,
      input.spf_verdict ?? null, input.dkim_verdict ?? null, input.dmarc_verdict ?? null,
      input.dkim_domain ?? null, input.dkim_selector ?? null, input.dkim_key ?? null,
      input.dkim_observed_at ?? null,
      jsonParam(input.ots_proof), jsonParam(input.tsa_token), jsonParam(input.key_obs_proof),
      input.archive_status ?? null, input.ts_status ?? null,
    ],
  );
  if (res.rows.length > 0) {
    return { artifact: mapRow(res.rows[0] as Row), created: true };
  }
  const existing = await getSignatureArtifact(pool, input.envelope_id, input.signer_email);
  if (!existing) {
    throw new Error('upsertSignatureArtifact: ON CONFLICT but row not found');
  }
  return { artifact: existing, created: false };
}

export async function getSignatureArtifact(
  pool: DbPool,
  envelopeId: string,
  signerEmail: string,
): Promise<SignatureArtifact | null> {
  const res = await pool.query(
    `SELECT * FROM signature_artifacts WHERE envelope_id = $1 AND LOWER(signer_email) = LOWER($2)`,
    [envelopeId, signerEmail],
  );
  return res.rows.length ? mapRow(res.rows[0] as Row) : null;
}

/** Load one artifact by id — the F-29 `timestamp_upgrade` self-rescheduling run
 *  re-reads its artifact each attempt to check whether it's still `pending`. */
export async function getSignatureArtifactById(
  pool: DbPool,
  id: string,
): Promise<SignatureArtifact | null> {
  const res = await pool.query(`SELECT * FROM signature_artifacts WHERE id = $1`, [id]);
  return res.rows.length ? mapRow(res.rows[0] as Row) : null;
}

/** All artifacts for an envelope (one per signed signer) — the dashboard evidence join (F-11). */
export async function listEnvelopeSignatureArtifacts(
  pool: DbPool,
  envelopeId: string,
): Promise<SignatureArtifact[]> {
  const res = await pool.query(
    `SELECT * FROM signature_artifacts WHERE envelope_id = $1`,
    [envelopeId],
  );
  return (res.rows as Row[]).map(mapRow);
}

/** Pending-OTS artifacts (oldest first) for the upgrade reconciler. */
export async function listPendingTimestampArtifacts(
  pool: DbPool,
  limit: number,
): Promise<SignatureArtifact[]> {
  const res = await pool.query(
    `SELECT * FROM signature_artifacts WHERE ts_status = 'pending' ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return (res.rows as Row[]).map(mapRow);
}

export interface ArtifactTimestampUpdate {
  otsProof?: TimestampProof;
  keyObsProof?: TimestampProof;
  tsStatus?: 'pending' | 'complete';
}

/** Advance an artifact's timestamps (the OTS-upgrade reconciler: pending → complete). */
export async function updateArtifactTimestamps(
  pool: DbPool,
  id: string,
  update: ArtifactTimestampUpdate,
): Promise<SignatureArtifact | null> {
  const res = await pool.query(
    `UPDATE signature_artifacts
       SET ots_proof = COALESCE($2::jsonb, ots_proof),
           key_obs_proof = COALESCE($3::jsonb, key_obs_proof),
           ts_status = COALESCE($4, ts_status),
           updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, jsonParam(update.otsProof), jsonParam(update.keyObsProof), update.tsStatus ?? null],
  );
  return res.rows.length ? mapRow(res.rows[0] as Row) : null;
}
