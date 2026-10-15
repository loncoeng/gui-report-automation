#!/usr/bin/env node
// Run node --check over the JavaScript under src, tools, legacy and
// scripts, and bash -n over the shell scripts.
//
// It walks the directories rather than listing filenames in package.json,
// because a list is a thing you forget to update every time you add a file.
//
// The shell scripts are included because one of them **powers the VM off**.
// A syntax error there means it runs halfway, and that is worth catching
// before it leaves this machine.
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

// Skipped where there is no bash. CI is Linux, so they are always checked there.
let shellsChecked = 0;
for (const file of shells) {
  try {
    await run("bash", ["-n", path.join(root, file)]);
    shellsChecked += 1;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("no bash here, so the shell scripts were not checked");
      break;
    }
    failures.push({ file, message: String(error.stderr || error.message).trim() });
  }
}

if (failures.length > 0) {
  for (const { file, message } of failures) {
    console.error(`✖ ${file}\n${message}\n`);
  }
  console.error(`syntax errors in ${failures.length} files`);
  process.exit(1);
}

console.log(`✓ checked ${scripts.length} JavaScript and ${shellsChecked} shell files`);
