export {
  requestMagicLink,
  exchangeMagicLinkToken,
  refreshAccessToken,
  fetchRun402User,
} from './dashboardAuth.js';
export type {
  RequestMagicLinkOpts,
  RequestMagicLinkResult,
  ExchangeMagicLinkOpts,
  ExchangeMagicLinkResult,
  RefreshAccessTokenOpts,
  RefreshAccessTokenResult,
  FetchRun402UserOpts,
  FetchRun402UserResult,
} from './dashboardAuth.js';

// Cookie session middleware (F-18.1 / DD-72) + the magic-link auth endpoints.
export {
  SESSION_COOKIE,
  CSRF_HEADER,
  buildSessionCookie,
  buildClearSessionCookie,
  csrfOk,
  startSession,
  resolveSession,
  endSession,
} from './session.js';
export type { SessionConfig, SessionActor, IssuedTokens } from './session.js';
export {
  handleAuthMagicLink,
  handleAuthTokenExchange,
  handleAuthUser,
  handleAuthSignout,
} from './authHandlers.js';
export type { AuthHandlerCtx, AuthResult } from './authHandlers.js';
