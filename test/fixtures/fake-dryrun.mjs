// 假的 cucumber dry-run:FAKE_DRY=undefined 時印出有未綁定步驟的摘要行(cucumber 這時仍然 exit 0)。
const mode = process.env.FAKE_DRY ?? 'ok';
console.log(mode === 'undefined' ? '1 scenario (1 undefined)\n2 steps (1 undefined, 1 skipped)' : '1 scenario (1 skipped)\n2 steps (2 skipped)');
