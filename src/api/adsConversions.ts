/**
 * adsConversions — F-37 conversion-enqueue seam (AC-207 / AC-208, DD-47).
 *
 * The `[both]` half of the Google Ads upload rail. At each conversion anchor
 * (account establishment, envelope create, credit purchase) the caller invokes
 * `enqueueAdsConversion`; when the account is click-attributed AND the operator
 * configured an upload function (`KYSIGNED_ADS_UPLOAD_FUNCTION` — the
 * `[service]` private handler; a fresh fork leaves it unset), an
 * `ads_conversion_upload` durable run is enqueued TARGETING that function.
 *
 * Disciplines:
 *   • organic accounts (no bound gclid) enqueue nothing — ever;
 *   • idempotency keys carry NO address: the per-account handle is a sha256
 *     prefix of the normalized inbox (`ads:<action>:<handle>`), purchases key
 *     by their ledger row (`ads:credit_purchase:<ledgerId>`);
 *   • the once-per-account actions (sign_up, envelope_created) enqueue on
 *     EVERY occurrence — the platform's idempotency dedupe admits only the
 *     first, which also freezes the FIRST occurrence's event time;
 *   • never throws (F-36.3): an enqueue failure is logged and the business
 *     transition completes untouched. Upload retry/durability is run402's
 *     (the run retries); kysigned keeps no queue of its own.
 */
import { createHash } from 'node:crypto';
import type { DbPool } from '../db/pool.js';
import type { CreateRun } from '../functions/runs.js';
import { getCreatorAttribution } from './attributionCapture.js';
import { normalizeInbox } from './signerInboxGuard.js';

export const ADS_CONVERSION_EVENT_TYPE = 'ads_conversion_upload';

export type AdsConversionAction = 'sign_up' | 'envelope_created' | 'credit_purchase';

export interface AdsConversionDeps {
  pool: DbPool;
  createRun?: CreateRun;
  /** Operator config: the `[service]` upload-handler function. Unset (fork default) → no enqueue ever. */
  adsUploadFunction?: string;
}

export interface AdsConversionOpts {
  /** The domain event's occurrence time (rides the payload; never upload time). */
  occurredAt: Date;
  /** Purchases: the actual amount in USD micros. */
  amountUsdMicros?: number;
  /** Key override for many-per-account actions (purchases: the ledger row id). */
  idempotencyRef?: string;
}

/** Stable, address-free per-account handle for run idempotency keys. */
export function attributionAccountKey(email: string): string {
  return createHash('sha256').update(normalizeInbox(email)).digest('hex').slice(0, 32);
}

/**
 * Enqueue one conversion for a click-attributed account. Resolves quietly in
 * every non-enqueue case (fork default, organic account, any failure).
 */
export async function enqueueAdsConversion(
  deps: AdsConversionDeps,
  action: AdsConversionAction,
  creatorEmail: string,
  opts: AdsConversionOpts,
): Promise<void> {
  if (!deps.createRun || !deps.adsUploadFunction) return;
  try {
    const attribution = await getCreatorAttribution(deps.pool, creatorEmail);
    if (!attribution) return; // organic — stays out of the rail entirely
    const ref = opts.idempotencyRef ?? attributionAccountKey(creatorEmail);
    await deps.createRun({
      eventType: ADS_CONVERSION_EVENT_TYPE,
      idempotencyKey: `ads:${action}:${ref}`,
      targetFunction: deps.adsUploadFunction,
      payload: {
        action,
        gclid: attribution.gclid,
        occurred_at: opts.occurredAt.toISOString(),
        consent: attribution.consent,
        ...(opts.amountUsdMicros !== undefined ? { amount_usd_micros: opts.amountUsdMicros } : {}),
      },
      retry: { preset: 'standard' },
    });
  } catch (err) {
    console.error(`ads conversion enqueue failed (${action}; transition unaffected):`, err);
  }
}
