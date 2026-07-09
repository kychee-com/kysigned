/**
 * api — the routed-HTTP function entry (14.5).
 *
 * run402 routes every `/v1/*` request to this function (a Web `Request` →
 * `Response` handler). `handleRequest` is a PURE function over injected deps so
 * the AUTH GATE — the security boundary — is unit-tested against fakes. The
 * `export default` lazily builds the real prod deps (buildAppDeps + the real
 * `@run402/functions` runtime) once, then delegates.
 *
 * ── The auth gate (read carefully — this is the security boundary) ──────────
 *   matchRoute(method, path) → { name, auth, params } | null   (null → 404)
 *   - `public`        : dispatched with no auth.
 *   - `session`       : TWO modes (DD-28 / F-30.1). An `Authorization` header is
 *                       a bearer ATTEMPT: resolveApiKey → the key's creator
 *                       (CSRF-exempt, fenced to BEARER_ROUTES) or a machine-
 *                       readable 401/403 — never a cookie fallback. Otherwise
 *                       the cookie path: unsafe methods require the CSRF custom
 *                       header (csrfOk) → 403 if absent; then
 *                       resolveSession(cookie) → 401 if no actor; the actor
 *                       (email) is passed to the handler.
 *   - `signer-token`  : NO session; the handler itself validates `params.token`
 *                       (getSignerByToken) — dispatched with params.id + token.
 *
 * Inbound MAILBOX email is NOT a route here (F-29.6): run402 delivers it as a
 * `reply_received` / `bounced` EMAIL-TRIGGER durable run, which `default` detects
 * and dispatches to the run handlers (see below + inboundEmail.ts).
 *
 * Passkey login/* is `public` (the WebAuthn ceremony IS the auth — verify issues
 * the session cookie); passkey register/list/delete are `session` (proxied to
 * run402 with the session's run402 token as the Bearer).
 *
 * Static assets + the SPA are served by run402 (static-file fallback) after a
 * route miss, so only `/v1/*` reaches here.
 */
import { matchRoute } from '../integrations/run402Router.js';
import { csrfOk, resolveSession } from '../api/auth/session.js';
import { resolveApiKey } from '../api/auth/apiKeyAuth.js';
import { handleMintApiKey, handleListApiKeys, handleRevokeApiKey } from '../api/apiKeys.js';
import { withCreateIdempotency } from '../api/idempotentCreate.js';
import { handleX402CreateEnvelope, defaultX402Seams } from '../api/x402Create.js';
import { handleCreatePreflight } from '../api/createPreflight.js';
import { buildHostedSenderGate } from '../api/billingGate.js';
import { handleHealth } from '../api/health.js';
import {
  handleAuthMagicLink,
  handleAuthTokenExchange,
  handleAuthUser,
  handleAuthSignout,
} from '../api/auth/authHandlers.js';
import {
  handlePasskeyLoginOptions,
  handlePasskeyLoginVerify,
  handlePasskeyRegisterOptions,
  handlePasskeyRegisterVerify,
  handlePasskeyList,
  handlePasskeyDelete,
  type PasskeyHandlerCtx,
} from '../api/auth/passkeyHandlers.js';
import {
  handleCreateEnvelope,
  handleGetEnvelope,
  handleVoidEnvelope,
  handleRemind,
  handleListDocuments,
  handleListEnvelopes,
  handleAddSigner,
  handleEditSigner,
  handleDeleteSigner,
  type SignerEditCtx,
} from '../api/envelope.js';
import { handleSealEnvelope } from '../api/sealEnvelope.js';
import { handleSignerInfo, handleSignerPdf } from '../api/signerApi.js';
import { handleGetEnvelopePdfForOwner } from '../api/ownerPdf.js';
import { handleKeyArchiveLookup } from '../api/keyArchiveProxy.js';
import { handleTestResetUser } from '../api/testReset.js';
import { getPdfBlob } from '../db/pdfBlobs.js';
import { getEnvelope } from '../db/envelopes.js';
import {
  handleAddAllowedSender,
  handleRemoveAllowedSender,
  handleListAllowedSenders,
  type AddAllowedSenderRequest,
} from '../api/admin.js';
import type { AppDeps } from './config.js';
import { getRuntimeDeps, getRunDispatcher } from './runtime.js';

/** The deps `handleRequest` consumes. run402 MAILBOX webhooks are unsigned, so
 *  there is no `verifyWebhook` seam — the inbound webhook authenticates by
 *  mailbox_id + the reconciler's authenticated raw-MIME fetch. */
export type RequestDeps = AppDeps;

// ── small response helpers ──────────────────────────────────────────────────

function json(body: unknown, status: number, setCookies?: string[]): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of setCookies ?? []) headers.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}

function pdf(bytes: Uint8Array, status = 200): Response {
  // TS 5.7: `Uint8Array<ArrayBufferLike>` no longer matches `BodyInit` in an
  // overload context; Response accepts the bytes at runtime (see ots/calendar.ts).
  return new Response(bytes as BodyInit, { status, headers: { 'content-type': 'application/pdf' } });
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Body for POST/PUT/PATCH — JSON-parsed, guarded (a bad/empty body → {}). */
async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const m = req.method.toUpperCase();
  if (m !== 'POST' && m !== 'PUT' && m !== 'PATCH') return {};
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Build the passkey-proxy ctx from the request deps (run402 anon key + base
 *  live in sessionConfig; baseUrl is the Origin fallback for the upstream call). */
function passkeyCtx(deps: RequestDeps): PasskeyHandlerCtx {
  return { pool: deps.pool, session: deps.sessionConfig, fallbackOrigin: deps.baseUrl };
}

/** Build the recipient-editing ctx (F-23) from the request deps — the create-flow
 *  storage + email seams, minus the credit gate (editing a paid envelope is free). */
function signerEditCtx(deps: RequestDeps): SignerEditCtx {
  return {
    pool: deps.pool,
    createRun: deps.createRun,
    deliveryBackstop: deps.deliveryBackstop,
    emailProvider: deps.emailProvider,
    baseUrl: deps.baseUrl,
    operatorDomain: deps.operatorDomain,
    unsubscribeMailto: deps.unsubscribeMailto,
    getPdf: deps.getPdf,
    storePdf: deps.storePdf,
    deletePdf: deps.deletePdf,
  };
}

// ── the pure request handler (the security boundary lives here) ─────────────

/**
 * The routes a bearer API key may reach (spec F-30.1 / AC-131): exactly the
 * creator envelope actions of F-12.1. Everything else on the session surface —
 * auth/passkey management, the admin allowlist, and ABOVE ALL key management —
 * stays cookie-only, so a leaked key can neither mint more keys nor touch
 * account credentials (privilege containment).
 */
const BEARER_ROUTES: ReadonlySet<string> = new Set([
  'createEnvelope',
  'listEnvelopes',
  'getEnvelope',
  'remindEnvelope',
  'voidEnvelope',
  'addSigner',
  'editSigner',
  'deleteSigner',
  'sealEnvelope',
  'ownerPdf',
  'listDocuments',
]);

export async function handleRequest(req: Request, deps: RequestDeps): Promise<Response> {
  // TR-018 / AC-137 — top-level error boundary. An unexpected throw from the auth
  // gate or ANY dispatched handler becomes a clean, taxonomy-coded 500
  // (`internal_error`), never the run402 platform's uncoded "Internal function
  // error". The error is logged for ops; the targeted guards still return the
  // correct 4xx for known conditions (F-015 → 409, F-017 → 400) — this only
  // backstops genuinely-unexpected failures so the /v1 error contract can never
  // regress to an un-coded body (system-test Cycle 14: F-015/F-017 were two
  // instances of an uncaught throw surfacing as an uncoded platform 500).
  try {
    return await dispatchRequest(req, deps);
  } catch (err) {
    let path = req.url;
    try { path = new URL(req.url).pathname; } catch { /* non-parseable url — log the raw value */ }
    console.error(`[api] unhandled error on ${req.method} ${path}:`, err);
    return json({ error: 'Internal error', code: 'internal_error' }, 500);
  }
}

async function dispatchRequest(req: Request, deps: RequestDeps): Promise<Response> {
  const method = req.method.toUpperCase();
  const url = new URL(req.url);
  const path = url.pathname;

  const route = matchRoute(method, path);
  if (!route) return json({ error: 'Not found', code: 'not_found' }, 404);

  const { name, auth, params } = route;
  const cookies = parseCookies(req.headers.get('cookie'));

  // ── AUTH GATE ──────────────────────────────────────────────────────────────
  // public: no auth.
  // session: TWO modes (DD-28 / spec F-30.1).
  //   • bearer — an `Authorization` header is an explicit bearer ATTEMPT: it must
  //     resolve (→ the key's creator, CSRF-EXEMPT since CSRF defends the cookie's
  //     ambient authority, which a bearer request never carries) or fail with a
  //     machine-readable 401 (`auth_invalid_key`) — it NEVER falls back to the
  //     cookie. Keys are fenced to the creator envelope actions (BEARER_ROUTES);
  //     anything else — key management above all — answers 403 `auth_key_scope`.
  //   • cookie — unchanged: resolve the cookie → actor FIRST (→401), THEN CSRF on
  //     unsafe methods (→403). Authentication precedes CSRF so an unauthenticated
  //     caller can never be told (via a 403) that a route exists and needs CSRF
  //     before they have proven they are authenticated — an unauthenticated
  //     request is always a flat 401 regardless of the CSRF header (system-test
  //     F-001 / AC-5 / AC-32).
  let actorEmail: string | null = null;
  let actorSessionId: string | null = null;
  if (auth === 'session') {
    const authz = req.headers.get('authorization');
    if (authz !== null && authz.trim() !== '') {
      if (!BEARER_ROUTES.has(name)) {
        return json({ error: 'API key not allowed for this action', code: 'auth_key_scope' }, 403);
      }
      const keyActor = await resolveApiKey(deps.pool, authz);
      if (!keyActor) {
        return json({ error: 'Authentication required', code: 'auth_invalid_key' }, 401);
      }
      actorEmail = keyActor.email;
    } else {
      const actor = await resolveSession(deps.pool, deps.sessionConfig, cookies);
      if (!actor) return json({ error: 'Authentication required', code: 'auth_required' }, 401);
      if (!csrfOk(method, req.headers)) {
        return json({ error: 'CSRF check failed', code: 'csrf_failed' }, 403);
      }
      actorEmail = actor.email;
      actorSessionId = actor.sessionId;
    }
  }
  // F-29.6 — inbound MAILBOX email is no longer an app webhook route: run402
  // creates a `reply_received` / `bounced` durable run via an EMAIL TRIGGER,
  // dispatched by `default` → `defineFunctionRuns` (see inboundEmail.ts).
  // signer-token: no session; each handler validates params.token itself.

  // ── DISPATCH ─────────────────────────────────────────────────────────────────
  switch (name) {
    // ── health (public) ──
    case 'health': {
      const r = handleHealth();
      return json(r.body, r.status);
    }

    // ── F-28 test-account reset (public route; secret + pattern gate in-handler) ──
    case 'testResetUser': {
      const body = await readJsonBody(req);
      const r = await handleTestResetUser(
        { pool: deps.pool, resetSecret: deps.testResetSecret, identityPattern: deps.testResetPattern },
        {
          email: typeof body.email === 'string' ? body.email : '',
          secret: req.headers.get('x-test-reset-secret') ?? '',
        },
      );
      return json(r.body, r.status);
    }

    // ── auth (public pre-session; session for user/signout) ──
    case 'authMagicLink': {
      const r = await handleAuthMagicLink(deps.authCtx(), await readJsonBody(req));
      return json(r.body, r.status, r.setCookies);
    }
    case 'authToken': {
      const r = await handleAuthTokenExchange(deps.authCtx(), await readJsonBody(req));
      return json(r.body, r.status, r.setCookies);
    }
    case 'authUser': {
      const r = await handleAuthUser(deps.authCtx(), { email: actorEmail!, sessionId: actorSessionId! });
      return json(r.body, r.status, r.setCookies);
    }
    case 'authSignout': {
      const r = await handleAuthSignout(deps.authCtx(), { email: actorEmail!, sessionId: actorSessionId! });
      return json(r.body, r.status, r.setCookies);
    }

    // ── passkeys (WebAuthn proxied to run402 — F-18.1) ──
    // login/* is public (the ceremony is the auth; verify issues the session
    // cookie). register/list/delete are session-authed → the gate has already
    // resolved actorSessionId; the handler reads the run402 token off that row.
    case 'passkeyLoginOptions': {
      const r = await handlePasskeyLoginOptions(passkeyCtx(deps), await readJsonBody(req));
      return json(r.body, r.status, r.setCookies);
    }
    case 'passkeyLoginVerify': {
      const r = await handlePasskeyLoginVerify(passkeyCtx(deps), await readJsonBody(req));
      return json(r.body, r.status, r.setCookies);
    }
    case 'passkeyRegisterOptions': {
      const r = await handlePasskeyRegisterOptions(passkeyCtx(deps), actorSessionId!, await readJsonBody(req));
      return json(r.body, r.status);
    }
    case 'passkeyRegisterVerify': {
      const r = await handlePasskeyRegisterVerify(passkeyCtx(deps), actorSessionId!, await readJsonBody(req));
      return json(r.body, r.status);
    }
    case 'passkeyList': {
      const r = await handlePasskeyList(passkeyCtx(deps), actorSessionId!);
      return json(r.body, r.status);
    }
    case 'passkeyDelete': {
      const r = await handlePasskeyDelete(passkeyCtx(deps), actorSessionId!, params.id!);
      if (r.status === 204) return new Response(null, { status: 204 });
      return json(r.body, r.status);
    }

    // ── #129 — free create pre-validation (public; no charge, no create) ──
    case 'createPreflight': {
      const body = await readJsonBody(req);
      const r = await handleCreatePreflight(body as Record<string, unknown>);
      return json(r.body, r.status);
    }

    // ── F-30.2 — the x402 always-priced create (public: payment IS the auth) ──
    case 'x402CreateEnvelope': {
      // Fork-inert: without operator x402 config the path (reached through the
      // /v1/* catch-all on unpriced deployments) answers a clean coded 404.
      if (!deps.x402) {
        return json({ error: 'x402 payments are not enabled on this instance', code: 'payment_x402_not_enabled' }, 404);
      }
      const cfg = deps.x402;
      // The gateway-settled context (platform-owned headers; clients stripped
      // at the gateway). No session/key/CSRF is consulted on this route.
      const payment = deps.readPaymentContext ? deps.readPaymentContext(req) : null;
      const body = await readJsonBody(req);
      // The paid create ALWAYS runs credit-backed at the route's price (DD-29):
      // the settled payment credits the ledger, the create debits it — even on
      // a fork whose global billing mode is unset.
      const seams = defaultX402Seams(deps.pool, cfg, (creatorEmail) => ({
        ...deps.apiContext(creatorEmail),
        senderGate: buildHostedSenderGate(deps.pool, cfg.priceUsdMicros),
      }));
      // #128 — run402 paid-function idempotency: honor a caller-supplied key.
      // Prefer the platform-forwarded, gateway-trusted `x-run402-idempotency-key`
      // (set by run402 when it starts propagating it on billed routes); fall back
      // to a plain `idempotency-key` the gateway passes through today. Absent →
      // the handler keys on the settled payment_id.
      const idemKey =
        req.headers.get('x-run402-idempotency-key') ?? req.headers.get('idempotency-key');
      const r = await handleX402CreateEnvelope(cfg, payment, seams, body as Record<string, unknown>, idemKey);
      return json(r.body, r.status);
    }

    // ── envelopes (creator, session) ──
    case 'createEnvelope': {
      const body = await readJsonBody(req);
      // F-30.3 / AC-136 — an Idempotency-Key header makes the create replay-safe:
      // a retried create returns the SAME envelope with exactly one debit. No
      // header → unchanged. The payload identity is the stable serialization of
      // the parsed body (a genuine agent retry resends identical JSON).
      const r = await withCreateIdempotency(
        { pool: deps.pool },
        actorEmail!,
        req.headers.get('idempotency-key'),
        JSON.stringify(body),
        async () => {
          const inner = await handleCreateEnvelope(deps.apiContext(actorEmail!), body as never);
          return { status: inner.status, body: inner.body };
        },
      );
      return json(r.body, r.status);
    }
    case 'getEnvelope': {
      // Creator-scoped: handleGetEnvelope 404s if the envelope's sender_email is
      // not the authed actor (no IDOR — the signer roster is PII).
      const r = await handleGetEnvelope({ pool: deps.pool, baseUrl: deps.baseUrl }, params.id!, actorEmail!);
      return json(r.body, r.status);
    }
    case 'remindEnvelope': {
      const r = await handleRemind(deps.reminderSendCtx(), params.id!, actorEmail!);
      return json(r.body, r.status);
    }
    case 'voidEnvelope': {
      // F-002: pass the FULL apiContext (which carries senderGate when hosted
      // billing is active) so the refund block runs — a hand-built ctx dropped
      // senderGate, making refundCredit dead code (every void returned refunded:false).
      const r = await handleVoidEnvelope(deps.apiContext(actorEmail!), params.id!, actorEmail!);
      return json(r.body, r.status);
    }
    // ── recipient editing until seal (F-23) + manual seal (F-24) ──
    case 'addSigner': {
      const body = await readJsonBody(req);
      const r = await handleAddSigner(signerEditCtx(deps), params.id!, actorEmail!, body as never);
      return json(r.body, r.status);
    }
    case 'editSigner': {
      // The signer being edited is identified by ?email= (an address is messy in a
      // path); the new name/org/message (+ optional new_email) come in the body.
      const body = await readJsonBody(req);
      const r = await handleEditSigner(signerEditCtx(deps), params.id!, actorEmail!, url.searchParams.get('email') ?? '', body as never);
      return json(r.body, r.status);
    }
    case 'deleteSigner': {
      const r = await handleDeleteSigner(signerEditCtx(deps), params.id!, actorEmail!, url.searchParams.get('email') ?? '');
      return json(r.body, r.status);
    }
    case 'sealEnvelope': {
      const r = await handleSealEnvelope(deps.pool, params.id!, actorEmail!, deps.distributeDeps());
      return json(r.body, r.status);
    }
    case 'ownerPdf': {
      const result = await handleGetEnvelopePdfForOwner(
        {
          getEnvelope: async (id) => {
            const e = await getEnvelope(deps.pool, id);
            if (!e) return null;
            return {
              id: e.id,
              sender_email: e.sender_email,
              document_name: e.document_name,
              document_hash: e.document_hash,
              status: e.status,
              pdf_storage_key: e.pdf_storage_key,
              pdf_deleted_at: e.pdf_deleted_at ? e.pdf_deleted_at.toISOString() : null,
              completed_at: e.completed_at ? e.completed_at.toISOString() : null,
            };
          },
          getPdfBlob: (key) => getPdfBlob(deps.pool, key),
        },
        params.id!,
        actorEmail,
      );
      if (result.ok) return pdf(result.bytes);
      // The taxonomy `code` (F-30.3) rides along from the handler's result.
      const errBody = { code: result.code, error: result.error };
      return json(result.context ? { ...errBody, ...result.context } : errBody, result.status);
    }
    case 'listDocuments': {
      const r = await handleListDocuments({ pool: deps.pool }, actorEmail!);
      return json(r.body, r.status);
    }
    case 'listEnvelopes': {
      // Creator-scoped: lists the AUTHED creator's envelopes (getEnvelopesBySender on
      // actorEmail) — no email param is read, so there is no IDOR. Drives the MCP
      // `list_envelopes` tool (was 404ing against a non-existent /v1/envelopes).
      const r = await handleListEnvelopes({ pool: deps.pool }, actorEmail!);
      return json(r.body, r.status);
    }

    // ── signer (no account — per-signer token; the handler validates it) ──
    case 'signInfo': {
      const r = await handleSignerInfo(deps.signerCtx(), params.id!, params.token!);
      return json(r.body, r.status);
    }
    case 'signerPdf': {
      const r = await handleSignerPdf(deps.signerCtx(), params.id!, params.token!);
      if (r.status === 200 && r.bytes) return pdf(r.bytes);
      return json(r.body ?? { error: 'Document not available', code: 'not_found' }, r.status);
    }

    // ── verifier support: key-archive lookup proxy (public; F-10.8) ──
    // Forwards the web verifier's PUBLIC (domain, selector) DKIM-key lookup to
    // archive.prove.email server-side (the archive has no CORS, so the browser
    // can't call it directly). Additive — never gates the client-side verdict.
    case 'keyArchive': {
      const r = await handleKeyArchiveLookup({}, url.searchParams.get('domain'), url.searchParams.get('selector'));
      return json(r.body, r.status);
    }

    // ── admin allowlist (session; operator-gated in the handler) ──
    case 'listAllowedSenders': {
      const r = await handleListAllowedSenders(deps.adminCtx(actorEmail!));
      return json(r.body, r.status);
    }
    case 'addAllowedSender': {
      const body = (await readJsonBody(req)) as unknown as AddAllowedSenderRequest;
      const r = await handleAddAllowedSender(deps.adminCtx(actorEmail!), body);
      return json(r.body, r.status);
    }
    case 'removeAllowedSender': {
      // The route carries the allowlist row id; identity_type + identity come from
      // the query string (the SPA passes them alongside the row id).
      const identityType = url.searchParams.get('identity_type') ?? '';
      const identity = url.searchParams.get('identity') ?? params.id!;
      const r = await handleRemoveAllowedSender(
        deps.adminCtx(actorEmail!),
        identityType as never,
        identity,
      );
      return json(r.body, r.status);
    }

    // ── F-30.1 creator API keys (session-ONLY; fenced out of BEARER_ROUTES) ──
    case 'mintApiKey': {
      const r = await handleMintApiKey({ pool: deps.pool }, actorEmail!, await readJsonBody(req));
      return json(r.body, r.status);
    }
    case 'listApiKeys': {
      const r = await handleListApiKeys({ pool: deps.pool }, actorEmail!);
      return json(r.body, r.status);
    }
    case 'revokeApiKey': {
      const r = await handleRevokeApiKey({ pool: deps.pool }, actorEmail!, params.id!);
      return json(r.body, r.status);
    }

    default:
      // Unreachable: every route in API_ROUTES has a case above. A new route
      // without a handler lands here as a hard 500 (caught in dev/tests).
      return json({ error: `No handler for route ${name}`, code: 'internal_error' }, 500);
  }
}

// ── the deployed-function entry ──────────────────────────────────────────────
// The real run402 runtime (adminDb + SDK client) is built ONCE in runtime.ts
// (the only allowed runtime import of @run402/*). The structural seams keep the
// rest of src/ free of those packages; a unit test of handleRequest never loads
// them.

let _deps: RequestDeps | null = null;

/** True when an invocation body is a run402 durable-run envelope (F-29). run402
 *  invokes this same function with `{ trigger: "function_run", … }` when a run
 *  fires; everything else is a routed HTTP request. A local structural check (no
 *  `@run402/*` import) keeps `handleRequest` unit-testable. */
function isFunctionRunBody(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && (body as { trigger?: unknown }).trigger === 'function_run';
}

export default async function (req: Request): Promise<Response> {
  if (!_deps) {
    _deps = await getRuntimeDeps();
  }
  // F-29 — a durable run arrives as a POST whose body is the run envelope. Peek a
  // clone (leaving `req` intact for the HTTP path) and, if it's a run, dispatch to
  // the run handlers instead of the router.
  if (req.method.toUpperCase() === 'POST') {
    let body: unknown = null;
    try {
      body = await req.clone().json();
    } catch {
      /* not a JSON body — a routed HTTP request; fall through */
    }
    if (isFunctionRunBody(body)) {
      const dispatch = await getRunDispatcher(_deps);
      return dispatch(body);
    }
  }
  return handleRequest(req, _deps);
}
