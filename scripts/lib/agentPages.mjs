/**
 * agentPages — markdown twins for the negotiated content pages (F-46.8,
 * DD-75). Runs on the STAGED site, after every page transform (kysigned.com:
 * scripts/deploy.ts right after stampCanonicalPages; forks: scripts/deploy.mjs
 * and the `run402 up` build), and writes, for each page:
 *   _agent/pages/<page>.html  a byte-for-byte copy of the staged page
 *   _agent/pages/<page>.md    its markdown twin
 * The kysigned-agent function serves both from there, so the copy an agent or
 * a browser gets is always the one that shipped with the site, and a
 * --site-only deploy stays correct. The public-path originals stay in place.
 *
 * Plain ESM with a CLI form, so every deploy path can use it:
 *   node scripts/lib/agentPages.mjs <siteDir> [page ...]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { parse } from 'node-html-parser';

/** The template's negotiated pages (F-46.12): its three public content pages. kysigned.com adds `pricing`. */
export const TEMPLATE_AGENT_PAGES = Object.freeze(['how-it-works', 'how-it-works-technical', 'faq']);

/** Where the staged copies live, relative to the site root. */
export const AGENT_PAGES_DIR = '_agent/pages';

// Chrome and non-text content that must not reach an agent. Without a <main>
// (kysigned.com's pages) the site header, nav and footer go too.
const ALWAYS_DROP = ['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'video', 'audio', 'canvas', 'img', 'picture', 'button', 'form'];
const CHROME = ['header', 'nav', 'footer'];

const converter = new NodeHtmlMarkdown({ bulletMarker: '-', codeBlockStyle: 'fenced', maxConsecutiveNewlines: 2 });

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function text(node) {
  return node ? node.text.replace(/\s+/g, ' ').trim() : '';
}

/** Collapse the converter's column padding in table rows (it costs agents tokens, not meaning). */
function tightenTables(md) {
  return md
    .split('\n')
    .map((line) => (line.startsWith('|') ? line.replace(/ {2,}/g, ' ').replace(/-{4,}/g, '---') : line))
    .join('\n');
}

/**
 * The markdown twin of one staged page: YAML front matter (title from the
 * first <h1>, since both how-it-works pages share one <title>; url from the
 * canonical link, else the page path) and the page's content as markdown.
 */
export function pageToMarkdown(html, { pagePath }) {
  const root = parse(html, { comment: false });
  const title = text(root.querySelector('h1')) || text(root.querySelector('title'));
  const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute('href') || pagePath;
  const main = root.querySelector('main');
  const content = main ?? root.querySelector('body') ?? root;
  for (const sel of main ? ALWAYS_DROP : [...ALWAYS_DROP, ...CHROME]) {
    for (const el of content.querySelectorAll(sel)) el.remove();
  }
  // A link whose only content was media (the video facade) keeps its accessible
  // name as its text; with no name at all it would be an empty `[ ](...)`.
  for (const a of content.querySelectorAll('a')) {
    if (text(a)) continue;
    const label = (a.getAttribute('aria-label') || a.getAttribute('title') || '').trim();
    if (label) a.set_content(escapeHtml(label));
    else a.remove();
  }
  const body = tightenTables(converter.translate(content.innerHTML)).replace(/\n{3,}/g, '\n\n').trim();
  return `---\ntitle: ${JSON.stringify(title)}\nurl: ${canonical}\n---\n\n${body}\n`;
}

/**
 * Stage the twins for `pages` in `siteDir`. Returns the written paths,
 * relative to the site root. A page missing from the site fails staging.
 */
export function stageAgentPages(siteDir, pages) {
  const outDir = join(siteDir, AGENT_PAGES_DIR);
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const page of pages) {
    const src = join(siteDir, `${page}.html`);
    if (!existsSync(src)) {
      throw new Error(`agent page ${page}.html is missing from ${siteDir}; every negotiated page must be staged (F-46.8)`);
    }
    copyFileSync(src, join(outDir, `${page}.html`));
    writeFileSync(join(outDir, `${page}.md`), pageToMarkdown(readFileSync(src, 'utf8'), { pagePath: `/${page}` }));
    written.push(`${AGENT_PAGES_DIR}/${page}.html`, `${AGENT_PAGES_DIR}/${page}.md`);
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [siteDir, ...pages] = process.argv.slice(2);
  if (!siteDir) {
    console.error('usage: node scripts/lib/agentPages.mjs <siteDir> [page ...]');
    process.exit(2);
  }
  const written = stageAgentPages(siteDir, pages.length ? pages : TEMPLATE_AGENT_PAGES);
  console.log(`agent pages staged: ${written.join(', ')}`);
}
