import os from "node:os";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { ExistingChromeRuntime, sleep } from "../src/gui-runtime.js";

const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const config = await loadConfig();
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });
const xwdPath = path.join(root, "artifacts", "drive-menu-diagnostic.xwd");
const pngPath = path.join(root, "artifacts", "drive-menu-diagnostic.png");

try {
  await runtime.initialize();
  const driveTab = await runtime.findTabByPageLocation((url) =>
    url.includes(`/drive/folders/${config.drive.folderId}`));
  if (!driveTab) throw new Error("Configured Drive folder tab was not found");
  const newButtonCoordinates = await runtime.exactTextWindowCoordinates(driveTab.windowId, "新規")
    .catch(() => runtime.exactTextWindowCoordinates(driveTab.windowId, "New"));
  await runtime.clickWindowCoordinates(driveTab.windowId, newButtonCoordinates);
  await sleep(8_000);
  await mkdir(path.dirname(xwdPath), { recursive: true });
  await runtime.run("xwd", ["-id", driveTab.windowId, "-silent", "-out", xwdPath]);
  await runtime.run("convert", [xwdPath, pngPath], { timeout: 60_000 });
  const { stdout } = await runtime.run("tesseract", [pngPath, "stdout", "-l", "jpn+eng", "--psm", "11", "tsv"], { timeout: 90_000 });
  const rows = stdout.split("\n").slice(1).map((line) => line.split("\t")).filter((row) => row.length >= 12 && row[11]);
  const lines = new Map();
  for (const row of rows) {
    const key = row.slice(1, 5).join(":");
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(row[11]);
  }
  console.log(JSON.stringify([...lines.values()].map((words) => words.join(" ")).filter(Boolean)));
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Escape"]);
} finally {
  await rm(xwdPath, { force: true });
  await rm(pngPath, { force: true });
  await runtime.restoreUserState().catch(() => {});
}
