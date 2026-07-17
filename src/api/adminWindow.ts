/**
 * F-34.1 — operator-console time window.
 *
 * Every console page is scoped by one `?window=` param. `parseWindow` turns it
 * into a lower bound the analytics DAOs filter on (`created_at >= since`, etc.):
 * the fixed windows map to `now − interval`; `all` drops the bound; anything
 * absent or unrecognized falls to the 30-day default (never an unbounded scan by
 * accident). Pure over (param, now) so the DAOs stay deterministic under test.
 */
const H = 3_600_000;
const D = 24 * H;

export type WindowKey = '24h' | '7d' | '30d' | '365d' | 'all';

const INTERVALS: Record<Exclude<WindowKey, 'all'>, number> = {
  '24h': 24 * H,
  '7d': 7 * D,
  '30d': 30 * D,
  '365d': 365 * D,
};

export interface ParsedWindow {
  /** The applied, normalized window (an unrecognized/absent param normalizes to '30d'). */
  key: WindowKey;
  /** Lower bound for the window, or null for 'all' (no bound). */
  since: Date | null;
}

export function parseWindow(param: string | null | undefined, now: Date = new Date()): ParsedWindow {
  const key: WindowKey =
    param === '24h' || param === '7d' || param === '30d' || param === '365d' || param === 'all'
      ? param
      : '30d';
  if (key === 'all') return { key, since: null };
  return { key, since: new Date(now.getTime() - INTERVALS[key]) };
}

/**
 * F-35.1 — the operator-console exclude-internal toggle param (`?exclude_internal=`).
 * The console default is ON (hide the operator's own data), so an ABSENT param means
 * exclude. Only an explicit off value (`0` / `false` / `no`) turns exclusion off —
 * anything else stays on, so a garbled value can never accidentally leak internal
 * data into the default view.
 */
export function parseExcludeInternal(param: string | null | undefined): boolean {
  if (param == null) return true;
  const v = param.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no');
}
