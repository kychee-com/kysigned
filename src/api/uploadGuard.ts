/**
 * uploadGuard — the BACKEND upload-size guard for `POST /v1/envelope`
 * (F-3.5a / AC-7; system-test cycle-3 F-004).
 *
 * `POST /v1/envelope` is a routed-HTTP function invoked SYNCHRONOUSLY on Lambda,
 * whose event payload is hard-capped at 6 MiB. The run402 gateway base64-wraps the
 * whole HTTP body into that event (×4/3) and a `pdf_base64` upload is itself base64
 * in the JSON body (×4/3), so a raw PDF inflates ~16/9 → true ceiling ≈ 3.5 MB.
 *
 * A 3–6 MiB `pdf_base64` is UNDER the gateway's 6 MiB hard limit, so it REACHES the
 * function — and without this guard the function crashes (502 / "No PDF header
 * found" while parsing) instead of returning a clean, sized 400. The frontend
 * (`frontend/src/lib/pdfSize.ts`) has the same cap, but API/agent clients bypass it,
 * so the cap MUST also live here, server-side. Mirrors the frontend constant + copy
 * (the backend can't import from `frontend/`).
 *
 * The guard applies to the DECODED `pdf_base64` bytes ONLY. The `pdf_url` path is
 * the documented escape for large documents (the function fetches the bytes
 * server-side, bypassing the synchronous-invoke payload limit — F-3.5a), so it is
 * NOT capped here; oversize `pdf_url` documents are bounded by the 15 MB bundle
 * ceiling (`sizeGuard.ts`) instead.
 */

/** 3 MB — safe under the 6 MiB Lambda synchronous-invoke cap (margin for the JSON
 *  envelope: ≤20 signers + message + the request's own cookies/headers). Mirrors
 *  `frontend/src/lib/pdfSize.ts MAX_PDF_BYTES`. */
export const MAX_PDF_BYTES = 3_000_000;

/** True when a decoded upload exceeds the cap. */
export function isUploadTooLarge(bytes: number): boolean {
  return bytes > MAX_PDF_BYTES;
}

/** The sized, user-facing rejection message (matches the frontend copy). */
export function uploadTooLargeMessage(bytes: number): string {
  return `That PDF is too large (${(bytes / 1_000_000).toFixed(1)} MB). The maximum is 3 MB — please compress it or split the document, then try again.`;
}
