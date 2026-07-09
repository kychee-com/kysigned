/**
 * paymentContextFallback — F-30.2: parse the gateway's platform-owned
 * `x-run402-payment-*` headers into a payment context, with the SAME strict
 * validation as `@run402/functions`' `getRoutedPaymentContext`.
 *
 * Exists because the platform bundles ITS copy of `@run402/functions` into the
 * deployed function at build time, and that copy can predate the helper — on
 * 2026-07-09 a REAL settled mainnet payment reached the fn whose injected
 * runtime lacked `getRoutedPaymentContext`, so the create answered 503 with
 * the money already settled. The headers themselves are trustworthy transport:
 * the gateway strips ALL client-supplied `x-run402-*` headers on every routed
 * request and injects these only after verify + settle. This is header
 * parsing of documented platform metadata — no payment logic of our own.
 */
import type { RoutedHttpPaymentContextV1 } from '@run402/functions';

function nonEmpty(v: string | null): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export function parsePaymentContextFromHeaders(
  headers: { get(name: string): string | null },
): RoutedHttpPaymentContextV1 | null {
  if (nonEmpty(headers.get('x-run402-payment-scheme')) !== 'x402') return null;
  const paymentId = nonEmpty(headers.get('x-run402-payment-id'));
  const amountRaw = nonEmpty(headers.get('x-run402-payment-amount-usd-micros'));
  const network = nonEmpty(headers.get('x-run402-payment-network'));
  const payTo = nonEmpty(headers.get('x-run402-payment-pay-to'));
  const settledAt = nonEmpty(headers.get('x-run402-payment-settled-at'));
  if (paymentId === null || amountRaw === null || network === null || payTo === null || settledAt === null) {
    return null;
  }
  const amountUsdMicros = Number(amountRaw);
  if (!Number.isSafeInteger(amountUsdMicros) || amountUsdMicros <= 0) return null;
  return {
    scheme: 'x402',
    paymentId,
    amountUsdMicros,
    payer: nonEmpty(headers.get('x-run402-payment-payer')),
    network,
    asset: nonEmpty(headers.get('x-run402-payment-asset')),
    payTo,
    transaction: nonEmpty(headers.get('x-run402-payment-transaction')),
    settledAt,
  };
}
