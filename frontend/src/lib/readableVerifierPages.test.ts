// The verifier pages an agent can read (plan 83.3, F-47.3, AC-301; F-47.4): the build
// writes verify.html and hashcheck.html from the built index.html, each with its own
// title, description and explanatory copy inside <div id="root">, which React replaces
// on mount (DD-80). run402 serves /verify from verify.html, so a plain fetch reads
// real text while a browser still gets the interactive tool.
import { describe, expect, it } from 'vitest';
import { READABLE_VERIFIER_PAGES, renderReadablePage } from './readableVerifierPages';

const INDEX = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <title>kysigned</title>',
  '    <script type="module" crossorigin src="/assets/index-AbC123.js"></script>',
  '    <link rel="stylesheet" crossorigin href="/assets/index-DeF456.css">',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '  </body>',
  '</html>',
].join('\n');

const page = (route: string) => {
  const p = READABLE_VERIFIER_PAGES.find((x) => x.route === route);
  if (!p) throw new Error(`no readable page for ${route}`);
  return p;
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');

describe('the readable verifier pages', () => {
  it('cover /verify and /hashcheck, served from verify.html and hashcheck.html', () => {
    expect(READABLE_VERIFIER_PAGES.map((p) => [p.route, p.file])).toEqual([
      ['/verify', 'verify.html'],
      ['/hashcheck', 'hashcheck.html'],
    ]);
  });

  it('each has a descriptive title (never the bare product name) and a description', () => {
    for (const p of READABLE_VERIFIER_PAGES) {
      expect(p.title).not.toBe('kysigned');
      expect(p.title).toMatch(/ \| kysigned$/);
      expect(p.description.length).toBeGreaterThan(40);
    }
  });

  it('/verify says what it checks, that it runs locally, how, and the programmatic paths (F-47.3)', () => {
    const t = text(page('/verify').html);
    expect(t).toMatch(/Verify a signed document/);
    expect(t).toMatch(/never uploaded/);
    expect(t).toMatch(/DKIM/);
    expect(t).toMatch(/npx kysigned verify <bundle\.pdf>/);
    expect(t).toMatch(/verify_bundle/);
    expect(t).toMatch(/npx -y kysigned-mcp/);
  });

  it('/hashcheck says what it checks, that it runs locally, and the programmatic path', () => {
    const t = text(page('/hashcheck').html);
    expect(t).toMatch(/Check your document/);
    expect(t).toMatch(/SHA-256/);
    expect(t).toMatch(/uploaded/);
    expect(t).toMatch(/npx kysigned verify <bundle\.pdf>/);
    expect(t).toMatch(/originalDocSha256/);
    expect(t).toMatch(/verify_bundle/);
  });

  it('both tell an agent that cannot run a program to say so and point to the page or a coding agent (F-47.4)', () => {
    for (const p of READABLE_VERIFIER_PAGES) {
      const t = text(p.html);
      expect(t).toMatch(/cannot run programs/);
      expect(t).toMatch(/say so/);
      expect(t).toMatch(/coding agent/);
    }
  });

  it('no em or en dash in any title, description or copy', () => {
    for (const p of READABLE_VERIFIER_PAGES) {
      for (const s of [p.title, p.description, p.html]) expect(s).not.toMatch(/[–—]/);
    }
  });
});

describe('renderReadablePage', () => {
  it('sets the title and description and puts the copy inside the root, leaving every asset tag as built', () => {
    const p = page('/verify');
    const out = renderReadablePage(INDEX, p);
    expect(out).toContain(`<title>${p.title}</title>`);
    expect(out).toContain('<meta name="description" content="');
    expect(out).toContain(`<div id="root">${p.html}</div>`);
    expect(out).not.toContain('<title>kysigned</title>');
    for (const line of INDEX.split('\n').filter((l) => /<script|<link|<meta charset/.test(l))) expect(out).toContain(line);
  });

  it('refuses an index.html it does not recognize, so a changed shell fails the build', () => {
    const p = page('/verify');
    expect(() => renderReadablePage(INDEX.replace('<title>kysigned</title>', '<title>other</title>'), p)).toThrow(/title/);
    expect(() => renderReadablePage(INDEX.replace('<div id="root"></div>', '<div id="app"></div>'), p)).toThrow(/root/);
  });
});
