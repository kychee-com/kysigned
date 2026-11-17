/**
 * Key-archive lookup proxy (F-10.8 / AC-104) — the operator forwards the web
 * verifier's PUBLIC `(domain, selector)` DKIM-key lookup to archive.prove.email
 * server-side, because the archive serves no CORS headers (so the browser can't
 * call it cross-origin and the /verify key badge would otherwise stay "pending").
 *
 * It returns the archive's records ARRAY (the same shape archive.prove.email
 * returns) so the same-origin web verifier's `lookupArchivedKey` parses it
 * identically. It forwards ONLY `(domain, selector)` — both public DNS facts — and
 * never touches the bundle/file (the document still never leaves the device). The
 * reference CLI queries the archive directly (no proxy), as the independent path.
 *
 * Additive: this corroborates the offline math; it never gates the PROVEN verdict.
 */
import { lookupArchivedKey, type DkimArchiveDeps, type ArchiveKeyRecord } from './signing/dkimArchive.js';
import {
  KEY_ARCHIVE_FRESH_MS,
  DEFAULT_KEY_ARCHIVE_CACHE_MAX,
  type KeyArchiveStore,
} from '../db/keyArchiveCache.js';

export interface KeyArchiveProxyDeps {
  /** Archive client deps (default: real archive.prove.email via global fetch). */
  archive?: DkimArchiveDeps;
  /**
   * F-10.8a (#102, DD-84) — the proxy's memory. Absent (a fork that wires none, or
   * a test) = the pre-F-10.8a behavior: every lookup asks the archive.
   */
  cache?: { store: KeyArchiveStore; now?: () => Date; max?: number };
}

export interface KeyArchiveLookupOptions {
  /** DD-85 — skip the remembered answer, ask the archive, and store what it says. */
  fresh?: boolean;
}

export interface KeyArchiveProxyResult {
  status: number;
  body: ArchiveKeyRecord[] | { code: string; error: string };
}

// Public DNS labels — a permissive shape guard (defense-in-depth on a public forward).
const DOMAIN_RE = /^[a-z0-9.-]{1,253}$/;
const SELECTOR_RE = /^[A-Za-z0-9._-]{1,128}$/;

export async function handleKeyArchiveLookup(
  deps: KeyArchiveProxyDeps,
  domain: string | null,
  selector: string | null,
  opts: KeyArchiveLookupOptions = {},
): Promise<KeyArchiveProxyResult> {
  const d = (domain ?? '').trim().toLowerCase();
  const s = (selector ?? '').trim();
  if (!d || !s) return { status: 400, body: { error: 'domain and selector are required', code: 'validation_domain_selector' } };
  if (!DOMAIN_RE.test(d) || !SELECTOR_RE.test(s)) {
    return { status: 400, body: { error: 'invalid domain or selector', code: 'validation_domain_selector' } };
  }
  // F-10.8a: a found answer fetched under 24 hours ago is served from memory, with
  // no archive call (so during an outage too). A fresh lookup skips this. Every
  // store failure falls through to the archive: the memory never fails a lookup.
  const store = deps.cache?.store;
  const now = deps.cache?.now?.() ?? new Date();
  if (store && !opts.fresh) {
    try {
      const remembered = await store.hit(d, s, now);
      if (remembered && now.getTime() - remembered.fetchedAt.getTime() < KEY_ARCHIVE_FRESH_MS) {
        return { status: 200, body: JSON.parse(remembered.records) as ArchiveKeyRecord[] };
      }
    } catch {
      /* unreadable or unreachable memory: ask the archive */
    }
  }
  try {
    const { records } = await lookupArchivedKey(d, s, deps.archive);
    if (store) {
      try {
        if (records.length > 0) {
          // Only found answers are remembered; prune only after a put, never on a hit.
          await store.put(d, s, JSON.stringify(records), now);
          await store.prune(now, deps.cache?.max ?? DEFAULT_KEY_ARCHIVE_CACHE_MAX);
        } else {
          // The archive's current answer is "no record": forget anything remembered.
          await store.remove(d, s);
        }
      } catch {
        /* a failed write never fails the lookup: the archive's answer stands */
      }
    }
    return { status: 200, body: records };
  } catch {
    // An answer older than 24 hours is never served, and a fresh lookup never
    // falls back to memory: the failure goes out (the verifier shows pending).
    // Archive unreachable / errored → 502; the web verifier degrades to `pending`.
    return { status: 502, body: { error: 'archive lookup failed', code: 'internal_upstream' } };
  }
}
