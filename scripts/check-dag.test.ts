/**
 * `scripts/check-dag.ts` 的先行紅測試(ADR-019 第 3 點)。
 *
 * 這一棒只建立可執行的 acceptance fixtures；實作由下一棒接手。
 * 每個 fixture 都是一次性的 git repo，讓 phase 引用與 commit 引用都跟
 * 真實專案格式一致，而且 `--root` 明講後不會碰到目前工作樹。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHECK_DAG_TS = resolve(import.meta.dirname, 'check-dag.ts');
const SPAWN_TIMEOUT_MS = 60_000;

const tmpDirs: string[] = [];

function runGit(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lc-check-dag-'));
  tmpDirs.push(dir);
  runGit(dir, 'init', '-q');
  runGit(dir, 'config', 'user.email', 'check-dag-test@example.com');
  runGit(dir, 'config', 'user.name', 'check-dag-test');
  runGit(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function write(root: string, relPath: string, content: string): void {
  const p = join(root, relPath);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

function commitAll(root: string, message: string): string {
  runGit(root, 'add', '-A');
  runGit(root, 'commit', '-q', '-m', message);
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git rev-parse HEAD failed: ${r.stderr}`);
  return r.stdout.trim();
}

function writeFeature(root: string, folder: string, phases: { n: number; status: string }[]): void {
  const rows = phases
    .map((p) => `| ${p.n} | phase-${p.n} | 測試 phase-${p.n} | Wave 0 | ${p.status} |  |`)
    .join('\n');
  write(
    root,
    `features/${folder}/FEATURE.md`,
    `# ${folder}\n\n## Phase\n\n| Phase | 標題 | 意圖(讓人做到什麼) | 階段 | 狀態 | 完成日 |\n|---|---|---|---|---|---|\n${rows}\n`,
  );
}

function writeNext(root: string, folder: string, body: string): void {
  write(root, `features/${folder}/NEXT.md`, `# ${folder} — 下一步\n\n${body}\n`);
}

function writeDecisionMap(root: string, ids: string[]): void {
  const body = ids.map((id) => `## ADR-${id} · 測試用決策\n\n內容。\n`).join('\n');
  write(root, 'docs/02-decision-map.md', `# 決策地圖\n\n${body}`);
}

function writeContracts(root: string, sections: string[]): void {
  const body = sections.map((section) => `## ${section}. 測試章節\n\n內容。\n`).join('\n');
  write(root, 'contracts/types.md', `# 契約\n\n${body}`);
}

function writeRoadmap(root: string, integrationIds: number[]): void {
  const body = integrationIds.map((n) => `## I${n} · 測試整合點\n\n內容。\n`).join('\n');
  write(root, 'docs/01-roadmap.md', `# Roadmap\n\n${body}`);
}

function run(root: string): { code: number; output: string } {
  const r = spawnSync('npx', ['tsx', CHECK_DAG_TS, '--root', root], {
    cwd: root,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, GATES_CONFIG_DIR: join(root, 'scripts') },
  });
  return { code: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function outputSection(output: string, startMarker: string, endMarker?: string): string {
  const start = output.indexOf(startMarker);
  if (start < 0) return '';
  const end = endMarker === undefined ? -1 : output.indexOf(endMarker, start + startMarker.length);
  return output.slice(start, end < 0 ? undefined : end);
}

function layerSection(output: string, layer: number, nextLayer?: number): string {
  return outputSection(output, `第 ${layer} 層`, nextLayer === undefined ? '目前 ready 集合' : `第 ${nextLayer} 層`);
}

const HEADER_FIXTURES = [
  {
    name: '模板原句「需要全部滿足:」',
    header: (phase: number) => `**phase-${phase}** 需要全部滿足:`,
  },
  {
    name: '全形冒號',
    header: (phase: number) => `**phase-${phase}** 需要：`,
  },
  {
    name: 'phase 號後帶括號說明',
    header: (phase: number) => `**phase-${phase}(接進 apps/api composition root)** 需要全部滿足:`,
  },
] as const;

function checklistGate(header: string, dependency: string): string {
  return `${header}\n\n- [ ] ${dependency}`;
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('check-dag:PASS 輸出', () => {
  it('列出拓撲分層、平行寬度、ready 集合與外部阻擋', () => {
    const root = makeRepo();
    writeDecisionMap(root, ['123']);
    writeContracts(root, ['7']);
    writeRoadmap(root, [1]);

    writeFeature(root, '01-alpha', [
      { n: 1, status: 'done' },
      { n: 2, status: 'todo' },
    ]);
    writeFeature(root, '02-beta', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '03-gamma', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '04-adr-blocked', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '05-contract-blocked', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '06-commit-blocked', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '07-externally-cleared', [{ n: 1, status: 'todo' }]);

    // 先建立一個可供 NEXT.md 引用的真實 commit sha。
    const baseSha = commitAll(root, 'base for external blocker citation');
    const shortSha = baseSha.slice(0, 10);

    writeNext(root, '01-alpha', '**phase-2** 需要:phase-1 `done`');
    writeNext(root, '02-beta', '**phase-1** 需要:\n- [ ] 01 phase-1 `done`');
    writeNext(root, '03-gamma', '**phase-1** 需要:\n- [ ] 01-alpha/phase-1 `done`');
    writeNext(root, '04-adr-blocked', '**phase-1** 需要:\n- [ ] ADR-123 等待裁示');
    writeNext(root, '05-contract-blocked', '**phase-1** 需要:\n- [ ] §7 等契約確認');
    writeNext(root, '06-commit-blocked', `**phase-1** 需要:\n- [ ] ${shortSha} 等待外部提交`);
    writeNext(root, '07-externally-cleared', '**phase-1** 需要:\n- [x] ADR-123 已解除');
    commitAll(root, 'add DAG gates');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).toContain('拓撲分層');
    expect(output).toContain('第 1 層');
    expect(output).toContain('第 2 層');
    expect(output).toContain('I1');
    expect(output).toContain('gate=dag result=PASS scanned=9');

    const layer1 = layerSection(output, 1, 2);
    expect(layer1).toContain('節點數=6');
    for (const node of ['01 phase-1', '04 phase-1', '05 phase-1', '06 phase-1', '07 phase-1', 'I1']) {
      expect(layer1, `第 1 層應包含 ${node}`).toContain(node);
    }

    const layer2 = layerSection(output, 2);
    expect(layer2).toContain('節點數=3');
    for (const node of ['01 phase-2', '02 phase-1', '03 phase-1']) {
      expect(layer2, `第 2 層應包含 ${node}`).toContain(node);
    }

    const ready = outputSection(output, '目前 ready 集合', '被外部阻擋卡住的 phase');
    for (const node of ['01 phase-2', '02 phase-1', '03 phase-1', '07 phase-1']) {
      expect(ready, `ready 集合應包含 ${node}`).toContain(node);
    }
    for (const node of ['04 phase-1', '05 phase-1', '06 phase-1']) {
      expect(ready, `外部阻擋中的 ${node} 不應在 ready 集合`).not.toContain(node);
    }

    const blocked = outputSection(output, '被外部阻擋卡住的 phase');
    expect(blocked).toContain('04 phase-1');
    expect(blocked).toContain('ADR-123');
    expect(blocked).toContain('05 phase-1');
    expect(blocked).toContain('§7');
    expect(blocked).toContain('06 phase-1');
    expect(blocked).toContain(shortSha);
    expect(blocked, '已勾選解除的外部 gate 不應列在 blocked 集合').not.toContain('07 phase-1');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-dag:環路', () => {
  it('環路 exit 1 並印出完整的閉合路徑', () => {
    const root = makeRepo();
    writeFeature(root, '01-alpha', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '02-beta', [{ n: 1, status: 'todo' }]);
    writeNext(root, '01-alpha', '**phase-1** 需要:02 phase-1');
    writeNext(root, '02-beta', '**phase-1** 需要:01 phase-1');
    commitAll(root, 'cycle');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('環');
    expect(output).toContain('01 phase-1 → 02 phase-1 → 01 phase-1');
    expect(output).toContain('gate=dag result=FAIL scanned=2');
  }, SPAWN_TIMEOUT_MS);

  for (const fixture of HEADER_FIXTURES) {
    it(`${fixture.name} 也必須抓到環路依賴`, () => {
      const root = makeRepo();
      writeFeature(root, '01-alpha', [{ n: 1, status: 'todo' }]);
      writeFeature(root, '02-beta', [{ n: 1, status: 'todo' }]);
      writeNext(root, '01-alpha', checklistGate(fixture.header(1), '02 phase-1'));
      writeNext(root, '02-beta', checklistGate(fixture.header(1), '01 phase-1'));
      commitAll(root, `cycle: ${fixture.name}`);

      const { code, output } = run(root);

      expect(code).toBe(1);
      expect(output).toContain('環');
      expect(output).toContain('01 phase-1 → 02 phase-1 → 01 phase-1');
      expect(output).toContain('gate=dag result=FAIL scanned=2');
    }, SPAWN_TIMEOUT_MS);
  }
});

describe('check-dag:依賴反向驗證', () => {
  it('拿掉一條真依賴後，該 phase 從第 2 層移到第 1 層', () => {
    const root = makeRepo();
    writeFeature(root, '01-alpha', [{ n: 1, status: 'done' }]);
    writeFeature(root, '02-beta', [{ n: 1, status: 'todo' }]);
    writeFeature(root, '03-gamma', [{ n: 1, status: 'todo' }]);
    writeNext(root, '01-alpha', '**phase-1**:無 gate。');
    writeNext(root, '02-beta', '**phase-1** 需要:01 phase-1 `done`');
    writeNext(root, '03-gamma', '**phase-1** 需要:01 phase-1 `done`');
    commitAll(root, 'dependency present');

    const before = run(root);
    expect(before.code).toBe(0);
    expect(layerSection(before.output, 1, 2)).not.toContain('02 phase-1');
    expect(layerSection(before.output, 2)).toContain('02 phase-1');

    // 只移除 02-beta 的真依賴，03-gamma 仍保留，避免測試只驗「整張圖重算」。
    writeNext(root, '02-beta', '**phase-1** 需要:無');
    const after = run(root);

    expect(after.code).toBe(0);
    expect(layerSection(after.output, 1, 2)).toContain('02 phase-1');
    expect(layerSection(after.output, 2)).not.toContain('02 phase-1');
    expect(layerSection(after.output, 2)).toContain('03 phase-1');
    expect(after.output).toContain('gate=dag result=PASS scanned=3');
  }, SPAWN_TIMEOUT_MS);

  for (const fixture of HEADER_FIXTURES) {
    it(`${fixture.name} 拿掉一條真依賴後 phase 會換層`, () => {
      const root = makeRepo();
      writeFeature(root, '01-alpha', [{ n: 1, status: 'done' }]);
      writeFeature(root, '02-beta', [{ n: 1, status: 'todo' }]);
      writeFeature(root, '03-gamma', [{ n: 1, status: 'todo' }]);
      writeNext(root, '01-alpha', '**phase-1**:無 gate。');
      writeNext(root, '02-beta', checklistGate(fixture.header(1), '01 phase-1 `done`'));
      writeNext(root, '03-gamma', '**phase-1** 需要:01 phase-1 `done`');
      commitAll(root, `dependency present: ${fixture.name}`);

      const before = run(root);
      expect(before.code).toBe(0);
      expect(layerSection(before.output, 1, 2)).not.toContain('02 phase-1');
      expect(layerSection(before.output, 2)).toContain('02 phase-1');

      writeNext(root, '02-beta', checklistGate(fixture.header(1), '無'));
      const after = run(root);

      expect(after.code).toBe(0);
      expect(layerSection(after.output, 1, 2)).toContain('02 phase-1');
      expect(layerSection(after.output, 2)).not.toContain('02 phase-1');
      expect(layerSection(after.output, 2)).toContain('03 phase-1');
      expect(after.output).toContain('gate=dag result=PASS scanned=3');
    }, SPAWN_TIMEOUT_MS);
  }
});
