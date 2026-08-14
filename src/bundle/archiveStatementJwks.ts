/**
 * archiveStatementJwks.ts (F-32.9, zkemail/archive#46) — the PINNED archive
 * statement-verification key set.
 *
 * This is the verifier-side trust anchor for archive-signed observation statements:
 * statements embedded in bundles (and fetched at receipt) verify against THIS
 * committed set, NEVER against a key set supplied by the bundle itself — a forger
 * who controls a bundle's bytes must not get to choose the keys it verifies under.
 *
 * Source of truth upstream: `https://archive.zk.email/.well-known/dkim-archive-jwks.json`,
 * which the archive serves FROM its own committed repo mirror
 * (`src/lib/archive-statement-jwks.json` in zkemail/archive), so the URL and their
 * repo cannot drift. Their rotation policy is APPEND-ONLY — a rotation adds a `kid`
 * and never removes one — so refreshing this pin is additive: append the new key,
 * keep every old one (old statements keep verifying). Pinned 2026-08-14 after the
 * 10/10 production interop verification.
 *
 * Browser-safe: a plain const (no I/O), importable by the /verify SPA, the CLI,
 * and the receipt path alike.
 */
import type { ArchiveJwks } from './archiveStatement.js';

export const ARCHIVE_STATEMENT_JWKS: ArchiveJwks = {
  keys: [
    {
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'gdLO4-b4uRFoR8ILajR8ng-f4zM1ZRPCoozNk6gXptQ',
      kid: 'archive-statement-2026-08-13-57Yb4kX1',
      alg: 'EdDSA',
      use: 'sig',
    },
  ],
};
