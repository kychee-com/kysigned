/**
 * config — production wiring for the run402-function entry (14.5).
 *
 * `buildAppDeps(env)` reads the function's environment and constructs the real
 * prod deps the routed-HTTP entry (`api.ts`) and the cron functions (`crons.ts`)
 * consume: the run402 SDK email client, the HTTP DB pool over `adminDb().sql`,
 * the session config, the PDF blob seams, and the per-request ctx factories.
 *
 * ── run402 surface is STRUCTURALLY typed here ──────────────────────────────
 * The rest of `src/` already structural-types run402 (`run402Db.ts`,
 * `run402Email.ts`) so the library code carries no direct `@run402/*` import.
 * `@run402/sdk` is a DECLARED dependency (published to npm — the public run402
 * service — so a forker's `npm install` and the operator deploy both resolve it
 * cleanly, no sibling-repo checkout; it is bundled into the deployed function).
 * `@run402/functions` stays a runtime-provided external — the run402 platform
 * injects it into the deployed function (`external` in the deploy bundle, never
 * installed), with ambient types in `src/types/run402-runtime.d.ts`. So this
 * module declares the tiny surface it uses
 * (`adminDb().sql`, the SDK `Run402` client's `.email`) as structural types and
 * accepts them through an injected `Run402Runtime`. The function-entry's
 * `export default` provides the real runtime (see `api.ts` / `crons.ts`), which
 * `import`s `@run402/functions` + `@run402/sdk` — the only place runtime imports
 * of those packages are allowed, alongside `scripts/`.
 *
 * The credit gate is CONFIG-GATED (F-13 `[service]`). A forker leaves
 * `KYSIGNED_BILLING` unset → the credit seam stays unwired → creation is gated
 * by the F-3.6 allowlist (no service-to-user payment). kysigned.com (operator
 * #1) sets `KYSIGNED_BILLING=hosted` → `buildAppDeps` wires the `createGate`
 * credit seam to the local ledger (`userCredits`), so `POST /v1/envelope`
 * enforces the 402-on-insufficient-credit (AC-5) and debits one flat credit on
 * success (AC-33). The payment-provider TOP-UP that funds the ledger (checkout +
 * webhook keys) is the private `[service]` activation — not in this forkable wiring.
 */
import type { DbPool } from '../db/pool.js';
import type { EmailProvider } from '../email/types.js';
import type { ApiContext } from '../api/envelope.js';
import type { AuthHandlerCtx } from '../api/auth/authHandlers.js';
import type { AdminContext } from '../api/admin.js';
import type { SignerApiCtx } from '../api/signerApi.js';
import type { SessionConfig } from '../api/auth/session.js';
import type { Envelope, EnvelopeSigner } from '../db/types.js';
import type { PreparedBundle } from '../api/distributeBundle.js';
import type { InboundEmailCtx } from '../api/signing/inboundEmail.js';
import type { DistributeBundleDeps } from '../api/distributeBundle.js';
import type { ReminderSendCtx } from '../api/envelope.js';
import type { ExpirationStorage } from '../api/envelope.js';
import type { TimestampProvider } from '../timestamp/contract.js';
import type { CreateRun } from './runs.js';
import type { X402Config } from '../api/x402Create.js';
import type { RoutedHttpPaymentContextV1 } from '@run402/functions';

import { Buffer } from 'node:buffer';
import { createHttpDbPool, type Run402AdminDb } from '../integrations/run402Db.js';
import {
  createRunEmailProvider,
  createFetchRawMime,
  defaultMailboxForFrom,
  type Run402EmailClient,
} from '../integrations/run402Email.js';
import { getPdfBlob, storePdfBlob, deletePdfBlob } from '../db/pdfBlobs.js';
import { getSignatureArtifact } from '../db/signatureArtifacts.js';
import { resolveSenderGate } from '../api/billingGate.js';
import { DEFAULT_ENVELOPE_COST_USD_MICROS } from '../api/createGate.js';
import { createDefaultTimestampAssemblyDeps } from '../api/signing/timestampProviders.js';
import { createOtsProvider } from '../timestamp/ots/provider.js';
import { assembleBundle } from '../bundle/assembleBundle.js';
import { resolveDocumentKey } from '../pdf/documentKey.js';
import type { BundleSignerInput } from '../bundle/types.js';

// ── The run402 runtime surface (structural) ────────────────────────────────
// The deployed-function entry injects the real `@run402/functions` adminDb()
// + a real `@run402/sdk` `Run402` client. Both are captured structurally so this
// module — and everything it imports — stays free of the run402 packages.

/** The `@run402/sdk` `Run402` client, narrowed to the namespaces kysigned uses. */
export type Run402SdkClient = Run402EmailClient;

/** Everything the function entry hands `buildAppDeps` from the real runtime. */
export interface Run402Runtime {
  /** `adminDb()` from `@run402/functions` (service_role HTTP SQL). */
  adminDb: Run402AdminDb;
  /** A constructed `@run402/sdk` `Run402` client (its `.email` is used). */
  sdk: Run402SdkClient;
  /**
   * F-29 — create a run402 durable function run over `@run402/functions`'
   * `functions.runs.create('kysigned-api', …)`. The entry builds this (it needs
   * the runtime package + an active run402 context); the pure layer only calls it.
   */
  createRun: CreateRun;
  /**
   * F-30.2 — `getRoutedPaymentContext` from `@run402/functions`: parse the
   * gateway-settled tenant x402 payment context off a routed request (the
   * platform-owned `x-run402-payment-*` headers; clients cannot supply them —
   * the gateway strips inbound `x-run402-*`). Optional: absent on runtimes
   * predating tenant x402.
   */
  readPaymentContext?: (req: Request) => RoutedHttpPaymentContextV1 | null;
}

// ── Env ────────────────────────────────────────────────────────────────────

/** The function environment kysigned reads. Documented for the deploy. */
export interface AppEnv {
  /** run402 API base. Default `https://api.run402.com`. */
  RUN402_API_BASE?: string;
  /** run402 API base generated by app-aware `run402 up`. */
  RUN402_API_BASE_URL?: string;
  /** run402 project id (required at runtime for email send / raw fetch). */
  RUN402_PROJECT_ID?: string;
  /** run402 service key (service_role) — used by the SDK client the entry builds. */
  RUN402_SERVICE_KEY?: string;
  /** run402 project anon key — required for the server-side token refresh (F-18.1). */
  RUN402_ANON_KEY?: string;
  /** Public app/SPA origin, e.g. `https://kysigned.com`. */
  KYSIGNED_BASE_URL?: string;
  /** Public app/SPA origin generated by app-aware `run402 up`. */
  RUN402_PUBLIC_ORIGIN?: string;
  /** Operator apex for From/links, e.g. `kysigned.com`. */
  KYSIGNED_OPERATOR_DOMAIN?: string;
  /** Exact signing mailbox address. Defaults to forward-to-sign@<operatorDomain>. */
  KYSIGNED_SIGNING_EMAIL?: string;
  /** Optional cookie Domain (e.g. `.kysigned.com`); omit for a host-only cookie. */
  KYSIGNED_COOKIE_DOMAIN?: string;
  /** Optional comma-list of creator emails allowed to create envelopes (F-3.6). */
  KYSIGNED_ALLOWED_CREATORS?: string;
  /** Optional comma-list of login-email domains allowed internal-test envelopes (F-3.7). */
  KYSIGNED_INTERNAL_TEST_DOMAINS?: string;
  /** F-33.1 `[both]` — optional comma-list of operator emails (the `/admin` operator surface). Empty/unset = fail-closed (no operators). */
  KYSIGNED_OPERATOR_EMAILS?: string;
  /**
   * Our signing mailbox id (the `forward-to-sign` mailbox). run402 MAILBOX
   * webhooks are UNSIGNED, so the inbound webhook authenticates by the payload
   * `mailbox_id` matching this (F-6.9) + the reconciler's service-key-scoped
   * raw-MIME re-fetch. Optional — unset accepts any mailbox.
   */
  KYSIGNED_SIGNING_MAILBOX_ID?: string;
  /** Generated `forward-to-sign` mailbox id from app-aware `run402 up`. */
  RUN402_MAILBOX_FORWARD_TO_SIGN_ID?: string;
  /** Generated `forward-to-sign` mailbox address from app-aware `run402 up`. */
  RUN402_MAILBOX_FORWARD_TO_SIGN_ADDRESS?: string;
  /** Core mailbox id used for notification-class mail (`notifications@...`). */
  KYSIGNED_NOTIFICATION_MAILBOX_ID?: string;
  /** Generated `notifications` mailbox id from app-aware `run402 up`. */
  RUN402_MAILBOX_NOTIFICATIONS_ID?: string;
  /** Generated `notifications` mailbox address from app-aware `run402 up`. */
  RUN402_MAILBOX_NOTIFICATIONS_ADDRESS?: string;
  /**
   * F-13 `[service]` billing mode. `hosted` (kysigned.com / operator #1) wires the
   * createGate credit seam to the local ledger → creation enforces the 402 (AC-5)
   * + debits one flat credit (AC-33). Unset/`allowlist` (forker default) leaves
   * the seam unwired — creation is gated by the F-3.6 allowlist only.
   */
  KYSIGNED_BILLING?: string;
  /** Flat per-envelope cost override (USD micros). Default 250_000 = $0.25 (F-13.1). */
  KYSIGNED_ENVELOPE_COST_USD_MICROS?: string;
  /**
   * F-30.2 `[service]` — the x402 create route's fixed price (USD micros).
   * Presence (a positive integer) ENABLES the dedicated always-priced create
   * (`POST /v1/x402/envelope`); a forker leaves it unset → the route answers
   * `payment_x402_not_enabled` (fork-inert, F-13 posture). Must equal the
   * priced-route `pricing.amount_usd_micros` the operator deploy declares.
   */
  KYSIGNED_X402_PRICE_USD_MICROS?: string;
  /**
   * F-30.2 `[service]` — optional expected payout wallet. When set, a settled
   * context whose `payTo` differs fails closed (`payment_x402_mismatch`) —
   * belt-and-suspenders against payout drift.
   */
  KYSIGNED_X402_PAY_TO?: string;
  /**
   * F-6.2a — `'true'` enforces the SPF/DMARC anti-spoof REJECTION on a hard FAIL.
   * Default (unset) = record-only: the SES verdicts are still persisted (AC-62),
   * but a FAIL never blocks signing (DKIM stays the primary gate).
   */
  KYSIGNED_ENFORCE_SENDER_AUTH?: string;
  /**
   * F-13.4 `[service]` — new-account trial credit, in ENVELOPE CREDITS. kysigned.com
   * sets `4` (= $1.00 = 4 envelopes), so a new account opens funded and can sign
   * without a credit card. Unset/`0` (the forker default) disables the grant. The
   * grant fires once at the first magic-link-confirmed sign-in (F-18.4) and is
   * deduped per normalized inbox + idempotent (signupGrant.ts).
   */
  KYSIGNED_SIGNUP_GRANT_CREDITS?: string;
  /**
   * F-16.6 / AC-97 — the trial-credit abuse-monitor alert threshold: grants per
   * 24h above which the daily monitor cron emails the operator (info@). Default
   * 100/day. 0 disables alerting (the metric is still logged). Tune as legit
   * signup volume grows.
   */
  KYSIGNED_SIGNUP_GRANT_ALERT_PER_DAY?: string;
  /**
   * Creator session lifetime in DAYS (F-18.1). kysigned.com sets 30 (matched to
   * the upstream run402 refresh-token TTL — the hard ceiling, beyond which the
   * server-side refresh fails and the session ends regardless). Unset → the
   * session.ts library default (a forker tunes it here). Codified concrete so the
   * value can't silently drift.
   */
  KYSIGNED_SESSION_TTL_DAYS?: string;
  /**
   * F-19 / AC-39 — the `List-Unsubscribe` mailto on outbound email. kysigned.com
   * sets `legal@kychee.com`; a forker leaving it unset gets `legal@<operatorDomain>`,
   * so no Kychee address is baked into the forkable template's mail.
   */
  KYSIGNED_UNSUBSCRIBE_MAILTO?: string;
  /**
   * F-32.7 / F-16.6 — where operator alert emails (the archive-reconciliation
   * sweep, the trial-credit abuse monitor) are delivered. The in-project
   * mailboxes are store-only (nothing forwards externally), so an operator who
   * wants alerts pushed to a real inbox sets this to an external address; unset
   * (the forker default) falls back to `info@<operatorDomain>`. Interim channel
   * until a proper alerts mechanism exists (#149).
   */
  KYSIGNED_OPERATOR_ALERT_EMAIL?: string;
  /**
   * F-9.9 / AC-124 — the delivery-confirmation backstop window, in HOURS. When a
   * signing-request send fails with an ambiguous/unclassifiable error, a deferred run
   * fires after this window; if the signer is still pending (neither delivered nor
   * signed), it is marked undeliverable and the creator notified. Default 24; a
   * non-positive / invalid value falls back to 24.
   */
  KYSIGNED_DELIVERY_BACKSTOP_HOURS?: string;
  /**
   * F-28 `[service]` — test-only account-reset secret. When BOTH this and
   * KYSIGNED_TEST_RESET_PATTERN are set, `POST /v1/test/reset-user` (this value in
   * the `x-test-reset-secret` header) purges a pattern-matched test identity so a
   * fresh trial grant can re-fire. Unset (the default, incl. every forker) → the
   * route 404s. NEVER set on a deployment holding real users you can't pattern-fence.
   */
  KYSIGNED_TEST_RESET_SECRET?: string;
  /**
   * F-28 `[service]` — a JS RegExp (tested against the trim+lowercased email) that
   * fences WHICH identities the reset endpoint may purge. Unset → refuse every
   * identity (fail-closed) even with the secret set. e.g. `^redteam.*@kysigned\.com$`.
   */
  KYSIGNED_TEST_RESET_PATTERN?: string;
}

function csv(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const list = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length ? list : undefined;
}

function requireEnv(env: AppEnv, key: keyof AppEnv): string {
  const v = env[key];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var ${key}`);
  }
  return v;
}

// ── App deps ────────────────────────────────────────────────────────────────

/**
 * The fully-wired production deps the HTTP entry + crons consume. Pure data +
 * factories — no `@run402/*` import reaches here (the runtime is injected).
 */
export interface AppDeps {
  pool: DbPool;
  emailProvider: EmailProvider;
  sessionConfig: SessionConfig;
  /** Our signing mailbox id (forward-to-sign). Unsigned-inbound mailbox_id auth. */
  signingMailboxId?: string;
  /** Core mailbox id used for notification-class mail (`notifications@...`). */
  notificationMailboxId?: string;
  /** Exact address signers forward to. Defaults to the generated run402 mailbox address when present. */
  signingEmail: string;
  baseUrl: string;
  operatorDomain: string;
  /** F-19 / AC-39 — operator-configured List-Unsubscribe contact (default legal@<operatorDomain>). */
  unsubscribeMailto: string;
  /** F-32.7/F-16.6 — operator alert recipient (default info@<operatorDomain>; kysigned.com routes externally, #149 interim). */
  operatorAlertEmail: string;
  /** F-33.1 `[both]` — operator allowlist: a session whose authenticated email is a member is an operator. Empty = fail-closed (nobody); kysigned.com's list is `[service]` config set in the private deploy. */
  operatorEmails?: string[];
  /** F-9.9 / AC-124 — delivery-confirmation backstop window as a run `delay` string (e.g. "24h"). */
  deliveryBackstop: string;
  /** F-16.6 / AC-97 — trial-credit abuse-monitor alert threshold (grants per 24h; 0 disables alerting). */
  signupGrantAlertThreshold: number;
  /** F-28 `[service]` — test-account-reset secret; undefined disables the endpoint (handler 404s). */
  testResetSecret?: string;
  /** F-28 `[service]` — identity pattern the reset may purge; undefined refuses all (fail-closed). */
  testResetPattern?: RegExp;
  projectId: string;
  /** Fetch a stored canonical/bundle PDF blob (envelopes/<hash>/original.pdf). */
  getPdf: (key: string) => Promise<Uint8Array | null>;
  storePdf: (key: string, data: Uint8Array) => Promise<void>;
  deletePdf: (key: string) => Promise<void>;
  /** Fetch a signer's raw forwarded `.eml` bytes by run402 message id (latin1 string). */
  fetchRawMime: (messageId: string) => Promise<string | null>;
  /** F-29 — create a run402 durable function run (background work, cron-less). */
  createRun: CreateRun;
  /** F-30.2 — operator x402 config; presence enables the always-priced create route. */
  x402?: X402Config;
  /** F-30.2 — parse the gateway-settled payment context off a routed request (runtime-injected). */
  readPaymentContext?: (req: Request) => RoutedHttpPaymentContextV1 | null;

  /** #146 — bounded readiness probes for GET /v1/health?deep=1 (db + signing mailbox). */
  healthChecks: () => { checkDb: () => Promise<void>; checkMailbox: () => Promise<void> };

  // per-request / per-sweep ctx factories
  apiContext: (creatorEmail: string) => ApiContext;
  authCtx: () => AuthHandlerCtx;
  adminCtx: (operator: string) => AdminContext;
  signerCtx: () => SignerApiCtx;

  // durable-run dep builders
  /** F-29.6 — the ctx for the `reply_received` / `bounced` email-trigger handlers. */
  inboundEmailCtx: () => InboundEmailCtx;
  distributeDeps: () => DistributeBundleDeps;
  reminderSendCtx: () => ReminderSendCtx;
  expirationStorage: () => ExpirationStorage;
  timestampProvider: () => TimestampProvider;
}

/**
 * Construct the production deps from env + the injected run402 runtime. The
 * function entry calls this once (lazily, on first request / cron tick).
 */
export function buildAppDeps(env: AppEnv, runtime: Run402Runtime): AppDeps {
  const apiBase = env.RUN402_API_BASE ?? env.RUN402_API_BASE_URL ?? 'https://api.run402.com';
  const projectId = requireEnv(env, 'RUN402_PROJECT_ID');
  const baseUrl = env.KYSIGNED_BASE_URL ?? env.RUN402_PUBLIC_ORIGIN ?? 'https://kysigned.com';
  const baseUrlParsed = new URL(baseUrl);
  const generatedSigningEmail = env.RUN402_MAILBOX_FORWARD_TO_SIGN_ADDRESS;
  const operatorDomain = env.KYSIGNED_OPERATOR_DOMAIN ?? generatedSigningEmail?.split('@')[1] ?? baseUrlParsed.hostname;
  const signingEmail = env.KYSIGNED_SIGNING_EMAIL ?? generatedSigningEmail ?? `forward-to-sign@${operatorDomain}`;
  // F-19 / AC-39 — operator-configurable List-Unsubscribe contact; forker default
  // derives from their own domain so no Kychee address ships in the template.
  const unsubscribeMailto = env.KYSIGNED_UNSUBSCRIBE_MAILTO ?? `legal@${operatorDomain}`;
  // F-32.7/F-16.6 — operator alerts go to a real inbox when configured (the
  // in-project mailboxes are store-only); default = the in-project human inbox.
  const operatorAlertEmail = env.KYSIGNED_OPERATOR_ALERT_EMAIL?.trim() || `info@${operatorDomain}`;
  const signingMailboxId = env.KYSIGNED_SIGNING_MAILBOX_ID ?? env.RUN402_MAILBOX_FORWARD_TO_SIGN_ID;
  const notificationMailboxId = env.KYSIGNED_NOTIFICATION_MAILBOX_ID ?? env.RUN402_MAILBOX_NOTIFICATIONS_ID;
  const allowedCreators = csv(env.KYSIGNED_ALLOWED_CREATORS);
  const internalTestDomains = csv(env.KYSIGNED_INTERNAL_TEST_DOMAINS);
  // F-33.1 `[both]` — operator allowlist for the /admin operator surface; empty =
  // fail-closed (no operators). kysigned.com's list is `[service]`, set in deploy.ts.
  const operatorEmails = csv(env.KYSIGNED_OPERATOR_EMAILS) ?? [];

  const pool = createHttpDbPool(runtime.adminDb);
  const emailProvider = createRunEmailProvider({
    client: runtime.sdk,
    projectId,
    mailboxForFrom(from) {
      const mailbox = defaultMailboxForFrom(from);
      if (signingMailboxId && from && from.trim().toLowerCase() === signingEmail.toLowerCase()) return signingMailboxId;
      if (mailbox === 'forward-to-sign' && signingMailboxId) return signingMailboxId;
      if (mailbox === 'notifications' && notificationMailboxId) return notificationMailboxId;
      return mailbox;
    },
  });
  // F-6.9 fix (Barry QA 2026-06-17): SCOPE the raw-MIME fetch to the signing
  // mailbox. The SDK auto-resolves the mailbox only when omitted AND the project
  // has exactly one — kysigned has FIVE mailboxes, so an omitted selector throws
  // an ambiguity error → every getRaw failed → forwards never recorded (signing
  // silently broken). Passing the mbx_… id resolves directly (no list call). A
  // single-mailbox forker leaves KYSIGNED_SIGNING_MAILBOX_ID unset → omit → fine.
  const fetchRawMime = createFetchRawMime({
    client: runtime.sdk,
    projectId,
    ...(signingMailboxId ? { mailbox: signingMailboxId } : {}),
  });

  // F-13 `[service]` — config-gated credit gate. `hosted` wires the createGate
  // credit seam to the local ledger (402 on insufficient credit, AC-5; flat
  // debit on success, AC-33; void-unsigned refund, AC-49). A forker leaves
  // KYSIGNED_BILLING unset → `undefined` → allowlist-only (F-3.6).
  const envelopeCostUsdMicros = env.KYSIGNED_ENVELOPE_COST_USD_MICROS
    ? parseInt(env.KYSIGNED_ENVELOPE_COST_USD_MICROS, 10)
    : DEFAULT_ENVELOPE_COST_USD_MICROS;
  const senderGate = resolveSenderGate(env.KYSIGNED_BILLING, pool, envelopeCostUsdMicros);

  // F-13.4 — the trial-credit grant amount, in USD micros: signupGrantCredits ×
  // the flat envelope cost (so 4 credits → $1.00 at $0.25/envelope). Unset/0
  // disables the grant (forker default). Wired into authCtx → fired at the first
  // magic-link-confirmed sign-in.
  const signupGrantCredits = env.KYSIGNED_SIGNUP_GRANT_CREDITS
    ? parseInt(env.KYSIGNED_SIGNUP_GRANT_CREDITS, 10)
    : 0;
  const signupGrantUsdMicros =
    Number.isFinite(signupGrantCredits) && signupGrantCredits > 0
      ? BigInt(signupGrantCredits) * BigInt(envelopeCostUsdMicros)
      : 0n;

  // F-16.6 / AC-97 — the daily abuse-monitor alert threshold (grants per 24h).
  // Default 100/day; 0 disables alerting (the cron still logs the metric).
  const parsedAlert = env.KYSIGNED_SIGNUP_GRANT_ALERT_PER_DAY
    ? parseInt(env.KYSIGNED_SIGNUP_GRANT_ALERT_PER_DAY, 10)
    : 100;
  const signupGrantAlertThreshold = Number.isFinite(parsedAlert) && parsedAlert >= 0 ? parsedAlert : 100;

  // F-9.9 / AC-124 — the delivery-confirmation backstop window (hours → a run `delay`
  // string). Default 24h; a non-positive / invalid value falls back to 24.
  const backstopHours = env.KYSIGNED_DELIVERY_BACKSTOP_HOURS
    ? parseInt(env.KYSIGNED_DELIVERY_BACKSTOP_HOURS, 10)
    : 24;
  const deliveryBackstop = `${Number.isFinite(backstopHours) && backstopHours > 0 ? backstopHours : 24}h`;

  // F-30.2 `[service]` — the x402 always-priced create. A positive price enables
  // the route; anything else leaves it inert (forker default, F-13 posture). The
  // payment-context parser rides the injected runtime (absent on pre-tenant-x402
  // runtimes → the route fails closed `payment_x402_unavailable`).
  const x402Price = env.KYSIGNED_X402_PRICE_USD_MICROS
    ? parseInt(env.KYSIGNED_X402_PRICE_USD_MICROS, 10)
    : 0;
  const x402: X402Config | undefined =
    Number.isSafeInteger(x402Price) && x402Price > 0
      ? {
          priceUsdMicros: x402Price,
          ...(env.KYSIGNED_X402_PAY_TO ? { expectedPayTo: env.KYSIGNED_X402_PAY_TO } : {}),
        }
      : undefined;

  // F-18.1 — session lifetime (days). Set by kysigned.com to 30; a forker leaving
  // it unset falls to the session.ts default. The upstream run402 refresh-token
  // TTL is the true ceiling (once it expires the server-side refresh fails).
  const sessionTtlDays = env.KYSIGNED_SESSION_TTL_DAYS
    ? parseInt(env.KYSIGNED_SESSION_TTL_DAYS, 10)
    : undefined;

  // F-28 `[service]` — test-only account reset. Both the secret AND the pattern must
  // be set to enable a purge; otherwise the endpoint 404s / refuses all (fail-closed).
  const testResetSecret = env.KYSIGNED_TEST_RESET_SECRET;
  let testResetPattern: RegExp | undefined;
  if (env.KYSIGNED_TEST_RESET_PATTERN) {
    try {
      testResetPattern = new RegExp(env.KYSIGNED_TEST_RESET_PATTERN);
    } catch {
      testResetPattern = undefined; // an invalid regexp → refuse every identity (fail-closed)
    }
  }

  const sessionConfig: SessionConfig = {
    projectAnonKey: requireEnv(env, 'RUN402_ANON_KEY'),
    run402BaseUrl: apiBase,
    secure: true,
    ...(env.KYSIGNED_COOKIE_DOMAIN ? { cookieDomain: env.KYSIGNED_COOKIE_DOMAIN } : {}),
    ...(sessionTtlDays ? { sessionTtlDays } : {}),
  };

  const getPdf = (key: string) => getPdfBlob(pool, key);
  const storePdf = (key: string, data: Uint8Array) => storePdfBlob(pool, key, data);
  const deletePdf = (key: string) => deletePdfBlob(pool, key);

  // #146 — readiness probes for GET /v1/health?deep=1. Bounded by the handler's
  // timeout; results surface only as ok/fail/timeout (public endpoint).
  const serviceKey = env.RUN402_SERVICE_KEY ?? '';
  const healthChecks = () => ({
    checkDb: async () => {
      await pool.query('SELECT 1');
    },
    checkMailbox: async () => {
      // A forker without a pinned signing mailbox has nothing to probe — the
      // check degrades to liveness parity rather than failing their readiness.
      if (!signingMailboxId) return;
      const res = await fetch(`${apiBase}/mailboxes/v1`, {
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
      if (!res.ok) throw new Error(`mailboxes read failed (${res.status})`);
      const body = (await res.json()) as { mailboxes?: Array<{ mailbox_id: string; status?: string }> };
      const mbx = (body.mailboxes ?? []).find((m) => m.mailbox_id === signingMailboxId);
      if (!mbx) throw new Error('signing mailbox not found in project');
      // #134-class: a suspended signing mailbox is a production outage — the
      // exact state the liveness-only /v1/health served green through.
      if (mbx.status && mbx.status !== 'active') throw new Error(`signing mailbox status ${mbx.status}`);
    },
  });

  // ── per-request ctx factories ──────────────────────────────────────────────
  const apiContext = (creatorEmail: string): ApiContext => ({
    pool,
    createRun: runtime.createRun,
    deliveryBackstop,
    emailProvider,
    baseUrl,
    // The creator identity is email-only (the vestigial senderType is removed).
    senderIdentity: creatorEmail,
    storePdf,
    deletePdf,
    operatorDomain,
    signingEmail,
    unsubscribeMailto,
    ...(allowedCreators ? { allowedCreators } : {}),
    ...(internalTestDomains ? { internalTestDomains } : {}),
    // F-13 — the credit gate (402/debit/refund), wired only when hosted billing
    // is active; absent for a forker (allowlist-gated, no payment).
    ...(senderGate ? { senderGate } : {}),
    // F-30.2 — with x402 config the credit-gate 402 names the paid route+price.
    ...(x402 ? { x402Discovery: { priceUsdMicros: x402.priceUsdMicros } } : {}),
  });

  const authCtx = (): AuthHandlerCtx => ({
    pool,
    session: sessionConfig,
    appBaseUrl: baseUrl,
    // F-13.4 — fire the trial-credit grant on a confirmed magic-link sign-in.
    ...(signupGrantUsdMicros > 0n ? { signupGrantUsdMicros } : {}),
  });
  const adminCtx = (operator: string): AdminContext => ({ pool, operator });
  const signerCtx = (): SignerApiCtx => ({ pool, getPdf, signingEmail });

  // ── cron dep builders ───────────────────────────────────────────────────────
  const timestampProvider = (): TimestampProvider => createOtsProvider({});

  // F-29.6 — the email-trigger inbound ctx (reply_received / bounced). Mirrors the
  // former reconciler's seams (raw-MIME fetch, live-DNS artifact assembly, run
  // creation) plus the notify surface (emailProvider / operatorDomain / baseUrl).
  const inboundEmailCtx = (): InboundEmailCtx => ({
    pool,
    emailProvider,
    operatorDomain,
    baseUrl,
    fetchRawMime,
    artifact: createDefaultTimestampAssemblyDeps(),
    createRun: runtime.createRun,
    // F-6.2a — the SES receipt verdicts are always recorded (AC-62); the SPF/DMARC
    // REJECTION is opt-in and OFF by default (record-only), so an operator can watch
    // real verdicts before turning it on. Set KYSIGNED_ENFORCE_SENDER_AUTH=true to enforce.
    enforceSenderAuth: env.KYSIGNED_ENFORCE_SENDER_AUTH === 'true',
    ...(signingMailboxId ? { signingMailboxId } : {}),
  });

  const reminderSendCtx = (): ReminderSendCtx => ({
    pool,
    emailProvider,
    baseUrl,
    operatorDomain,
    signingEmail,
    unsubscribeMailto,
  });

  const expirationStorage = (): ExpirationStorage => ({ deletePdf });

  // The F-9.1 completion-distribution `prepareBundle` seam: gather the canonical
  // PDF (blob store) + each signed signer's raw `.eml` (run402 inbound store) +
  // its signature artifact, then assemble the deterministic bundle PDF.
  const prepareBundle = async (
    envelope: Envelope,
    signers: EnvelopeSigner[],
  ): Promise<PreparedBundle | null> => {
    // Resolve D's blob key: the explicit pdf_storage_key column when set, else the
    // deterministic key derived from document_hash. The fallback is load-bearing —
    // pdf_storage_key is NOT written on create, so it is null in practice; reading
    // it directly made prepareBundle return null for EVERY envelope (the bundle
    // never assembled → "completed" on the dashboard but no completion email).
    const documentOriginal = await getPdf(resolveDocumentKey(envelope));
    if (!documentOriginal) return null;

    // Every envelope is parallel; order the bundle by when each signer signed.
    const signed = signers
      .filter((s) => s.status === 'signed')
      .sort((a, b) => (a.signed_at?.getTime() ?? 0) - (b.signed_at?.getTime() ?? 0));

    const bundleSigners: BundleSignerInput[] = [];
    for (let i = 0; i < signed.length; i++) {
      const s = signed[i]!;
      const artifact = await getSignatureArtifact(pool, envelope.id, s.email);
      if (!artifact || !artifact.message_id) return null; // evidence not ready → defer
      const rawLatin1 = await fetchRawMime(artifact.message_id);
      if (rawLatin1 == null) return null; // raw not retrievable yet → defer
      // Family B: this signer's stored cover → cover-<n>.pdf in the bundle, so the
      // verifier can reconstruct P_i = cover ++ document-original.pdf (F-10.3).
      const cover = await getPdf(`envelopes/${envelope.document_hash}/cover-${s.signing_token}.pdf`);
      if (cover == null) return null; // cover blob not retrievable yet → defer
      bundleSigners.push({
        index: i + 1,
        name: s.name,
        email: s.email,
        onBehalfOf: s.on_behalf_of,
        signingDomain: artifact.dkim_domain ?? '',
        selector: artifact.dkim_selector ?? '',
        signedAt: s.signed_at ?? artifact.created_at,
        emlSha256: artifact.sha256_eml,
        rawEml: Uint8Array.from(Buffer.from(rawLatin1, 'latin1')),
        cover,
        dkimKey: artifact.dkim_key,
        dkimObservedAt: artifact.dkim_observed_at,
        archiveStatus: artifact.archive_status,
        otsProof: artifact.ots_proof,
        tsaToken: artifact.tsa_token,
        verdicts: {
          ...(artifact.spf_verdict ? { spf: artifact.spf_verdict } : {}),
          ...(artifact.dkim_verdict ? { dkim: artifact.dkim_verdict } : {}),
          ...(artifact.dmarc_verdict ? { dmarc: artifact.dmarc_verdict } : {}),
        },
      });
    }

    const assembled = await assembleBundle({
      envelope: {
        id: envelope.id,
        documentName: envelope.document_name,
        documentHash: envelope.document_hash,
        creatorEmail: envelope.sender_email,
        completedAt: envelope.completed_at ?? new Date(),
      },
      documentOriginal,
      signers: bundleSigners,
      verifierBaseUrl: baseUrl,
    });
    return { bytes: assembled.bytes, fingerprint: assembled.fingerprint };
  };

  const distributeDeps = (): DistributeBundleDeps => ({
    emailProvider,
    operatorDomain,
    verifierBaseUrl: baseUrl,
    dashboardBaseUrl: baseUrl,
    prepareBundle,
    // F-9.3 / F-013 — schedule the ephemeral-retention run when the bundle is distributed.
    createRun: runtime.createRun,
  });

  return {
    pool,
    emailProvider,
    sessionConfig,
    ...(signingMailboxId ? { signingMailboxId } : {}),
    ...(notificationMailboxId ? { notificationMailboxId } : {}),
    signingEmail,
    baseUrl,
    operatorDomain,
    unsubscribeMailto,
    signupGrantAlertThreshold,
    operatorAlertEmail,
    operatorEmails,
    projectId,
    getPdf,
    storePdf,
    deletePdf,
    fetchRawMime,
    createRun: runtime.createRun,
    deliveryBackstop,
    ...(testResetSecret ? { testResetSecret } : {}),
    ...(testResetPattern ? { testResetPattern } : {}),
    ...(x402 ? { x402 } : {}),
    ...(runtime.readPaymentContext ? { readPaymentContext: runtime.readPaymentContext } : {}),
    healthChecks,
    apiContext,
    authCtx,
    adminCtx,
    signerCtx,
    inboundEmailCtx,
    distributeDeps,
    reminderSendCtx,
    expirationStorage,
    timestampProvider,
  };
}
