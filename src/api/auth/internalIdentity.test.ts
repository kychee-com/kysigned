/**
 * internalIdentity.test — F-35.4 / AC-191, the operator-console internal-identity
 * matcher. A record's creator is "internal" when it matches a configured rule in
 * one of three forms: an exact email, a whole domain (`@domain`), or a
 * domain-scoped glob (`prefix*@domain`). Matching is case-insensitive; an empty
 * rule set matches nobody (a fresh fork excludes only internal_test envelopes).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInternalIdentity } from './internalIdentity.js';

const RULES = ['@kychee.com', 'volinskey@gmail.com', 'redteam-*@kysigned.com'];

describe('isInternalIdentity (F-35.4 / AC-191)', () => {
  it('a whole-domain rule matches every mailbox at that domain, case-insensitively', () => {
    assert.equal(isInternalIdentity('AGENT-smoke@Kychee.com', RULES), true);
    assert.equal(isInternalIdentity('tal@kychee.com', RULES), true);
  });

  it('an exact-email rule matches only that address (case-insensitive)', () => {
    assert.equal(isInternalIdentity('volinskey@gmail.com', RULES), true);
    assert.equal(isInternalIdentity('VOLINSKEY@GMAIL.COM', RULES), true);
    assert.equal(isInternalIdentity('someoneelse@gmail.com', RULES), false);
  });

  it('a domain-scoped glob matches a local-part prefix at exactly that domain', () => {
    assert.equal(isInternalIdentity('redteam-pilot@kysigned.com', RULES), true);
    assert.equal(isInternalIdentity('redteam-paywall@kysigned.com', RULES), true);
    // the glob must not cross the @ boundary or match a different domain
    assert.equal(isInternalIdentity('redteam-pilot@evil.com', RULES), false);
    assert.equal(isInternalIdentity('other@kysigned.com', RULES), false);
  });

  it('external identities matching no rule classify external', () => {
    assert.equal(isInternalIdentity('jrdrake22@gmail.com', RULES), false);
    assert.equal(isInternalIdentity('babyproject418@gmail.com', RULES), false);
  });

  it('an empty rule set matches nobody (fresh-fork default)', () => {
    assert.equal(isInternalIdentity('barry@kychee.com', []), false);
    assert.equal(isInternalIdentity('anyone@anywhere.com', []), false);
  });

  it('a null / blank / malformed email is never internal', () => {
    assert.equal(isInternalIdentity(null, RULES), false);
    assert.equal(isInternalIdentity(undefined, RULES), false);
    assert.equal(isInternalIdentity('   ', RULES), false);
    assert.equal(isInternalIdentity('not-an-email', RULES), false);
  });
});
