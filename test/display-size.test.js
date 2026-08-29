import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const displayScript = new URL("../ensure-display-size.sh", import.meta.url);

const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const makeMockXrandr = async ({ initialWidth, initialHeight }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vmra-display-"));
  const statePath = path.join(root, "state");
  const callsPath = path.join(root, "calls");
  const xrandrPath = path.join(root, "xrandr");
  await writeFile(
    xrandrPath,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$MOCK_CALLS"
if [[ "\${1:-}" == "--output" ]]; then
  printf 'resized' > "$MOCK_STATE"
  exit 0
fi
if [[ -s "$MOCK_STATE" ]]; then
  width=1024
  height=768
else
  width=${initialWidth}
  height=${initialHeight}
fi
printf 'Screen 0: current %s x %s\\n' "$width" "$height"
printf 'DUMMY0 connected primary %sx%s+0+0\\n' "$width" "$height"
printf '   800x600 60.00\\n'
printf '   1024x768 60.00\\n'
printf '   1600x1200_60 60.00\\n'
`
  );
  await chmod(xrandrPath, 0o755);
  return { root, statePath, callsPath };
};

test("display guard preserves an already safe CRD resolution", async () => {
  const mock = await makeMockXrandr({ initialWidth: 1396, initialHeight: 837 });
  const result = await run("bash", [displayScript.pathname], {
    env: { ...process.env, PATH: `${mock.root}:${process.env.PATH}`, MOCK_STATE: mock.statePath, MOCK_CALLS: mock.callsPath }
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /DISPLAY_SIZE_OK.*1396x837/);
  assert.equal((await readFile(mock.callsPath, "utf8")).trim(), "--current");
});

test("display guard selects the smallest available safe mode and verifies it", async () => {
  const mock = await makeMockXrandr({ initialWidth: 800, initialHeight: 600 });
  const result = await run("bash", [displayScript.pathname], {
    env: { ...process.env, PATH: `${mock.root}:${process.env.PATH}`, MOCK_STATE: mock.statePath, MOCK_CALLS: mock.callsPath }
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /DISPLAY_SIZE_ADJUSTED.*mode=1024x768.*1024x768/);
  assert.match(await readFile(mock.callsPath, "utf8"), /--output DUMMY0 --mode 1024x768/);
});

test("Chrome startup checks the display before launching either profile", async () => {
  const source = await readFile(new URL("../start-chrome.sh", import.meta.url), "utf8");
  const guardIndex = source.indexOf('"$script_dir/ensure-display-size.sh"');
  const chromeIndex = source.indexOf("google-chrome");

  assert.notEqual(guardIndex, -1);
  assert.ok(guardIndex < chromeIndex);
});
