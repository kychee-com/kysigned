/**
 * Provider no-DKIM diagnosis — F-45.1 / AC-271 / AC-278.
 *
 * A forward is diagnosed "‹provider› without DKIM" only when it certainly came from
 * that provider (every DKIM signature is under the provider's fallback signing domain
 * and at least one verifies) and carries no signature for the signer's own domain.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseProviderNoDkim, isUnsignedForward } from './providerNoDkim.js';
import type { DkimSignatureDescriptor } from './dkimPolicy.js';

function sig(signingDomain: string, result: DkimSignatureDescriptor['result'] = 'pass'): DkimSignatureDescriptor {
  return { signingDomain, selector: 's', result, alignedDomain: null, algorithm: 'rsa-sha256' };
}

describe('diagnoseProviderNoDkim (F-45.1)', () => {
  it('Google Workspace fallback only, verifying → google_workspace', () => {
    assert.equal(
      diagnoseProviderNoDkim({ fromDomain: 'example.com', signatures: [sig('example-com.20251104.gappssmtp.com')] }),
      'google_workspace',
    );
  });

  it('Microsoft 365 fallback only, verifying → microsoft_365', () => {
    assert.equal(
      diagnoseProviderNoDkim({ fromDomain: 'contoso.com', signatures: [sig('contoso.onmicrosoft.com')] }),
      'microsoft_365',
    );
  });

  it('matches the fallback domain case-insensitively', () => {
    assert.equal(
      diagnoseProviderNoDkim({ fromDomain: 'example.com', signatures: [sig('Example-Com.20251104.GAPPSSMTP.COM')] }),
      'google_workspace',
    );
  });

  it('several fallback signatures, only one verifying → still that provider', () => {
    assert.equal(
      diagnoseProviderNoDkim({
        fromDomain: 'example.com',
        signatures: [sig('example-com.20230601.gappssmtp.com', 'fail'), sig('example-com.20251104.gappssmtp.com')],
      }),
      'google_workspace',
    );
  });

  it('a verifying signature under any other domain → null', () => {
    assert.equal(diagnoseProviderNoDkim({ fromDomain: 'example.com', signatures: [sig('relay.example.net')] }), null);
  });

  it('a failing own-domain signature beside a verifying fallback → null (the domain HAS DKIM)', () => {
    assert.equal(
      diagnoseProviderNoDkim({
        fromDomain: 'example.com',
        signatures: [sig('example.com', 'fail'), sig('example-com.20251104.gappssmtp.com')],
      }),
      null,
    );
  });

  it('no verifying signature at all → null', () => {
    assert.equal(
      diagnoseProviderNoDkim({ fromDomain: 'example.com', signatures: [sig('example-com.20251104.gappssmtp.com', 'fail')] }),
      null,
    );
  });

  it('no signatures → null', () => {
    assert.equal(diagnoseProviderNoDkim({ fromDomain: 'example.com', signatures: [] }), null);
  });

  it('look-alike domains are not the provider → null', () => {
    for (const d of ['evilgappssmtp.com', 'gappssmtp.com.evil.net', 'notonmicrosoft.com', 'onmicrosoft.com.evil.net']) {
      assert.equal(diagnoseProviderNoDkim({ fromDomain: 'example.com', signatures: [sig(d)] }), null, d);
    }
  });

  it('a mix of both providers is not ONE provider → null', () => {
    assert.equal(
      diagnoseProviderNoDkim({
        fromDomain: 'example.com',
        signatures: [sig('example-com.20251104.gappssmtp.com'), sig('contoso.onmicrosoft.com')],
      }),
      null,
    );
  });

  it('a sender whose own address sits under the fallback domain → null', () => {
    assert.equal(
      diagnoseProviderNoDkim({ fromDomain: 'contoso.onmicrosoft.com', signatures: [sig('fabrikam.onmicrosoft.com')] }),
      null,
    );
  });
});

describe('diagnoseProviderNoDkim: Microsoft 365, unsigned (F-45.1, spec 0.73.0, AC-279)', () => {
  // mailauth reports an unsigned message as one placeholder result with no domain.
  const NOT_SIGNED = sig('', 'none');

  it('isUnsignedForward: only the "message not signed" placeholder, or nothing at all', () => {
    assert.equal(isUnsignedForward({ signatures: [NOT_SIGNED] }), true);
    assert.equal(isUnsignedForward({ signatures: [] }), true);
    assert.equal(isUnsignedForward({ signatures: [sig('example.com', 'fail')] }), false);
    assert.equal(isUnsignedForward({ signatures: [NOT_SIGNED, sig('example.com', 'neutral')] }), false);
  });

  it('unsigned + first sealed by Microsoft → microsoft_365', () => {
    assert.equal(
      diagnoseProviderNoDkim({ fromDomain: 'contoso.com', signatures: [NOT_SIGNED] }, { arcFirstSealer: 'microsoft.com' }),
      'microsoft_365',
    );
  });

  it('the same with no descriptors at all (the no_signature shape) → microsoft_365', () => {
    assert.equal(
      diagnoseProviderNoDkim({ fromDomain: 'contoso.com', signatures: [] }, { arcFirstSealer: 'microsoft.com' }),
      'microsoft_365',
    );
  });

  it('unsigned + first sealed by anyone else → null', () => {
    for (const sealer of ['google.com', 'relay.example.net', 'notmicrosoft.com', 'microsoft.com.evil.net']) {
      assert.equal(
        diagnoseProviderNoDkim({ fromDomain: 'contoso.com', signatures: [NOT_SIGNED] }, { arcFirstSealer: sealer }),
        null,
        sealer,
      );
    }
  });

  it('unsigned with no verified sealer → null', () => {
    assert.equal(diagnoseProviderNoDkim({ fromDomain: 'contoso.com', signatures: [NOT_SIGNED] }, { arcFirstSealer: null }), null);
    assert.equal(diagnoseProviderNoDkim({ fromDomain: 'contoso.com', signatures: [NOT_SIGNED] }), null);
  });

  it("a sender on Microsoft's own onmicrosoft.com domain → null (Microsoft always signs it)", () => {
    assert.equal(
      diagnoseProviderNoDkim({ fromDomain: 'contoso.onmicrosoft.com', signatures: [NOT_SIGNED] }, { arcFirstSealer: 'microsoft.com' }),
      null,
    );
  });

  it('a signed forward ignores the sealer: judged by the fallback rules alone', () => {
    // An own-domain signature that fails: the domain HAS DKIM, so no diagnosis.
    assert.equal(
      diagnoseProviderNoDkim({ fromDomain: 'contoso.com', signatures: [sig('contoso.com', 'fail')] }, { arcFirstSealer: 'microsoft.com' }),
      null,
    );
    // A Google fallback signature stays Google even when Microsoft sealed the message.
    assert.equal(
      diagnoseProviderNoDkim(
        { fromDomain: 'example.com', signatures: [sig('example-com.20251104.gappssmtp.com')] },
        { arcFirstSealer: 'microsoft.com' },
      ),
      'google_workspace',
    );
  });
});
