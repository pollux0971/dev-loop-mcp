// Gherkin 為英文,使用 cucumber 預設語言,不需 language 標頭。
// @cucumber/cucumber 11 的設定檔規則:top-level 的 `export default` 本身就是 "default" 這個
// profile 的內容,不需要(也不能)再包一層 `default: {...}`——包了那一層會讓 paths/import/tags
// 全部被忽略(讀到的是 { default: {...} } 這個物件,none of its keys 對得上 schema),
// cucumber 會安靜地退回內建預設值,而 import 完全不會發生,所有 step 都變成 undefined
// (見 docs/02-decision-map.md ADR-013)。
// 想要額外的 profile 用具名 export(例如 `export const ci = {...}`),不要塞進這個物件裡。
//
// v4:paths 不再寫死。
//   1. 命令列有給 feature 路徑(`npm run accept -- features/x/v1.feature`)時,只跑命令列給的。
//      cucumber 會把設定檔的 paths 和命令列的路徑「合併」,v3 的單一節點驗收因此會連別的節點的場景一起跑。
//   2. 沒給路徑時跑全部,但跳過 .dp/pending-features.json 列的檔:已批准、但節點還沒完成的 gherkin
//      (它們在主線上,實作還沒合併,一定是紅的)。這份清單由 dp 維護,不要手改。
//      v3 實測:兩個以上節點同時在做時,全 gate 的 accept 因為彼此未完成的場景永遠紅,互相卡死。
// 注意:paths 陣列**不支援** `!` 負向排除(PITFALLS P-07),所以在這裡自己列檔。
// _template 的樣板檔用 .feature.template 副檔名,自然不會被 *.feature 掃到;複製後要改名。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['features', 'docs/integration'];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name).split('\\').join('/');
    if (statSync(p).isDirectory()) return name.startsWith('_') ? [] : walk(p);
    return p.endsWith('.feature') ? [p] : [];
  });
}

function pendingFeatures() {
  try {
    return new Set(JSON.parse(readFileSync('.dp/pending-features.json', 'utf8')));
  } catch {
    return new Set();
  }
}

const cliPaths = process.argv.slice(2).filter((a) => !a.startsWith('-') && existsSync(a.replace(/(:\d+)+$/, '')));
const pending = pendingFeatures();
const all = ROOTS.flatMap(walk).filter((p) => !pending.has(p));

export default {
  // 全部都被跳過時給一個不存在的 glob:paths 空陣列會讓 cucumber 退回它自己的預設(features/**)
  paths: cliPaths.length ? [] : all.length ? all : ['features/__none__/*.feature'],
  import: ['features/steps/**/*.ts'],
  tags: 'not @manual',
  format: ['progress'],
};
