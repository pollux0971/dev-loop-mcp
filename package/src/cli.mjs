#!/usr/bin/env node

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_MANIFEST = ".npx-init-manifest.json";
const TRANSPORT_ALIASES = new Map([[".gitignore", "gitignore"], [".npmrc", "npmrc"]]);
const SOURCE_RE = /^(\/\/|#) SOURCE: template v/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";

async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function isFile(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } }

async function filesUnder(root) {
  const result = [];
  const visit = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) result.push(full);
    }
  };
  if (await exists(root)) await visit(root);
  return result;
}

function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") { i += 1; source += "(?:.*/)?"; }
      else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

async function expandEntry(sourceRoot, entry) {
  let root = path.resolve(sourceRoot, entry.root);
  if (TRANSPORT_ALIASES.has(entry.root) && !await isFile(root)) {
    const transportAlias = path.resolve(sourceRoot, TRANSPORT_ALIASES.get(entry.root));
    if (await isFile(transportAlias)) root = transportAlias;
  }
  const includes = entry.include ?? ["**/*"];
  const files = [];
  if (await isFile(root)) return [root];
  for (const include of includes) {
    const exact = path.resolve(root, include);
    if (!/[?*]/.test(include) && await isFile(exact)) { files.push(exact); continue; }
    const matcher = globToRegExp(include.replaceAll(path.sep, "/"));
    for (const candidate of await filesUnder(root)) {
      const relative = path.relative(root, candidate).split(path.sep).join("/");
      if (matcher.test(relative)) files.push(candidate);
    }
  }
  return [...new Set(files)].sort();
}

function render(text, target) {
  const projectName = path.basename(target) || "new-project";
  const today = new Date().toISOString().slice(0, 10);
  return text.replaceAll("{{PROJECT_NAME}}", projectName).replaceAll("{{TODAY}}", today);
}

function sourceHeader(version, commit, body, extension) {
  const marker = extension === ".py" ? "#" : "//";
  return `${marker} SOURCE: template v${version} (${commit}) sha256=${sha256(body)} — 勿手改;升版用 sync-gates.sh\n${body}`;
}

async function templateContext() {
  const packageInfo = await readJson(path.join(PACKAGE_ROOT, "package.json"));
  const distRoot = path.join(PACKAGE_ROOT, "dist", "template");
  const sourceRoot = await exists(path.join(distRoot, "VERSION")) ? distRoot : path.resolve(PACKAGE_ROOT, "..");
  const version = (await fs.readFile(path.join(sourceRoot, "VERSION"), "utf8")).trim();
  if (packageInfo.version !== version) throw new Error(`版本不一致: package/package.json=${packageInfo.version}, VERSION=${version}`);
  const manifest = await readJson(path.join(PACKAGE_ROOT, "payload-manifest.json"));
  let commit = "unknown";
  if (process.env.INIT_TEMPLATE_COMMIT) commit = process.env.INIT_TEMPLATE_COMMIT.replace(/[()\s]/g, "-");
  return { packageInfo, sourceRoot, version, manifest, commit };
}

async function managedPaths(target) {
  const file = path.join(target, INSTALL_MANIFEST);
  if (!await isFile(file)) return new Set();
  try {
    const installed = await readJson(file);
    const paths = new Set(installed.files?.map((entry) => entry.path) ?? []);
    if (installed.manifestVersion === 1 && installed.templateVersion) paths.add(INSTALL_MANIFEST);
    return paths;
  } catch { return new Set(); }
}

function safeRelative(relative) {
  const normalized = path.posix.normalize(relative.replaceAll(path.sep, "/"));
  return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && !path.posix.isAbsolute(normalized);
}

async function packagePlan(sourceRoot, target) {
  const sourcePackage = JSON.parse(render(await fs.readFile(path.join(sourceRoot, "package.json"), "utf8"), target));
  const destination = path.join(target, "package.json");
  if (!await isFile(destination)) return { body: json(sourcePackage), conflicts: [] };
  const current = await readJson(destination);
  const merged = structuredClone(current);
  const conflicts = [];
  for (const section of ["scripts", "devDependencies"]) {
    const proposed = sourcePackage[section] ?? {};
    merged[section] ??= {};
    for (const [key, value] of Object.entries(proposed)) {
      if (!(key in merged[section])) merged[section][key] = value;
      else if (JSON.stringify(merged[section][key]) !== JSON.stringify(value)) conflicts.push(`package.json ${section}.${key}: existing=${JSON.stringify(merged[section][key])} proposed=${JSON.stringify(value)}`);
    }
  }
  return { body: json(merged), conflicts };
}

async function buildPlan(context, target) {
  const { sourceRoot, manifest, version, commit } = context;
  const outputs = [];
  const seen = new Set();
  const add = (relative, body) => {
    const normalized = relative.split(path.sep).join("/");
    if (!safeRelative(normalized)) throw new Error(`manifest 路徑不安全: ${relative}`);
    if (seen.has(normalized)) return;
    seen.add(normalized); outputs.push({ path: normalized, body, hash: sha256(body) });
  };
  for (const entry of manifest.payload ?? []) {
    if (entry.root === "package.json") continue;
    for (const source of await expandEntry(sourceRoot, entry)) {
      const sourceRelative = path.relative(sourceRoot, source).split(path.sep).join("/");
      const relative = TRANSPORT_ALIASES.get(entry.root) === sourceRelative ? entry.root : sourceRelative;
      let body = render((await fs.readFile(source)).toString("utf8"), target);
      if (relative.startsWith("scripts/") && (relative.endsWith(".ts") || relative.endsWith(".py"))) body = sourceHeader(version, commit, body, path.extname(relative));
      add(relative, body);
    }
  }
  const packageOutput = await packagePlan(sourceRoot, target);
  add("package.json", packageOutput.body);
  for (const conflict of packageOutput.conflicts) outputs.push({ path: "package.json", body: packageOutput.body, hash: sha256(packageOutput.body), packageConflict: conflict });
  return outputs;
}

async function collisionScan(target, plan, owned) {
  const conflicts = [];
  for (const output of plan) {
    const destination = path.join(target, output.path);
    if (!await exists(destination)) continue;
    if (output.packageConflict) { conflicts.push(output.packageConflict); continue; }
    if (output.path === "package.json" || owned.has(output.path)) continue;
    const firstLine = (await fs.readFile(destination, "utf8")).split(/\r?\n/, 1)[0];
    if (!SOURCE_RE.test(firstLine)) conflicts.push(`✗ ${output.path} 已存在且沒有 SOURCE 標頭(是 consumer 自有檔)`);
  }
  const manifestDestination = path.join(target, INSTALL_MANIFEST);
  if (await isFile(manifestDestination) && !owned.has(INSTALL_MANIFEST)) conflicts.push(`✗ ${INSTALL_MANIFEST} 已存在且不是 init 建立的 manifest`);
  return [...new Set(conflicts)];
}

function manifestBody(context, plan) {
  const base = { manifestVersion: 1, packageVersion: context.packageInfo.version, templateVersion: context.version, source: "VERSION", generatedBy: "npx init", files: plan.map(({ path: relative, hash }) => ({ path: relative, sha256: hash })), manifestSha256: null };
  base.manifestSha256 = sha256(json(base));
  return json(base);
}

async function commitPlan(target, plan, manifest, failAfter = 0) {
  const stage = await fs.mkdtemp(path.join(target, ".npx-init-stage-"));
  const journalPath = path.join(target, ".npx-init-journal.json");
  const backup = path.join(stage, ".backup");
  const journal = { version: 1, stage, backup, operations: [] };
  const writeJournal = () => fs.writeFile(journalPath, json(journal), "utf8");
  try {
    const all = [...plan, { path: INSTALL_MANIFEST, body: manifest, hash: sha256(manifest) }];
    for (const output of all) {
      const staged = path.join(stage, output.path);
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await fs.writeFile(staged, output.body, "utf8");
    }
    await writeJournal();
    let committed = 0;
    for (const output of all) {
      const destination = path.join(target, output.path);
      const staged = path.join(stage, output.path);
      const backupPath = path.join(backup, output.path);
      const operation = { path: output.path, destination, backupPath, hadExisting: await exists(destination), moved: false, installed: false };
      journal.operations.push(operation); await writeJournal();
      if (operation.hadExisting) { await fs.mkdir(path.dirname(backupPath), { recursive: true }); await fs.rename(destination, backupPath); operation.moved = true; await writeJournal(); }
      await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.rename(staged, destination); operation.installed = true; committed += 1; await writeJournal();
      if (failAfter > 0 && committed >= failAfter) throw new Error(`測試用中途失敗: ${failAfter}`);
    }
    await fs.rm(stage, { recursive: true, force: true }); await fs.rm(journalPath, { force: true });
  } catch (error) {
    for (const operation of [...journal.operations].reverse()) {
      try { if (operation.installed) await fs.rm(operation.destination, { force: true }); if (operation.moved) { await fs.mkdir(path.dirname(operation.destination), { recursive: true }); await fs.rename(operation.backupPath, operation.destination); } } catch (rollbackError) { console.error(`✗ rollback 失敗 ${operation.path}: ${rollbackError.message}`); }
    }
    await fs.rm(stage, { recursive: true, force: true }); await fs.rm(journalPath, { force: true }); throw error;
  }
}

async function init(target, options) {
  const context = await templateContext();
  if (!await exists(target) || !(await fs.stat(target)).isDirectory()) throw new Error(`目標不是既有資料夾: ${target}`);
  const plan = await buildPlan(context, target);
  const conflicts = await collisionScan(target, plan, await managedPaths(target));
  if (conflicts.length) { console.error("✗ init 先掃後寫發現衝突(零寫入):"); for (const conflict of conflicts) console.error(conflict); process.exitCode = 1; return; }
  const manifest = manifestBody(context, plan);
  if (options.dryRun) { console.log(`✓ plan ${plan.length + 1} paths, template v${context.version}`); for (const output of [...plan, { path: INSTALL_MANIFEST }]) console.log(`  ${output.path}`); return; }
  await commitPlan(target, plan, manifest, Number(process.env.NPX_INIT_FAIL_AFTER || 0));
  console.log(`✓ init 完成: ${plan.length + 1} paths, template v${context.version}`);
  console.log("未執行 npm install 或 git init;請依 README 五步驟繼續。");
}

async function main(argv) {
  const [command = "", ...args] = argv;
  if (command !== "init") throw new Error("用法: node src/cli.mjs init [target] [--yes] [--dry-run]");
  const flags = args.filter((arg) => arg.startsWith("--"));
  const unknown = flags.filter((flag) => !["--yes", "--dry-run"].includes(flag));
  if (unknown.length) throw new Error(`不提供 ${unknown.join(", ")};請改名或刪除衝突檔後重跑`);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) throw new Error("init 只接受一個 target");
  await init(path.resolve(positional[0] ?? process.cwd()), { dryRun: args.includes("--dry-run") });
}

main(process.argv.slice(2)).catch((error) => { console.error(`✗ ${error.message}`); process.exitCode = 1; });
