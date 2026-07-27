/**
 * googleHandlers — F-41's Google sign-in doors (DD-58..62), the passkey-proxy
 * pattern applied to run402's machine OAuth flow:
 *
 *   handleGoogleStart     (public)  mint PKCE + ceremony row (DD-59), proxy
 *                                   run402's start, hand back authorization_url.
 *   handleGoogleExchange  (public)  consume the ceremony exactly-once, exchange
 *                                   the code (+verifier) at run402, then run the
 *                                   magic-link exchange's EXACT downstream:
 *                                   startSession → session_created(method) →
 *                                   grant (DD-62 proof) → creator_signed_up →
 *                                   attribution bind → ceremony draft claim.
 *   handleGoogleLink      (session) the Connect-Google start: intent=link with
 *                                   the session's server-held run402 Bearer.
 *
 * kysigned implements NO OAuth of its own: run402 owns the client, the Google
 * round trip, token verification, and the identity/linking rules. These are
 * thin doors whose value is WHERE they put things (ceremony row, same session
 * store) and what they refuse (dead ceremonies, cross-user links).
 */
import type { DbPool } from '../../db/pool.js';
import { getAuthSession } from '../../db/authSessions.js';
import {
  createGoogleCeremony,
  consumeGoogleCeremony,
  mintPkceVerifier,
  pkceChallengeS256,
} from '../../db/googleCeremonies.js';
import { startSession, type SessionActor } from './session.js';
import {
  grantSignupCreditIfEligible,
  type SignupGrantConfig,
  type SignupGrantOutcome,
} from '../signupGrant.js';
import {
  parseAttributionSubmission,
  recordAttributionCapture,
  bindAttributionIfPending,
  type AttributionSubmission,
  type BindOutcome,
} from '../attributionCapture.js';
import { enqueueAdsConversion } from '../adsConversions.js';
import type { AuthHandlerCtx, AuthResult } from './authHandlers.js';
import type { AuthMethods } from './authMethods.js';

/** Same shape as the magic-link path's handle guard (authHandlers.ts). */
const DRAFT_HANDLE_RE = /^ps_[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,64}$/;
const CEREMONY_ID_RE = /^gc_[0-9a-f-]{36}$/;
const GATE_TRIGGERS = new Set(['direct', 'redirect', 'send']);

export interface GoogleHandlerCtx {
  /** The magic-link ctx — session config, grant amount, events, attribution,
   *  telemetry. One downstream, two front doors. */
  auth: AuthHandlerCtx;
  /** Platform provider discovery (authMethods.ts). Off → friendly 503. */
  methods: () => Promise<AuthMethods>;
  /** Claim the ceremony-held draft for the establishing session (73.9 wires the
   *  real pendingSend path; tests inject). Absent → drafts are ignored. */
  claimCeremonyDraft?: (handle: string, sessionEmail: string) => Promise<{ status: number; body: unknown }>;
  /** Injectable grant (tests); defaults to the real one. */
  grantSignupCredit?: (email: string, config: SignupGrantConfig) => Promise<SignupGrantOutcome>;
  /** Injectable attribution seams (tests); default to the real ones. */
  attribution?: {
    record: (email: string, submission: AttributionSubmission) => Promise<void>;
    bind: (email: string) => Promise<BindOutcome>;
  };
}

const GOOGLE_UNAVAILABLE: AuthResult = {
  status: 503,
  body: {
    error: 'Google sign-in is not available right now. Use the email sign-in link instead.',
    code: 'auth_google_unavailable',
  },
};

const SIGNIN_FAILED: AuthResult = {
  status: 401,
  body: { error: 'Sign-in failed', code: 'auth_signin_failed' },
};

type FetchLike = NonNullable<AuthHandlerCtx['session']['fetchImpl']>;

function fetchImpl(ctx: GoogleHandlerCtx): FetchLike {
  return (
    (ctx.auth.session.fetchImpl as FetchLike | undefined) ??
    ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>)
  );
}

function run402Base(ctx: GoogleHandlerCtx): string {
  return ctx.auth.session.run402BaseUrl ?? 'https://api.run402.com';
}

/** The GH#20-safe landing — the same SPA route the magic link uses. */
function dashboardLanding(appBaseUrl: string): string {
  return new URL('/dashboard', appBaseUrl).toString();
}

/**
 * AC-248 — where a LINK ceremony comes back to. NOT the dashboard: a link is
 * always started by a signed-in visitor, and a signed-in visitor renders the
 * dashboard rather than the sign-in screen that reads the ceremony result off
 * the URL — so both the confirmation and the refusal were invisible (Barry,
 * walk 5: a correctly-refused cross-account link showed him nothing, and he
 * reasonably concluded it might have worked). It returns to the page the
 * visitor pressed Connect on, which can therefore report what happened.
 */
function signInMethodsLanding(appBaseUrl: string): string {
  return new URL('/account/passkeys', appBaseUrl).toString();
}

/** run402 machine start (routes/auth.ts:516.., read at 414cc643). */
async function run402GoogleStart(
  ctx: GoogleHandlerCtx,
  body: Record<string, unknown>,
  bearer?: string,
): Promise<{ ok: boolean; authorizationUrl?: string }> {
  try {
    const res = await fetchImpl(ctx)(`${run402Base(ctx)}/auth/v1/oauth/google/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ctx.auth.session.projectAnonKey,
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) return { ok: false };
    const parsed = (await res.json()) as { authorization_url?: string };
    if (typeof parsed.authorization_url !== 'string' || !parsed.authorization_url) return { ok: false };
    return { ok: true, authorizationUrl: parsed.authorization_url };
  } catch {
    return { ok: false };
  }
}

/** Shared start core: gate on methods, mint ceremony, proxy run402. */
async function startCeremony(
  ctx: GoogleHandlerCtx,
  fields: { draftHandle?: string; gclid?: unknown; linkEmail?: string; gateTrigger?: string },
  intent: 'signin' | 'link',
  bearer?: string,
): Promise<AuthResult> {
  if (!(await ctx.methods()).google) return GOOGLE_UNAVAILABLE;
  const pkceVerifier = mintPkceVerifier();
  const ceremonyId = await createGoogleCeremony(ctx.auth.pool, { pkceVerifier, ...fields });
  const started = await run402GoogleStart(
    ctx,
    {
      redirect_url: intent === 'link' ? signInMethodsLanding(ctx.auth.appBaseUrl) : dashboardLanding(ctx.auth.appBaseUrl),
      mode: 'redirect',
      intent,
      code_challenge: pkceChallengeS256(pkceVerifier),
      code_challenge_method: 'S256',
      client_state: ceremonyId,
    },
    bearer,
  );
  // The unconsumed ceremony row expires on its own TTL; nothing to clean here.
  if (!started.ok) return GOOGLE_UNAVAILABLE;
  return { status: 200, body: { authorization_url: started.authorizationUrl } };
}

export async function handleGoogleStart(
  ctx: GoogleHandlerCtx,
  body: { draft_id?: unknown; attribution?: unknown; trigger?: unknown },
): Promise<AuthResult> {
  const draftHandle =
    typeof body.draft_id === 'string' && DRAFT_HANDLE_RE.test(body.draft_id) ? body.draft_id : undefined;
  // F-37 — the rider is stored server-side in the ceremony (never a URL), and
  // window-checked at BIND time like the email path; here only shape-checked.
  let gclid: unknown;
  if (ctx.auth.attributionEnabled && body.attribution !== undefined) {
    try {
      gclid = parseAttributionSubmission(body.attribution, new Date()) ? body.attribution : undefined;
    } catch {
      gclid = undefined;
    }
  }
  const gateTrigger =
    typeof body.trigger === 'string' && GATE_TRIGGERS.has(body.trigger) ? body.trigger : undefined;
  return startCeremony(ctx, { draftHandle, gclid, gateTrigger }, 'signin');
}

export async function handleGoogleLink(ctx: GoogleHandlerCtx, actor: SessionActor): Promise<AuthResult> {
  if (!(await ctx.methods()).google) return GOOGLE_UNAVAILABLE;
  const session = await getAuthSession(ctx.auth.pool, actor.sessionId);
  const bearer = session?.run402_access_token;
  if (!bearer) return SIGNIN_FAILED;
  return startCeremony(ctx, { linkEmail: actor.email }, 'link', bearer);
}

export async function handleGoogleExchange(
  ctx: GoogleHandlerCtx,
  body: { code?: unknown; ceremony?: unknown },
): Promise<AuthResult> {
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const ceremonyId = typeof body.ceremony === 'string' ? body.ceremony.trim() : '';
  if (!code || !CEREMONY_ID_RE.test(ceremonyId)) {
    return { status: 400, body: { error: 'code and ceremony are required', code: 'validation_google_exchange' } };
  }

  // Exactly-once, BEFORE any upstream call: a dead ceremony never spends the
  // authorization code (which could be an attacker's replay bait).
  const ceremony = await consumeGoogleCeremony(ctx.auth.pool, ceremonyId);
  if (!ceremony) return SIGNIN_FAILED;

  let exchanged: {
    access_token?: string;
    refresh_token?: string;
    user?: { email?: string; email_verified_at?: string | null };
  };
  try {
    const res = await fetchImpl(ctx)(`${run402Base(ctx)}/auth/v1/token?grant_type=authorization_code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ctx.auth.session.projectAnonKey },
      body: JSON.stringify({ code, code_verifier: ceremony.pkceVerifier }),
    });
    if (res.status < 200 || res.status >= 300) return SIGNIN_FAILED;
    exchanged = (await res.json()) as typeof exchanged;
  } catch {
    return SIGNIN_FAILED;
  }
  const email = exchanged.user?.email?.toLowerCase();
  if (!exchanged.access_token || !exchanged.refresh_token || !email) return SIGNIN_FAILED;

  // ── LINK ceremony: attach, never sign in (F-41.4). The caller already holds
  // their session; minting another would rotate it for no reason, and a
  // cross-user resolution must never quietly switch accounts.
  if (ceremony.linkEmail) {
    if (email !== ceremony.linkEmail) {
      return {
        status: 409,
        body: {
          error: 'That Google account belongs to a different sign-in. Choose the Google account for this address.',
          code: 'auth_google_link_mismatch',
        },
      };
    }
    return { status: 200, body: { ok: true, linked: true, email } };
  }

  // ── SIGN-IN ceremony: the magic-link downstream, verbatim order
  // (authHandlers.handleAuthTokenExchange is the reference implementation).
  const { cookie } = await startSession(ctx.auth.pool, ctx.auth.session, {
    email,
    accessToken: exchanged.access_token,
    refreshToken: exchanged.refresh_token,
  });

  try {
    await ctx.auth.telemetryStep?.('session_created', { method: 'google' });
  } catch (err) {
    console.error('telemetry step session_created failed (sign-in unaffected):', err);
  }

  // F-13.4 / F-41.3 — DD-62: Google's attestation is the mailbox proof.
  const grant = ctx.grantSignupCredit ?? ((e: string, c: SignupGrantConfig) => grantSignupCreditIfEligible(ctx.auth.pool, e, c));
  try {
    const outcome = await grant(email, {
      grantUsdMicros: ctx.auth.signupGrantUsdMicros ?? 0n,
      proof: exchanged.user?.email_verified_at ? 'google_verified' : 'google_unverified',
    });
    if (outcome.granted && outcome.ledgerId) {
      if (ctx.auth.internalGate?.account(email)) {
        ctx.auth.internalGate.logSuppressed('creator_signed_up', [outcome.ledgerId]);
      } else {
        await ctx.auth.emitAppEvent?.('creator_signed_up', [outcome.ledgerId], {
          grant_usd_micros: Number(ctx.auth.signupGrantUsdMicros ?? 0n),
          source: 'google',
        });
      }
    }
  } catch (err) {
    console.error('signup-grant failed (sign-in unaffected):', err);
  }

  // F-37 / AC-249 — the ceremony-held rider becomes a capture for THIS address,
  // then the same bind-at-establishment the email path runs (window re-checked
  // inside the parse, first-touch inside the bind).
  let bind: BindOutcome = { bound: false };
  if (ctx.auth.attributionEnabled) {
    try {
      const record = ctx.attribution?.record ?? ((e: string, s: AttributionSubmission) => recordAttributionCapture(ctx.auth.pool, e, s));
      const doBind = ctx.attribution?.bind ?? ((e: string) => bindAttributionIfPending(ctx.auth.pool, e));
      const submission = ceremony.gclid ? parseAttributionSubmission(ceremony.gclid, new Date()) : null;
      if (submission) await record(email, submission);
      bind = await doBind(email);
    } catch (err) {
      console.error('attribution bind failed (sign-in unaffected):', err);
    }
  }
  if (bind.bound) {
    await enqueueAdsConversion(
      { pool: ctx.auth.pool, createRun: ctx.auth.createRun, adsUploadFunction: ctx.auth.adsUploadFunction },
      'sign_up',
      email,
      { occurredAt: new Date() },
    );
  }

  // F-41.6 / AC-251 — the ceremony carried a held draft: claim it for the
  // session the ceremony just established. A refusal (no credit, allowlist)
  // NEVER un-signs the visitor — it rides the response for the SPA to route
  // (F-39.4's standard outcomes).
  if (ceremony.draftHandle && ctx.claimCeremonyDraft) {
    try {
      const claim = await ctx.claimCeremonyDraft(ceremony.draftHandle, email);
      return {
        status: 200,
        body: { ok: true, email, claim: { status: claim.status, ...(claim.body as Record<string, unknown>) } },
        setCookies: [cookie],
      };
    } catch (err) {
      console.error('ceremony draft claim failed (sign-in unaffected):', err);
      return { status: 200, body: { ok: true, email, claim: { status: 500 } }, setCookies: [cookie] };
    }
  }

  return { status: 200, body: { ok: true, email }, setCookies: [cookie] };
}

/**
 * F-41.8 (AC-254) — Disconnect Google: remove the creator's own Google identity
 * from their account. Two platform calls, both with the session's server-held
 * token (never the browser's): read the identities to find the google
 * `provider_sub`, then unlink by it.
 *
 * The platform gates this on the actor having authenticated RECENTLY, and a
 * refreshed access token preserves the authentication time of the sign-in it
 * descends from — so a long-lived session (ours is 30 days, refreshed
 * transparently) is effectively never recent enough. That refusal is therefore
 * the NORMAL first answer, not an error: it is mapped to a distinct
 * `auth_reauth_required` so the page can ask for a fresh sign-in in plain
 * words, and no platform code or vendor string reaches the creator.
 */
export async function handleGoogleDisconnect(ctx: GoogleHandlerCtx, actor: SessionActor): Promise<AuthResult> {
  const session = await getAuthSession(ctx.auth.pool, actor.sessionId);
  const bearer = session?.run402_access_token;
  if (!bearer) return SIGNIN_FAILED;

  const headers = {
    'Content-Type': 'application/json',
    apikey: ctx.auth.session.projectAnonKey,
    Authorization: `Bearer ${bearer}`,
  };

  // 1. Which identity? The unlink's `subject` is the provider's subject id
  //    (provider_sub), NOT our user id — a distinction worth naming, because
  //    "subject" reads like the latter.
  let providerSub: string | null = null;
  try {
    const res = await fetchImpl(ctx)(`${run402Base(ctx)}/auth/v1/account/identities`, { headers });
    if (res.status < 200 || res.status >= 300) return SIGNIN_FAILED;
    const body = (await res.json()) as { identities?: Array<{ provider?: string; provider_sub?: string }> };
    providerSub = (body.identities ?? []).find((i) => i?.provider === 'google')?.provider_sub ?? null;
  } catch {
    return SIGNIN_FAILED;
  }
  // Nothing linked is a clean, idempotent outcome — the creator's intent (no
  // Google on this account) already holds.
  if (!providerSub) return { status: 200, body: { ok: true, disconnected: false } };

  try {
    const res = await fetchImpl(ctx)(`${run402Base(ctx)}/auth/v1/account/identities/unlink`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'google', subject: providerSub }),
    });
    if (res.status >= 200 && res.status < 300) {
      return { status: 200, body: { ok: true, disconnected: true } };
    }
    const err = (await res.json().catch(() => ({}))) as { code?: string };
    if (res.status === 401 && err.code === 'R402_AUTH_FRESHNESS_REQUIRED') {
      return {
        status: 401,
        body: {
          error: 'For your security, sign in again before disconnecting Google.',
          code: 'auth_reauth_required',
        },
      };
    }
    return SIGNIN_FAILED;
  } catch {
    return SIGNIN_FAILED;
  }
}
