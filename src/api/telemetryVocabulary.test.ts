/**
 * telemetryVocabulary.test.ts — the two-sided browser vocabulary lock (FC30.3,
 * AC-264).
 *
 * F-44.4: both create-page affordance names are part of the browser vocabulary
 * END-TO-END, because "an event name added on only one side is exactly the
 * silent defect this clause exists to prevent." The collection endpoint answers
 * 204 unconditionally (F-38.2 — collection never surfaces an error to a
 * visitor), so a name the server does not know is dropped SILENTLY: nothing on
 * the wire, nothing in the logs, nothing in the table.
 *
 * Until this test existed that invariant was guaranteed only by a live probe
 * leg running at publish time — which is why system-test cycle 30 could
 * plausibly (if wrongly) allege one-sided drift and nobody could refute it
 * without a deployed round trip. Now a name added on one side fails here, in
 * seconds, with the offender named.
 *
 * This test lives in the BACKEND suite, where `BROWSER_EVENTS` lives, and
 * imports the client list — so the two sides are compared in exactly one place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_TELEMETRY_EVENTS } from '../../frontend/src/lib/telemetryEvents.js';
import { BROWSER_EVENTS, SERVER_EVENTS } from './telemetry.js';

const client: readonly string[] = CLIENT_TELEMETRY_EVENTS;

test('every event the client rail may emit is accepted by the server (client ⊆ BROWSER_EVENTS)', () => {
  const unknownToServer = client.filter((e) => !BROWSER_EVENTS.has(e));
  assert.deepEqual(
    unknownToServer,
    [],
    `client-only telemetry event(s) ${JSON.stringify(unknownToServer)} — the browser fires them and the ` +
      `collection endpoint drops them SILENTLY (it always answers 204). Add them to BROWSER_EVENTS in ` +
      `src/api/telemetry.ts, with a validElement rule.`,
  );
});

test('every event the server accepts from a browser can actually be emitted (BROWSER_EVENTS ⊆ client)', () => {
  const unclaimedByClient = [...BROWSER_EVENTS].filter((e) => !client.includes(e));
  assert.deepEqual(
    unclaimedByClient,
    [],
    `server-only browser event(s) ${JSON.stringify(unclaimedByClient)} — the allowlist accepts a name no ` +
      `browser can send. Either add it to CLIENT_TELEMETRY_EVENTS in frontend/src/lib/telemetryEvents.ts ` +
      `(if the client half is missing) or drop it from BROWSER_EVENTS (if it is dead vocabulary).`,
  );
});

test('no browser event collides with a SERVER-recorded funnel step (F-38.4)', () => {
  const forged = client.filter((e) => SERVER_EVENTS.has(e));
  assert.deepEqual(
    forged,
    [],
    `${JSON.stringify(forged)} is a server-recorded funnel step — a browser may never fabricate a funnel ` +
      `bottom (F-38.4). Rename the client event.`,
  );
});

test('the client vocabulary is a clean list: unique, non-empty, and shaped like an event name', () => {
  assert.equal(new Set(client).size, client.length, 'duplicate name in CLIENT_TELEMETRY_EVENTS');
  for (const e of client) assert.match(e, /^[a-z][a-z0-9_]{2,39}$/, `malformed telemetry event name: ${e}`);
});

test('the F-44.4 affordance facts are present on BOTH sides (the names cycle 30 filed on)', () => {
  for (const e of ['sample_doc_clicked', 'cover_details_expanded']) {
    assert.ok(client.includes(e), `${e} missing from the client vocabulary`);
    assert.ok(BROWSER_EVENTS.has(e), `${e} missing from the server vocabulary`);
  }
});
