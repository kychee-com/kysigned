import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { READABLE_VERIFIER_PAGES, renderReadablePage } from './src/lib/readableVerifierPages'

// F-44.2 — the sample document the editor's "Try it with a sample document"
// button fetches same-origin as /samples/acme-anvil-waiver.pdf. The repo keeps
// ONE canonical copy (docs/test-assets); public/samples/ is gitignored and
// re-derived on every build/dev serve, so the served sample can never drift
// from the canonical asset. A missing or divergent copy throws — the build
// fails rather than shipping a broken sample button.
const SAMPLE_SRC = fileURLToPath(new URL('../docs/test-assets/acme-anvil-waiver.pdf', import.meta.url))
const SAMPLE_DEST_DIR = fileURLToPath(new URL('./public/samples', import.meta.url))
const SAMPLE_DEST = fileURLToPath(new URL('./public/samples/acme-anvil-waiver.pdf', import.meta.url))

function stageSampleDocument(): Plugin {
  return {
    name: 'kysigned-stage-sample-document',
    buildStart() {
      mkdirSync(SAMPLE_DEST_DIR, { recursive: true })
      copyFileSync(SAMPLE_SRC, SAMPLE_DEST)
      if (!readFileSync(SAMPLE_SRC).equals(readFileSync(SAMPLE_DEST))) {
        throw new Error(`sample document diverged after copy: ${SAMPLE_DEST}`)
      }
    },
  }
}

// F-47.3 (DD-80): verify.html and hashcheck.html, the built index.html with each
// page's title, description and explanatory copy inside the root. The static host
// serves /verify from verify.html, so a plain fetch (an agent, a crawler) reads real
// text, and React replaces the copy when the app mounts. renderReadablePage throws
// if the built shell changes shape, so the build fails rather than shipping a page
// without its copy.
function writeReadableVerifierPages(): Plugin {
  let outDir = 'dist'
  return {
    name: 'kysigned-readable-verifier-pages',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const indexHtml = readFileSync(join(outDir, 'index.html'), 'utf8')
      for (const page of READABLE_VERIFIER_PAGES) {
        writeFileSync(join(outDir, page.file), renderReadablePage(indexHtml, page))
      }
    },
  }
}

// `kysigned-verify` → the kysigned package's fully client-side bundle verifier
// (WebCrypto + DecompressionStream + pkijs; no mailauth/node deps). The /verify
// page imports it so verification runs entirely in the visitor's browser (AC-27).
export default defineConfig({
  plugins: [react(), tailwindcss(), stageSampleDocument(), writeReadableVerifierPages()],
  resolve: {
    alias: {
      'kysigned-verify': fileURLToPath(new URL('../dist/bundle/verifyWeb.js', import.meta.url)),
    },
  },
})
