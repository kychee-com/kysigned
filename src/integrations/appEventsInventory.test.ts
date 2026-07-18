/**
 * appEventsInventory.test.ts — F-36.2 / AC-195 structural lock (60.4).
 *
 * The five emit sites' own suites exercise each transition with PII-rich
 * fixtures and `deepEqual` the EXACT ids-only payload. This suite locks the
 * structure around them so future drift fails loudly:
 *
 *  1. INVENTORY — every `emitAppEvent` call site in production source must be
 *     in the registered set below. A new site = register it here AND give it
 *     a deepEqual payload test in its own suite.
 *  2. KEY ALLOWLIST — the payload-object keys at every registered site are
 *     scanned from source and must stay inside the ids/counts/enums allowlist
 *     (no email/name/document-derived keys can appear without failing here).
 *  3. RUNTIME BOUNDARY — the real `@run402/functions` events surface is
 *     touched ONLY by `runtime.ts` (value import) and the ambient d.ts;
 *     nothing else may call `events.emit` directly (the DD-43 seam is the
 *     single choke point).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') && !p.endsWith('.testpool.ts'))
      out.push(p);
  }
  return out;
}

const files = walk(SRC);
const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');

/** Production files allowed to CALL the seam, with their exact emit-call count. */
const REGISTERED_EMIT_SITES: Record<string, number> = {
  'api/signing/inboundEmail.ts': 2, // signature_completed + signer_declined
  'api/envelope.ts': 1, // envelope_undeliverable
  'api/distributeBundle.ts': 1, // envelope_completed
  'api/signing/archiveReconciliation.ts': 1, // sweep_anomaly (archive)
  'api/signupGrantMonitor.ts': 1, // sweep_anomaly (grant)
  'integrations/appEvents.ts': 1, // the seam's own definition/entry
  'functions/config.ts': 1, // buildAppDeps constructs the seam binding
};

/** Every payload key any emit site may put on the wire (ids/counts/enums only). */
const PAYLOAD_KEY_ALLOWLIST = new Set([
  'envelope_id',
  'message_id',
  'signer_id',
  'code',
  'recipients',
  'monitor',
  'still_failing',
  'healed',
  'issuance_count',
  'grant_funded_envelopes',
  'threshold',
]);

test('every emitAppEvent call site is registered (new sites must register + add a payload test)', () => {
  const found: Record<string, number> = {};
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const calls = text.match(/emitAppEvent(\?\.)?\(/g);
    if (calls) found[rel(f)] = calls.length;
  }
  // Pass-through/wiring references (no parens) are free; CALLS are inventoried.
  assert.deepEqual(
    Object.fromEntries(Object.entries(found).sort()),
    Object.fromEntries(Object.entries(REGISTERED_EMIT_SITES).sort()),
    'emitAppEvent call-site inventory drifted — register the site here and give it a deepEqual payload-shape test',
  );
});

test('emit payload keys stay inside the ids/counts/enums allowlist (no PII, nothing document-derived)', () => {
  const offenders: string[] = [];
  for (const f of files) {
    if (!(rel(f) in REGISTERED_EMIT_SITES)) continue;
    const text = readFileSync(f, 'utf8');
    // Match each emit call's inline payload object literal and pull its keys.
    const re = /emitAppEvent(?:\?\.)?\(\s*'[a-z_]+'\s*,\s*\[[^\]]*\]\s*,\s*\{([^}]*)\}/gs;
    for (const m of text.matchAll(re)) {
      for (const keyMatch of m[1].matchAll(/(?:^|[,{]\s*)([a-z_]+)\s*:/gs)) {
        const key = keyMatch[1];
        if (!PAYLOAD_KEY_ALLOWLIST.has(key)) offenders.push(`${rel(f)}: payload key "${key}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'non-allowlisted payload key on the wire — ids/counts/enums only (F-36.2)');
});

test('the runtime events surface is touched only by runtime.ts (DD-43 single choke point)', () => {
  const offenders: string[] = [];
  for (const f of files) {
    const r = rel(f);
    const text = readFileSync(f, 'utf8');
    if (/\bevents\.emit\(/.test(text) && r !== 'functions/runtime.ts') {
      offenders.push(`${r}: direct events.emit`);
    }
    if (/^import\s+(?!type)[^;]*from\s+'@run402\/functions'/m.test(text) && r !== 'functions/runtime.ts') {
      // Value imports of the runtime module outside runtime.ts break the
      // runtime-free core (type-only imports are fine).
      offenders.push(`${r}: value import of @run402/functions`);
    }
  }
  assert.deepEqual(offenders, [], 'the platform events surface must flow through runtime.ts + the seam only');
});
