import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { isPdfParseable } from './validate.ts';

// F-017 (system-test Cycle 14): a `pdf_url` (or `pdf_base64`) whose bytes fetch/
// decode successfully but are NOT a PDF must be caught cleanly, not crash pdf-lib
// deep in per-signer assembly.
describe('isPdfParseable (F-017)', () => {
  it('returns true for a real, parseable PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const bytes = await doc.save();
    assert.equal(await isPdfParseable(bytes), true);
  });

  it('returns false for a successful-but-non-PDF blob (e.g. a README) — the F-017 case', async () => {
    const readme = new TextEncoder().encode('# Hello\n\nThis is a markdown file, not a PDF.\n');
    assert.equal(await isPdfParseable(readme), false);
  });

  it('returns false for empty bytes', async () => {
    assert.equal(await isPdfParseable(new Uint8Array(0)), false);
  });
});
