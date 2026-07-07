/**
 * GET /v1/health — unauthenticated liveness probe (F-11 / AC-32).
 *
 * Pure: returns a 200 with a small JSON body. No auth, no DB. The run402 Lambda
 * router maps `GET /v1/health` → this handler (route wiring lands in Phase 14);
 * the shipping smoke check (Phase 20) curls it.
 */
export interface HealthResult {
  status: 200;
  body: { status: 'ok'; service: 'kysigned'; ts: string };
}

export function handleHealth(now: Date = new Date()): HealthResult {
  return { status: 200, body: { status: 'ok', service: 'kysigned', ts: now.toISOString() } };
}
