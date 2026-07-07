import { createHash } from 'node:crypto';

export function computePdfHash(pdfBytes: Uint8Array): string {
  return createHash('sha256').update(pdfBytes).digest('hex');
}

export async function fetchPdfFromUrl(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.status}`);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

export function decodePdfBase64(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}
