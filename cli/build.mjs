// Build the published `kysigned` package (plan 83.1, DD-77): esbuild bundles the
// verifier core (../src/bundle) and every dependency it needs into self-contained
// ESM, so `npx kysigned` installs one package with nothing else to resolve. Two
// outputs: the library (dist/index.js, the whole verifier) and the command
// (dist/kysigned.mjs, which imports the library rather than carrying a second
// copy). Minified with names kept (ASN.1 and PDF code reads class names).
// Third-party license notices go to *.LEGAL.txt beside each output.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
// CommonJS dependencies inside an ESM bundle reach Node built-ins through `require`.
const REQUIRE_SHIM =
  "import { createRequire as __kysignedCreateRequire } from 'node:module'; const require = __kysignedCreateRequire(import.meta.url);";

rmSync(join(HERE, 'dist'), { recursive: true, force: true });
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  keepNames: true,
  legalComments: 'external',
  define: { __KYSIGNED_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
};
await build({
  ...common,
  entryPoints: [join(HERE, 'src', 'index.ts')],
  outfile: join(HERE, 'dist', 'index.js'),
  banner: { js: REQUIRE_SHIM },
});
await build({
  ...common,
  entryPoints: [join(HERE, 'src', 'cli.ts')],
  outfile: join(HERE, 'dist', 'kysigned.mjs'),
  external: ['./index.js'],
  banner: { js: '#!/usr/bin/env node' },
});
