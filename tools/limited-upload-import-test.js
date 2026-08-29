import os from "node:os";
import path from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { ExistingChromeRuntime, sleep } from "../src/gui-runtime.js";
import { readDailyRun, updateDailyRun } from "../src/run-state.js";

const requiredConsent = {
  ALLOW_DRIVE_UPLOAD_TEST: "YES",
  ALLOW_IMPORT_GAS_TEST: "YES"
};

for (const [name, expected] of Object.entries(requiredConsent)) {
  if (process.env[name] !== expected) {
    throw new Error(`Safety lock: ${name}=${expected} is required`);
  }
}

const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const reportDate = process.env.MANUALLY_COMPLETED_REPORT_DATE;
if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate || "")) {
  throw new Error("Safety lock: MANUALLY_COMPLETED_REPORT_DATE=YYYY-MM-DD is required");
}
const verifiedWorkspaceWindowId = process.env.VERIFIED_WORKSPACE_WINDOW_ID || null;

const config = await loadConfig();
const importSheet = config.sheets.find(({ key }) => key === "import");
if (!importSheet || importSheet.spreadsheetId !== "EXAMPLE_IMPORT_SPREADSHEET_ID") {
  throw new Error("Safety lock: the approved source import spreadsheet is not configured exactly");
}

const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });
const actionSettleMs = Math.max(config.waits?.actionSettleMs ?? 5_000, 5_000);
const navigationSettleMs = Math.max(config.waits?.navigationSettleMs ?? 10_000, 10_000);
const pollIntervalMs = Math.max(config.waits?.pollIntervalMs ?? 5_000, 5_000);
const uploadTimeoutMs = config.waits?.uploadTimeoutMs ?? 300_000;
const gasDialogTimeoutMs = config.waits?.gasDialogTimeoutMs ?? 420_000;
const postGasOkSettleMs = config.waits?.postGasOkSettleMs ?? 20_000;
const statePath = path.join(root, "state", `${reportDate}.json`);
let testFilePath = null;
let uploadedFilename = null;

const retryReadOnly = async (operation, attempts = 3) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(5_000);
    }
  }
  throw lastError;
};

const markManualCompletion = async () => {
  const state = await readDailyRun(root, reportDate);
  if (!state) throw new Error(`Safety lock: no run state exists for ${reportDate}`);
  await updateDailyRun(statePath, {
    status: "manual_completed",
    stage: "manual_completed",
    manualCompletedAt: new Date().toISOString(),
    manualCompletionSource: "user_on_windows",
    note: "Production workflow was completed manually. Only the isolated Drive upload and import-GAS test may follow.",
    error: undefined,
    failedAt: undefined
  });
  await log("manual_completion_recorded", { reportDate });
};

const waitForMarkers = async (tab, key, markers, timeoutMs = 120_000) => {
  const started = Date.now();
  await sleep(navigationSettleMs);
  while (Date.now() - started < timeoutMs) {
    const state = await runtime.pageSummary(tab.windowId, markers);
    if (state.auth) throw new Error(`Manual authentication required while checking ${key}`);
    if (state.markers.every(Boolean)) return state;
    await sleep(pollIntervalMs);
  }
  throw new Error(`${key} did not become ready`);
};

const findImportSheet = async (workspaceWindowId) => {
  let tab = await runtime.findTabByPageLocation((url) =>
    url.includes(`/spreadsheets/d/${importSheet.spreadsheetId}/`));
  if (tab && tab.windowId !== workspaceWindowId) {
    throw new Error("The approved source import spreadsheet is open in a different Chrome profile window");
  }
  if (!tab) {
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${importSheet.spreadsheetId}/edit`;
    tab = await runtime.navigateTabByPageLocation(
      workspaceWindowId,
      sheetUrl,
      (url) => url.includes(`/spreadsheets/d/${importSheet.spreadsheetId}/`)
    );
    if (!tab.url.includes(`/spreadsheets/d/${importSheet.spreadsheetId}/`)) {
      throw new Error("The approved source import spreadsheet ID could not be verified after opening it");
    }
    await log("limited_import_sheet_opened_by_id", { sheetKey: "import" });
  }
  await waitForMarkers(tab, "source import sheet", [...importSheet.requiredSheets, importSheet.menu]);
  return tab;
};

const findWorkspaceWindow = async () => {
  if (verifiedWorkspaceWindowId) {
    const windows = await runtime.listChromeWindows();
    if (!windows.includes(verifiedWorkspaceWindowId)) {
      throw new Error("The previously verified workspace Chrome window ID is no longer present");
    }
    await log("limited_workspace_window_identified_by_verified_window_id", { windowId: verifiedWorkspaceWindowId });
    return verifiedWorkspaceWindowId;
  }
  const driveTab = await runtime.findTabByPageLocation((url) => url.startsWith("https://drive.google.com/drive/"));
  if (driveTab) return driveTab.windowId;
  const importTab = await runtime.findTabByPageLocation((url) =>
    url.includes(`/spreadsheets/d/${importSheet.spreadsheetId}/`));
  if (importTab) {
    await log("limited_workspace_window_identified_by_import_sheet_id", { sheetKey: "import" });
    return importTab.windowId;
  }
  const accountMatches = [];
  for (const windowId of await runtime.listChromeWindows()) {
    try {
      const state = await runtime.accessiblePageSummary(windowId, [config.browser.workspaceAccountEmail]);
      if (state.markers[0]) accountMatches.push(windowId);
    } catch {
      // A Chrome internal page cannot expose DOM identity; keep checking safely.
    }
  }
  if (accountMatches.length === 1) {
    await log("limited_workspace_window_identified_by_account", { account: "configured_workspace" });
    return accountMatches[0];
  }
  throw new Error("Neither the workspace Drive tab nor the approved import spreadsheet ID was found; no Chrome profile will be guessed");
};

const openDriveFolder = async (workspaceWindowId) => {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(config.drive.folderId || "")) {
    throw new Error("Drive folder ID is not configured safely");
  }
  const folderUrl = `https://drive.google.com/drive/folders/${config.drive.folderId}`;
  let tab = await runtime.findTabByPageLocation((url) => url.startsWith("https://drive.google.com/drive/"));
  if (tab && tab.windowId !== workspaceWindowId) {
    throw new Error("Drive is open in a different Chrome profile window");
  }
  if (!tab) {
    tab = await runtime.navigateTabByPageLocation(
      workspaceWindowId,
      folderUrl,
      (url) => url.includes(`/folders/${config.drive.folderId}`)
    );
  } else if (!tab.url.includes(`/folders/${config.drive.folderId}`)) {
    tab = await runtime.navigateTabByPageLocation(
      tab.windowId,
      folderUrl,
      (url) => url.includes(`/folders/${config.drive.folderId}`)
    );
  }
  await waitForMarkers(tab, "Drive folder", [config.drive.folderName]);
  const folderState = await runtime.pageSummary(tab.windowId, [config.drive.folderName]);
  if (folderState.auth) throw new Error("workspace Drive authentication is required");
  if (!folderState.url.includes(`/folders/${config.drive.folderId}`)) {
    throw new Error("Drive folder ID verification failed");
  }
  await log("limited_drive_folder_id_verified", { folderName: config.drive.folderName });
  return tab;
};

const createTestFile = async () => {
  const artifactDir = path.join(root, "test-artifacts");
  await mkdir(artifactDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  uploadedFilename = `VMRA_UPLOAD_TEST_DO_NOT_IMPORT_${stamp}.txt`;
  testFilePath = path.join(artifactDir, uploadedFilename);
  await writeFile(testFilePath, `Drive upload verification only. Created ${new Date().toISOString()}\n`, "utf8");
  await access(testFilePath);
};

const uploadTestFile = async (driveTab) => {
  const before = await runtime.pageSummary(driveTab.windowId, [uploadedFilename]);
  if (before.markers[0]) throw new Error(`Drive safety stop: test file already exists (${uploadedFilename})`);
  const newButtonCoordinates = await retryReadOnly(() =>
    runtime.exactTextWindowCoordinates(driveTab.windowId, "新規")
      .catch(() => runtime.exactTextWindowCoordinates(driveTab.windowId, "New")));
  await runtime.clickWindowCoordinates(driveTab.windowId, newButtonCoordinates);
  await sleep(actionSettleMs);
  await runtime.activateWindow(driveTab.windowId);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Home"]);
  await sleep(1_000);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Down"]);
  await sleep(1_000);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Return"]);
  await log("limited_drive_file_upload_selected_by_menu_order", {
    selection: "second_item_after_home"
  });
  await runtime.chooseFile(testFilePath);

  const started = Date.now();
  while (Date.now() - started < uploadTimeoutMs) {
    const state = await runtime.pageSummary(driveTab.windowId, [uploadedFilename]);
    if (state.auth) throw new Error("workspace Drive authentication changed during upload");
    if (state.markers[0]) {
      await log("limited_drive_upload_test_ok", { filename: uploadedFilename });
      return;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Drive upload test could not be verified: ${uploadedFilename}`);
};

const runApprovedImportGas = async (tab) => {
  const staleDialog = await runtime.dialogState(tab.windowId);
  if (staleDialog.visible) throw new Error(`Safety stop: an existing dialog is open on the import sheet (${staleDialog.text})`);
  await runtime.clickSingleActionCustomMenu(tab.windowId, importSheet.menu, "データインポート");
  const dialog = await runtime.waitForDialog(tab.windowId, gasDialogTimeoutMs);
  if (dialog.error) throw new Error(`source import GAS failed: ${dialog.text}`);
  await log("limited_import_gas_test_ok", { sheetKey: "import", action: "データインポート", result: dialog.text });
  await runtime.confirmDialog(tab.windowId, dialog);
  await runtime.waitForDialogDismissed(tab.windowId);
  await sleep(Math.max(actionSettleMs, postGasOkSettleMs));
  return dialog.text;
};

await log("limited_upload_import_test_started", { reportDate });

try {
  await markManualCompletion();
  await runtime.initialize();
  const workspaceWindowId = await findWorkspaceWindow();
  const importTab = await findImportSheet(workspaceWindowId);
  const driveTab = await openDriveFolder(workspaceWindowId);
  await createTestFile();
  await uploadTestFile(driveTab);
  const gasImportTab = await findImportSheet(workspaceWindowId);
  const gasResult = await runApprovedImportGas(gasImportTab);
  await log("limited_upload_import_test_completed", { reportDate, uploadedFilename, gasResult });
  console.log(JSON.stringify({ ok: true, uploadedFilename, gasResult }));
} catch (error) {
  await log("limited_upload_import_test_failed", {
    reportDate,
    uploadedFilename,
    message: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (testFilePath) await runtime.run("gio", ["trash", testFilePath]).catch(() => {});
  await runtime.closeOpenFileChoosers().catch(() => {});
  await runtime.restoreUserState().catch(() => {});
}
