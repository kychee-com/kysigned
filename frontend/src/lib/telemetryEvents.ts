/**
 * telemetryEvents — the browser rail's emittable vocabulary (F-38.4, F-44.4).
 *
 * The ONE list of event names a browser may put on the wire, kept in a
 * standalone module with NO imports so BOTH sides can read it: the SPA rail
 * (`telemetry.ts`) types its public emit helpers against it, and the SERVER's
 * unit suite imports it to hold `BROWSER_EVENTS` and this list to each other
 * (`src/api/telemetryVocabulary.test.ts`).
 *
 * Why this exists (FC30.3): F-44.4 says both create-page affordance names are
 * part of the browser vocabulary END-TO-END, because "an event name added on
 * only one side is exactly the silent defect this clause exists to prevent" —
 * the collection endpoint always answers 204, so a name the server does not
 * know is dropped SILENTLY. That invariant used to be guaranteed only by a live
 * probe leg at publish time, which is why cycle 30 could allege one-sided drift
 * and nobody could refute it without a deployed round trip. Now a name added on
 * one side fails a unit test in seconds.
 *
 * Adding an event = add it HERE, add it to the server's `BROWSER_EVENTS` (and
 * give it an `validElement` rule), in the same change. Server-recorded funnel
 * steps (`SERVER_EVENTS`) may NEVER appear in this list — a browser may not
 * fabricate a funnel bottom (F-38.4).
 */
export const CLIENT_TELEMETRY_EVENTS = [
  // F-38.2 — the rail's own automatic facts.
  'page_view',
  'click',
  'scroll',
  // F-38.3 / AC-230 — the sign-in gate.
  'signin_prompt',
  'signin_email_focus',
  'signin_submit',
  // F-41.5 — the gate's Continue-with-Google click.
  'signin_google',
  // F-39.5 (DD-52) — the hand-fired guest-editor steps.
  'draft_started',
  'send_clicked',
  // F-44.4 (DD-67) — the create-page affordance facts.
  'sample_doc_clicked',
  'cover_details_expanded',
] as const;

/** Any name the browser rail is allowed to emit. */
export type ClientTelemetryEvent = (typeof CLIENT_TELEMETRY_EVENTS)[number];
