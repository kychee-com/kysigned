import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Off deliberately (2026-07-19): every hit in this codebase is the
      // standard "kick off an async load on mount + flip a busy flag" pattern
      // (auth hydrate, envelope fetch, pdf preview, verify-on-restore). The
      // rule targets derived-state cascades; refactoring 11 working
      // data-loading effects in signing/verification pages to appease it is
      // behavior-drift risk for zero user value. Revisit if we adopt a query
      // library that owns these effects.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
])
