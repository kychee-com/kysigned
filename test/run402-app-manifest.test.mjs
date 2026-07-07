import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readManifest() {
  return JSON.parse(readFileSync(join(ROOT, "run402.json"), "utf8"));
}

describe("Run402 app manifest", () => {
  it("declares the clone-to-up contract for the durable Kysigned app", () => {
    const manifest = readManifest();

    assert.equal(manifest.$schema, "https://run402.com/schemas/run402-app.v1.schema.json");
    assert.equal(manifest.spec_version, 1);
    assert.equal(manifest.project.name, "${input.name}");
    assert.deepEqual(manifest.release.subdomains.set, ["${input.name}"]);
    assert.deepEqual(
      manifest.build.commands.map((command) => command.id),
      ["install-root", "install-frontend", "build"],
    );
    assert.deepEqual(
      Object.keys(manifest.resources.mailboxes).sort(),
      ["forward_to_sign", "info", "notifications"],
    );
    assert.equal(manifest.resources.mailboxes.forward_to_sign.slug, "forward-to-sign");
    assert.equal(manifest.resources.mailboxes.notifications.slug, "notifications");
    assert.deepEqual(manifest.resources.mailboxes.notifications.roles, ["default_outbound", "auth_sender"]);
    assert.equal(manifest.resources.mailboxes.info.slug, "info");
    assert.equal(manifest.resources.webhooks, undefined);
  });

  it("wires email-trigger durable runs instead of webhook or cron resources", () => {
    const manifest = readManifest();
    const fn = manifest.release.functions.replace["kysigned-api"];
    const apiRoute = manifest.release.routes.replace.find((route) => route.pattern === "/v1/*");

    assert.equal(manifest.release.functions.replace.api, undefined);
    assert.equal(apiRoute?.target.name, "kysigned-api");
    assert.deepEqual(
      fn.triggers.map((trigger) => trigger.type),
      ["email", "email"],
    );
    assert.deepEqual(
      fn.triggers.map((trigger) => trigger.mailbox),
      ["${RUN402_MAILBOX_FORWARD_TO_SIGN_ID}", "${RUN402_MAILBOX_FORWARD_TO_SIGN_ID}"],
    );
    assert.deepEqual(
      fn.triggers.map((trigger) => trigger.run.event_type),
      ["reply_received", "bounced"],
    );
    assert.equal(
      fn.deps.some((dep) => dep.startsWith("@run402/functions")),
      false,
      "@run402/functions is injected by Run402 and must not be listed as an app dep",
    );
    assert.equal(JSON.stringify(manifest).includes("\"type\":\"schedule\""), false);
    assert.equal(JSON.stringify(manifest).includes("cron-"), false);
  });

  it("requires only the creator allowlist from the user and uses generated Run402 bindings for the rest", () => {
    const manifest = readManifest();

    assert.deepEqual(Object.keys(manifest.secrets), ["KYSIGNED_ALLOWED_CREATORS"]);
    assert.equal(manifest.secrets.KYSIGNED_ALLOWED_CREATORS.required, true);
    assert.equal(manifest.secrets.KYSIGNED_ALLOWED_CREATORS.source_env, "KYSIGNED_ALLOWED_CREATORS");
    assert.deepEqual(manifest.release.secrets.require.sort(), [
      "KYSIGNED_ALLOWED_CREATORS",
      "RUN402_ANON_KEY",
      "RUN402_API_BASE",
      "RUN402_API_BASE_URL",
      "RUN402_MAILBOX_FORWARD_TO_SIGN_ADDRESS",
      "RUN402_MAILBOX_FORWARD_TO_SIGN_ID",
      "RUN402_MAILBOX_NOTIFICATIONS_ADDRESS",
      "RUN402_MAILBOX_NOTIFICATIONS_ID",
      "RUN402_PROJECT_ID",
      "RUN402_PUBLIC_ORIGIN",
      "RUN402_SERVICE_KEY",
    ]);
    assert.equal(manifest.release.secrets.require.includes("KYSIGNED_BASE_URL"), false);
    assert.equal(manifest.release.secrets.require.includes("KYSIGNED_OPERATOR_DOMAIN"), false);
    assert.equal(manifest.release.secrets.require.includes("KYSIGNED_SIGNING_MAILBOX_ID"), false);
    assert.equal(manifest.release.secrets.require.includes("KYSIGNED_NOTIFICATION_MAILBOX_ID"), false);
  });

  it("publishes generic static info pages and aliases extensionless marketing URLs", () => {
    const manifest = readManifest();
    const routes = manifest.release.routes.replace;
    const byPattern = new Map(routes.map((route) => [route.pattern, route]));

    assert.equal(existsSync(join(ROOT, "frontend", "public", "faq.html")), true);
    assert.equal(existsSync(join(ROOT, "frontend", "public", "how-it-works.html")), true);
    assert.deepEqual(byPattern.get("/faq")?.methods, ["GET", "HEAD"]);
    assert.deepEqual(byPattern.get("/faq")?.target, { type: "static", file: "faq.html" });
    assert.deepEqual(byPattern.get("/how-it-works")?.target, { type: "static", file: "how-it-works.html" });
    assert.equal(
      manifest.verify.http.some((check) => check.path === "/faq.html" && check.expect.status === 200),
      true,
    );
  });

  // GH#103 / F-14.10 / F-17.7: the public repo ships ZERO operator-specifics —
  // no pricing page, no /pricing route, no pricing smoke check. kysigned.com
  // re-adds pricing via its private overrides; a fresh fork has none.
  it("ships no pricing page, route, or smoke check (public is operator-free)", () => {
    const manifest = readManifest();
    const routes = manifest.release.routes.replace;

    assert.equal(existsSync(join(ROOT, "frontend", "public", "pricing.html")), false);
    assert.equal(routes.some((route) => route.pattern === "/pricing"), false);
    assert.equal(
      manifest.verify.http.some((check) => check.path === "/pricing.html"),
      false,
    );
  });
});
