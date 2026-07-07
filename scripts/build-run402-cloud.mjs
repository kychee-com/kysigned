#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { KYSIGNED_RUN402_FUNCTIONS, ROOT, bundleRun402Function } from "./run402-functions.mjs";

export const CLOUD_FUNCTION_OUT_DIR = path.join(ROOT, "dist", "run402", "cloud-functions");

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  });
}

async function main() {
  console.log("Building root TypeScript artifacts...");
  run("npm", ["run", "build"]);

  console.log("Building frontend for same-origin Run402 routes...");
  run("npm", ["run", "build"], {
    cwd: path.join(ROOT, "frontend"),
    env: {
      VITE_BASE: "/",
      VITE_API_BASE: "",
    },
  });

  console.log(`Bundling ${KYSIGNED_RUN402_FUNCTIONS.length} Run402 Cloud function...`);
  await mkdir(CLOUD_FUNCTION_OUT_DIR, { recursive: true });
  for (const fn of KYSIGNED_RUN402_FUNCTIONS) {
    const source = await bundleRun402Function(fn);
    const outPath = path.join(CLOUD_FUNCTION_OUT_DIR, `${fn.name}.js`);
    await writeFile(outPath, source, "utf8");
    const sizeKiB = (Buffer.byteLength(source) / 1024).toFixed(0);
    console.log(`  ${path.relative(ROOT, outPath)} - ${sizeKiB} KiB`);
  }

  console.log("Cloud build complete. Deploy with: run402 up --name <project>");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
