/**
 * handleTestResetUser — the F-28 test-account reset endpoint handler.
 *
 * Secret-gated + identity-scoped, test-only. Fail-closed guardrails so it can
 * never touch a real user or any account outside the kysigned app:
 *   - no reset secret configured    → 404 (endpoint effectively absent)
 *   - wrong / absent request secret → 401
 *   - missing email                 → 400
 *   - identity outside the pattern  → 403, ZERO mutation
 *   - no pattern configured         → 403 (refuse all)
 *   - matched identity + secret     → purge (resetTestAccount) → 200 + report
 */
import type { DbPool } from '../db/pool.js';
import { resetTestAccount, type ResetReport } from '../db/testReset.js';

export interface TestResetCtx {
  pool: DbPool;
  /** KYSIGNED_TEST_RESET_SECRET — undefined disables the endpoint entirely. */
  resetSecret: string | undefined;
  /** KYSIGNED_TEST_RESET_PATTERN — undefined refuses every identity (fail-closed). */
  identityPattern: RegExp | undefined;
}

export interface TestResetRequest {
  email: string;
  /** the secret supplied on the request (e.g. the x-test-reset-secret header). */
  secret: string;
}

export interface TestResetResult {
  status: 200 | 400 | 401 | 403 | 404;
  body: { report: ResetReport } | { code: string; error: string };
}

export async function handleTestResetUser(
  ctx: TestResetCtx,
  req: TestResetRequest,
): Promise<TestResetResult> {
  // Inert unless a reset secret is configured — indistinguishable from a
  // non-existent route (F-28: disabled → 404).
  if (!ctx.resetSecret) {
    return { status: 404, body: { error: 'not_found', code: 'not_found' } };
  }
  if (!req.secret || req.secret !== ctx.resetSecret) {
    return { status: 401, body: { error: 'unauthorized', code: 'auth_required' } };
  }
  if (!req.email || req.email.trim() === '') {
    return { status: 400, body: { error: 'email is required', code: 'validation_email' } };
  }
  // Identity-scoped: refuse anything outside the configured test pattern
  // (fail-closed when no pattern is set) — no mutation reaches the DB.
  const candidate = req.email.trim().toLowerCase();
  if (!ctx.identityPattern || !ctx.identityPattern.test(candidate)) {
    return { status: 403, body: { error: 'identity not permitted for test reset', code: 'auth_forbidden' } };
  }
  const report = await resetTestAccount(ctx.pool, req.email);
  return { status: 200, body: { report } };
}
