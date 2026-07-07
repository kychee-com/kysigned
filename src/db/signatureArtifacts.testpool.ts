/**
 * Shared in-memory DbPool for signature_artifacts tests (DAO + reconciler wiring).
 *
 * NOT a test file (`.testpool.ts`) — exports a helper, runs no assertions, excluded
 * from the test runner glob. Models the exact SQL shapes signatureArtifacts.ts
 * emits. JSONB params arrive as JSON strings (the DAO `JSON.stringify`s them); they
 * are stored as-is and the DAO's `coerceProof` parses them on read.
 */
import type { DbPool } from './pool.js';

export function createSignatureArtifactsMemoryPool() {
  const rows: any[] = [];
  let seq = 0;
  const clone = (r: any) => ({ ...r });

  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];

      // upsertSignatureArtifact — INSERT ... ON CONFLICT (envelope_id, signer_email) DO NOTHING
      if (text.includes('INSERT INTO signature_artifacts')) {
        const [
          envelope_id, signer_email, message_id, sha256_eml,
          spf_verdict, dkim_verdict, dmarc_verdict,
          dkim_domain, dkim_selector, dkim_key, dkim_observed_at,
          ots_proof, tsa_token, key_obs_proof, archive_status, ts_status,
        ] = v;
        const conflict = rows.find(
          (r) => r.envelope_id === envelope_id &&
            String(r.signer_email).toLowerCase() === String(signer_email).toLowerCase(),
        );
        if (conflict) return { rows: [], rowCount: 0 } as any; // DO NOTHING
        seq += 1;
        const now = new Date(1700000000000 + seq * 1000).toISOString();
        const row = {
          id: `sa-${seq}`, envelope_id, signer_email,
          message_id: message_id ?? null, sha256_eml,
          spf_verdict: spf_verdict ?? null, dkim_verdict: dkim_verdict ?? null, dmarc_verdict: dmarc_verdict ?? null,
          dkim_domain: dkim_domain ?? null, dkim_selector: dkim_selector ?? null, dkim_key: dkim_key ?? null,
          dkim_observed_at: dkim_observed_at ?? null,
          ots_proof: ots_proof ?? null, tsa_token: tsa_token ?? null, key_obs_proof: key_obs_proof ?? null,
          archive_status: archive_status ?? null,
          ts_status: ts_status ?? 'pending',
          created_at: now, updated_at: now,
        };
        rows.push(row);
        return { rows: [clone(row)], rowCount: 1 } as any;
      }

      // getSignatureArtifact — SELECT ... WHERE envelope_id AND LOWER(signer_email)
      if (text.includes('SELECT * FROM signature_artifacts') && text.includes('LOWER(signer_email)')) {
        const [envelope_id, signer_email] = v;
        const r = rows.find(
          (x) => x.envelope_id === envelope_id &&
            String(x.signer_email).toLowerCase() === String(signer_email).toLowerCase(),
        );
        return { rows: r ? [clone(r)] : [], rowCount: r ? 1 : 0 } as any;
      }

      // listPendingTimestampArtifacts — WHERE ts_status = 'pending' ORDER BY created_at LIMIT
      if (text.includes("ts_status = 'pending'")) {
        const [limit] = v;
        const out = rows
          .filter((r) => r.ts_status === 'pending')
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .slice(0, typeof limit === 'number' ? limit : rows.length)
          .map(clone);
        return { rows: out, rowCount: out.length } as any;
      }

      // updateArtifactTimestamps — UPDATE ... WHERE id RETURNING *
      if (text.includes('UPDATE signature_artifacts')) {
        const [id, ots_proof, key_obs_proof, ts_status] = v;
        const r = rows.find((x) => x.id === id);
        if (!r) return { rows: [], rowCount: 0 } as any;
        if (ots_proof != null) r.ots_proof = ots_proof;       // COALESCE: keep when null
        if (key_obs_proof != null) r.key_obs_proof = key_obs_proof;
        if (ts_status != null) r.ts_status = ts_status;
        r.updated_at = new Date(1700000000000 + ++seq * 1000).toISOString();
        return { rows: [clone(r)], rowCount: 1 } as any;
      }

      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };

  return { pool, rows };
}
