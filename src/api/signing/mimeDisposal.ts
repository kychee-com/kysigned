/**
 * Raw MIME disposal — spec F3.3.3.
 *
 * After the signed `.eml` has been embedded in the evidence bundle, the raw
 * email MUST be deleted from operator state. Only the bundle persists. This module provides a disposal function
 * that records the disposal for audit purposes.
 *
 * Note: JavaScript strings are immutable and GC'd — we cannot zero memory
 * directly. The disposal function records that the operator code has dropped
 * all references to the raw MIME. The actual memory cleanup happens via GC.
 * For defense-in-depth, the handler should set the rawMime variable to ''
 * after calling secureDispose.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DisposalRecord {
  disposed: boolean;
  disposedAt: Date | null;
  /** Size of the disposed content, for audit/logging */
  byteCount: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Record that raw MIME data has been disposed.
 *
 * @param rawMime - The raw MIME string to dispose (for byte counting)
 * @param record - Disposal record to update (caller-owned, for audit trail)
 */
export function secureDispose(rawMime: string, record: DisposalRecord): void {
  record.byteCount = rawMime.length;
  record.disposed = true;
  record.disposedAt = new Date();
}
