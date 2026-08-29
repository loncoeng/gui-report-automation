import { execFile, spawnSync } from "node:child_process";
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
    maxBuffer: 2 * 1024 * 1024
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
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
    await delay(400);
  }
  return null;
};

const gidFromUrl = (value) => {
  try {
    const url = new URL(value);
    return url.searchParams.get("gid") || url.hash.match(/(?:^#|[&#])gid=(\d+)/)?.[1] || null;
  } catch {
    return null;
  }
};

const targets = [
  {
    key: "source-admin",
    matches: (url) => url.startsWith(config.admin.url),
    activeSheet: null,
    expectedGid: null,
    menu: null,
    actions: ["月次CSV取得", "日次CSV取得"]
  },
  {
    key: "drive-folder",
    matches: (url) => url.includes(`/drive/folders/${config.drive.folderId}`),
    activeSheet: null,
    expectedGid: null,
    menu: null,
    actions: ["月次CSVアップロード", "日次CSVアップロード"]
  },
  ...config.sheets.map((sheet) => ({
    ...sheet,
    matches: (url) => url.includes(`/spreadsheets/d/${sheet.spreadsheetId}/`)
  }))
];

const enabledSafetyFlags = Object.entries(config.safety).filter(([, enabled]) => enabled).map(([key]) => key);
if (config.schedule.enabled || enabledSafetyFlags.length) {
  throw new Error(`Dry-run safety lock is not active: schedule=${config.schedule.enabled}, flags=${enabledSafetyFlags.join(",")}`);
}

const display = await detectDisplay();
const env = { ...process.env, DISPLAY: display, XAUTHORITY: xauthority };
const originalClipboard = readClipboard(env);
let originalWindowId = null;
let originalUrl = null;

try {
  const windows = await listChromeWindows(env);
  if (!windows.length) throw new Error("No visible Google Chrome windows were found");

  try {
    originalWindowId = (await run("xdotool", ["getactivewindow"], { env })).stdout;
    if (windows.includes(`0x${Number(originalWindowId).toString(16).padStart(8, "0")}`)) {
      originalWindowId = `0x${Number(originalWindowId).toString(16).padStart(8, "0")}`;
      originalUrl = await currentUrl(originalWindowId, env);
    } else {
      originalWindowId = null;
    }
  } catch {
    originalWindowId = null;
  }

  for (const target of targets) {
    let foundUrl = null;
    let foundWindowId = null;
    for (const windowId of windows) {
      const candidate = await activateMatchingTab(windowId, target.matches, env);
      if (candidate) {
        foundUrl = candidate;
        foundWindowId = windowId;
        break;
      }
    }
    if (!foundUrl || !foundWindowId) throw new Error(`Dry-run target was not found in the required state: ${target.key}`);
    if (/accounts\.google\.com|\/login(?:[/?#]|$)|signin/i.test(foundUrl)) {
      throw new Error(`Login page detected for ${target.key}`);
    }

    const { stdout: title } = await run("xdotool", ["getwindowname", foundWindowId], { env });
    const result = {
      key: target.key,
      title,
      url: foundUrl,
      activeSheet: target.activeSheet,
      expectedGid: target.expectedGid,
      menu: target.menu,
      plannedActions: target.actions
    };
    await log("gui_dry_run_target", result);
    console.log(`GUI_DRY_RUN_TARGET ${target.key} gid=${gidFromUrl(foundUrl) || "-"} actions=${target.actions.length}`);
  }

  await log("gui_dry_run_ok", { targetKeys: targets.map(({ key }) => key), safety: config.safety });
  console.log("GUI_DRY_RUN_OK");
} catch (error) {
  await log("gui_dry_run_failed", { message: error instanceof Error ? error.message : String(error) });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (originalWindowId && originalUrl) {
    try {
      await activateMatchingTab(originalWindowId, (url) => url === originalUrl, env);
      await run("xdotool", ["windowactivate", "--sync", originalWindowId], { env });
    } catch {
      // Restoring the user's original visible tab is best-effort only.
    }
  }
  writeClipboard(originalClipboard, env);
}
