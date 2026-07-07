import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test the suite-building logic extracted from test-all.mjs:
// (1) only unit when BASE_URL is unset, (2) unit + e2e + smoke when set.

import { buildSuiteList } from './test-all.mjs';

describe('test-all: buildSuiteList', () => {
  it('includes only unit when BASE_URL is not set', () => {
    const suites = buildSuiteList(undefined);
    assert.deepStrictEqual(suites.map(s => s.name), ['unit']);
  });

  it('includes unit + e2e + smoke when BASE_URL is set', () => {
    const suites = buildSuiteList('http://localhost:4022');
    assert.deepStrictEqual(suites.map(s => s.name), ['unit', 'e2e', 'smoke']);
  });

  it('each suite has a name and command', () => {
    const suites = buildSuiteList('http://localhost:4022');
    for (const suite of suites) {
      assert.ok(suite.name, 'suite should have a name');
      assert.ok(suite.command, 'suite should have a command');
      assert.equal(typeof suite.command, 'string');
    }
  });

  it('unit suite runs npm run test', () => {
    const unit = buildSuiteList(undefined).find(s => s.name === 'unit');
    assert.ok(unit);
    assert.equal(unit.command, 'npm run test');
  });

  it('e2e suite runs npm run test:e2e', () => {
    const e2e = buildSuiteList('http://localhost:4022').find(s => s.name === 'e2e');
    assert.ok(e2e);
    assert.equal(e2e.command, 'npm run test:e2e');
  });

  it('smoke suite runs npm run test:e2e:smoke', () => {
    const smoke = buildSuiteList('http://localhost:4022').find(s => s.name === 'smoke');
    assert.ok(smoke);
    assert.equal(smoke.command, 'npm run test:e2e:smoke');
  });
});
