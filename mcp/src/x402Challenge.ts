/**
 * x402Challenge — the unpaid-challenge probe of the x402 create route
 * (DD-31), in a module with no wallet, viem or @run402/sdk imports, so the
 * web front door (F-46, `webServer.ts`) reads the route's own terms without
 * bundling the local wallet stack. `wallet.ts` re-exports these names, so the
 * local MCP keeps one implementation.
 *
 * The platform settles before the function runs, so an unpaid call never
 * reaches kysigned's code: it answers 402 with the x402 v2 `Payment-Required`
 * header and has no side effects.
 */
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';

/** The x402 create route relative to the configured endpoint (F-30.2). */
export const X402_CREATE_PATH = '/v1/x402/envelope';

export interface ChallengeTerms {
  network: string;
  asset: string;
  assetName?: string;
  /** Atomic units of `asset` as a decimal string (USDC: atomic == usd micros). */
  amountAtomic: string;
  amountUsdMicros?: number;
  payTo: string;
}

export class X402RouteError extends Error {
  readonly kind: 'not_priced' | 'bad_challenge';
  constructor(kind: 'not_priced' | 'bad_challenge', message: string) {
    super(message);
    this.name = 'X402RouteError';
    this.kind = kind;
  }
}

export interface X402Challenge {
  /** The route's challenge exactly as decoded: what an x402 client signs against. */
  paymentRequired: PaymentRequired;
  /** The `exact` accepts entry, reduced to the fields the tools report. */
  terms: ChallengeTerms;
}

/**
 * Probe the priced route unpaid and decode its x402 v2 challenge.
 * Throws X402RouteError: `not_priced` when the route answers anything but a
 * 402 challenge (e.g. a fork where the operator has not wired x402), and
 * `bad_challenge` when a 402 arrives without a parseable challenge.
 */
export async function fetchChallenge(
  endpoint: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<X402Challenge> {
  const url = `${endpoint}${X402_CREATE_PATH}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (res.status !== 402) {
    throw new X402RouteError(
      'not_priced',
      `${url} answered ${res.status}, not an x402 402 challenge: this instance has no wallet-payable create (the operator has not wired x402).`,
    );
  }
  const header = res.headers.get('payment-required');
  if (!header) {
    throw new X402RouteError('bad_challenge', `402 from ${url} carried no Payment-Required challenge header.`);
  }
  let paymentRequired: PaymentRequired;
  let accept: Record<string, unknown>;
  try {
    paymentRequired = decodePaymentRequiredHeader(header);
    const accepts = Array.isArray(paymentRequired.accepts)
      ? (paymentRequired.accepts as unknown as Array<Record<string, unknown>>)
      : [];
    const found = accepts.find((a) => a['scheme'] === 'exact') ?? accepts[0];
    if (!found) throw new Error('no accepts entries');
    accept = found;
  } catch (err) {
    throw new X402RouteError(
      'bad_challenge',
      `Could not parse the Payment-Required challenge from ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const network = accept['network'];
  const asset = accept['asset'];
  const amount = accept['amount'];
  const payTo = accept['payTo'];
  if (typeof network !== 'string' || typeof asset !== 'string' || typeof payTo !== 'string' ||
      typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new X402RouteError('bad_challenge', `Challenge accepts entry from ${url} is missing network/asset/amount/payTo.`);
  }
  const extra = (accept['extra'] ?? {}) as Record<string, unknown>;
  const terms: ChallengeTerms = { network, asset, amountAtomic: amount, payTo };
  if (typeof extra['name'] === 'string') terms.assetName = extra['name'];
  if (typeof extra['amount_usd_micros'] === 'number') terms.amountUsdMicros = extra['amount_usd_micros'];
  return { paymentRequired, terms };
}

/** The terms alone (the local wallet tools' view of the challenge). */
export async function fetchChallengeTerms(
  endpoint: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ChallengeTerms> {
  return (await fetchChallenge(endpoint, fetchFn)).terms;
}
