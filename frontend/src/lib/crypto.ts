/**
 * Client-side crypto utilities — SHA-256 only.
 *
 * Phase 3R: Ed25519 keypair generation removed (signing happens via email
 * reply, not client-side crypto). Only SHA-256 remains for PDF hash
 * verification on the verify page.
 */

/** SHA-256 hash via Web Crypto API. Returns hex string. */
export async function sha256(data: Uint8Array | ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data as ArrayBuffer)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
