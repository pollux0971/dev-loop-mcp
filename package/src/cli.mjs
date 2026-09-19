#!/usr/bin/env node

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_MANIFEST = ".npx-init-manifest.json";
const SOURCE_RE = /^(\/\/|#) SOURCE: template v/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";

export function transportAlias(payloadPath) {
  const normalized = payloadPath.replaceAll(path.sep, "/");
  const basename = path.posix.basename(normalized);
  if (basename !== ".gitignore" && basename !== ".npmrc") return normalized;
  return path.posix.join(path.posix.dirname(normalized), basename.slice(1));
}

function restoreTransportAlias(transportPath) {
  const normalized = transportPath.replaceAll(path.sep, "/");
  const basename = path.posix.basename(normalized);
  if (basename !== "gitignore" && basename !== "npmrc") return normalized;
  return path.posix.join(path.posix.dirname(normalized), `.${basename}`);
}

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
  if (!await isFile(root)) {
    const transportPath = transportAlias(entry.root);
    const transportRoot = path.resolve(sourceRoot, transportPath);
    if (transportPath !== entry.root && await isFile(transportRoot)) root = transportRoot;
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
  const expanded = [...new Set(files)].sort();
  // 1.7.1(P-97 發作後修):一個 manifest 條目展開成零個檔,一定是寫錯或來源不在——大聲失敗。
  // 原本 filesUnder 對不存在的 root 靜默回傳 [],實測過一次:舊的 package/dist/ 快照裡沒有新條目的路徑,
  // init 少落地一個 DECISIONS_NEEDED.md、印「✓ init 完成」、exit 0。零輸入不是很乾淨,是掃描器壞了(P-32)。
  if (expanded.length === 0) throw new Error(`manifest 條目「${entry.root}」展開成 0 個檔(來源根目錄:${sourceRoot})。` +
    `可能是條目寫錯,或 package/dist/ 是舊快照——刪掉 package/dist/ 或重跑 npm pack 再試。`);
  return expanded;
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
  if (!await isFile(file)) return new Map();
  try {
    const installed = await readJson(file);
    // 1.7.1:回傳「路徑 → 安裝當時的內容雜湊」。原本只回傳路徑集合,衝突掃描因此無從得知使用者有沒有改過。
    const paths = new Map((installed.files ?? []).map((entry) => [entry.path, entry.sha256 ?? null]));
    if (installed.manifestVersion === 1 && installed.templateVersion) paths.set(INSTALL_MANIFEST, null);
    return paths;
  } catch { return new Map(); }
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
      // 1.7.1:單檔條目可用 `dest` 指定落地路徑(例:空白骨架 package/skeleton/DECISIONS_NEEDED.md → DECISIONS_NEEDED.md)。
      const relative = entry.dest ?? (transportAlias(entry.root) === sourceRelative
        ? entry.root
        : restoreTransportAlias(sourceRelative));
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
    if (output.path === "package.json") continue; // package.json 走保守 merge,衝突在 packagePlan 列出
    if (owned.has(output.path)) {
      // 1.7.1(資料遺失 bug):原本「在安裝紀錄裡」就直接放行覆蓋。【驗】使用者在 init 裝好的 CLAUDE.md
      // 加了一行,再跑一次 init → 印「✓ init 完成」、exit 0,而那一行被模板原文蓋掉。安裝紀錄明明記了
      // 每個檔的 sha256,只是從來沒拿來比。現在:內容已經是這一版 → 不動;跟安裝當時一樣(使用者沒碰)
      // → 可以更新;都不是 → 使用者改過,列為衝突、零寫入。
      const current = sha256(await fs.readFile(destination, "utf8"));
      if (current === output.hash) continue;
      if (owned.get(output.path) && current === owned.get(output.path)) continue;
      conflicts.push(`✗ ${output.path} 是 init 裝的,但裝完之後被改過(內容與安裝紀錄不符)——不覆蓋你的修改`);
      continue;
    }
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
    const candidates = [...plan, { path: INSTALL_MANIFEST, body: manifest, hash: sha256(manifest) }];
    // 1.7.1:內容已經相同的檔不重寫——重跑 init 應該是真的 no-op(原本會把每個檔 rename 一次,修改時間全變)。
    const all = [];
    for (const output of candidates) {
      const destination = path.join(target, output.path);
      if (await isFile(destination) && sha256(await fs.readFile(destination, "utf8")) === output.hash) continue;
      all.push(output);
    }
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
  console.log("未執行 npm install 或 git init;請從 README「步驟 1」繼續(步驟 0 的複製已經由 init 完成)。");
}

const USAGE = [
  "用法: pollux-dev-paradigm init [target] [--dry-run] [--yes]",
  "",
  "  init [target]   把開發範式落地到 target(預設目前目錄)。只支援全新專案;不執行 npm install 或 git init。",
  "  --dry-run       只列出會建立哪些檔,不寫入。",
  "  --yes           接受預設值,不互動(CI 用)。",
  "",
  "  私有 GitHub 安裝:npx github:pollux0971/dev-paradigm#npx-v<版本> init .",
  "  落地後照 README「步驟 1」往下做(步驟 0 的複製已經由 init 完成)。",
].join("\n");

async function main(argv) {
  const [command = "", ...args] = argv;
  if (command === "--help" || command === "-h" || command === "help") { console.log(USAGE); return; }
  if (command !== "init") throw new Error(`不認得的指令「${command || "(空白)"}」。\n${USAGE}`);
  const flags = args.filter((arg) => arg.startsWith("--"));
  const unknown = flags.filter((flag) => !["--yes", "--dry-run"].includes(flag));
  if (unknown.length) throw new Error(`不提供 ${unknown.join(", ")};請改名或刪除衝突檔後重跑`);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) throw new Error("init 只接受一個 target");
  await init(path.resolve(positional[0] ?? process.cwd()), { dryRun: args.includes("--dry-run") });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`✗ ${error.message}`); process.exitCode = 1; });
}
