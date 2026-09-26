/**
 * verify_bundle (F-47.2, DD-78): the reference verifier from the published `kysigned`
 * package, as a tool of the local server. It reads a completed bundle from a path on
 * this machine or from base64 bytes (exactly one), verifies it here, and returns the
 * tiered verdict as structured content (the document `kysigned verify --json`
 * prints), with the human-first report and that document as text. A FAILED verdict
 * is a result; only bad input is a tool error (the CLI's exit 2).
 *
 * The bundle never leaves this machine and the operator is never contacted (F-47.5):
 * online, only the verifier's two additive indicators use the network. Needs no
 * creator key and no wallet.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyBundleBytes } from 'kysigned';
import { textResult, type McpToolResult } from './http.js';

export interface VerifyBundleArgs {
  path?: string;
  pdf_base64?: string;
  offline?: boolean;
}

export const VERIFY_BUNDLE_DESCRIPTION =
  'Verify a completed kysigned evidence bundle (the sealed PDF every party receives) on this machine, with the ' +
  'same verifier as `npx kysigned verify` and the web verifier at /verify. Give EXACTLY ONE of path (the file on ' +
  'this machine; an absolute path is safest) or pdf_base64 (the PDF bytes). Returns the assurance tier of the ' +
  'bundle and of each signer (FAILED, INTEGRITY_VERIFIED, PROVIDER_KEY_CONFIRMED or PROVEN_DURABLE), each ' +
  "signer's checks and reasons, and the SHA-256 of the original document (originalDocSha256), as structured " +
  'content (the kysigned.verdict.v1 document) plus a readable report. A FAILED verdict is a result, not a tool ' +
  'error. The bundle never leaves this machine and the kysigned operator is never contacted: online (the ' +
  'default), only two additive indicators use the network (timestamp-commitment hashes to the public ' +
  "OpenTimestamps calendars and a Bitcoin block source; the signer's public domain and selector to the key " +
  'archive). offline: true skips them and they report pending. Needs no API key and no wallet.';

const DATA_URL_PREFIX = /^data:[^,]*;base64,/i;
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** The bundle's bytes from exactly one of the two inputs, or the tool error to return. */
function readBundle(args: VerifyBundleArgs): Uint8Array | McpToolResult {
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  const b64 = typeof args.pdf_base64 === 'string' ? args.pdf_base64.replace(DATA_URL_PREFIX, '').replace(/\s+/g, '') : '';
  if ((path === '') === (b64 === '')) return textResult('Error: provide exactly one of path or pdf_base64.', true);
  if (path !== '') {
    const file = path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(1)) : resolve(path);
    try {
      return new Uint8Array(readFileSync(file));
    } catch (e) {
      return textResult(`Error: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  if (!BASE64.test(b64) || b64.length % 4 === 1) return textResult('Error: pdf_base64 is not valid base64.', true);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export async function verifyBundle(args: VerifyBundleArgs): Promise<McpToolResult> {
  const bytes = readBundle(args);
  if (!(bytes instanceof Uint8Array)) return bytes;
  try {
    const outcome = await verifyBundleBytes(bytes, { offline: args.offline === true });
    return {
      content: [
        { type: 'text', text: outcome.report },
        { type: 'text', text: JSON.stringify(outcome.json) },
      ],
      structuredContent: outcome.json,
    };
  } catch (e) {
    return textResult(`Error: could not verify the bundle: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
