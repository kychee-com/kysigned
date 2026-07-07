/**
 * authConfig.ts — forker auth-config derivation helpers (2F.AUTH6, F2.1.12).
 *
 * Pure derivation functions from a deployment's host to:
 *   - `cookieDomain` — the cookie `Domain` attribute. Leading dot ONLY when
 *     the operator owns the registrable apex; host-scoped otherwise
 *     (critical for tenant-on-shared-apex shapes like *.run402.com — a
 *     `.run402.com` cookie would leak between tenants).
 *   - `webauthnRpId` — the WebAuthn relying-party identifier. Always a
 *     hostname (no leading dot — WebAuthn forbids it).
 *
 * No I/O. The Lambda picks env-var overrides; these helpers compute defaults
 * from the operator's deployed host (`spaDomain` or `operatorDomain` — same
 * under DD-73 single-origin).
 */

/**
 * Apex domains that are SHARED across multiple tenants. Hosts ending in one
 * of these (with at least one tenant label) MUST stay host-scoped so cookies
 * don't leak across tenants.
 *
 * Add new shared-apex hosts here as additional run402-like platforms appear.
 */
const SHARED_TENANT_APEXES = ['run402.com'];

function isSharedTenantApex(host: string): boolean {
  return SHARED_TENANT_APEXES.some(
    (apex) => host === apex || host.endsWith(`.${apex}`),
  );
}

/**
 * Derive the cookie `Domain` attribute from a hostname.
 *
 * Rules:
 *   - hostname is the shared-tenant apex itself (run402.com) → host-scoped
 *   - hostname is a tenant subdomain of a shared apex (foo.run402.com) → host-scoped
 *   - hostname has ≥3 labels and is NOT under a shared apex → strip leftmost
 *     label and prefix with `.` (e.g. app.example.com → .example.com)
 *   - hostname has ≤2 labels → host-scoped
 */
export function deriveCookieDomain(host: string): string {
  const lower = host.toLowerCase();
  if (isSharedTenantApex(lower)) return lower;
  const labels = lower.split('.');
  if (labels.length >= 3) {
    return `.${labels.slice(1).join('.')}`;
  }
  return lower;
}

/**
 * Derive the WebAuthn RP ID from a hostname.
 *
 * Rules:
 *   - shared-tenant subdomain (foo.run402.com) → return host as-is (the
 *     operator's effective control scope IS the full host)
 *   - ≥3 labels and not under a shared apex → return the registrable apex
 *     (e.g. app.example.com → example.com)
 *   - ≤2 labels → return host as-is
 *
 * Never includes a leading dot (WebAuthn rejects `.example.com`).
 */
export function deriveWebauthnRpId(host: string): string {
  const lower = host.toLowerCase();
  if (isSharedTenantApex(lower)) return lower;
  const labels = lower.split('.');
  if (labels.length >= 3) {
    return labels.slice(1).join('.');
  }
  return lower;
}
