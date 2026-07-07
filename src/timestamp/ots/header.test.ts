import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createExplorerHeaderSource, type HeaderSource } from './header.js';

function fakeExplorer(opts: { failBases?: string[] } = {}): typeof fetch {
  return async (url) => {
    const u = String(url);
    if (opts.failBases?.some((b) => u.startsWith(b))) return new Response('err', { status: 500 });
    if (u.includes('/block-height/')) return new Response('0000000000000000000blockhashabc', { status: 200 });
    if (u.includes('/block/')) {
      return new Response(JSON.stringify({ merkle_root: 'deadbeefmerkleroot', timestamp: 1700001234 }), { status: 200 });
    }
    return new Response('?', { status: 404 });
  };
}

describe('Bitcoin-header source (AC-12 — pluggable, fetch-only)', () => {
  it('fetches a block header (merkle root + time + hash) from the explorer', async () => {
    const src = createExplorerHeaderSource({ fetchFn: fakeExplorer() });
    const h = await src.getBlockHeader(800000);
    assert.equal(h.height, 800000);
    assert.equal(h.merkleRoot, 'deadbeefmerkleroot');
    assert.equal(h.timeSec, 1700001234);
    assert.equal(h.blockHash, '0000000000000000000blockhashabc');
  });

  it('falls back to the secondary explorer when the primary fails', async () => {
    const src = createExplorerHeaderSource({
      bases: ['https://primary', 'https://secondary'],
      fetchFn: fakeExplorer({ failBases: ['https://primary'] }),
    });
    const h = await src.getBlockHeader(800000);
    assert.equal(h.timeSec, 1700001234);
  });

  it('throws when every explorer fails', async () => {
    const src = createExplorerHeaderSource({
      bases: ['https://a', 'https://b'],
      fetchFn: fakeExplorer({ failBases: ['https://a', 'https://b'] }),
    });
    await assert.rejects(() => src.getBlockHeader(800000), /all (bitcoin )?header sources/i);
  });

  it('accepts any custom HeaderSource (the seam is pluggable)', async () => {
    const custom: HeaderSource = {
      async getBlockHeader(height) {
        return { height, merkleRoot: 'aa', timeSec: 1, blockHash: 'bb' };
      },
    };
    assert.equal((await custom.getBlockHeader(1)).merkleRoot, 'aa');
  });
});
