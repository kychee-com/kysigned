# timestamp-module

A self-contained **timestamping module**: given any 32-byte hash, **stamp** it and
later **validate** it end-to-end. Everything hides behind one swappable
`TimestampProvider` contract, so a whole provider can be replaced as a unit.

Written from scratch over `fetch` + runtime crypto and the generic `pkijs` (ASN.1/PKI)
library — **no `opentimestamps` dependency and no turnkey "RFC 3161" package.**

## The contract

```ts
interface TimestampProvider {
  readonly id: string;                 // 'ots' | 'rfc3161' | 'fake'
  readonly trustModel?: TrustModel;    // 'bitcoin-math' | 'trusted-third-party' | 'fake'
  stamp(hash: Uint8Array): Promise<TimestampProof>;
  verify(proof: TimestampProof, hash: Uint8Array): Promise<{ ok; timeSec; anchor }>;
  upgrade?(proof: TimestampProof): Promise<TimestampProof>;  // OTS: pending → Bitcoin
}
```

A consumer stamps `sha256(payload)`, persists the opaque (JSON-serializable) proof, and
later verifies it — in a different process, or in the browser.

## The two providers (selectable options)

| | **OpenTimestamps** (`ots`) | **RFC 3161 TSA** (`rfc3161`) |
|---|---|---|
| Anchored by | the **Bitcoin** blockchain (via opentimestamps.org calendars) | a **timestamping authority** (default freeTSA) |
| Trust model | `bitcoin-math` — nobody to trust but Bitcoin + math | `trusted-third-party` — the TSA + its CA |
| Proof artifact | a standard `.ots` proof (base64 in `proof.data`) | a DER RFC 3161 token (base64 in `proof.data`) |
| Validation | re-derive the commitment from the hash, match it to a real block's merkle root (block-explorer header source), read the block time | verify the TSA's signature over the token + that its imprint == the hash, read `genTime` |
| Lifecycle | `stamp` → **pending** immediately; `upgrade` → **complete** after Bitcoin confirms (~hours) | `stamp` → **complete** in one round-trip; no upgrade |
| Browser-safe verify | yes (fetch + WebCrypto) | yes (pkijs + WebCrypto) |

**kysigned.com runs BOTH in production** — a deliberate dual anchor over `sha256(raw .eml)`.
OpenTimestamps is the trustless Bitcoin/math anchor but is *pending* until a block confirms
(~hours); RFC 3161 is the synchronous, court/eIDAS-recognised TSA token that covers exactly that
confirmation gap. The chain anchor, in turn, can't be back-dated, so it backstops a misbehaving
TSA. The two establish the same fact through independent trust roots, so a verifier can rely on
either alone — and a forker can run either provider on its own, or swap in their own.

## Usage

```ts
import { createOtsProvider } from './ots/provider.js';
import { createRfc3161Provider } from './rfc3161/provider.js';

const ots = createOtsProvider();          // default public calendars + block-explorer header source
const proof = await ots.stamp(hash);      // pending
const complete = await ots.upgrade!(proof); // after Bitcoin confirms
const { ok, timeSec, anchor } = await ots.verify(complete, hash);

const tsa = createRfc3161Provider();      // default freeTSA; pass { tsaUrl } to override
```

Every external endpoint is configurable (calendars, header source, TSA URL), so a forker
can swap them — or implement a new `TimestampProvider` and drop it in.

## CLI (dev/test harness)

```
npx tsx src/timestamp/cli-main.ts [--provider ots|rfc3161] stamp   <hash-hex | file>
npx tsx src/timestamp/cli-main.ts [--provider ots|rfc3161] verify  <proof | proof-file> <hash-hex | file>
npx tsx src/timestamp/cli-main.ts [--provider ots] upgrade <proof-file>
```

Stamping a file writes a `<file>.tsproof` artifact.

## Testing

The default suite is **fully offline** (fixtures + a fake provider) with **no skipped
tests**:

```
node --test --import tsx "src/timestamp/**/*.test.ts"
```

Live checks against the real services — OTS calendars, a **real Bitcoin block** (via a
block explorer, proving the verification math), and real freeTSA — live in separate
`*.live.ts` files, run on demand:

```
node --test --import tsx "src/timestamp/**/*.live.ts"
```

Correctness is established by the **math** (verifying against the real Bitcoin chain) and
by emitting a **standard `.ots` artifact** any OpenTimestamps implementation can read — we
do not depend on, or test against, another implementation's client.
