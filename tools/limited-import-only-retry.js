import os from "node:os";
import path from "node:path";
import { access, realpath } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { ExistingChromeRuntime, sleep } from "../src/gui-runtime.js";
import { readDailyRun } from "../src/run-state.js";

if (process.env.ALLOW_IMPORT_GAS_RETRY !== "YES") {
  throw new Error("Safety lock: ALLOW_IMPORT_GAS_RETRY=YES is required");
}
if (process.env.ALLOW_APPROVED_CSV_UPLOAD !== "YES") {
  throw new Error("Safety lock: ALLOW_APPROVED_CSV_UPLOAD=YES is required");
}

const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const reportDate = process.env.MANUALLY_COMPLETED_REPORT_DATE;
if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate || "")) {
  throw new Error("Safety lock: MANUALLY_COMPLETED_REPORT_DATE=YYYY-MM-DD is required");
}

const workspaceWindowId = process.env.VERIFIED_WORKSPACE_WINDOW_ID;
if (!/^0x[0-9a-f]{8}$/i.test(workspaceWindowId || "")) {
  throw new Error("Safety lock: VERIFIED_WORKSPACE_WINDOW_ID is required");
}

const testArtifactName = process.env.OWN_TEST_ARTIFACT_NAME;
if (!/^VMRA_UPLOAD_TEST_DO_NOT_IMPORT_[A-Za-z0-9-]+\.txt$/.test(testArtifactName || "")) {
  throw new Error("Safety lock: the exact OWN_TEST_ARTIFACT_NAME is required");
}

const config = await loadConfig();
const importSheet = config.sheets.find(({ key }) => key === "import");
if (!importSheet || importSheet.spreadsheetId !== "EXAMPLE_IMPORT_SPREADSHEET_ID") {
  throw new Error("Safety lock: the approved source import spreadsheet is not configured exactly");
}

const state = await readDailyRun(root, reportDate);
if (!state || state.status !== "manual_completed") {
  throw new Error(`Safety lock: ${reportDate} must remain manual_completed`);
}

const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });
const actionSettleMs = Math.max(config.waits?.actionSettleMs ?? 5_000, 5_000);
const gasDialogTimeoutMs = config.waits?.gasDialogTimeoutMs ?? 420_000;
const postGasOkSettleMs = config.waits?.postGasOkSettleMs ?? 20_000;
const [reportYear, reportMonth] = reportDate.split("-");
const expectedCsvNames = [
  `ContractSummary_JP_${reportYear}-${reportMonth}.csv`,
  `ContractSummary_JP_${reportDate}.csv`
];
const approvedCsvPaths = [process.env.APPROVED_MONTHLY_CSV, process.env.APPROVED_DAILY_CSV];

const verifyApprovedCsvPaths = async () => {
  const approvedRunRoot = await realpath(path.join(root, "runs", reportDate));
  const verified = [];
  for (let index = 0; index < expectedCsvNames.length; index += 1) {
    const candidate = approvedCsvPaths[index];
    if (!candidate || path.basename(candidate) !== expectedCsvNames[index]) {
      throw new Error(`Safety lock: approved CSV basename must be ${expectedCsvNames[index]}`);
    }
    await access(candidate);
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(`${approvedRunRoot}${path.sep}`)) {
      throw new Error("Safety lock: approved CSV must come from this report date run directory");
    }
    verified.push(resolved);
  }
  return verified;
};

const visibleContractCsvNames = (windowId) => runtime.typeAddressJavascript(
  windowId,
  "async()=>{const names=new Set();for(const e of document.querySelectorAll('[role=row],[role=gridcell],div,span'))for(const line of (e.innerText||e.textContent||'').split('\\n')){const s=line.trim();if(/^ContractSummary_JP_.*\\.csv$/.test(s))names.add(s)}return[...names].sort()}"
);

const waitForDriveFilename = async (windowId, filename, timeoutMs = 300_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await runtime.pageSummary(windowId, [filename]);
    if (state.auth) throw new Error("workspace Drive authentication changed during upload");
    if (state.markers[0]) return;
    await sleep(5_000);
  }
  throw new Error(`Drive upload could not be verified: ${filename}`);
};

const uploadApprovedCsv = async (windowId, filePath, filename) => {
  const before = await runtime.pageSummary(windowId, [filename]);
  if (before.markers[0]) throw new Error(`Drive safety stop: ${filename} already exists`);
  const newButtonCoordinates = await runtime.exactTextWindowCoordinates(windowId, "新規")
    .catch(() => runtime.exactTextWindowCoordinates(windowId, "New"));
  await runtime.clickWindowCoordinates(windowId, newButtonCoordinates);
  await sleep(actionSettleMs);
  await runtime.activateWindow(windowId);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Home"]);
  await sleep(1_000);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Down"]);
  await sleep(1_000);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Return"]);
  await runtime.chooseFile(filePath);
  await waitForDriveFilename(windowId, filename);
  await log("limited_approved_csv_upload_ok", { reportDate, filename });
};

const verifyDriveCsvPair = async () => {
  const tab = await runtime.activateMatchingTabByPageLocation(
    workspaceWindowId,
    (url) => url.includes(`/drive/folders/${config.drive.folderId}`)
  );
  if (!tab) throw new Error("The already-open レポート保存 folder tab was not found");

  const page = await runtime.pageSummary(tab.windowId, [
    config.drive.folderName,
    testArtifactName,
    ...expectedCsvNames
  ]);
  if (page.auth) throw new Error("Manual authentication is required on the Drive folder");
  if (!page.url.includes(`/folders/${config.drive.folderId}`) || !page.markers[0]) {
    throw new Error("Drive folder ID verification failed");
  }

  if (page.markers[1]) throw new Error("Drive safety stop: the TXT upload-test artifact is still present");
  const csvPaths = await verifyApprovedCsvPaths();
  let csvNames = await visibleContractCsvNames(tab.windowId);
  if (csvNames.length === 0) {
    for (let index = 0; index < csvPaths.length; index += 1) {
      await uploadApprovedCsv(tab.windowId, csvPaths[index], expectedCsvNames[index]);
    }
    csvNames = await visibleContractCsvNames(tab.windowId);
  } else if (!page.markers.slice(2).every(Boolean)) {
    throw new Error(`Required CSV pair is incomplete: expected ${expectedCsvNames.join(", ")}`);
  }

  if (csvNames.length !== 2 || expectedCsvNames.some((name) => !csvNames.includes(name))) {
    throw new Error(`Drive CSV safety stop: visible names=${csvNames.join(", ")}`);
  }
  await log("limited_drive_csv_pair_verified", { reportDate, filenames: expectedCsvNames });
};

await log("limited_import_only_retry_started", { reportDate });

try {
  await runtime.initialize();
  const windows = await runtime.listChromeWindows();
  if (!windows.includes(workspaceWindowId)) {
    throw new Error("The verified workspace Chrome window is no longer present");
  }

  await runtime.run("wmctrl", ["-ir", workspaceWindowId, "-b", "add,maximized_vert,maximized_horz"]);
  await sleep(actionSettleMs);

  await verifyDriveCsvPair();

  const tab = await runtime.activateMatchingTabByPageLocation(
    workspaceWindowId,
    (url) => url.includes(`/spreadsheets/d/${importSheet.spreadsheetId}/`)
  );
  if (!tab) throw new Error("The approved source import spreadsheet tab was not found");

  const page = await runtime.pageSummary(tab.windowId, [...importSheet.requiredSheets, importSheet.menu]);
  if (page.auth) throw new Error("Manual authentication is required on the import spreadsheet");
  if (!page.markers.every(Boolean)) throw new Error("The import spreadsheet markers are incomplete");

  const staleDialog = await runtime.dialogState(tab.windowId);
  if (staleDialog.visible) {
    throw new Error(`Safety stop: an existing dialog is open on the import sheet (${staleDialog.text})`);
  }

  await runtime.clickSingleActionCustomMenu(tab.windowId, importSheet.menu, "データインポート");
  await log("limited_import_menu_action_clicked", {
    reportDate,
    sheetKey: "import",
    menu: importSheet.menu,
    action: "データインポート"
  });

  const dialog = await runtime.waitForDialog(tab.windowId, gasDialogTimeoutMs);
  if (dialog.error) throw new Error(`source import GAS failed: ${dialog.text}`);
  await log("limited_import_only_retry_ok", {
    reportDate,
    sheetKey: "import",
    action: "データインポート",
    result: dialog.text
  });
  await runtime.confirmDialog(tab.windowId, dialog);
  await runtime.waitForDialogDismissed(tab.windowId);
  await sleep(Math.max(actionSettleMs, postGasOkSettleMs));
  console.log(JSON.stringify({ ok: true, reportDate, action: "データインポート" }));
} catch (error) {
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Escape"]).catch(() => {});
  await log("limited_import_only_retry_failed", {
    reportDate,
    message: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await runtime.restoreUserState().catch(() => {});
}
