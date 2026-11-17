/**
 * signerDomainWarnings.test.ts — F-3.9 (#113, DD-87): the editor's live heads-up
 * about a signer's email domain. Only the DOMAIN ever leaves the browser, never
 * for a malformed or plus-alias address; a failed call shows nothing; a response
 * for a value the field no longer holds is never shown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { apiGetPublicMock } = vi.hoisted(() => ({ apiGetPublicMock: vi.fn() }));
vi.mock('./api', async (importActual) => {
  const actual = await importActual<typeof import('./api')>();
  return { ...actual, apiGetPublic: apiGetPublicMock };
});

import {
  domainToCheck,
  fetchDomainWarnings,
  domainWarningMessages,
  useSignerDomainWarnings,
} from './signerDomainWarnings';

beforeEach(() => {
  apiGetPublicMock.mockReset();
});

describe('domainToCheck', () => {
  it('returns the domain part of a well-formed address, lowercased', () => {
    expect(domainToCheck('Jane.Smith@Example.COM')).toBe('example.com');
    expect(domainToCheck('  bob@mailinator.com ')).toBe('mailinator.com');
  });
  it('returns null for a malformed address or a plus-alias (F-3.2a refuses those anyway)', () => {
    for (const bad of ['', 'jane', 'jane@', '@x.com', 'jane@localhost', 'a b@x.com', 'jane+tag@example.com']) {
      expect(domainToCheck(bad)).toBeNull();
    }
  });
});

describe('fetchDomainWarnings', () => {
  it('asks the public endpoint with the domain only', async () => {
    apiGetPublicMock.mockResolvedValue({ warnings: ['disposable'] });
    expect(await fetchDomainWarnings('mailinator.com')).toEqual(['disposable']);
    expect(apiGetPublicMock).toHaveBeenCalledWith('/v1/signer-domain-check?domain=mailinator.com');
  });
  it('drops warning codes it does not know', async () => {
    apiGetPublicMock.mockResolvedValue({ warnings: ['no_sender_protection', 'something_new'] });
    expect(await fetchDomainWarnings('small.test')).toEqual(['no_sender_protection']);
  });
  it('a failed call is null (shown as nothing, and not remembered)', async () => {
    apiGetPublicMock.mockRejectedValue(new Error('offline'));
    expect(await fetchDomainWarnings('x.test')).toBeNull();
    apiGetPublicMock.mockResolvedValue({ nope: true });
    expect(await fetchDomainWarnings('x.test')).toBeNull();
  });
});

describe('domainWarningMessages — the reference wording (F-3.9)', () => {
  it('names the domain and the signer', () => {
    expect(domainWarningMessages(['cannot_receive'], { domain: 'gmial.com', name: 'Jane' })).toEqual([
      'gmial.com can’t receive email. Check the spelling of this address.',
    ]);
    expect(domainWarningMessages(['disposable'], { domain: 'mailinator.com', name: 'Jane' })).toEqual([
      'This looks like a temporary email address. It may stop working before Jane signs.',
    ]);
    expect(domainWarningMessages(['no_sender_protection'], { domain: 'small.test', name: 'Jane' })).toEqual([
      'small.test doesn’t publish email security settings. If Jane’s signature is refused, they may need their email administrator’s help.',
    ]);
  });
  it('falls back to "this signer" when no name is entered yet', () => {
    expect(domainWarningMessages(['disposable', 'no_sender_protection'], { domain: 'd.test', name: '  ' })).toEqual([
      'This looks like a temporary email address. It may stop working before this signer signs.',
      'd.test doesn’t publish email security settings. If this signer’s signature is refused, they may need their email administrator’s help.',
    ]);
  });
  it('uses no dash as a pause (outbound copy rule)', () => {
    const all = domainWarningMessages(['cannot_receive', 'disposable', 'no_sender_protection'], { domain: 'a.test', name: 'A' });
    for (const m of all) expect(m).not.toMatch(/[—–]| - /);
  });
});

describe('useSignerDomainWarnings', () => {
  it('a malformed or plus-alias address is never sent', () => {
    const { result } = renderHook(() => useSignerDomainWarnings());
    act(() => {
      result.current.check('not-an-address');
      result.current.check('jane+tag@example.com');
    });
    expect(apiGetPublicMock).not.toHaveBeenCalled();
  });

  it('checks a domain once, and the answer belongs to every address on that domain', async () => {
    apiGetPublicMock.mockResolvedValue({ warnings: ['disposable'] });
    const { result } = renderHook(() => useSignerDomainWarnings());
    act(() => result.current.check('a@mailinator.com'));
    await waitFor(() => expect(result.current.warningsFor('a@mailinator.com')).toEqual(['disposable']));
    act(() => result.current.check('b@MAILINATOR.com'));
    expect(apiGetPublicMock).toHaveBeenCalledTimes(1);
    expect(result.current.warningsFor('b@mailinator.com')).toEqual(['disposable']);
    expect(result.current.warningsFor('b@gmail.com')).toEqual([]);
  });

  it('a response for a value the field no longer holds is not shown for the new value', async () => {
    let release: (v: unknown) => void = () => {};
    apiGetPublicMock.mockReturnValue(new Promise((res) => { release = res; }));
    const { result } = renderHook(() => useSignerDomainWarnings());
    act(() => result.current.check('a@slow.test'));
    // The field now holds another address; the old answer arrives late.
    await act(async () => release({ warnings: ['cannot_receive'] }));
    expect(result.current.warningsFor('a@other.test')).toEqual([]);
  });

  it('a failed call shows nothing and a later check may ask again', async () => {
    apiGetPublicMock.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useSignerDomainWarnings());
    act(() => result.current.check('a@flaky.test'));
    await waitFor(() => expect(apiGetPublicMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(result.current.warningsFor('a@flaky.test')).toEqual([]);
    apiGetPublicMock.mockResolvedValue({ warnings: ['no_sender_protection'] });
    act(() => result.current.check('a@flaky.test'));
    await waitFor(() => expect(result.current.warningsFor('a@flaky.test')).toEqual(['no_sender_protection']));
    expect(apiGetPublicMock).toHaveBeenCalledTimes(2);
  });
});
