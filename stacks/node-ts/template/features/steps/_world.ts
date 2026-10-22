import { setWorldConstructor, World, IWorldOptions, Before, After } from '@cucumber/cucumber';
import { readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { makeIsolatedTempDir } from '../../scripts/_root.js';

/** Repo root (two levels above features/steps/) */
export const ROOT = resolve(import.meta.dirname, '../..');

type Manifest = Record<string, { cmd: string; interactive: boolean; expect?: string; expectExit?: number }>;

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr, handy for "it prints ..." style assertions */
  output: string;
}

/**
 * State container shared by all steps.
 *
 * Three principles:
 * 1. Each scenario gets a fresh World; no state is shared.
 * 2. A fixture that needs writing is always copied to a temp dir first; never modify contracts/fixtures/.
 * 3. lastResult holds the output of When; Then asserts against it.
 *
 * Common steps (features/steps/common.steps.ts) only read and write the fields here; each feature's step file fills in the values.
 *
 * The fields below are a **generic starting point**; add or remove them to fit your project.
 */
export class ProjectWorld extends World {
  /** Temp working directory, created by useFixture */
  dir?: string | undefined;
  /**
   * "Today" inside tests. Set a fixed value that fits your fixtures so date-related scenarios are predictable.
   * The default is a fixed date; change it to a date that matches your fixtures' assumptions (don't use the real today, or scenarios become unreproducible).
   */
  today = '2026-01-01';
  /** Result of the latest When; each step narrows the type itself */
  lastResult: unknown;
  /**
   * Text for the common step "the result is X" to compare against.
   * When lastResult is not a primitive, the When step can set this field directly so the common step doesn't have to guess.
   */
  resultText?: string | undefined;
  /** Latest thrown error, for "should fail" scenarios */
  lastError?: Error | undefined;
  /**
   * Record of calls to external services (e.g. LLM / third-party APIs), used to assert "no external service was called".
   * A project without such dependencies can delete the whole group.
   */
  llmCalls: { task: string; prompt: string }[] = [];
  /** Record of any outbound network request (pushed in by a fake adapter), used to assert "no network request" */
  networkRequests: string[] = [];
  /** The common step "a fake router replaying the recorded fixtures" sets this to true; each feature's When builds its own fake */
  useFakeRouter = false;
  /** Result of the latest external command (standalone / dev server) */
  lastRun?: RunResult;
  /** Tags of the feature the current scenario belongs to (filled by the Before hook) */
  tags: string[] = [];
  /** Raw text loaded by a common step; adjust its use and name to your core entity */
  fixtureText?: string;
  /** For pure-function checks: the input object reference and a deep copy taken before the call, see trackInput */
  inputRef?: unknown;
  inputSnapshot?: string;

  constructor(options: IWorldOptions) {
    super(options);
  }

  /** Copy a read-only fixture into a temp dir and return the new path */
  useFixture(name: string): string {
    const src = join(ROOT, 'contracts/fixtures', name);
    const dst = makeIsolatedTempDir('proj-');
    cpSync(src, dst, { recursive: true });
    this.dir = dst;
    return dst;
  }

  /** Read a fixture directly without copying. Only for cases where it won't be modified */
  readFixture(relPath: string): string {
    return readFileSync(join(ROOT, 'contracts/fixtures', relPath), 'utf8');
  }

  /** Read a file in the temp dir */
  read(relPath: string): string {
    if (!this.dir) throw new Error('尚未呼叫 useFixture');
    return readFileSync(join(this.dir, relPath), 'utf8');
  }

  /** Pure-function check: record the input before calling the function under test, then assert with "the original object is unchanged" */
  trackInput<T>(input: T): T {
    this.inputRef = input;
    this.inputSnapshot = JSON.stringify(input);
    return input;
  }

  /**
   * Derive the standalone.json key from the feature file's tag. In v2 the key is the capability name (the part of the dag node id before `/v`, e.g. `ingest`),
   * so `@ingest` hits directly; v1 `NN-name` keys also work (`@todo` → `01-todo`).
   */
  standaloneKey(): string {
    const manifest = this.manifest();
    for (const t of this.tags) {
      const name = t.replace(/^@/, '');
      const hit = Object.keys(manifest).find((k) => k === name || k.endsWith(`-${name}`));
      if (hit) return hit;
    }
    throw new Error(`從 tags ${this.tags.join(' ')} 推不出 standalone.json 的 key`);
  }

  manifest(): Manifest {
    return JSON.parse(readFileSync(join(ROOT, 'standalone.json'), 'utf8')) as Manifest;
  }

  /**
   * Run a shell command synchronously, store the result in lastRun and return it. cwd defaults to the repo root; CLI integration tests often need to run in a temp dir (holding test files), so pass opts.cwd.
   * `--import tsx` in the command is replaced with tsx's absolute location: outside the repo, node can't resolve tsx and the child process fails at startup,
   * which looks like a "not implemented yet" red (a fake red), and the dev leg can never turn it green however it edits (dlm v4.7.3 real run: the step spawns itself with cwd set to a temp dir).
   */
  runCommand(cmd: string, opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): RunResult {
    const r = spawnSync(withTsxResolved(cmd), {
      cwd: opts.cwd ?? ROOT,
      shell: true,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 120_000,
      // Drop NODE_OPTIONS: cucumber starts with --import=tsx, and a child process in another cwd can't resolve tsx, giving a fake red
      env: { ...withoutNodeOptions(process.env), ...opts.env },
    });
    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';
    this.lastRun = { status: r.error ? null : r.status, stdout, stderr, output: stdout + stderr };
    return this.lastRun;
  }

  /** Run the command of a key in standalone.json. Without a key, derive it from the tags */
  runStandalone(key?: string, extraArgs = ''): RunResult {
    const k = key ?? this.standaloneKey();
    const entry = this.manifest()[k];
    if (!entry) throw new Error(`standalone.json 裡沒有 ${k}`);
    if (entry.interactive) throw new Error(`${k} 是互動式指令,用 startDevServer`);
    return this.runCommand(extraArgs ? `${entry.cmd} ${extraArgs}` : entry.cmd);
  }

  /**
   * Start an interactive command (dev server), wait until the output shows a ready marker or times out, then shut it down.
   * The result goes into lastRun: status 0 means the ready marker was seen.
   */
  async startDevServer(key?: string, opts: { readyPattern?: RegExp; timeoutMs?: number } = {}): Promise<RunResult> {
    const k = key ?? this.standaloneKey();
    const entry = this.manifest()[k];
    if (!entry) throw new Error(`standalone.json 裡沒有 ${k}`);
    const ready = opts.readyPattern ?? /localhost:\d+|Local:|ready in/i;
    const timeoutMs = opts.timeoutMs ?? 60_000;

    return new Promise<RunResult>((resolveRun) => {
      const child = spawn(withTsxResolved(entry.cmd), { cwd: ROOT, shell: true, env: withoutNodeOptions(process.env), detached: true });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (status: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already exited */ }
        this.lastRun = { status, stdout, stderr, output: stdout + stderr };
        resolveRun(this.lastRun);
      };
      const check = () => { if (ready.test(stdout + stderr)) finish(0); };
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); check(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); check(); });
      child.on('exit', (code) => finish(code ?? 1));
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  cleanup(): void {
    if (this.dir && existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }
}

/** Copy the env vars but drop NODE_OPTIONS (see the comment in runCommand) */
/** Absolute location of tsx (resolved from the repo). `node --import tsx` only resolves inside the repo; with this it loads from any cwd. */
const TSX_URL = (() => { try { return import.meta.resolve('tsx'); } catch { return null; } })();
function withTsxResolved(cmd: string): string {
  return TSX_URL ? cmd.replace(/--import(?:=|\s+)tsx(?![\w/.-])/g, `--import=${TSX_URL}`) : cmd;
}

function withoutNodeOptions(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NODE_OPTIONS: _omit, ...rest } = env;
  return rest;
}

setWorldConstructor(ProjectWorld);

Before(function (this: ProjectWorld, { pickle }) {
  this.llmCalls = [];
  this.networkRequests = [];
  this.lastError = undefined;
  this.lastResult = undefined;
  this.resultText = undefined;
  this.useFakeRouter = false;
  this.tags = pickle.tags.map((t) => t.name);
});

After(function (this: ProjectWorld) {
  this.cleanup();
});
