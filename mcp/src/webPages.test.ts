/**
 * The negotiated content pages (82.5, F-46.8, DD-75): the agent function
 * answers each page URL with the page's HTML for browsers and its markdown
 * twin for agents, fetched from the copies staged under /_agent/pages/.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_PAGE_NAMES, matchPagePath, prefersMarkdown, servePage } from './webPages.js';

const ORIGIN = 'https://kysigned.test';
const PAGE_HTML = '<!DOCTYPE html><html><head><title>FAQ | kysigned</title></head><body><h1>FAQ</h1>é</body></html>';
const PAGE_MD = '---\ntitle: "Frequently asked questions"\nurl: /faq\n---\n\n# Frequently asked questions\n\nYou sign by forwarding.\n';

function staticHost(files: Record<string, string>) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const path = new URL(url).pathname;
    if (path in files) {
      const type = path.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
      return new Response(files[path], { status: 200, headers: { 'Content-Type': type } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const FILES = { '/_agent/pages/faq.html': PAGE_HTML, '/_agent/pages/faq.md': PAGE_MD };
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

async function page(path: string, accept: string | null, method = 'GET', files: Record<string, string> = FILES) {
  const host = staticHost(files);
  const m = matchPagePath(path);
  assert.ok(m, `${path} is a page URL`);
  const headers: Record<string, string> = {};
  if (accept !== null) headers['Accept'] = accept;
  const res = await servePage(new Request(`${ORIGIN}${path}`, { method, headers }), m!, { origin: ORIGIN, fetchFn: host.fetchFn });
  return { res, calls: host.calls };
}

describe('prefersMarkdown', () => {
  const cases: Array<[string | null, boolean]> = [
    ['text/markdown', true],
    ['text/markdown, text/html', true],
    ['text/html, text/markdown', true],
    ['text/markdown, text/html;q=0.9, */*;q=0.8', true],
    ['text/html;q=0.8, text/markdown;q=0.9', true],
    ['text/html, text/markdown;q=0.5', false],
    ['text/markdown;q=0', false],
    ['*/*', false],
    ['text/*', false],
    [BROWSER, false],
    ['*/*;q=1, text/markdown;q=0.9', false],
    ['TEXT/Markdown', true],
    ['', false],
    [null, false],
  ];
  for (const [accept, want] of cases) {
    it(`${JSON.stringify(accept)} -> ${want ? 'markdown' : 'html'}`, () => assert.equal(prefersMarkdown(accept), want));
  }
});

describe('matchPagePath', () => {
  it('every negotiated page, on every URL form', () => {
    assert.deepEqual([...AGENT_PAGE_NAMES], ['how-it-works', 'how-it-works-technical', 'faq', 'pricing']);
    for (const name of AGENT_PAGE_NAMES) {
      assert.deepEqual(matchPagePath(`/${name}`), { name, form: 'extensionless' });
      assert.deepEqual(matchPagePath(`/${name}.html`), { name, form: 'html' });
      assert.deepEqual(matchPagePath(`/${name}.md`), { name, form: 'md' });
    }
  });

  it('nothing else: not the homepage, legal pages, or near misses', () => {
    for (const p of ['/', '/index.html', '/terms', '/privacy.html', '/faq/', '/faq.htm', '/faqs', '/_agent/pages/faq.html', '/dashboard']) {
      assert.equal(matchPagePath(p), null, p);
    }
  });
});

describe('servePage (AC-292 hermetic part)', () => {
  it('a markdown Accept gets the twin with its headers and an absolute canonical URL', async () => {
    const { res, calls } = await page('/faq', 'text/markdown');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(res.headers.get('vary'), 'Accept');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=0, must-revalidate');
    const body = await res.text();
    assert.ok(body.startsWith('---\ntitle: "Frequently asked questions"\nurl: https://kysigned.test/faq\n---\n'));
    assert.equal(res.headers.get('x-markdown-tokens'), String(Math.ceil(body.length / 4)));
    assert.deepEqual(calls, [`${ORIGIN}/_agent/pages/faq.md`]);
  });

  it('a browser gets the staged HTML byte for byte, on both URL forms', async () => {
    for (const path of ['/faq', '/faq.html']) {
      const { res, calls } = await page(path, BROWSER);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(res.headers.get('vary'), 'Accept');
      assert.equal(res.headers.get('x-markdown-tokens'), null);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(PAGE_HTML), `${path}: identical bytes`);
      assert.deepEqual(calls, [`${ORIGIN}/_agent/pages/faq.html`]);
    }
  });

  it('*/* and a missing Accept get HTML', async () => {
    for (const accept of ['*/*', null]) {
      const { res } = await page('/faq.html', accept);
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    }
  });

  it('the .md address always answers markdown, whatever the Accept header', async () => {
    for (const accept of [BROWSER, null, 'text/html']) {
      const { res } = await page('/faq.md', accept);
      assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
      assert.match(await res.text(), /# Frequently asked questions/);
    }
  });

  it('HEAD answers the same headers with no body', async () => {
    const { res } = await page('/faq', 'text/markdown', 'HEAD');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(await res.text(), '');
  });

  it('a missing staged copy is a 502 with plain text, never an empty 200', async () => {
    const { res } = await page('/pricing', 'text/markdown', 'GET', {});
    assert.equal(res.status, 502);
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
  });
});
