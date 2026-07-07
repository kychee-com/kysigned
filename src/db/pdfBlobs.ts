/**
 * pdfBlobs — PostgreSQL-backed PDF storage.
 *
 * Schema: pdf_blobs(storage_key PK, bytes_b64 TEXT, byte_count, created_at)
 * — bytes stored base64-encoded TEXT per migration 009. BYTEA was tried in
 * migration 008 but doesn't round-trip through run402's HTTP DB layer
 * (Buffer params JSON-stringify to `{type:"Buffer",data:[...]}` which gets
 * stored as the literal bytes of that JSON string).
 *
 * Keyed by storage_key (caller-supplied — typically derived from document
 * hash via `envelopes/${hash}/original.pdf`). Same key = same bytes,
 * idempotent on conflict. Reads return null if the row doesn't exist.
 *
 * Lives in the public kysigned package so the signing handlers in
 * envelope.ts can call it directly without the operator's private adapter
 * layer needing PDF-specific code.
 */
import type { DbPool } from './pool.js';

export async function storePdfBlob(
  pool: DbPool,
  storageKey: string,
  bytes: Uint8Array,
): Promise<void> {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const b64 = buf.toString('base64');
  await pool.query(
    `INSERT INTO pdf_blobs (storage_key, bytes_b64, byte_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (storage_key) DO NOTHING`,
    [storageKey, b64, buf.length],
  );
}

export async function getPdfBlob(
  pool: DbPool,
  storageKey: string,
): Promise<Uint8Array | null> {
  const result = await pool.query(
    `SELECT bytes_b64 FROM pdf_blobs WHERE storage_key = $1`,
    [storageKey],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as { bytes_b64: string };
  if (typeof row.bytes_b64 !== 'string') return null;
  return new Uint8Array(Buffer.from(row.bytes_b64, 'base64'));
}

export async function deletePdfBlob(pool: DbPool, storageKey: string): Promise<void> {
  await pool.query(`DELETE FROM pdf_blobs WHERE storage_key = $1`, [storageKey]);
}
