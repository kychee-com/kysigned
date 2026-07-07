/**
 * Proof envelope (de)serialization — F-1 / AC-2.
 *
 * A `TimestampProof` is plain JSON (the raw artifact lives base64-encoded in
 * `data`), so serialize/deserialize is JSON + a runtime shape guard. This lets a
 * consumer persist a proof and verify it later in a separate process.
 */
import type { TimestampProof } from './contract.js';

/** Runtime shape guard for a value that should be a `TimestampProof`. */
export function isTimestampProof(x: unknown): x is TimestampProof {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.provider === 'string' &&
    typeof p.version === 'number' &&
    (p.status === 'pending' || p.status === 'complete') &&
    typeof p.data === 'string'
  );
}

/** Serialize a proof to a storable/transmittable string. */
export function serializeProof(proof: TimestampProof): string {
  return JSON.stringify(proof);
}

/** Parse and validate a serialized proof; throws on malformed or non-proof input. */
export function deserializeProof(s: string): TimestampProof {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new Error('deserializeProof: input is not valid JSON');
  }
  if (!isTimestampProof(parsed)) {
    throw new Error('deserializeProof: input is not a TimestampProof');
  }
  return parsed;
}
