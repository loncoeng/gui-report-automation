#!/usr/bin/env node
// src / tools / legacy / scripts 配下の JavaScript を node --check に、
// シェルスクリプトを bash -n にかける。
//
// 個々のファイル名を package.json に列挙すると、ファイルを増やすたびに
// 更新漏れが起きるため、ディレクトリを走査する方式にしている。
//
// シェルも見るのは、ここに **VM の電源を落とすスクリプト**があるため。
// 構文エラーで途中まで実行される事態を、手元で潰しておきたい。
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "tools", "legacy", "scripts"];

const collect = async (dir, extensions) => {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && extensions.some((x) => e.name.endsWith(x)))
    .map((e) => path.join(dir, e.name));
};

const scripts = (await Promise.all(DIRS.map((d) => collect(d, [".js", ".mjs"])))).flat().sort();
const shells = (
  await Promise.all([".", "scripts"].map((d) => collect(d, [".sh"])))
).flat().sort();

const failures = [];

for (const file of scripts) {
  try {
    await run(process.execPath, ["--check", path.join(root, file)]);
  } catch (error) {
    failures.push({ file, message: String(error.stderr || error.message).trim() });
  }
}

// bash が無い環境では飛ばす。CI は Linux なのでそこで必ず見られる。
let shellsChecked = 0;
for (const file of shells) {
  try {
    await run("bash", ["-n", path.join(root, file)]);
    shellsChecked += 1;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("bash が無いのでシェルスクリプトの検査は飛ばします");
      break;
    }
    failures.push({ file, message: String(error.stderr || error.message).trim() });
  }
}

if (failures.length > 0) {
  for (const { file, message } of failures) {
    console.error(`✖ ${file}\n${message}\n`);
  }
  console.error(`${failures.length} ファイルに構文エラー`);
  process.exit(1);
}

console.log(`✓ JavaScript ${scripts.length} / シェル ${shellsChecked} ファイルの構文チェックを通過`);
