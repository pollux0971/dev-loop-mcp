// Fake cucumber dry-run: with FAKE_DRY=undefined it prints a summary line with unbound steps (cucumber still exits 0 then).
const mode = process.env.FAKE_DRY ?? 'ok';
console.log(mode === 'undefined' ? '1 scenario (1 undefined)\n2 steps (1 undefined, 1 skipped)' : '1 scenario (1 skipped)\n2 steps (2 skipped)');
