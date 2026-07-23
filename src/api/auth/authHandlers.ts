/**
 * authHandlers — the magic-link cookie-session auth endpoints (F-18.1).
 *
 *   POST /v1/auth/magic-link  → requestMagicLink (always 200; anti-enumeration)
 *   POST /v1/auth/token       → exchange the clicked token → start a session + cookie
 *   GET  /v1/auth/user        → the resolved actor's email (+ saved display name)
 *   POST /v1/auth/signout     → end the session + clear the cookie
 *
 * Each result carries an optional `setCookies` the function-entry turns into
 * `Set-Cookie` headers. Auth is run402-backed (dashboardAuth) + a server-side
 * session (session.ts). Passkey sign-in (F-18.1's passkey-first) shares this same
 * session machinery — see `passkeyHandlers.ts` (a run402 `/auth/v1/passkeys/*`
 * proxy whose verify route calls the same `startSession`).
 */
import type { DbPool } from '../../db/pool.js';
import { requestMagicLink, exchangeMagicLinkToken } from './dashboardAuth.js';
import { startSession, endSession, type SessionConfig, type SessionActor } from './session.js';
import { getCreatorName } from '../../db/creatorProfiles.js';
import { grantSignupCreditIfEligible } from '../signupGrant.js';
import {
  parseAttributionSubmission,
  recordAttributionCapture,
  bindAttributionIfPending,
  type BindOutcome,
} from '../attributionCapture.js';
import { enqueueAdsConversion } from '../adsConversions.js';
import type { CreateRun } from '../../functions/runs.js';
import type { EmitAppEvent } from '../../integrations/appEvents.js';
import type { InternalSubjectGate } from '../../integrations/internalSubject.js';

export interface AuthHandlerCtx {
  pool: DbPool;
  session: SessionConfig;
  /**
   * The app's public origin. The magic link returns the user on
   * `<appBaseUrl>/dashboard` (see `magicLinkLandingUrl`), where the SPA's
   * SignInScreen reads `?token=` and completes the exchange.
   */
  appBaseUrl: string;
  /**
   * F-13.4 — the new-account trial-credit grant amount, in USD micros. The
   * grant fires on a confirmed magic-link sign-in (F-18.4). 0 / unset disables
   * it (the forker default); kysigned.com sets it via `signupGrantCredits`.
   */
  signupGrantUsdMicros?: bigint;
  /** F-36.4 — the DD-43 app-events seam (never throws). Prod (config.ts) wires it. */
  emitAppEvent?: EmitAppEvent;
  /**
   * F-36.6 — the DD-49 internal-subject gate: an internal-identity claim still
   * grants, but its `creator_signed_up` is suppressed (logged, never emitted).
   * Absent (fork default before config wiring): nothing is suppressed.
   */
  internalGate?: InternalSubjectGate;
  /**
   * F-37 — server gate for the attribution rail (`KYSIGNED_CAPTURE_GCLID`).
   * Unset/false (the forker default): the magic-link rider is ignored and no
   * attribution row is ever written, so a fresh fork captures nothing anywhere.
   */
  attributionEnabled?: boolean;
  /** F-37 — durable-run creator for the sign-up conversion enqueue (65.4). */
  createRun?: CreateRun;
  /** F-37 — the `[service]` upload-handler function name (fork default: unset → no enqueue). */
  adsUploadFunction?: string;
  /**
   * F-38.4 — record one server-side funnel step (send_ok / send_failed /
   * link_opened / session_created). Present only when the telemetry rail is
   * enabled; ALWAYS best-effort — a telemetry failure must never gate auth.
   * `paid` is set only when THIS request establishes it (the attribution
   * rider); everything else records the explicit unknown — never a guess.
   */
  telemetryStep?: (
    event: 'send_ok' | 'send_failed' | 'link_opened' | 'session_created',
    opts?: { paid?: boolean; country?: string },
  ) => Promise<void>;
}

export interface AuthResult {
  status: number;
  body: unknown;
  /** `Set-Cookie` values the entry should emit. */
  setCookies?: string[];
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** F-38.4 — true only when a VALID attribution rider rides this request. */
function riderIsPaid(ctx: AuthHandlerCtx, attribution: unknown): boolean {
  if (!ctx.attributionEnabled) return false;
  try {
    return parseAttributionSubmission(attribution, new Date()) !== null;
  } catch {
    return false;
  }
}

/** F-38.4 — fire a server-recorded funnel step; never throws, never gates. */
async function recordStep(
  ctx: AuthHandlerCtx,
  event: 'send_ok' | 'send_failed' | 'link_opened' | 'session_created',
  opts?: { paid?: boolean },
): Promise<void> {
  if (!ctx.telemetryStep) return;
  try {
    await ctx.telemetryStep(event, opts);
  } catch (err) {
    console.error(`telemetry step ${event} failed (auth unaffected):`, err);
  }
}

/**
 * GH#20 (P0) — the emailed link must land on an SPA-SERVED route. run402
 * appends `?token=` to this URL verbatim; the operator deployment aliases `/`
 * to a static home.html that cannot exchange the token, so pointing at the
 * bare base URL silently killed every email sign-in. `/dashboard` is served
 * by the SPA in both deployments (operator spa_fallback and fork), where
 * RequireAuth renders SignInScreen and its `?token=` effect completes the
 * exchange. URL resolution (not concat) so a trailing-slash base normalizes.
 *
 * LOCKSTEP: kysigned-private mirrors this path in
 * `src/deploy/staticRouteAliases.ts` (MAGIC_LINK_LANDING_PATH), whose contract
 * test forbids any static route alias from shadowing it. Change one → change
 * both.
 */
export const MAGIC_LINK_LANDING_PATH = '/dashboard';

function magicLinkLandingUrl(appBaseUrl: string): string {
  return new URL(MAGIC_LINK_LANDING_PATH, appBaseUrl).toString();
}

export async function handleAuthMagicLink(
  ctx: AuthHandlerCtx,
  body: { email?: unknown; attribution?: unknown },
): Promise<AuthResult> {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !EMAIL_RE.test(email)) {
    return { status: 400, body: { error: 'A valid email address is required', code: 'validation_email' } };
  }
  // F-38.4 — the send outcome is a funnel fact (accepted vs rejected); the
  // paid mark comes ONLY from the attribution rider on this same request
  // (DD-50.6 — no email-join, the rail stays identifier-free end to end).
  let sendOk = false;
  try {
    const sendResult = await requestMagicLink({
      email,
      redirectUrl: magicLinkLandingUrl(ctx.appBaseUrl),
      projectAnonKey: ctx.session.projectAnonKey,
      run402BaseUrl: ctx.session.run402BaseUrl,
      fetchImpl: ctx.session.fetchImpl,
    });
    sendOk = sendResult.ok;
  } catch (err) {
    await recordStep(ctx, 'send_failed', { paid: riderIsPaid(ctx, body.attribution) });
    throw err;
  }
  await recordStep(ctx, sendOk ? 'send_ok' : 'send_failed', { paid: riderIsPaid(ctx, body.attribution) });

  // F-37 — the attribution rider: the email submit happens in the browser that
  // holds the gclid capture (the link may be opened elsewhere), so the capture
  // is persisted NOW, keyed to the email, and bound at establishment. Strictly
  // best-effort and gated: a malformed rider or a write failure must never
  // disturb the anti-enumeration 200 contract, and a fork (flag off) ignores
  // the field entirely.
  if (ctx.attributionEnabled) {
    try {
      const submission = parseAttributionSubmission(body.attribution, new Date());
      if (submission) await recordAttributionCapture(ctx.pool, email, submission);
    } catch (err) {
      console.error('attribution capture failed (magic-link unaffected):', err);
    }
  }

  // Always 200 — never reveal whether an account exists (anti-enumeration).
  return { status: 200, body: { ok: true } };
}

export async function handleAuthTokenExchange(ctx: AuthHandlerCtx, body: { token?: unknown }): Promise<AuthResult> {
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return { status: 400, body: { error: 'token is required', code: 'validation_token' } };
  // F-38.4 — the emailed link was OPENED (browser-independent: this request IS
  // the open, whatever device it lands on and whatever happens next).
  await recordStep(ctx, 'link_opened');
  const r = await exchangeMagicLinkToken({
    magicLinkToken: token,
    projectAnonKey: ctx.session.projectAnonKey,
    run402BaseUrl: ctx.session.run402BaseUrl,
    fetchImpl: ctx.session.fetchImpl,
  });
  if (!r.ok || !r.accessToken || !r.refreshToken || !r.email) {
    return { status: 401, body: { error: 'Sign-in failed', code: 'auth_signin_failed', reason: r.reason } };
  }
  const email = r.email.toLowerCase();
  const { cookie } = await startSession(ctx.pool, ctx.session, {
    email,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
  });
  // F-38.4 — the session exists: the funnel's last step.
  await recordStep(ctx, 'session_created');

  // F-13.4 / F-18.4 — new-account trial credit. The magic-link click is the
  // mailbox-control proof, and the grant is idempotent + deduped on the
  // normalized inbox (signupGrant.ts), so attempting it on every confirmed
  // sign-in lands it exactly once. Best-effort: a grant failure must NEVER break
  // sign-in (the session is already started), so it is wrapped and swallowed.
  try {
    const grant = await grantSignupCreditIfEligible(ctx.pool, email, {
      grantUsdMicros: ctx.signupGrantUsdMicros ?? 0n,
    });
    // F-36.4 — creator_signed_up on the FRESH claim only (the grant's
    // normalized-inbox UNIQUE is the exactly-once anchor). Keyed by the grant
    // ledger row id — no address in the key or payload, ever.
    if (grant.granted && grant.ledgerId) {
      // F-36.6 — an internal-identity claim grants normally but never emits.
      if (ctx.internalGate?.account(email)) {
        ctx.internalGate.logSuppressed('creator_signed_up', [grant.ledgerId]);
      } else {
        await ctx.emitAppEvent?.('creator_signed_up', [grant.ledgerId], {
          grant_usd_micros: Number(ctx.signupGrantUsdMicros ?? 0n),
          source: 'magic_link',
        });
      }
    }
  } catch (err) {
    console.error('signup-grant failed (sign-in unaffected):', err);
  }

  // F-37 / AC-206 — bind-at-establishment: stamp the account once (the earliest
  // unexpired pending capture wins; none → permanently organic). Best-effort —
  // an attribution failure never breaks sign-in. The fresh-bind outcome is the
  // sign-up conversion signal (65.4).
  let bind: BindOutcome = { bound: false };
  if (ctx.attributionEnabled) {
    try {
      bind = await bindAttributionIfPending(ctx.pool, email);
    } catch (err) {
      console.error('attribution bind failed (sign-in unaffected):', err);
    }
  }

  // F-37 / AC-207 — a FRESH attributed establishment IS the sign-up conversion.
  // The per-account once-key (`ads:sign_up:<handle>`) makes retries safe, and
  // the seam never throws — sign-in completes regardless (AC-208 isolation).
  if (bind.bound) {
    await enqueueAdsConversion(
      { pool: ctx.pool, createRun: ctx.createRun, adsUploadFunction: ctx.adsUploadFunction },
      'sign_up',
      email,
      { occurredAt: new Date() },
    );
  }

  return { status: 200, body: { ok: true, email }, setCookies: [cookie] };
}

export async function handleAuthUser(ctx: AuthHandlerCtx, actor: SessionActor): Promise<AuthResult> {
  const displayName = await getCreatorName(ctx.pool, actor.email).catch(() => null);
  return { status: 200, body: { email: actor.email, display_name: displayName ?? undefined } };
}

export async function handleAuthSignout(ctx: AuthHandlerCtx, actor: SessionActor): Promise<AuthResult> {
  const clear = await endSession(ctx.pool, ctx.session, actor.sessionId);
  return { status: 200, body: { ok: true }, setCookies: [clear] };
}
