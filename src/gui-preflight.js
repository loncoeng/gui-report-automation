import { execFile, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig, reportingDate, tokyoDateParts } from "./config.js";
import { createLogger } from "./logger.js";

const execFileAsync = promisify(execFile);
const config = await loadConfig();
const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const log = await createLogger(path.join(root, "logs"));
const chromeUserDataDir = process.env.CHROME_USER_DATA_DIR || path.join(os.homedir(), ".config", "google-chrome");
const xauthority = process.env.XAUTHORITY || path.join(os.homedir(), ".Xauthority");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const run = async (command, args = [], options = {}) => {
  const { stdout = "", stderr = "" } = await execFileAsync(command, args, {
    env: options.env || process.env,
    timeout: options.timeout || 30_000,
    maxBuffer: 1024 * 1024
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

const captureCurrentTab = async (windowId, env) => {
  await run("xdotool", ["windowactivate", "--sync", windowId], { env });
  await run("xdotool", ["key", "--clearmodifiers", "ctrl+l"], { env });
  await delay(300);
  const clipboardSentinel = `__GUI_PREFLIGHT_${Date.now()}_${Math.random()}__`;
  writeClipboard(clipboardSentinel, env);
  await run("xdotool", ["key", "--clearmodifiers", "ctrl+c"], { env });
  let url = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(100);
    const clipboardValue = readClipboard(env).trim();
    if (clipboardValue && clipboardValue !== clipboardSentinel) {
      url = clipboardValue;
      break;
    }
  }
  if (!url) throw new Error("Timed out while reading the active Chrome tab URL");
  await run("xdotool", ["key", "--clearmodifiers", "Escape"], { env });
  const { stdout: title } = await run("xdotool", ["getwindowname", windowId], { env });
  return { title, url };
};

const inspectTabs = async (windowId, env, maxTabs = 12) => {
  const tabs = [];
  for (let index = 0; index < maxTabs; index += 1) {
    const tab = await captureCurrentTab(windowId, env);
    if (index > 0 && tab.url === tabs[0].url) break;
    tabs.push(tab);
    await run("xdotool", ["key", "--clearmodifiers", "ctrl+Tab"], { env });
    await delay(350);
  }
  return tabs;
};

const normalizeUrl = (value) => {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
};

const gidFromUrl = (value) => {
  try {
    const url = new URL(value);
    return url.searchParams.get("gid") || url.hash.match(/(?:^#|[&#])gid=(\d+)/)?.[1] || null;
  } catch {
    return null;
  }
};

const adminOrigin = new URL(config.admin.url).origin;
const adminLoginUrl = `${adminOrigin}/login`;
const allowAdminLoginRecovery = config.safety.allowGoogleSignInRecovery === true;
const isAdminLogin = (url) => allowAdminLoginRecovery && url.startsWith(adminLoginUrl);
const isRecoverableGoogleSignIn = (url) =>
  allowAdminLoginRecovery && url.startsWith("https://accounts.google.com/");

const expectedTargets = [
  { key: "source-admin", matches: (url) => url.startsWith(config.admin.url) || isAdminLogin(url) },
  {
    key: "drive-folder",
    matches: (url) => url.includes(`/drive/folders/${config.drive.folderId}`)
  },
  ...config.sheets.map((sheet) => ({
    key: sheet.key,
    matches: (url) => url.includes(`/spreadsheets/d/${sheet.spreadsheetId}/`)
  }))
];

const today = tokyoDateParts();
await log("gui_preflight_started", { date: `${today.year}-${today.month}-${today.day}`, reportDate: reportingDate() });

try {
  for (const tool of ["google-chrome", "xdotool", "xclip", "wmctrl"]) {
    if (!(await commandExists(tool))) throw new Error(`Required command is missing: ${tool}`);
  }

  await access(path.join(chromeUserDataDir, "Default"));
  await access(path.join(chromeUserDataDir, "Profile 1"));
  const display = await detectDisplay();
  const guiEnv = { ...process.env, DISPLAY: display, XAUTHORITY: xauthority };
  const originalClipboard = readClipboard(guiEnv);

  try {
    const windows = await listChromeWindows(guiEnv);
    if (!windows.length) {
      throw new Error("No visible Google Chrome windows were found; preflight will not start Chrome or create profiles");
    }

    const observedTabs = [];
    for (const windowId of windows) {
      const tabs = await inspectTabs(windowId, guiEnv);
      observedTabs.push(...tabs.map((tab) => ({ ...tab, url: normalizeUrl(tab.url), windowId })));
    }

    const missing = expectedTargets.filter((target) => !observedTabs.some((tab) => target.matches(tab.url)));
    const loginRedirects = observedTabs.filter((tab) =>
      /accounts\.google\.com|\/login(?:[/?#]|$)|signin/i.test(tab.url) &&
      !isAdminLogin(tab.url) &&
      !isRecoverableGoogleSignIn(tab.url));

    await log("gui_preflight_observed", {
      display,
      startedChrome: false,
      windowCount: windows.length,
      tabs: observedTabs.map(({ title, url, windowId }) => ({ title, url, windowId }))
    });

    if (loginRedirects.length) throw new Error(`Login page detected: ${loginRedirects.map(({ url }) => url).join(", ")}`);
    if (missing.length) throw new Error(`Required pages are not open: ${missing.map(({ key }) => key).join(", ")}`);

    await log("gui_preflight_ok", {
      display,
      windowCount: windows.length,
      targetKeys: expectedTargets.map(({ key }) => key)
    });
    console.log("GUI_PREFLIGHT_OK");
  } finally {
    writeClipboard(originalClipboard, guiEnv);
  }
} catch (error) {
  await log("gui_preflight_failed", { message: error instanceof Error ? error.message : String(error) });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
