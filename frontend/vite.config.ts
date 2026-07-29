import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'

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

// `kysigned-verify` → the kysigned package's fully client-side bundle verifier
// (WebCrypto + DecompressionStream + pkijs; no mailauth/node deps). The /verify
// page imports it so verification runs entirely in the visitor's browser (AC-27).
export default defineConfig({
  plugins: [react(), tailwindcss(), stageSampleDocument()],
  resolve: {
    alias: {
      'kysigned-verify': fileURLToPath(new URL('../dist/bundle/verifyWeb.js', import.meta.url)),
    },
  },
})
