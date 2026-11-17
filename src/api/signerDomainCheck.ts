/**
 * signerDomainCheck — F-3.9 (#113, DD-86): a heads-up about a signer's email
 * DOMAIN before anything is sent.
 *
 * Three warnings, all advice and never a block:
 *  - `cannot_receive`: the domain does not exist, declares a null MX, or has no
 *    MX and no A/AAAA a mail server could fall back to. Reported ALONE.
 *  - `disposable`: the domain is on the maintained disposable list (F-13.6); no
 *    lookup needed, given regardless of DNS.
 *  - `no_sender_protection`: the domain publishes neither SPF nor DMARC.
 *
 * Bounded: ONE budget per request (DOMAIN_CHECK_BUDGET_MS) across every domain;
 * all lookups start in parallel, and those still open at the budget are
 * cancelled on the request's own resolver. A DNS-based warning is given only
 * when ITS lookups returned a definite answer (a result, or a definite "no such
 * name / no such record"); an error, a cancel or a lookup still open counts as
 * not checked, so a slow resolver never invents a problem.
 *
 * Privacy: only domain names reach the resolver (never a local part), and
 * nothing about a check is stored or logged. This module has no store.
 */
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { isDisposableDomain } from './disposableDomains.js';

/** F-3.9 — the check adds at most this much to any request. */
export const DOMAIN_CHECK_BUDGET_MS = 2000;

export type SignerDomainWarning = 'cannot_receive' | 'disposable' | 'no_sender_protection';

export interface SignerWarning {
  email: string;
  warnings: SignerDomainWarning[];
}

/** The slice of `node:dns/promises` `Resolver` the check uses (injected in tests). */
export interface DomainResolver {
  resolveMx(host: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  resolveTxt(host: string): Promise<string[][]>;
  /** Cancel every lookup still open on THIS resolver. */
  cancel(): void;
}

export interface DomainCheckDeps {
  /** A fresh resolver per check, so `cancel()` touches only this request's lookups. */
  createResolver: () => DomainResolver;
  /** Test seams for the budget timer; default the wall clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/** A signer-domain checker bound to its deps (what the handlers receive). */
export type SignerDomainChecker = (addresses: string[]) => Promise<SignerWarning[]>;

/** The production resolver: one per request; the c-ares timeout is a backstop to the budget. */
export function createNodeResolver(): DomainResolver {
  return new Resolver({ timeout: DOMAIN_CHECK_BUDGET_MS, tries: 1 }) as unknown as DomainResolver;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * The ASCII form of a domain, or null when the value is not a checkable
 * domain (no lookup is ever made for null).
 */
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 253 || /[\s@/\\]/.test(trimmed)) return null;
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  const tld = labels[labels.length - 1]!;
  if (/^\d+$/.test(tld)) return null; // an IP address, not a domain
  return ascii;
}

/** The ASCII domain of a well-formed address, or null (a malformed address is never looked up). */
function domainOfAddress(address: unknown): string | null {
  if (typeof address !== 'string') return null;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return normalizeDomain(address.slice(at + 1));
}

// ── one domain's lookups ────────────────────────────────────────────────────

type Outcome<T> = { kind: 'value'; value: T } | { kind: 'absent' } | { kind: 'unknown' };

/** A definite "no such name" (NXDOMAIN) or "no such record" (NODATA). */
const DEFINITE_ABSENT = new Set(['ENOTFOUND', 'ENODATA']);

interface Tracked<T> {
  outcome: Outcome<T>;
  done: Promise<void>;
}

function track<T>(start: () => Promise<T>): Tracked<T> {
  const t: Tracked<T> = { outcome: { kind: 'unknown' }, done: Promise.resolve() };
  let p: Promise<T>;
  try {
    p = start();
  } catch {
    return t; // a resolver that throws synchronously: not checked
  }
  t.done = Promise.resolve(p).then(
    (value) => {
      t.outcome = { kind: 'value', value };
    },
    (err: unknown) => {
      const code = (err as { code?: unknown } | null)?.code;
      t.outcome = typeof code === 'string' && DEFINITE_ABSENT.has(code) ? { kind: 'absent' } : { kind: 'unknown' };
    },
  );
  return t;
}

interface DomainLookups {
  mx: Tracked<Array<{ exchange: string; priority: number }>>;
  a: Tracked<string[]>;
  aaaa: Tracked<string[]>;
  txt: Tracked<string[][]>;
  dmarc: Tracked<string[][]>;
}

function startLookups(r: DomainResolver, domain: string): DomainLookups {
  return {
    mx: track(() => r.resolveMx(domain)),
    a: track(() => r.resolve4(domain)),
    aaaa: track(() => r.resolve6(domain)),
    txt: track(() => r.resolveTxt(domain)),
    dmarc: track(() => r.resolveTxt(`_dmarc.${domain}`)),
  };
}

const isNullMx = (exchange: string) => exchange === '' || exchange === '.';
const noRecords = (o: Outcome<unknown[]>) => o.kind === 'absent' || (o.kind === 'value' && o.value.length === 0);

function cannotReceive(l: DomainLookups): boolean {
  const mx = l.mx.outcome;
  if (mx.kind === 'value' && mx.value.length > 0) return mx.value.every((r) => isNullMx(r.exchange));
  // No MX at all: undeliverable only when A and AAAA are DEFINITELY absent too.
  return noRecords(mx) && noRecords(l.a.outcome) && noRecords(l.aaaa.outcome);
}

/** null = not definitely known. */
function hasTxtTag(o: Outcome<string[][]>, tag: RegExp): boolean | null {
  if (o.kind === 'unknown') return null;
  if (o.kind === 'absent') return false;
  return o.value.some((chunks) => tag.test((Array.isArray(chunks) ? chunks.join('') : String(chunks)).trim()));
}

const SPF_TAG = /^v=spf1(\s|$)/i;
const DMARC_TAG = /^v=dmarc1\s*(;|$)/i;

function noSenderProtection(l: DomainLookups): boolean {
  const spf = hasTxtTag(l.txt.outcome, SPF_TAG);
  const dmarc = hasTxtTag(l.dmarc.outcome, DMARC_TAG);
  return spf === false && dmarc === false;
}

function warningsOf(domain: string, l: DomainLookups | null): SignerDomainWarning[] {
  if (l && cannotReceive(l)) return ['cannot_receive'];
  const out: SignerDomainWarning[] = [];
  if (isDisposableDomain(domain)) out.push('disposable');
  if (l && noSenderProtection(l)) out.push('no_sender_protection');
  return out;
}

// ── the bounded check ───────────────────────────────────────────────────────

/** Warnings per distinct ASCII domain, under ONE budget. Never throws. */
async function checkDomains(domains: string[], deps: DomainCheckDeps): Promise<Map<string, SignerDomainWarning[]>> {
  const distinct = [...new Set(domains)];
  const result = new Map<string, SignerDomainWarning[]>();
  if (distinct.length === 0) return result;

  let resolver: DomainResolver | null = null;
  try {
    resolver = deps.createResolver();
  } catch {
    resolver = null; // no DNS: only the lookup-free warning remains
  }
  const lookups = new Map<string, DomainLookups>();
  if (resolver) {
    for (const d of distinct) lookups.set(d, startLookups(resolver, d));
    const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    let timer: unknown;
    const budget = new Promise<'budget'>((res) => {
      timer = setTimer(() => res('budget'), DOMAIN_CHECK_BUDGET_MS);
    });
    const all = Promise.all(
      [...lookups.values()].flatMap((l) => [l.mx.done, l.a.done, l.aaaa.done, l.txt.done, l.dmarc.done]),
    ).then(() => 'answered' as const);
    const winner = await Promise.race([all, budget]);
    clearTimer(timer);
    if (winner === 'budget') {
      // Snapshot first: whatever settles after the budget never counts.
      const snapshot = new Map<string, SignerDomainWarning[]>();
      for (const d of distinct) snapshot.set(d, warningsOf(d, lookups.get(d) ?? null));
      try {
        resolver.cancel();
      } catch {
        /* nothing outlives the request either way */
      }
      return snapshot;
    }
  }
  for (const d of distinct) result.set(d, warningsOf(d, lookups.get(d) ?? null));
  return result;
}

/**
 * F-3.9 — the per-signer warnings for a validated signer set: one entry per
 * address that has warnings (none for a clean domain). Never throws.
 */
export async function checkSignerDomains(addresses: string[], deps: DomainCheckDeps): Promise<SignerWarning[]> {
  try {
    const pairs = addresses.map((email) => ({ email, domain: domainOfAddress(email) }));
    const byDomain = await checkDomains(
      pairs.flatMap((p) => (p.domain ? [p.domain] : [])),
      deps,
    );
    const out: SignerWarning[] = [];
    const seen = new Set<string>();
    for (const { email, domain } of pairs) {
      if (!domain) continue;
      const key = email.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const warnings = byDomain.get(domain) ?? [];
      if (warnings.length > 0) out.push({ email, warnings });
    }
    return out;
  } catch {
    return []; // advice only: a broken check never fails a request
  }
}

/** F-3.9 / DD-87 — the warnings for ONE domain (the editor's live check). Never throws. */
export async function checkOneDomain(raw: unknown, deps: DomainCheckDeps): Promise<SignerDomainWarning[]> {
  const domain = normalizeDomain(raw);
  if (!domain) return [];
  try {
    return (await checkDomains([domain], deps)).get(domain) ?? [];
  } catch {
    return [];
  }
}

/** Bind the deps once: what the request handlers receive. */
export function createSignerDomainChecker(deps: DomainCheckDeps): SignerDomainChecker {
  return (addresses) => checkSignerDomains(addresses, deps);
}
