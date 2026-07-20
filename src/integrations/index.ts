// run402 integration adapters (F-17.5 / Phase 14) — bridge kysigned's seams
// (EmailProvider, fetchRawMime) to the @run402/sdk surface. Structurally typed,
// so the core library carries no SDK runtime dependency; the real client is
// injected at the run402-function entry.
export * from './run402Email.js';
export * from './run402Db.js';
export * from './run402Http.js';
export * from './run402Router.js';
export * from './appEvents.js';
export * from './internalSubject.js';
