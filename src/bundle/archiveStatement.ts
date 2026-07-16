/**
 * archiveStatement.ts (F-32.8 / AC-167, zkemail/archive#46) — verify a signed DKIM
 * archive observation statement.
 *
 * The consuming half of the signed-observation format kysigned proposed upstream,
 * built ahead of the archive's implementation so the format is executable and interop
 * testing can start now. A statement is a compact JWS whose payload attests one
 * archive record (domain, selector, key value, source, first/last-seen) as of an
 * issuance time. This module verifies the signature against the archive's pinned
 * verification keys and returns the parsed record, or a distinct machine-readable
 * reason on any failure.
 *
 * **Browser-safe:** `jose` is isomorphic (Web Crypto under the hood) and this module
 * uses no Node-only API — so the same verifier runs in the /verify SPA and the CLI
 * when the statement is embedded in a bundle (the post-format-agreement integration).
 * A source guard in the test pins the no-Node-API property.
 *
 * **Not wired into any flow yet** — this is a standalone, fully-tested library
 * component (the `verifyWeb`-before-pages pattern). Signing lives ONLY in tests /
 * the reference-vector generator; kysigned never signs statements.
 */
import { compactVerify, importJWK, decodeProtectedHeader, type JWK } from 'jose';

/** The archive's published verification keys (a JWKS; each key carries a `kid`). */
export interface ArchiveJwks {
  keys: Array<JWK & { kid?: string }>;
}

export type ArchiveSource = 'live_dns' | 'gcd_recovered';

/** The parsed record, normalized to kysigned's internal camelCase shape. */
export interface ArchiveStatementRecord {
  /** Optional opaque archive record id. */
  id?: string;
  domain: string;
  selector: string;
  /** The DKIM TXT value as stored (`v=DKIM1; k=rsa; p=…`). */
  value: string;
  source: ArchiveSource;
  /** RFC 3339 UTC (verbatim from the statement). */
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Distinct, machine-readable reject classes (fail-closed). */
export type ArchiveStatementReject =
  | 'malformed-jws' // not a parseable compact JWS
  | 'unsupported-alg' // header alg outside {EdDSA, ES256} (blocks alg-none / HS-confusion)
  | 'unknown-key' // header kid absent from the pinned JWKS
  | 'bad-signature' // signature did not verify (tampered payload, or wrong key)
  | 'malformed-shape'; // signature ok, payload fails the statement schema

export type ArchiveStatementResult =
  | { ok: true; record: ArchiveStatementRecord; iat: number; kid: string }
  | { ok: false; reason: ArchiveStatementReject };

/** Algorithms we accept — EdDSA (asked-for) and ES256 (offered alternative). Nothing else. */
const ALLOWED_ALGS = new Set(['EdDSA', 'ES256']);

/** RFC 3339 UTC with a `Z` zone (what we asked the archive to emit). */
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isRfc3339Utc(v: unknown): v is string {
  return typeof v === 'string' && RFC3339_UTC.test(v) && !Number.isNaN(Date.parse(v));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Validate the decoded payload against the statement schema; null when malformed. */
function parseStatement(payload: unknown): { record: ArchiveStatementRecord; iat: number } | null {
  if (!payload || typeof payload !== 'object') return null;
  const s = payload as Record<string, unknown>;
  if (s.v !== 1) return null;
  if (s.iss !== 'archive.prove.email') return null;
  if (typeof s.iat !== 'number' || !Number.isInteger(s.iat)) return null;
  if (!s.record || typeof s.record !== 'object') return null;
  const r = s.record as Record<string, unknown>;
  if (!isNonEmptyString(r.domain) || !isNonEmptyString(r.selector) || !isNonEmptyString(r.value)) return null;
  if (r.source !== 'live_dns' && r.source !== 'gcd_recovered') return null;
  if (!isRfc3339Utc(r.first_seen_at) || !isRfc3339Utc(r.last_seen_at)) return null;
  if (r.id !== undefined && !isNonEmptyString(r.id)) return null;
  const record: ArchiveStatementRecord = {
    domain: r.domain.toLowerCase(),
    selector: r.selector.toLowerCase(),
    value: r.value,
    source: r.source,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  };
  if (typeof r.id === 'string') record.id = r.id;
  return { record, iat: s.iat };
}

/**
 * Verify one compact-JWS archive statement against the pinned archive JWKS. Never
 * throws; returns `{ ok: true, record, iat, kid }` or `{ ok: false, reason }`.
 */
export async function verifyArchiveStatement(
  jws: string,
  jwks: ArchiveJwks,
): Promise<ArchiveStatementResult> {
  // 1. Structure + protected header (alg/kid) without trusting the signature yet.
  let header: { alg?: string; kid?: string };
  if (typeof jws !== 'string' || jws.split('.').length !== 3) {
    return { ok: false, reason: 'malformed-jws' };
  }
  try {
    header = decodeProtectedHeader(jws);
  } catch {
    return { ok: false, reason: 'malformed-jws' };
  }

  // 2. Algorithm allowlist — refuse alg-none / HS-confusion before any key work.
  if (!header.alg || !ALLOWED_ALGS.has(header.alg)) {
    return { ok: false, reason: 'unsupported-alg' };
  }

  // 3. Resolve the pinned key by kid (never trust an embedded key).
  const jwk = header.kid ? jwks.keys.find((k) => k.kid === header.kid) : undefined;
  if (!jwk) return { ok: false, reason: 'unknown-key' };

  // 4. Verify the signature, constraining the alg to the header's allowed value.
  let payloadBytes: Uint8Array;
  try {
    const key = await importJWK(jwk, header.alg);
    const res = await compactVerify(jws, key, { algorithms: [header.alg] });
    payloadBytes = res.payload;
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }

  // 5. Parse + schema-validate the now-authenticated payload.
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'malformed-shape' };
  }
  const parsed = parseStatement(payload);
  if (!parsed) return { ok: false, reason: 'malformed-shape' };

  return { ok: true, record: parsed.record, iat: parsed.iat, kid: header.kid! };
}
