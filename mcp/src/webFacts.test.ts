/**
 * webFacts lockstep (82.2, F-46.11 / AC-281 / AC-294): the web front door's
 * one source of auth and payment facts must match what the API actually
 * honors. Cross-package, test-only reads of the root source (the pattern
 * contract.test.ts uses for #155): a renamed prefix, route or error code in
 * the API fails this suite instead of leaving the agent docs wrong.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WEB_FACTS } from './webFacts.js';

const root = new URL('../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

describe('WEB_FACTS match the API', () => {
  it('the creator key and tracking token prefixes', async () => {
    const { API_KEY_PREFIX } = await import('../../src/api/auth/apiKeyAuth.js');
    const { TRACKING_TOKEN_PREFIX } = await import('../../src/api/trackingToken.js');
    assert.equal(WEB_FACTS.apiKeyPrefix, API_KEY_PREFIX);
    assert.equal(WEB_FACTS.trackingTokenPrefix, TRACKING_TOKEN_PREFIX);
  });

  it('the x402 create route, the free preflight and the status read are real routes', async () => {
    const { X402_CREATE_ROUTE } = await import('../../src/api/createGate.js');
    assert.equal(WEB_FACTS.x402CreatePath, X402_CREATE_ROUTE);
    const router = read('src/integrations/run402Router.ts');
    assert.ok(router.includes(`pattern: '${WEB_FACTS.preflightPath}'`), 'preflight route');
    assert.ok(router.includes(`pattern: '${WEB_FACTS.envelopeStatusPattern}'`), 'status read route');
  });

  it('the auth error codes the docs name are the ones the API returns', () => {
    const api = read('src/functions/api.ts');
    for (const code of Object.values(WEB_FACTS.errorCodes)) {
      assert.ok(api.includes(`code: '${code}'`), `src/functions/api.ts returns ${code}`);
    }
  });

  it('the key-minting page is a real SPA route', () => {
    assert.ok(read('frontend/src/App.tsx').includes(`path="${WEB_FACTS.apiKeysPath}"`));
  });

  it('the local package name is the published one', () => {
    const pkg = JSON.parse(read('mcp/package.json')) as { name: string };
    assert.equal(WEB_FACTS.localPackage, pkg.name);
  });
});
