import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const DRIVER = resolve(import.meta.dirname, 'mutate-with-lock.ts');
const LOCK_FILE = '.stryker.lock';
const DRIVER_TIMEOUT_MS = 5_000;

interface Fixture {
  root: string;
  lockPath: string;
  argsPath: string;
  fakePidPath: string;
  driverPath: string;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
}

interface DriverHandle {
  child: ChildProcess;
  result: Promise<ProcessResult>;
}

const FAKE_STRYKER = `#!/usr/bin/env node
const fs = require('node:fs');

const argsPath = process.env.MUTATE_TEST_ARGS_FILE;
const pidPath = process.env.MUTATE_TEST_PID_FILE;

if (process.env.MUTATE_TEST_MODE === 'hang') {
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1_000);
} else {
  fs.writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)), 'utf8');
  process.exit(Number(process.env.MUTATE_TEST_EXIT_CODE || '0'));
}
`;

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'mutate-with-lock-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }, null, 2) + '\n', 'utf8');
    execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });

    const binDir = join(root, 'bin');
    const localBinDir = join(root, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(localBinDir, { recursive: true });
    for (const target of [join(binDir, 'stryker'), join(localBinDir, 'stryker')]) {
      writeFileSync(target, FAKE_STRYKER, 'utf8');
      chmodSync(target, 0o755);
    }

    return {
      root,
      lockPath: join(root, LOCK_FILE),
      argsPath: join(root, 'received-args.json'),
      fakePidPath: join(root, 'fake-stryker.pid'),
      driverPath: DRIVER,
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function makeCommonJsConsumerFixture(): Fixture {
  const fixture = makeFixture();
  const driverPath = join(fixture.root, 'scripts', 'mutate-with-lock.ts');
  mkdirSync(join(fixture.root, 'scripts'), { recursive: true });
  copyFileSync(DRIVER, driverPath);
  return { ...fixture, driverPath };
}

function cleanupFixture(fixture: Fixture): void {
  if (existsSync(fixture.fakePidPath)) {
    const pid = Number(readFileSync(fixture.fakePidPath, 'utf8'));
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 假替身已經隨 wrapper 一起結束。
      }
    }
  }
  rmSync(fixture.root, { recursive: true, force: true });
}

function startDriver(fixture: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}): DriverHandle {
  const { NODE_OPTIONS: _nodeOptions, ...baseEnv } = process.env;
  const pathEntries = [
    join(fixture.root, 'node_modules', '.bin'),
    join(fixture.root, 'bin'),
    join(resolve(import.meta.dirname, '..'), 'node_modules', '.bin'),
    baseEnv.PATH,
  ].filter((entry): entry is string => Boolean(entry));
  const child = spawn('tsx', [fixture.driverPath, ...args], {
    cwd: fixture.root,
    env: {
      ...baseEnv,
      ...extraEnv,
      PATH: pathEntries.join(delimiter),
      MUTATE_TEST_ARGS_FILE: fixture.argsPath,
      MUTATE_TEST_PID_FILE: fixture.fakePidPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const result = new Promise<ProcessResult>((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, DRIVER_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ code, signal, stdout, stderr, output: stdout + stderr, timedOut });
    };

    child.once('error', (error) => {
      stderr += error.message;
      finish(-1, null);
    });
    child.once('close', finish);
  });

  return { child, result };
}

async function runDriver(
  fixture: Fixture,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return startDriver(fixture, args, extraEnv).result;
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  return existsSync(path);
}

describe('mutate-with-lock: Stryker 變異測試的跨 worktree 鎖', () => {
  it('搶鎖失敗時立刻回報持有者與持有時間', async () => {
    const fixture = makeFixture();
    try {
      const holderPid = process.pid;
      const startedAt = new Date(Date.now() - 45_000).toISOString();
      writeFileSync(
        fixture.lockPath,
        JSON.stringify({ pid: holderPid, timestamp: startedAt, startedAt, started_at: startedAt }),
        'utf8',
      );

      const started = performance.now();
      const result = await runDriver(fixture, []);
      const elapsedMs = performance.now() - started;

      expect(result.timedOut, '鎖衝突應該立即結束，不可排隊等待').toBe(false);
      expect(result.code, '已有活鎖時必須以非零 exit code 失敗').not.toBe(0);
      expect(elapsedMs, '鎖衝突不可等到 timeout 才回報').toBeLessThan(1_500);
      expect(result.output, '失敗訊息必須指出持有者 pid').toContain(String(holderPid));
      expect(result.output, '失敗訊息必須指出鎖已持有多久').toMatch(/持有|held|duration|elapsed|second|minute|ms/i);
    } finally {
      cleanupFixture(fixture);
    }
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`${signal} 中斷後不留下殘留鎖`, async () => {
      const fixture = makeFixture();
      const handle = startDriver(fixture, [], { MUTATE_TEST_MODE: 'hang' });
      try {
        const lockReady = await waitForFile(fixture.lockPath);
        expect(lockReady, '假 Stryker 開始前必須先取得鎖').toBe(true);
        const fakeReady = await waitForFile(fixture.fakePidPath);
        expect(fakeReady, '測試必須確認假 Stryker 確實在跑').toBe(true);

        handle.child.kill(signal);
        const result = await handle.result;
        expect(result.timedOut, `${signal} 後 wrapper 應該結束`).toBe(false);
        expect(existsSync(fixture.lockPath), `${signal} 後鎖檔必須被清掉`).toBe(false);
      } finally {
        if (handle.child.exitCode === null && handle.child.signalCode === null) {
          handle.child.kill('SIGKILL');
        }
        await handle.result;
        cleanupFixture(fixture);
      }
    });
  }

  it('原樣轉傳所有參數並原樣傳回替身 exit code', async () => {
    const fixture = makeFixture();
    try {
      const forwardedArgs = ['--mutate', 'foo/**/*.ts', '--incremental'];
      const result = await runDriver(fixture, forwardedArgs, { MUTATE_TEST_EXIT_CODE: '37' });

      expect(result.code, 'wrapper 必須傳回替身的實際 exit code').toBe(37);
      expect(existsSync(fixture.argsPath), '替身必須收到一次呼叫').toBe(true);
      const receivedArgs = JSON.parse(readFileSync(fixture.argsPath, 'utf8')) as string[];
      expect(receivedArgs, 'wrapper 不可改寫或遺漏 CLI 參數').toEqual(['run', ...forwardedArgs]);
      expect(existsSync(fixture.lockPath), '正常結束後不可留下鎖檔').toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it('沒有 type:module 的 consumer 也能正常取鎖、跑完並釋放鎖', async () => {
    const fixture = makeCommonJsConsumerFixture();
    try {
      const packageJson = JSON.parse(readFileSync(join(fixture.root, 'package.json'), 'utf8')) as Record<string, unknown>;
      expect(packageJson, 'CJS consumer fixture 不可偷偷帶入 type:module').not.toHaveProperty('type');

      const result = await runDriver(fixture, []);
      const output = result.output || '(driver 沒有輸出)';
      expect(result.timedOut, `CJS consumer driver output:\n${output}`).toBe(false);
      expect(result.code, `CJS consumer driver output:\n${output}`).toBe(0);
      expect(existsSync(fixture.argsPath), 'CJS consumer 的假 Stryker 必須確實被執行').toBe(true);
      expect(existsSync(fixture.lockPath), 'CJS consumer 正常結束後不可留下鎖檔').toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });
});
