/**
 * pdfSize — the upload-size guard for the create form (2026-06-21).
 *
 * The create request is invoked SYNCHRONOUSLY on Lambda, which caps the *event
 * payload* at 6 MiB. The run402 gateway base64-wraps the entire HTTP body into
 * that event (×4/3), and the PDF is itself base64-encoded inside the JSON body
 * (×4/3) — so a raw PDF inflates by ~16/9 before it hits the 6 MiB wall. That
 * puts the true ceiling near 3.5 MB; over it, the gateway can't invoke the
 * function and Cloudflare returns an opaque 502 (NOT a clean error).
 *
 * We cap at 3 MB to leave margin for the JSON envelope (≤20 signers, message)
 * plus the request's own cookies/headers, and reject oversize files up front
 * with a clear, sized message instead of the 502.
 *
 * (Separate from the backend bundle-size guard, which caps the ASSEMBLED evidence
 * bundle at 15 MiB — that one grows with signer count; this one is the upload wall.
 * The real fix for large documents is `pdf_url` upload — see the operator's private issue tracker.)
 */
export const MAX_PDF_BYTES = 3_000_000; // 3 MB — safe under the 6 MiB Lambda invoke cap

export function isPdfTooLarge(bytes: number): boolean {
  return bytes > MAX_PDF_BYTES;
}

export function pdfTooLargeMessage(bytes: number): string {
  return `That PDF is too large (${(bytes / 1_000_000).toFixed(1)} MB). The maximum is 3 MB — please compress it or split the document, then try again.`;
}
