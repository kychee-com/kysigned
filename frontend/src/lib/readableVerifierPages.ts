/**
 * The verifier pages an agent can read without JavaScript (F-47.3, F-47.4, DD-80).
 * The build (vite.config.ts) writes verify.html and hashcheck.html from the built
 * index.html with renderReadablePage: a page title, a description, and this copy
 * inside <div id="root">, which React replaces when the app mounts. run402 serves
 * /verify from verify.html, so a plain fetch reads real text while a browser still
 * gets the interactive tool. Pure strings: the build imports this under Node.
 */

export interface ReadablePage {
  /** The file the build writes next to index.html. */
  file: string;
  /** The URL it answers. */
  route: string;
  title: string;
  description: string;
  /** The copy placed inside <div id="root">. */
  html: string;
}

const BOX = 'max-width:48rem;margin:0 auto;padding:2rem 1rem;line-height:1.6';
const CODE = 'font-family:ui-monospace,monospace';

export const READABLE_VERIFIER_PAGES: ReadablePage[] = [
  {
    file: 'verify.html',
    route: '/verify',
    title: 'Verify a signed document | kysigned',
    description:
      'Verify a kysigned evidence bundle on your own machine, with math and public keys. The file is never uploaded, and kysigned is not in the trust set.',
    html: [
      `<main style="${BOX}">`,
      '<h1>Verify a signed document</h1>',
      '<p>This page checks a kysigned evidence bundle: the PDF every party receives when an envelope is complete. ',
      'The check runs entirely on your own machine, in your browser. The file is never uploaded, and kysigned is not part of what you are trusting.</p>',
      "<p>How it works: the bundle carries each signer's email, signed by their email provider with DKIM, plus timestamps. ",
      "The verifier checks each signature against the provider's public key, confirms each signer signed exactly this document, ",
      'checks the timestamps, and reports an assurance tier for every signer.</p>',
      '<h2>Verify without a browser</h2>',
      `<p>Run the same verifier from a terminal: <code style="${CODE}">npx kysigned verify &lt;bundle.pdf&gt;</code> `,
      `(add <code style="${CODE}">--json</code> for a machine-readable verdict). `,
      `From an MCP client, use the <code style="${CODE}">verify_bundle</code> tool of the local server `,
      `(<code style="${CODE}">npx -y kysigned-mcp</code>). Both run on your machine.</p>`,
      '<p>An AI assistant that cannot run programs cannot verify a bundle itself: it should say so and point you to this page, ',
      'or suggest a coding agent that can run the command above.</p>',
      '<p>This page runs the check with JavaScript in your browser.</p>',
      '</main>',
    ].join(''),
  },
  {
    file: 'hashcheck.html',
    route: '/hashcheck',
    title: 'Check your document | kysigned',
    description:
      'Check on your own machine that a document is exactly the one inside a kysigned signing record or sign request, by comparing SHA-256 fingerprints. Nothing is uploaded.',
    html: [
      `<main style="${BOX}">`,
      '<h1>Check your document</h1>',
      '<p>This page confirms that a document you have is exactly the one inside a kysigned signing record or sign request, ',
      'by comparing their SHA-256 fingerprints on your own machine. Neither file is uploaded.</p>',
      '<h2>Check without a browser</h2>',
      `<p>For a completed bundle, <code style="${CODE}">npx kysigned verify &lt;bundle.pdf&gt;</code> prints the SHA-256 of the `,
      `original document every signer signed (with <code style="${CODE}">--json</code>, the field `,
      `<code style="${CODE}">originalDocSha256</code>); compare it with the SHA-256 of your copy. `,
      `The <code style="${CODE}">verify_bundle</code> tool of the local MCP server (<code style="${CODE}">npx -y kysigned-mcp</code>) `,
      'returns the same value.</p>',
      '<p>An AI assistant that cannot run programs cannot run this check itself: it should say so and point you to this page, ',
      'or suggest a coding agent that can run the command above.</p>',
      '<p>This page runs the check with JavaScript in your browser.</p>',
      '</main>',
    ].join(''),
  },
];

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The built index.html, re-titled and described, with the page's copy inside the root. */
export function renderReadablePage(indexHtml: string, page: ReadablePage): string {
  const TITLE = '<title>kysigned</title>';
  const ROOT = '<div id="root"></div>';
  if (!indexHtml.includes(TITLE)) throw new Error(`readable page ${page.file}: index.html has no ${TITLE} to replace`);
  if (!indexHtml.includes(ROOT)) throw new Error(`readable page ${page.file}: index.html has no empty ${ROOT} to fill`);
  return indexHtml
    .replace(TITLE, `<title>${page.title}</title>\n    <meta name="description" content="${escapeAttr(page.description)}" />`)
    .replace(ROOT, `<div id="root">${page.html}</div>`);
}
