import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { agentRoutes } from "../scripts/lib/agentRoutes.mjs";
import { TEMPLATE_AGENT_PAGES } from "../scripts/lib/agentPages.mjs";

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
      ["install-root", "install-frontend", "install-mcp", "build"],
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

  it("publishes generic info pages, served (with their markdown twins) by the agent function (F-46)", () => {
    const manifest = readManifest();
    const routes = manifest.release.routes.replace;
    const byPattern = new Map(routes.map((route) => [route.pattern, route]));

    assert.equal(existsSync(join(ROOT, "frontend", "public", "faq.html")), true);
    assert.equal(existsSync(join(ROOT, "frontend", "public", "how-it-works.html")), true);
    assert.deepEqual(byPattern.get("/faq")?.methods, ["GET", "HEAD"]);
    assert.deepEqual(byPattern.get("/faq")?.target, { type: "function", name: "kysigned-agent" });
    assert.deepEqual(byPattern.get("/how-it-works")?.target, { type: "function", name: "kysigned-agent" });
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

  // F-46 (spec 0.74.0, #164): the agent front door ships on `run402 up` too.
  it("declares the kysigned-agent function and the same agent route table as the SDK deploy", () => {
    const manifest = readManifest();
    const agent = manifest.release.functions.replace["kysigned-agent"];
    assert.equal(agent.runtime, "node22");
    assert.deepEqual(agent.source, { path: "dist/run402/cloud-functions/kysigned-agent.js" });
    assert.equal(agent.deps, undefined, "bundled whole: no runtime deps");
    assert.equal(agent.triggers, undefined);
    const routes = manifest.release.routes.replace;
    for (const want of agentRoutes(TEMPLATE_AGENT_PAGES)) {
      assert.deepEqual(routes.find((r) => r.pattern === want.pattern), want, want.pattern);
    }
    const agentPatterns = new Set(agentRoutes(TEMPLATE_AGENT_PAGES).map((r) => r.pattern));
    for (const r of routes) {
      if (r.target.name === "kysigned-agent") assert.ok(agentPatterns.has(r.pattern), `${r.pattern} is not in the shared table`);
    }
    assert.equal(routes[routes.length - 1].pattern, "/v1/*", "the api catch-all stays last");
    assert.deepEqual(manifest.build.commands.find((c) => c.id === "install-mcp")?.argv, ["npm", "ci", "--prefix", "mcp"]);
  });

  it("the cloud build stages the agent copies and markdown twins into frontend/dist", () => {
    const build = readFileSync(join(ROOT, "scripts", "build-run402-cloud.mjs"), "utf8");
    assert.match(build, /import \{[^}]*stageAgentPages[^}]*\} from "\.\/lib\/agentPages\.mjs"/);
    assert.match(build, /stageAgentPages\(path\.join\(ROOT, "frontend", "dist"\), TEMPLATE_AGENT_PAGES\)/);
  });
});
