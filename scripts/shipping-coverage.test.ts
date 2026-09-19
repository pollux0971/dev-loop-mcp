/**
 * 出貨覆蓋名冊(1.7.0,DECISIONS_NEEDED #21;P-95 / P-96)。
 *
 * 問的問題:**repo 裡每一個 tracked 檔,都要能回答「它靠什麼到 consumer 手上」。**
 * 答案只有三種:
 *   (1) 真的被出貨了——依該檔案的管道契約,`sync-gates.sh` 與/或 `npx init` 的 tarball 裝了它;
 *   (2) 刻意不出貨——列在 `NOT_SHIPPED`,附理由;
 *   (3) 已知缺口——列在 `KNOWN_GAPS`,**必須指向一件還在待批示的 DECISIONS_NEEDED**。
 * 三種都不是 → 紅,訊息列出是哪幾個檔。
 *
 * 背景(專案 A 協調者 2026-09-12):他們手上唯一一份 `.orca-brief/TASK.md.template` 在一個
 * 7 天前凍結的 worktree 裡,路徑還帶著 repo 拆分前的 `template/` 那一層——`sync-gates.sh` 從來
 * 沒搬過它。而它一直沒被發現的原因才是重點:那份凍結副本跟上游**逐位元組相同**(樣板自己也沒改過),
 * 所以沒有任何時刻會出現「內容不對」這個訊號。**這種不會壞,它只是靜止。**
 * 所以檢查的不是「內容對不對」,是「哪些檔在 repo 裡、但不在任何出貨集合裡」。
 *
 * ## 出貨集合用工具自己的輸出,不重寫展開邏輯
 *
 * 不解析 `payload-manifest.json` 的 glob、也不解析 `sync-gates.sh` 的複製規則——那等於第三份
 * 展開邏輯(P-91;而且 1.7.0 實作這支時才發現 `package/src/cli.mjs` 與 `build-template.mjs`
 * **已經各有一份、行為還不一致**)。改成:把 tracked 檔複製到暫存 repo,**真的跑一次 `npm pack`
 * 讀 tarball 清單**、**真的跑一次 `sync-gates.sh` 看落地了哪些檔**。量的是實際出貨的母體,
 * 不是某份規則描述的母體(P-92)。
 *
 * ## 防腐(豁免要貴一點)
 *
 *   - `NOT_SHIPPED` 每一筆:理由有最短長度;至少要比對到一個 tracked 檔(改名後殘留 → 紅);
 *     **不准比對到實際有出貨的檔**(宣告「不出貨」卻出貨了,兩個說法打架 → 紅)。
 *   - `KNOWN_GAPS` 每一筆按管道登記:檔案必須 tracked;該管道必須真的沒出貨(缺口已經補上卻還掛著
 *     → 紅);**指向的 DECISIONS_NEEDED 編號必須還在「待批示」**——那件裁決一離開待批示,這支就紅,
 *     逼人回頭把缺口改成「已出貨」或「刻意不出貨」。這是 #11「暫時措施要有退場條件,而且退場條件
 *     要是一個可查的事實」在這裡的實作。
 *   - `KNOWN_GAPS` 與 `NOT_SHIPPED` 刻意分開:前者是**欠帳**,後者是**決定**。混在一起的話,
 *     欠帳會被讀成決定(那正是 #17 講的「靜默」)。
 *
 * ## 為什麼 `.orca-brief/` 不用一個前綴整包豁免
 *
 * 那樣 `.orca-brief/TASK.md.template`(真正的缺口)會被「上游協調紀錄不出貨」這個理由一起吞掉。
 * 所以豁免逐項列具體子路徑;`.orca-brief/` 底下出現一個新檔,會以「未分類」紅出來。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_TIMEOUT_MS = 300_000;
const MIN_REASON_LENGTH = 40;
type Pipeline = 'npx' | 'sync';
type PipelineGap = { decision: number; reason: string };
type KnownGap = Partial<Record<Pipeline, PipelineGap>>;

/** 這四類是兩個管道都必須出貨的受管非守門檔,不可用 KNOWN_GAPS 豁免。 */
const REQUIRED_BOTH_SHIPPED = [
  '.claude/skills/',
  '.agents/skills/',
  'docs/templates/TASK.md.template',
  'scripts/py/.gitignore',
] as const;

/** 刻意不出貨。每一筆是「路徑或目錄前綴」→ 理由。 */
const NOT_SHIPPED: Record<string, string> = {
  '.orca-brief/MAILBOX.md':
    '上游協調者與技術顧問的往返紀錄,是這個 repo 自己的決策留痕,不是給 consumer 的素材;consumer 有自己的協調紀錄。',
  '.orca-brief/PM-BRIEF.md': '上游協調者交接給產品 PM session 的一次性簡報,內容綁定上游當時的任務,對 consumer 沒有意義。',
  '.orca-brief/dispatch/':
    '上游 npx init 三個階段實際派出的工單,是 dispatch envelope 的歷史實例;通用的工單形狀在 TASK 樣板裡,不在這些實例裡。',
  '.orca-brief/roles/':
    '上游自己跑 ADR-018 四常駐 CLI 的啟動 prompt 與護欄腳本,寫死本機路徑(/data/python/dev-paradigm-briefs、~/orca/workspaces/dev-paradigm);consumer 拿的是 docs/session-prompts/ 的通用版。',
  '.orca-brief/proposals/':
    '待使用者裁決的提案素材(DECISIONS_NEEDED #8~#13 等),尚未批准;批准落地後出貨的是規則本身,不是提案檔。',
  'DECISIONS_NEEDED.md':
    '模板自己的收件匣(裡面是模板本身的待裁事項)。consumer 拿到的是 package/skeleton/DECISIONS_NEEDED.md 落地成的空白骨架;' +
    '1.7.0 以前出貨的是這一份,新專案一開始就有十幾件跟他無關的待批示(1.7.1 UX 檢查發現)。',
  'package/package.json': 'npx 發布殼的 manifest;它以 npm 套件的形式存在(發布分支的根),不是 template payload 的一部分。',
  'package/payload-manifest.json': '出貨清單本身;它描述要出貨什麼,自己不落地到 consumer。以套件檔的形式跟著發布分支走。',
  'package/README.md': 'npx 發布殼的說明文件,給維護發布流程的人看;consumer 的說明在根目錄 README.md。',
  'package/src/': 'npx 的 CLI 與建置程式(cli.mjs、build-template.mjs);cli.mjs 以套件的 bin 形式存在,不是 payload。',
  'package/test/':
    'npx 發布殼的黑箱測試:它會複製整個模板 repo、跑 npm pack、在暫存目錄 init,依賴上游的完整結構與 package/ 本身;consumer 那裡沒有 package/,跑不起來。',
  'package/release-npx-branch.sh': '把 npm pack 的產物推成發布分支與 npx-v<版本> tag 的腳本,只有模板維護者在上游執行。',
  'package-lock.json': '模板自己開發環境的 lockfile;consumer 會依自己的 package.json 產生自己的 lockfile,出貨上游的只會造成衝突。',
  'scripts/zero-input.gates.test.ts':
    '守的是**模板自己**全部 gate 的零輸入行為(P-84),依賴模板 repo 的完整 gate 清單;consumer 那邊的 gate 組成不同,跑不起來也沒意義。',
  'scripts/no-bypass-literal.test.ts':
    '守的是**模板自己** scripts/ 不含可複製的 Stryker CLI 字面(P-83),掃的是模板原始碼;consumer 的 scripts 有自己的內容與規則。',
  'scripts/skip-dirs-roster.test.ts':
    '共用排除層名冊(#13),豁免清單是依模板當下每一支掃描器逐項寫的理由;consumer 的掃描器組合不同,那份豁免表在他們那裡不成立。',
  'scripts/shipping-coverage.test.ts':
    '本檔:依賴模板 repo 的 git ls-files、package/ 發布殼與 sync-gates.sh 原始碼,只在上游有意義;在 consumer 那裡根本沒有 package/。',
};

/** 已知缺口是欠帳,不是決定;每一筆按 npx/sync 管道標記,且必須指向待批示裁決。 */
const KNOWN_GAPS: Record<string, KnownGap> = {};

const tmpDirs: string[] = [];
let tracked: string[] = [];
let npxShipped = new Set<string>();
let syncShipped = new Set<string>();
let anyPipelineShipped = new Set<string>();
let requiredBothFiles: string[] = [];

function run(cmd: string, args: string[], cwd: string): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: SETUP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full).split('\\').join('/'));
    }
  };
  walk(root);
  return out;
}

/** 已知缺口指向的裁決,是否還在 DECISIONS_NEEDED.md 的「待批示」段落裡。 */
function pendingDecisionNumbers(): Set<number> {
  const text = readFileSync(join(TEMPLATE_ROOT, 'DECISIONS_NEEDED.md'), 'utf8');
  const start = text.indexOf('## 待批示');
  const end = text.indexOf('## 已批示');
  const section = start >= 0 && end > start ? text.slice(start, end) : '';
  return new Set([...section.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1])));
}

function matchesPrefix(file: string, prefix: string): boolean {
  return prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix;
}

beforeAll(() => {
  const ls = run('git', ['ls-files'], TEMPLATE_ROOT);
  if (ls.code !== 0) throw new Error(`git ls-files 失敗(這支只能在模板 repo 裡跑):\n${ls.out}`);
  tracked = ls.out.split('\n').filter(Boolean).sort();

  const base = mkdtempSync(join(tmpdir(), 'dp-shipping-coverage-'));
  tmpDirs.push(base);
  const repo = join(base, 'repo');
  const art = join(base, 'art');
  const consumer = join(base, 'consumer');
  mkdirSync(art, { recursive: true });
  mkdirSync(consumer, { recursive: true });
  // 只複製 tracked 檔:出貨的母體就是 tracked 檔,不含未追蹤的雜物(P-92)。
  for (const f of tracked) {
    const dest = join(repo, f);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(TEMPLATE_ROOT, f), dest);
  }

  // (1) npx:真的 npm pack,讀 tarball。npm 會把 .gitignore / .npmrc 改名存放(transport alias),這裡換回來。
  const pack = run('npm', ['pack', '--json', '--pack-destination', art], join(repo, 'package'));
  if (pack.code !== 0) throw new Error(`npm pack 失敗:\n${pack.out}`);
  const tgz = readdirSync(art).find((n) => n.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack 沒有產出 tarball:\n${pack.out}`);
  const tar = run('tar', ['-tzf', join(art, tgz)], base);
  if (tar.code !== 0) throw new Error(`tar -tzf 失敗:\n${tar.out}`);
  const alias = new Map([['gitignore', '.gitignore'], ['npmrc', '.npmrc']]);
  npxShipped = new Set(
    tar.out
      .split('\n')
      .map((l) => l.match(/^package\/dist\/template\/(.+)$/)?.[1])
      .filter((p): p is string => Boolean(p))
      .map((p) => alias.get(p) ?? p),
  );

  // (2) sync:真的跑一次,看 consumer 落地了哪些檔。
  const init = run('git', ['init', '-q', '.'], consumer);
  if (init.code !== 0) throw new Error(`git init 失敗:\n${init.out}`);
  const sync = run('bash', [join(repo, 'scripts', 'sync-gates.sh'), consumer, 'scripts', '--lang', 'ts,py'], repo);
  if (sync.code !== 0) throw new Error(`sync-gates.sh 失敗:\n${sync.out}`);
  syncShipped = new Set(listFiles(consumer));

  anyPipelineShipped = new Set([...npxShipped, ...syncShipped]);
  requiredBothFiles = tracked.filter((file) => REQUIRED_BOTH_SHIPPED.some((prefix) => matchesPrefix(file, prefix)));
}, SETUP_TIMEOUT_MS);

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('出貨覆蓋名冊:每個 tracked 檔都要能回答「它靠什麼到 consumer 手上」', () => {
  it('陽性對照:兩個管道都真的有出貨東西(量到 0 是量法壞了,不是很乾淨)', () => {
    expect(tracked.length).toBeGreaterThan(0);
    expect(npxShipped.size, 'npm pack 的 tarball 裡沒有任何 dist/template/ 檔').toBeGreaterThan(20);
    expect(syncShipped.size, 'sync-gates.sh 沒有落地任何檔').toBeGreaterThan(10);
  });

  it.each(REQUIRED_BOTH_SHIPPED)('受管檔類別 %s 至少有一個 tracked 檔', (prefix) => {
    expect(tracked.some((file) => matchesPrefix(file, prefix)), prefix + ' 沒有對到任何 tracked 檔').toBe(true);
  });

  it('每一個受管非守門檔都必須由 npx 與 sync 兩個管道都出貨', () => {
    expect(requiredBothFiles.length, '受管非守門檔清單量到 0,測試資料或追蹤清單壞了').toBeGreaterThan(0);
    const missingNpx = requiredBothFiles.filter((file) => !npxShipped.has(file));
    const missingSync = requiredBothFiles.filter((file) => !syncShipped.has(file));
    expect(
      { npx: missingNpx, sync: missingSync },
      '受管檔雙管道出貨缺口(npx / sync)',
    ).toEqual({ npx: [], sync: [] });
  });

  it('沒有未分類的 tracked 檔(不是出貨、不是刻意不出貨、也不是已知缺口)', () => {
    const unclassified = tracked.filter(
      (f) =>
        !anyPipelineShipped.has(f) &&
        !requiredBothFiles.includes(f) &&
        !Object.keys(NOT_SHIPPED).some((p) => matchesPrefix(f, p)) &&
        !Object.prototype.hasOwnProperty.call(KNOWN_GAPS, f),
    );
    expect(
      unclassified,
      `這些檔在 repo 裡、卻不在任何出貨集合,也沒有被宣告為刻意不出貨或已知缺口。` +
        `每一個都要能回答「它靠什麼到 consumer 手上」:要嘛讓它出貨,要嘛加進 NOT_SHIPPED 寫理由,` +
        `要嘛加進 KNOWN_GAPS 並開一件 DECISIONS_NEEDED。`,
    ).toEqual([]);
  });

  it.each(Object.entries(NOT_SHIPPED))('刻意不出貨 %s:理由夠長、有對到 tracked 檔、而且真的沒出貨', (prefix, reason) => {
    expect(reason.trim().length, `${prefix} 的理由太短——豁免要貴一點`).toBeGreaterThanOrEqual(MIN_REASON_LENGTH);
    const hits = tracked.filter((f) => matchesPrefix(f, prefix));
    expect(hits.length, `${prefix} 沒有對到任何 tracked 檔(改名或刪檔後殘留的豁免)`).toBeGreaterThan(0);
    const contradicted = hits.filter((f) => anyPipelineShipped.has(f));
    expect(contradicted, `${prefix} 宣告「不出貨」,但這些檔實際有出貨——兩個說法打架`).toEqual([]);
  });

  it.each(Object.entries(KNOWN_GAPS))('已知缺口 %s:按管道仍沒出貨、指向的裁決仍在待批示', (file, gap) => {
    expect(tracked.includes(file), file + ' 已不是 tracked 檔(改名或刪檔後殘留的缺口登記)').toBe(true);
    const entries = (['npx', 'sync'] as const).filter((pipeline) => gap[pipeline]);
    expect(entries.length, file + ' 沒有標記任何管道缺口').toBeGreaterThan(0);
    for (const pipeline of entries) {
      const detail = gap[pipeline]!;
      const shippedByPipeline = pipeline === 'npx' ? npxShipped : syncShipped;
      expect(detail.reason.trim().length, file + '(' + pipeline + ') 的缺口理由太短').toBeGreaterThanOrEqual(MIN_REASON_LENGTH);
      expect(
        shippedByPipeline.has(file),
        file + '(' + pipeline + ') 已經有出貨了——缺口補上了,把這筆從 KNOWN_GAPS 拿掉',
      ).toBe(false);
      expect(
        pendingDecisionNumbers().has(detail.decision),
        file + '(' + pipeline + ') 指向 DECISIONS_NEEDED #' + detail.decision + ',但那件已不在「待批示」。' +
          '裁決已經做了,回頭把這個缺口改成「已出貨」或「刻意不出貨」——欠帳不能在裁決之後繼續掛著。',
      ).toBe(true);
    }
  });
});
