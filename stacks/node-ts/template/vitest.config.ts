import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Aligned with the paths in tsconfig.json, so vitest can also resolve @contracts/* and @core/*
    // (tsx supports tsconfig paths natively when running, but vitest does not read them automatically, so set them separately).
    alias: {
      '@contracts': fileURLToPath(new URL('./packages/contracts/src', import.meta.url)),
      '@core': fileURLToPath(new URL('./packages/core/src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Line coverage is only a passing mark. Real quality is decided by mutation testing, see
      // .claude/skills/mutation-testing/SKILL.md
      thresholds: { lines: 70, functions: 70 },
    },
  },
});
