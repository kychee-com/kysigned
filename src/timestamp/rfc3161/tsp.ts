/**
 * RFC 3161 Time-Stamp Protocol primitives — F-8 / AC-15, AC-16.
 *
 * Built on the generic `pkijs` (ASN.1/PKI) library — not a turnkey RFC 3161
 * package. We own the request building, response/token parsing, and the
 * verify logic (signature + messageImprint + genTime).
 */
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

// pkijs needs a WebCrypto engine for signature verification. Node 22 and browsers
// both expose one at globalThis.crypto (with .subtle), so this stays isomorphic —
// no node:crypto import.
const webcrypto = (globalThis as { crypto?: Crypto }).crypto;
if (webcrypto?.subtle) {
  try {
    pkijs.setEngine('tsmodule-engine', new pkijs.CryptoEngine({ name: 'tsmodule-engine', crypto: webcrypto }));
  } catch {
    /* engine already initialised */
  }
}

export const SHA256_OID = '2.16.840.1.101.3.4.2.1';

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** Build a DER-encoded TimeStampReq for a 32-byte sha256 hash (requests the TSA cert). */
export function buildTimeStampReq(hash: Uint8Array): Uint8Array {
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: SHA256_OID }),
      hashedMessage: new asn1js.OctetString({ valueHex: toArrayBuffer(hash) }),
    }),
    certReq: true,
  });
  return new Uint8Array(req.toSchema().toBER(false));
}

/** Parse a TimeStampReq back to its message imprint (for tests/inspection). */
export function parseTimeStampReq(der: Uint8Array): { hashAlgoOid: string; hashedMessage: Uint8Array } {
  const asn1 = asn1js.fromBER(toArrayBuffer(der));
  const req = new pkijs.TimeStampReq({ schema: asn1.result });
  return {
    hashAlgoOid: req.messageImprint.hashAlgorithm.algorithmId,
    hashedMessage: new Uint8Array(req.messageImprint.hashedMessage.valueBlock.valueHexView),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Extract the DER `timeStampToken` (a CMS ContentInfo) from a TimeStampResp; throws unless granted. */
export function extractToken(respDer: Uint8Array): Uint8Array {
  const resp = new pkijs.TimeStampResp({ schema: asn1js.fromBER(toArrayBuffer(respDer)).result });
  const status = resp.status.status;
  if (status !== 0 && status !== 1) throw new Error(`TSA did not grant the timestamp (PKIStatus ${status})`);
  if (!resp.timeStampToken) throw new Error('TSA response contained no token');
  return new Uint8Array(resp.timeStampToken.toSchema().toBER(false));
}

export interface TokenInfo {
  hashAlgoOid: string;
  messageImprint: Uint8Array;
  genTimeSec: number;
  tsaName: string;
}

function signerCommonName(signedData: pkijs.SignedData): string {
  const cert = signedData.certificates?.find((c) => c instanceof pkijs.Certificate) as
    | pkijs.Certificate
    | undefined;
  if (cert) {
    const cn = cert.subject.typesAndValues.find((t) => t.type === '2.5.4.3');
    if (cn) return String(cn.value.valueBlock.value);
  }
  return 'rfc3161-tsa';
}

/** Parse a timeStampToken (CMS SignedData wrapping a TSTInfo). */
export function parseToken(tokenDer: Uint8Array): TokenInfo {
  const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(toArrayBuffer(tokenDer)).result });
  const signedData = new pkijs.SignedData({ schema: ci.content });
  const eContent = signedData.encapContentInfo.eContent;
  if (!eContent) throw new Error('token has no eContent (TSTInfo)');
  const tstBytes = new Uint8Array(eContent.valueBlock.valueHexView);
  const tstInfo = new pkijs.TSTInfo({ schema: asn1js.fromBER(toArrayBuffer(tstBytes)).result });
  return {
    hashAlgoOid: tstInfo.messageImprint.hashAlgorithm.algorithmId,
    messageImprint: new Uint8Array(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView),
    genTimeSec: Math.floor(tstInfo.genTime.getTime() / 1000),
    tsaName: signerCommonName(signedData),
  };
}

export interface TokenVerifyResult {
  ok: boolean;
  genTimeSec: number;
  tsaName: string;
}

const SHA_BY_OID: Record<string, string> = {
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
  '1.3.14.3.2.26': 'SHA-1',
};
const SIG_HASH_BY_OID: Record<string, string> = {
  '1.2.840.10045.4.3.2': 'SHA-256', // ecdsa-with-SHA256
  '1.2.840.10045.4.3.3': 'SHA-384',
  '1.2.840.10045.4.3.4': 'SHA-512',
  '1.2.840.113549.1.1.11': 'SHA-256', // sha256WithRSAEncryption
  '1.2.840.113549.1.1.12': 'SHA-384',
  '1.2.840.113549.1.1.13': 'SHA-512',
  '1.2.840.113549.1.1.5': 'SHA-1',
};
const CURVE_BY_OID: Record<string, string> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};
const CURVE_SIZE: Record<string, number> = { 'P-256': 32, 'P-384': 48, 'P-521': 66 };
const EC_KEY_OID = '1.2.840.10045.2.1';
const RSA_KEY_OID = '1.2.840.113549.1.1.1';
const MESSAGE_DIGEST_OID = '1.2.840.113549.1.9.4';

/** Convert a DER ECDSA signature (SEQUENCE{r,s}) to WebCrypto raw `r‖s` (fixed width). */
function derEcdsaToRaw(der: Uint8Array, size: number): Uint8Array {
  const seq = asn1js.fromBER(toArrayBuffer(der)).result as asn1js.Sequence;
  const part = (i: number) => new Uint8Array((seq.valueBlock.value[i] as asn1js.Integer).valueBlock.valueHexView);
  const fix = (x: Uint8Array) => {
    let v = x;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    const o = new Uint8Array(size);
    o.set(v, size - v.length);
    return o;
  };
  return Uint8Array.from([...fix(part(0)), ...fix(part(1))]);
}

/**
 * Verify the token's CMS signature and that its imprint matches `hash`.
 *
 * We parse with pkijs but run the actual signature check on WebCrypto directly
 * (DD-2): (1) imprint == hash, (2) the message-digest attribute equals the digest
 * of the TSTInfo, (3) the signer's signature over the signed attributes verifies.
 */
export async function verifyToken(tokenDer: Uint8Array, hash: Uint8Array): Promise<TokenVerifyResult> {
  const fail: TokenVerifyResult = { ok: false, genTimeSec: 0, tsaName: '' };
  const wc = (globalThis as { crypto?: Crypto }).crypto;
  if (!wc?.subtle) return fail;

  let sd: pkijs.SignedData;
  let si: pkijs.SignerInfo;
  let info: TokenInfo;
  try {
    const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(toArrayBuffer(tokenDer)).result });
    sd = new pkijs.SignedData({ schema: ci.content });
    si = sd.signerInfos[0];
    info = parseToken(tokenDer);
  } catch {
    return fail;
  }
  if (info.hashAlgoOid !== SHA256_OID || !bytesEqual(info.messageImprint, hash)) return fail;

  const eContent = sd.encapContentInfo.eContent;
  const cert = (sd.certificates ?? []).find((c) => c instanceof pkijs.Certificate) as pkijs.Certificate | undefined;
  if (!eContent || !si.signedAttrs || !cert) return fail;

  try {
    // (2) message-digest attribute == digest(TSTInfo)
    const mdHash = SHA_BY_OID[si.digestAlgorithm.algorithmId];
    const mdAttr = si.signedAttrs.attributes.find((a) => a.type === MESSAGE_DIGEST_OID);
    if (!mdHash || !mdAttr) return fail;
    const eBytes = new Uint8Array(eContent.valueBlock.valueHexView);
    const computed = new Uint8Array(await wc.subtle.digest(mdHash, toArrayBuffer(eBytes)));
    const declared = new Uint8Array((mdAttr.values[0] as asn1js.OctetString).valueBlock.valueHexView);
    if (!bytesEqual(declared, computed)) return fail;

    // (3) signature over the signed attributes (re-tagged as SET OF)
    const sigHash = SIG_HASH_BY_OID[si.signatureAlgorithm.algorithmId];
    if (!sigHash) return fail;
    const attrsBer = new Uint8Array(si.signedAttrs.toSchema().toBER());
    attrsBer[0] = 0x31; // [0] IMPLICIT -> SET OF
    const spki = new Uint8Array(cert.subjectPublicKeyInfo.toSchema().toBER());
    const sig = new Uint8Array(si.signature.valueBlock.valueHexView);
    const keyOid = cert.subjectPublicKeyInfo.algorithm.algorithmId;

    let verified = false;
    if (keyOid === EC_KEY_OID) {
      const curveOid = (cert.subjectPublicKeyInfo.algorithm.algorithmParams as asn1js.ObjectIdentifier).valueBlock.toString();
      const curve = CURVE_BY_OID[curveOid];
      if (!curve) return fail;
      const key = await wc.subtle.importKey('spki', toArrayBuffer(spki), { name: 'ECDSA', namedCurve: curve }, false, ['verify']);
      verified = await wc.subtle.verify({ name: 'ECDSA', hash: sigHash }, key, toArrayBuffer(derEcdsaToRaw(sig, CURVE_SIZE[curve])), toArrayBuffer(attrsBer));
    } else if (keyOid === RSA_KEY_OID) {
      const key = await wc.subtle.importKey('spki', toArrayBuffer(spki), { name: 'RSASSA-PKCS1-v1_5', hash: sigHash }, false, ['verify']);
      verified = await wc.subtle.verify('RSASSA-PKCS1-v1_5', key, toArrayBuffer(sig), toArrayBuffer(attrsBer));
    }
    if (!verified) return fail;
  } catch {
    return fail;
  }
  return { ok: true, genTimeSec: info.genTimeSec, tsaName: info.tsaName };
}
