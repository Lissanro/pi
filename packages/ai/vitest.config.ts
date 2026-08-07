import { defaultExclude, defineConfig } from 'vitest/config';

// Cloud e2e tests (*-e2e.test.ts) hit real provider APIs and activate on
// endpoint/auth env vars. They are excluded by default so stray API keys in
// the environment can never activate cloud tests; set PI_E2E_TESTS=1 to run
// them explicitly.
const e2eExclude = process.env.PI_E2E_TESTS === '1' ? [] : ['test/**/*-e2e.test.ts'];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for API calls
    reporters: process.env.GITHUB_ACTIONS ? ['dot', 'github-actions'] : ['dot'],
    silent: 'passed-only',
    exclude: [...defaultExclude, ...e2eExclude],
    setupFiles: ['test/setup-e2e-guard.ts'],
  }
});
