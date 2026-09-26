/**
 * webFacts — the web front door's one source of auth, payment and verification
 * facts (F-46.11, F-47.4). The explanation tool, the skills and /auth.md all draw
 * on it, and webFacts.test.ts checks every fact against its source (the API, the
 * kysigned package, the local server, the SPA routes), so a renamed prefix,
 * route, error code, command or tool fails a test instead of leaving an agent
 * instruction that no longer holds (the F-30.4 rule).
 *
 * Outbound copy: no em or en dashes (the outbound-dash guard scans these
 * string literals).
 */
import { X402_CREATE_PATH } from './x402Challenge.js';

export const WEB_FACTS = {
  apiKeyPrefix: 'ksk_',
  trackingTokenPrefix: 'ktt_',
  x402CreatePath: X402_CREATE_PATH,
  preflightPath: '/v1/envelope/preflight',
  envelopeStatusPattern: '/v1/envelope/:id',
  apiKeysPath: '/account/api-keys',
  localPackage: 'kysigned-mcp',
  mcpPath: '/mcp',
  publicRepo: 'https://github.com/kychee-com/kysigned',
  // F-47 verification: the command, the local tool and the page for people (DD-81).
  verifyPackage: 'kysigned',
  verifyCommand: 'npx kysigned verify',
  verifyTool: 'verify_bundle',
  verifyPath: '/verify',
  errorCodes: {
    invalidKey: 'auth_invalid_key',
    keyScope: 'auth_key_scope',
    trackingScope: 'auth_tracking_scope',
  },
} as const;

/**
 * What an agent that cannot run a program does instead of verifying (F-47.4): say so,
 * then point the person to the web verifier or suggest a coding agent. Never a hosted
 * check (F-46.3). An empty `origin` gives the instance-relative page (the template
 * llms.txt).
 */
export function cannotRunProgramsLine(origin: string): string {
  const f = WEB_FACTS;
  return (
    "If you are an AI assistant that cannot run programs on your user's machine (a chat assistant with no code " +
    'execution), you cannot verify a bundle yourself. Say so plainly, then either point the person to ' +
    `${origin}${f.verifyPath} (the check runs in their own browser and the file is never uploaded) or suggest doing ` +
    `the check with a coding agent that can run ${f.verifyCommand} or the local ${f.verifyTool} tool.`
  );
}

/** The explain_kysigned text (F-46.1): what kysigned is and every way to use it, for this instance. */
export function explainKysigned(origin: string): string {
  const f = WEB_FACTS;
  return [
    'kysigned: self-verifying e-signatures. The signature is an email.',
    '',
    'How signing works',
    '1. The sender provides a PDF and the signers (a name and an email address each).',
    '2. Each signer receives an email with the document attached. To sign, they forward that email back to the signing address with "I sign this document" as the first line. Their own email provider signs that forward (DKIM), which proves who signed, the exact document, and the intent.',
    '3. When everyone has signed, every party receives the evidence bundle: one PDF holding the document, a signature page, the signed emails and two independent timestamps. Anyone can check it with public math and public keys, even if this service no longer exists.',
    'Signers never need an account. Agents never sign: every signer is a person.',
    '',
    'Price',
    'Call check_price for this instance\'s live per-envelope price, read from its payment route.',
    '',
    'Ways to create an envelope',
    `- Here, with no account and no key: call create_envelope_x402. It first checks your request for free, then answers "payment required" with the exact terms. An MCP client that supports x402 signs the payment with your own wallet and calls again. This service never holds your keys or your funds.`,
    `- With the local MCP server on your own machine (npx -y ${f.localPackage}): its create_envelope_x402 pays from a local run402 wallet, and its create_envelope uses a creator API key.`,
    `- Over HTTP with any x402 client: POST ${origin}${f.x402CreatePath}.`,
    `- With a creator API key (${f.apiKeyPrefix}...): a person mints one at ${origin}${f.apiKeysPath} and it is sent as "Authorization: Bearer ${f.apiKeyPrefix}..."; each create uses one of that account's credits.`,
    '',
    'Tracking',
    `Every create returns a tracking token (${f.trackingTokenPrefix}...). Pass it to check_envelope_status here, with no account. It reads that one envelope and nothing else.`,
    '',
    'Verifying a bundle',
    'Verification runs on your own machine: never upload a bundle to anyone, including this service.',
    `- Run ${f.verifyCommand} <bundle.pdf> (Node 22 or later, nothing to clone): exit 0 means verified at the tier it prints, 1 means FAILED with the reasons; add --json for one machine-readable document (each signer's tier and checks, and originalDocSha256, the SHA-256 of the signed document).`,
    `- Or call ${f.verifyTool} on the local MCP server (npx -y ${f.localPackage}) with the file's path or its base64: the same verdict, with no key and no wallet. This endpoint has no verify tool.`,
    `- A person can open ${origin}${f.verifyPath} in a browser: the check runs inside the page and the file never leaves their device.`,
    cannotRunProgramsLine(origin),
    '',
    'More',
    `- Every way to authenticate: ${origin}/auth.md`,
    `- The API: ${origin}/openapi.json and ${origin}/llms.txt`,
    `- This instance's API catalog: ${origin}/.well-known/api-catalog`,
  ].join('\n');
}
