/**
 * archiveReconciliation tests — F-32.7 / AC-165 / AC-166 (spec 0.44.0, DD-36).
 *
 * The daily operator backstop: re-evaluate the verifier-parity predicate for
 * 24-48h-old artifacts whose receipt-time confirmation is not clean; heal silently;
 * aggregate still-failing ones into ONE operator email (info@ From notifications@);
 * NEVER email signers or creators (the human gate owns customer contact).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runArchiveReconciliation } from './archiveReconciliation.js';
import { createSignatureArtifactsMemoryPool } from '../../db/signatureArtifacts.testpool.js';
import { upsertSignatureArtifact } from '../../db/signatureArtifacts.js';
import type { EmailMessage, EmailProvider } from '../../email/types.js';

const NOW = new Date('2026-07-14T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const KEY = 'v=DKIM1; k=rsa; p=GENUINEKEYAAAA';
const ENV = '18267982-ca76-45dc-a294-e86039a6343d';

function capturingEmail(): { provider: EmailProvider; sends: EmailMessage[] } {
  const sends: EmailMessage[] = [];
  return {
    provider: {
      async send(message: EmailMessage) {
        sends.push(message);
        return { messageId: `em-${sends.length}` };
      },
    },
    sends,
  };
}

/** fetch fake: lookup returns `records`; POST /api/dsp returns idempotent 200. Counts calls. */
function archiveFetch(records: unknown[] | 'throw') {
  const calls: string[] = [];
  const fetchFn = (async (url: string, init?: { method?: string }) => {
    calls.push(String(url));
    if (records === 'throw') throw new Error('ECONNREFUSED');
    if (init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ already_in_db: true, added: false }) };
    }
    return { ok: true, status: 200, json: async () => records };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function seed(
  pool: import('../../db/pool.js').DbPool,
  rows: any[],
  over: Record<string, unknown>,
  ageHours = 30,
) {
  const { artifact } = await upsertSignatureArtifact(pool, {
    envelope_id: ENV,
    signer_email: `signer-${rows.length}@customer.example`,
    sha256_eml: 'a'.repeat(64),
    dkim_domain: 'example.com',
    dkim_selector: 'sel',
    dkim_key: KEY,
    archive_status: 'outage',
    archive_confirmation: 'outage',
    archive_confirmation_checked_at: new Date(hoursAgo(ageHours)),
    ...over,
  } as never);
  const row = rows.find((r) => r.id === artifact.id)!;
  row.created_at = hoursAgo(ageHours);
  return artifact;
}

describe('runArchiveReconciliation — the F-32.7 daily backstop', () => {
  it('heals silently: the archive now holds the exact key → confirmed + healed_at, NO email (AC-165)', async () => {
    const { pool, rows } = createSignatureArtifactsMemoryPool();
    await seed(pool, rows, { signer_email: 'dana@customer.example' });
    const { provider, sends } = capturingEmail();
    const { fetchFn } = archiveFetch([
      { domain: 'example.com', selector: 'sel', value: KEY, firstSeenAt: hoursAgo(31), lastSeenAt: hoursAgo(1) },
    ]);

    const result = await runArchiveReconciliation(pool, {
      emailProvider: provider,
      operatorDomain: 'kysigned.com',
      archive: { fetchFn },
      now: NOW,
    });

    assert.deepEqual(
      { swept: result.swept, healed: result.healed, stillFailing: result.stillFailing, alerted: result.alerted },
      { swept: 1, healed: 1, stillFailing: 0, alerted: false },
    );
    assert.equal(sends.length, 0, 'a fully-healed sweep sends nothing');
    assert.equal(rows[0].archive_confirmation, 'confirmed');
    assert.ok(rows[0].archive_confirmation_healed_at, 'healed_at recorded');
  });

  it('F-36: an alerted sweep emits exactly one sweep_anomaly (dated key, counts only); a healed sweep emits nothing', async () => {
    const { pool, rows } = createSignatureArtifactsMemoryPool();
    await seed(pool, rows, { signer_email: 'alice@customer.example' });
    const { provider } = capturingEmail();
    const { fetchFn } = archiveFetch([]); // still unconfirmed → alert
    const events: Array<{ type: string; ids: readonly string[]; payload: Record<string, unknown> }> = [];
    const emitAppEvent = (async (type: string, ids: readonly string[], payload: Record<string, unknown>) => {
      events.push({ type, ids, payload });
    }) as never;

    const result = await runArchiveReconciliation(pool, {
      emailProvider: provider,
      operatorDomain: 'kysigned.com',
      archive: { fetchFn },
      now: NOW,
      emitAppEvent,
    });
    assert.equal(result.alerted, true);
    assert.deepEqual(events, [
      {
        type: 'sweep_anomaly',
        ids: ['archive-reconciliation', NOW.toISOString().slice(0, 10)],
        payload: { monitor: 'archive_reconciliation', still_failing: 1, healed: 0 },
      },
    ]);
  });

  it('still-failing artifacts produce EXACTLY ONE aggregated operator email to info@ — never to customers (AC-165/AC-166)', async () => {
    const { pool, rows } = createSignatureArtifactsMemoryPool();
    await seed(pool, rows, { signer_email: 'alice@customer.example' });
    await seed(pool, rows, { signer_email: 'bob@customer.example' });
    const { provider, sends } = capturingEmail();
    const { fetchFn } = archiveFetch([]); // archive still has nothing → contribute retried, still unconfirmed

    const result = await runArchiveReconciliation(pool, {
      emailProvider: provider,
      operatorDomain: 'kysigned.com',
      archive: { fetchFn },
      now: NOW,
    });

    assert.equal(result.stillFailing, 2);
    assert.equal(result.alerted, true);
    assert.equal(sends.length, 1, 'ONE aggregated email, not one per artifact');
    assert.equal(sends[0].to, 'info@kysigned.com');
    assert.equal(sends[0].from, 'notifications@kysigned.com');
    assert.match(sends[0].text, /alice@customer\.example/);
    assert.match(sends[0].text, /bob@customer\.example/);
    assert.match(sends[0].text, new RegExp(ENV));
    // AC-166: the sweep's ONLY automated recipient is the operator address.
    for (const m of sends) assert.equal(m.to, 'info@kysigned.com');
    assert.equal(rows[0].archive_confirmation, 'unconfirmed', 're-check outcome recorded');
    assert.notEqual(rows[0].archive_confirmation_checked_at, hoursAgo(30), 'checked_at advanced');
  });

  it('sweeps nothing → no archive calls, no email', async () => {
    const { pool } = createSignatureArtifactsMemoryPool();
    const { provider, sends } = capturingEmail();
    const { fetchFn, calls } = archiveFetch([]);

    const result = await runArchiveReconciliation(pool, {
      emailProvider: provider,
      operatorDomain: 'kysigned.com',
      archive: { fetchFn },
      now: NOW,
    });

    assert.deepEqual(
      { swept: result.swept, healed: result.healed, stillFailing: result.stillFailing, alerted: result.alerted },
      { swept: 0, healed: 0, stillFailing: 0, alerted: false },
    );
    assert.equal(calls.length, 0);
    assert.equal(sends.length, 0);
  });

  it('mixed sweep: heals one, alerts once naming only the still-failing one', async () => {
    const { pool, rows } = createSignatureArtifactsMemoryPool();
    await seed(pool, rows, { signer_email: 'healed@customer.example', dkim_selector: 'good' });
    await seed(pool, rows, { signer_email: 'failing@customer.example', dkim_selector: 'bad' });
    const { provider, sends } = capturingEmail();
    // selector 'good' → exact key present; selector 'bad' → empty.
    const fetchFn = (async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ already_in_db: true }) };
      const records = String(url).includes('selector=good')
        ? [{ domain: 'example.com', selector: 'good', value: KEY, firstSeenAt: hoursAgo(31), lastSeenAt: hoursAgo(1) }]
        : [];
      return { ok: true, status: 200, json: async () => records };
    }) as unknown as typeof fetch;

    const result = await runArchiveReconciliation(pool, {
      emailProvider: provider,
      operatorDomain: 'kysigned.com',
      archive: { fetchFn },
      now: NOW,
    });

    assert.deepEqual(
      { swept: result.swept, healed: result.healed, stillFailing: result.stillFailing, alerted: result.alerted },
      { swept: 2, healed: 1, stillFailing: 1, alerted: true },
    );
    assert.equal(sends.length, 1);
    assert.match(sends[0].text, /failing@customer\.example/);
    assert.doesNotMatch(sends[0].text, /healed@customer\.example/, 'healed artifacts are silent');
  });

  it('routes the alert to the configured operator alert address when set (barry@kychee.com interim until #149)', async () => {
    const { pool, rows } = createSignatureArtifactsMemoryPool();
    await seed(pool, rows, { signer_email: 'x@customer.example' });
    const { provider, sends } = capturingEmail();
    const { fetchFn } = archiveFetch([]);

    const result = await runArchiveReconciliation(pool, {
      emailProvider: provider,
      operatorDomain: 'kysigned.com',
      alertEmail: 'barry@kychee.com',
      archive: { fetchFn },
      now: NOW,
    });

    assert.equal(result.alerted, true);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, 'barry@kychee.com');
    assert.equal(sends[0].from, 'notifications@kysigned.com', 'the sender mailbox is unchanged');
  });

  it('an archive outage DURING the sweep records outage state and is included in the single alert', async () => {
    const { pool, rows } = createSignatureArtifactsMemoryPool();
    await seed(pool, rows, { signer_email: 'carol@customer.example' });
    const { provider, sends } = capturingEmail();
    const { fetchFn } = archiveFetch('throw');

    const result = await runArchiveReconciliation(pool, {
      emailProvider: provider,
      operatorDomain: 'kysigned.com',
      archive: { fetchFn },
      now: NOW,
    });

    assert.equal(result.stillFailing, 1);
    assert.equal(sends.length, 1);
    assert.match(sends[0].text, /outage/);
    assert.equal(rows[0].archive_confirmation, 'outage');
  });
});
