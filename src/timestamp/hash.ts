/**
 * Input guard — F-1 / AC-3.
 *
 * Every provider's `stamp()` calls `assertHash32` as its first statement, so a
 * malformed hash is rejected synchronously before any network call is made.
 */

/** Assert `hash` is exactly a 32-byte Uint8Array (a SHA-256 digest); throws otherwise. */
export function assertHash32(hash: unknown): asserts hash is Uint8Array {
  if (!(hash instanceof Uint8Array)) {
    throw new TypeError('hash must be a Uint8Array (a 32-byte SHA-256 digest)');
  }
  if (hash.length !== 32) {
    throw new RangeError(`hash must be a 32-byte digest, got ${hash.length} bytes`);
  }
}
