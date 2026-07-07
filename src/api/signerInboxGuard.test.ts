/**
 * signerInboxGuard tests (#96 / F-3.2a, AC-88 + AC-89).
 *
 * Two signers on one inbox forward from the same address with the same DKIM
 * identity (indistinguishable), and a plus-alias signer's forward replies from
 * the PRIMARY address (so it may never match the invited alias). Both are
 * forbidden at envelope creation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSignerAddresses, isPlusAlias, normalizeInbox } from './signerInboxGuard.js';

describe('signerInboxGuard — normalizeInbox / isPlusAlias', () => {
  it('lowercases + trims and leaves a normal address otherwise unchanged', () => {
    assert.equal(normalizeInbox('  Bob@Company.COM '), 'bob@company.com');
  });
  it('strips dots and unifies googlemail→gmail ONLY for gmail', () => {
    assert.equal(normalizeInbox('b.o.b@gmail.com'), 'bob@gmail.com');
    assert.equal(normalizeInbox('bob@googlemail.com'), 'bob@gmail.com');
    // dots are significant for non-gmail domains
    assert.equal(normalizeInbox('b.o.b@company.com'), 'b.o.b@company.com');
  });
  it('drops a +tag in the normalized inbox identity', () => {
    assert.equal(normalizeInbox('user+tester@gmail.com'), 'user@gmail.com');
  });
  it('detects a plus-alias by a + in the local part', () => {
    assert.equal(isPlusAlias('user+tester@gmail.com'), true);
    assert.equal(isPlusAlias('user@gmail.com'), false);
    assert.equal(isPlusAlias('a+b@x.com'), true);
  });
});

describe('checkSignerAddresses — #96 guard', () => {
  it('rejects a lone plus-alias signer, naming the address + primary (AC-89)', () => {
    const issue = checkSignerAddresses([{ email: 'user+tester@gmail.com' }]);
    assert.ok(issue);
    assert.equal(issue.code, 'validation_plus_alias');
    assert.match(issue.message, /user\+tester@gmail\.com/);
    assert.match(issue.message, /user@gmail\.com/); // names the primary form
  });

  it('rejects a plus-alias even alongside a valid distinct signer (AC-89)', () => {
    const issue = checkSignerAddresses([
      { email: 'real@company.com' },
      { email: 'bob+sneaky@example.com' },
    ]);
    assert.ok(issue);
    assert.equal(issue.code, 'validation_plus_alias');
    assert.match(issue.message, /bob\+sneaky@example\.com/);
  });

  it('rejects two case-insensitive exact duplicates, naming both (AC-88)', () => {
    const issue = checkSignerAddresses([
      { email: 'Alice@Example.com' },
      { email: 'alice@example.COM' },
    ]);
    assert.ok(issue);
    assert.equal(issue.code, 'validation_same_inbox');
    assert.match(issue.message, /Alice@Example\.com/);
    assert.match(issue.message, /alice@example\.COM/);
  });

  it('rejects two Gmail dot-variants as the same inbox (AC-88)', () => {
    const issue = checkSignerAddresses([
      { email: 'n.a.me@gmail.com' },
      { email: 'name@gmail.com' },
    ]);
    assert.ok(issue);
    assert.equal(issue.code, 'validation_same_inbox');
  });

  it('rejects a googlemail-vs-gmail collision as the same inbox (AC-88)', () => {
    const issue = checkSignerAddresses([
      { email: 'bob@googlemail.com' },
      { email: 'bob@gmail.com' },
    ]);
    assert.ok(issue);
    assert.equal(issue.code, 'validation_same_inbox');
  });

  it('accepts signers on distinct primary inboxes (AC-88)', () => {
    assert.equal(
      checkSignerAddresses([
        { email: 'alice@example.com' },
        { email: 'bob@example.com' },
      ]),
      null,
    );
  });

  it('does NOT collapse dots for non-gmail domains (distinct → accepted)', () => {
    assert.equal(
      checkSignerAddresses([
        { email: 'b.o.b@company.com' },
        { email: 'bob@company.com' },
      ]),
      null,
    );
  });

  it('accepts a single ordinary signer', () => {
    assert.equal(checkSignerAddresses([{ email: 'solo@example.com' }]), null);
  });
});

describe('checkSignerAddresses — #110 renderable signer fields (embedded Unicode font)', () => {
  it('ACCEPTS Cyrillic / Greek / Hebrew / Arabic names + orgs (renderable now, rejected pre-#110)', () => {
    assert.equal(
      checkSignerAddresses([{ email: 'a@example.com', name: 'Александр', on_behalf_of: 'Αcme Ελλάς' }]),
      null,
      'Cyrillic name + Greek org',
    );
    assert.equal(checkSignerAddresses([{ email: 'b@example.com', name: 'דוד כהן' }]), null, 'Hebrew name');
    assert.equal(checkSignerAddresses([{ email: 'c@example.com', name: 'محمد بن عبد الله' }]), null, 'Arabic name');
  });

  it('accepts an internationalized (Cyrillic) email domain — renders now (#110)', () => {
    // 'gmaіl.com' uses U+0456 (Cyrillic i). Pre-#110 the WinAnsi gate rejected it as a
    // side effect; DejaVu renders it, and kysigned verifies mailbox control + the
    // signer's own DKIM, not identity (F-15.3), so it no longer blocks here.
    assert.equal(checkSignerAddresses([{ email: 'user@gmaіl.com' }]), null);
  });

  it('rejects a signer NAME the embedded font cannot draw (CJK), naming the char + code point + FAQ', () => {
    const issue = checkSignerAddresses([{ email: 'lei@example.com', name: '李雷' }]);
    assert.ok(issue);
    assert.equal(issue.code, 'validation_unrenderable');
    assert.match(issue.message, /name/i);
    assert.match(issue.message, /李/, 'names the offending character');
    assert.match(issue.message, /Chinese, Japanese, and Korean/);
    assert.match(issue.message, /FAQ/i);
  });

  it('rejects a Korean organisation (on_behalf_of), naming the field', () => {
    const issue = checkSignerAddresses([
      { email: 'a@example.com', name: 'A', on_behalf_of: '한국 주식회사' }, // Hangul
    ]);
    assert.ok(issue);
    assert.equal(issue.code, 'validation_unrenderable');
    assert.match(issue.message, /organisation/i);
  });

  it('accepts WinAnsi-encodable names and organisations (José / Café S.à r.l.)', () => {
    assert.equal(
      checkSignerAddresses([{ email: 'jose@example.com', name: 'José', on_behalf_of: 'Café S.à r.l.' }]),
      null,
    );
  });

  it('checks renderability BEFORE the alias / collision rules', () => {
    // BOTH a font-unrenderable name (CJK) AND a plus-alias → reports `validation_unrenderable` first.
    const issue = checkSignerAddresses([{ email: 'user+tag@example.com', name: '中' }]);
    assert.equal(issue?.code, 'validation_unrenderable');
  });
});
