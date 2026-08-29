#!/usr/bin/env node
// src / tools / legacy / scripts 配下の JavaScript を node --check にかける。
// 個々のファイル名を package.json に列挙すると、ファイルを増やすたびに
// 更新漏れが起きるため、ディレクトリを走査する方式にしている。
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "tools", "legacy", "scripts"];

const collect = async (dir) => {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith(".js") || e.name.endsWith(".mjs")))
    .map((e) => path.join(dir, e.name));
};

const files = (await Promise.all(DIRS.map(collect))).flat().sort();
const failures = [];

for (const file of files) {
  try {
    await run(process.execPath, ["--check", path.join(root, file)]);
  } catch (error) {
    failures.push({ file, message: String(error.stderr || error.message).trim() });
  }
}

if (failures.length > 0) {
  for (const { file, message } of failures) {
    console.error(`✖ ${file}\n${message}\n`);
  }
  console.error(`${failures.length} / ${files.length} ファイルに構文エラー`);
  process.exit(1);
}

console.log(`✓ ${files.length} ファイルの構文チェックを通過`);
