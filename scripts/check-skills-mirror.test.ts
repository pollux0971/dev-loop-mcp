/**
 * scripts/check-skills-mirror.ts 的測試(工單 skill-mirror leg 1)。
 *
 * 每個案例都造一個一次性的假 consumer 根,避免測試依賴真的 `.claude/skills/`
 * 內容。這一棒先寫紅:腳本尚未存在時,四項斷言都應該失敗;下一棒會在不改本檔的
 * 前提下讓它們轉綠。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeIsolatedTempDir } from './_root.js';

const CHECK_SKILLS_MIRROR_TS = resolve(import.meta.dirname, 'check-skills-mirror.ts');
const SPAWN_TIMEOUT_MS = 60_000;

const tmpDirs: string[] = [];

function makeRoot(): string {
  const root = makeIsolatedTempDir('lc-skills-mirror-');
  tmpDirs.push(root);
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(root, '.agents', 'skills'), { recursive: true });

  return root;
}

function writeSkill(root: string, side: '.claude' | '.agents', relPath: string, content: string): string {
  const path = join(root, side, 'skills', relPath);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

function run(root: string, ...extra: string[]): { code: number; output: string } {
  // 2026-09-21 起守門預設有三組配對(skills→.agents、skills→plugin、commands→plugin)。
  // 這些案例測的是「比對與修復邏輯」,所以固定只跑第一組;預設三組是否完整由下面另一條案例守。
  // `--pairs-default` 是這個 helper 自己的暗號:代表「這條案例要測正式預設的三組配對」,
  // 不傳給腳本。其餘案例固定只跑第一組,因為它們測的是比對與修復邏輯本身。
  const wantsDefault = extra.includes('--pairs-default');
  const passThrough = extra.filter((arg) => arg !== '--pairs-default');
  const pairs = wantsDefault ? [] : ['--pairs', '.claude/skills:.agents/skills'];
  const result = spawnSync('npx', ['tsx', CHECK_SKILLS_MIRROR_TS, '--root', root, ...pairs, ...passThrough], {
    cwd: root,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('check-skills-mirror:集合與內容一致', () => {
  it('兩邊檔案集合相同、內容相同 → exit 0 且印 result=PASS', () => {
    const root = makeRoot();
    writeSkill(root, '.claude', 'autopilot/SKILL.md', 'canonical autopilot\n');
    writeSkill(root, '.agents', 'autopilot/SKILL.md', 'canonical autopilot\n');
    writeSkill(root, '.claude', 'decision-record/SKILL.md', 'canonical decision record\n');
    writeSkill(root, '.agents', 'decision-record/SKILL.md', 'canonical decision record\n');

    const { code, output } = run(root);

    expect(code).toBe(0);
    expect(output).toContain('gate=skills-mirror result=PASS scanned=2');
  }, SPAWN_TIMEOUT_MS);

  it('一邊多一個檔 → exit 1、印出檔案、差異類型與可複製的 --fix 指令', () => {
    const root = makeRoot();
    writeSkill(root, '.claude', 'autopilot/SKILL.md', 'canonical autopilot\n');
    writeSkill(root, '.agents', 'autopilot/SKILL.md', 'canonical autopilot\n');
    writeSkill(root, '.agents', 'extra.txt', 'only in agents\n');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('extra.txt');
    expect(output).toMatch(/只在|only in/i);
    expect(output).toMatch(/npx tsx.*check-skills-mirror\.ts.*--fix|npm run .*skills-mirror.*--fix/);
    expect(output).toContain('gate=skills-mirror result=FAIL');
  }, SPAWN_TIMEOUT_MS);

  it('兩邊都有同名檔但 sha256 不同 → exit 1、印出檔案與內容差異類型', () => {
    const root = makeRoot();
    writeSkill(root, '.claude', 'autopilot/SKILL.md', 'canonical autopilot\n');
    writeSkill(root, '.agents', 'autopilot/SKILL.md', 'tampered autopilot\n');

    const { code, output } = run(root);

    expect(code).toBe(1);
    expect(output).toContain('autopilot/SKILL.md');
    expect(output).toMatch(/內容不同|content differs/i);
    expect(output).toContain('gate=skills-mirror result=FAIL');
  }, SPAWN_TIMEOUT_MS);

  it('--fix 修好合成目錄後重新 PASS,且只改 .agents/skills/、不改正本', () => {
    const root = makeRoot();
    const canonicalPath = writeSkill(root, '.claude', 'autopilot/SKILL.md', 'canonical autopilot\n');
    const mirrorPath = writeSkill(root, '.agents', 'autopilot/SKILL.md', 'tampered autopilot\n');
    const canonicalBefore = readFileSync(canonicalPath);
    const mirrorBefore = readFileSync(mirrorPath);

    expect(mirrorBefore).not.toEqual(canonicalBefore);

    const fixed = run(root, '--fix');

    expect(fixed.code).toBe(0);
    expect(fixed.output).toContain('gate=skills-mirror result=PASS scanned=1');
    expect(readFileSync(canonicalPath)).toEqual(canonicalBefore);
    expect(readFileSync(mirrorPath)).toEqual(canonicalBefore);
    expect(readFileSync(mirrorPath)).not.toEqual(mirrorBefore);

    const verified = run(root);
    expect(verified.code).toBe(0);
    expect(verified.output).toContain('gate=skills-mirror result=PASS scanned=1');
  }, SPAWN_TIMEOUT_MS);
});

describe('check-skills-mirror:預設的三組配對', () => {
  it('不帶 --pairs 時,plugin 那兩組也要被檢查(少一個鏡像檔就要紅)', () => {
    const root = makeRoot();
    // 三組配對的正本都給,而且 .agents 鏡像先弄成一致——這樣唯一的差異只會來自 plugin。
    writeSkill(root, '.claude', 'autopilot/SKILL.md', 'canonical autopilot\n');
    writeSkill(root, '.agents', 'autopilot/SKILL.md', 'canonical autopilot\n');
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(root, '.claude', 'commands', 'demo.md'), '# demo\n', 'utf8');
    mkdirSync(join(root, 'plugin', 'commands'), { recursive: true });
    writeFileSync(join(root, 'plugin', 'commands', 'demo.md'), '# demo\n', 'utf8');
    // plugin/skills 故意不建:如果預設配對漏了它,下面這條會綠,那就是守門在說謊。

    const result = run(root, '--pairs-default');

    expect(result.code).toBe(1);
    expect(result.output).toContain('plugin/skills');
  }, SPAWN_TIMEOUT_MS);
});
