import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleHealth } from './health.js';

describe('handleHealth — GET /v1/health (AC-32)', () => {
  it('returns 200 ok with no auth required', () => {
    const r = handleHealth(new Date('2026-06-14T00:00:00.000Z'));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.service, 'kysigned');
    assert.equal(r.body.ts, '2026-06-14T00:00:00.000Z');
  });
});
