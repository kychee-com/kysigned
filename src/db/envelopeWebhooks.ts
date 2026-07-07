/**
 * envelopeWebhooks — the creator-supplied completion webhook per envelope
 * (spec F-30.3 / AC-138). One row per envelope: the callback URL + the
 * signing secret whose raw value is returned exactly once in the create
 * response. PK envelope_id, FK ON DELETE CASCADE — the webhook (and its
 * secret) dies with its envelope, consistent with F-9 retention.
 *
 * Runs over run402's HTTP SQL (HttpDbPool) in prod; TIMESTAMPTZ arrives as
 * ISO strings — rehydrate at this boundary.
 */
import type { DbPool } from './pool.js';

export interface EnvelopeWebhookRow {
  envelope_id: string;
  url: string;
  secret: string;
  created_at: Date;
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

export interface SetEnvelopeWebhookInput {
  envelopeId: string;
  url: string;
  secret: string;
}

export async function setEnvelopeWebhook(pool: DbPool, w: SetEnvelopeWebhookInput): Promise<void> {
  await pool.query(
    `INSERT INTO envelope_webhooks (envelope_id, url, secret)
     VALUES ($1, $2, $3)`,
    [w.envelopeId, w.url, w.secret],
  );
}

export async function getEnvelopeWebhook(pool: DbPool, envelopeId: string): Promise<EnvelopeWebhookRow | null> {
  const res = await pool.query(
    `SELECT * FROM envelope_webhooks WHERE envelope_id = $1`,
    [envelopeId],
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    envelope_id: String(row.envelope_id),
    url: String(row.url),
    secret: String(row.secret),
    created_at: toDate(row.created_at),
  };
}
