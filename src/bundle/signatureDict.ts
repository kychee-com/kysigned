/**
 * No-signature-dictionary guard (F-8.2 / AC-63).
 *
 * The bundle PDF must carry NO digital-signature dictionary, so mainstream viewers
 * (Acrobat/Reader, Preview, Chrome) open it clean — no "certified" banner and,
 * crucially, no "validity unknown" red-X. Trust comes from the embedded evidence,
 * never a PDF signature. The assembler asserts this before returning; the verifier
 * test asserts it on the output (AC-63).
 *
 * Detection scans for the canonical signature markers a viewer keys off: the
 * `/ByteRange` placeholder present on every signed PDF, a `/Type /Sig` signature
 * dictionary, the `/SigFlags` AcroForm flag, or the PKCS#7/CAdES `/SubFilter`.
 * (Embedded FILE attachments — our five evidence classes — use `/EmbeddedFiles`
 * and `/Type /Filespec`, which are NOT signatures and do not trip any of these.)
 */
export function hasSignatureDictionary(pdfBytes: Uint8Array): boolean {
  // latin1 keeps every byte 1:1 so the PDF operators match literally.
  const s = Buffer.from(pdfBytes).toString('latin1');
  return (
    /\/ByteRange\b/.test(s) ||
    /\/Type\s*\/Sig\b/.test(s) ||
    /\/SigFlags\b/.test(s) ||
    /\/SubFilter\s*\/(adbe\.pkcs7|ETSI\.CAdES)/.test(s)
  );
}
