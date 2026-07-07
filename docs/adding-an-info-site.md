# Adding an information site to your kysigned instance

When you deploy kysigned, you get the **app**: a dashboard, the signing pages, the `/hashcheck` and `/verify` tools, and the signing API — all served from one origin (one domain). What you don't get out of the box is a public front door — if someone browses to your domain's root, kysigned sends them to the sign-in screen (`/` redirects to `/dashboard`).

That's fine for a tool your users already know about. But if you want a public landing page that explains what your service is — for visitors who land on your domain before they have an account — you'll want to layer an **information site** alongside the app on the **same domain**.

> This is **your** site, not kysigned's. The kysigned repo ships the app only; the marketing/info pages for the hosted service at kysigned.com live in a private repo and are intentionally not part of the fork. You build the front door you want.

## The deployment model: one project, one domain

By design (DD-73), kysigned deploys as **one run402 project** serving the SPA + the API + any marketing static files from a **single origin**. This is mandatory for cookie-based session auth (introduced in v0.22.0): the run402 platform's gateway CORS sets `Access-Control-Allow-Origin: *` with no `Access-Control-Allow-Credentials: true`, which the CORS spec forbids combining with `credentials:'include'`. The only way cookies work is same-origin.

So your deployment is:

```
yourbrand.com         → ONE run402 project serving:
yourbrand.com/        → marketing splash (your info-site index)
yourbrand.com/about   → another marketing page (optional)
yourbrand.com/pricing → marketing pricing page (optional)
yourbrand.com/dashboard, /verify, /sign/*, /review/*  → the SPA (spa_fallback)
yourbrand.com/v1/*    → the signing API
```

One project. One custom hostname binding. No CORS to configure. No two-subdomain juggling.

## How the routing works

run402's apply spec lets you put marketing static files and the SPA bundle in the same project. The gateway resolves paths in this order:

1. **Exact static-file match** — e.g. `yourbrand.com/about.html` serves `dist-site/about.html`.
2. **Function route match** — e.g. `yourbrand.com/v1/auth/user` routes to your kysigned-api Lambda.
3. **Static-alias route** — if you've explicitly mapped `/` → `marketing-home.html`, that alias serves.
4. **spa_fallback** — anything else (e.g. `/dashboard`, `/account/passkeys`) falls through to the SPA's `index.html`, where React Router takes over.

You only need to handle conflicts where a path could match both a static file AND a SPA route (e.g. both `index.html` and the SPA's `index.html` want to be at `/`). The kysigned reference deploy script shows the pattern: rename the marketing landing during staging, then use a static-alias route to map `/` to the renamed file. SPA paths fall through naturally.

## Steps for a forker

1. **Drop your marketing files into the same project.** If you're using the kysigned reference deploy script as a base, copy your `info-site/` directory into the deploy staging step (model on how `stageMarketingSite()` works). If you're using a custom deploy, just include your marketing static files in your apply spec's `site.replace` alongside the SPA bundle.

2. **Decide how `/` resolves.** Two simple options:
   - **Marketing landing at `/`** — rename your marketing landing to `marketing-home.html` (or any name that won't collide with the SPA's `/index.html`), add a static-alias route `{ pattern: '/', methods: ['GET', 'HEAD'], target: { type: 'static', file: 'marketing-home.html' } }`. SPA serves at every other unmatched path via spa_fallback.
   - **SPA at `/`** — let the SPA's `/index.html` serve at `/` directly (the default). Marketing pages live at explicit URLs like `/welcome.html` or `/about.html`. Simpler but `/` shows the sign-in screen.

3. **No operator-config change needed.** Under DD-73, the SPA, the API, and your marketing pages all share one origin (`yourbrand.com`). The SPA's `fetch('/v1/...')` calls land on the same origin same-origin — cookie auth, marketing nav state, sign-out from any page, all Just Work. The previous v0.18.x guidance to set `spaDomain` separately from `operatorDomain` is no longer needed; they're the same value.

4. **Link from your info site to the app.** Your "Sign in" / "Create an envelope" buttons point at `/dashboard` (relative — same origin). Example:

   ```html
   <a href="/dashboard">Sign in →</a>
   <a href="/dashboard/create">Create an envelope →</a>
   ```

   For the "Create an envelope" CTA, if you want unauthenticated visitors to hit the sign-in screen first, link to `/?intent=create` and let the SPA's `<RequireAuth/>` route wrapper bounce them through sign-in before landing on `/dashboard/create`.

## A minimal starter page

Drop this in your project as `marketing-home.html` (so it doesn't collide with the SPA's `index.html`), wire up the static-alias route for `/`, and replace the copy with your own. It uses no framework — just HTML and inline CSS.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YourBrand — secure document signing</title>
  <style>
    body { font-family: system-ui, sans-serif; color: #1a1a2e; max-width: 640px;
           margin: 0 auto; padding: 80px 24px; text-align: center; line-height: 1.6; }
    h1 { font-size: 40px; margin-bottom: 16px; }
    p { font-size: 18px; color: #555; }
    .cta { display: inline-block; margin-top: 24px; background: #1a1a2e; color: #fff;
           padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Sign documents. The proof lives in your inbox.</h1>
  <p>YourBrand collects signatures by email and records a permanent, independently
     verifiable proof for every one. No accounts for signers, no vendor lock-in.</p>
  <a class="cta" href="/dashboard">Sign in →</a>
</body>
</html>
```

## Marketing nav signed-in awareness (optional)

The SPA already handles "Signed in as X" / "Sign out" in its own header. But if you want your marketing pages (the static HTML ones, not SPA routes) to also reflect signed-in state — e.g. show "Sign in" when logged out, "{email} ▾" when logged in — you can read the same `kysigned_session_display` cookie the SPA uses:

```html
<script>
  // kysigned sets this cookie on sign-in; clears it on sign-out.
  // Same-origin, so available via document.cookie.
  function getSession() {
    const match = document.cookie.match(/(?:^|; )kysigned_session_display=([^;]+)/);
    if (!match) return null;
    try {
      const payload = JSON.parse(decodeURIComponent(atob(decodeURIComponent(match[1])
        .replace(/-/g, '+').replace(/_/g, '/'))));
      if (payload.v !== 1) return null;          // forward-compat
      if (payload.exp && payload.exp * 1000 < Date.now()) return null; // expired
      return payload;
    } catch { return null; }
  }
  const s = getSession();
  document.getElementById('nav-auth').innerHTML = s
    ? `<span>${s.email}</span> <a href="javascript:fetch('/v1/auth/signout',{method:'POST',credentials:'include',headers:{'X-Kysigned-Csrf':'1'}}).then(()=>location.reload())">Sign out</a>`
    : `<a href="/?intent=signin">Sign in</a>`;
</script>
<nav>...<span id="nav-auth"></span></nav>
```

Same origin = same cookies, so no API calls or cross-origin gymnastics needed.

## Auth config (cookieDomain + webauthnRpId)

Under DD-73 you almost never need to touch these. The defaults are derived from your deployment's hostname via the `deriveCookieDomain` / `deriveWebauthnRpId` helpers (in `kysigned/src/config/authConfig.ts`) and Just Work for the three operator shapes we've seen in the wild:

| Your shape | Deployed hostname | `cookieDomain` (auto) | `webauthnRpId` (auto) |
|---|---|---|---|
| Single-host on your apex (Kychee's `kysigned.com`) | `kysigned.com` | `kysigned.com` | `kysigned.com` |
| Single-host on a subdomain of your own apex | `signed.lawfirmxx.com` | `.lawfirmxx.com` | `lawfirmxx.com` |
| Tenant on a shared apex (e.g. run402 subdomain) | `lawfirmxx-signed.run402.com` | `lawfirmxx-signed.run402.com` | `lawfirmxx-signed.run402.com` |

The key distinction: the leading dot on `cookieDomain` is only emitted when you own the registrable apex. For tenant-on-shared-apex shapes (anything under `*.run402.com`), the cookie stays host-scoped so it can't leak across tenants. The `webauthnRpId` never has a leading dot (WebAuthn rejects it) and never widens past the host you control.

Override only if your defaults don't match what you actually serve from:

- `KYSIGNED_COOKIE_DOMAIN` — set explicitly if the derivation lands on the wrong scope. Be careful: setting this to a domain you don't fully control means another site on that apex could clear your cookies or set spoofed display cookies.
- `KYSIGNED_WEBAUTHN_RP_ID` — set explicitly if you serve the SPA from a different host than what your WebAuthn relying party should claim. `run402`'s gateway also enforces a `validateWebAuthnAppOrigin` check, so a mismatched rpId here will reject the WebAuthn ceremony cleanly — surface misconfiguration is loud, not silent.

> **WARNING:** never set `webauthnRpId` to a domain you don't control. WebAuthn's security model binds credentials to the rpId; a mismatch is either rejected by the platform or — worse — silently binds credentials to the wrong relying party.

## What changed from older guidance

If you read an earlier version of this doc (pre-v0.22.1), it described a two-host pattern with the SPA on `app.yoursite.com` and marketing on the apex `yoursite.com`. That pattern is **superseded by DD-73** and no longer works for cookie-based auth on run402. The single-project same-origin pattern above is the only supported deployment shape going forward; Kychee's own `kysigned.com` deployment runs this way too.

If you're migrating from a two-host deployment: collapse to one project, delete the SPA-only run402 project + its Custom Hostname, retire the `app.<yourdomain>` subdomain, and redeploy with the SPA bundled into your marketing project. The SPA's URLs all stay the same minus the `app.` prefix (`app.yourbrand.com/dashboard` → `yourbrand.com/dashboard`).

## What stays cryptographically identical

However you host the front door, the signing guarantees don't change — your instance produces the same self-verifying evidence bundles (the signer's provider-DKIM-signed emails sealed into one PDF), verifiable the same way as any other kysigned deployment, with no dependency on your instance staying online. The info site is presentation only; it has no bearing on the trust model. See the technical how-it-works page for the full picture.
