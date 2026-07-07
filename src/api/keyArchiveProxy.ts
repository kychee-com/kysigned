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

export interface KeyArchiveProxyDeps {
  /** Archive client deps (default: real archive.prove.email via global fetch). */
  archive?: DkimArchiveDeps;
}

export interface KeyArchiveProxyResult {
  status: number;
  body: ArchiveKeyRecord[] | { error: string };
}

// Public DNS labels — a permissive shape guard (defense-in-depth on a public forward).
const DOMAIN_RE = /^[a-z0-9.-]{1,253}$/;
const SELECTOR_RE = /^[A-Za-z0-9._-]{1,128}$/;

export async function handleKeyArchiveLookup(
  deps: KeyArchiveProxyDeps,
  domain: string | null,
  selector: string | null,
): Promise<KeyArchiveProxyResult> {
  const d = (domain ?? '').trim().toLowerCase();
  const s = (selector ?? '').trim();
  if (!d || !s) return { status: 400, body: { error: 'domain and selector are required' } };
  if (!DOMAIN_RE.test(d) || !SELECTOR_RE.test(s)) {
    return { status: 400, body: { error: 'invalid domain or selector' } };
  }
  try {
    const { records } = await lookupArchivedKey(d, s, deps.archive);
    return { status: 200, body: records };
  } catch {
    // Archive unreachable / errored → 502; the web verifier degrades to `pending`.
    return { status: 502, body: { error: 'archive lookup failed' } };
  }
}
