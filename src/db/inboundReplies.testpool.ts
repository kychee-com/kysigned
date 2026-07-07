/**
 * Shared in-memory DbPool for inbound_replies tests (DAO + reconciler).
 *
 * NOT a test file (`.testpool.ts`, not `.test.ts`) — it exports a helper, runs
 * no assertions, and is excluded from the `src/**\/*.test.ts` runner glob.
 *
 * Models the exact SQL shapes + param orders inboundReplies.ts emits. Timestamps
 * are ISO strings (as the production HttpDbPool returns TIMESTAMPTZ) so the DAO's
 * coercion is exercised.
 */
import type { DbPool } from './pool.js';

export function createInboundRepliesMemoryPool() {
  const rows: any[] = [];
  // 2F.SG.4: the reconciler membership gate reads envelopes + envelope_signers
  // via the same pool. Seed these for gate tests; empty by default (DAO tests
  // that don't touch the gate are unaffected).
  const envelopes: any[] = [];
  const signers: any[] = [];
  // Phase 7 wiring: the forward reconciler assembles signature_artifacts on `signed`.
  const signatureArtifacts: any[] = [];
  let seq = 0;
  const clone = (r: any) => ({ ...r });

  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      const v = (values ?? []) as any[];

      // scanReconcilerWork — the reconciler's single-call tick scan. Matched
      // FIRST: its SQL also contains 'completion_distributed_at IS NULL' and
      // 'FROM envelopes', which would otherwise hit the narrower branches
      // below. Returns the three aggregates pre-parsed (the production HTTP
      // gateway returns json columns parsed too — verified live 2026-06-10).
      if (text.includes('AS new_message_ids')) {
        const [messageIds, states, replyLimit, completionLimit] = v as [string[], string[], number, number];
        const newIds = messageIds.filter((id) => !rows.some((r) => r.message_id === id));
        const active = rows
          .filter((r) => states.includes(r.status))
          .sort(
            (a, b) =>
              states.indexOf(a.status) - states.indexOf(b.status) ||
              a.created_at.localeCompare(b.created_at),
          )
          .slice(0, replyLimit)
          .map(clone);
        const completion = envelopes
          .filter((e) => {
            if (e.completion_distributed_at != null) return false;
            if (e.status !== 'active' && e.status !== 'completed') return false;
            const es = signers.filter((s) => s.envelope_id === e.id);
            return es.length > 0 && es.every((s) => s.status === 'signed');
          })
          .map((e) => e.id)
          .slice(0, completionLimit);
        return {
          rows: [{ new_message_ids: newIds, active_replies: active, completion_envelope_ids: completion }],
          rowCount: 1,
        } as any;
      }

      // recordReceivedRepliesBatch — one INSERT ... unnest(...) ON CONFLICT
      // DO NOTHING RETURNING * for the whole batch. Matched before the
      // single-row INSERT branch (both contain 'INSERT INTO inbound_replies').
      if (text.includes('INSERT INTO inbound_replies') && text.includes('unnest')) {
        const [mailboxIds, messageIds] = v as [string[], string[]];
        const out: any[] = [];
        for (let i = 0; i < messageIds.length; i++) {
          if (rows.some((r) => r.message_id === messageIds[i])) continue;
          seq += 1;
          const now = new Date(1700000000000 + seq * 1000).toISOString();
          const row = {
            id: `ir-${seq}`,
            mailbox_id: mailboxIds[i],
            message_id: messageIds[i],
            envelope_id: null,
            signer_email: null,
            status: 'received',
            feedback: null,
            attempts: 0,
            last_error: null,
            created_at: now,
            updated_at: now,
          };
          rows.push(row);
          out.push(clone(row));
        }
        return { rows: out, rowCount: out.length } as any;
      }

      // recordReceivedReply — INSERT ... ON CONFLICT (message_id) DO NOTHING
      if (text.includes('INSERT INTO inbound_replies')) {
        const [mailboxId, messageId] = v;
        const existing = rows.find((r) => r.message_id === messageId);
        if (existing) return { rows: [], rowCount: 0 } as any;
        seq += 1;
        const now = new Date(1700000000000 + seq * 1000).toISOString();
        const row = {
          id: `ir-${seq}`,
          mailbox_id: mailboxId,
          message_id: messageId,
          envelope_id: null,
          signer_email: null,
          status: 'received',
          feedback: null,
          attempts: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        };
        rows.push(row);
        return { rows: [clone(row)], rowCount: 1 } as any;
      }

      // transition — UPDATE ... SET status=$1 ... WHERE id=$6 AND status=$7
      if (text.includes('UPDATE inbound_replies') && text.includes('SET status')) {
        const [to, envelopeId, signerEmail, feedback, lastError, id, from] = v;
        const row = rows.find((r) => r.id === id && r.status === from);
        if (!row) return { rows: [], rowCount: 0 } as any;
        row.status = to;
        if (envelopeId != null) row.envelope_id = envelopeId;
        if (signerEmail != null) row.signer_email = signerEmail;
        if (feedback != null) row.feedback = feedback;
        row.last_error = lastError ?? null;
        row.updated_at = new Date(1700000000000 + ++seq * 1000).toISOString();
        return { rows: [clone(row)], rowCount: 1 } as any;
      }

      // bumpAttempts — UPDATE ... SET attempts = attempts + 1, last_error = $1,
      // feedback = COALESCE($3, feedback) ... WHERE id = $2  (F3.3.9.8: $3 optional)
      if (text.includes('UPDATE inbound_replies') && text.includes('attempts = attempts + 1')) {
        const [lastError, id, feedback] = v;
        const row = rows.find((r) => r.id === id);
        if (!row) return { rows: [], rowCount: 0 } as any;
        row.attempts += 1;
        row.last_error = lastError ?? null;
        if (feedback != null) row.feedback = feedback; // COALESCE: keep existing when $3 is null
        row.updated_at = new Date(1700000000000 + ++seq * 1000).toISOString();
        return { rows: [clone(row)], rowCount: 1 } as any;
      }

      // 2F.SG.4 membership gate reads (matched BEFORE the generic inbound_replies
      // `WHERE id = $1` branch, since `FROM envelopes WHERE id = $1` contains it).
      if (text.includes('FROM envelopes WHERE id')) {
        const e = envelopes.find((x) => x.id === v[0]);
        return { rows: e ? [clone(e)] : [], rowCount: e ? 1 : 0 } as any;
      }
      // 2F.CD.5: getEnvelopesNeedingCompletion — all-signed but not yet distributed.
      if (text.includes('completion_distributed_at IS NULL') && text.includes('FROM envelopes')) {
        const all = envelopes
          .filter((e) => {
            if (e.completion_distributed_at != null) return false;
            if (e.status !== 'active' && e.status !== 'completed') return false;
            const es = signers.filter((s) => s.envelope_id === e.id);
            return es.length > 0 && es.every((s) => s.status === 'signed');
          })
          .map((e) => ({ id: e.id }));
        // Honor the LIMIT $1 param (v[0]) like the real DAO — the completion
        // backstop is bounded per tick (2F.CD.12) so a tick can't time out.
        const limit = typeof v[0] === 'number' ? v[0] : all.length;
        const out = all.slice(0, limit);
        return { rows: out, rowCount: out.length } as any;
      }
      if (text.includes('FROM envelope_signers WHERE envelope_id') && text.includes('LOWER(email)')) {
        const [envelopeId, email] = v;
        const s = signers.find(
          (x) => x.envelope_id === envelopeId && String(x.email).toLowerCase() === String(email).toLowerCase(),
        );
        return { rows: s ? [clone(s)] : [], rowCount: s ? 1 : 0 } as any;
      }
      // 2F.CD.1: markSignerSignedByEmail — flip signer by envelope_id + email (idempotent).
      if (text.includes('UPDATE envelope_signers') && text.includes("status = 'signed'") && text.includes('LOWER(email)')) {
        const [envelopeId, email] = v;
        const s = signers.find(
          (x) => x.envelope_id === envelopeId &&
            String(x.email).toLowerCase() === String(email).toLowerCase() &&
            x.status !== 'signed',
        );
        if (s) {
          s.status = 'signed'; s.signed_at = new Date(); s.signing_method = 'email';
          return { rows: [{ id: s.id }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      }
      // 2F.CD.2: checkAllSigned — COUNT total + signed for an envelope's signers.
      if (text.includes('COUNT(*)') && text.includes('envelope_signers')) {
        const es = signers.filter((x) => x.envelope_id === v[0]);
        return {
          rows: [{ total: String(es.length), signed: String(es.filter((x) => x.status === 'signed').length) }],
          rowCount: 1,
        } as any;
      }

      // priorTerminalNoteExists (2F.SG.3) — prior (envelope, signer) row carrying this exact note text.
      if (text.includes('LOWER(signer_email)') && text.includes('feedback =')) {
        const [envelopeId, signerEmail, feedback] = v;
        const match = rows.find(
          (r) =>
            r.envelope_id === envelopeId &&
            r.signer_email != null &&
            String(r.signer_email).toLowerCase() === String(signerEmail).toLowerCase() &&
            r.feedback === feedback,
        );
        return { rows: match ? [{ exists: 1 }] : [], rowCount: match ? 1 : 0 } as any;
      }

      if (text.includes('WHERE message_id = $1')) {
        const row = rows.find((r) => r.message_id === v[0]);
        return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 } as any;
      }
      if (text.includes('WHERE id = $1')) {
        const row = rows.find((r) => r.id === v[0]);
        return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 } as any;
      }
      if (text.includes('WHERE status = $1')) {
        const [status, limit] = v;
        const matching = rows
          .filter((r) => r.status === status)
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .slice(0, limit)
          .map(clone);
        return { rows: matching, rowCount: matching.length } as any;
      }

      // ── signature_artifacts (Phase 7 timestamp wiring) ──────────────────────
      if (text.includes('INSERT INTO signature_artifacts')) {
        const [envelope_id, signer_email, message_id, sha256_eml, spf, dkimv, dmarcv,
          dkim_domain, dkim_selector, dkim_key, dkim_observed_at,
          ots_proof, tsa_token, key_obs_proof, archive_status, ts_status] = v;
        const conflict = signatureArtifacts.find(
          (r) => r.envelope_id === envelope_id &&
            String(r.signer_email).toLowerCase() === String(signer_email).toLowerCase(),
        );
        if (conflict) return { rows: [], rowCount: 0 } as any;
        seq += 1;
        const now = new Date(1700000000000 + seq * 1000).toISOString();
        const row = {
          id: `sa-${seq}`, envelope_id, signer_email, message_id: message_id ?? null, sha256_eml,
          spf_verdict: spf ?? null, dkim_verdict: dkimv ?? null, dmarc_verdict: dmarcv ?? null,
          dkim_domain: dkim_domain ?? null, dkim_selector: dkim_selector ?? null, dkim_key: dkim_key ?? null,
          dkim_observed_at: dkim_observed_at ?? null,
          ots_proof: ots_proof ?? null, tsa_token: tsa_token ?? null, key_obs_proof: key_obs_proof ?? null,
          archive_status: archive_status ?? null, ts_status: ts_status ?? 'pending',
          created_at: now, updated_at: now,
        };
        signatureArtifacts.push(row);
        return { rows: [clone(row)], rowCount: 1 } as any;
      }
      if (text.includes('SELECT * FROM signature_artifacts') && text.includes('LOWER(signer_email)')) {
        const [envelope_id, signer_email] = v;
        const r = signatureArtifacts.find(
          (x) => x.envelope_id === envelope_id &&
            String(x.signer_email).toLowerCase() === String(signer_email).toLowerCase(),
        );
        return { rows: r ? [clone(r)] : [], rowCount: r ? 1 : 0 } as any;
      }
      if (text.includes('FROM signature_artifacts') && text.includes("ts_status = 'pending'")) {
        const [limit] = v;
        const out = signatureArtifacts
          .filter((r) => r.ts_status === 'pending')
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .slice(0, typeof limit === 'number' ? limit : signatureArtifacts.length)
          .map(clone);
        return { rows: out, rowCount: out.length } as any;
      }
      if (text.includes('UPDATE signature_artifacts')) {
        const [id, ots_proof, key_obs_proof, ts_status] = v;
        const r = signatureArtifacts.find((x) => x.id === id);
        if (!r) return { rows: [], rowCount: 0 } as any;
        if (ots_proof != null) r.ots_proof = ots_proof;
        if (key_obs_proof != null) r.key_obs_proof = key_obs_proof;
        if (ts_status != null) r.ts_status = ts_status;
        r.updated_at = new Date(1700000000000 + ++seq * 1000).toISOString();
        return { rows: [clone(r)], rowCount: 1 } as any;
      }

      return { rows: [], rowCount: 0 } as any;
    },
    async end() {},
  };

  return { pool, rows, envelopes, signers, signatureArtifacts };
}
