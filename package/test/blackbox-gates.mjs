#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..");
const MANIFEST_FILE = path.join(PACKAGE_ROOT, "payload-manifest.json");
const SOURCE_HEADER = /^(\/\/|#) SOURCE: template v[0-9]+\.[0-9]+\.[0-9]+ \([^)]*\) sha256=[0-9a-f]{64}/;
const PLACEHOLDER = /\{\{[^{}\n]+\}\}/g;
const TRANSPORT_ALIAS = new Map([[".gitignore", "gitignore"], [".npmrc", "npmrc"]]);

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sorted(values) { return [...values].sort(); }

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function filesUnder(root) {
  const result = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) result.push(full);
    }
  }
  if (await isFile(root)) return [root];
  if (await fs.stat(root).catch(() => null)) await visit(root);
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

async function expandManifest(sourceRoot, manifest) {
  const paths = [];
  for (const entry of manifest.payload ?? []) {
    let root = path.resolve(sourceRoot, entry.root);
    if (entry.root === ".gitignore" && !await isFile(root)) root = path.resolve(sourceRoot, "gitignore");
    if (await isFile(root)) {
      paths.push(entry.root);
      continue;
    }
    for (const include of entry.include ?? ["**/*"]) {
      const exact = path.resolve(root, include);
      if (!/[?*]/.test(include) && await isFile(exact)) {
        paths.push(path.relative(sourceRoot, exact).split(path.sep).join("/"));
        continue;
      }
      const matcher = globToRegExp(include.replaceAll(path.sep, "/"));
      for (const candidate of await filesUnder(root)) {
        const relative = path.relative(root, candidate).split(path.sep).join("/");
        if (matcher.test(relative)) paths.push(path.relative(sourceRoot, candidate).split(path.sep).join("/"));
      }
    }
  }
  return sorted(new Set(paths));
}

async function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

async function runRaw(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout: Buffer.concat(stdout), stderr }));
  });
}

function output(result) { return `${result.stdout}${result.stderr}`; }
function requireLine(result, line) { assert.match(output(result), new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), `missing explicit success line: ${line}`); }

async function makeTemp(label) { return fs.mkdtemp(path.join(os.tmpdir(), `npx-init-${label}-`)); }

async function copyRepo(destination) {
  await fs.cp(REPO_ROOT, destination, {
    recursive: true,
    filter(source) {
      const relative = path.relative(REPO_ROOT, source).split(path.sep).join("/");
      if (!relative) return true;
      if (relative === ".git" || relative.startsWith(".git/")) return false;
      if (relative === "node_modules" || relative.startsWith("node_modules/")) return false;
      if (relative === "package/dist" || relative.startsWith("package/dist/")) return false;
      if (relative.startsWith("package/") && relative.endsWith(".tgz")) return false;
      return true;
    },
  });
}

async function packArtifact() {
  const temp = await makeTemp("pack");
  const repo = path.join(temp, "repo");
  await copyRepo(repo);
  const artifactDir = path.join(temp, "artifacts");
  await fs.mkdir(artifactDir);
  const result = await run("npm", ["pack", "--json", "--pack-destination", artifactDir], { cwd: path.join(repo, "package") });
  assert.equal(result.code, 0, `npm pack failed:\n${output(result)}`);
  const metadata = JSON.parse(result.stdout);
  const tarball = path.join(artifactDir, metadata[0].filename);
  assert.ok(await isFile(tarball), `npm pack did not create ${tarball}`);
  return { temp, repo, tarball, packageDir: path.join(repo, "package"), metadata: metadata[0] };
}

async function tarEntries(tarball) {
  const result = await run("tar", ["-tzf", tarball]);
  assert.equal(result.code, 0, `tar listing failed:\n${output(result)}`);
  return result.stdout.split(/\r?\n/).filter((entry) => entry && !entry.endsWith("/")).map((entry) => entry.replace(/^package\//, ""));
}

async function unpack(tarball, destination) {
  await fs.mkdir(destination, { recursive: true });
  const result = await run("tar", ["-xzf", tarball, "-C", destination]);
  assert.equal(result.code, 0, `tar extraction failed:\n${output(result)}`);
  return path.join(destination, "package");
}

function payloadArchivePath(payloadPath) { return `dist/template/${TRANSPORT_ALIAS.get(payloadPath) ?? payloadPath}`; }

function excluded(payloadPath, excludes) {
  return excludes.some((pattern) => {
    if (pattern.endsWith("/")) return payloadPath.startsWith(pattern);
    return globToRegExp(pattern).test(payloadPath);
  });
}

async function gateTarball(artifact) {
  const manifest = JSON.parse(await fs.readFile(path.join(artifact.packageDir, "payload-manifest.json"), "utf8"));
  const payload = await expandManifest(path.resolve(artifact.repo), manifest);
  const expected = sorted(["README.md", "package.json", "payload-manifest.json", "src/cli.mjs", ...payload.map(payloadArchivePath)]);
  const actual = sorted(await tarEntries(artifact.tarball));
  assert.deepEqual(actual, expected, `tarball path multiset differs (expected ${expected.length}, actual ${actual.length})`);
  for (const payloadPath of payload) {
    assert.equal(excluded(payloadPath, manifest.exclude ?? []), false, `manifest payload hits exclude: ${payloadPath}`);
    const archivePath = payloadArchivePath(payloadPath);
    const staged = path.join(artifact.packageDir, "dist", "template", TRANSPORT_ALIAS.get(payloadPath) ?? payloadPath);
    const archive = await runRaw("tar", ["-xOzf", artifact.tarball, `package/${archivePath}`]);
    assert.equal(archive.code, 0, `cannot read tarball member ${archivePath}`);
    assert.equal(sha256(archive.stdout), sha256(await fs.readFile(staged)), `tarball bytes differ: ${archivePath}`);
  }
  for (const entry of actual) {
    const payloadPath = entry.startsWith("dist/template/") ? entry.slice("dist/template/".length) : null;
    if (payloadPath) assert.equal(excluded(payloadPath, manifest.exclude ?? []), false, `tarball member hits exclude: ${payloadPath}`);
  }
  return { manifest, payload };
}

async function snapshot(root) {
  const result = new Map();
  for (const file of await filesUnder(root)) {
    const stat = await fs.stat(file, { bigint: true });
    result.set(path.relative(root, file), { bytes: await fs.readFile(file), mtimeNs: stat.mtimeNs.toString() });
  }
  return result;
}

async function assertSnapshot(root, before, label) {
  const after = await snapshot(root);
  assert.deepEqual(sorted([...after.keys()]), sorted([...before.keys()]), `${label}: file set changed`);
  for (const [relative, previous] of before) {
    const current = after.get(relative);
    assert.deepEqual(current.bytes, previous.bytes, `${label}: bytes changed: ${relative}`);
    assert.equal(current.mtimeNs, previous.mtimeNs, `${label}: mtime changed: ${relative}`);
  }
}

function checklistPlaceholders(checklist) {
  const allowed = new Set(["{{FEATURE_NAME}}"]).add("{{PROJECT_NAME}}");
  const numbered = new Map();
  for (const token of checklist.match(PLACEHOLDER) ?? []) {
    const inner = token.slice(2, -2);
    const range = inner.match(/^(.*?)(\d+)\.\.(\d+)$/);
    if (range) {
      for (let n = Number(range[2]); n <= Number(range[3]); n += 1) allowed.add(`{{${range[1]}${n}}}`);
      continue;
    }
    const pieces = inner.split("/");
    const first = pieces.shift();
    allowed.add(`{{${first}}}`);
    const prefix = first.match(/^(.*?\D)\d+$/)?.[1];
    for (const piece of pieces) allowed.add(`{{${prefix && /^\d+$/.test(piece) ? prefix + piece : piece}}}`);
    const numberedMatch = first.match(/^(.*_)(\d+)(_.+)$/);
    if (numberedMatch) {
      const key = `${numberedMatch[1]}:${numberedMatch[3]}`;
      const values = numbered.get(key) ?? { prefix: numberedMatch[1], suffix: numberedMatch[3], numbers: [] };
      values.numbers.push(Number(numberedMatch[2]));
      numbered.set(key, values);
    }
  }
  for (const { prefix, suffix, numbers } of numbered.values()) {
    for (let n = Math.min(...numbers); n <= Math.max(...numbers); n += 1) allowed.add(`{{${prefix}${n}${suffix}}}`);
  }
  return allowed;
}

async function assertCleanInstall(packageDir, target, manifest, payload) {
  const cli = path.join(packageDir, "src", "cli.mjs");
  const init = await run(process.execPath, [cli, "init", target]);
  assert.equal(init.code, 0, `clean init failed:\n${output(init)}`);
  assert.match(init.stdout, /^✓ init 完成: \d+ paths, template v\d+\.\d+\.\d+$/m);
  const installed = sorted((await filesUnder(target)).map((file) => path.relative(target, file).split(path.sep).join("/")));
  // 1.7.1:單檔條目可用 `dest` 指定落地路徑,落地集合要套用同一個對應(tarball 仍然是來源路徑)。
  const destOf = new Map((manifest.payload ?? []).filter((e) => e.dest).map((e) => [e.root, e.dest]));
  const expectedInstalled = payload.map((p) => destOf.get(p) ?? p);
  assert.deepEqual(installed, sorted([...expectedInstalled, ".npx-init-manifest.json"]), "installed path set differs from manifest");
  // 1.7.1:新專案的收件匣必須是空的。1.7.0 以前出貨的是上游那份,consumer 一開始就有十幾件模板內部待裁事項。
  const inbox = await fs.readFile(path.join(target, "DECISIONS_NEEDED.md"), "utf8");
  const pendingSection = inbox.slice(inbox.indexOf("## 待批示"), inbox.indexOf("## 已批示"));
  assert.ok(pendingSection.includes("## 待批示"), "落地的 DECISIONS_NEEDED.md 沒有「待批示」段落");
  assert.deepEqual([...pendingSection.matchAll(/^\|\s*\d+\s*\|/gm)].map((m) => m[0]), [], "新專案的收件匣「待批示」不是空的——出貨了上游的內部事項");
  const expectedHeaderFiles = (await filesUnder(path.join(target, "scripts"))).filter((file) => file.endsWith(".ts") || file.endsWith(".py"));
  for (const file of expectedHeaderFiles) assert.match((await fs.readFile(file, "utf8")).split(/\r?\n/, 1)[0], SOURCE_HEADER, `invalid SOURCE header: ${file}`);
  const sync = await run("bash", [path.join(target, "scripts", "sync-gates.sh"), target, "scripts", "--check"]);
  assert.equal(sync.code, 0, `sync-gates --check failed:\n${output(sync)}`);
  requireLine(sync, "✓ 守門內容自同步以來未被更動");
  const checklist = await fs.readFile(path.join(target, "CHECKLIST.md"), "utf8");
  const allowed = checklistPlaceholders(checklist);
  const violations = [];
  for (const file of await filesUnder(target)) {
    const relative = path.relative(target, file).split(path.sep).join("/");
    const tokens = (await fs.readFile(file, "utf8").catch(() => Buffer.alloc(0))).toString().match(PLACEHOLDER) ?? [];
    if (relative === "README.md" || relative === "CHECKLIST.md") continue;
    for (const token of tokens) if (!allowed.has(token)) violations.push(`${relative}:${token}`);
  }
  assert.deepEqual(violations, [], `unwhitelisted placeholders remain: ${violations.join(", ")}`);
  return init;
}

async function gateCleanInit(artifact, manifest, payload) {
  const extracted = await makeTemp("clean");
  const packageDir = await unpack(artifact.tarball, extracted);
  const target = path.join(extracted, "consumer");
  await fs.mkdir(target);
  await assertCleanInstall(packageDir, target, manifest, payload);
}

async function gateConflict(artifact) {
  const extracted = await makeTemp("conflict");
  const packageDir = await unpack(artifact.tarball, extracted);
  const target = path.join(extracted, "consumer");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "README.md"), "consumer-owned README\n");
  await fs.writeFile(path.join(target, "package.json"), JSON.stringify({ name: "consumer", scripts: { boundaries: "consumer-boundaries" }, devDependencies: { tsx: "0.0.0" } }, null, 2) + "\n");
  const before = await snapshot(target);
  const init = await run(process.execPath, [path.join(packageDir, "src", "cli.mjs"), "init", target]);
  assert.notEqual(init.code, 0, "conflicting init unexpectedly succeeded");
  requireLine(init, "✗ init 先掃後寫發現衝突(零寫入):");
  await assertSnapshot(target, before, "conflict zero-write");
}

async function gateRollback(artifact, payload) {
  const failPoints = [1, Math.max(2, payload.length - 1)];
  for (const failAfter of failPoints) {
    const extracted = await makeTemp(`rollback-${failAfter}`);
    const packageDir = await unpack(artifact.tarball, extracted);
    const target = path.join(extracted, "consumer");
    await fs.mkdir(target);
    await fs.mkdir(path.join(target, "local"));
    await fs.writeFile(path.join(target, "local", "sentinel.txt"), `before rollback ${failAfter}\n`);
    const before = await snapshot(target);
    const init = await run(process.execPath, [path.join(packageDir, "src", "cli.mjs"), "init", target], { env: { NPX_INIT_FAIL_AFTER: String(failAfter) } });
    assert.notEqual(init.code, 0, `fail point ${failAfter} unexpectedly succeeded`);
    assert.match(output(init), /測試用中途失敗/);
    await assertSnapshot(target, before, `rollback failAfter=${failAfter}`);
    assert.equal(await isFile(path.join(target, ".npx-init-journal.json")), false, `journal remained at ${failAfter}`);
  }
}

async function probeTarball(artifact, manifest, payload) {
  const mutantDir = await makeTemp("probe-tarball");
  const unpacked = await unpack(artifact.tarball, mutantDir);
  await fs.writeFile(path.join(unpacked, "dist", "template", "probe-extra.txt"), "unexpected payload\n");
  const mutant = path.join(mutantDir, "mutant.tgz");
  const packed = await run("tar", ["-czf", mutant, "package"], { cwd: mutantDir });
  assert.equal(packed.code, 0, output(packed));
  const actual = sorted(await tarEntries(mutant));
  const expected = sorted(["README.md", "package.json", "payload-manifest.json", "src/cli.mjs", ...payload.map(payloadArchivePath)]);
  assert.deepEqual(actual, expected, `tarball path multiset differs (expected ${expected.length}, actual ${actual.length})`);
}

async function probeCleanInit(artifact, manifest, payload) {
  const extracted = await makeTemp("probe-clean");
  const packageDir = await unpack(artifact.tarball, extracted);
  const target = path.join(extracted, "consumer");
  await fs.mkdir(target);
  await assertCleanInstall(packageDir, target, manifest, payload);
  await fs.appendFile(path.join(target, "scripts", "check-boundaries.ts"), "\nprobe mutation\n");
  const sync = await run("bash", [path.join(target, "scripts", "sync-gates.sh"), target, "scripts", "--check"]);
  assert.equal(sync.code, 0, `sync-gates --check failed:\n${output(sync)}`);
  requireLine(sync, "✓ 守門內容自同步以來未被更動");
}

async function probeConflict(artifact) {
  const extracted = await makeTemp("probe-conflict");
  const packageDir = await unpack(artifact.tarball, extracted);
  const target = path.join(extracted, "consumer");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "package.json"), JSON.stringify({ name: "consumer" }) + "\n");
  const before = await snapshot(target);
  const init = await run(process.execPath, [path.join(packageDir, "src", "cli.mjs"), "init", target]);
  assert.notEqual(init.code, 0, "conflicting init unexpectedly succeeded");
  requireLine(init, "✗ init 先掃後寫發現衝突(零寫入):");
  await assertSnapshot(target, before, "conflict zero-write");
}

async function probeRollback(artifact, payload) {
  const extracted = await makeTemp("probe-rollback");
  const packageDir = await unpack(artifact.tarball, extracted);
  const target = path.join(extracted, "consumer");
  await fs.mkdir(target);
  const before = await snapshot(target);
  const init = await run(process.execPath, [path.join(packageDir, "src", "cli.mjs"), "init", target], { env: { NPX_INIT_FAIL_AFTER: "1" } });
  assert.notEqual(init.code, 0);
  await fs.writeFile(path.join(target, "probe-corruption.txt"), "rollback corruption\n");
  await assertSnapshot(target, before, "rollback");
}

async function main() {
  const probe = process.argv.find((arg) => arg.startsWith("--probe="))?.slice("--probe=".length);
  const only = process.argv.find((arg) => arg.startsWith("--gate="))?.slice("--gate=".length);
  const artifact = await packArtifact();
  const { manifest, payload } = await gateTarball(artifact);
  if (probe === "tarball") return probeTarball(artifact, manifest, payload);
  if (probe === "clean-init") return probeCleanInit(artifact, manifest, payload);
  if (probe === "conflict") return probeConflict(artifact);
  if (probe === "rollback") return probeRollback(artifact, payload);
  assert.equal(probe, undefined, `unknown probe: ${probe}`);
  assert.ok(only === undefined || ["tarball", "clean-init", "conflict", "rollback"].includes(only), `unknown gate: ${only}`);
  if (only === "tarball") { console.log("✓ gate tarball-multiset PASS"); return; }
  if (only === "clean-init") { await gateCleanInit(artifact, manifest, payload); console.log("✓ gate clean-init PASS"); return; }
  if (only === "conflict") { await gateConflict(artifact); console.log("✓ gate conflict-zero-write PASS"); return; }
  if (only === "rollback") { await gateRollback(artifact, payload); console.log("✓ gate rollback-two-failures PASS (n=1, late)"); return; }
  await gateCleanInit(artifact, manifest, payload);
  await gateConflict(artifact);
  await gateRollback(artifact, payload);
  console.log("✓ gate tarball-multiset PASS");
  console.log("✓ gate clean-init PASS");
  console.log("✓ gate conflict-zero-write PASS");
  console.log("✓ gate rollback-two-failures PASS (n=1, late)");
  console.log("✓ blackbox gates PASS (4/4)");
}

main().catch((error) => {
  console.error(`✗ blackbox gates FAIL: ${error.message}`);
  process.exitCode = 1;
});
