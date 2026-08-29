import os from "node:os";
import path from "node:path";
import { loadConfig, reportingDate } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { ExistingChromeRuntime, sleep } from "../src/gui-runtime.js";
import {
  captureDownloadSnapshot,
  moveDownloadIntoRun,
  prepareDownloadWorkspace,
  waitForFreshStableDownload
} from "../src/download-workspace.js";

const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const downloadDir = process.env.CHROME_DOWNLOAD_DIR || path.join(os.homedir(), "Downloads");
const config = await loadConfig();
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });
const reportDate = reportingDate();
const [reportYear, reportMonth, reportDay] = reportDate.split("-");
const monthlyName = `ContractSummary_JP_${reportYear}-${reportMonth}.csv`;
const dailyName = `ContractSummary_JP_${reportDate}.csv`;
const expectedFiles = [monthlyName, dailyName];
const actionSettleMs = Math.max(config.waits?.actionSettleMs ?? 5_000, 5_000);
const navigationSettleMs = Math.max(config.waits?.navigationSettleMs ?? 10_000, 10_000);
const pollIntervalMs = Math.max(config.waits?.pollIntervalMs ?? 5_000, 5_000);
const downloadTimeoutMs = config.waits?.downloadTimeoutMs ?? 180_000;
const uploadTimeoutMs = config.waits?.uploadTimeoutMs ?? 300_000;
const gasDialogTimeoutMs = config.waits?.gasDialogTimeoutMs ?? 420_000;
const postGasOkSettleMs = config.waits?.postGasOkSettleMs ?? 20_000;
const importSheet = config.sheets.find(({ key }) => key === "import");
const mainSheet = config.sheets.find(({ key }) => key === "main");

if (process.env.ALLOW_LIMITED_THROUGH_MAIN_MENU_TEST !== "YES") {
  throw new Error("Safety lock: ALLOW_LIMITED_THROUGH_MAIN_MENU_TEST=YES is required");
}
if (!importSheet || importSheet.spreadsheetId !== "EXAMPLE_IMPORT_SPREADSHEET_ID" ||
    importSheet.menu !== "集計用" || JSON.stringify(importSheet.actions) !== JSON.stringify(["データインポート"])) {
  throw new Error("Safety lock: import spreadsheet mapping is not approved");
}
if (!mainSheet || mainSheet.spreadsheetId !== "EXAMPLE_MAIN_SPREADSHEET_ID" ||
    mainSheet.expectedGid !== "100000002" || mainSheet.activeSheet !== "実績サマリ" ||
    mainSheet.menu !== "集計用" || mainSheet.actions[0] !== "①データインポート") {
  throw new Error("Safety lock: main spreadsheet mapping is not approved");
}

const gidFromUrl = (value) => {
  try {
    const url = new URL(value);
    return url.searchParams.get("gid") || url.hash.match(/(?:^#|[&#])gid=(\d+)/)?.[1] || null;
  } catch {
    return null;
  }
};

const pageHasMarkers = async (tab, markers) => {
  const state = await runtime.pageSummary(tab.windowId, markers);
  return { ...state, all: state.markers.every(Boolean) };
};

const waitForMarkers = async (tab, key, markers, timeoutMs = 120_000) => {
  const started = Date.now();
  await sleep(navigationSettleMs);
  while (Date.now() - started < timeoutMs) {
    const state = await pageHasMarkers(tab, markers);
    const missingMarkers = markers.filter((_, index) => !state.markers[index]);
    await log("limited_main_menu_test_marker_check", {
      key,
      url: state.url,
      auth: state.auth,
      missingMarkers
    });
    if (state.auth) throw new Error(`Manual authentication required: ${key}`);
    if (state.all) return state;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Limited test safety stop: required page markers did not appear: ${key}`);
};

const findRequiredTab = async (key, matches) => {
  const tab = await runtime.findTab(matches);
  if (!tab) throw new Error(`Limited test safety stop: required tab was not found: ${key}`);
  await log("limited_main_menu_test_tab_found", { key, windowId: tab.windowId });
  return tab;
};

const downloadReport = async (adminTab, workspace, mode, filename) => {
  await runtime.clickExactText(adminTab.windowId, mode);
  await sleep(actionSettleMs);
  await runtime.setSelectFollowingLabel(adminTab.windowId, "Year", reportYear);
  await sleep(actionSettleMs);
  await runtime.setSelectFollowingLabel(adminTab.windowId, "Month", reportMonth);
  await sleep(actionSettleMs);
  if (mode === "Daily") {
    await runtime.setSelectFollowingLabel(adminTab.windowId, "Day", reportDay);
    await sleep(actionSettleMs);
  }
  const before = await captureDownloadSnapshot(downloadDir, filename);
  const startedAtMs = Date.now();
  await runtime.clickExactText(adminTab.windowId, "Download", { delayMs: 750 });
  const candidate = await waitForFreshStableDownload({
    downloadDir,
    canonicalName: filename,
    before,
    startedAtMs,
    timeoutMs: downloadTimeoutMs,
    pollIntervalMs,
    sleep
  });
  const filePath = await moveDownloadIntoRun({ candidate, runDir: workspace.runDir, canonicalName: filename });
  await log("limited_main_menu_test_download_ok", { mode, filename, filePath });
  await sleep(actionSettleMs);
  return filePath;
};

const ensureDriveFolder = async (workspaceWindowId) => {
  const expectedUrl = `https://drive.google.com/drive/folders/${config.drive.folderId}`;
  const tab = await findRequiredTab("drive-folder", (url) => url.includes(`/drive/folders/${config.drive.folderId}`));
  if (tab.windowId !== workspaceWindowId || !tab.url.startsWith(expectedUrl)) {
    throw new Error("Limited test safety stop: Drive folder is not open in the approved workspace window");
  }
  await waitForMarkers(tab, "drive-folder", [config.drive.folderName]);
  return tab;
};

const waitForDriveFilename = async (driveTab, filename) => {
  const started = Date.now();
  while (Date.now() - started < uploadTimeoutMs) {
    const state = await pageHasMarkers(driveTab, [filename]);
    if (state.auth) throw new Error("Manual authentication required: workspace Drive");
    if (state.all) return;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Limited test upload could not be verified: ${filename}`);
};

const uploadFile = async (driveTab, filePath) => {
  const filename = path.basename(filePath);
  const existing = await pageHasMarkers(driveTab, [filename]);
  if (existing.all) throw new Error(`Limited test safety stop: Drive file already exists (${filename})`);
  const newCoordinates = await runtime.exactTextWindowCoordinates(driveTab.windowId, "新規")
    .catch(() => runtime.exactTextWindowCoordinates(driveTab.windowId, "New"));
  await runtime.clickWindowCoordinates(driveTab.windowId, newCoordinates);
  await sleep(actionSettleMs);
  await runtime.activateWindow(driveTab.windowId);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Home"]);
  await sleep(1_000);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Down"]);
  await sleep(1_000);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Return"]);
  await runtime.chooseFile(filePath);
  await waitForDriveFilename(driveTab, filename);
  await log("limited_main_menu_test_upload_ok", { filename });
  await sleep(actionSettleMs);
};

let mainMenuOpened = false;
await runtime.initialize();
try {
  const adminTab = await findRequiredTab("source-admin", (url) => url.startsWith(config.admin.url));
  const importTab = await findRequiredTab("import", (url) =>
    url.includes(`/spreadsheets/d/${importSheet.spreadsheetId}/`));
  const mainTab = await findRequiredTab("main", (url) =>
    url.includes(`/spreadsheets/d/${mainSheet.spreadsheetId}/`) && gidFromUrl(url) === mainSheet.expectedGid);
  if (importTab.windowId !== mainTab.windowId) {
    throw new Error("Limited test safety stop: import and main spreadsheets are not in the same workspace window");
  }
  // Bottom sheet tabs can be virtualized or scrolled out of the rendered DOM. The exact
  // spreadsheet ID, workspace window, approved menu, and action mapping remain safety-locked.
  const activeImportPreflight = await runtime.activateMatchingTab(importTab.windowId, (url) =>
    url.includes(`/spreadsheets/d/${importSheet.spreadsheetId}/`));
  if (!activeImportPreflight) throw new Error("Limited test safety stop: import tab preflight activation failed");
  const importReady = await waitForMarkers(activeImportPreflight, "import", [importSheet.menu]);
  if (!importReady.url.includes(`/spreadsheets/d/${importSheet.spreadsheetId}/`)) {
    throw new Error("Limited test safety stop: import marker check ran on the wrong tab");
  }

  const activeMainPreflight = await runtime.activateMatchingTab(mainTab.windowId, (url) =>
    url.includes(`/spreadsheets/d/${mainSheet.spreadsheetId}/`) && gidFromUrl(url) === mainSheet.expectedGid);
  if (!activeMainPreflight) throw new Error("Limited test safety stop: main tab preflight activation failed");
  const mainReady = await waitForMarkers(activeMainPreflight, "main", [mainSheet.activeSheet, mainSheet.menu]);
  if (!mainReady.url.includes(`/spreadsheets/d/${mainSheet.spreadsheetId}/`) ||
      gidFromUrl(mainReady.url) !== mainSheet.expectedGid) {
    throw new Error("Limited test safety stop: main marker check ran on the wrong tab");
  }

  // A tab left open across midnight does not publish the new day until reload.
  await runtime.reloadTab(adminTab.windowId);
  await sleep(navigationSettleMs);
  const refreshed = await pageHasMarkers(adminTab, [config.admin.authenticatedMarker]);
  if (!refreshed.all || refreshed.auth) throw new Error("Manual authentication required: 対象管理画面 after refresh");

  await runtime.clickExactText(adminTab.windowId, "Daily");
  await sleep(actionSettleMs);
  await runtime.setSelectFollowingLabel(adminTab.windowId, "Year", reportYear);
  await sleep(actionSettleMs);
  await runtime.setSelectFollowingLabel(adminTab.windowId, "Month", reportMonth);
  await sleep(actionSettleMs);
  await runtime.setSelectFollowingLabel(adminTab.windowId, "Day", reportDay);
  await sleep(actionSettleMs);
  await log("limited_main_menu_test_report_date_verified", { reportDate });

  const workspace = await prepareDownloadWorkspace({ root, reportDate, downloadDir, canonicalNames: expectedFiles });
  const monthlyFile = await downloadReport(adminTab, workspace, "Monthly", monthlyName);
  const dailyFile = await downloadReport(adminTab, workspace, "Daily", dailyName);
  const files = [monthlyFile, dailyFile];

  const driveTab = await ensureDriveFolder(importTab.windowId);
  for (const filename of expectedFiles) {
    const existing = await pageHasMarkers(driveTab, [filename]);
    if (existing.all) throw new Error(`Limited test safety stop: Drive file already exists (${filename})`);
  }
  for (const file of files) await uploadFile(driveTab, file);

  const activeImportTab = await runtime.activateMatchingTab(importTab.windowId, (url) =>
    url.includes(`/spreadsheets/d/${importSheet.spreadsheetId}/`));
  if (!activeImportTab) throw new Error("Limited test safety stop: import tab could not be reactivated");
  try {
    await runtime.exactOcrTextCoordinates(activeImportTab.windowId, ["OK"], "eng");
    throw new Error("Limited test safety stop: an existing OK dialog is visible on the import sheet");
  } catch (error) {
    if (!/OCR safety stop: approved text matches=0/.test(String(error))) throw error;
  }
  await runtime.clickSingleActionCustomMenu(activeImportTab.windowId, importSheet.menu, "データインポート");
  await log("limited_main_menu_test_import_gas_started", { reportDate });
  const dialog = await runtime.waitForDialog(activeImportTab.windowId, gasDialogTimeoutMs);
  if (dialog.error) throw new Error(`Limited test import GAS failed: ${dialog.text}`);
  await runtime.confirmDialog(activeImportTab.windowId, dialog);
  await runtime.waitForDialogDismissed(activeImportTab.windowId);
  await sleep(Math.max(actionSettleMs, postGasOkSettleMs));
  await log("limited_main_menu_test_import_gas_completed", {
    reportDate,
    postOkWaitMs: Math.max(actionSettleMs, postGasOkSettleMs)
  });

  const activeMainTab = await runtime.activateMatchingTab(mainTab.windowId, (url) =>
    url.includes(`/spreadsheets/d/${mainSheet.spreadsheetId}/`) && gidFromUrl(url) === mainSheet.expectedGid);
  if (!activeMainTab) throw new Error("Limited test safety stop: main 実績サマリ tab could not be reactivated");
  await runtime.clickExactTextByPointer(activeMainTab.windowId, mainSheet.activeSheet);
  await sleep(actionSettleMs);
  const activeUrl = await runtime.currentUrl(activeMainTab.windowId);
  if (gidFromUrl(activeUrl) !== mainSheet.expectedGid) {
    throw new Error("Limited test safety stop: main active sheet is not 実績サマリ");
  }
  const mainMenuCoordinates = await runtime.exactTextWindowCoordinates(activeMainTab.windowId, mainSheet.menu);
  await runtime.clickWindowCoordinates(activeMainTab.windowId, mainMenuCoordinates);
  mainMenuOpened = true;
  await sleep(2_000);
  const recognizedCoordinates = await runtime.exactOcrTextCoordinates(
    activeMainTab.windowId,
    ["①データインポート", "データインポート"],
    "jpn+eng"
  );
  await log("limited_main_menu_test_first_action_recognized_only", {
    reportDate,
    menu: mainSheet.menu,
    action: mainSheet.actions[0],
    matches: 1,
    recognizedCoordinates,
    clicked: false
  });
  console.log(JSON.stringify({
    ok: true,
    reportDate,
    downloaded: expectedFiles,
    uploaded: expectedFiles,
    importGasCompleted: true,
    mainMenu: mainSheet.menu,
    recognizedAction: mainSheet.actions[0],
    matches: 1,
    clicked: false,
    stoppedBeforeMainGas: true
  }));
} catch (error) {
  await log("limited_main_menu_test_failed", {
    reportDate,
    message: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (mainMenuOpened) {
    await runtime.run("xdotool", ["key", "--clearmodifiers", "Escape"]).catch(() => {});
  }
  await runtime.closeOpenFileChoosers().catch(() => {});
  await runtime.restoreUserState().catch(() => {});
}
