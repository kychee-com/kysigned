/**
 * DKIM public-key archive client — F-6.7 / AC-60 (spec v0.4.0).
 *
 * At signing time, while the signer's provider DKIM key is still live in DNS,
 * kysigned locks in an INDEPENDENT, third-party record of that key by checking the
 * public DKIM archive (archive.prove.email, a public archive of ~1M keys that
 * DNS-fetches each key itself) and contributing the key if it is absent. This is
 * what lets a verifier confirm the key's authenticity decades later even after
 * the provider rotates it — critical for custom-domain signers the archive's
 * top-million crawl never covered.
 *
 * The archive's records are server-trusted plain JSON: it runs NO on-chain/witness
 * timestamping (that path was dropped in its rebuild — confirmed by the archive team
 * 2026-07-15, zkemail/archive#46). Never describe its records as chain-anchored. The
 * operator therefore anchors its OWN observed-key record with TSA + OpenTimestamps
 * (F-6.7.1 / AC-169), and the offline-durable path (OQ17) is a signed archive
 * statement that kysigned time-anchors itself (verifier: bundle/archiveStatement.ts).
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

/** One per-channel observation window (the archive's 2026-08 shape; camelCase). */
export interface ArchiveObservation {
  /** 'live_dns' | 'gcd_recovered' (unknown values tolerated, never counted live). */
  source?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface ArchiveKeyRecord {
  domain: string;
  selector: string;
  /** The DKIM TXT value, e.g. "v=DKIM1; k=rsa; p=...". */
  value: string;
  /** Numeric in /api/key JSON (a string inside signed statements — compare as strings). */
  id?: number | string;
  /**
   * Top-level times are SINGLE-CHANNEL since the archive's 2026-08 rework (the
   * live-DNS window where one exists, else the GCD window) — they are no longer a
   * cross-channel union. Use `liveLastSeenAt` for the F-32.4 window input.
   */
  firstSeenAt?: string;
  lastSeenAt?: string;
  /** Per-channel windows; absent only on pre-2026-08 fixtures/caches. */
  observations?: ArchiveObservation[];
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

/**
 * The base64 `p=` public key from a DKIM TXT value (`v=DKIM1; k=rsa; p=<b64>`) or a
 * bare `p=<b64>`, whitespace-stripped. THE canonical key comparison for both the
 * verifier's provenance gate (confirmKeyArchive) and the receipt-time parity check
 * (confirmKeyAtSigning) — one predicate, shared (F-32.6 / DD-36).
 */
export function extractPublicKey(value: string | null | undefined): string {
  if (!value) return '';
  const m = /p=([^;]*)/i.exec(value);
  return (m ? m[1] : '').replace(/\s+/g, '');
}

/** The record's usable last-seen (falls back to first-seen), channel-blind. */
export function usableLastSeenAt(record: ArchiveKeyRecord): string | null {
  return record.lastSeenAt ?? record.firstSeenAt ?? null;
}

/**
 * The record's last-observed-LIVE time — THE F-32.4 window input (#147 option A,
 * spec 0.71.0): only the `live_dns` observation channel bounds validity; a record
 * the archive knows only through key recovery has NO usable live window (null →
 * the dimension goes inconclusive / receipt goes unconfirmed, never confirmed).
 * When `observations` is absent entirely (pre-2026-08 fixtures or a cached shape)
 * the single-channel top-level times stand in — the production API always carries
 * `observations` today (interop-probed 2026-08-14).
 */
export function liveLastSeenAt(record: ArchiveKeyRecord): string | null {
  if (Array.isArray(record.observations)) {
    let best: string | null = null;
    for (const o of record.observations) {
      if (!o || o.source !== 'live_dns') continue;
      const t = o.lastSeenAt ?? o.firstSeenAt ?? null;
      if (t && (best === null || t > best)) best = t;
    }
    return best;
  }
  return usableLastSeenAt(record);
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
    // `value` alone qualifies: the 2026-08 single-record shape leads with `id` and
    // the key comparison never reads `domain` off the record — requiring a top-level
    // domain made a shape tweak silently normalize to [] (found:false), the
    // fails-soft-and-invisible failure mode.
    if (typeof obj.value === 'string') {
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

export interface StatementFetchResult {
  /** Compact-JWS strings exactly as served — the archive freshly signs per request. */
  statements: string[];
  /** HTTP status of the final attempt; null when the fetch itself threw. */
  status: number | null;
  /** Retriable-later signal (429 after the one retry, 5xx, network) — the F-32.10 wait path re-attempts. */
  outage: boolean;
}

/**
 * Fetch the archive's signed observation statements for a pair (F-32.9,
 * zkemail/archive#46): `GET /api/key/statement?domain=&selector=` → array of
 * compact JWS. A GCD-only pair legitimately returns `200 []` (only live-DNS
 * observations are signed — their signature IS the live-only filter). The
 * endpoint rate-limits bursts, so one bounded Retry-After retry (clamped ≤5s)
 * is honored; anything still failing reports `outage` for the wait-path retry
 * cadence rather than hammering. Never throws.
 */
export async function fetchArchiveStatements(
  domain: string,
  selector: string,
  deps?: DkimArchiveDeps,
): Promise<StatementFetchResult> {
  const base = deps?.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${base}/api/key/statement?domain=${encodeURIComponent(domain)}&selector=${encodeURIComponent(selector)}`;
  try {
    const f = resolveFetch(deps);
    let res = await f(url);
    if (res.status === 429) {
      const ra = Number(res.headers?.get?.('retry-after') ?? '2');
      const waitMs = Math.min(Math.max(Number.isFinite(ra) ? ra : 2, 0), 5) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      res = await f(url);
    }
    if (res.status !== 200) {
      return { statements: [], status: res.status, outage: res.status === 429 || res.status >= 500 };
    }
    const body = (await res.json().catch(() => null)) as unknown;
    const statements = Array.isArray(body) ? body.filter((s): s is string => typeof s === 'string') : [];
    return { statements, status: 200, outage: false };
  } catch {
    return { statements: [], status: null, outage: true };
  }
}

export type SigningConfirmOutcome = 'confirmed' | 'unconfirmed' | 'outage';

export interface SigningKeyConfirmation {
  /**
   * The receipt-time verifier-parity result (F-32.6 / AC-163):
   *   - `confirmed`: the archive holds the EXACT observed key bytes with a usable last-seen
   *     — the same predicate the verifier's provenance gate applies later;
   *   - `unconfirmed`: not (yet) confirmable — absent, stale selector records, contributed
   *     just now (the read path may lag), no usable time, or no observed key to compare.
   *     The F-32.7 reconciliation sweep re-checks and heals these;
   *   - `outage`: the archive was unreachable/errored. NEVER blocks receipt.
   */
  outcome: SigningConfirmOutcome;
  /** Usable last-seen for the exact key when confirmed (F-32.4 window input); else null. */
  lastSeenAt: string | null;
  /** A contribute POST was issued this call (absent pair, or the stale-selector nudge). */
  nudged: boolean;
  /** Diagnostic detail for the audit log. */
  detail?: string;
}

/**
 * Receipt-time verifier-parity confirmation (F-32.6 / AC-163, DD-36). Evaluates the
 * VERIFIER'S own predicate at signing — exact key bytes present in the archive with a
 * usable last-seen — and ALWAYS contributes when the selector's records lack the
 * observed key (rotation under a reused selector: the old ensure-flow skipped the POST
 * whenever ANY record existed, so the archive was never nudged to re-observe — the
 * latent false-FAIL risk this fixes). Never throws; receipt proceeds on any outcome.
 */
export async function confirmKeyAtSigning(
  domain: string,
  selector: string,
  observedKey: string | null,
  deps?: DkimArchiveDeps,
): Promise<SigningKeyConfirmation> {
  try {
    const lookup = await lookupArchivedKey(domain, selector, deps);
    const want = extractPublicKey(observedKey);
    if (lookup.found && !want) {
      // resolveDkimKey failed upstream — parity is not evaluable; presence alone is
      // deliberately NOT `confirmed` (operator metadata never substitutes, AC-158).
      return { outcome: 'unconfirmed', lastSeenAt: null, nudged: false, detail: 'no observed key to compare' };
    }
    if (lookup.found) {
      const match = lookup.records.find((r) => extractPublicKey(r.value) === want);
      if (match) {
        // Live-only (#147-A, spec 0.71.0): only a live_dns-channel bound confirms —
        // a recovery-only window nudges a fresh DNS observation instead.
        const lastSeen = liveLastSeenAt(match);
        if (lastSeen) return { outcome: 'confirmed', lastSeenAt: lastSeen, nudged: false };
        const nudge = await contributeKey(domain, selector, deps);
        return nudge.ok
          ? { outcome: 'unconfirmed', lastSeenAt: null, nudged: true, detail: 'exact key present, no usable live last-seen; nudged' }
          : { outcome: 'outage', lastSeenAt: null, nudged: true, detail: `nudge failed: HTTP ${nudge.status}` };
      }
      // Records exist but none carry the observed key → nudge a fresh observation.
      const nudge = await contributeKey(domain, selector, deps);
      return nudge.ok
        ? { outcome: 'unconfirmed', lastSeenAt: null, nudged: true, detail: 'selector records lack the observed key; nudged' }
        : { outcome: 'outage', lastSeenAt: null, nudged: true, detail: `nudge failed: HTTP ${nudge.status}` };
    }
    // Nothing archived for the pair → contribute (F-6.7). Contributed-now stays
    // `unconfirmed`: the broad read path can lag (re-GET would false-negative), so
    // the sweep confirms it 24–48h later against the settled record.
    const contribution = await contributeKey(domain, selector, deps);
    return contribution.ok
      ? {
          outcome: 'unconfirmed',
          lastSeenAt: null,
          nudged: true,
          detail: contribution.alreadyPresent ? 'already_in_db (race)' : 'contributed',
        }
      : { outcome: 'outage', lastSeenAt: null, nudged: true, detail: `contribute failed: HTTP ${contribution.status}` };
  } catch (err) {
    return { outcome: 'outage', lastSeenAt: null, nudged: false, detail: `archive unreachable: ${(err as Error).message}` };
  }
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
