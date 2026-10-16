import { defineConfig } from 'vitest/config';

// 守門腳本(`scripts/check-*.ts`)自己的測試,跟 `vitest.config.ts`(測 packages/apps)
// 分開一份設定:守門腳本的測試會起子行程跑 `npx tsx`,單一案例動輒一到三秒,
// 混進主測試套件的預設 include 會拖慢每次 `npm test`,而且守門腳本本來就不屬於
// packages/**、apps/** 底下——`npm run test:scripts` 才會用到這份設定。
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    passWithNoTests: true,
    include: ['scripts/**/*.test.ts'],
  },
});
