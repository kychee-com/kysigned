/**
 * Default timestamp composition tests — F-6.6 (BOTH timestamps).
 *
 * Structural (offline — provider construction does no network): kysigned wires both
 * OpenTimestamps (Bitcoin) and RFC 3161 (freeTSA) by default, with honest trust
 * labels. The assembly persisting both proofs is covered by artifactAssembly.test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultTimestampAssemblyDeps } from './timestampProviders.js';

describe('createDefaultTimestampAssemblyDeps — both timestamps wired', () => {
  it('wires BOTH OpenTimestamps (bitcoin-math) and RFC 3161 (trusted-third-party)', () => {
    const deps = createDefaultTimestampAssemblyDeps();
    assert.equal(deps.timestampProvider.id, 'ots');
    assert.equal(deps.timestampProvider.trustModel, 'bitcoin-math');
    assert.equal(deps.tsaProvider?.id, 'rfc3161');
    assert.equal(deps.tsaProvider?.trustModel, 'trusted-third-party');
  });

  it('honors calendar + TSA overrides while keeping both providers', () => {
    const deps = createDefaultTimestampAssemblyDeps({
      calendars: ['https://cal.example/'],
      tsaUrl: 'https://tsa.example/tsr',
    });
    assert.equal(deps.timestampProvider.id, 'ots');
    assert.equal(deps.tsaProvider?.id, 'rfc3161');
  });
});
