/**
 * internalSubject.test.ts — F-36.6 internal-subject classifier (66.1, DD-49).
 *
 * The ONE classification the app-event emit sites consult before emitting: a
 * subject is internal exactly when the operator console's exclude-internal
 * toggle would hide it (F-35.4) — the account email matches the configured
 * rules, or the subject envelope is `internal_test` / has a rule-matched
 * creator. The gate owns the two disciplines every site would otherwise copy:
 * the suppression log line, and FAIL-OPEN on a classification-lookup failure
 * (AC-213 — availability of real events outranks perfect suppression; a DB
 * blip must never gate a transition NOR silently eat an external event).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInternalSubjectGate,
  isInternalEnvelopeRow,
  type InternalSubjectGate,
} from './internalSubject.js';

const RULES = ['@kychee.com', 'volinskey@gmail.com', 'redteam-*@kysigned.com'];

function collector(): { lines: string[]; log: (message: string) => void } {
  const lines: string[] = [];
  return { lines, log: (message: string) => void lines.push(message) };
}

function poolReturning(rows: unknown[]): { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> } {
  return { query: async () => ({ rows }) };
}

// ── account form (pure, F-35.4 predicate) ────────────────────────────────────

test('account: rule-matched emails classify internal across all three rule forms', () => {
  const { log } = collector();
  const gate = createInternalSubjectGate({ internalIdentities: RULES, log });
  assert.equal(gate.account('barry@kychee.com'), true); // whole domain
  assert.equal(gate.account('VOLINSKEY@GMAIL.COM'), true); // exact, case-insensitive
  assert.equal(gate.account('redteam-pilot@kysigned.com'), true); // domain-scoped glob
  assert.equal(gate.account('jrdrake22@gmail.com'), false); // external stays external
  assert.equal(gate.account(null), false);
  assert.equal(gate.account(undefined), false);
});

test('account: an EMPTY rules list matches nobody (fork default, AC-192 posture)', () => {
  const { log } = collector();
  const gate = createInternalSubjectGate({ internalIdentities: [], log });
  assert.equal(gate.account('barry@kychee.com'), false);
  assert.equal(gate.account('redteam-pilot@kysigned.com'), false);
});

// ── envelope row form (pure) ─────────────────────────────────────────────────

test('envelope row: internal_test OR rule-matched creator → internal; neither → external', () => {
  assert.equal(isInternalEnvelopeRow({ internal_test: true, sender_email: 'ext@example.com' }, []), true);
  assert.equal(isInternalEnvelopeRow({ internal_test: false, sender_email: 'redteam-pilot@kysigned.com' }, RULES), true);
  assert.equal(isInternalEnvelopeRow({ internal_test: false, sender_email: 'ext@example.com' }, RULES), false);
  assert.equal(isInternalEnvelopeRow({ sender_email: null }, RULES), false);
});

// ── envelope lookup form (one SELECT; fail-open) ─────────────────────────────

test('envelope: a provided row classifies WITHOUT any pool query', async () => {
  const { log } = collector();
  let queried = 0;
  const pool = { query: async () => ((queried += 1), { rows: [] }) };
  const gate = createInternalSubjectGate({ pool, internalIdentities: RULES, log });
  assert.equal(await gate.envelope('env-1', { internal_test: true, sender_email: null }), true);
  assert.equal(await gate.envelope('env-2', { internal_test: false, sender_email: 'ext@example.com' }), false);
  assert.equal(queried, 0);
});

test('envelope: no row provided → one SELECT classifies by internal_test/sender_email', async () => {
  const { log } = collector();
  const gate = createInternalSubjectGate({
    pool: poolReturning([{ internal_test: false, sender_email: 'redteam-pilot@kysigned.com' }]),
    internalIdentities: RULES,
    log,
  });
  assert.equal(await gate.envelope('env-3'), true);

  const external = createInternalSubjectGate({
    pool: poolReturning([{ internal_test: false, sender_email: 'ext@example.com' }]),
    internalIdentities: RULES,
    log,
  });
  assert.equal(await external.envelope('env-4'), false);
});

test('envelope: unknown envelope (no row) fails open to external', async () => {
  const { log, lines } = collector();
  const gate = createInternalSubjectGate({ pool: poolReturning([]), internalIdentities: RULES, log });
  assert.equal(await gate.envelope('env-missing'), false);
  assert.equal(lines.length, 0); // absent row is a normal outcome, not a failure
});

test('envelope: a THROWING lookup fails OPEN (external) and logs the failure — AC-213', async () => {
  const { log, lines } = collector();
  const gate = createInternalSubjectGate({
    pool: { query: async () => { throw new Error('db down'); } },
    internalIdentities: RULES,
    log,
  });
  assert.equal(await gate.envelope('env-5'), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /internal-classification/);
  assert.match(lines[0]!, /env-5/);
  assert.match(lines[0]!, /db down/);
});

test('envelope: no pool and no row fails OPEN (external) without throwing', async () => {
  const { log } = collector();
  const gate: InternalSubjectGate = createInternalSubjectGate({ internalIdentities: RULES, log });
  assert.equal(await gate.envelope('env-6'), false);
});

// ── the suppression log line (uniform across all sites) ──────────────────────

test('logSuppressed writes the one seam-discipline line: type, colon-joined subject, reason', () => {
  const { log, lines } = collector();
  const gate = createInternalSubjectGate({ internalIdentities: RULES, log });
  gate.logSuppressed('creator_signed_up', ['ledger-1']);
  gate.logSuppressed('envelope_completed', ['env-7', 'sig-2']);
  assert.deepEqual(lines, [
    'app-event creator_signed_up [ledger-1] suppressed: internal identity',
    'app-event envelope_completed [env-7:sig-2] suppressed: internal identity',
  ]);
});
