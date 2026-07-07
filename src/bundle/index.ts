// Evidence-bundle assembly (Phase 9 — F-8). One self-contained PDF per envelope:
// signature page(s) → cover+document, with the five embedded-file classes and a
// fingerprint over the embedded evidence. No signature dictionary (clean open).
export { assembleBundle } from './assembleBundle.js';
export { buildEvidenceManifest } from './evidenceManifest.js';
export { computeBundleFingerprint } from './fingerprint.js';
export { buildKeysJson, keysJsonBytes } from './keysJson.js';
export type { KeysJson, KeysJsonKeyRecord } from './keysJson.js';
export { buildVerifyReadme } from './verifyReadme.js';
export { hasSignatureDictionary } from './signatureDict.js';
// Verifier (Phase 11 — F-10): extract embedded evidence, run the F-10.3 algorithm
// (DKIM vs keys.json + attachment + intent + timestamp + key-join + fingerprint).
export { extractEmbeddedFiles, extractEmbeddedFileMap } from './extract.js';
export type { ExtractedFile } from './extract.js';
export { verifyBundle } from './verify.js';
export type {
  BundleVerdict,
  SignerVerdict,
  VerifyBundleDeps,
  KeyAuthStatus,
} from './verify.js';
export { formatVerdict, exitCodeFor, runVerifyCli } from './verifyCli.js';
// Browser verifier (Phase 11.2 — F-10.1, AC-27): the SAME algorithm, fully
// client-side via WebCrypto + DecompressionStream, differential-tested to return
// the identical verdict to the Node/mailauth path.
export { verifyBundleWeb } from './verifyWeb.js';
export { verifyDkimWeb } from './dkimVerifyWeb.js';
export type { DkimWebResult, WebKeyLookup } from './dkimVerifyWeb.js';
export { extractEmbeddedFilesWeb, extractEmbeddedFileMapWeb } from './extractWeb.js';
export { renderSignaturePages } from './signaturePage.js';
export type { SignaturePageInput, SignaturePageSigner } from './signaturePage.js';
export type {
  AssembleBundleInput,
  AssembledBundle,
  BundleEnvelopeInput,
  BundleSignerInput,
  EmbeddedFile,
} from './types.js';
