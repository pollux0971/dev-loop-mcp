// v4.7 這台電腦上的 dlm 專案清單(~/.config/dlm/projects.json,DLM_PROJECTS_FILE 可改)。dlm hub 照這份清單監控、操作。
// 清單只記名稱和路徑;專案自己的設定、帳本都還在各自的 repo 裡。
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { configDir } from './accounts.mjs';
import { isLegacyProject, projectCli, projectPaths } from './legacy.mjs';
import { DlmError, readJson, writeJson } from './util.mjs';

export const projectsFile = () => process.env.DLM_PROJECTS_FILE || join(configDir(), 'projects.json');

export function loadProjects() {
  return readJson(projectsFile(), { projects: {} }).projects ?? {};
}
function save(projects) {
  mkdirSync(dirname(projectsFile()), { recursive: true });
  writeJson(projectsFile(), { projects });
}

const NAME = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;
const realpath = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const nameFrom = (path) => basename(path).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40) || 'project';

export function isDlmProject(path) {
  // A project from before 4.8.0 (dp.config.json + tools/dp.mjs) still counts: the hub and MCP run it through its own CLI until it is upgraded
  return existsSync(projectPaths(path).config) && projectCli(path) !== null;
}

export { isLegacyProject };

/** 專案裝的 dlm 版本(看 .dlm-install.json;舊專案沒有就 null)。 */
export function projectVersion(path) {
  const m = readJson(projectPaths(path).manifest, null);
  if (m?.version) return m.version;
  const v = join(path, 'VERSION');
  return existsSync(v) ? readFileSync(v, 'utf8').trim() : null;
}

/** 登記一個專案。同一個路徑登記第二次 → 回原本那筆(不重複)。 */
export function addProject(path, { name = null } = {}) {
  const abs = realpath(resolve(path));
  if (!isDlmProject(abs)) throw new DlmError(`${abs} 不是 dlm 專案(要有 dlm.config.json 與 tools/dlm.mjs;先 dlm init)`);
  const projects = loadProjects();
  const same = Object.entries(projects).find(([, p]) => p.path === abs);
  if (same) return { name: same[0], ...same[1], existed: true };
  let n = name ?? nameFrom(abs);
  if (!NAME.test(n)) throw new DlmError('專案名稱只能用英數、. - _(40 字內)');
  if (projects[n]) {
    if (name) throw new DlmError(`已經有叫「${n}」的專案(${projects[n].path})`);
    let i = 2;
    while (projects[`${n}-${i}`]) i++;
    n = `${n}-${i}`;
  }
  projects[n] = { path: abs, added: new Date().toISOString() };
  save(projects);
  return { name: n, ...projects[n], existed: false };
}

export function removeProject(name) {
  const projects = loadProjects();
  if (!projects[name]) throw new DlmError(`沒有專案「${name}」`);
  const { path } = projects[name];
  delete projects[name];
  save(projects);
  return { removed: name, path, note: '只從清單拿掉;專案的檔案、帳本都沒動' };
}

/** 名稱 → 路徑。找不到丟 DlmError(code 3 = 404)。 */
export function resolveProject(nameOrPath) {
  const projects = loadProjects();
  if (projects[nameOrPath]) return { name: nameOrPath, ...projects[nameOrPath] };
  const abs = realpath(resolve(nameOrPath));
  const hit = Object.entries(projects).find(([, p]) => p.path === abs);
  if (hit) return { name: hit[0], ...hit[1] };
  throw new DlmError(`沒有專案「${nameOrPath}」(dlm project list 看有哪些;dlm project add <目錄> 加進來)`, 3);
}

/** 路徑 → 清單裡的名稱(沒登記就 null)。 */
export function projectNameOf(path) {
  const abs = realpath(path);
  return Object.entries(loadProjects()).find(([, p]) => p.path === abs)?.[0] ?? null;
}
