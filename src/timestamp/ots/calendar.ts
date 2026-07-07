/**
 * OTS calendar client — F-3 / AC-6, AC-7.
 *
 * Stamping appends a random 16-byte nonce to the file digest, SHA-256s it (so the
 * value we publish reveals nothing about the document), and submits that leaf to
 * several public calendar servers. Each returns a timestamp tree (rooted at the
 * leaf) ending in a PendingAttestation; we union them under one proof. Stamping
 * succeeds if at least one calendar responds.
 */
import { assertHash32 } from '../hash.js';
import { Reader } from './serialization.js';
import { applyOp } from './ops.js';
import { collectAttestations, deserializeTimestamp, type Branch, type Timestamp } from './timestamp.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface StampDeps {
  /** Injectable fetch (default: global fetch) — tests pass a fake, no network. */
  fetchFn?: typeof fetch;
  /** Injectable randomness for the nonce (default: crypto RNG) — tests pin it. */
  randomBytes?: (n: number) => Uint8Array;
}

function resolveFetch(deps?: StampDeps): typeof fetch {
  const f = deps?.fetchFn ?? (globalThis.fetch as typeof fetch | undefined);
  if (!f) throw new Error('calendar: no fetch available (provide deps.fetchFn)');
  return f;
}

function defaultRandomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** Submit a 32-byte message to one calendar; returns its timestamp tree rooted at `msg`. */
export async function submitDigest(
  calendarUrl: string,
  msg: Uint8Array,
  deps?: StampDeps,
): Promise<Timestamp> {
  const res = await resolveFetch(deps)(`${calendarUrl.replace(/\/$/, '')}/digest`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.opentimestamps.v1',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'kysigned-timestamp-module',
    },
    // TS 5.7 typed `Uint8Array` as `Uint8Array<ArrayBufferLike>`, which no longer
    // matches `BodyInit` in an overload context; fetch accepts the bytes at runtime.
    body: msg as BodyInit,
  });
  if (!res.ok) throw new Error(`calendar ${calendarUrl} returned HTTP ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  return deserializeTimestamp(new Reader(body), msg);
}

/**
 * Stamp a 32-byte file digest across calendars, returning a pending proof tree:
 *   digest --append(nonce)--> --sha256--> leaf --[calendar branches…]
 */
export async function stampWithCalendars(
  fileDigest: Uint8Array,
  calendarUrls: string[],
  deps?: StampDeps,
): Promise<Timestamp> {
  assertHash32(fileDigest);
  const nonce = (deps?.randomBytes ?? defaultRandomBytes)(16);
  const appended = applyOp({ kind: 'append', arg: nonce }, fileDigest);
  const leaf = applyOp({ kind: 'sha256' }, appended);

  const results = await Promise.allSettled(calendarUrls.map((u) => submitDigest(u, leaf, deps)));
  const trees = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (trees.length === 0) throw new Error('all calendars failed — stamping aborted');

  const leafTimestamp: Timestamp = { msg: leaf, branches: trees.flatMap((t) => t.branches) };
  const appendedTimestamp: Timestamp = {
    msg: appended,
    branches: [{ type: 'op', op: { kind: 'sha256' }, child: leafTimestamp }],
  };
  return {
    msg: fileDigest,
    branches: [{ type: 'op', op: { kind: 'append', arg: nonce }, child: appendedTimestamp }],
  };
}

function hasBitcoin(ts: Timestamp): boolean {
  return collectAttestations(ts).some((a) => a.attestation.kind === 'bitcoin');
}

/** GET <calendar>/timestamp/<commitment-hex>; null on 404/error (not yet confirmed). */
async function fetchUpgrade(
  calendarUrl: string,
  commitment: Uint8Array,
  deps?: StampDeps,
): Promise<Timestamp | null> {
  const hex = bytesToHex(commitment);
  try {
    const res = await resolveFetch(deps)(`${calendarUrl.replace(/\/$/, '')}/timestamp/${hex}`, {
      headers: { Accept: 'application/vnd.opentimestamps.v1' },
    });
    if (!res.ok) return null;
    return deserializeTimestamp(new Reader(new Uint8Array(await res.arrayBuffer())), commitment);
  } catch {
    return null;
  }
}

/**
 * Try to advance every pending attestation to its Bitcoin-anchored path by asking
 * the calendar. Splices in any confirmed branch; pending stays pending otherwise.
 * Returns the (possibly) upgraded proof and whether anything advanced.
 */
export async function upgradeTimestamp(
  ts: Timestamp,
  deps?: StampDeps,
): Promise<{ timestamp: Timestamp; upgraded: boolean }> {
  let upgraded = false;
  const walk = async (node: Timestamp): Promise<Timestamp> => {
    const branches: Branch[] = [];
    for (const br of node.branches) {
      if (br.type === 'attestation' && br.attestation.kind === 'pending') {
        const fetched = await fetchUpgrade(br.attestation.uri, node.msg, deps);
        if (fetched && hasBitcoin(fetched)) {
          branches.push(...fetched.branches);
          upgraded = true;
        } else {
          branches.push(br);
        }
      } else if (br.type === 'op') {
        branches.push({ ...br, child: await walk(br.child) });
      } else {
        branches.push(br);
      }
    }
    return { msg: node.msg, branches };
  };
  const timestamp = await walk(ts);
  return { timestamp, upgraded };
}
