import { fileURLToPath } from "node:url";
import path from "node:path";

import esbuild from "esbuild";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const KYSIGNED_RUN402_FUNCTIONS = [
  { name: "kysigned-api", entryPath: path.join(ROOT, "src/functions/api.ts") },
];

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
  const result = await esbuild.build({
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    entryPoints: [fn.entryPath],
    write: false,
    external: KYSIGNED_RUN402_DEPS.map(packageName),
    legalComments: "none",
    logLevel: "warning",
  });
  return result.outputFiles[0].text;
}
