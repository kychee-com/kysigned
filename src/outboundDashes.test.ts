/**
 * FC32.10: no em or en dash on any reader-visible surface of this repository.
 *
 * The Kychee outbound-writing rule: an em dash is one of the clearest tells of machine-written
 * text, so no em dash (U+2014) or en dash (U+2013), nor their HTML entities, may reach anything a
 * reader outside the team sees. The fix is always to rewrite the sentence (a comma, a colon,
 * parentheses or two sentences), never to swap the character for another dash-like mark.
 *
 * Reader-visible here means:
 *   - the documents the site serves: frontend/index.html and frontend/public (every page, llms.txt,
 *     openapi.json, the SVGs);
 *   - the strings of every shipped program: the scripts served from frontend/public, the SPA
 *     (frontend/src), the backend (src: API messages, every email, the PDF cover and signature
 *     pages, the verifier CLI), the MCP server (mcp/src) and the independent verification kit;
 *   - the outbound markdown: the npm README, the trust model, the forker and verifier guides and
 *     the legal README.
 * Code comments and internal engineering notes are exempt, so in code only string literals,
 * template text and JSX text count; in HTML, comments do not count and a <script> block counts
 * only through its string literals; in CSS, comments do not count. Tests and fixtures are exempt.
 *
 * A failure lists every offending file and line. The private repository carries the same guard
 * for kysigned.com's own pages (kysigned-private src/outboundDashes.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DASH_SOURCE = String.raw`[–—]|&(?:mdash|ndash);|&#(?:8211|8212|x201[34]);`;
const DASH = new RegExp(DASH_SOURCE, 'i');

/** The markdown a reader outside the team reads (engineering notes such as src/timestamp/README.md are exempt). */
const OUTBOUND_MARKDOWN = [
  'README.md',
  'mcp/README.md',
  'legal.README.md',
  'docs/trust-model.md',
  'docs/adding-an-info-site.md',
  'docs/run402-cloud.md',
  'scripts/verification-tools/README.md',
];
/** Every reader-visible root, relative to the repository root. */
const ROOTS = ['frontend/index.html', 'frontend/public', 'frontend/src', 'src', 'mcp/src', 'scripts/verification-tools', ...OUTBOUND_MARKDOWN];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'fixtures', '__fixtures__', 'test', 'tests', '__tests__']);

type Kind = 'code' | 'html' | 'css' | 'markdown' | 'text';

/** How a file is read, or null when it is not a reader-visible surface. */
function kindOf(rel: string): Kind | null {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /\.d\.ts$/.test(rel)) return null;
  if (/\.md$/i.test(rel)) return OUTBOUND_MARKDOWN.includes(rel) ? 'markdown' : null;
  if (rel === 'frontend/index.html') return 'html';
  if (rel.startsWith('frontend/public/')) {
    if (/\.(html?|svg|xml)$/i.test(rel)) return 'html';
    if (/\.(txt|json|webmanifest)$/i.test(rel)) return 'text';
    if (/\.[cm]?js$/i.test(rel)) return 'code';
    if (/\.css$/i.test(rel)) return 'css';
    return null;
  }
  if (rel.startsWith('frontend/src/')) {
    if (/\.tsx?$/.test(rel)) return 'code';
    if (/\.css$/.test(rel)) return 'css';
    return null;
  }
  if ((rel.startsWith('src/') || rel.startsWith('mcp/src/')) && /\.[cm]?ts$/.test(rel)) return 'code';
  if (rel.startsWith('scripts/verification-tools/') && /\.[cm]?js$/.test(rel)) return 'code';
  return null;
}

/** Blank everything the reader cannot see, keeping newlines so line numbers survive. */
const blank = (s: string) => s.replace(/[^\n]/g, ' ');
const withoutHtmlComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, blank);

/** Code: only string literals, template text and JSX text are visible (comments and code are not). */
function visibleCode(text: string, fileName: string): { visible: string; escapedAt: number[] } {
  const kind = /\.tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(fileName)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const out = blank(text).split('');
  const escapedAt: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const start = node.getStart(sf);
      const end = node.getEnd();
      for (let i = start; i < end; i += 1) out[i] = text[i]!;
      // A dash written as an escape (—) is invisible in the source but not on the page.
      const cooked = (node as ts.LiteralLikeNode).text;
      if (DASH.test(cooked) && !DASH.test(text.slice(start, end))) escapedAt.push(start);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // A literal that carries an HTML comment emits a comment, which the reader does not see.
  return { visible: withoutHtmlComments(out.join('')), escapedAt };
}

/** HTML (and SVG/XML): comments do not count; a script counts through its strings; CSS comments do not count. */
function visibleHtml(text: string): string {
  let t = withoutHtmlComments(text);
  t = t.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, body: string, close: string) =>
    open + body.replace(/\/\*[\s\S]*?\*\//g, blank) + close,
  );
  t = t.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open: string, body: string, close: string) =>
    /type\s*=\s*["']?application\/(?:ld\+)?json/i.test(open) ? m : open + visibleCode(body, 'inline.js').visible + close,
  );
  return t;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function scanFile(rel: string, kind: Kind): string[] {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  let visible: string;
  let escapedAt: number[] = [];
  if (kind === 'code') ({ visible, escapedAt } = visibleCode(text, rel));
  else if (kind === 'html') visible = visibleHtml(text);
  else if (kind === 'css') visible = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  else if (kind === 'markdown') visible = withoutHtmlComments(text);
  else visible = text;
  const hits: string[] = [];
  const lines = text.split('\n');
  const all = new RegExp(DASH_SOURCE, 'gi');
  for (let m = all.exec(visible); m; m = all.exec(visible)) {
    const line = lineOf(visible, m.index);
    hits.push(`${rel}:${line}: ${lines[line - 1]!.trim().slice(0, 140)}`);
  }
  for (const at of escapedAt) {
    const line = lineOf(text, at);
    hits.push(`${rel}:${line}: (an escaped dash) ${lines[line - 1]!.trim().slice(0, 120)}`);
  }
  return hits;
}

function walk(rel: string, out: string[]): void {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return;
  if (statSync(abs).isDirectory()) {
    for (const entry of readdirSync(abs)) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(rel ? `${rel}/${entry}` : entry, out);
    }
    return;
  }
  out.push(rel);
}

function reachableSurfaces(): Array<{ rel: string; kind: Kind }> {
  const files: string[] = [];
  for (const r of ROOTS) walk(r, files);
  return [...new Set(files)]
    .map((rel) => ({ rel, kind: kindOf(rel) }))
    .filter((f): f is { rel: string; kind: Kind } => f.kind !== null);
}

test('the guard reaches every surface kind it claims to cover (FC32.10)', () => {
  const kinds = new Set(reachableSurfaces().map((f) => f.kind));
  for (const k of ['code', 'html', 'text', 'markdown'] as const) assert.ok(kinds.has(k), `no ${k} surface was scanned`);
  const rels = reachableSurfaces().map((f) => f.rel);
  for (const must of [
    'frontend/index.html',
    'frontend/public/llms.txt',
    'frontend/public/openapi.json',
    'frontend/public/faq.html',
    'src/email/templates.ts',
    'src/pdf/coverPage.ts',
    'frontend/src/pages/EnvelopeDetailPage.tsx',
    'mcp/src/server.ts',
    'mcp/README.md',
    'scripts/verification-tools/README.md',
  ]) {
    assert.ok(rels.includes(must), `${must} is not scanned`);
  }
});

test('the guard sees a dash in visible text and ignores one in a comment (FC32.10)', () => {
  const em = String.fromCodePoint(0x2014);
  const code = `// a comment ${em} exempt\nconst shown = 'Save ${em} and close';\nconst ok = 'no dash here';\n`;
  const { visible } = visibleCode(code, 'x.ts');
  assert.equal(lineOf(visible, visible.search(DASH)), 2);
  assert.equal((visible.match(new RegExp(DASH_SOURCE, 'gi')) ?? []).length, 1);
  const html = `<!-- note ${em} exempt -->\n<title>FAQ &mdash; site</title>\n<script>// c ${em}\nvar s = "x";</script>`;
  const v = visibleHtml(html);
  assert.equal((v.match(new RegExp(DASH_SOURCE, 'gi')) ?? []).length, 1);
  assert.equal(lineOf(v, v.search(DASH)), 2);
  assert.equal(visibleCode(`const s = '\\u2014';`, 'x.ts').escapedAt.length, 1);
});

test('no em or en dash on any reader-visible surface: rewrite the sentence, never swap the character (FC32.10)', () => {
  const hits = reachableSurfaces().flatMap(({ rel, kind }) => scanFile(rel, kind));
  assert.deepEqual(hits, [], `${hits.length} em/en dash(es) on reader-visible surfaces:\n${hits.join('\n')}`);
});
