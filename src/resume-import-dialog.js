import os from "node:os";
import path from "node:path";
import { loadConfig, reportingDate } from "./config.js";
import { createLogger } from "./logger.js";
import { readDailyRun, updateDailyRun } from "./run-state.js";
import { ExistingChromeRuntime, sleep } from "./gui-runtime.js";
import { verifyImportSheetReportDate } from "./import-sheet-verification.js";

const config = await loadConfig();
const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const reportDate = reportingDate();
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });
const statePath = path.join(root, "state", `${reportDate}.json`);
const expectedStage = "gas_started:import:データインポート";
const expectedDialogTimeoutError = "Timed out waiting for the GAS result dialog";
const expectedDismissalError = "GAS dialog did not disappear after clicking OK";
const expectedVerificationTypingError = "Address-bar typing safety stop: the omnibox did not contain the complete intended text";

try {
  const previous = await readDailyRun(root, reportDate);
  const acceptedError = previous?.error === expectedDialogTimeoutError ||
    previous?.error === expectedDismissalError ||
    previous?.error === expectedVerificationTypingError;
  if (previous?.status !== "failed" || previous?.stage !== expectedStage || !acceptedError) {
    throw new Error(
      `Import-dialog resume safety stop: unexpected state ` +
      `status=${previous?.status || "missing"} stage=${previous?.stage || "missing"} error=${previous?.error || "missing"}`
    );
  }

  await runtime.initialize({ preserveActiveDialog: true });
  const windows = await runtime.listChromeWindows();
  const sheetWindows = [];
  const importSheet = config.sheets.find(({ key }) => key === "import");
  if (!importSheet?.spreadsheetId) throw new Error("Import-dialog resume safety stop: import spreadsheet ID is missing");
  for (const windowId of windows) {
    const matchedTab = await runtime.activateMatchingTab(windowId, (url) =>
      url.includes(`/spreadsheets/d/${importSheet.spreadsheetId}/`));
    if (matchedTab) {
      const { stdout: title } = await runtime.run("xdotool", ["getwindowname", windowId]);
      sheetWindows.push({ windowId, title, url: matchedTab.url });
    }
  }
  if (previous.error === expectedDialogTimeoutError && sheetWindows.length === 0) {
    // When the prior attempt timed out before seeing the dialog, a compositor
    // modal may still block URL inspection. Preserve the legacy title fallback
    // for that recovery case only.
    for (const windowId of windows) {
      const { stdout: title } = await runtime.run("xdotool", ["getwindowname", windowId]);
      if (/Google Sheets/i.test(title) && !/17\s*-\s*Admin/i.test(title)) {
        sheetWindows.push({ windowId, title });
      }
    }
  }
  if (sheetWindows.length !== 1) {
    throw new Error(`Import-dialog resume safety stop: expected one workspace Sheets window, found ${sheetWindows.length}`);
  }

  const { windowId, title } = sheetWindows[0];
  await log("resident_import_dialog_resume_window_verified", { windowId, title });
  let confirmationMethod;
  let verification;
  if (previous.error === expectedDismissalError) {
    // The live runner can only emit expectedDismissalError after it has found
    // the completion dialog and sent an approved OK confirmation. Do not click
    // the GAS action or dialog again. Verify twice that the browser modal no
    // longer blocks Ctrl+L, then record the already-completed import safely.
    const firstProbe = await runtime.probeAddressBarAvailableWithoutEscape(windowId);
    await sleep(1_500);
    const secondProbe = await runtime.probeAddressBarAvailableWithoutEscape(windowId);
    if (!firstProbe || !secondProbe) {
      throw new Error("Import-dialog resume safety stop: the prior dialog is still blocking the sheet");
    }
    confirmationMethod = "verified-dismissed-after-pointer-confirmation";
    await log("resident_import_dialog_prior_confirmation_verified", {
      reportDate,
      firstProbe,
      secondProbe
    });
  } else {
    try {
      verification = await verifyImportSheetReportDate({ runtime, windowId, sheet: importSheet, reportDate });
      confirmationMethod = "sheet-date-verified-after-dialog-timeout";
      await log("resident_import_dialog_timeout_verified_from_sheet", { reportDate, verification });
    } catch (verificationError) {
      const dialog = await runtime.waitForDialog(windowId, 45_000, 1_500, { successLabels: ["処理が完了しました"] });
      if (dialog.error) throw new Error(`Import-dialog resume safety stop: ${dialog.text}`);
      await log("resident_import_dialog_resume_detected", {
        reportDate,
        confirmation: dialog.confirmation,
        result: dialog.text
      });
      confirmationMethod = await runtime.confirmDialog(windowId, dialog);
      await runtime.waitForDialogDismissed(windowId);
      verification = await verifyImportSheetReportDate({ runtime, windowId, sheet: importSheet, reportDate });
    }
  }
  verification ||= await verifyImportSheetReportDate({ runtime, windowId, sheet: importSheet, reportDate });
  await sleep(Math.max(config.waits?.postGasOkSettleMs ?? 20_000, 20_000));
  await updateDailyRun(statePath, {
    status: "started",
    stage: "gas_completed:import:データインポート",
    resumedAfterImportDialogAt: new Date().toISOString(),
    importDialogConfirmationMethod: confirmationMethod,
    importSheetVerifiedAt: new Date().toISOString(),
    importSheetVerification: verification,
    error: undefined,
    failedAt: undefined
  });
  await log("resident_import_dialog_resume_completed", { reportDate, confirmationMethod });
  console.log("RESIDENT_IMPORT_DIALOG_RESUME_OK");
} catch (error) {
  await log("resident_import_dialog_resume_failed", {
    reportDate,
    message: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  runtime.writeClipboard(runtime.originalClipboard);
}
