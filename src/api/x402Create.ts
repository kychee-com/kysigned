/**
 * x402Create — F-30.2 (spec 0.39.0): the dedicated always-priced x402 create
 * route's orchestration (`POST /v1/x402/envelope`).
 *
 * TRUST MODEL. The run402 gateway verifies + settles the x402 payment BEFORE
 * invoking the function and forwards the confirmed facts as platform-owned
 * `x-run402-payment-*` headers — client-supplied `x-run402-*` headers are
 * stripped at the gateway on every routed request, so a parsed payment context
 * can only exist gateway-settled. This module receives the ALREADY-PARSED
 * context from the dispatch (which reads it via `@run402/functions`
 * `getRoutedPaymentContext`), cross-checks it against the operator config
 * (amount, optional payTo) as belt-and-suspenders against operator misconfig,
 * and never does payment cryptography of its own (spec Constraints).
 *
 * MONEY STORY (one auditable ledger, F-13.5/F-13.7). The settled payment is
 * credited to the supplied creator's ledger EXACTLY ONCE — `creditUser` with
 * `(source='x402', external_ref=paymentId)` rides the ledger's
 * UNIQUE(source, external_ref) — and the standard create then debits it like
 * any credit. The stable payment id doubles as the create idempotency key
 * (`x402:<paymentId>` through `withCreateIdempotency`), so a same-proof retry
 * replays the SAME 201: one credit, one debit, one envelope. A non-201 create
 * outcome deliberately KEEPS the credit (the money settled on-chain); the
 * corrected retry dedups the credit and the gate then sees the balance.
 *
 * ZERO-ONBOARDING (AC-134/AC-141). No session, key, or CSRF is consulted —
 * the payment IS the authorization. The `creator_email` field in the body
 * names the creator record the envelope and ledger rows attach to; a later
 * dashboard sign-in with that email (normal F-18 auth) sees them like any
 * creator's.
 */
import type { RoutedHttpPaymentContextV1 } from '@run402/functions';
import type { DbPool } from '../db/pool.js';
import { creditUser } from '../db/userCredits.js';
import { withCreateIdempotency, type CreateResult } from './idempotentCreate.js';
import { handleCreateEnvelope } from './envelope.js';

/** Operator x402 config — presence enables the route (fork-inert without it). */
export interface X402Config {
  /** The route's fixed price (USD micros) — must equal the manifest pricing. */
  priceUsdMicros: number;
  /** Optional expected payout wallet; mismatch with the settled payTo fails closed. */
  expectedPayTo?: string;
}

/** The two side-effect seams, injectable for tests; `defaultX402Seams` wires the real ones. */
export interface X402CreateSeams {
  /** Credit the settled payment to the creator's ledger (exactly-once per payment id). */
  creditPayment(creatorEmail: string, payment: RoutedHttpPaymentContextV1): Promise<void>;
  /** Run the standard create under the payment-derived idempotency key. */
  runCreate(
    creatorEmail: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<CreateResult>;
}

/** Same shape as the magic-link validation — this address will receive mail (F-9). */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function defaultX402Seams(
  pool: DbPool,
  config: X402Config,
  buildCreateCtx: (creatorEmail: string) => Parameters<typeof handleCreateEnvelope>[0],
  createFn: (
    ctx: Parameters<typeof handleCreateEnvelope>[0],
    body: never,
  ) => Promise<CreateResult> = handleCreateEnvelope as never,
): X402CreateSeams {
  return {
    creditPayment: async (creatorEmail, payment) => {
      await creditUser(pool, {
        email: creatorEmail,
        amountUsdMicros: BigInt(config.priceUsdMicros),
        source: 'x402',
        externalRef: payment.paymentId,
        description: `x402 payment ${payment.paymentId}${payment.transaction ? ` (${payment.transaction})` : ''}`,
      });
    },
    runCreate: (creatorEmail, idempotencyKey, body) =>
      withCreateIdempotency({ pool }, creatorEmail, idempotencyKey, JSON.stringify(body), () =>
        createFn(buildCreateCtx(creatorEmail), body as never),
      ),
  };
}

export async function handleX402CreateEnvelope(
  config: X402Config,
  payment: RoutedHttpPaymentContextV1 | null,
  seams: X402CreateSeams,
  body: Record<string, unknown>,
  callerIdempotencyKey?: string | null,
): Promise<CreateResult> {
  // Config is on but no gateway-settled context reached us: the route is not
  // actually priced on this deployment (manifest/config drift) or the platform
  // is misbehaving. Fail closed — mirrors run402's serve-time 503 posture.
  if (!payment) {
    return {
      status: 503,
      body: {
        error: 'x402 payment is not active on this route — no settled payment context',
        code: 'payment_x402_unavailable',
      },
    };
  }

  // Belt-and-suspenders cross-checks against operator misconfig (price changed
  // in config but the priced route not redeployed, or payout drift). The
  // gateway already bound the settled amount/payTo to THIS route+project.
  if (
    payment.amountUsdMicros !== config.priceUsdMicros ||
    (config.expectedPayTo !== undefined &&
      payment.payTo.toLowerCase() !== config.expectedPayTo.toLowerCase())
  ) {
    return {
      status: 409,
      body: {
        error: 'Settled payment does not match this route’s configured price/payee',
        code: 'payment_x402_mismatch',
      },
    };
  }

  const rawEmail = body['creator_email'];
  const creatorEmail = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(creatorEmail)) {
    return {
      status: 400,
      body: {
        error:
          'creator_email (a deliverable address — creation/completion mail and the evidence bundle land there) is required on the x402 create',
        code: 'validation_creator_email',
      },
    };
  }

  // Credit BEFORE create: the payment is already settled on-chain, so the
  // ledger row (exactly-once on the payment id) must exist before the create's
  // gate reads the balance. A credit failure is a 500 — the agent retries with
  // the same proof (same payment id) and the credit dedups.
  try {
    await seams.creditPayment(creatorEmail, payment);
  } catch (e) {
    return {
      status: 500,
      body: {
        error: `Could not credit the settled payment: ${e instanceof Error ? e.message : 'ledger error'}`,
        code: 'internal_x402_credit',
      },
    };
  }

  // Create idempotency key (#128 — run402 paid-function idempotency): honor a
  // CALLER-supplied key when present so an agent's retry framework dedupes the
  // create by its own spending-intent key; otherwise the settled payment_id (a
  // same-proof retry resolves to the SAME payment_id → same 201). The ledger
  // CREDIT stays payment_id-keyed either way, so money is exactly-once per
  // settled payment regardless of the create key.
  const callerKey = typeof callerIdempotencyKey === 'string' ? callerIdempotencyKey.trim() : '';
  const createKey = callerKey ? `x402:idem:${callerKey}` : `x402:${payment.paymentId}`;
  const { creator_email: _consumed, ...createBody } = body;

  const result = await seams.runCreate(creatorEmail, createKey, createBody);
  const receipt = paymentReceipt(payment);
  const resultBody = result.body && typeof result.body === 'object' ? (result.body as Record<string, unknown>) : { value: result.body };

  if (result.status === 201) {
    // #133 — return a durable payment receipt so a wallet agent can reconcile the
    // spend with the envelope. #131 — the status_url needs creator auth, which a
    // wallet-only creator does not have; point them at the creator_email sign-in.
    return {
      status: 201,
      body: {
        ...resultBody,
        payment: receipt,
        tracking: {
          status_url_auth: 'creator',
          creator_email: creatorEmail,
          note:
            `status_url requires creator authentication. As a wallet-only creator, sign in to ` +
            `${creatorEmail} (request a magic link at POST /v1/auth/magic-link) to track this envelope in ` +
            `the dashboard; the creation email, completion notice, and the evidence bundle are all sent to ` +
            `${creatorEmail}.`,
        },
      },
    };
  }

  // #129 — the payment settled on-chain and was BANKED as an account credit for
  // creator_email BEFORE this deterministic create failure (plus-alias signer,
  // bad email, unparseable/oversize PDF, …). The money is not lost: surface it
  // so the agent can recover it, and DON'T pay again to fix input.
  return {
    status: result.status,
    body: {
      ...resultBody,
      payment_banked: true,
      payment: receipt,
      credit_email: creatorEmail,
      next_actions: [
        {
          type: 'use_banked_credit',
          why:
            `Your $${(payment.amountUsdMicros / 1_000_000).toFixed(2)} payment settled and was banked as ` +
            `account credit for ${creatorEmail} (it was NOT lost). Fix the input, then sign in to ${creatorEmail} ` +
            `(magic link) and create via the authenticated POST /v1/envelope — the banked credit covers it, no new ` +
            `payment needed. Tip: call POST /v1/envelope/preflight (free) to validate inputs BEFORE paying.`,
        },
      ],
    },
  };
}

/** #133 — the client-facing payment receipt built from the gateway-confirmed context. */
function paymentReceipt(payment: RoutedHttpPaymentContextV1): Record<string, unknown> {
  return {
    payment_id: payment.paymentId,
    network: payment.network,
    amount_usd_micros: payment.amountUsdMicros,
    asset: payment.asset,
    pay_to: payment.payTo,
    settlement_reference: payment.transaction,
    settled_at: payment.settledAt,
  };
}
