/**
 * 文件連結檢查(見 docs/03-agile-workflow.md「文件漂移」維護項)。
 *
 * 掃描根目錄、docs/、features/、contracts/、.claude/ 底下的 *.md,抓 markdown 相對連結
 * `[text](path)`,確認目標檔案或目錄存在。文件裡的相對連結是唯一沒有編譯器、
 * 沒有測試會幫你檢查的東西——檔案搬走、改名之後,連結安靜地爛掉,直到有人手動點才發現。
 * `.claude/` 底下是 commands / rules / skills,agent 每次載入都會讀,壞連結的代價比一般 docs 更貴。
 *
 * 規則:
 *   1. 掃描範圍:repo 根目錄下直接的 *.md(不遞迴),加上 docs/、features/、contracts/、
 *      .claude/ 底下遞迴的所有 *.md;排除任何路徑含 node_modules、archive/、.claude/worktrees/ 的檔案
 *   2. 排除:``` 圍欄程式碼區塊、行內反引號 code span 裡的內容(先整段剝掉,保留行數)
 *   3. 抓 `[text](path)` 形式的連結(含圖片 `![alt](path)` 的 path 部分);排除
 *      http(s):、mailto: 開頭,以及純錨點 `#...`;path 裡的 `#fragment` 一律去掉再判斷
 *   4. 目標相對於「連結所在檔案」所在目錄解析,要求該路徑存在(檔案或目錄都算通過)
 *
 * 用法(repo 根從 `git rev-parse --show-toplevel` 解析,不在 git repo 裡則退回 cwd):
 *   npx tsx scripts/check-doc-links.ts               # 複製進 repo 後執行
 *   npx tsx <template>/scripts/check-doc-links.ts    # 從模板路徑直接執行,cwd 需在目標 repo
 *
 * 退出碼:
 *   0  沒有壞掉的連結
 *   1  有連結指向不存在的路徑;或掃到 0 條連結(這不是很乾淨,是掃描器壞了)
 *
 * 反向驗證(改完要還原,不要留下改動):
 *   (a) 找一份現有 .md(例如 docs/01-roadmap.md)裡一條指向真實檔案的相對連結
 *       (例如指到某個 FEATURE.md),把它的路徑改成明顯不存在的檔名(加個 -broken 後綴)。
 *       重跑這支腳本 → 應該紅,列出那個檔案:行號 → 壞掉的目標。
 *   (b) 改回原本的路徑 → 重跑 → 應該綠。
 *   (c) 順手確認:把同一條連結包進反引號(變成 code span)重跑 → 不該被當成連結抓到
 *       (驗證「code span 裡的不算連結」這條規則),測完記得拿掉反引號、還原檔案。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ROOT } from './_root.js';

const SKIP_SEGMENTS = new Set(['node_modules', 'archive']);
/** 路徑前綴(相對於 ROOT,posix 分隔),整個子樹排除。 */
const SKIP_PREFIXES = ['.claude/worktrees'];

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

function isSkipped(relPath: string): boolean {
  const posix = toPosix(relPath);
  if (posix.split('/').some((seg) => SKIP_SEGMENTS.has(seg))) return true;
  return SKIP_PREFIXES.some((prefix) => posix === prefix || posix.startsWith(`${prefix}/`));
}

function* walkMd(dir: string, relDir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relDir ? `${relDir}/${name}` : name;
    if (isSkipped(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) yield* walkMd(full, rel);
    else if (name.endsWith('.md')) yield full;
  }
}

function collectMarkdownFiles(): string[] {
  const files: string[] = [];
  // 根目錄:不遞迴,只抓直接放在 repo 根的 *.md
  for (const name of readdirSync(ROOT)) {
    const full = join(ROOT, name);
    if (statSync(full).isFile() && name.endsWith('.md')) files.push(full);
  }
  for (const dir of ['docs', 'features', 'contracts', '.claude']) {
    for (const f of walkMd(join(ROOT, dir), dir)) files.push(f);
  }
  return files.filter((f) => !isSkipped(toPosix(relative(ROOT, f))));
}

/** 剝掉 ``` 圍欄區塊與行內反引號 code span,保留原本的行數與大致長度(用空白填充),避免行號跑掉。 */
function stripCode(src: string): string {
  let out = src.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  return out;
}

interface LinkOccurrence { file: string; line: number; target: string }
interface BrokenLink extends LinkOccurrence { resolved: string }

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

function extractLinks(file: string, cleanSrc: string): LinkOccurrence[] {
  const out: LinkOccurrence[] = [];
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(cleanSrc)) !== null) {
    const rawTarget = m[1]!.trim();
    const line = cleanSrc.slice(0, m.index).split('\n').length;
    out.push({ file, line, target: rawTarget });
  }
  return out;
}

function isExternalOrAnchor(target: string): boolean {
  if (/^https?:/i.test(target)) return true;
  if (/^mailto:/i.test(target)) return true;
  if (target.startsWith('#')) return true;
  return false;
}

function stripFragment(target: string): string {
  const idx = target.indexOf('#');
  return idx >= 0 ? target.slice(0, idx) : target;
}

function main(): void {
  const files = collectMarkdownFiles();
  if (files.length === 0) {
    console.log('✗ 掃到 0 個 .md 檔(根目錄、docs/、features/、contracts/、.claude/)。這不是很乾淨,是掃描器壞了。');
    process.exit(1);
  }

  const allLinks: LinkOccurrence[] = [];
  const broken: BrokenLink[] = [];

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const clean = stripCode(raw);
    for (const link of extractLinks(file, clean)) {
      if (isExternalOrAnchor(link.target)) continue;
      allLinks.push(link);
      const withoutFragment = stripFragment(link.target);
      if (!withoutFragment) continue; // 去掉 fragment 後空字串:例如奇怪的 "path#" 但實務上通常不會發生
      const resolved = resolve(dirname(link.file), withoutFragment);
      if (!existsSync(resolved)) broken.push({ ...link, resolved });
    }
  }

  console.log(`doc-links: 掃描 ${files.length} 個 .md 檔,${allLinks.length} 條相對連結`);

  if (allLinks.length === 0) {
    console.log('✗ 掃到 0 條連結。這不是很乾淨,是掃描器壞了。');
    process.exit(1);
  }

  if (broken.length) {
    console.log(`\n✗ ${broken.length} 條壞掉的連結:`);
    for (const b of broken) {
      const rel = toPosix(relative(ROOT, b.file));
      console.log(`  ${rel}:${b.line}  → ${b.target}  (解析為 ${toPosix(relative(ROOT, b.resolved))},不存在)`);
    }
    process.exit(1);
  }

  console.log('✓ 無壞掉的連結');
  process.exit(0);
}

main();
