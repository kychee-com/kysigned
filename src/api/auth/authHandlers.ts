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
import type { EmitAppEvent } from '../../integrations/appEvents.js';

export interface AuthHandlerCtx {
  pool: DbPool;
  session: SessionConfig;
  /** Where the magic link returns the user (the SPA reads `?token=` here). */
  appBaseUrl: string;
  /**
   * F-13.4 — the new-account trial-credit grant amount, in USD micros. The
   * grant fires on a confirmed magic-link sign-in (F-18.4). 0 / unset disables
   * it (the forker default); kysigned.com sets it via `signupGrantCredits`.
   */
  signupGrantUsdMicros?: bigint;
  /** F-36.4 — the DD-43 app-events seam (never throws). Prod (config.ts) wires it. */
  emitAppEvent?: EmitAppEvent;
}

export interface AuthResult {
  status: number;
  body: unknown;
  /** `Set-Cookie` values the entry should emit. */
  setCookies?: string[];
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function handleAuthMagicLink(ctx: AuthHandlerCtx, body: { email?: unknown }): Promise<AuthResult> {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !EMAIL_RE.test(email)) {
    return { status: 400, body: { error: 'A valid email address is required', code: 'validation_email' } };
  }
  await requestMagicLink({
    email,
    redirectUrl: ctx.appBaseUrl,
    projectAnonKey: ctx.session.projectAnonKey,
    run402BaseUrl: ctx.session.run402BaseUrl,
    fetchImpl: ctx.session.fetchImpl,
  });
  // Always 200 — never reveal whether an account exists (anti-enumeration).
  return { status: 200, body: { ok: true } };
}

export async function handleAuthTokenExchange(ctx: AuthHandlerCtx, body: { token?: unknown }): Promise<AuthResult> {
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return { status: 400, body: { error: 'token is required', code: 'validation_token' } };
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
      await ctx.emitAppEvent?.('creator_signed_up', [grant.ledgerId], {
        grant_usd_micros: Number(ctx.signupGrantUsdMicros ?? 0n),
        source: 'magic_link',
      });
    }
  } catch (err) {
    console.error('signup-grant failed (sign-in unaffected):', err);
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
