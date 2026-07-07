/**
 * F-5.2 — envelope routing token in the email subject (AC-11).
 *
 * The signing-request subject embeds [ksgn-<envHex>]; a forward retains it
 * behind "Fwd:"/"Fw:"/localized prefixes, so the fixed signing mailbox parses
 * it to route the forward back to its envelope without per-envelope addresses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelopeToken, parseEnvelopeToken } from './subjectToken.ts';

const ENV = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

describe('subjectToken — F-5.2 / AC-11', () => {
  it('build → parse round-trips to the dashed UUID', () => {
    const token = buildEnvelopeToken(ENV);
    assert.equal(token, '[ksgn-f47ac10b58cc4372a5670e02b2c3d479]');
    assert.equal(parseEnvelopeToken(`Signature requested: "NDA" ${token}`), ENV);
  });

  it('parses through forward prefixes (Fwd:/Fw:/RE:/localized) and case', () => {
    const subj = `Signature requested: "NDA" ${buildEnvelopeToken(ENV)}`;
    for (const prefix of ['Fwd: ', 'FW: ', 'Re: ', 'WG: ', 'Rv: ', 'Fwd: Fwd: ']) {
      assert.equal(parseEnvelopeToken(prefix + subj), ENV, `prefix "${prefix}"`);
    }
    // Token itself is case-insensitive.
    assert.equal(parseEnvelopeToken('Fwd: x [KSGN-F47AC10B58CC4372A5670E02B2C3D479]'), ENV);
  });

  it('returns null when no token is present', () => {
    assert.equal(parseEnvelopeToken('Fwd: just a normal subject'), null);
    assert.equal(parseEnvelopeToken('[ksgn-tooshort]'), null);
    assert.equal(parseEnvelopeToken(''), null);
  });

  it('extracts the FIRST token if a subject somehow carries two', () => {
    const a = buildEnvelopeToken(ENV);
    const b = buildEnvelopeToken('00000000-0000-0000-0000-000000000000');
    assert.equal(parseEnvelopeToken(`x ${a} y ${b}`), ENV);
  });
});
