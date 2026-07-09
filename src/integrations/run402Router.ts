/**
 * run402Router — the route table + matcher for the run402-function entry (14.5).
 *
 * Pure path/method → {name, auth, params}. The entry consults `auth` to apply the
 * right gate before dispatching to the `src/api/*` handler:
 *   - `public`       — no auth (health, pre-session auth, public verify)
 *   - `session`      — the `kysigned_session` cookie → creator email (401 if absent)
 *   - `signer-token` — the per-signer `:token` (no account)
 *   - `webhook-*`    — verified by signature (run402 inbound webhook)
 *
 * Static assets + SPA routes are NOT here — run402 serves materialized static
 * files (and SPA-fallbacks to index.html) after a route miss, so only the `/v1/*`
 * API surface is routed to this function.
 *
 * BILLING IS NOT HERE. The public forker app gates creation by the credit balance /
 * allowlist only (no service-to-user payment). kysigned.com's credit-packs
 * (`/v1/credits/*` + the payment-provider webhook) are PROPRIETARY and live in
 * the operator's private billing function, plugged in via the public `createGate` credit
 * seam. The provider webhook authenticates itself (its own signature), so it needs no
 * AuthMode here.
 */
import { X402_CREATE_ROUTE } from '../api/createGate.js';

export type AuthMode = 'public' | 'session' | 'signer-token';

export interface RouteDef {
  method: string;
  /** Pattern with `:param` segments, e.g. `/v1/envelope/:id/remind`. */
  pattern: string;
  name: string;
  auth: AuthMode;
}

export interface RouteMatch {
  name: string;
  auth: AuthMode;
  params: Record<string, string>;
}

/**
 * The complete `/v1/*` route table. Ordering is not significant — segment-count +
 * literal matching makes every entry unambiguous (no generic param-last route
 * shadows a literal one).
 */
export const API_ROUTES: RouteDef[] = [
  // ── health ──────────────────────────────────────────────────────────────
  { method: 'GET', pattern: '/v1/health', name: 'health', auth: 'public' },

  // ── auth (DD-72 cookie session) ─────────────────────────────────────────
  { method: 'POST', pattern: '/v1/auth/magic-link', name: 'authMagicLink', auth: 'public' },
  { method: 'POST', pattern: '/v1/auth/token', name: 'authToken', auth: 'public' },
  { method: 'GET', pattern: '/v1/auth/user', name: 'authUser', auth: 'session' },
  { method: 'POST', pattern: '/v1/auth/signout', name: 'authSignout', auth: 'session' },
  // passkeys (F-18.1 passkey-first) — kysigned does NOT implement WebAuthn; these
  // proxy to run402's `/auth/v1/passkeys/*` (run402 owns the relying-party logic).
  // login/* is public (the ceremony IS the auth; verify issues the session
  // cookie); register/list/delete are session-authed (the session's run402 token
  // is the upstream Bearer). See api/auth/passkeyHandlers.ts.
  { method: 'POST', pattern: '/v1/auth/passkeys/login/options', name: 'passkeyLoginOptions', auth: 'public' },
  { method: 'POST', pattern: '/v1/auth/passkeys/login/verify', name: 'passkeyLoginVerify', auth: 'public' },
  { method: 'POST', pattern: '/v1/auth/passkeys/register/options', name: 'passkeyRegisterOptions', auth: 'session' },
  { method: 'POST', pattern: '/v1/auth/passkeys/register/verify', name: 'passkeyRegisterVerify', auth: 'session' },
  { method: 'GET', pattern: '/v1/auth/passkeys', name: 'passkeyList', auth: 'session' },
  { method: 'DELETE', pattern: '/v1/auth/passkeys/:id', name: 'passkeyDelete', auth: 'session' },

  // ── envelopes (creator, session) — note the SINGULAR /v1/envelope ───────
  { method: 'POST', pattern: '/v1/envelope', name: 'createEnvelope', auth: 'session' },
  // #129 — FREE deterministic pre-validation of a create body (no charge, no
  // create). Public so a wallet/x402 agent can validate inputs BEFORE paying the
  // x402 create (which settles before app validation runs). Unambiguous: no
  // other POST /v1/envelope/<one-segment> route exists.
  { method: 'POST', pattern: '/v1/envelope/preflight', name: 'createPreflight', auth: 'public' },
  // Plural list (the creator's own envelopes, session-scoped) — distinct from the
  // singular create/get above and from /v1/documents (which groups by upload hash).
  { method: 'GET', pattern: '/v1/envelopes', name: 'listEnvelopes', auth: 'session' },
  { method: 'GET', pattern: '/v1/envelope/:id', name: 'getEnvelope', auth: 'session' },
  { method: 'POST', pattern: '/v1/envelope/:id/remind', name: 'remindEnvelope', auth: 'session' },
  { method: 'POST', pattern: '/v1/envelope/:id/void', name: 'voidEnvelope', auth: 'session' },
  // F-23 recipient editing (until seal) + F-24 manual seal. add/edit/delete share
  // /signers (method-distinguished); the signer email for edit/delete rides in
  // `?email=` (an address is messy in a path segment). seal = the manual "Seal & send".
  { method: 'POST', pattern: '/v1/envelope/:id/signers', name: 'addSigner', auth: 'session' },
  { method: 'PATCH', pattern: '/v1/envelope/:id/signers', name: 'editSigner', auth: 'session' },
  { method: 'DELETE', pattern: '/v1/envelope/:id/signers', name: 'deleteSigner', auth: 'session' },
  { method: 'POST', pattern: '/v1/envelope/:id/seal', name: 'sealEnvelope', auth: 'session' },
  { method: 'GET', pattern: '/v1/envelope/:id/pdf', name: 'ownerPdf', auth: 'session' },
  { method: 'GET', pattern: '/v1/documents', name: 'listDocuments', auth: 'session' },

  // ── F-30.2 — the dedicated always-priced x402 create (spec 0.39.0) ────────
  // PUBLIC at the router: the gateway settles the payment BEFORE invoking the
  // fn and the settled context IS the authorization (no session/key/CSRF). On
  // a deployment whose operator declared the priced route, this path never
  // reaches the fn unpaid (the gateway 402-challenges first); reached through
  // the /v1/* catch-all on an unpriced deployment, the handler refuses cleanly
  // (fork-inert without operator x402 config).
  { method: 'POST', pattern: X402_CREATE_ROUTE, name: 'x402CreateEnvelope', auth: 'public' },

  // NOTE: /v1/credits/* (balance, checkout) is NOT a public route — it's
  // kysigned.com-proprietary billing, served by the operator's private billing
  // function. The forker app has no service-to-user payment.

  // ── signer (no account — per-signer token) ───────────────────────────────
  { method: 'GET', pattern: '/v1/sign/:id/:token/info', name: 'signInfo', auth: 'signer-token' },
  { method: 'GET', pattern: '/v1/envelope/:id/:token/pdf', name: 'signerPdf', auth: 'signer-token' },

  // NOTE: there is NO server-side public-verify endpoint. Verification (F-10) is
  // fully client-side: the SPA's static `/verify` page runs `verifyBundleWeb`
  // over the bundle PDF the user holds (no API round-trip, no per-envelope
  // server state). The previous `GET /v1/verify/:id` route had no handler in the
  // repo, so it is intentionally omitted rather than stubbed (14.5).
  //
  // ── verifier support: key-archive lookup proxy (F-10.8) ───────────────────
  // The web verifier's key-archive check can't call archive.prove.email
  // cross-origin (the archive serves no CORS headers), so it calls this
  // same-origin proxy, which forwards the PUBLIC (domain, selector) lookup
  // server-side. Additive — never gates the (client-side) verdict; the CLI
  // queries the archive directly. Forwards only domain+selector, never the file.
  { method: 'GET', pattern: '/v1/key-archive', name: 'keyArchive', auth: 'public' },

  // ── admin allowlist (session, operator-gated in the handler) ─────────────
  { method: 'GET', pattern: '/v1/admin/allowed-senders', name: 'listAllowedSenders', auth: 'session' },
  { method: 'POST', pattern: '/v1/admin/allowed-senders', name: 'addAllowedSender', auth: 'session' },
  { method: 'DELETE', pattern: '/v1/admin/allowed-senders/:id', name: 'removeAllowedSender', auth: 'session' },

  // ── F-30.1 creator API keys (session-ONLY: a bearer key cannot manage keys) ──
  { method: 'POST', pattern: '/v1/api-keys', name: 'mintApiKey', auth: 'session' },
  { method: 'GET', pattern: '/v1/api-keys', name: 'listApiKeys', auth: 'session' },
  { method: 'DELETE', pattern: '/v1/api-keys/:id', name: 'revokeApiKey', auth: 'session' },

  // F-29.6 — inbound MAILBOX email has NO route: run402 delivers it as a
  // `reply_received` / `bounced` EMAIL-TRIGGER durable run (see inboundEmail.ts).
  // (The payment-provider webhook is proprietary → the operator's private billing fn, not here.)

  // ── F-28 `[service]` — test-only account reset (secret-gated IN THE HANDLER) ──
  // `public` at the router (no session/signature); handleTestResetUser enforces the
  // `x-test-reset-secret` header + the identity pattern and 404s when unconfigured,
  // so the route is invisible on any deploy (incl. every forker) without the secret.
  { method: 'POST', pattern: '/v1/test/reset-user', name: 'testResetUser', auth: 'public' },
];

/** Match a method + path to a route. GET routes also match HEAD. */
export function matchRoute(method: string, path: string, routes: RouteDef[] = API_ROUTES): RouteMatch | null {
  const m = method.toUpperCase();
  for (const r of routes) {
    const methodOk = r.method === m || (m === 'HEAD' && r.method === 'GET');
    if (!methodOk) continue;
    const params = matchPattern(r.pattern, path);
    if (params) return { name: r.name, auth: r.auth, params };
  }
  return null;
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split('/');
  // normalize a trailing slash (but keep root '/'): '/v1/health/' ≡ '/v1/health'
  const norm = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const tp = norm.split('/');
  if (pp.length !== tp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i]!;
    if (seg.startsWith(':')) {
      const v = tp[i]!;
      if (v === '') return null; // an empty param segment is not a match
      try {
        params[seg.slice(1)] = decodeURIComponent(v);
      } catch {
        params[seg.slice(1)] = v;
      }
    } else if (seg !== tp[i]) {
      return null;
    }
  }
  return params;
}
