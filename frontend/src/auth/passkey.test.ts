/**
 * passkey.test.ts — WebAuthn wire-format helpers + sign-in flow (2F.AUTH8).
 *
 * The browser-side helpers convert run402's JSON challenges to WebAuthn
 * ArrayBuffers and back; signInWithPasskey orchestrates the full ceremony.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  passkeysSupported,
  conditionalMediationAvailable,
  startConditionalPasskeyLogin,
  base64UrlToArrayBuffer,
  arrayBufferToBase64Url,
  normalizeRequestOptions,
  credentialToAssertionJson,
} from './passkey';

describe('passkey — base64url round-trip', () => {
  it('decodes then re-encodes to the same string for clean-length input', () => {
    // 12 chars = 9 bytes — multiple-of-4 length round-trips cleanly without
    // padding loss. 11-char base64url strings can lose 2 trailing bits on
    // decode (which is by design — they're typically padded with `=`).
    const original = 'abc123_-XYZw';
    const buf = base64UrlToArrayBuffer(original);
    const encoded = arrayBufferToBase64Url(buf);
    expect(encoded).toBe(original);
  });

  it('handles empty input', () => {
    const buf = base64UrlToArrayBuffer('');
    expect(buf.byteLength).toBe(0);
    expect(arrayBufferToBase64Url(buf)).toBe('');
  });

  it('handles bytes that round-trip cleanly to readable base64url', () => {
    // 'kysigned' as bytes — ascii lowercase, no padding-special characters
    const buf = base64UrlToArrayBuffer('a3lzaWduZWQ');
    const view = new Uint8Array(buf);
    expect(String.fromCharCode(...view)).toBe('kysigned');
  });

  it('uses urlsafe alphabet (no +, /, =)', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);
    const encoded = arrayBufferToBase64Url(bytes.buffer);
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('passkey — normalizeRequestOptions', () => {
  it('converts run402 JSON-shaped login options into a WebAuthn-friendly object', () => {
    const json = {
      challenge: 'a3lzaWduZWQ',
      rpId: 'kysigned.com',
      timeout: 60000,
      userVerification: 'required',
      allowCredentials: [
        { id: 'a3lzaWduZWQ', type: 'public-key', transports: ['internal'] },
      ],
    };
    const normalized = normalizeRequestOptions(json);
    expect(normalized.challenge).toBeInstanceOf(ArrayBuffer);
    expect(normalized.rpId).toBe('kysigned.com');
    expect(normalized.timeout).toBe(60000);
    expect(normalized.userVerification).toBe('required');
    expect(normalized.allowCredentials?.[0]?.id).toBeInstanceOf(ArrayBuffer);
    expect(normalized.allowCredentials?.[0]?.type).toBe('public-key');
  });

  it('handles missing allowCredentials (empty list)', () => {
    const normalized = normalizeRequestOptions({ challenge: 'a3lzaWduZWQ' });
    expect(normalized.allowCredentials).toEqual([]);
  });
});

describe('passkey — credentialToAssertionJson', () => {
  it('encodes a PublicKeyCredential into run402-postable JSON', () => {
    // Construct a minimal mock-credential shape
    const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0)).buffer;
    const fakeCredential = {
      id: 'cred-id',
      rawId: enc('cred-id'),
      type: 'public-key',
      response: {
        clientDataJSON: enc('{"type":"webauthn.get"}'),
        authenticatorData: enc('AUTH_DATA'),
        signature: enc('SIG'),
        userHandle: enc('USER_HANDLE'),
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: () => ({}),
    } as unknown as PublicKeyCredential;

    const json = credentialToAssertionJson(fakeCredential);
    expect(json.id).toBe('cred-id');
    expect(json.type).toBe('public-key');
    expect(typeof json.rawId).toBe('string');
    expect(typeof json.response.clientDataJSON).toBe('string');
    expect(typeof json.response.authenticatorData).toBe('string');
    expect(typeof json.response.signature).toBe('string');
    expect(json.authenticatorAttachment).toBe('platform');
  });

  it('omits userHandle when missing', () => {
    const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0)).buffer;
    const fake = {
      id: 'c',
      rawId: enc('c'),
      type: 'public-key',
      response: {
        clientDataJSON: enc('{}'),
        authenticatorData: enc('AD'),
        signature: enc('S'),
        userHandle: null,
      },
      clientExtensionResults: () => ({}),
    } as unknown as PublicKeyCredential;
    const json = credentialToAssertionJson(fake);
    expect(json.response.userHandle).toBeUndefined();
  });
});

describe('passkey — passkeysSupported', () => {
  const orig = globalThis.PublicKeyCredential;

  afterEach(() => {
    // restore
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = orig;
  });

  it('returns false when PublicKeyCredential is undefined', () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = undefined;
    expect(passkeysSupported()).toBe(false);
  });

  it('returns true when PublicKeyCredential exists', () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
    expect(passkeysSupported()).toBe(true);
  });
});

describe('passkey — conditionalMediationAvailable (autofill probe)', () => {
  const orig = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  afterEach(() => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = orig;
  });

  it('false when PublicKeyCredential is undefined', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = undefined;
    expect(await conditionalMediationAvailable()).toBe(false);
  });

  it('false when isConditionalMediationAvailable is absent', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
    expect(await conditionalMediationAvailable()).toBe(false);
  });

  it('reflects isConditionalMediationAvailable() when present', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      isConditionalMediationAvailable: () => Promise.resolve(true),
    };
    expect(await conditionalMediationAvailable()).toBe(true);
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = {
      isConditionalMediationAvailable: () => Promise.resolve(false),
    };
    expect(await conditionalMediationAvailable()).toBe(false);
  });
});

describe('passkey — startConditionalPasskeyLogin (usernameless autofill ceremony)', () => {
  const origPKC = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  afterEach(() => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = origPKC;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns ok:false when passkeys are unsupported', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = undefined;
    expect((await startConditionalPasskeyLogin()).ok).toBe(false);
  });

  it('runs a usernameless ceremony with mediation:conditional and verifies', async () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
    const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0)).buffer;
    const fakeCred = {
      id: 'c', rawId: enc('c'), type: 'public-key',
      response: { clientDataJSON: enc('{}'), authenticatorData: enc('AD'), signature: enc('S') },
      clientExtensionResults: () => ({}),
    };
    const get = vi.fn().mockResolvedValue(fakeCred);
    vi.stubGlobal('navigator', { credentials: { get } });
    const fetchSpy = vi.fn((url: string) => {
      if (String(url).endsWith('/login/options')) {
        return Promise.resolve(new Response(JSON.stringify({ challenge_id: 'ch1', options: { challenge: 'a3lzaWduZWQ' } }), { status: 200 }));
      }
      if (String(url).endsWith('/login/verify')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, email: 'alice@example.com' }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const r = await startConditionalPasskeyLogin();
    expect(r.ok).toBe(true);
    expect(r.email).toBe('alice@example.com');
    expect(get).toHaveBeenCalledTimes(1);
    // autofill mediation + usernameless (no allowCredentials filter from an email)
    expect((get.mock.calls[0]![0] as { mediation?: string }).mediation).toBe('conditional');
  });
});
