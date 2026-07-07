/**
 * Real-browser reachability guard (Phase 28.3 — DD-17 / DD-18 deepening).
 *
 * The AC-59-class miss recurred one level down: 27.7's reachability test ran in
 * NODE (no CORS), so it couldn't catch that the browser was blocked from reading
 * archive.prove.email cross-origin. The ONLY thing that catches a CORS-class break
 * is a REAL browser. This launches headless Chromium (the system Edge/Chrome via
 * `channel`, no browser download), loads /verify, drops the committed signed
 * fixture, and asserts the key badge reaches green "key in public archive" — which
 * only happens if the web verifier reaches the archive through the SAME-ORIGIN proxy
 * (F-10.8). If the lookup were cross-origin (no CORS), the badge would stay "pending"
 * and this times out.
 *
 * Run:  VERIFY_URL=https://kysigned.com/verify node frontend/test/keyArchiveBrowser.e2e.mjs
 *       (PW_CHANNEL=chrome to use Chrome instead of Edge)
 */
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const VERIFY_URL = process.env.VERIFY_URL ?? 'https://kysigned.com/verify';
const CHANNEL = process.env.PW_CHANNEL ?? 'msedge';
const FIXTURE = fileURLToPath(new URL('../../docs/test-assets/acme-anvil-waiver-signed-bundle.pdf', import.meta.url));

console.log(`[browser-e2e] launching ${CHANNEL} (headless) → ${VERIFY_URL}`);
const browser = await chromium.launch({ headless: true, channel: CHANNEL });
let failed = false;
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page console.error]', m.text()); });
  await page.goto(VERIFY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // Drop the fixture on the (hidden) upload input — setInputFiles works without a click.
  await page.setInputFiles('input[type=file]', FIXTURE);

  // The offline verdict renders first; then the auto-online key-archive check upgrades
  // the badge grey → green THROUGH THE SAME-ORIGIN PROXY. That green is the CORS-class
  // assertion (a cross-origin no-CORS lookup would leave it stuck at "pending").
  await page.getByText('Verified').first().waitFor({ timeout: 30_000 });
  await page.getByText(/key in public archive/i).waitFor({ timeout: 30_000 });
  // Bitcoin should also reach green (web ≡ CLI, additive) — assert for completeness.
  await page.getByText(/Bitcoin timestamp confirmed/i).waitFor({ timeout: 30_000 });

  console.log('[browser-e2e] PASS — real browser: Verified + green "key in public archive" via the proxy + Bitcoin confirmed.');
} catch (e) {
  failed = true;
  console.log('[browser-e2e] FAIL —', e instanceof Error ? e.message.split('\n')[0] : String(e));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
