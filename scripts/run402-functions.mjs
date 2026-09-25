import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import esbuild from "esbuild";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const KYSIGNED_RUN402_FUNCTIONS = [
  { name: "kysigned-api", entryPath: path.join(ROOT, "src/functions/api.ts") },
  // F-46 (#164): the agent front door (/mcp, the discovery documents, the
  // negotiated pages). Its code and dependencies live in mcp/, and it is bundled
  // whole: no runtime deps, so `npm ci --prefix mcp` must have run first.
  { name: "kysigned-agent", entryPath: path.join(ROOT, "mcp/src/webFunction.ts"), bundleAll: true },
];

/** The mcp package version, inlined into the agent bundle (its version.ts reads package.json at run time). */
export function mcpPackageVersion() {
  return JSON.parse(readFileSync(path.join(ROOT, "mcp", "package.json"), "utf8")).version;
}

export const KYSIGNED_RUN402_DEPS = [
  "@run402/functions",
  "@run402/sdk@^3.7.9",
  "@noble/hashes@^2.2.0",
  "@pdf-lib/fontkit@^1.1.1",
  "crypto-js@^4.2.0",
  "mailauth@^4.13.3",
  "pdf-lib@^1.17.1",
  "pg@^8.20.0",
  "pkijs@^3.4.0",
  "qrcode@^1.5.4",
];

function packageName(spec) {
  if (spec.startsWith("@")) {
    const at = spec.indexOf("@", 1);
    return at === -1 ? spec : spec.slice(0, at);
  }
  const at = spec.indexOf("@");
  return at === -1 ? spec : spec.slice(0, at);
}

/** Bundle one Run402 function to a single-file ESM JS string. */
export async function bundleRun402Function(fn) {
  if (fn.bundleAll && !existsSync(path.join(ROOT, "mcp", "node_modules"))) {
    throw new Error(`${fn.name} bundles from mcp/: run \`npm ci --prefix mcp\` first`);
  }
  const result = await esbuild.build({
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    entryPoints: [fn.entryPath],
    write: false,
    external: fn.bundleAll ? [] : KYSIGNED_RUN402_DEPS.map(packageName),
    define: fn.bundleAll ? { __KYSIGNED_MCP_VERSION__: JSON.stringify(mcpPackageVersion()) } : undefined,
    // Bundled CommonJS dependencies may call require(); give the ESM output one.
    banner: fn.bundleAll ? { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' } : undefined,
    legalComments: "none",
    logLevel: "warning",
  });
  return result.outputFiles[0].text;
}
