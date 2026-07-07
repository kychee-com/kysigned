/**
 * Positive-state reachability guard (DD-17) — the anti-orphan-seam regression net.
 *
 * The AC-59 bug (DD-16) shipped because a fake-only dependency seam made the GREEN
 * "archive-confirmed" state UNREACHABLE in production, while unit tests (the fake
 * passes) AND Red Team (a permanently-grey "pending" badge looks legitimate) both
 * stayed green. The only thing that kills that class is proving the success state is
 * REACHABLE through the real path. So: drive the REAL verifier (NO fakes; real
 * archive + real Bitcoin) over the committed signed fixture and assert EVERY indicator
 * reaches its green/success state. Any positive state unreachable → FAIL.
 *
 * Gated on KYSIGNED_ONLINE_E2E=1 — it hits the live archive.prove.email, the OTS
 * calendars, and a Bitcoin block source, so it stays out of the default hermetic unit
 * run (where it is skipped, never failed).
 *
 * ── The orphan-seam audit heuristic (re-run periodically) ──────────────────────────
 * Grep the non-test source for `if (deps.X)` — a behaviour gated on an injected seam.
 * For each, confirm a NON-TEST production caller supplies the real impl; a seam that
 * ONLY test fakes ever fill is an orphan (the AC-59 shape). Prefer `?? realDefault`
 * over a bare `if (deps.X)`, so "no deps" runs the real thing and a fake is the
 * explicit test override — then the unwired state cannot ship. (Audit 2026-06-30:
 * resolveArchiveWindow was the sole orphan; all signing-path seams are wired via
 * config.ts:326.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyBundleWeb, confirmKeyArchiveWeb, confirmBitcoinAnchorsWeb } from './verifyWeb.js';

const FIXTURE = fileURLToPath(new URL('../../docs/test-assets/acme-anvil-waiver-signed-bundle.pdf', import.meta.url));
const bundle = new Uint8Array(readFileSync(FIXTURE));
const skip = process.env.KYSIGNED_ONLINE_E2E === '1' ? false : 'set KYSIGNED_ONLINE_E2E=1 to run (hits live archive.prove.email + Bitcoin)';

describe('positive-state reachability (DD-17) — every green indicator is reachable via the REAL path', () => {
  it(
    'real verifier + real archive + real Bitcoin → DKIM, attachment, intent, timestamp, key archive-confirmed, Bitcoin confirmed',
    { skip },
    async () => {
      // 1. Offline verdict (NO fakes) — the four gating checks must be reachable green.
      const v = await verifyBundleWeb(bundle);
      assert.equal(v.proven, true, `bundle not PROVEN: ${JSON.stringify(v.signers?.[0]?.reasons)}`);
      const s0 = v.signers[0];
      assert.equal(s0.checks.dkim, true, 'DKIM green unreachable');
      assert.equal(s0.checks.attachment, true, 'attachment green unreachable');
      assert.equal(s0.checks.intent, true, 'intent green unreachable');
      assert.equal(s0.checks.timestamp, true, 'timestamp green unreachable');

      // 2. ONLINE key-archive presence (real archive.prove.email) — the formerly-orphaned
      //    green state. If THIS is unreachable, the AC-59 class has regressed.
      const keys = await confirmKeyArchiveWeb(bundle);
      assert.equal(
        keys[s0.index]?.keyAuthenticity,
        'archive-confirmed',
        'KEY ARCHIVE green unreachable — orphan-seam regression (the AC-59 class)',
      );
      assert.ok(keys[s0.index]?.observedAt, 'archive-confirmed must carry a registration time');

      // 3. ONLINE Bitcoin anchor (real OTS calendar + Bitcoin block) — green reachable.
      const anchors = await confirmBitcoinAnchorsWeb(bundle);
      assert.equal(anchors[s0.index]?.status, 'confirmed', 'BITCOIN green unreachable');
      assert.ok(anchors[s0.index]?.blockHeight, 'confirmed Bitcoin anchor must carry a block height');
    },
  );
});
