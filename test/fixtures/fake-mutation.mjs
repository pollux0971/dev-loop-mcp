// Fake stryker: writes a report in mutation-testing-report-schema format based on FAKE_SCORE (a percentage). argv[2] is {files}.
import { mkdirSync, writeFileSync } from 'node:fs';
const score = Number(process.env.FAKE_SCORE ?? 100);
const files = (process.argv[2] ?? '').split(',').filter(Boolean);
const killed = Math.round(score / 10);
const mutants = [
  ...Array.from({ length: killed }, (_, i) => ({ id: `k${i}`, status: 'Killed' })),
  ...Array.from({ length: 10 - killed }, (_, i) => ({ id: `s${i}`, status: 'Survived' })),
];
mkdirSync('reports/mutation', { recursive: true });
writeFileSync('reports/mutation/mutation.json', JSON.stringify({ schemaVersion: '1', files: Object.fromEntries(files.map((f) => [f, { mutants }])) }));
console.log(`mutated ${files.join(',')} score ${score}`);
