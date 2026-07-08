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

  // The standard create, keyed on the payment id: a same-proof retry (the
  // gateway resolves it to the SAME payment id) replays the same 201.
  const { creator_email: _consumed, ...createBody } = body;
  return seams.runCreate(creatorEmail, `x402:${payment.paymentId}`, createBody);
}
