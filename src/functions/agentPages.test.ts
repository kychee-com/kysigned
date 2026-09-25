/**
 * Markdown twins at staging (82.5, F-46.8, DD-75). scripts/lib/agentPages.mjs
 * runs on both deploy paths after the site is final: it copies each
 * negotiated page, byte for byte, to _agent/pages/<page>.html and writes the
 * markdown twin beside it, so the agent function always serves the copy that
 * shipped with the site (a --site-only deploy stays correct).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_PAGES_DIR, TEMPLATE_AGENT_PAGES, pageToMarkdown, stageAgentPages } from '../../scripts/lib/agentPages.mjs';

const PUBLIC = join(import.meta.dirname, '..', '..', 'frontend', 'public');

// The public template's shape: header, <main>, footer.
const MAIN_PAGE = `<!DOCTYPE html><html><head><title>FAQ | kysigned</title>
<link rel="canonical" href="https://kysigned.example/faq"><style>.x{color:red}</style></head>
<body><header><a href="/">brand</a><nav aria-label="Main"><a href="/faq">FAQ</a></nav></header>
<main><h1>Frequently asked questions</h1><p>You sign by <strong>forwarding</strong> the email.</p>
<script>window.evil = 1</script>
<table><tr><th>Claim</th><th>Proof</th></tr><tr><td>signer</td><td>DKIM</td></tr></table></main>
<footer>Template footer text</footer></body></html>`;

// kysigned.com's shape after staging: no <main>, the stamped site header, scripts, a footer.
const STAMPED_PAGE = `<!DOCTYPE html><html><head><title>How it works | kysigned</title>
<script>gtag('config','G-XXXX')</script></head><body>
<!--ksgn:site-header--><header class="ksgn-site-header"><a href="/">kysigned</a><a href="/pricing.html">Pricing</a></header><script>menu()</script>
<div class="container"><section class="hero"><h1>How signing works</h1><p>The signature <em>is</em> an email.</p>
<div class="video-frame"><a class="video-embed" href="https://youtu.be/example" aria-label="Play the explainer video (53 seconds)">\n  <img src="/explainer-poster.jpg" alt="">\n  <span class="video-play"><svg viewBox="0 0 1 1"><path d="M0,0"/></svg></span>\n</a><button>Play video</button></div><a href="/nowhere"> <span> </span> </a></section>
<section><h2>Trust</h2><p>Anyone can verify it.</p></section></div>
<footer><p>© Kychee</p></footer><script>facade()</script></body></html>`;

describe('pageToMarkdown (DD-75)', () => {
  it('a <main> page: only the main content, front matter from its h1 and canonical link', () => {
    const md = pageToMarkdown(MAIN_PAGE, { pagePath: '/faq' });
    assert.ok(md.startsWith('---\ntitle: "Frequently asked questions"\nurl: https://kysigned.example/faq\n---\n\n'), md.slice(0, 120));
    assert.match(md, /# Frequently asked questions/);
    assert.match(md, /You sign by \*\*forwarding\*\* the email\./);
    for (const gone of ['brand', 'Template footer text', 'window.evil', 'color:red', '<']) {
      assert.ok(!md.includes(gone), `${gone} must not reach the markdown`);
    }
    assert.match(md, /\| Claim \| Proof \|/, 'table padding is collapsed');
  });

  it('a stamped page with no <main>: header, nav, footer, scripts, images and buttons are stripped', () => {
    const md = pageToMarkdown(STAMPED_PAGE, { pagePath: '/how-it-works' });
    assert.ok(md.startsWith('---\ntitle: "How signing works"\nurl: /how-it-works\n---\n\n'), 'h1 title; path when no canonical');
    assert.match(md, /# How signing works/);
    assert.match(md, /The signature _is_ an email\./);
    assert.match(md, /## Trust/);
    assert.match(md, /\[Play the explainer video \(53 seconds\)\]\(https:\/\/youtu\.be\/example\)/, 'a text-less link keeps its aria-label');
    for (const gone of ['Pricing', 'Kychee', 'gtag', 'menu()', 'facade()', 'Play video', 'explainer-poster', '/nowhere', '[ ]', '<']) {
      assert.ok(!md.includes(gone), `${gone} must not reach the markdown`);
    }
  });

  it('the real template pages convert cleanly', () => {
    for (const page of TEMPLATE_AGENT_PAGES) {
      const html = readFileSync(join(PUBLIC, `${page}.html`), 'utf8');
      const md = pageToMarkdown(html, { pagePath: `/${page}` });
      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)![1]!.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();
      assert.ok(md.includes(h1.split(/\s+/)[0]!), `${page}: its heading survives`);
      assert.ok(!/<(div|section|script|style|nav|footer|header)\b/.test(md), `${page}: no HTML left`);
      assert.ok(md.length < html.length, `${page}: the twin is smaller than the page`);
    }
  });
});

describe('stageAgentPages', () => {
  function site(pages: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'agent-pages-'));
    for (const [name, html] of Object.entries(pages)) writeFileSync(join(dir, `${name}.html`), html);
    return dir;
  }

  it('copies each page byte for byte and writes its twin beside it', () => {
    const dir = site({ faq: MAIN_PAGE, 'how-it-works': STAMPED_PAGE });
    const written = stageAgentPages(dir, ['faq', 'how-it-works']);
    assert.deepEqual(written.sort(), [
      `${AGENT_PAGES_DIR}/faq.html`,
      `${AGENT_PAGES_DIR}/faq.md`,
      `${AGENT_PAGES_DIR}/how-it-works.html`,
      `${AGENT_PAGES_DIR}/how-it-works.md`,
    ]);
    assert.equal(readFileSync(join(dir, AGENT_PAGES_DIR, 'faq.html'), 'utf8'), MAIN_PAGE);
    assert.equal(readFileSync(join(dir, AGENT_PAGES_DIR, 'faq.md'), 'utf8'), pageToMarkdown(MAIN_PAGE, { pagePath: '/faq' }));
    assert.ok(existsSync(join(dir, 'faq.html')), 'the public-path original stays');
  });

  it('a negotiated page missing from the staged site fails staging', () => {
    const dir = site({ faq: MAIN_PAGE });
    assert.throws(() => stageAgentPages(dir, ['faq', 'pricing']), /pricing\.html/);
  });

  it('the template negotiates exactly its three public content pages (no pricing, no legal)', () => {
    assert.deepEqual([...TEMPLATE_AGENT_PAGES], ['how-it-works', 'how-it-works-technical', 'faq']);
  });
});

describe('each template page links its markdown (AC-293)', () => {
  it('carries <link rel="alternate" type="text/markdown" href="/<page>.md">', () => {
    for (const page of ['how-it-works', 'how-it-works-technical', 'faq']) {
      const html = readFileSync(join(PUBLIC, `${page}.html`), 'utf8');
      assert.ok(
        html.includes(`<link rel="alternate" type="text/markdown" href="/${page}.md">`),
        `${page}.html links /${page}.md`,
      );
    }
  });
});
