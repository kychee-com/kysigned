/**
 * Evidence manifest + fingerprint + keys.json tests — F-8.1/8.2/8.4.
 *
 * Pure + offline. Locks the deterministic five-class order, the fingerprint's
 * evidence set (everything except VERIFY-README.txt), proof omission when a proof
 * is absent, and the keys.json shape the offline verifier reads.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { buildEvidenceManifest } from './evidenceManifest.js';
import { computeBundleFingerprint } from './fingerprint.js';
import { buildKeysJson } from './keysJson.js';
import type { AssembleBundleInput, BundleSignerInput } from './types.js';
import type { TimestampProof } from '../timestamp/contract.js';

function proof(provider: string, raw: string, status: 'pending' | 'complete' = 'complete'): TimestampProof {
  return { provider, version: 1, status, data: Buffer.from(raw).toString('base64') };
}

function signer(over: Partial<BundleSignerInput> = {}): BundleSignerInput {
  return {
    index: over.index ?? 1,
    name: over.name ?? 'Alice',
    email: over.email ?? 'alice@example.com',
    onBehalfOf: over.onBehalfOf ?? null,
    signingDomain: over.signingDomain ?? 'example.com',
    selector: over.selector ?? 'sel',
    signedAt: over.signedAt ?? new Date('2026-06-14T10:00:00Z'),
    emlSha256: over.emlSha256 ?? 'a'.repeat(64),
    rawEml: over.rawEml ?? new Uint8Array(Buffer.from('From: alice@example.com\r\n\r\nI sign this document\r\n')),
    cover: over.cover ?? new Uint8Array(Buffer.from(`%PDF-cover-${over.index ?? 1}\n`)),
    dkimKey: over.dkimKey === undefined ? 'v=DKIM1; k=rsa; p=AAAB' : over.dkimKey,
    dkimObservedAt: over.dkimObservedAt ?? new Date('2026-06-14T10:00:01Z'),
    archiveStatus: over.archiveStatus ?? 'archived',
    otsProof: over.otsProof === undefined ? proof('ots', 'ots-bytes', 'pending') : over.otsProof,
    tsaToken: over.tsaToken === undefined ? proof('rfc3161', 'tsr-bytes') : over.tsaToken,
    verdicts: over.verdicts ?? { spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
  };
}

function input(signers: BundleSignerInput[]): AssembleBundleInput {
  return {
    envelope: {
      id: '18267982-ca76-45dc-a294-e86039a6343d',
      documentName: 'NDA',
      documentHash: 'd'.repeat(64),
      creatorEmail: 'creator@acme.com',
      completedAt: new Date('2026-06-14T12:00:00Z'),
    },
    documentOriginal: new Uint8Array(Buffer.from('%PDF-1.7\ndoc bytes\n%%EOF\n')),
    signers,
    verifierBaseUrl: 'https://kysigned.com',
  };
}

describe('buildEvidenceManifest — the six classes in F-8.4 order (Family B)', () => {
  it('orders document → covers → emls → proofs (tsr,ots per signer) → keys.json → README', () => {
    const m = buildEvidenceManifest(input([signer({ index: 1 }), signer({ index: 2, email: 'bob@x.com', name: 'Bob' })]));
    assert.deepEqual(
      m.map((f) => f.path),
      [
        'document-original.pdf',
        'cover-1.pdf',
        'cover-2.pdf',
        'signer-1.eml',
        'signer-2.eml',
        'proofs/signer-1.tsr',
        'proofs/signer-1.ots',
        'proofs/signer-2.tsr',
        'proofs/signer-2.ots',
        'keys.json',
        'VERIFY-README.txt',
      ],
    );
    // All six embedded-file CLASSES present (Family B adds per-signer covers).
    assert.ok(m.some((f) => f.path === 'document-original.pdf'));
    assert.ok(m.some((f) => f.path === 'cover-1.pdf'));
    assert.ok(m.some((f) => f.path.endsWith('.eml')));
    assert.ok(m.some((f) => f.path.startsWith('proofs/')));
    assert.ok(m.some((f) => f.path === 'keys.json'));
    assert.ok(m.some((f) => f.path === 'VERIFY-README.txt'));
  });

  it('omits a signer’s proof files when that proof is absent', () => {
    const m = buildEvidenceManifest(input([signer({ index: 1, otsProof: null, tsaToken: proof('rfc3161', 't') })]));
    assert.ok(m.some((f) => f.path === 'proofs/signer-1.tsr'));
    assert.ok(!m.some((f) => f.path === 'proofs/signer-1.ots'), 'no .ots when OTS proof is null');
  });

  it('decodes proof bytes from the base64 proof data', () => {
    const m = buildEvidenceManifest(input([signer({ index: 1, otsProof: proof('ots', 'HELLO-OTS', 'pending') })]));
    const ots = m.find((f) => f.path === 'proofs/signer-1.ots')!;
    assert.equal(Buffer.from(ots.bytes).toString(), 'HELLO-OTS');
  });

  it('marks only VERIFY-README.txt as outside the fingerprint', () => {
    const m = buildEvidenceManifest(input([signer()]));
    for (const f of m) {
      assert.equal(f.inFingerprint, f.path !== 'VERIFY-README.txt', `${f.path} fingerprint membership`);
    }
  });
});

describe('computeBundleFingerprint — F-8.2', () => {
  it('is a deterministic 64-hex digest over identical inputs', () => {
    const a = computeBundleFingerprint(buildEvidenceManifest(input([signer()])));
    const b = computeBundleFingerprint(buildEvidenceManifest(input([signer()])));
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, b);
  });

  it('changes when an .eml byte changes (evidence is covered)', () => {
    const base = computeBundleFingerprint(buildEvidenceManifest(input([signer()])));
    const tampered = computeBundleFingerprint(
      buildEvidenceManifest(input([signer({ rawEml: new Uint8Array(Buffer.from('tampered eml')) })])),
    );
    assert.notEqual(base, tampered);
  });

  it('does NOT change when only VERIFY-README content changes (README excluded)', () => {
    const m1 = buildEvidenceManifest(input([signer()]));
    const fp1 = computeBundleFingerprint(m1);
    // Mutate the README bytes in place — fingerprint must be unaffected.
    const readme = m1.find((f) => f.path === 'VERIFY-README.txt')!;
    readme.bytes = new Uint8Array(Buffer.from('different readme text entirely'));
    const fp2 = computeBundleFingerprint(m1);
    assert.equal(fp1, fp2);
  });
});

describe('buildKeysJson — the offline DKIM key record (F-8.1)', () => {
  it('records domain/selector/key/observedAt/archive per signer in index order', () => {
    const k = buildKeysJson([
      signer({ index: 1 }),
      signer({ index: 2, signingDomain: 'globex.com', selector: 's2', dkimKey: null, archiveStatus: 'contributed' }),
    ]);
    assert.equal(k.version, 1);
    assert.equal(k.keys.length, 2);
    assert.deepEqual(k.keys[0], {
      signer: 1,
      domain: 'example.com',
      selector: 'sel',
      record: 'v=DKIM1; k=rsa; p=AAAB',
      observedAt: '2026-06-14T10:00:01.000Z',
      archive: { status: 'archived', source: 'archive.prove.email' },
    });
    // null key + contributed archive surface correctly.
    assert.equal(k.keys[1].record, null);
    assert.equal(k.keys[1].archive.status, 'contributed');
  });
});
