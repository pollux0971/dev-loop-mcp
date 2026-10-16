import { defineConfig } from 'vitest/config';

// Tests of the gate scripts (`scripts/check-*.ts`) themselves. They get a separate config from
// `vitest.config.ts` (which tests packages/apps): the gate script tests spawn a child process
// that runs `npx tsx`, and a single case easily takes one to three seconds. Mixing them into the
// default include of the main test suite would slow down every `npm test`, and the gate scripts
// do not belong under packages/** or apps/** anyway. Only `npm run test:scripts` uses this config.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    passWithNoTests: true,
    include: ['scripts/**/*.test.ts'],
  },
});
