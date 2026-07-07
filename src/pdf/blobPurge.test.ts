/**
 * blobPurge tests — F-013.
 *
 * Every terminal-state path purges an envelope's REAL blob keys through this
 * helper. Covers are always deleted; the shared document D is deleted only when
 * no other envelope still references it (content-addressed by document_hash).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { purgeEnvelopeBlobs } from './blobPurge.js';
import type { DbPool } from '../db/pool.js';

/** A pool whose "other referencer?" guard returns `siblingExists` rows. */
function guardPool(siblingExists: boolean): DbPool {
  return {
    async query(text: string) {
      if (text.includes('FROM envelopes') && text.includes('document_hash')) {
        return { rows: siblingExists ? [{ '?column?': 1 }] : [] } as never;
      }
      return { rows: [] } as never;
    },
    async end() {},
  };
}

function storage() {
  const deleted: string[] = [];
  return { deleted, async deletePdf(k: string) { deleted.push(k); } };
}

describe('purgeEnvelopeBlobs — F-013', () => {
  it('deletes the document D + every cover when this is the sole referencer', async () => {
    const s = storage();
    const r = await purgeEnvelopeBlobs(
      guardPool(false),
      s,
      { id: 'e1', document_hash: 'hh' },
      [{ signing_token: 't1' }, { signing_token: 't2' }],
    );
    assert.deepEqual(s.deleted.sort(), [
      'envelopes/hh/cover-t1.pdf',
      'envelopes/hh/cover-t2.pdf',
      'envelopes/hh/document.pdf',
    ]);
    assert.equal(r.deleted, 3);
    assert.equal(r.failed, 0);
  });

  it('SKIPS the shared document D when another envelope still references it', async () => {
    const s = storage();
    const r = await purgeEnvelopeBlobs(
      guardPool(true), // a live sibling shares document_hash
      s,
      { id: 'e1', document_hash: 'hh' },
      [{ signing_token: 't1' }],
    );
    // Only the cover is freed; D stays for the sibling.
    assert.deepEqual(s.deleted, ['envelopes/hh/cover-t1.pdf']);
    assert.ok(!s.deleted.includes('envelopes/hh/document.pdf'));
    assert.equal(r.deleted, 1);
  });

  it('purges the document even for a signer-less envelope', async () => {
    const s = storage();
    await purgeEnvelopeBlobs(guardPool(false), s, { id: 'e1', document_hash: 'z' }, []);
    assert.deepEqual(s.deleted, ['envelopes/z/document.pdf']);
  });

  it('is fail-soft: a single delete throwing is counted, not fatal', async () => {
    const failing = {
      deleted: [] as string[],
      async deletePdf(k: string) {
        if (k.endsWith('document.pdf')) throw new Error('backend down');
        this.deleted.push(k);
      },
    };
    const r = await purgeEnvelopeBlobs(
      guardPool(false),
      failing,
      { id: 'e1', document_hash: 'hh' },
      [{ signing_token: 't1' }],
    );
    assert.deepEqual(failing.deleted, ['envelopes/hh/cover-t1.pdf']);
    assert.equal(r.deleted, 1);
    assert.equal(r.failed, 1);
  });
});
