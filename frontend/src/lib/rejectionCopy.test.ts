/**
 * rejectionCopy — the dashboard's plain-words guidance per rejection class
 * (F-45.5 / AC-275): what went wrong, what to tell the signer, and the provider's
 * FAQ steps for the two "domain has no DKIM" classes.
 */
import { describe, it, expect } from 'vitest';
import { rejectionGuidance, REJECTION_CLASSES } from './rejectionCopy';

const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);

describe('rejectionGuidance (F-45.5)', () => {
  it('covers all seven classes the API can send', () => {
    expect([...REJECTION_CLASSES].sort()).toEqual([
      'attachment_missing', 'attachment_modified', 'dkim_unverifiable', 'google_workspace_no_dkim',
      'microsoft_365_no_dkim', 'sender_auth', 'wrong_phrase',
    ]);
  });

  it('Google Workspace: names the provider, DKIM, the Admin console, and links the Google steps', () => {
    const g = rejectionGuidance('google_workspace_no_dkim');
    expect(g.reason).toMatch(/Google Workspace/);
    expect(g.tell).toMatch(/DKIM/);
    expect(g.tell).toMatch(/Google Admin console/);
    expect(g.faqHref).toBe('/faq#email-setup-google');
  });

  it('Microsoft 365: names the provider, DKIM, the Defender portal, and links the Microsoft steps', () => {
    const g = rejectionGuidance('microsoft_365_no_dkim');
    expect(g.reason).toMatch(/Microsoft 365/);
    expect(g.tell).toMatch(/DKIM/);
    expect(g.tell).toMatch(/Microsoft Defender portal/);
    expect(g.faqHref).toBe('/faq#email-setup-microsoft');
  });

  it('the self-fixable classes say what was wrong and that the signer was already told', () => {
    const expected: Record<string, RegExp> = {
      wrong_phrase: /didn.t start with .I sign this document./,
      attachment_missing: /didn.t include the attached document/,
      attachment_modified: /attached to their last forward had been changed/,
      sender_auth: /didn.t pass our sender checks/,
      dkim_unverifiable: /signature on their last forward didn.t verify/,
    };
    for (const [cls, reason] of Object.entries(expected)) {
      const g = rejectionGuidance(cls);
      expect(g.reason, cls).toMatch(reason);
      expect(g.tell, cls).toMatch(/already emailed them/);
      expect(g.faqHref, cls).toBeUndefined();
    }
  });

  it('an unknown class still yields a plain, generic line', () => {
    const g = rejectionGuidance('something_new');
    expect(g.reason).toMatch(/last forward wasn.t accepted/);
    expect(g.tell).toMatch(/already emailed them/);
  });

  it('no em or en dash anywhere in the copy', () => {
    for (const cls of [...REJECTION_CLASSES, 'something_new']) {
      const g = rejectionGuidance(cls);
      for (const s of [g.reason, g.tell]) {
        expect(s.includes(EM_DASH) || s.includes(EN_DASH), `${cls}: ${s}`).toBe(false);
      }
    }
  });
});
