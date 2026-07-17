/**
 * operator.test — F-33.1 / AC-177 operator authorization predicate.
 *
 * `isOperator` is the whole operator authorization decision: an authenticated
 * email is an operator iff it is a member of the operator-config allowlist,
 * case-insensitively. It is FAIL-CLOSED — an empty/absent allowlist (a fresh
 * install or a fresh fork, AC-181) authorizes nobody — and null-safe, so the
 * gate can call it with a possibly-null session email.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isOperator } from './operator.js';

describe('isOperator — F-33.1 / AC-177', () => {
  it('an exact allowlist member is an operator', () => {
    assert.equal(isOperator('op@kychee.com', ['op@kychee.com']), true);
  });

  it('matches case-insensitively on the email', () => {
    assert.equal(isOperator('OP@Kychee.com', ['op@kychee.com']), true);
  });

  it('matches case-insensitively on the allowlist entry', () => {
    assert.equal(isOperator('op@kychee.com', ['OP@KYCHEE.COM']), true);
  });

  it('trims surrounding whitespace before comparing', () => {
    assert.equal(isOperator('  op@kychee.com  ', ['op@kychee.com']), true);
  });

  it('a non-member is not an operator', () => {
    assert.equal(isOperator('creator@example.com', ['op@kychee.com']), false);
  });

  it('FAIL-CLOSED — an empty allowlist authorizes nobody (fresh install / fork, AC-181)', () => {
    assert.equal(isOperator('op@kychee.com', []), false);
  });

  it('null / undefined / empty email is never an operator', () => {
    assert.equal(isOperator(null, ['op@kychee.com']), false);
    assert.equal(isOperator(undefined, ['op@kychee.com']), false);
    assert.equal(isOperator('', ['op@kychee.com']), false);
  });
});
