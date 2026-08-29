import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { ExistingChromeRuntime, sleep } from "./gui-runtime.js";

const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const config = await loadConfig();
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });
const main = config.sheets.find(({ key }) => key === "main");
const firstActionOcrAliases = [
  "①データインポート",
  "データインポート",
  "データインボート",
  "データインポボート"
];

if (!main ||
    main.spreadsheetId !== "EXAMPLE_MAIN_SPREADSHEET_ID" ||
    main.expectedGid !== "100000002" ||
    main.activeSheet !== "実績サマリ" ||
    main.menu !== "集計用" ||
    main.actions[0] !== "①データインポート") {
  throw new Error("Safety lock: main GAS menu configuration is not the approved mapping");
}

const gidFromUrl = (value) => {
  try {
    const url = new URL(value);
    return url.searchParams.get("gid") || url.hash.match(/(?:^#|[&#])gid=(\d+)/)?.[1] || null;
  } catch {
    return null;
  }
};

await runtime.initialize();
let menuOpened = false;
try {
  const tab = await runtime.findTab((url) =>
    url.includes(`/spreadsheets/d/${main.spreadsheetId}/`) &&
    gidFromUrl(url) === main.expectedGid);
  if (!tab) throw new Error("Safety stop: approved main spreadsheet tab on 実績サマリ was not found");

  const state = await runtime.pageSummary(tab.windowId, [main.activeSheet, main.menu]);
  if (state.auth || !state.markers.every(Boolean)) {
    throw new Error("Safety stop: main spreadsheet was not authenticated or required markers were missing");
  }

  // Stop if any result dialog is already open; Escape below must never be used
  // to dismiss a meaningful GAS result during this recognition-only test.
  try {
    await runtime.exactOcrTextCoordinates(tab.windowId, ["OK"], "eng");
    throw new Error("Safety stop: an existing OK dialog is visible on the main spreadsheet");
  } catch (error) {
    if (!/OCR safety stop: approved text matches=0/.test(String(error))) throw error;
  }

  const menuCoordinates = await runtime.exactTextWindowCoordinates(tab.windowId, main.menu);
  await runtime.clickWindowCoordinates(tab.windowId, menuCoordinates);
  menuOpened = true;
  await sleep(2_000);

  const artifactDir = path.join(root, "artifacts");
  const rootXwd = path.join(artifactDir, "main-menu-diagnostic-root.xwd");
  const rootPng = path.join(artifactDir, "main-menu-diagnostic-root.png");
  await mkdir(artifactDir, { recursive: true });
  await runtime.run("xwd", ["-root", "-silent", "-out", rootXwd]);
  await runtime.run("convert", [rootXwd, rootPng], { timeout: 60_000 });
  const rawOcr = (await runtime.run(
    "tesseract",
    [rootPng, "stdout", "-l", "jpn+eng", "--psm", "11"],
    { timeout: 90_000 }
  )).stdout;
  await log("resident_main_gas_menu_diagnostic_captured", {
    rootPng,
    menuCoordinates,
    rawOcr: rawOcr.slice(0, 4_000)
  });

  // exactOcrTextCoordinates succeeds only when exactly one approved line is
  // visible. The returned coordinates are evidence only and are never clicked.
  let recognizedCoordinates;
  try {
    recognizedCoordinates = await runtime.exactOcrTextCoordinates(
      tab.windowId,
      firstActionOcrAliases,
      "jpn+eng"
    );
  } catch (error) {
    if (!/OCR safety stop: approved text matches=0/.test(String(error))) throw error;
    recognizedCoordinates = await runtime.exactPopupOcrTextScreenCoordinates(
      tab.windowId,
      firstActionOcrAliases,
      menuCoordinates,
      "jpn+eng"
    );
  }
  await log("resident_main_gas_first_action_recognized_only", {
    spreadsheetId: main.spreadsheetId,
    gid: main.expectedGid,
    menu: main.menu,
    action: main.actions[0],
    matches: 1,
    recognizedCoordinates,
    diagnosticPng: rootPng
  });
  console.log(JSON.stringify({
    ok: true,
    menu: main.menu,
    action: main.actions[0],
    matches: 1,
    clicked: false,
    diagnosticPng: rootPng
  }));
} catch (error) {
  await log("resident_main_gas_first_action_recognition_failed", {
    message: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (menuOpened) {
    await runtime.run("xdotool", ["key", "--clearmodifiers", "Escape"]).catch(() => {});
  }
  await runtime.restoreUserState().catch(() => {});
}
