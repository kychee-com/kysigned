/**
 * Bitcoin block-header source — F-6 / AC-12, AC-23.
 *
 * Verification needs one external fact: the merkle root + time of a block at a
 * given height. This seam is pluggable (DD-3); the default reads a public
 * block-explorer's Esplora REST API (blockstream primary, mempool fallback). It
 * uses only `fetch`, so it runs in the browser (kysigned's verifier) too. A
 * trustless SPV/full-node source can implement the same interface later.
 *
 * `merkleRoot` is returned in explorer **display** (big-endian) hex; the verifier
 * reconciles byte order against the proof's commitment.
 */

export interface BlockHeader {
  height: number;
  /** Merkle root, explorer display-order hex. */
  merkleRoot: string;
  /** Block header timestamp, unix seconds. */
  timeSec: number;
  /** Block hash, display-order hex. */
  blockHash: string;
}

export interface HeaderSource {
  getBlockHeader(height: number): Promise<BlockHeader>;
}

export interface ExplorerOptions {
  /** Esplora-compatible API bases, tried in order. */
  bases?: string[];
  fetchFn?: typeof fetch;
}

const DEFAULT_BASES = ['https://blockstream.info/api', 'https://mempool.space/api'];

export function createExplorerHeaderSource(opts: ExplorerOptions = {}): HeaderSource {
  const bases = opts.bases ?? DEFAULT_BASES;
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as typeof fetch | undefined);
  if (!fetchFn) throw new Error('header source: no fetch available (provide fetchFn)');

  return {
    async getBlockHeader(height: number): Promise<BlockHeader> {
      let lastErr: unknown;
      for (const base of bases) {
        try {
          const root = base.replace(/\/$/, '');
          const hRes = await fetchFn(`${root}/block-height/${height}`);
          if (!hRes.ok) throw new Error(`block-height ${height}: HTTP ${hRes.status}`);
          const blockHash = (await hRes.text()).trim();
          const bRes = await fetchFn(`${root}/block/${blockHash}`);
          if (!bRes.ok) throw new Error(`block ${blockHash}: HTTP ${bRes.status}`);
          const block = (await bRes.json()) as { merkle_root?: string; timestamp?: number };
          if (typeof block.merkle_root !== 'string' || typeof block.timestamp !== 'number') {
            throw new Error('explorer returned an unexpected block shape');
          }
          return { height, merkleRoot: block.merkle_root, timeSec: block.timestamp, blockHash };
        } catch (e) {
          lastErr = e;
        }
      }
      throw new Error(`all bitcoin header sources failed for block ${height}: ${String(lastErr)}`);
    },
  };
}
