#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.resolve(packageRoot, "..");
const outputRoot = path.join(packageRoot, "dist", "template");

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function filesUnder(root) {
  const result = [];
  const visit = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) result.push(full);
    }
  };
  if (await isFile(root)) return [root];
  await visit(root);
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

async function expand(root, include) {
  if (await isFile(root)) return [root];
  const exact = path.resolve(root, include);
  if (!/[?*]/.test(include) && await isFile(exact)) return [exact];
  const matcher = globToRegExp(include.replaceAll(path.sep, "/"));
  return (await filesUnder(root)).filter((file) => matcher.test(path.relative(root, file).split(path.sep).join("/")));
}

const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "payload-manifest.json"), "utf8"));
const packageInfo = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
const version = (await fs.readFile(path.join(sourceRoot, "VERSION"), "utf8")).trim();
if (packageInfo.version !== version) throw new Error(`版本不一致: package/package.json=${packageInfo.version}, VERSION=${version}`);

await fs.rm(outputRoot, { recursive: true, force: true });
for (const entry of manifest.payload ?? []) {
  const root = path.resolve(sourceRoot, entry.root);
  for (const include of entry.include ?? ["**/*"]) {
    for (const source of await expand(root, include)) {
      const relative = path.relative(sourceRoot, source);
      // npm-packlist reserves .gitignore. Keep the canonical payload path in
      // the manifest, but use a transport-safe name inside the npm archive.
      const transportRelative = relative === ".gitignore" || relative === ".npmrc"
        ? relative.slice(1)
        : relative;
      const destination = path.join(outputRoot, transportRelative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }
  }
}
