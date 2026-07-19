/**
 * adsConversions.test.ts — F-37 conversion enqueue seam (AC-207 / AC-208).
 *
 * `enqueueAdsConversion` is the `[both]` half of the upload rail: at a
 * conversion anchor it reads the account's bound attribution and enqueues an
 * `ads_conversion_upload` durable run TARGETING the operator's private upload
 * function. Fork default (no `adsUploadFunction` config) enqueues nothing;
 * organic accounts enqueue nothing; failures never throw (the business
 * transition always completes — the F-36.3 discipline).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DbPool } from '../db/pool.js';
import type { CreateRunOptions } from '../functions/runs.js';
import {
  enqueueAdsConversion,
  attributionAccountKey,
  ADS_CONVERSION_EVENT_TYPE,
} from './adsConversions.js';

const OCCURRED = new Date('2026-07-19T10:15:00.000Z');
const BOUND_ROW = { gclid: 'Cj0Kbound', captured_at: '2026-07-18T09:30:00.000Z', consent_state: 'granted' };

function attributedPool(row: Record<string, unknown> | null = BOUND_ROW): DbPool {
  return {
    async query(text: string) {
      if (text.includes('FROM creator_attribution')) {
        return (row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }) as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
    async end() {},
  };
}

function runRecorder(opts: { throwOnCreate?: boolean } = {}) {
  const runs: CreateRunOptions[] = [];
  return {
    runs,
    createRun: async (o: CreateRunOptions) => {
      if (opts.throwOnCreate) throw new Error('runs surface down');
      runs.push(o);
      return { runId: 'r-1', deduplicated: false };
    },
  };
}

describe('attributionAccountKey', () => {
  it('is a stable 32-hex handle of the NORMALIZED inbox (no address in any run key)', () => {
    const mixed = attributionAccountKey('Alice.Smith+promo@GoogleMail.com');
    const normalized = attributionAccountKey('alicesmith@gmail.com');
    assert.equal(mixed, normalized, 'alias/case/dot variants collapse to one account handle');
    assert.match(mixed, /^[0-9a-f]{32}$/);
    assert.equal(mixed, createHash('sha256').update('alicesmith@gmail.com').digest('hex').slice(0, 32));
  });
});

describe('enqueueAdsConversion', () => {
  it('fork default (no adsUploadFunction) enqueues nothing, even for an attributed account', async () => {
    const r = runRecorder();
    await enqueueAdsConversion(
      { pool: attributedPool(), createRun: r.createRun },
      'sign_up',
      'a@x.com',
      { occurredAt: OCCURRED },
    );
    assert.equal(r.runs.length, 0);
  });

  it('organic accounts enqueue nothing (no bound gclid)', async () => {
    const r = runRecorder();
    await enqueueAdsConversion(
      { pool: attributedPool(null), createRun: r.createRun, adsUploadFunction: 'kysigned-billing' },
      'sign_up',
      'organic@x.com',
      { occurredAt: OCCURRED },
    );
    assert.equal(r.runs.length, 0);
  });

  it('an attributed sign-up enqueues the run at the private target with the once-key + full payload', async () => {
    const r = runRecorder();
    await enqueueAdsConversion(
      { pool: attributedPool(), createRun: r.createRun, adsUploadFunction: 'kysigned-billing' },
      'sign_up',
      'Alice.Smith+promo@GoogleMail.com',
      { occurredAt: OCCURRED },
    );
    assert.equal(r.runs.length, 1);
    const run = r.runs[0]!;
    assert.equal(run.eventType, ADS_CONVERSION_EVENT_TYPE);
    assert.equal(run.targetFunction, 'kysigned-billing', 'targets the PRIVATE upload handler');
    assert.equal(run.idempotencyKey, `ads:sign_up:${attributionAccountKey('alicesmith@gmail.com')}`);
    assert.deepEqual(run.payload, {
      action: 'sign_up',
      gclid: 'Cj0Kbound',
      occurred_at: OCCURRED.toISOString(),
      consent: 'granted',
    });
  });

  it('envelope_created uses the SAME per-account once-key on every call (the platform dedupe admits only the first)', async () => {
    const r = runRecorder();
    const deps = { pool: attributedPool(), createRun: r.createRun, adsUploadFunction: 'kysigned-billing' };
    await enqueueAdsConversion(deps, 'envelope_created', 'a@x.com', { occurredAt: OCCURRED });
    await enqueueAdsConversion(deps, 'envelope_created', 'a@x.com', {
      occurredAt: new Date(OCCURRED.getTime() + 60_000),
    });
    assert.equal(r.runs.length, 2, 'every create enqueues — dedupe is the platform key, not caller state');
    assert.equal(r.runs[0]!.idempotencyKey, r.runs[1]!.idempotencyKey);
    assert.match(r.runs[0]!.idempotencyKey, /^ads:envelope_created:[0-9a-f]{32}$/);
  });

  it('credit_purchase keys by the ledger ref and carries the actual USD amount', async () => {
    const r = runRecorder();
    await enqueueAdsConversion(
      { pool: attributedPool(), createRun: r.createRun, adsUploadFunction: 'kysigned-billing' },
      'credit_purchase',
      'buyer@x.com',
      { occurredAt: OCCURRED, amountUsdMicros: 5_000_000, idempotencyRef: 'cl-42' },
    );
    assert.equal(r.runs.length, 1);
    assert.equal(r.runs[0]!.idempotencyKey, 'ads:credit_purchase:cl-42');
    assert.deepEqual(r.runs[0]!.payload, {
      action: 'credit_purchase',
      gclid: 'Cj0Kbound',
      occurred_at: OCCURRED.toISOString(),
      consent: 'granted',
      amount_usd_micros: 5_000_000,
    });
  });

  it('never throws: a failing runs surface or a failing pool read resolves quietly (F-36.3 discipline)', async () => {
    const r = runRecorder({ throwOnCreate: true });
    await enqueueAdsConversion(
      { pool: attributedPool(), createRun: r.createRun, adsUploadFunction: 'kysigned-billing' },
      'sign_up',
      'a@x.com',
      { occurredAt: OCCURRED },
    );
    const failingPool: DbPool = {
      async query() {
        throw new Error('db down');
      },
      async end() {},
    };
    const r2 = runRecorder();
    await enqueueAdsConversion(
      { pool: failingPool, createRun: r2.createRun, adsUploadFunction: 'kysigned-billing' },
      'sign_up',
      'a@x.com',
      { occurredAt: OCCURRED },
    );
    assert.equal(r2.runs.length, 0);
  });
});
