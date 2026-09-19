/**
 * `.claude/skills/` 與 `.agents/skills/` 的逐檔鏡像守門。
 *
 * `.claude/skills/` 是唯一正本；`.agents/skills/` 只能由 `--fix` 從正本重建，
 * 不會反向覆蓋正本。兩邊的相對檔案集合與每個檔案的 sha256 都必須一致。
 *
 * 用法:
 *   npx tsx scripts/check-skills-mirror.ts
 *   npx tsx scripts/check-skills-mirror.ts --fix
 *   npx tsx scripts/check-skills-mirror.ts --root <dir> --fix
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  ROOT as GIT_ROOT,
  loadGatesConfig,
  lookupConfig,
  requireRootDir,
  resolveSkipDirs,
} from './_root.js';

const GATE_NAME = 'skills-mirror';
const CANONICAL_REL = '.claude/skills';
const MIRROR_REL = '.agents/skills';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const ROOT_EXPLICIT = argValue('--root') !== undefined;
const ROOT = resolve(argValue('--root') ?? GIT_ROOT);
requireRootDir(ROOT, ROOT_EXPLICIT, GATE_NAME);

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** 這行要能直接複製貼上，並保留本次 `--root` 的目標。 */
function rebuildCommand(): string {
  const root = ROOT_EXPLICIT ? ` --root ${shellQuote(ROOT)}` : '';
  return `npx tsx scripts/check-skills-mirror.ts${root} --fix`;
}

function fail(message: string, scanned: number, withFixCommand = true): never {
  console.error(`✗ ${message}`);
  if (withFixCommand) console.error(`  重新產生鏡像:${rebuildCommand()}`);
  console.log(`gate=${GATE_NAME} result=FAIL scanned=${scanned}`);
  process.exit(1);
}

/**
 * `gates.config.json` 是選填的；即使 `--root` 明講而目標沒有這份設定，也使用
 * `resolveSkipDirs()` 的內建清單。`resolveSkipDirs()` 本身負責驗證額外清單與 glob 硬錯。
 */
function loadSkipDirs(): Set<string> {
  const lookup = lookupConfig(import.meta.dirname, 'gates.config.json', {
    root: ROOT,
    rootExplicit: ROOT_EXPLICIT,
  });
  const config = loadGatesConfig(lookup.path, GATE_NAME);
  return resolveSkipDirs(config, GATE_NAME);
}

interface ScannedFile {
  absolutePath: string;
  sha256: string;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 遞迴收集相對於某個 skill root 的檔案；略過層由 `_root.ts` 統一提供。 */
function collectFiles(root: string, skipDirs: Set<string>): Map<string, ScannedFile> {
  const files = new Map<string, ScannedFile>();
  if (!existsSync(root) || !statSync(root).isDirectory()) return files;

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const absolutePath = join(current, entry.name);
      files.set(toPosix(relative(root, absolutePath)), {
        absolutePath,
        sha256: sha256(absolutePath),
      });
    }
  }

  walk(root);
  return files;
}

type DifferenceKind = 'only-canonical' | 'only-mirror' | 'content-differs';

interface Difference {
  path: string;
  kind: DifferenceKind;
  canonicalSha256?: string;
  mirrorSha256?: string;
}

function compare(canonical: Map<string, ScannedFile>, mirror: Map<string, ScannedFile>): Difference[] {
  const allPaths = [...new Set([...canonical.keys(), ...mirror.keys()])].sort();
  const differences: Difference[] = [];

  for (const path of allPaths) {
    const canonicalFile = canonical.get(path);
    const mirrorFile = mirror.get(path);
    if (!canonicalFile) {
      differences.push({ path, kind: 'only-mirror' });
    } else if (!mirrorFile) {
      differences.push({ path, kind: 'only-canonical' });
    } else if (canonicalFile.sha256 !== mirrorFile.sha256) {
      differences.push({
        path,
        kind: 'content-differs',
        canonicalSha256: canonicalFile.sha256,
        mirrorSha256: mirrorFile.sha256,
      });
    }
  }

  return differences;
}

function printDifferences(differences: Difference[]): void {
  console.error(`✗ `.concat(`${differences.length} 個 skill 鏡像差異:`));
  for (const difference of differences) {
    if (difference.kind === 'only-canonical') {
      console.error(`  ${difference.path} — 只在 ${CANONICAL_REL}/ 存在`);
    } else if (difference.kind === 'only-mirror') {
      console.error(`  ${difference.path} — 只在 ${MIRROR_REL}/ 存在`);
    } else {
      console.error(
        `  ${difference.path} — 兩邊都在但內容不同` +
          ` (sha256 ${CANONICAL_REL}=${difference.canonicalSha256}, ${MIRROR_REL}=${difference.mirrorSha256})`,
      );
    }
  }
  console.error(`  重新產生鏡像:${rebuildCommand()}`);
}

function repair(canonicalRoot: string, mirrorRoot: string): void {
  // 先清掉 mirror，才能同時移除 mirror 多出、但正本不存在的檔案。
  // 這個函式只寫 `.agents/skills/`，`.claude/skills/` 永遠只讀。
  rmSync(mirrorRoot, { recursive: true, force: true });
  mkdirSync(dirname(mirrorRoot), { recursive: true });
  cpSync(canonicalRoot, mirrorRoot, { recursive: true });
}

function main(): void {
  const canonicalRoot = join(ROOT, CANONICAL_REL);
  const mirrorRoot = join(ROOT, MIRROR_REL);
  if (!existsSync(canonicalRoot) || !statSync(canonicalRoot).isDirectory()) {
    fail(`找不到正本目錄:${canonicalRoot}`, 0);
  }

  const skipDirs = loadSkipDirs();
  const fix = process.argv.includes('--fix');

  let canonical = collectFiles(canonicalRoot, skipDirs);
  let mirror = collectFiles(mirrorRoot, skipDirs);
  let differences = compare(canonical, mirror);

  if (fix && differences.length > 0) {
    try {
      repair(canonicalRoot, mirrorRoot);
    } catch (error) {
      fail(`--fix 無法從正本重建鏡像:${error instanceof Error ? error.message : String(error)}`, canonical.size);
    }
    canonical = collectFiles(canonicalRoot, skipDirs);
    mirror = collectFiles(mirrorRoot, skipDirs);
    differences = compare(canonical, mirror);
  }

  if (differences.length > 0) {
    printDifferences(differences);
    console.log(`gate=${GATE_NAME} result=FAIL scanned=${canonical.size + mirror.size}`);
    process.exit(1);
  }

  console.log(`gate=${GATE_NAME} result=PASS scanned=${canonical.size}`);
  process.exit(0);
}

main();
