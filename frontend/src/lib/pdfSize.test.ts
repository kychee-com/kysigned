import { describe, it, expect } from 'vitest';
import { MAX_PDF_BYTES, isPdfTooLarge, pdfTooLargeMessage } from './pdfSize';

// 2026-06-21: the create request is invoked synchronously on Lambda, which caps the
// *event payload* at 6 MiB. The run402 gateway base64-wraps the whole HTTP body into
// that event (×4/3), and the PDF is itself base64 inside the body (×4/3) — so a PDF
// inflates by ~16/9 before it hits the limit. The old 4.4 MB cap mis-modelled this as
// a 6 MiB cap on the HTTP body and produced an opaque Cloudflare 502. We reject up
// front so the user gets a clear, sized message instead.
const LAMBDA_INVOKE_LIMIT = 6 * 1024 * 1024; // AWS synchronous-invoke request payload cap

describe('pdf upload size guard', () => {
  it('accepts a PDF at or under the cap', () => {
    expect(isPdfTooLarge(MAX_PDF_BYTES)).toBe(false);
    expect(isPdfTooLarge(2_900_000)).toBe(false);
  });

  it('rejects a PDF over the cap', () => {
    expect(isPdfTooLarge(MAX_PDF_BYTES + 1)).toBe(true);
    // 3.5 MB still reaches the gateway but a 4.4 MB upload 502s — both must be rejected.
    expect(isPdfTooLarge(3_500_000)).toBe(true);
    expect(isPdfTooLarge(4_400_000)).toBe(true);
  });

  it('the worst-case Lambda event stays under the 6 MiB invoke limit', () => {
    // Stage 1: PDF -> base64 inside the JSON body (+ wrapper headroom for signers/message).
    const httpBody = Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4000;
    // Stage 2: the gateway base64-wraps the whole HTTP body into the Lambda event.
    const lambdaEvent = Math.ceil(httpBody / 3) * 4;
    expect(lambdaEvent).toBeLessThan(LAMBDA_INVOKE_LIMIT);
    // ...with comfortable margin for cookies/headers/requestContext on a real request.
    expect(lambdaEvent).toBeLessThan(LAMBDA_INVOKE_LIMIT - 250_000);
  });

  it('the message names the actual size and the 3 MB limit', () => {
    const m = pdfTooLargeMessage(4_400_000);
    expect(m).toMatch(/4\.4 MB/);
    expect(m).toMatch(/3 MB/);
  });
});
