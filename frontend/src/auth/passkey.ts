/**
 * passkey.ts — WebAuthn wire-format helpers + sign-in/register orchestration
 * (2F.AUTH8 / F2.1.8).
 *
 * These helpers bridge between run402's JSON-shaped WebAuthn challenges
 * (`{challenge: base64url, allowCredentials: [{id: base64url, ...}]}`) and
 * the browser's native `navigator.credentials.get/create` API, which expects
 * `ArrayBuffer` for `challenge` / `id` fields.
 *
 * Cookie session model (F2.1.7): passkey login/verify uses the same
 * `credentials: 'include'` cookie auth as magic-link — the Lambda's verify
 * route calls `issueSession()` on success and the response sets the
 * HttpOnly session cookie. The SPA never sees the run402 access/refresh.
 */

import { apiPost } from '../lib/api';

// --- base64url helpers ---------------------------------------------------

export function base64UrlToArrayBuffer(s: string): ArrayBuffer {
  if (s.length === 0) return new ArrayBuffer(0);
  // Re-pad and convert urlsafe alphabet to standard base64.
  const pad = (4 - (s.length % 4)) % 4;
  const padded = (s + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function arrayBufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// --- run402 JSON → WebAuthn-native normalisation -------------------------

export interface PasskeyLoginOptionsJson {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: AuthenticatorAttachment | 'discouraged' | 'preferred' | 'required';
  allowCredentials?: Array<{
    id: string;
    type: 'public-key';
    transports?: AuthenticatorTransport[];
  }>;
}

export interface PasskeyRegisterOptionsJson {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: Array<{
    id: string;
    type: 'public-key';
    transports?: AuthenticatorTransport[];
  }>;
}

export function normalizeRequestOptions(
  json: PasskeyLoginOptionsJson,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64UrlToArrayBuffer(json.challenge),
    rpId: json.rpId,
    timeout: json.timeout,
    userVerification:
      (json.userVerification as PublicKeyCredentialRequestOptions['userVerification']) ?? undefined,
    allowCredentials: (json.allowCredentials ?? []).map((c) => ({
      id: base64UrlToArrayBuffer(c.id),
      type: c.type,
      transports: c.transports,
    })),
  };
}

export function normalizeCreationOptions(
  json: PasskeyRegisterOptionsJson,
): PublicKeyCredentialCreationOptions {
  return {
    challenge: base64UrlToArrayBuffer(json.challenge),
    rp: json.rp,
    user: {
      id: base64UrlToArrayBuffer(json.user.id),
      name: json.user.name,
      displayName: json.user.displayName,
    },
    pubKeyCredParams: json.pubKeyCredParams,
    timeout: json.timeout,
    attestation: json.attestation,
    authenticatorSelection: json.authenticatorSelection,
    excludeCredentials: (json.excludeCredentials ?? []).map((c) => ({
      id: base64UrlToArrayBuffer(c.id),
      type: c.type,
      transports: c.transports,
    })),
  };
}

// --- credential → run402-postable JSON -----------------------------------

export interface PasskeyAssertionJson {
  id: string;
  rawId: string;
  type: 'public-key';
  authenticatorAttachment?: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
}

export interface PasskeyAttestationJson {
  id: string;
  rawId: string;
  type: 'public-key';
  authenticatorAttachment?: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
}

export function credentialToAssertionJson(cred: PublicKeyCredential): PasskeyAssertionJson {
  const resp = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: arrayBufferToBase64Url(cred.rawId),
    type: 'public-key',
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: arrayBufferToBase64Url(resp.clientDataJSON),
      authenticatorData: arrayBufferToBase64Url(resp.authenticatorData),
      signature: arrayBufferToBase64Url(resp.signature),
      ...(resp.userHandle
        ? { userHandle: arrayBufferToBase64Url(resp.userHandle) }
        : {}),
    },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
  };
}

export function credentialToAttestationJson(cred: PublicKeyCredential): PasskeyAttestationJson {
  const resp = cred.response as AuthenticatorAttestationResponse;
  const transports = typeof resp.getTransports === 'function' ? resp.getTransports() : undefined;
  return {
    id: cred.id,
    rawId: arrayBufferToBase64Url(cred.rawId),
    type: 'public-key',
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: arrayBufferToBase64Url(resp.clientDataJSON),
      attestationObject: arrayBufferToBase64Url(resp.attestationObject),
      ...(transports && transports.length ? { transports } : {}),
    },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
  };
}

// --- support probe -------------------------------------------------------

export function passkeysSupported(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential !== 'undefined'
  );
}

/**
 * Whether the browser supports CONDITIONAL mediation (passkey autofill). When
 * true, we can surface the user's passkey inside the email field's autofill UI
 * instead of a button — so a passkey only ever appears when the device actually
 * has one (and nothing shows when it doesn't). Safe on every browser: returns
 * false when `PublicKeyCredential` or the method is absent.
 */
export async function conditionalMediationAvailable(): Promise<boolean> {
  try {
    const PKC = (globalThis as {
      PublicKeyCredential?: { isConditionalMediationAvailable?: () => Promise<boolean> };
    }).PublicKeyCredential;
    return Boolean(PKC?.isConditionalMediationAvailable && (await PKC.isConditionalMediationAvailable()));
  } catch {
    return false;
  }
}

// --- orchestration: login + register -------------------------------------

/**
 * Drive a WebAuthn login ceremony end-to-end:
 *   1. POST /v1/auth/passkeys/login/options (with email + app_origin)
 *   2. navigator.credentials.get(normalizedOptions)
 *   3. POST /v1/auth/passkeys/login/verify (with challenge_id + assertion)
 *
 * On success the Lambda has set the kysigned_session cookie; the
 * caller is responsible for broadcasting `signed-in` + navigating. Returns
 * the email + ok flag (cookie carries the actual session).
 */
export async function signInWithPasskey(params: {
  email?: string;
}): Promise<{ ok: boolean; email?: string; error?: string }> {
  if (!passkeysSupported()) {
    return { ok: false, error: 'Passkeys not supported in this browser' };
  }
  try {
    const optionsResp = await apiPost<{
      challenge_id: string;
      options: PasskeyLoginOptionsJson;
    }>('/v1/auth/passkeys/login/options', {
      email: params.email,
      app_origin: window.location.origin,
    });

    const credential = (await navigator.credentials.get({
      publicKey: normalizeRequestOptions(optionsResp.options),
    })) as PublicKeyCredential | null;

    if (!credential) {
      return { ok: false, error: 'No passkey selected' };
    }

    const verifyResp = await apiPost<{ ok?: boolean; email?: string; error?: string }>(
      '/v1/auth/passkeys/login/verify',
      {
        challenge_id: optionsResp.challenge_id,
        response: credentialToAssertionJson(credential),
        // The Lambda forwards this as the upstream Origin header so the
        // server-to-server call's WebAuthn binding matches what the browser
        // ceremony used (handles apex vs www. mismatch).
        app_origin: window.location.origin,
      },
    );
    return {
      ok: Boolean(verifyResp.ok),
      email: verifyResp.email,
      error: verifyResp.error,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? 'Passkey sign-in failed' };
  }
}

/**
 * Start a CONDITIONAL (autofill) passkey login. Unlike `signInWithPasskey`, this
 * is usernameless (no email → the server returns a discoverable-credential
 * challenge) and uses `mediation: 'conditional'`, so the browser offers the
 * device's passkeys inside the email field's autofill UI rather than a modal.
 * The returned promise stays pending until the user picks a passkey (or the
 * `signal` aborts on unmount). On success the session cookie is set; the caller
 * broadcasts `signed-in` + refreshes. Resolves `{ok:false}` on abort/no-passkey.
 */
export async function startConditionalPasskeyLogin(opts?: {
  signal?: AbortSignal;
}): Promise<{ ok: boolean; email?: string; error?: string }> {
  if (!passkeysSupported()) return { ok: false, error: 'Passkeys not supported in this browser' };
  try {
    const optionsResp = await apiPost<{
      challenge_id: string;
      options: PasskeyLoginOptionsJson;
    }>('/v1/auth/passkeys/login/options', {
      // No email — a usernameless/discoverable challenge (empty allowCredentials).
      app_origin: window.location.origin,
    });

    const credential = (await navigator.credentials.get({
      publicKey: normalizeRequestOptions(optionsResp.options),
      mediation: 'conditional' as CredentialMediationRequirement,
      signal: opts?.signal,
    })) as PublicKeyCredential | null;

    if (!credential) return { ok: false, error: 'No passkey selected' };

    const verifyResp = await apiPost<{ ok?: boolean; email?: string; error?: string }>(
      '/v1/auth/passkeys/login/verify',
      {
        challenge_id: optionsResp.challenge_id,
        response: credentialToAssertionJson(credential),
        app_origin: window.location.origin,
      },
    );
    return { ok: Boolean(verifyResp.ok), email: verifyResp.email, error: verifyResp.error };
  } catch (e) {
    // AbortError (unmount / navigation) is expected — not a real failure.
    return { ok: false, error: (e as Error).message ?? 'Passkey sign-in failed' };
  }
}

/**
 * Drive a WebAuthn registration ceremony (session-authed):
 *   1. POST /v1/auth/passkeys/register/options (with app_origin + label)
 *   2. navigator.credentials.create(normalizedOptions)
 *   3. POST /v1/auth/passkeys/register/verify (with challenge_id + attestation + label)
 */
export async function registerPasskey(params: {
  label?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!passkeysSupported()) {
    return { ok: false, error: 'Passkeys not supported in this browser' };
  }
  try {
    const optionsResp = await apiPost<{
      challenge_id: string;
      options: PasskeyRegisterOptionsJson;
    }>('/v1/auth/passkeys/register/options', {
      app_origin: window.location.origin,
      label: params.label,
    });

    const credential = (await navigator.credentials.create({
      publicKey: normalizeCreationOptions(optionsResp.options),
    })) as PublicKeyCredential | null;

    if (!credential) {
      return { ok: false, error: 'Registration cancelled' };
    }

    await apiPost('/v1/auth/passkeys/register/verify', {
      challenge_id: optionsResp.challenge_id,
      response: credentialToAttestationJson(credential),
      label: params.label,
      // Same as login/verify: forward the browser's origin so the Lambda's
      // server-to-server Origin header matches the WebAuthn ceremony.
      app_origin: window.location.origin,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? 'Passkey registration failed' };
  }
}
