/**
 * Vitest config — frontend unit + component tests (2F.AUTH7+).
 *
 * Uses jsdom so React Testing Library can render components against a DOM.
 * `globals: true` brings vitest's describe/it/expect into scope without imports.
 * The setupFiles registers jest-dom's matchers (toBeInTheDocument, etc.).
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'kysigned-verify': fileURLToPath(new URL('../dist/bundle/verifyWeb.js', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
