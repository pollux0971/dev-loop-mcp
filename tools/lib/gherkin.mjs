// 只做 dlm 需要的部分:找出場景、它們的 tag(含 Feature 層 tag)、行號與步驟。不是完整 parser。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function scanGherkin(text) {
  const lines = text.split('\n');
  const scenarios = [];
  let featureTags = [];
  let pendingTags = [];
  let current = null;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('#') || !line) return;
    if (line.startsWith('@')) {
      pendingTags.push(...line.split(/\s+/).filter((t) => t.startsWith('@')));
      return;
    }
    if (/^Feature:/.test(line)) {
      featureTags = pendingTags;
      pendingTags = [];
      return;
    }
    const m = /^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/.exec(line);
    if (m) {
      current = { name: m[2], line: i + 1, tags: [...new Set([...featureTags, ...pendingTags])], steps: [] };
      scenarios.push(current);
      pendingTags = [];
      return;
    }
    if (/^(Background|Rule):/.test(line)) {
      current = null;
      pendingTags = [];
      return;
    }
    if (current && /^(Given|When|Then|And|But|\*)\b/.test(line)) current.steps.push(line);
  });
  return scenarios;
}

export function readScenarios(root, relPath) {
  const p = join(root, relPath);
  if (!existsSync(p)) return [];
  return scanGherkin(readFileSync(p, 'utf8')).map((s) => ({ ...s, file: relPath }));
}
