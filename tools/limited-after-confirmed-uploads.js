import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig, reportingDate } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { ExistingChromeRuntime, sleep } from "../src/gui-runtime.js";

const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const config = await loadConfig();
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });
const reportDate = reportingDate();
const explicitDate = process.env.LIMITED_REPORT_DATE || "";
const approved = process.env.ALLOW_LIMITED_AFTER_CONFIRMED_UPLOADS === "YES";
const [reportYear, reportMonth] = reportDate.split("-");
const expectedFiles = [
  `ContractSummary_JP_${reportYear}-${reportMonth}.csv`,
  `ContractSummary_JP_${reportDate}.csv`
];
const importSheet = config.sheets.find(({ key }) => key === "import");
const mainSheet = config.sheets.find(({ key }) => key === "main");
const expectedImportId = "EXAMPLE_IMPORT_SPREADSHEET_ID";
const expectedMainId = "EXAMPLE_MAIN_SPREADSHEET_ID";
const expectedMainGid = "100000002";
const actionSettleMs = Math.max(config.waits?.actionSettleMs ?? 5_000, 5_000);
const pollIntervalMs = Math.max(config.waits?.pollIntervalMs ?? 5_000, 5_000);
const gasDialogTimeoutMs = config.waits?.gasDialogTimeoutMs ?? 420_000;
const postGasOkSettleMs = Math.max(config.waits?.postGasOkSettleMs ?? 20_000, 20_000);
const gidFromUrl = (url) => new URL(url).hash.match(/gid=(\d+)/)?.[1] || null;

const verifyUploadProof = async () => {
  if (!approved) throw new Error("Limited confirmed-upload safety stop: explicit approval is missing");
  if (explicitDate !== reportDate) {
    throw new Error(`Limited confirmed-upload safety stop: explicit date ${explicitDate || "blank"} != ${reportDate}`);
  }
  if (importSheet?.spreadsheetId !== expectedImportId ||
      mainSheet?.spreadsheetId !== expectedMainId ||
      mainSheet?.expectedGid !== expectedMainGid ||
      importSheet?.menu !== "集計用" ||
      importSheet?.actions?.length !== 1 ||
      importSheet.actions[0] !== "データインポート" ||
      mainSheet?.activeSheet !== "実績サマリ" ||
      mainSheet?.menu !== "集計用" ||
      mainSheet?.actions?.[0] !== "①データインポート") {
    throw new Error("Limited confirmed-upload safety stop: approved IDs/menu/action mapping changed");
  }
  const tokyoLogDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  const lines = (await readFile(path.join(root, "logs", `${tokyoLogDate}.jsonl`), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const proof = lines.findLast((entry) =>
    entry.event === "resident_run_resumed_after_uploads" &&
    entry.reportDate === reportDate &&
    Array.isArray(entry.files) &&
    entry.files.length === expectedFiles.length &&
    expectedFiles.every((filename) => entry.files.includes(filename)));
  if (!proof) {
    throw new Error("Limited confirmed-upload safety stop: exact same-day upload proof was not found");
  }
  const alreadyStarted = lines.some((entry) =>
    entry.reportDate === reportDate &&
    [
      "limited_confirmed_upload_import_gas_started",
      "limited_main_menu_test_import_gas_started",
      "limited_import_gas_started"
    ].includes(entry.event));
  if (alreadyStarted) {
    throw new Error("Limited confirmed-upload safety stop: import GAS was already started for this report date");
  }
  return proof;
};

const findRequiredTab = async (label, matches) => {
  const tab = await runtime.findTabByPageLocation(matches);
  if (!tab) throw new Error(`Limited confirmed-upload safety stop: required tab was not found (${label})`);
  return tab;
};

const waitForMarkers = async (tab, label, markers, timeoutMs = 120_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await runtime.pageSummary(tab.windowId, markers);
    if (state.auth) throw new Error(`Manual authentication required: ${label}`);
    if (state.markers.every(Boolean)) return state;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Limited confirmed-upload safety stop: markers were not ready (${label})`);
};

let mainMenuOpened = false;
const uploadProof = await verifyUploadProof();
await runtime.initialize();
try {
  const importTab = await findRequiredTab("import", (url) =>
    url.includes(`/spreadsheets/d/${expectedImportId}/`));
  const mainTab = await findRequiredTab("main", (url) =>
    url.includes(`/spreadsheets/d/${expectedMainId}/`) && gidFromUrl(url) === expectedMainGid);
  if (importTab.windowId !== mainTab.windowId) {
    throw new Error("Limited confirmed-upload safety stop: import/main are not in one approved workspace window");
  }

  const activeImportTab = await runtime.activateMatchingTab(importTab.windowId, (url) =>
    url.includes(`/spreadsheets/d/${expectedImportId}/`));
  if (!activeImportTab) throw new Error("Limited confirmed-upload safety stop: import tab reactivation failed");
  const importReady = await waitForMarkers(activeImportTab, "import", [importSheet.menu]);
  if (!importReady.url.includes(`/spreadsheets/d/${expectedImportId}/`)) {
    throw new Error("Limited confirmed-upload safety stop: import marker check ran on the wrong tab");
  }
  try {
    await runtime.exactOcrTextCoordinates(activeImportTab.windowId, ["OK"], "eng");
    throw new Error("Limited confirmed-upload safety stop: an existing OK dialog is visible on the import sheet");
  } catch (error) {
    if (!/OCR safety stop: approved text matches=0/.test(String(error))) throw error;
  }

  await runtime.clickSingleActionCustomMenu(activeImportTab.windowId, "集計用", "データインポート");
  await log("limited_confirmed_upload_import_gas_started", {
    reportDate,
    uploadProofAt: uploadProof.at,
    files: expectedFiles
  });
  const dialog = await runtime.waitForDialog(activeImportTab.windowId, gasDialogTimeoutMs);
  if (dialog.error) throw new Error(`Limited confirmed-upload import GAS failed: ${dialog.text}`);
  await runtime.confirmDialog(activeImportTab.windowId, dialog);
  await runtime.waitForDialogDismissed(activeImportTab.windowId);
  await sleep(postGasOkSettleMs);
  await log("limited_confirmed_upload_import_gas_completed", {
    reportDate,
    postOkWaitMs: postGasOkSettleMs
  });

  const activeMainTab = await runtime.activateMatchingTab(mainTab.windowId, (url) =>
    url.includes(`/spreadsheets/d/${expectedMainId}/`) && gidFromUrl(url) === expectedMainGid);
  if (!activeMainTab) throw new Error("Limited confirmed-upload safety stop: main 実績サマリ tab reactivation failed");
  await runtime.clickExactTextByPointer(activeMainTab.windowId, "実績サマリ");
  await sleep(actionSettleMs);
  const activeUrl = await runtime.currentUrl(activeMainTab.windowId);
  if (gidFromUrl(activeUrl) !== expectedMainGid) {
    throw new Error("Limited confirmed-upload safety stop: main active sheet is not 実績サマリ");
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
  await log("limited_confirmed_upload_first_action_recognized_only", {
    reportDate,
    action: "①データインポート",
    matches: 1,
    recognizedCoordinates,
    clicked: false
  });
  console.log(JSON.stringify({
    ok: true,
    reportDate,
    reusedConfirmedUploads: expectedFiles,
    importGasCompleted: true,
    recognizedAction: "①データインポート",
    matches: 1,
    clicked: false,
    stoppedBeforeMainGas: true
  }));
} catch (error) {
  await log("limited_confirmed_upload_failed", {
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
