# Licenses

This repository is **100% permissively licensed**. Everything is
[Apache-2.0](LICENSE) — and **every dependency is permissive too** (MIT or Apache-2.0).
There is **no GPL, LGPL, AGPL, or other copyleft anywhere** in the tree or in the
dependency graph.

For a forker that means: use it, modify it, run it commercially, and redistribute
it with **no copyleft obligations, no source-disclosure requirement, and no
royalties**. The root [LICENSE](LICENSE) file (Apache-2.0) governs the entire repository
with no per-file exceptions.

## Dependencies

All runtime and build dependencies are permissive:

| Dependency | License |
|------------|---------|
| `mailauth` (classical DKIM/SPF/DMARC verification — the trust anchor) | MIT |
| `pdf-lib` (canonical PDF + bundle assembly) | MIT |
| `pg` (Postgres client) | MIT |
| `qrcode` (signature-page + verify QR codes) | MIT |
| `crypto-js` | MIT |
| `tsx` | MIT |
| `typescript` | Apache-2.0 |

See [LEGAL.md](LEGAL.md) for signature-validity disclaimers and jurisdictional
limitations.
