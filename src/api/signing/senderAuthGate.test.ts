/**
 * Sender-authentication gate tests — F-6.2a / AC-62 (spec v0.4.0).
 *
 * Only an explicit SES `FAIL` on SPF or DMARC rejects; GRAY / PROCESSING_FAILED /
 * absent verdicts do not block (DKIM remains the authority). DMARC is reported
 * first when both fail.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSenderAuth } from './senderAuthGate.js';

describe('evaluateSenderAuth — SPF/DMARC receipt gate (F-6.2a)', () => {
  it('accepts a PASS/PASS receipt', () => {
    assert.deepEqual(evaluateSenderAuth({ spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' }), { ok: true });
  });

  it('rejects an SPF FAIL', () => {
    const r = evaluateSenderAuth({ spf: 'FAIL', dmarc: 'PASS' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.failed, 'spf');
      assert.equal(r.reason, 'spf_fail');
      assert.equal(r.verdict, 'FAIL');
    }
  });

  it('rejects a DMARC FAIL', () => {
    const r = evaluateSenderAuth({ spf: 'PASS', dmarc: 'FAIL' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.failed, 'dmarc');
      assert.equal(r.reason, 'dmarc_fail');
    }
  });

  it('reports DMARC first when both fail (authoritative combination verdict)', () => {
    const r = evaluateSenderAuth({ spf: 'FAIL', dmarc: 'FAIL' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.failed, 'dmarc');
  });

  it('does NOT reject GRAY or PROCESSING_FAILED (only explicit FAIL blocks)', () => {
    assert.equal(evaluateSenderAuth({ spf: 'GRAY', dmarc: 'PASS' }).ok, true);
    assert.equal(evaluateSenderAuth({ spf: 'PASS', dmarc: 'GRAY' }).ok, true);
    assert.equal(evaluateSenderAuth({ spf: 'PROCESSING_FAILED', dmarc: 'PASS' }).ok, true);
  });

  it('does NOT reject when verdicts are absent (DKIM is the authority)', () => {
    assert.equal(evaluateSenderAuth({}).ok, true);
    assert.equal(evaluateSenderAuth({ spf: null, dmarc: undefined }).ok, true);
  });

  it('is case-insensitive on the verdict string', () => {
    assert.equal(evaluateSenderAuth({ spf: 'fail', dmarc: 'pass' }).ok, false);
    assert.equal(evaluateSenderAuth({ dmarc: 'Fail' }).ok, false);
  });
});
