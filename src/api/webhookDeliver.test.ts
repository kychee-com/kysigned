/**
 * webhookDeliver tests — F-30.3 (AC-138).
 *
 * Covers: callback_url validation (https-only + literal-private-host block),
 * the completion enqueue (only when a webhook row exists; namespaced
 * idempotency key), and the delivery run handler body (signed POST; 2xx
 * terminal; 4xx permanent; 5xx/network retryable — at-least-once via run402).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { DbPool } from '../db/pool.js';
import type { CreateRunOptions, CreateRunResult } from '../functions/runs.js';
import { RetryableRunError, PermanentRunError } from '../functions/runs.js';
import { validateCallbackUrl, scheduleCompletionWebhook, deliverEnvelopeWebhook } from './webhookDeliver.js';
import { verifyWebhookSignature } from './webhookSignature.js';

const SECRET = 'whs_' + 's'.repeat(64);

function poolWith(handler: (text: string, values?: unknown[]) => Array<Record<string, unknown>>) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const pool: DbPool = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      const rows = handler(text, values);
      return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as unknown as pg.QueryResult;
    },
    async end() {},
  };
  return { pool, queries };
}

const WEBHOOK_ROW = { envelope_id: 'env-1', url: 'https://agent.example.com/hook', secret: SECRET, created_at: new Date().toISOString() };
const ENVELOPE_ROW = {
  id: 'env-1', sender_email: 'creator@example.com', document_name: 'Contract',
  status: 'completed', completed_at: '2026-07-07T10:00:00.000Z',
};
const SIGNER_ROWS = [
  { id: 'sg-1', envelope_id: 'env-1', email: 's@example.com', name: 'S', status: 'signed', signed_at: '2026-07-07T09:59:00.000Z' },
];

/** Standard pool: webhook row + envelope + signers. */
function fullPool() {
  return poolWith((text) => {
    if (/FROM envelope_webhooks/i.test(text)) return [{ ...WEBHOOK_ROW }];
    if (/FROM envelopes/i.test(text)) return [{ ...ENVELOPE_ROW }];
    if (/FROM envelope_signers/i.test(text)) return SIGNER_ROWS.map((r) => ({ ...r }));
    return [];
  });
}

describe('validateCallbackUrl (F-30.3)', () => {
  it('accepts a normal https URL', () => {
    assert.equal(validateCallbackUrl('https://agent.example.com/hook').ok, true);
  });
  it('rejects http, non-URLs, and literal private/loopback hosts', () => {
    for (const bad of [
      'http://agent.example.com/hook', // https only
      'not a url',
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
      'https://10.1.2.3/hook',
      'https://192.168.1.4/hook',
      'https://172.16.0.9/hook',
      'https://169.254.1.1/hook',
      'ftp://example.com/x',
    ]) {
      assert.equal(validateCallbackUrl(bad).ok, false, `must reject ${bad}`);
    }
  });
});

describe('scheduleCompletionWebhook (F-30.3)', () => {
  it('enqueues a webhook_deliver run (namespaced key) when a webhook row exists', async () => {
    const { pool } = fullPool();
    const calls: CreateRunOptions[] = [];
    const createRun = async (o: CreateRunOptions): Promise<CreateRunResult> => {
      calls.push(o);
      return { runId: 'run-1', deduplicated: false };
    };
    await scheduleCompletionWebhook(pool, createRun, 'env-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.eventType, 'webhook_deliver');
    assert.equal(calls[0]!.idempotencyKey, 'webhook-completed:env-1');
    assert.deepEqual(calls[0]!.payload, { envelopeId: 'env-1' });
  });

  it('no webhook row → no run; a createRun failure never throws (best-effort)', async () => {
    const { pool } = poolWith(() => []);
    let called = 0;
    await scheduleCompletionWebhook(pool, async () => { called += 1; throw new Error('x'); }, 'env-1');
    assert.equal(called, 0, 'no row → no enqueue');

    const { pool: withRow } = fullPool();
    await scheduleCompletionWebhook(withRow, async () => { throw new Error('run402 down'); }, 'env-1');
    // reaching here without throwing IS the assertion (distribution must not fail)
  });
});

describe('deliverEnvelopeWebhook (F-30.3 / AC-138)', () => {
  it('POSTs a SIGNED payload the documented recipe verifies; 2xx is terminal', async () => {
    const { pool } = fullPool();
    let captured: { url: string; body: string; sig: string | null } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: String(url),
        body: String(init?.body),
        sig: (init?.headers as Record<string, string>)['X-Kysigned-Signature'] ?? null,
      };
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const r = await deliverEnvelopeWebhook(pool, 'env-1', { fetchImpl, nowSeconds: 1_700_000_000 });
    assert.equal(r.action, 'delivered');
    assert.ok(captured);
    assert.equal(captured!.url, WEBHOOK_ROW.url);
    const payload = JSON.parse(captured!.body) as Record<string, unknown>;
    assert.equal(payload.type, 'envelope.completed');
    assert.equal(payload.envelope_id, 'env-1');
    assert.equal((payload.signers as Array<{ email: string }>)[0]!.email, 's@example.com');
    // The signature verifies against the stored secret + the exact raw body.
    assert.ok(captured!.sig, 'X-Kysigned-Signature header present');
    assert.equal(
      verifyWebhookSignature(SECRET, captured!.sig!, captured!.body, { nowSeconds: 1_700_000_010 }),
      true,
      'receiver recipe verifies the delivery',
    );
    // Tamper check: the same header must NOT verify a modified body.
    assert.equal(
      verifyWebhookSignature(SECRET, captured!.sig!, captured!.body + 'x', { nowSeconds: 1_700_000_010 }),
      false,
    );
  });

  it('no webhook row → terminal no-op; missing envelope → terminal gone', async () => {
    const { pool: empty } = poolWith(() => []);
    assert.deepEqual(await deliverEnvelopeWebhook(empty, 'env-1'), { action: 'no_webhook' });

    const { pool: noEnv } = poolWith((text) => (/FROM envelope_webhooks/i.test(text) ? [{ ...WEBHOOK_ROW }] : []));
    assert.deepEqual(await deliverEnvelopeWebhook(noEnv, 'env-1'), { action: 'gone' });
  });

  it('5xx and network errors are RETRYABLE (at-least-once); 4xx is PERMANENT', async () => {
    const { pool } = fullPool();
    const status = (code: number) =>
      (async () => new Response('x', { status: code })) as unknown as typeof fetch;

    await assert.rejects(
      () => deliverEnvelopeWebhook(fullPool().pool, 'env-1', { fetchImpl: status(503) }),
      RetryableRunError,
      '5xx retries',
    );
    await assert.rejects(
      () => deliverEnvelopeWebhook(pool, 'env-1', { fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch }),
      RetryableRunError,
      'network error retries',
    );
    await assert.rejects(
      () => deliverEnvelopeWebhook(fullPool().pool, 'env-1', { fetchImpl: status(400) }),
      PermanentRunError,
      '4xx is terminal',
    );
  });
});
