import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { loadConfig, reportingDate } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { ExistingChromeRuntime, sleep } from "../src/gui-runtime.js";

const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const config = await loadConfig();
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });
const reportDate = reportingDate();
const explicitDate = process.env.LIMITED_REPORT_DATE || "";
const downloadRunDir = process.env.LIMITED_DOWNLOAD_RUN_DIR || "";
const approval = process.env.ALLOW_LIMITED_DUPLICATE_ARCHIVE === "YES";
const [reportYear, reportMonth] = reportDate.split("-");
const expectedFiles = [
  `ContractSummary_JP_${reportYear}-${reportMonth}.csv`,
  `ContractSummary_JP_${reportDate}.csv`
];
const importSheet = config.sheets.find(({ key }) => key === "import");
const mainSheet = config.sheets.find(({ key }) => key === "main");
const expectedDriveFolderId = "EXAMPLE_DRIVE_FOLDER_ID";
const expectedImportId = "EXAMPLE_IMPORT_SPREADSHEET_ID";
const expectedMainId = "EXAMPLE_MAIN_SPREADSHEET_ID";
const expectedMainGid = "100000002";
const actionSettleMs = Math.max(config.waits?.actionSettleMs ?? 5_000, 5_000);
const pollIntervalMs = Math.max(config.waits?.pollIntervalMs ?? 5_000, 5_000);
const uploadTimeoutMs = config.waits?.uploadTimeoutMs ?? 300_000;
const gasDialogTimeoutMs = config.waits?.gasDialogTimeoutMs ?? 420_000;
const postGasOkSettleMs = Math.max(config.waits?.postGasOkSettleMs ?? 20_000, 20_000);

const gidFromUrl = (url) => new URL(url).hash.match(/gid=(\d+)/)?.[1] || null;

const assertSafetyLocks = async () => {
  if (!approval) throw new Error("Limited resume safety stop: explicit archive approval is missing");
  if (explicitDate !== reportDate) {
    throw new Error(`Limited resume safety stop: explicit date ${explicitDate || "blank"} != ${reportDate}`);
  }
  if (!path.isAbsolute(downloadRunDir)) {
    throw new Error("Limited resume safety stop: absolute download run directory is required");
  }
  if (config.drive.folderId !== expectedDriveFolderId ||
      importSheet?.spreadsheetId !== expectedImportId ||
      mainSheet?.spreadsheetId !== expectedMainId ||
      mainSheet?.expectedGid !== expectedMainGid ||
      importSheet?.menu !== "集計用" ||
      importSheet?.actions?.length !== 1 ||
      importSheet.actions[0] !== "データインポート" ||
      mainSheet?.activeSheet !== "実績サマリ" ||
      mainSheet?.menu !== "集計用" ||
      mainSheet?.actions?.[0] !== "①データインポート") {
    throw new Error("Limited resume safety stop: approved IDs/menu/action mapping changed");
  }
  for (const filename of expectedFiles) {
    const filePath = path.join(downloadRunDir, filename);
    const file = await stat(filePath);
    if (!file.isFile() || file.size <= 0) {
      throw new Error(`Limited resume safety stop: fresh CSV is missing or empty (${filename})`);
    }
  }
};

const pageHasMarkers = (tab, markers) => runtime.pageSummary(tab.windowId, markers);

const findRequiredTab = async (label, matches) => {
  const tab = await runtime.findTabByPageLocation(matches);
  if (!tab) throw new Error(`Limited resume safety stop: required tab was not found (${label})`);
  return tab;
};

const waitForMarkers = async (tab, label, markers, timeoutMs = 120_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await pageHasMarkers(tab, markers);
    if (state.auth) throw new Error(`Manual authentication required: ${label}`);
    if (state.markers.every(Boolean)) return state;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Limited resume safety stop: markers were not ready (${label})`);
};

const waitForDriveFilename = async (driveTab, filename) => {
  const started = Date.now();
  while (Date.now() - started < uploadTimeoutMs) {
    const state = await pageHasMarkers(driveTab, [filename]);
    if (state.auth) throw new Error("Manual authentication required: workspace Drive");
    if (state.markers[0]) return;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Limited resume upload could not be verified: ${filename}`);
};

const uploadFile = async (driveTab, filePath) => {
  const filename = path.basename(filePath);
  if (await runtime.driveVisibleRowExactNameCount(driveTab.windowId, filename) !== 0) {
    throw new Error(`Limited resume safety stop: exact Drive name already exists (${filename})`);
  }
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
  if (await runtime.driveVisibleRowExactNameCount(driveTab.windowId, filename) !== 1) {
    throw new Error(`Limited resume upload safety stop: exact Drive row is not unique (${filename})`);
  }
  await log("limited_resume_upload_ok", { filename });
  await sleep(actionSettleMs);
};

let mainMenuOpened = false;
await assertSafetyLocks();
await runtime.initialize();
try {
  const driveTab = await findRequiredTab("drive-folder", (url) =>
    url.includes(`/drive/folders/${expectedDriveFolderId}`));
  const importTab = await findRequiredTab("import", (url) =>
    url.includes(`/spreadsheets/d/${expectedImportId}/`));
  const mainTab = await findRequiredTab("main", (url) =>
    url.includes(`/spreadsheets/d/${expectedMainId}/`) && gidFromUrl(url) === expectedMainGid);
  if (driveTab.windowId !== importTab.windowId || importTab.windowId !== mainTab.windowId) {
    throw new Error("Limited resume safety stop: Drive/import/main are not in one approved workspace window");
  }

  const activeDriveTab = await runtime.activateMatchingTab(driveTab.windowId, (url) =>
    url.includes(`/drive/folders/${expectedDriveFolderId}`));
  if (!activeDriveTab) throw new Error("Limited resume safety stop: Drive folder reactivation failed");
  await waitForMarkers(activeDriveTab, "drive-folder", [config.drive.folderName]);

  for (const filename of expectedFiles) {
    const count = await runtime.driveVisibleRowExactNameCount(activeDriveTab.windowId, filename);
    if (count !== 1) {
      throw new Error(`Limited resume safety stop: expected one existing Drive row, found ${count} (${filename})`);
    }
  }

  const backupStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const archived = [];
  for (const filename of expectedFiles) {
    const backupName = filename.replace(/\.csv$/, `.pretest-backup-${backupStamp}.csv`);
    archived.push(await runtime.renameDriveRowExactName(activeDriveTab.windowId, filename, backupName));
    await sleep(actionSettleMs);
  }
  for (const filename of expectedFiles) {
    await uploadFile(activeDriveTab, path.join(downloadRunDir, filename));
  }

  const activeImportTab = await runtime.activateMatchingTab(importTab.windowId, (url) =>
    url.includes(`/spreadsheets/d/${expectedImportId}/`));
  if (!activeImportTab) throw new Error("Limited resume safety stop: import tab reactivation failed");
  const importReady = await waitForMarkers(activeImportTab, "import", [importSheet.menu]);
  if (!importReady.url.includes(`/spreadsheets/d/${expectedImportId}/`)) {
    throw new Error("Limited resume safety stop: import marker check ran on the wrong tab");
  }
  try {
    await runtime.exactOcrTextCoordinates(activeImportTab.windowId, ["OK"], "eng");
    throw new Error("Limited resume safety stop: an existing OK dialog is visible on the import sheet");
  } catch (error) {
    if (!/OCR safety stop: approved text matches=0/.test(String(error))) throw error;
  }
  await runtime.clickSingleActionCustomMenu(activeImportTab.windowId, "集計用", "データインポート");
  await log("limited_resume_import_gas_started", { reportDate });
  const dialog = await runtime.waitForDialog(activeImportTab.windowId, gasDialogTimeoutMs);
  if (dialog.error) throw new Error(`Limited resume import GAS failed: ${dialog.text}`);
  await runtime.confirmDialog(activeImportTab.windowId, dialog);
  await runtime.waitForDialogDismissed(activeImportTab.windowId);
  await sleep(postGasOkSettleMs);
  await log("limited_resume_import_gas_completed", { reportDate, postOkWaitMs: postGasOkSettleMs });

  const activeMainTab = await runtime.activateMatchingTab(mainTab.windowId, (url) =>
    url.includes(`/spreadsheets/d/${expectedMainId}/`) && gidFromUrl(url) === expectedMainGid);
  if (!activeMainTab) throw new Error("Limited resume safety stop: main 実績サマリ tab reactivation failed");
  await runtime.clickExactTextByPointer(activeMainTab.windowId, "実績サマリ");
  await sleep(actionSettleMs);
  const activeUrl = await runtime.currentUrl(activeMainTab.windowId);
  if (gidFromUrl(activeUrl) !== expectedMainGid) {
    throw new Error("Limited resume safety stop: main active sheet is not 実績サマリ");
  }
  const menuCoordinates = await runtime.exactTextWindowCoordinates(activeMainTab.windowId, "集計用");
  await runtime.clickWindowCoordinates(activeMainTab.windowId, menuCoordinates);
  mainMenuOpened = true;
  await sleep(2_000);
  const recognizedCoordinates = await runtime.exactOcrTextCoordinates(
    activeMainTab.windowId,
    ["①データインポート", "データインポート"],
    "jpn+eng"
  );
  await log("limited_resume_first_action_recognized_only", {
    reportDate,
    action: "①データインポート",
    matches: 1,
    recognizedCoordinates,
    clicked: false
  });
  console.log(JSON.stringify({
    ok: true,
    reportDate,
    archived,
    uploaded: expectedFiles,
    importGasCompleted: true,
    recognizedAction: "①データインポート",
    matches: 1,
    clicked: false,
    stoppedBeforeMainGas: true
  }));
} catch (error) {
  await log("limited_resume_failed", {
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
