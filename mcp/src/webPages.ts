/**
 * webPages — markdown for agents on the negotiated content pages (F-46.8,
 * DD-75). run402 routes on path and method only, so each page URL is routed
 * to the agent function, which answers browsers with the page's HTML and
 * agents with its markdown twin. Both come from the copies staged with the
 * site under /_agent/pages/ (scripts/lib/agentPages.mjs), fetched from the
 * instance's own origin, so the bytes a browser gets are exactly the staged
 * page, and a --site-only deploy stays correct.
 */

/** Every page any instance may negotiate. The route table decides which ones reach this code. */
export const AGENT_PAGE_NAMES = ['how-it-works', 'how-it-works-technical', 'faq', 'pricing'] as const;
export type AgentPageName = (typeof AGENT_PAGE_NAMES)[number];

export type PageForm = 'extensionless' | 'html' | 'md';

export interface PageMatch {
  name: AgentPageName;
  form: PageForm;
}

export interface PageDeps {
  origin: string;
  fetchFn: typeof fetch;
}

export const AGENT_PAGES_PATH = '/_agent/pages/';

export function matchPagePath(path: string): PageMatch | null {
  const m = /^\/([a-z-]+?)(\.html|\.md)?$/.exec(path);
  if (!m) return null;
  const name = m[1] as AgentPageName;
  if (!(AGENT_PAGE_NAMES as readonly string[]).includes(name)) return null;
  const form: PageForm = m[2] === '.html' ? 'html' : m[2] === '.md' ? 'md' : 'extensionless';
  return { name, form };
}

/** The quality a media range assigns; undefined when the range is absent. */
function qualities(accept: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of accept.split(',')) {
    const [range, ...params] = part.trim().toLowerCase().split(';');
    if (!range) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split('=');
      if (k === 'q' && v !== undefined) {
        const n = Number(v);
        q = Number.isFinite(n) ? n : 0;
      }
    }
    out.set(range.trim(), Math.max(out.get(range.trim()) ?? -1, q));
  }
  return out;
}

/**
 * Markdown only when `text/markdown` is listed with a nonzero quality at least
 * as high as HTML's (text/html, else text/*, else *\/*). Browsers never list it.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const q = qualities(accept);
  const md = q.get('text/markdown');
  if (md === undefined || md <= 0) return false;
  const html = q.get('text/html') ?? q.get('text/*') ?? q.get('*/*') ?? 0;
  return md >= html;
}

const NEGOTIATED_HEADERS: Readonly<Record<string, string>> = {
  Vary: 'Accept',
  // Never let a shared cache hand one representation to a request for the other.
  'Cache-Control': 'private, max-age=0, must-revalidate',
};

/** Make the front matter's path-only url absolute to this instance (forks stage before they know their origin). */
function absoluteFrontMatter(md: string, origin: string): string {
  return md.replace(/^(---\n(?:[^\n]*\n)*?)url: (\/[^\n]*)\n/, (_m, head: string, path: string) => `${head}url: ${origin}${path}\n`);
}

export async function servePage(req: Request, match: PageMatch, deps: PageDeps): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed\n', { status: 405, headers: { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' } });
  }
  const markdown = match.form === 'md' || prefersMarkdown(req.headers.get('accept'));
  const upstream = await deps.fetchFn(`${deps.origin}${AGENT_PAGES_PATH}${match.name}.${markdown ? 'md' : 'html'}`);
  if (!upstream.ok) {
    return new Response('This page is temporarily unavailable. Please try again shortly.\n', {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const headers = new Headers(NEGOTIATED_HEADERS);
  let body: ArrayBuffer | string;
  if (markdown) {
    body = absoluteFrontMatter(await upstream.text(), deps.origin);
    headers.set('Content-Type', 'text/markdown; charset=utf-8');
    headers.set('x-markdown-tokens', String(Math.ceil(body.length / 4)));
  } else {
    body = await upstream.arrayBuffer();
    const type = upstream.headers.get('content-type') ?? '';
    headers.set('Content-Type', type.toLowerCase().startsWith('text/html') ? type : 'text/html; charset=utf-8');
  }
  return new Response(req.method === 'HEAD' ? null : body, { status: 200, headers });
}
