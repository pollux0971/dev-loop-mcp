// Gherkin 為英文,使用 cucumber 預設語言,不需 language 標頭。
// @cucumber/cucumber 11 的設定檔規則:top-level 的 `export default` 本身就是 "default" 這個
// profile 的內容,不需要(也不能)再包一層 `default: {...}`——包了那一層會讓 paths/import/tags
// 全部被忽略(讀到的是 { default: {...} } 這個物件,none of its keys 對得上 schema),
// cucumber 會安靜地退回內建預設值,而 import 完全不會發生,所有 step 都變成 undefined
// (見 docs/02-decision-map.md ADR-013)。
// 想要額外的 profile 用具名 export(例如 `export const ci = {...}`),不要塞進這個物件裡。
export default {
  // 排除 features/_template/**,否則每次跑驗收都會多出幾個 undefined 的示範場景當噪音。
  // 注意:paths 陣列**不支援** `!` 負向排除(會被原樣回顯但不生效,PITFALLS P-07)。
  // _template 的樣板檔用 .feature.template 副檔名,自然不會被 *.feature 掃到;複製後要改名。
  paths: ['features/**/*.feature', 'docs/integration/**/*.feature'],
  import: ['features/steps/**/*.ts'],
  tags: 'not @manual',
  format: ['progress'],
};
