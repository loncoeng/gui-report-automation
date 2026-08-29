import os from "node:os";
import path from "node:path";
import { loadConfig, reportingDate } from "./config.js";
import { createLogger } from "./logger.js";
import { readDailyRun, updateDailyRun } from "./run-state.js";
import { ExistingChromeRuntime, sleep } from "./gui-runtime.js";

const config = await loadConfig();
const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const reportDate = reportingDate();
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });
const statePath = path.join(root, "state", `${reportDate}.json`);
const expectedStage = "gas_started:main:①データインポート";
const expectedDismissalError = "GAS dialog did not disappear after clicking OK";
const expectedResultTimeoutError = "Timed out waiting for the GAS result dialog";

try {
  const previous = await readDailyRun(root, reportDate);
  const confirmedSuccessDialog = previous?.error?.startsWith("main:①データインポート failed:") &&
    previous.error.includes("インポート完了しました") &&
    previous.error.includes("OK");
  const priorConfirmationTimedOut = previous?.error === expectedDismissalError;
  const resultDialogTimedOut = previous?.error === expectedResultTimeoutError;
  if (previous?.status !== "failed" || previous?.stage !== expectedStage ||
      (!confirmedSuccessDialog && !priorConfirmationTimedOut && !resultDialogTimedOut)) {
    throw new Error(
      `Main-import dialog resume safety stop: unexpected state ` +
      `status=${previous?.status || "missing"} stage=${previous?.stage || "missing"}`
    );
  }

  await runtime.initialize({ preserveActiveDialog: true });
  const windows = await runtime.listChromeWindows();
  const sheetWindows = [];
  if (priorConfirmationTimedOut || resultDialogTimedOut) {
    const mainSheet = config.sheets.find(({ key }) => key === "main");
    if (!mainSheet?.spreadsheetId) throw new Error("Main-import dialog resume safety stop: main spreadsheet ID is missing");
    for (const windowId of windows) {
      const { stdout: initialTitle } = await runtime.run("xdotool", ["getwindowname", windowId]);
      if (/17\s*-\s*Admin/i.test(initialTitle)) {
        await log("resident_main_import_dialog_admin_window_skipped", { windowId, title: initialTitle });
        continue;
      }
      const matchedTab = await runtime.activateMatchingTab(windowId, (url) =>
        url.includes(`/spreadsheets/d/${mainSheet.spreadsheetId}/`));
      if (matchedTab) {
        const { stdout: title } = await runtime.run("xdotool", ["getwindowname", windowId]);
        sheetWindows.push({ windowId, title });
      }
    }
  } else {
    for (const windowId of windows) {
      const { stdout: title } = await runtime.run("xdotool", ["getwindowname", windowId]);
      if (/Google Sheets/i.test(title) && !/17\s*-\s*Admin/i.test(title)) {
        sheetWindows.push({ windowId, title });
      }
    }
  }
  if (sheetWindows.length !== 1) {
    throw new Error(`Main-import dialog resume safety stop: expected one workspace Sheets window, found ${sheetWindows.length}`);
  }

  const { windowId, title } = sheetWindows[0];
  await log("resident_main_import_dialog_resume_window_verified", { windowId, title });
  let confirmationMethod;
  if (priorConfirmationTimedOut) {
    const firstProbe = await runtime.probeAddressBarAvailableWithoutEscape(windowId);
    await sleep(1_500);
    const secondProbe = await runtime.probeAddressBarAvailableWithoutEscape(windowId);
    if (!firstProbe || !secondProbe) {
      throw new Error("Main-import dialog resume safety stop: the prior dialog is still blocking the sheet");
    }
    confirmationMethod = "verified-dismissed-after-pointer-confirmation";
    await log("resident_main_import_dialog_prior_confirmation_verified", {
      reportDate,
      firstProbe,
      secondProbe
    });
  } else {
    const dialog = await runtime.waitForDialog(windowId, 45_000, 1_500);
    if (dialog.error || !dialog.text.includes("インポート完了しました")) {
      throw new Error(`Main-import dialog resume safety stop: ${dialog.text}`);
    }
    await log("resident_main_import_dialog_resume_detected", {
      reportDate,
      confirmation: dialog.confirmation,
      result: dialog.text
    });
    confirmationMethod = await runtime.confirmDialog(windowId, dialog);
    await runtime.waitForDialogDismissed(windowId);
  }
  await sleep(Math.max(config.waits?.postGasOkSettleMs ?? 20_000, 20_000));
  await updateDailyRun(statePath, {
    status: "started",
    stage: "gas_completed:main:①データインポート",
    resumedAfterMainImportDialogAt: new Date().toISOString(),
    mainImportDialogConfirmationMethod: confirmationMethod,
    error: undefined,
    failedAt: undefined
  });
  await log("resident_main_import_dialog_resume_completed", { reportDate, confirmationMethod });
  console.log("RESIDENT_MAIN_IMPORT_DIALOG_RESUME_OK");
} catch (error) {
  await log("resident_main_import_dialog_resume_failed", {
    reportDate,
    message: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  runtime.writeClipboard(runtime.originalClipboard);
}
