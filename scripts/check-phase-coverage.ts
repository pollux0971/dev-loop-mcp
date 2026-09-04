/**
 * Phase 涵蓋率檢查(P-32,見 docs/03-agile-workflow.md 合併檢查段落)。
 *
 * 背景:cucumber 的 tag 表達式打錯字(例如 `@phase-1` 打成 `@phase1`,或資料夾名稱
 * 跟 tag 對不上)不會讓任何測試變紅——它只是安靜地比對到 0 個場景,`npm run accept` 一樣
 * 全綠,因為根本沒有場景被跑到。這支腳本對每個 phase 檔用「它自己宣稱的 tag」跑一次
 * cucumber dry-run,要求至少比對到 1 個場景。
 *
 * 規則:
 *   對每個 features/<NN-name>/phase-<N>.feature:
 *     1. 讀檔案第一行(tag 行),取出資料夾名稱去掉 "NN-" 前綴當作 <name>,檔名的 N 當作 phase 號
 *     2. 確認第一行同時含有 @<name> 與 @phase-<N> 這兩個 tag(字面比對,不是子字串)——
 *        對不上就算這個 phase 檔失敗(tag 掛錯,dry-run 也救不了)
 *     3. 執行 `NODE_OPTIONS=--import=tsx npx cucumber-js --tags "@<name> and @phase-<N>"
 *        --dry-run --format summary`(spawnSync,cwd 是 repo 根,env 去掉外層 NODE_OPTIONS
 *        後只加自己的 `--import=tsx`)
 *     4. 解析輸出裡的 `N scenarios`,要求 N ≥ 1
 *
 * 用法:
 *   npx tsx scripts/check-phase-coverage.ts               # 全部 phase 檔
 *   npx tsx scripts/check-phase-coverage.ts --only 04-scheduler
 *   npx tsx scripts/check-phase-coverage.ts --list         # 只列出會檢查哪些檔案,不執行
 *
 * 退出碼:
 *   0  每個 phase 檔用自己的 tag 都至少比對到 1 個場景
 *   1  任一 phase 檔比對到 0 個場景,或 tag 掛錯,或執行/解析失敗;
 *      或掃到 0 個 phase 檔(這不是很乾淨,是掃描器壞了)
 *
 * 反向驗證(改完要還原,不要留下改動):
 *   (a) 挑一個 phase 檔(例如 features/04-scheduler/phase-1.feature),把第一行的
 *       `@phase-1` 手動改成 `@phase-9`(製造 tag 與檔名對不上)。重跑這支腳本 →
 *       應該紅,列出 04-scheduler/phase-1 的 tag 對不上或比對到 0 個場景。
 *   (b) 改回 `@phase-1` → 重跑 → 應該綠。
 *   (c) 這個 worktree 的舊版根目錄本身就是資料:直接跑一次全部,應該看到每個既有
 *       phase 檔都 ≥1 個場景(沒有場景清單本身就是紅,不用手動改壞就看得到)。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ONLY = arg('--only');
const LIST_ONLY = process.argv.includes('--list');

interface PhaseFile { folder: string; name: string; phase: number; file: string; relFile: string }

function collectPhaseFiles(): PhaseFile[] {
  const featuresDir = join(ROOT, 'features');
  if (!existsSync(featuresDir)) return [];
  const out: PhaseFile[] = [];
  for (const entry of readdirSync(featuresDir)) {
    const folderMatch = entry.match(/^(\d{2})-(.+)$/);
    if (!folderMatch) continue; // 跳過 _template、steps 等非 NN-name 資料夾
    const folder = entry;
    const name = folderMatch[2]!;
    const folderPath = join(featuresDir, folder);
    if (!statSync(folderPath).isDirectory()) continue;
    for (const file of readdirSync(folderPath)) {
      const phaseMatch = file.match(/^phase-(\d+)\.feature$/);
      if (!phaseMatch) continue;
      out.push({
        folder,
        name,
        phase: Number(phaseMatch[1]),
        file: join(folderPath, file),
        relFile: `features/${folder}/${file}`,
      });
    }
  }
  return out.sort((a, b) => (a.folder === b.folder ? a.phase - b.phase : a.folder.localeCompare(b.folder)));
}

function firstNonEmptyLine(file: string): string {
  const lines = readFileSync(file, 'utf8').split('\n');
  return lines.find((l) => l.trim().length > 0) ?? '';
}

function hasTag(line: string, tag: string): boolean {
  const tags: string[] = line.match(/@[^\s]+/g) ?? [];
  return tags.includes(tag);
}

function runDryRun(tagExpr: string): { scenarios: number; output: string } | { error: string; output: string } {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  env.NODE_OPTIONS = '--import=tsx';
  const r = spawnSync('npx', ['cucumber-js', '--tags', tagExpr, '--dry-run', '--format', 'summary'], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error) return { error: r.error.message, output };
  const m = output.match(/(\d+)\s+scenarios?\b/);
  if (!m) return { error: '輸出裡找不到 "N scenarios"', output };
  return { scenarios: Number(m[1]), output };
}

function main(): void {
  let phaseFiles = collectPhaseFiles();
  if (ONLY) phaseFiles = phaseFiles.filter((p) => p.folder === ONLY);

  if (phaseFiles.length === 0) {
    console.log(
      ONLY
        ? `✗ 找不到 features/${ONLY}/phase-*.feature`
        : '✗ 掃到 0 個 phase 檔(features/<NN-name>/phase-*.feature)。這不是很乾淨,是掃描器壞了。',
    );
    process.exit(1);
  }

  if (LIST_ONLY) {
    for (const p of phaseFiles) console.log(`  ${p.relFile}  →  @${p.name} and @phase-${p.phase}`);
    process.exit(0);
  }

  console.log(`phase-coverage: 檢查 ${phaseFiles.length} 個 phase 檔`);

  const failures: string[] = [];
  for (const p of phaseFiles) {
    const line = firstNonEmptyLine(p.file);
    const nameTag = `@${p.name}`;
    const phaseTag = `@phase-${p.phase}`;
    if (!hasTag(line, nameTag) || !hasTag(line, phaseTag)) {
      failures.push(`${p.relFile}  第一行缺少 ${nameTag} 或 ${phaseTag}(實際:${line.trim() || '(空白)'})`);
      console.log(`  ✗ ${p.relFile}  tag 掛錯`);
      continue;
    }
    const tagExpr = `${nameTag} and ${phaseTag}`;
    const result = runDryRun(tagExpr);
    if ('error' in result) {
      failures.push(`${p.relFile}  執行/解析失敗:${result.error}`);
      console.log(`  ✗ ${p.relFile}  執行/解析失敗:${result.error}`);
      continue;
    }
    if (result.scenarios < 1) {
      failures.push(`${p.relFile}  tag "${tagExpr}" 比對到 0 個場景`);
      console.log(`  ✗ ${p.relFile}  0 個場景(tag "${tagExpr}")`);
      continue;
    }
    console.log(`  ✓ ${p.relFile}  ${result.scenarios} 個場景`);
  }

  if (failures.length) {
    console.log(`\n✗ ${failures.length} 個 phase 檔沒有涵蓋率:`);
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }

  console.log('\n✓ 全部 phase 檔至少涵蓋 1 個場景');
  process.exit(0);
}

main();
