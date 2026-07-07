/**
 * DKIM public-key archive client — F-6.7 / AC-60 (spec v0.4.0).
 *
 * At signing time, while the signer's provider DKIM key is still live in DNS,
 * kysigned locks in an INDEPENDENT, third-party, timestamped record of that key by
 * checking the public DKIM archive (archive.prove.email, a public archive of
 * ~1M keys, witness.co-timestamped) and contributing the key if it is absent. This
 * is what lets a verifier confirm the key's authenticity decades later even after
 * the provider rotates it — critical for custom-domain signers the archive's
 * top-million crawl never covered.
 *
 * Proven end-to-end 2026-06-13 (the operator's DKIM-archive research note):
 *   - lookup:     GET  /api/key/domain?domain=<d>&selector=<s>  → the full record
 *   - contribute: POST /api/dsp  {domain, selector}  → 201 {addResult:{added:true}}
 *                 (idempotent re-POST → 200 {already_in_db:true, added:false})
 * No auth; rate limit 1200 req / 10 min; the server DNS-fetches + timestamps.
 *
 * **Outage non-blocking (AC-60):** contribution is best-effort and additive (DKIM
 * public keys are already world-readable in DNS). A temporary archive outage NEVER
 * blocks signing — `ensureKeyArchived` never throws; the operator's own timestamped
 * observed-key record (F-6.7, see Phase 7.1) stands regardless and contribution
 * retries while the key remains in DNS.
 */

const DEFAULT_BASE_URL = 'https://archive.prove.email';

export interface DkimArchiveDeps {
  /** Injectable fetch (default: global fetch) — tests pass a fake, no network. */
  fetchFn?: typeof fetch;
  /** Archive base URL (default https://archive.prove.email). */
  baseUrl?: string;
  /**
   * Lookup path (default `/api/key/domain`). The WEB verifier sets `baseUrl: ''` +
   * `path: '/v1/key-archive'` so the browser calls the operator's SAME-ORIGIN proxy
   * (the archive serves no CORS headers); the CLI uses the direct default (F-10.8).
   */
  path?: string;
}

export interface ArchiveKeyRecord {
  domain: string;
  selector: string;
  /** The DKIM TXT value, e.g. "v=DKIM1; k=rsa; p=...". */
  value: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface ArchiveLookupResult {
  found: boolean;
  records: ArchiveKeyRecord[];
}

export interface ContributeResult {
  /** The POST returned a success status (200 or 201). */
  ok: boolean;
  /** A new record was added by this call (HTTP 201). */
  added: boolean;
  /** The pair was already archived (idempotent HTTP 200). */
  alreadyPresent: boolean;
  status: number;
}

export interface EnsureArchivedResult {
  /** The (domain, selector) is in the archive (already, or contributed this call). */
  archived: boolean;
  /** We contributed it on this call (it was absent). */
  contributed: boolean;
  /** The archive was unreachable/errored — signing must NOT block (AC-60). */
  outage: boolean;
  /** Records found on lookup (if any). */
  records: ArchiveKeyRecord[];
  /** Diagnostic detail for the audit log. */
  detail?: string;
}

function resolveFetch(deps?: DkimArchiveDeps): typeof fetch {
  const f = deps?.fetchFn ?? (globalThis.fetch as typeof fetch | undefined);
  if (!f) throw new Error('dkimArchive: no fetch available (provide deps.fetchFn)');
  return f;
}

/** Coerce the archive's lookup body (single record | array | {records}) into a record list. */
function normalizeRecords(body: unknown): ArchiveKeyRecord[] {
  if (Array.isArray(body)) {
    return body.filter((r): r is ArchiveKeyRecord => !!r && typeof r === 'object' && 'value' in r);
  }
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.records)) {
      return (obj.records as unknown[]).filter(
        (r): r is ArchiveKeyRecord => !!r && typeof r === 'object' && 'value' in (r as object),
      );
    }
    if (typeof obj.value === 'string' && typeof obj.domain === 'string') {
      return [obj as unknown as ArchiveKeyRecord];
    }
  }
  return [];
}

export async function lookupArchivedKey(
  domain: string,
  selector: string,
  deps?: DkimArchiveDeps,
): Promise<ArchiveLookupResult> {
  const base = deps?.baseUrl ?? DEFAULT_BASE_URL;
  const path = deps?.path ?? '/api/key/domain';
  const url = `${base}${path}?domain=${encodeURIComponent(domain)}&selector=${encodeURIComponent(selector)}`;
  const res = await resolveFetch(deps)(url);
  if (!res.ok) {
    // 404 = definitively absent; other non-2xx = surface as an error (→ outage upstream).
    if (res.status === 404) return { found: false, records: [] };
    throw new Error(`archive lookup failed: HTTP ${res.status}`);
  }
  const records = normalizeRecords(await res.json().catch(() => null));
  return { found: records.length > 0, records };
}

export async function contributeKey(
  domain: string,
  selector: string,
  deps?: DkimArchiveDeps,
): Promise<ContributeResult> {
  const base = deps?.baseUrl ?? DEFAULT_BASE_URL;
  const res = await resolveFetch(deps)(`${base}/api/dsp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain, selector }),
  });
  const ok = res.status === 200 || res.status === 201;
  if (!ok) {
    return { ok: false, added: false, alreadyPresent: false, status: res.status };
  }
  // 201 → {addResult:{added:true,...}} ; 200 re-POST → {already_in_db:true,added:false}.
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const result = (body.addResult ?? body) as Record<string, unknown>;
  return {
    ok: true,
    added: result.added === true,
    alreadyPresent: result.already_in_db === true,
    status: res.status,
  };
}

export async function ensureKeyArchived(
  domain: string,
  selector: string,
  deps?: DkimArchiveDeps,
): Promise<EnsureArchivedResult> {
  // AC-60: this NEVER throws — a temporary archive outage must not block signing.
  try {
    const lookup = await lookupArchivedKey(domain, selector, deps);
    if (lookup.found) {
      return { archived: true, contributed: false, outage: false, records: lookup.records };
    }
    const contribution = await contributeKey(domain, selector, deps);
    if (contribution.ok) {
      // Trust the POST result (the idempotent re-POST confirms storage); the broad
      // read path can lag, so we do NOT re-GET to verify (would false-negative).
      return {
        archived: true,
        contributed: contribution.added,
        outage: false,
        records: [],
        detail: contribution.alreadyPresent ? 'already_in_db (race)' : 'contributed',
      };
    }
    return {
      archived: false,
      contributed: false,
      outage: true,
      records: [],
      detail: `contribute failed: HTTP ${contribution.status}`,
    };
  } catch (err) {
    return {
      archived: false,
      contributed: false,
      outage: true,
      records: [],
      detail: `archive unreachable: ${(err as Error).message}`,
    };
  }
}
