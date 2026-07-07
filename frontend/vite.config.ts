import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// `kysigned-verify` → the kysigned package's fully client-side bundle verifier
// (WebCrypto + DecompressionStream + pkijs; no mailauth/node deps). The /verify
// page imports it so verification runs entirely in the visitor's browser (AC-27).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      'kysigned-verify': fileURLToPath(new URL('../dist/bundle/verifyWeb.js', import.meta.url)),
    },
  },
})
