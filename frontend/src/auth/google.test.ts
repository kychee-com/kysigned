/**
 * google.test.ts — the SPA side of the F-41 ceremony (DD-59/60): methods
 * cache, the sessionStorage stash, the hash reader's gc_-only discipline, and
 * the start call's wire shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  apiGet: apiGetMock,
  apiPost: apiPostMock,
}));

import {
  fetchAuthMethods,
  resetAuthMethodsCache,
  startGoogleSignIn,
  readGoogleHash,
  stashGoogleDraft,
  takeGoogleDraftStash,
  peekGoogleDraftStash,
  GOOGLE_DRAFT_STASH_KEY,
} from './google';

const CEREMONY = 'gc_00000000-0000-4000-8000-000000000001';
const HANDLE = 'ps_00000000-0000-4000-8000-000000000000.' + 'S'.repeat(43);

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  resetAuthMethodsCache();
  sessionStorage.clear();
});

describe('fetchAuthMethods', () => {
  it('reports the platform answer and caches it for the page load', async () => {
    apiGetMock.mockResolvedValue({ google: true });
    expect(await fetchAuthMethods()).toEqual({ google: true });
    expect(await fetchAuthMethods()).toEqual({ google: true });
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it('fails to the email-only gate: an unreachable API reads {google:false}', async () => {
    apiGetMock.mockRejectedValue(new Error('offline'));
    expect(await fetchAuthMethods()).toEqual({ google: false });
  });
});

describe('startGoogleSignIn', () => {
  it('posts the trigger + draft handle and stashes the handle for the round trip', async () => {
    apiPostMock.mockResolvedValue({ authorization_url: 'https://accounts.google.com/x' });
    const url = await startGoogleSignIn({ trigger: 'send', draftHandle: HANDLE });
    expect(url).toBe('https://accounts.google.com/x');
    expect(apiPostMock).toHaveBeenCalledWith('/v1/auth/google/start', { trigger: 'send', draft_id: HANDLE });
    expect(sessionStorage.getItem(GOOGLE_DRAFT_STASH_KEY)).toBe(HANDLE);
  });

  it('a deliberate sign-in posts no draft and stashes nothing', async () => {
    apiPostMock.mockResolvedValue({ authorization_url: 'https://accounts.google.com/x' });
    await startGoogleSignIn({ trigger: 'direct' });
    expect(apiPostMock).toHaveBeenCalledWith('/v1/auth/google/start', { trigger: 'direct' });
    expect(sessionStorage.getItem(GOOGLE_DRAFT_STASH_KEY)).toBeNull();
  });

  it('throws when the server has no authorization_url (the gate shows friendly copy)', async () => {
    apiPostMock.mockResolvedValue({});
    await expect(startGoogleSignIn({ trigger: 'direct' })).rejects.toThrow();
  });
});

describe('readGoogleHash — gc_-only discipline', () => {
  it('reads a success hash and a failure hash, both carrying the ceremony', () => {
    expect(readGoogleHash(`#code=abc&state=${CEREMONY}`)).toEqual({ kind: 'code', code: 'abc', ceremony: CEREMONY });
    expect(readGoogleHash(`#error=account_exists_requires_link&state=${CEREMONY}`)).toEqual({
      kind: 'error',
      error: 'account_exists_requires_link',
      ceremony: CEREMONY,
    });
  });

  it('ignores a foreign state, a missing state, and an empty hash', () => {
    expect(readGoogleHash('#code=abc&state=not-ours')).toBeNull();
    expect(readGoogleHash('#code=abc')).toBeNull();
    expect(readGoogleHash('')).toBeNull();
    expect(readGoogleHash('#unrelated=1')).toBeNull();
  });
});

describe('the draft stash — single-use across the round trip', () => {
  it('take reads AND clears; peek only reads', () => {
    stashGoogleDraft(HANDLE);
    expect(peekGoogleDraftStash()).toBe(HANDLE);
    expect(takeGoogleDraftStash()).toBe(HANDLE);
    expect(takeGoogleDraftStash()).toBeNull();
  });
});
