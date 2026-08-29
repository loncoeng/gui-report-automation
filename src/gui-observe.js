import { execFile, spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const execFileAsync = promisify(execFile);
const config = await loadConfig();
const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const log = await createLogger(path.join(root, "logs"));
const xauthority = process.env.XAUTHORITY || path.join(os.homedir(), ".Xauthority");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const run = async (command, args = [], options = {}) => {
  const { stdout = "", stderr = "" } = await execFileAsync(command, args, {
    env: options.env || process.env,
    timeout: options.timeout || 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
};

const commandExists = async (command) => {
  try {
    await run("/usr/bin/env", ["bash", "-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
};

const detectDisplay = async () => {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  const { stdout } = await run("pgrep", ["-a", "-u", String(process.getuid()), "Xorg"]);
  const displays = stdout.split("\n").map((line) => line.match(/(?:^|\s)(:\d+)(?:\s|$)/)?.[1]).filter(Boolean);
  if (!displays.length) throw new Error("Chrome Remote Desktop display was not found");
  return displays.includes(":20") ? ":20" : displays[0];
};

const readClipboard = (env) => {
  const result = spawnSync("xclip", ["-selection", "clipboard", "-o"], {
    encoding: "utf8",
    env,
    timeout: 5_000
  });
  return result.status === 0 ? result.stdout : "";
};

const writeClipboard = (text, env) => {
  spawnSync("xclip", ["-selection", "clipboard", "-i"], {
    encoding: "utf8",
    env,
    input: text,
    timeout: 5_000
  });
};

const listChromeWindows = async (env) => {
  const { stdout } = await run("wmctrl", ["-lx"], { env });
  return stdout.split("\n")
    .filter((line) => /\sgoogle-chrome\.Google-chrome\s/i.test(line))
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
};

const currentUrl = async (windowId, env) => {
  await run("xdotool", ["windowactivate", "--sync", windowId], { env });
  await run("xdotool", ["key", "--clearmodifiers", "ctrl+l"], { env });
  await delay(300);
  await run("xdotool", ["key", "--clearmodifiers", "ctrl+c"], { env });
  await delay(250);
  const url = readClipboard(env).trim();
  await run("xdotool", ["key", "--clearmodifiers", "Escape"], { env });
  return url;
};

const activateMatchingTab = async (windowId, matches, env, maxTabs = 12) => {
  for (let index = 0; index < maxTabs; index += 1) {
    const url = await currentUrl(windowId, env);
    if (matches(url)) return url;
    await run("xdotool", ["key", "--clearmodifiers", "ctrl+Tab"], { env });
    await delay(500);
  }
  return null;
};

const captureOcr = async (key, env) => {
  const safeKey = key.replace(/[^a-z0-9_-]/gi, "-");
  const artifactDir = path.join(root, "artifacts");
  const xwdPath = path.join(artifactDir, `${safeKey}.xwd`);
  const pngPath = path.join(artifactDir, `${safeKey}.png`);
  const topPath = path.join(artifactDir, `${safeKey}-top.png`);
  const bottomPath = path.join(artifactDir, `${safeKey}-bottom.png`);
  await mkdir(artifactDir, { recursive: true });

  try {
    await run("xwd", ["-root", "-silent", "-display", env.DISPLAY, "-out", xwdPath], { env });
    await run("convert", [xwdPath, pngPath], { env, timeout: 60_000 });
    const { stdout: dimensions } = await run("identify", ["-format", "%w %h", pngPath], { env });
    const [width, height] = dimensions.split(/\s+/).map(Number);
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("Could not read screenshot dimensions");

    const topHeight = Math.min(260, height);
    const bottomHeight = Math.min(170, height);
    await Promise.all([
      run("convert", [pngPath, "-crop", `${width}x${topHeight}+0+0`, "+repage", topPath], { env, timeout: 60_000 }),
      run("convert", [pngPath, "-crop", `${width}x${bottomHeight}+0+${height - bottomHeight}`, "+repage", bottomPath], {
        env,
        timeout: 60_000
      })
    ]);

    const ocrResults = await Promise.all(
      [pngPath, topPath, bottomPath].map((imagePath) =>
        run("tesseract", [imagePath, "stdout", "-l", "jpn+eng", "--psm", "11"], {
          env,
          timeout: 90_000
        })
      )
    );
    return ocrResults.map(({ stdout }) => stdout).join("\n");
  } finally {
    await rm(xwdPath, { force: true });
    await rm(pngPath, { force: true });
    await rm(topPath, { force: true });
    await rm(bottomPath, { force: true });
  }
};

const normalize = (value) => value.replace(/\s+/g, "").toLowerCase();
const containsMarker = (ocr, marker) => normalize(ocr).includes(normalize(marker));

const targets = [
  {
    key: "source-admin",
    matches: (url) => url.startsWith(config.admin.url),
    markers: ["Monthly", "Daily", "Download"]
  },
  ...config.sheets.map((sheet) => ({
    key: sheet.key,
    matches: (url) => url.includes(`/spreadsheets/d/${sheet.spreadsheetId}/`),
    markers: [...sheet.requiredSheets, sheet.menu]
  }))
];

try {
  for (const tool of ["xdotool", "xclip", "wmctrl", "xwd", "convert", "tesseract"]) {
    if (!(await commandExists(tool))) throw new Error(`Required command is missing: ${tool}`);
  }

  const display = await detectDisplay();
  const env = { ...process.env, DISPLAY: display, XAUTHORITY: xauthority };
  const originalClipboard = readClipboard(env);

  try {
    const windows = await listChromeWindows(env);
    if (!windows.length) throw new Error("No visible Google Chrome windows were found");

    for (const target of targets) {
      let found = null;
      let windowId = null;
      for (const candidateWindow of windows) {
        const url = await activateMatchingTab(candidateWindow, target.matches, env);
        if (url) {
          found = url;
          windowId = candidateWindow;
          break;
        }
      }
      if (!found || !windowId) throw new Error(`Target tab was not found: ${target.key}`);

      await run("wmctrl", ["-ir", windowId, "-b", "add,maximized_vert,maximized_horz"], { env });
      await delay(1_000);
      const ocr = await captureOcr(target.key, env);
      const markerResults = Object.fromEntries(target.markers.map((marker) => [marker, containsMarker(ocr, marker)]));
      await log("gui_observe_target", { key: target.key, url: found, markerResults });
      console.log(`GUI_OBSERVE_TARGET ${target.key} ${JSON.stringify(markerResults)}`);
    }

    await log("gui_observe_ok", { targetKeys: targets.map(({ key }) => key) });
    console.log("GUI_OBSERVE_OK");
  } finally {
    writeClipboard(originalClipboard, env);
  }
} catch (error) {
  await log("gui_observe_failed", { message: error instanceof Error ? error.message : String(error) });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
