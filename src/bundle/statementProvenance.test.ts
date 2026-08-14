/**
 * statementProvenance tests — F-32.9 / AC-267 / AC-268 groundwork (spec 0.71.0).
 *
 * Offline. The module matrix (verify → match → live-only → confirmation; every
 * failure leg falls back to nothing), and the ENGINE fold: a bundle whose signer
 * embeds a valid statement reaches keyProvenance CONFIRMED with zero network on
 * BOTH engines; a statement-less bundle keeps the offline-pending posture.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CompactSign, generateKeyPair, exportJWK } from 'jose';
import { confirmStatementsOffline } from './statementProvenance.js';
import { buildEvidenceManifest } from './evidenceManifest.js';
import { assembleBundle } from './assembleBundle.js';
import { verifyBundleWeb } from './verifyWeb.js';
import { verifyBundle } from './verify.js';
import type { AssembleBundleInput, BundleSignerInput } from './types.js';
import type { ArchiveJwks } from './archiveStatement.js';

const OBSERVED_KEY = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqTESTKEY';

async function makeSigner(kid = 'test-arch-1') {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };
  const sign = async (payload: unknown) =>
    new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .sign(privateKey);
  return { sign, jwks: { keys: [jwk] } as ArchiveJwks };
}

function stmtPayload(over: Record<string, unknown> = {}, recordOver: Record<string, unknown> = {}) {
  return {
    v: 1,
    iss: 'archive.zk.email',
    iat: 1789000000,
    record: {
      id: '77', domain: 'example.com', selector: 'sel', value: OBSERVED_KEY,
      source: 'live_dns', first_seen_at: '2026-06-01T00:00:00Z', last_seen_at: '2026-08-09T00:00:00Z',
      ...recordOver,
    },
    ...over,
  };
}

function bundleSigner(over: Partial<BundleSignerInput> = {}): BundleSignerInput {
  return {
    index: 1,
    name: 'Alice',
    email: 'alice@example.com',
    signingDomain: 'example.com',
    selector: 'sel',
    signedAt: new Date('2026-06-14T10:00:00Z'),
    emlSha256: 'a'.repeat(64),
    rawEml: new TextEncoder().encode('From: alice@example.com\r\n\r\nI sign this document\r\n'),
    cover: new TextEncoder().encode('%PDF-cover-1\n'),
    dkimKey: OBSERVED_KEY,
    dkimObservedAt: new Date('2026-06-14T10:00:01Z'),
    archiveStatus: 'archived',
    ...over,
  };
}

function filesFor(signers: BundleSignerInput[]): Map<string, Uint8Array> {
  const input: AssembleBundleInput = {
    envelope: {
      id: '18267982-ca76-45dc-a294-e86039a6343d',
      documentName: 'NDA',
      documentHash: 'd'.repeat(64),
      creatorEmail: 'creator@acme.com',
      completedAt: new Date('2026-06-14T12:00:00Z'),
    },
    documentOriginal: new TextEncoder().encode('%PDF-1.7\ndoc\n%%EOF\n'),
    signers,
    verifierBaseUrl: 'https://kysigned.com',
  };
  return new Map(buildEvidenceManifest(input).map((f) => [f.path, f.bytes]));
}

describe('confirmStatementsOffline — the module matrix', () => {
  it('a valid matching live statement confirms with the statement’s own window times', async () => {
    const { sign, jwks } = await makeSigner();
    const jws = await sign(stmtPayload());
    const files = filesFor([bundleSigner({ archiveStatement: jws })]);
    const out = await confirmStatementsOffline(files, jwks);
    assert.deepEqual(out[1], {
      keyAuthenticity: 'archive-confirmed',
      keyProvenance: 'confirmed',
      observedAt: '2026-06-01T00:00:00Z',
      lastSeenAt: '2026-08-09T00:00:00Z',
    });
  });

  it('every failure leg yields NOTHING (live fallback): stranger signer, wrong key, wrong pair, non-live source, no statement', async () => {
    const { sign } = await makeSigner();
    const strangerJwks = (await makeSigner('other-kid')).jwks; // different keypair
    const cases: Array<[string, Map<string, Uint8Array>, ArchiveJwks]> = [
      ['stranger signer', filesFor([bundleSigner({ archiveStatement: await sign(stmtPayload()) })]), strangerJwks],
      ['wrong key', filesFor([bundleSigner({ archiveStatement: await sign(stmtPayload({}, { value: 'v=DKIM1; k=rsa; p=OTHER' })) })]), (await makeSigner()).jwks],
      ['no statement', filesFor([bundleSigner()]), (await makeSigner()).jwks],
    ];
    // wrong pair + non-live need the SAME signer's jwks:
    const s2 = await makeSigner();
    cases.push(['wrong pair', filesFor([bundleSigner({ archiveStatement: await s2.sign(stmtPayload({}, { selector: 'other-sel' })) })]), s2.jwks]);
    const s3 = await makeSigner();
    cases.push(['non-live source', filesFor([bundleSigner({ archiveStatement: await s3.sign(stmtPayload({}, { source: 'gcd_recovered' })) })]), s3.jwks]);
    for (const [label, files, jwks] of cases) {
      const out = await confirmStatementsOffline(files, jwks);
      assert.deepEqual(out, {}, `${label} must contribute nothing`);
    }
  });
});

describe('engine fold — embedded statement confirms provenance OFFLINE on both engines (AC-267)', () => {
  async function tinyPdf(label: string): Promise<Uint8Array> {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([200, 100]);
    doc.setTitle(label);
    return doc.save({ useObjectStreams: false });
  }

  async function craftBundle(signerOver: Partial<BundleSignerInput>) {
    const documentOriginal = await tinyPdf('doc');
    const cover = await tinyPdf('cover');
    return assembleBundle({
      envelope: {
        id: '18267982-ca76-45dc-a294-e86039a6343d',
        documentName: 'NDA',
        documentHash: 'd'.repeat(64),
        creatorEmail: 'creator@acme.com',
        completedAt: new Date('2026-06-14T12:00:00Z'),
      },
      documentOriginal,
      signers: [bundleSigner({ cover, ...signerOver })],
      verifierBaseUrl: 'https://kysigned.com',
    });
  }

  it('web + node: keyProvenance confirmed with zero network; statement-less bundle stays pending', async () => {
    const { sign, jwks } = await makeSigner();
    const jws = await sign(stmtPayload());
    const withStmt = await craftBundle({ archiveStatement: jws });
    const web = await verifyBundleWeb(withStmt.bytes, { statementJwks: jwks });
    const node = await verifyBundle(withStmt.bytes, { statementJwks: jwks });
    for (const [engine, v] of [['web', web], ['node', node]] as const) {
      assert.equal(v.signers[0]?.assurance.keyProvenance, 'confirmed', `${engine}: offline statement confirms provenance`);
      assert.equal(v.signers[0]?.checks.keyAuthenticity, 'archive-confirmed', `${engine}: key shows archive-confirmed`);
      assert.equal(v.signers[0]?.keyObservedAt, '2026-06-01T00:00:00Z', `${engine}: observedAt from the statement`);
    }

    const without = await craftBundle({});
    const webPlain = await verifyBundleWeb(without.bytes, { statementJwks: jwks });
    assert.equal(webPlain.signers[0]?.assurance.keyProvenance, 'pending', 'no statement → the offline-pending posture (old bundles unchanged)');
  });
});
