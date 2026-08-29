import os from "node:os";
import path from "node:path";
import { access, readFile, readdir } from "node:fs/promises";
import { loadConfig, reportingDate, tokyoDateParts } from "./config.js";
import { createLogger } from "./logger.js";
import { beginDailyRun, completeDailyRun, failDailyRun, readDailyRun, updateDailyRun } from "./run-state.js";
import { readSheetDateRange, verifyImportSheetReportDate } from "./import-sheet-verification.js";
import { readDriveExactFileCounts } from "./drive-verification.js";
import { ExistingChromeRuntime, sleep } from "./gui-runtime.js";
import {
  captureDownloadSnapshot,
  moveDownloadIntoRun,
  prepareDownloadWorkspace,
  waitForFreshStableDownload
} from "./download-workspace.js";

const args = new Set(process.argv.slice(2));
const preflightOnly = args.has("--preflight");
const liveRequested = args.has("--live");
const resumeAfterDownloads = args.has("--resume-after-downloads");
let resumeAfterUploads = args.has("--resume-after-uploads");
const resumeAfterImportConfirmed = args.has("--resume-after-import-confirmed");
const resumeAfterMainMenuBlocked = args.has("--resume-after-main-menu-blocked");
const resumeAfterMainMenuDiagnosticStop = args.has("--resume-after-main-menu-diagnostic-stop");
let resumeAfterMainImportConfirmed = args.has("--resume-after-main-import-confirmed");
const resumeAfterMainChatworkConfirmed = args.has("--resume-after-main-chatwork-confirmed");
const config = await loadConfig();
const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const downloadDir = process.env.CHROME_DOWNLOAD_DIR || path.join(os.homedir(), "Downloads");
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });

const actionSettleMs = config.waits?.actionSettleMs ?? 5_000;
const navigationSettleMs = config.waits?.navigationSettleMs ?? 10_000;
const pollIntervalMs = config.waits?.pollIntervalMs ?? 5_000;
const downloadTimeoutMs = config.waits?.downloadTimeoutMs ?? 180_000;
const uploadTimeoutMs = config.waits?.uploadTimeoutMs ?? 300_000;
const gasDialogTimeoutMs = config.waits?.gasDialogTimeoutMs ?? 360_000;
const sheetReadyTimeoutMs = config.waits?.sheetReadyTimeoutMs ?? 600_000;
const sheetStableWindowMs = config.waits?.sheetStableWindowMs ?? 30_000;
const postGasOkSettleMs = config.waits?.postGasOkSettleMs ?? 20_000;
const dateAvailabilityRetryDelayMs = config.waits?.dateAvailabilityRetryDelayMs ?? 180_000;

const today = tokyoDateParts();
const dayOfMonth = Number(today.day);
const executionDate = `${today.year}-${today.month}-${today.day}`;
const reportDate = reportingDate();
const [reportYear, reportMonth, reportDay] = reportDate.split("-");
const monthlyName = `ContractSummary_JP_${reportYear}-${reportMonth}.csv`;
const dailyName = `ContractSummary_JP_${reportDate}.csv`;
const expectedFiles = [monthlyName, dailyName];
let dailyRunPath = null;
let downloadWorkspace = null;
let existingRun = null;
let resumeAfterMonthlyDateAvailability = false;
let resumeAfterKnownMonthlyDriveDuplicate = false;
let resumeAfterPartialDriveUpload = false;
let resumeAfterMainImportBySheet = false;

const readGasCompletionEvidence = async (run) => {
  if (!run?.startedAt) return { importConfirmed: false, mainImportConfirmed: false };
  const startedAt = Date.parse(run.startedAt);
  const endedAt = Date.parse(run.failedAt || run.updatedAt || new Date().toISOString());
  const records = [];
  for (const name of await readdir(path.join(root, "logs"))) {
    if (!name.endsWith(".jsonl")) continue;
    const contents = await readFile(path.join(root, "logs", name), "utf8");
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const at = Date.parse(record.at);
        if (at >= startedAt && at <= endedAt) records.push(record);
      } catch {
        // Ignore a partial final log line; completed evidence requires two
        // separate valid JSON records below.
      }
    }
  }
  const confirmed = (sheetKey, action) =>
    records.some((record) => record.event === "resident_gas_dialog_dismissed" && record.sheetKey === sheetKey && record.action === action) &&
    records.some((record) => record.event === "resident_post_gas_settle_completed" && record.sheetKey === sheetKey && record.action === action);
  return {
    importConfirmed: confirmed("import", "データインポート"),
    mainImportConfirmed: confirmed("main", "①データインポート")
  };
};

const gidFromUrl = (value) => {
  try {
    const url = new URL(value);
    return url.searchParams.get("gid") || url.hash.match(/(?:^#|[&#])gid=(\d+)/)?.[1] || null;
  } catch {
    return null;
  }
};

const expectedGasConfiguration = {
  import: {
    activeSheet: "日次集計",
    expectedGid: "100000001",
    menu: "集計用",
    actions: ["データインポート"]
  },
  main: {
    activeSheet: "実績サマリ",
    expectedGid: "100000002",
    menu: "集計用",
    actions: ["①データインポート", "②Chatworkに報告", "③使用済みファイル削除"]
  },
  department: {
    activeSheet: "部門別サマリ",
    expectedGid: "100000003",
    menu: "数字報告用",
    actions: ["Chatworkに報告"]
  }
};

const gasSuccessLabels = {
  "import:データインポート": ["処理が完了しました"],
  "main:①データインポート": ["インポート完了しました"],
  "main:②Chatworkに報告": ["投稿完了しました"],
  "main:③使用済みファイル削除": ["ファイル削除が完了しました"],
  "department:Chatworkに報告": ["投稿完了しました"]
};

const gasAcceptedWarningLabels = {
  "main:②Chatworkに報告": ["最大値を超えました", "最大実行時間を超えました"],
  "main:③使用済みファイル削除": ["最大値を超えました", "最大実行時間を超えました"]
};

const assertGasConfiguration = () => {
  for (const [key, expected] of Object.entries(expectedGasConfiguration)) {
    const actual = config.sheets.find((sheet) => sheet.key === key);
    if (!actual) throw new Error(`GAS configuration safety stop: missing sheet ${key}`);
    const actionsMatch = JSON.stringify(actual.actions) === JSON.stringify(expected.actions);
    if (actual.activeSheet !== expected.activeSheet ||
        String(actual.expectedGid) !== String(expected.expectedGid) ||
        actual.menu !== expected.menu ||
        !actionsMatch) {
      throw new Error(`GAS configuration safety stop: unexpected menu mapping for ${key}`);
    }
  }
};

const assertLiveSafety = () => {
  if (!liveRequested) throw new Error("Resident live mode requires --live");
  const required = [
    "executionEnabled",
    "allowDownloads",
    "allowUploads",
    "allowGas",
    "allowChatwork",
    "allowCleanup",
    "allowGoogleSignInRecovery"
  ];
  const disabled = required.filter((key) => config.safety[key] !== true);
  if (disabled.length) throw new Error(`Safety lock: disabled capabilities: ${disabled.join(", ")}`);
  if (config.safety.onlyReportDate && config.safety.onlyReportDate !== reportDate) {
    throw new Error(`Safety lock: report date ${reportDate} is not allowed (expected ${config.safety.onlyReportDate})`);
  }
};

const findRequiredTab = async (key, matches) => {
  const tab = await runtime.findTab(matches);
  if (!tab) throw new Error(`Required resident Chrome tab was not found: ${key}`);
  await log("resident_tab_found", { key, windowId: tab.windowId });
  return tab;
};

const findRequiredTabInWindows = async (key, windowIds, matches) => {
  for (const windowId of windowIds) {
    const tab = await runtime.activateMatchingTab(windowId, matches);
    if (tab) {
      await log("resident_tab_found", { key, windowId: tab.windowId });
      return tab;
    }
  }
  throw new Error(`Required resident Chrome tab was not found: ${key}`);
};

const pageHasMarkers = async (tab, markers) => {
  const summary = await runtime.pageSummary(tab.windowId, markers);
  return { ...summary, all: summary.markers.every(Boolean) };
};

const waitForPageMarkers = async (tab, key, markers) => {
  const started = Date.now();
  const timeoutMs = Math.min(sheetReadyTimeoutMs, 120_000);
  await sleep(navigationSettleMs);
  let lastState = null;

  while (Date.now() - started < timeoutMs) {
    lastState = await pageHasMarkers(tab, markers);
    const missingMarkers = markers.filter((_, index) => !lastState.markers[index]);
    await log("resident_marker_check", {
      key,
      url: lastState.url,
      auth: lastState.auth,
      missingMarkers
    });
    if (lastState.auth) throw new Error(`Manual authentication required while checking resident tab: ${key}`);
    if (lastState.all) return lastState;
    await sleep(pollIntervalMs);
  }

  const missingMarkers = markers.filter((_, index) => !lastState?.markers?.[index]);
  throw new Error(`Resident tab did not become ready: ${key}; missing=${missingMarkers.join(", ")}`);
};

const waitForAdminAuthenticated = async (adminTab, timeoutMs) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await pageHasMarkers(adminTab, [config.admin.authenticatedMarker]);
    if (state.all) return true;
    if (state.auth) throw new Error("Manual authentication required: password, verification, or CAPTCHA is visible");
    await sleep(pollIntervalMs);
  }
  return false;
};

const recoverAdminLogin = async (adminTab) => {
  if (config.safety.allowGoogleSignInRecovery !== true) {
    throw new Error("対象管理画面 is logged out and Google sign-in recovery is disabled");
  }
  await log("resident_google_signin_started", { accountEmail: config.admin.googleAccountEmail });
  const labels = config.admin.googleSignInLabels;
  let clicked = false;
  for (const label of labels) {
    try {
      await runtime.clickExactText(adminTab.windowId, label, { delayMs: 500 });
      clicked = true;
      break;
    } catch {
      // Try the localized alternative.
    }
  }
  if (!clicked) throw new Error("Manual authentication required: Sign in with Google control was not uniquely available");
  await sleep(navigationSettleMs);

  if (await waitForAdminAuthenticated(adminTab, 10_000)) {
    await log("resident_google_signin_ok", { accountSelectionRequired: false });
    return;
  }

  const coordinates = await runtime.exactEmailCoordinates(adminTab.windowId, config.admin.googleAccountEmail);
  await runtime.clickWindowCoordinates(adminTab.windowId, coordinates);
  await sleep(navigationSettleMs);
  if (!(await waitForAdminAuthenticated(adminTab, config.admin.googleSignInTimeoutMs ?? 90_000))) {
    throw new Error("Manual authentication required: approved Google account was selected but 対象管理画面 did not authenticate");
  }
  await log("resident_google_signin_ok", { accountSelectionRequired: true });
};

const downloadReport = async (adminTab, mode, filename) => {
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
  const filePath = await moveDownloadIntoRun({ candidate, runDir: downloadWorkspace.runDir, canonicalName: filename });
  await log("resident_download_ok", { mode, canonicalFilename: filename, browserFilename: candidate.name, runFile: filePath });
  await sleep(actionSettleMs);
  return filePath;
};

const verifyAdminReportDateAvailable = async (adminTab) => {
  // 対象管理画面 does not update the available day options in a tab that remains
  // open across the date boundary. Explicitly verify the active project tab,
  // then bypass Chrome's cache with Ctrl+Shift+R. A reload is successful only
  // when a new document time origin and readyState=complete are both observed.
  // If the target date is genuinely absent, wait three minutes and repeat the
  // forced reload before stopping without downloads or GAS side effects.
  const targetDay = Number(reportDay);
  const dateIsUnavailable = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes(`Date option scroll safety stop: ${targetDay} was not uniquely visible`) &&
      message.includes("matches=0")
    ) || message.includes(`option ${targetDay} not found after Day`);
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await log("resident_admin_refresh_started", { reportDate, attempt, method: "ctrl+shift+r" });
      const reload = await runtime.reloadTab(adminTab.windowId, {
        forceReload: true,
        expectedUrlPrefix: config.admin.url
      });
      await sleep(navigationSettleMs);
      const refreshedAdminState = await pageHasMarkers(adminTab, [config.admin.authenticatedMarker]);
      if (!refreshedAdminState.all) await recoverAdminLogin(adminTab);
      await log("resident_admin_refresh_ok", { reportDate, attempt, reload });

      await runtime.clickExactText(adminTab.windowId, "Daily");
      await sleep(actionSettleMs);
      await runtime.setSelectFollowingLabel(adminTab.windowId, "Year", reportYear);
      await sleep(actionSettleMs);
      await runtime.setSelectFollowingLabel(adminTab.windowId, "Month", reportMonth);
      await sleep(actionSettleMs);
      await runtime.setSelectFollowingLabel(adminTab.windowId, "Day", reportDay);
      await sleep(actionSettleMs);
      await log("resident_report_date_available", { reportDate, attempt });
      return;
    } catch (error) {
      if (attempt === 1 && dateIsUnavailable(error)) {
        await log("resident_report_date_retry_wait", {
          reportDate,
          attempt,
          retryDelayMs: dateAvailabilityRetryDelayMs,
          reason: error instanceof Error ? error.message : String(error)
        });
        await sleep(dateAvailabilityRetryDelayMs);
        continue;
      }
      throw error;
    }
  }
};

const ensureDriveFolderTab = async (workspaceWindowId) => {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(config.drive.folderId || "")) {
    throw new Error("Drive folder ID is not configured safely");
  }
  const folderUrl = `https://drive.google.com/drive/folders/${config.drive.folderId}`;
  // Preflight already identified the one approved workspace window. Searching
  // only that window avoids repeatedly probing every Admin tab on a 4 GB VM.
  const driveTab = await runtime.activateMatchingTab(workspaceWindowId, (url) =>
    url.includes(`/drive/folders/${config.drive.folderId}`));
  if (!driveTab) {
    throw new Error(
      `The existing workspace Drive folder tab is not open: ${folderUrl}; ` +
      "resident mode will not create or navigate a tab"
    );
  }
  await waitForPageMarkers(driveTab, "drive-folder", [config.drive.folderName]);
  const confirmed = await runtime.pageSummary(driveTab.windowId, [config.drive.folderName]);
  if (!confirmed.url.includes(`/folders/${config.drive.folderId}`)) {
    throw new Error("Drive folder ID verification failed");
  }
  return driveTab;
};

const waitForDriveFilename = async (driveTab, filename) => {
  const started = Date.now();
  while (Date.now() - started < uploadTimeoutMs) {
    // Drive keeps completed-upload toasts in document.body after files have
    // been removed. Only an exact visible file row is acceptable evidence.
    const rowCount = await runtime.driveVisibleRowExactNameCount(driveTab.windowId, filename);
    if (rowCount === 1) return;
    if (rowCount > 1) {
      throw new Error(`Drive upload verification safety stop: duplicate exact rows=${rowCount} (${filename})`);
    }
    const state = await pageHasMarkers(driveTab, []);
    if (state.auth) throw new Error("workspace Drive authentication changed during upload");
    await sleep(pollIntervalMs);
  }
  throw new Error(`Drive upload could not be verified: ${filename}`);
};

const uploadFileToDrive = async (driveTab, filePath) => {
  const filename = path.basename(filePath);
  // Do not use body text here: a stale completed-upload toast can contain an
  // old filename even when the actual folder has no such file.
  const existingRowCount = await runtime.driveVisibleRowExactNameCount(driveTab.windowId, filename);
  if (existingRowCount > 0) {
    throw new Error(`Drive safety stop: a file already exists in レポート保存 (${filename})`);
  }
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
  const newButtonCoordinates = await retryReadOnly(() =>
    runtime.exactTextWindowCoordinates(driveTab.windowId, "新規")
      .catch(() => runtime.exactTextWindowCoordinates(driveTab.windowId, "New")));
  await runtime.clickWindowCoordinates(driveTab.windowId, newButtonCoordinates);
  await sleep(actionSettleMs);
  // Drive's menu text is rendered too softly for reliable OCR on the small VM.
  // The previously verified upload test uses the menu's stable keyboard order:
  // first item is New folder, second item is File upload.
  await runtime.activateWindow(driveTab.windowId);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Home"]);
  await sleep(1_000);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Down"]);
  await sleep(1_000);
  await runtime.run("xdotool", ["key", "--clearmodifiers", "Return"]);
  await log("resident_drive_file_upload_selected_by_menu_order", {
    selection: "second_item_after_home"
  });
  try {
    await runtime.chooseFile(filePath);
  } catch (error) {
    if (String(error instanceof Error ? error.message : error) !==
        "File chooser did not close after selecting the approved file") {
      throw error;
    }
    // A low-spec desktop can keep the portal chooser mapped after Drive has
    // already accepted the file. Reconcile only from the exact visible Drive
    // row; never click Upload a second time merely because the chooser lingered.
    await waitForDriveFilename(driveTab, filename);
    await log("resident_file_chooser_linger_reconciled_by_drive_row", { filename });
  }
  await waitForDriveFilename(driveTab, filename);
  await sleep(actionSettleMs);
  await log("resident_drive_upload_ok", { filename });
};

const archiveExistingMonthlyDriveFile = async (driveTab) => {
  const count = await runtime.driveVisibleRowExactNameCount(driveTab.windowId, monthlyName);
  if (count === 0) return null;
  if (count !== 1) {
    throw new Error(`Drive monthly archive safety stop: expected at most one exact row, found ${count} (${monthlyName})`);
  }
  const backupStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const backupName = monthlyName.replace(/\.csv$/, `.stale-backup-${backupStamp}.csv`);
  const archived = await runtime.renameDriveRowExactName(driveTab.windowId, monthlyName, backupName);
  await log("resident_drive_existing_monthly_archived", {
    originalName: monthlyName,
    backupName,
    archived
  });
  return archived;
};

const waitForSheetStable = async (tab, key) => {
  const started = Date.now();
  let stableSince = null;
  let previousHash = null;
  while (Date.now() - started < sheetReadyTimeoutMs) {
    // Ignore transient Sheets snackbars/toasts when deciding whether the
    // calculated sheet contents have settled. Their appearance/disappearance
    // must not restart the data-stability window.
    const state = await runtime.typeAddressJavascript(tab.windowId, "async()=>{let t=document.body?.innerText||'';const q='[role=alert],[role=status],[class*=snackbar],[class*=toast]',v=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};for(const e of document.querySelectorAll(q)){if(!v(e))continue;const x=(e.innerText||e.textContent||'').trim();if(x)t=t.split(x).join('')}const u=location.href;let h=0;for(let i=0;i<t.length;i++)h=(h*31+t.charCodeAt(i))|0;return{h,n:t.length,error:/#N\\/A|#REF!|#VALUE!|#ERROR!/.test(t),auth:/^https:\\/\\/accounts\\.google\\.com\\//i.test(u)||/^https:\\/\\/admin\\.example\\.com\\/login(?:[/?#]|$)/i.test(u)}}");
    if (state.auth) throw new Error(`Manual authentication required while waiting for sheet: ${key}`);
    if (state.error) {
      stableSince = null;
      previousHash = null;
    } else if (state.h === previousHash) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= sheetStableWindowMs) {
        await log("resident_sheet_stable", { key, stableWindowMs: sheetStableWindowMs });
        return;
      }
    } else {
      previousHash = state.h;
      // The first clean observation is already the beginning of a possible
      // stable window. Starting the clock only on the second identical sample
      // forced one unnecessary full address-bar probe on the small VM.
      stableSince = Date.now();
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Sheet did not become stable without formula errors: ${key}`);
};

const activateSheetTab = async (tab, sheet) => {
  const activeTab = await runtime.activateMatchingTab(tab.windowId, (url) =>
    url.includes(`/spreadsheets/d/${sheet.spreadsheetId}/`));
  if (!activeTab) throw new Error(`Required GAS tab could not be activated: ${sheet.key}`);
  await log("resident_gas_tab_activated", { sheetKey: sheet.key, windowId: activeTab.windowId });
  return activeTab;
};

const ensureConfiguredSheetActive = async (activeTab, sheet, failureLabel = "Active sheet safety check failed") => {
  if (!sheet.expectedGid || gidFromUrl(activeTab.url) === String(sheet.expectedGid)) return activeTab;
  const targetUrl = `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit?gid=${sheet.expectedGid}#gid=${sheet.expectedGid}`;
  const navigated = await runtime.navigateTab(activeTab.windowId, targetUrl);
  await sleep(actionSettleMs);
  if (!navigated.url.includes(`/spreadsheets/d/${sheet.spreadsheetId}/`) ||
      gidFromUrl(navigated.url) !== String(sheet.expectedGid)) {
    throw new Error(`${failureLabel} for ${sheet.key}`);
  }
  await log("resident_configured_sheet_navigated", {
    sheetKey: sheet.key,
    windowId: activeTab.windowId,
    expectedGid: String(sheet.expectedGid)
  });
  return { ...activeTab, url: navigated.url };
};

const runGasAction = async (
  tab,
  sheet,
  action,
  { waitForStable = false, acceptedWarningLabels = [] } = {}
) => {
  const actionKey = `${sheet.key}:${action}`;
  const successLabels = gasSuccessLabels[actionKey];
  if (!successLabels) throw new Error(`GAS result safety stop: success text is not configured for ${actionKey}`);
  const activeTab = await activateSheetTab(tab, sheet);
  await runtime.ensureWindowMaximized(activeTab.windowId);
  // First identify the already-open browser tab by spreadsheet ID. The sheet
  // inside that document may legitimately be the startup/default sheet (for
  // example the import workbook's monthly sheet), so select the configured
  // sheet here and verify its gid before any GAS action.
  await ensureConfiguredSheetActive(activeTab, sheet);
  if (dailyRunPath) await updateDailyRun(dailyRunPath, { stage: `gas_ready:${sheet.key}:${action}` });

  const refreshBlockingNotification = async (reason) => {
    const notification = await runtime.visibleSheetsBlockingNotification(activeTab.windowId);
    if (!notification.visible) return false;
    const expectedUrlPrefix = `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/`;
    await log("resident_sheets_blocking_notification_detected", {
      sheetKey: sheet.key,
      action,
      reason,
      text: notification.text,
      count: notification.count
    });
    await runtime.reloadTab(activeTab.windowId, { expectedUrlPrefix });
    const refreshedTab = await activateSheetTab(activeTab, sheet);
    await ensureConfiguredSheetActive(refreshedTab, sheet, "Post-notification refresh sheet safety check failed");
    await waitForSheetStable(activeTab, sheet.key);
    await log("resident_sheets_blocking_notification_cleared_by_reload", {
      sheetKey: sheet.key,
      action,
      reason
    });
    return true;
  };

  await refreshBlockingNotification("before-menu-selection");
  let selected;
  try {
    selected = await runtime.clickCustomMenuActionByOrder(
      activeTab.windowId,
      sheet.menu,
      sheet.actions,
      action
    );
  } catch (error) {
    const menuBlocked = /Custom menu safety stop: approved action did not become visible/.test(String(error));
    if (!menuBlocked || !(await refreshBlockingNotification("after-menu-recognition-failure"))) throw error;
    selected = await runtime.clickCustomMenuActionByOrder(
      activeTab.windowId,
      sheet.menu,
      sheet.actions,
      action,
      { menuOpenAttempts: 1 }
    );
  }
  if (dailyRunPath) {
    await updateDailyRun(dailyRunPath, {
      stage: `gas_started:${sheet.key}:${action}`,
      gasMenuSelectedAt: new Date().toISOString()
    });
  }
  await log("resident_gas_menu_action_selected", {
    sheetKey: sheet.key,
    menu: sheet.menu,
    action,
    actionIndex: selected.actionIndex
  });
  let dialog;
  try {
    dialog = await runtime.waitForDialog(activeTab.windowId, gasDialogTimeoutMs, 1_500, {
      successLabels,
      warningLabels: acceptedWarningLabels
    });
  } catch (error) {
    const timedOut = String(error instanceof Error ? error.message : error) ===
      "Timed out waiting for the GAS result dialog";
    if (!timedOut || acceptedWarningLabels.length === 0) throw error;
    const notification = await runtime.visibleSheetsBlockingNotification(activeTab.windowId);
    const normalizedNotification = notification.text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    const matchedWarningLabel = acceptedWarningLabels.find((label) =>
      normalizedNotification.includes(label.normalize("NFKC").replace(/\s+/g, "").toLowerCase()));
    if (!notification.visible || !matchedWarningLabel) throw error;
    dialog = {
      visible: true,
      text: notification.text,
      error: false,
      warning: true,
      notification: true,
      matchedWarningLabel,
      confirmation: null
    };
    await log("resident_gas_warning_notification_recovered_after_timeout", {
      sheetKey: sheet.key,
      action,
      matchedWarningLabel
    });
  }
  if (dialog.error) throw new Error(`${sheet.key}:${action} failed: ${dialog.text}`);
  await log(dialog.warning ? "resident_gas_dialog_warning_accepted" : "resident_gas_dialog_ok", {
    sheetKey: sheet.key,
    action,
    result: dialog.text,
    matchedWarningLabel: dialog.matchedWarningLabel || null
  });
  // Persist positive evidence before sending OK. If anything fails after this
  // point, a recovery must never start the same one-per-day GAS action again.
  if (dailyRunPath) {
    const current = await readDailyRun(root, reportDate);
    if (dialog.warning) {
      const warningGasActions = [...new Set([...(current?.warningGasActions || []), actionKey])];
      await updateDailyRun(dailyRunPath, {
        stage: `gas_warning_acknowledged:${sheet.key}:${action}`,
        warningGasActions,
        gasWarnings: [
          ...(current?.gasWarnings || []),
          { actionKey, text: dialog.text, at: new Date().toISOString() }
        ]
      });
    } else {
      const confirmedGasActions = [...new Set([...(current?.confirmedGasActions || []), actionKey])];
      await updateDailyRun(dailyRunPath, {
        stage: `gas_result_confirmed:${sheet.key}:${action}`,
        confirmedGasAction: actionKey,
        confirmedGasActions,
        gasResultConfirmedAt: new Date().toISOString()
      });
    }
  }
  let confirmationMethod = null;
  if (!dialog.notification) {
    confirmationMethod = await runtime.confirmDialog(activeTab.windowId, dialog);
    await log("resident_gas_dialog_confirmation_sent", {
      sheetKey: sheet.key,
      action,
      confirmationMethod
    });
  } else {
    await log("resident_gas_warning_notification_requires_reload", {
      sheetKey: sheet.key,
      action,
      matchedWarningLabel: dialog.matchedWarningLabel
    });
  }
  // OCR plus the non-typing focus probe can take more than 30 seconds on the
  // small VM. Allow enough time for two independent dismissal confirmations.
  if (!dialog.notification) {
    await runtime.waitForDialogDismissed(activeTab.windowId, 120_000, {
      confirmationMethod,
      successLabels: dialog.warning ? acceptedWarningLabels : successLabels
    });
    await log("resident_gas_dialog_dismissed", { sheetKey: sheet.key, action });
  }
  // Google Sheets briefly shows a black "script finished" snackbar after OK.
  // It can cover or intercept the next custom-menu click, especially on the
  // small VM. Always let that transient UI expire before doing anything else.
  await sleep(Math.max(actionSettleMs, postGasOkSettleMs));
  await log("resident_post_gas_settle_completed", {
    sheetKey: sheet.key,
    action,
    waitedMs: Math.max(actionSettleMs, postGasOkSettleMs)
  });
  // The final department action has no following GAS action to perform the
  // normal pre-menu notification check. Clear a lingering black Sheets script
  // notification here too so it cannot obstruct the next scheduled run.
  await refreshBlockingNotification("after-dialog-dismissal");
  if (waitForStable) await waitForSheetStable(activeTab, sheet.key);
  if (dailyRunPath) {
    const current = await readDailyRun(root, reportDate);
    const completedGasActions = [...new Set([...(current?.completedGasActions || []), actionKey])];
    await updateDailyRun(dailyRunPath, {
      stage: `gas_completed:${sheet.key}:${action}`,
      completedGasActions,
      confirmedGasAction: null,
      gasCompletedAt: new Date().toISOString()
    });
  }
  return {
    status: dialog.warning ? "warning" : "confirmed",
    warning: Boolean(dialog.warning),
    result: dialog.text
  };
};

const verifyImportOutput = async (_tab, importSheet, method) => {
  const verification = await verifyImportSheetReportDate({
    sheet: importSheet,
    reportDate,
    auth: config.sheetsReadVerification
  });
  await log("resident_import_sheet_date_verified", { reportDate, method, ...verification });
  return verification;
};

const recordNonBlockingWarning = async (category, warning, details = {}) => {
  if (dailyRunPath) {
    const current = await readDailyRun(root, reportDate);
    await updateDailyRun(dailyRunPath, {
      warnings: [
        ...(current?.warnings || []),
        { category, warning, details, at: new Date().toISOString() }
      ]
    });
  }
  await log("resident_nonblocking_warning", { category, warning, ...details });
};

const reconcileImportUiAfterApiVerification = async (tab, importSheet) => {
  const action = "データインポート";
  try {
    const activeTab = await activateSheetTab(tab, importSheet);
    const expectedUrlPrefix = `https://docs.google.com/spreadsheets/d/${importSheet.spreadsheetId}/`;
    if (!activeTab.url.startsWith(expectedUrlPrefix)) {
      throw new Error("the active tab was not the configured import spreadsheet");
    }

    // The date API has already proved that this one-per-day GAS action
    // completed. If a browser-modal result still owns focus, send one Return
    // to its default button. If the dialog disappeared before the API check,
    // Ctrl+L succeeds and no key is sent to the page.
    const addressBarAvailable = await runtime.probeAddressBarAvailableWithoutEscape(activeTab.windowId);
    let modalCleanup = "not-present";
    if (!addressBarAvailable) {
      await runtime.activateWindow(activeTab.windowId);
      await runtime.run("xdotool", ["key", "--clearmodifiers", "Return"]);
      modalCleanup = "api-verified-default-button-once";
      await log("resident_import_api_verified_modal_confirmation_sent", {
        sheetKey: importSheet.key,
        action
      });
      await sleep(2_000);
      const cleared = await runtime.probeAddressBarAvailableWithoutEscape(activeTab.windowId);
      if (!cleared) {
        throw new Error("the API-verified import modal did not release focus after one confirmation");
      }
    }

    let notificationCleanup = "not-present";
    const notification = await runtime.visibleSheetsBlockingNotification(activeTab.windowId);
    if (notification.visible) {
      await log("resident_import_post_api_notification_detected", {
        text: notification.text,
        count: notification.count
      });
      await runtime.reloadTab(activeTab.windowId, { expectedUrlPrefix });
      const refreshedTab = await activateSheetTab(activeTab, importSheet);
      await ensureConfiguredSheetActive(
        refreshedTab,
        importSheet,
        "Post-import API cleanup sheet safety check failed"
      );
      notificationCleanup = "existing-tab-reloaded";
    }

    const result = { status: "reconciled", modalCleanup, notificationCleanup };
    await log("resident_import_post_api_ui_reconciled", result);
    return result;
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    await recordNonBlockingWarning("import-ui-cleanup", warning, {
      action: "import:データインポート"
    });
    return { status: "warning", warning };
  }
};

const auditDriveCleanupNonBlocking = async () => {
  const attempts = Math.max(1, Number(config.drive?.cleanupAuditAttempts ?? 3));
  const retryDelayMs = Math.max(0, Number(config.drive?.cleanupAuditRetryDelayMs ?? 5_000));
  let verification = null;
  let attemptsUsed = 0;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      attemptsUsed = attempt;
      verification = await readDriveExactFileCounts({
        folderId: config.drive.folderId,
        filenames: expectedFiles,
        auth: config.driveReadVerification
      });
      await log("resident_drive_cleanup_api_checked", { attempt, ...verification });
      if (verification.verifiedAbsent) break;
      if (attempt < attempts) await sleep(retryDelayMs);
    }

    if (verification.verifiedAbsent) {
      const result = { status: "verified-absent", attempts: attemptsUsed, ...verification };
      await log("resident_drive_cleanup_verified_by_api", result);
      return result;
    }

    const warning = `Drive cleanup audit found exact files still present: ${JSON.stringify(verification.counts)}`;
    await recordNonBlockingWarning("drive-cleanup-files-remaining", warning, {
      counts: verification.counts
    });
    return { status: "files-remaining", attempts: attemptsUsed, ...verification };
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    await recordNonBlockingWarning("drive-cleanup-audit-unavailable", warning);
    return { status: "unavailable", warning };
  }
};

const readMainImportOutput = async (mainSheet, method) => {
  const verification = await readSheetDateRange({
    sheet: mainSheet,
    expectedDate: executionDate,
    auth: config.sheetsReadVerification
  });
  await log("resident_main_import_a1_checked", {
    reportDate,
    executionDate,
    method,
    ...verification
  });
  return verification;
};

const recordGasActionCompletedByEvidence = async ({
  sheetKey,
  action,
  evidence,
  warning = null
}) => {
  const actionKey = `${sheetKey}:${action}`;
  const current = await readDailyRun(root, reportDate);
  const completedGasActions = [...new Set([...(current?.completedGasActions || []), actionKey])];
  const unconfirmedGasActions = warning
    ? [...new Set([...(current?.unconfirmedGasActions || []), actionKey])]
    : (current?.unconfirmedGasActions || []);
  await updateDailyRun(dailyRunPath, {
    status: "started",
    stage: `gas_completed:${sheetKey}:${action}`,
    completedGasActions,
    unconfirmedGasActions,
    gasCompletedAt: new Date().toISOString(),
    evidenceAcceptedGasAction: actionKey,
    evidenceAcceptedAt: new Date().toISOString(),
    gasEvidence: [
      ...(current?.gasEvidence || []),
      { actionKey, evidence, at: new Date().toISOString() }
    ],
    warnings: warning
      ? [...(current?.warnings || []), { actionKey, warning, at: new Date().toISOString() }]
      : (current?.warnings || []),
    error: undefined,
    failedAt: undefined
  });
  await log("resident_gas_action_completed_by_evidence", {
    reportDate,
    actionKey,
    evidence,
    warning
  });
};

const verifyResidentTabs = async () => {
  const adminTab = await findRequiredTab("source-admin", (url) =>
    url.startsWith(config.admin.url) || url.startsWith("https://admin.example.com/login"));

  const chromeWindows = await runtime.listChromeWindows();
  if (chromeWindows.length !== 2) {
    throw new Error(`Expected exactly two resident Chrome windows, found ${chromeWindows.length}`);
  }
  const workspaceWindowIds = chromeWindows.filter((windowId) => windowId !== adminTab.windowId);
  if (workspaceWindowIds.length !== 1) {
    throw new Error("Could not uniquely identify the workspace Chrome profile window");
  }

  // Never search for Drive or Sheets in the project/Admin window. Once the
  // workspace window is identified, keep all remaining tab checks inside it.
  const driveTab = await findRequiredTabInWindows("drive-folder", workspaceWindowIds, (url) =>
    url.includes(`/drive/folders/${config.drive.folderId}`));
  await waitForPageMarkers(driveTab, "drive-folder", [config.drive.folderName]);
  const sheetTabs = new Map();
  for (const sheet of config.sheets) {
    const tab = await findRequiredTabInWindows(sheet.key, [driveTab.windowId], (url) =>
      url.includes(`/spreadsheets/d/${sheet.spreadsheetId}/`));
    await waitForPageMarkers(tab, sheet.key, [...sheet.requiredSheets, sheet.menu]);
    sheetTabs.set(sheet.key, tab);
  }
  const workspaceWindows = new Set([driveTab, ...sheetTabs.values()].map(({ windowId }) => windowId));
  if (workspaceWindows.size !== 1) throw new Error("Drive and the three workspace sheets are not in one Chrome profile window");
  if (workspaceWindows.has(adminTab.windowId)) throw new Error("Project and workspace tabs are in the same Chrome profile window");
  await log("resident_preflight_ok", { adminWindowId: adminTab.windowId, workspaceWindowId: [...workspaceWindows][0] });
  return { adminTab, driveTab, sheetTabs, workspaceWindowId: [...workspaceWindows][0] };
};

await log("resident_run_started", { preflightOnly, liveRequested, reportDate, slowMode: true });

if (config.skipDaysOfMonth.includes(dayOfMonth)) {
  await log("resident_run_skipped", { reason: "monthly_sheet_update_day", dayOfMonth });
  process.exit(0);
}

try {
  assertGasConfiguration();
  if (!preflightOnly) assertLiveSafety();

  // Timer invocations after the first attempt must be state-only no-ops unless
  // the recorded failure is one of the narrowly approved automatic recovery
  // cases below. In particular, do not initialize or focus Chrome merely to
  // discover that today's run already completed or cannot be resumed safely.
  if (!preflightOnly) {
    existingRun = await readDailyRun(root, reportDate);
    const existingGasEvidence = existingRun?.status === "failed"
      ? await readGasCompletionEvidence(existingRun)
      : { importConfirmed: false, mainImportConfirmed: false };
    const knownPostMainImportStableCheckFailure = existingRun?.status === "failed" &&
      existingRun?.stage === "gas_started:main:①データインポート" &&
      existingRun?.error === "Address-bar typing safety stop: the omnibox did not contain the complete intended text" &&
      existingGasEvidence.importConfirmed &&
      existingGasEvidence.mainImportConfirmed;
    resumeAfterMainImportConfirmed = resumeAfterMainImportConfirmed || knownPostMainImportStableCheckFailure;
    const mainImportActionWasStarted = existingRun?.status === "failed" &&
      [
        "gas_started:main:①データインポート",
        "gas_result_confirmed:main:①データインポート",
        "gas_completed:main:①データインポート"
      ].includes(existingRun?.stage);
    if (mainImportActionWasStarted && !resumeAfterMainImportConfirmed) {
      const mainSheet = config.sheets.find(({ key }) => key === "main");
      const verification = await readMainImportOutput(mainSheet, "timer-recovery-before-chrome").catch(() => null);
      if (verification?.verified) {
        const statePath = path.join(root, "state", `${reportDate}.json`);
        const actionKey = "main:①データインポート";
        await updateDailyRun(statePath, {
          status: "started",
          stage: "gas_completed:main:①データインポート",
          completedGasActions: [...new Set([...(existingRun.completedGasActions || []), actionKey])],
          mainImportSheetVerifiedAt: new Date().toISOString(),
          mainImportSheetVerification: verification,
          resumedAfterMainImportSheetVerificationAt: new Date().toISOString(),
          error: undefined,
          failedAt: undefined
        });
        resumeAfterMainImportBySheet = true;
        resumeAfterMainImportConfirmed = true;
        await log("resident_main_import_recovered_by_a1_before_chrome", { reportDate, verification });
      }
    }
    const knownPreImportSheetActivationFailure = existingRun?.status === "failed" &&
      existingRun?.stage === "drive_upload_completed" &&
      existingRun?.error === "Active sheet safety check failed for import";
    resumeAfterUploads = resumeAfterUploads || knownPreImportSheetActivationFailure;
    const knownDateAvailabilityFailure = existingRun?.status === "failed" &&
      existingRun?.stage === "downloads_started" &&
      (
        existingRun?.error === `Resident page command failed: expected one visible option ${Number(reportDay)} after Day, found 0` ||
        (
          existingRun?.error?.includes(`Date option scroll safety stop: ${Number(reportDay)} was not uniquely visible`) &&
          existingRun?.error?.includes("matches=0")
        )
      );
    resumeAfterMonthlyDateAvailability = Boolean(
      knownDateAvailabilityFailure &&
      !resumeAfterDownloads &&
      !resumeAfterUploads &&
      !resumeAfterImportConfirmed &&
      !resumeAfterMainMenuBlocked &&
      !resumeAfterMainMenuDiagnosticStop &&
      !resumeAfterMainImportConfirmed &&
      !resumeAfterMainChatworkConfirmed
    );
    const knownMonthlyDriveDuplicate = existingRun?.status === "failed" &&
      (
        (
          existingRun?.stage === "drive_upload_started" &&
          existingRun?.error === `Drive safety stop: a file already exists in レポート保存 (${monthlyName})`
        ) ||
        (
          existingRun?.stage === "downloads_completed" &&
          existingRun?.error === "Address-bar focus safety stop: the selected text was not a browser URL"
        )
      );
    resumeAfterKnownMonthlyDriveDuplicate = Boolean(
      knownMonthlyDriveDuplicate &&
      !resumeAfterDownloads &&
      !resumeAfterUploads &&
      !resumeAfterImportConfirmed &&
      !resumeAfterMainMenuBlocked &&
      !resumeAfterMainMenuDiagnosticStop &&
      !resumeAfterMainImportConfirmed &&
      !resumeAfterMainChatworkConfirmed
    );
    const knownPartialDriveUploadFailure = existingRun?.status === "failed" &&
      existingRun?.stage === "drive_upload_started" &&
      existingRun?.error === "File chooser did not close after selecting the approved file";
    resumeAfterPartialDriveUpload = Boolean(
      knownPartialDriveUploadFailure &&
      !resumeAfterDownloads &&
      !resumeAfterUploads &&
      !resumeAfterImportConfirmed &&
      !resumeAfterMainMenuBlocked &&
      !resumeAfterMainMenuDiagnosticStop &&
      !resumeAfterMainImportConfirmed &&
      !resumeAfterMainChatworkConfirmed &&
      !resumeAfterKnownMonthlyDriveDuplicate
    );
    if (existingRun &&
        !resumeAfterDownloads &&
        !resumeAfterUploads &&
        !resumeAfterImportConfirmed &&
        !resumeAfterMainMenuBlocked &&
        !resumeAfterMainMenuDiagnosticStop &&
        !resumeAfterMainImportConfirmed &&
        !resumeAfterMainChatworkConfirmed &&
        !resumeAfterMonthlyDateAvailability &&
        !resumeAfterKnownMonthlyDriveDuplicate &&
        !resumeAfterPartialDriveUpload) {
      await log("resident_run_skipped_existing_state", {
        reportDate,
        status: existingRun.status,
        stage: existingRun.stage,
        chromeInitialized: false
      });
      console.log(`RESIDENT_RUN_ALREADY_RECORDED status=${existingRun.status} stage=${existingRun.stage}`);
      process.exit(0);
    }
  }

  await access(downloadDir);
  await runtime.initialize();
  const { adminTab, sheetTabs, workspaceWindowId } = await verifyResidentTabs();

  const adminState = await pageHasMarkers(adminTab, [config.admin.authenticatedMarker]);
  if (!adminState.all) {
    if (preflightOnly) throw new Error("対象管理画面 is logged out; preflight will not attempt recovery");
    await recoverAdminLogin(adminTab);
  }

  if (preflightOnly) {
    await log("resident_execution_blocked", { reason: "preflight_only" });
    console.log("RESIDENT_PREFLIGHT_OK");
    process.exit(0);
  }

  // 対象管理画面 can publish the previous day's option after the scheduled start
  // time. Verify availability before creating run state or downloading the
  // monthly CSV so a later timer attempt remains safe and side-effect free.
  if (!resumeAfterDownloads && !resumeAfterUploads && !resumeAfterImportConfirmed && !resumeAfterMainMenuBlocked && !resumeAfterMainMenuDiagnosticStop && !resumeAfterMainImportConfirmed && !resumeAfterMainChatworkConfirmed && !resumeAfterKnownMonthlyDriveDuplicate && !resumeAfterPartialDriveUpload) {
    await verifyAdminReportDateAvailable(adminTab);
  }

  let files;
  let trustedImportVerification = false;
  if (resumeAfterMainChatworkConfirmed) {
    const previous = await readDailyRun(root, reportDate);
    const actionKey = "main:②Chatworkに報告";
    if (previous?.status !== "failed" ||
        previous?.stage !== "gas_started:main:②Chatworkに報告" ||
        previous?.error !== "Timed out waiting for the GAS result dialog") {
      throw new Error("Post-main-Chatwork resume safety stop: the exact timed-out action state was not recorded");
    }
    if (!previous.mainChatworkUserConfirmedAt) {
      throw new Error("Post-main-Chatwork resume safety stop: user confirmation evidence is missing");
    }
    if (!previous.completedGasActions?.includes("main:①データインポート") ||
        previous.importSheetVerification?.verified !== true ||
        previous.importSheetVerification?.expectedDate !== reportDate) {
      throw new Error("Post-main-Chatwork resume safety stop: prior import completion evidence is incomplete");
    }
    if (!previous.runDir || !Array.isArray(previous.files) || expectedFiles.some((name) => !previous.files.includes(name))) {
      throw new Error("Post-main-Chatwork resume safety stop: the previous download workspace is incomplete");
    }
    files = expectedFiles.map((name) => path.join(previous.runDir, name));
    for (const file of files) await access(file);
    dailyRunPath = path.join(root, "state", `${reportDate}.json`);
    trustedImportVerification = true;
    await updateDailyRun(dailyRunPath, {
      status: "started",
      stage: "gas_completed:main:②Chatworkに報告",
      confirmedGasActions: [...new Set([...(previous.confirmedGasActions || []), actionKey])],
      completedGasActions: [...new Set([...(previous.completedGasActions || []), actionKey])],
      resumedAfterMainChatworkConfirmationAt: new Date().toISOString(),
      mainChatworkConfirmationMethod: "user-confirmed-message-received",
      error: undefined,
      failedAt: undefined
    });
    await log("resident_run_resumed_after_main_chatwork_confirmation", { reportDate });
  } else if (resumeAfterMainImportConfirmed) {
    const previous = await readDailyRun(root, reportDate);
    const previousGasEvidence = await readGasCompletionEvidence(previous);
    const knownStableCheckFailure = previous?.status === "failed" &&
      previous?.stage === "gas_started:main:①データインポート" &&
      previous?.error === "Address-bar typing safety stop: the omnibox did not contain the complete intended text" &&
      previousGasEvidence.importConfirmed &&
      previousGasEvidence.mainImportConfirmed;
    if (!knownStableCheckFailure &&
        (previous?.status !== "started" || previous?.stage !== "gas_completed:main:①データインポート")) {
      throw new Error("Post-main-import resume safety stop: main import completion was not explicitly confirmed");
    }
    const sheetVerifiedResume = previous.mainImportSheetVerification?.verified === true &&
      previous.mainImportSheetVerification?.expectedDate === executionDate &&
      Boolean(previous.resumedAfterMainImportSheetVerificationAt);
    if ((!previous.resumedAfterMainImportDialogAt && !knownStableCheckFailure && !sheetVerifiedResume) ||
        (!previous.resumedAfterImportDialogAt && !previousGasEvidence.importConfirmed)) {
      throw new Error("Post-main-import resume safety stop: prior dialog confirmation evidence is missing");
    }
    if (!previous.runDir || !Array.isArray(previous.files) || expectedFiles.some((name) => !previous.files.includes(name))) {
      throw new Error("Post-main-import resume safety stop: the previous download workspace is incomplete");
    }
    files = expectedFiles.map((name) => path.join(previous.runDir, name));
    for (const file of files) await access(file);
    dailyRunPath = path.join(root, "state", `${reportDate}.json`);
    if (knownStableCheckFailure) {
      await updateDailyRun(dailyRunPath, {
        status: "started",
        stage: "gas_completed:main:①データインポート",
        resumedAfterMainImportDialogAt: new Date().toISOString(),
        resumedAfterImportDialogAt: previous.resumedAfterImportDialogAt || new Date().toISOString(),
        mainImportDialogConfirmationMethod: "confirmed-before-stability-check",
        error: undefined,
        failedAt: undefined
      });
    }
    await log("resident_run_resumed_after_main_import_dialog", {
      reportDate,
      sheetVerifiedResume,
      resumeAfterMainImportBySheet
    });
  } else if (resumeAfterMainMenuDiagnosticStop) {
    const previous = await readDailyRun(root, reportDate);
    if (previous?.status !== "started" || previous?.stage !== "gas_started:main:①データインポート") {
      throw new Error("Post-diagnostic resume safety stop: the exact pre-action main GAS state was not recorded");
    }
    if (!previous.resumedAfterMainMenuBlockedAt || !previous.resumedAfterImportDialogAt) {
      throw new Error("Post-diagnostic resume safety stop: prior import and menu-resume evidence is missing");
    }
    if (!previous.runDir || !Array.isArray(previous.files) || expectedFiles.some((name) => !previous.files.includes(name))) {
      throw new Error("Post-diagnostic resume safety stop: the previous download workspace is incomplete");
    }
    files = expectedFiles.map((name) => path.join(previous.runDir, name));
    for (const file of files) await access(file);
    dailyRunPath = path.join(root, "state", `${reportDate}.json`);
    await updateDailyRun(dailyRunPath, {
      stage: "gas_ready:main:①データインポート",
      resumedAfterMainMenuDiagnosticStopAt: new Date().toISOString()
    });
    await log("resident_run_resumed_after_main_menu_diagnostic_stop", { reportDate });
  } else if (resumeAfterMainMenuBlocked) {
    const previous = await readDailyRun(root, reportDate);
    const expectedError = "Custom menu safety stop: approved action did not become visible: 集計用:①データインポート";
    if (previous?.status !== "failed" || previous?.stage !== "gas_started:main:①データインポート") {
      throw new Error("Post-menu resume safety stop: the main GAS menu failure state was not recorded");
    }
    if (previous.error !== expectedError) {
      throw new Error(`Post-menu resume safety stop: unexpected previous error: ${previous.error || "missing"}`);
    }
    if (!previous.resumedAfterImportDialogAt) {
      throw new Error("Post-menu resume safety stop: prior import completion evidence is missing");
    }
    if (!previous.runDir || !Array.isArray(previous.files) || expectedFiles.some((name) => !previous.files.includes(name))) {
      throw new Error("Post-menu resume safety stop: the previous download workspace is incomplete");
    }
    files = expectedFiles.map((name) => path.join(previous.runDir, name));
    for (const file of files) await access(file);
    dailyRunPath = path.join(root, "state", `${reportDate}.json`);
    await updateDailyRun(dailyRunPath, {
      status: "started",
      stage: "gas_ready:main:①データインポート",
      resumedAfterMainMenuBlockedAt: new Date().toISOString(),
      error: undefined,
      failedAt: undefined
    });
    await log("resident_run_resumed_after_main_menu_blocked", { reportDate });
  } else if (resumeAfterImportConfirmed) {
    const previous = await readDailyRun(root, reportDate);
    const knownRepeatedVerificationFailure = previous?.status === "failed" &&
      previous?.stage === "gas_completed:import:データインポート" &&
      previous?.error === "Address-bar typing safety stop: the omnibox did not contain the complete intended text" &&
      previous?.importSheetVerification?.verified === true &&
      previous?.importSheetVerification?.expectedDate === reportDate;
    if (!knownRepeatedVerificationFailure &&
        (previous?.status !== "started" || previous?.stage !== "gas_completed:import:データインポート")) {
      throw new Error("Post-import resume safety stop: import completion was not explicitly confirmed");
    }
    if (!previous.resumedAfterImportDialogAt) {
      throw new Error("Post-import resume safety stop: dialog confirmation timestamp is missing");
    }
    if (!previous.runDir || !Array.isArray(previous.files) || expectedFiles.some((name) => !previous.files.includes(name))) {
      throw new Error("Post-import resume safety stop: the previous download workspace is incomplete");
    }
    files = expectedFiles.map((name) => path.join(previous.runDir, name));
    for (const file of files) await access(file);
    dailyRunPath = path.join(root, "state", `${reportDate}.json`);
    trustedImportVerification = previous.importSheetVerification?.verified === true &&
      previous.importSheetVerification?.expectedDate === reportDate;
    if (knownRepeatedVerificationFailure) {
      await updateDailyRun(dailyRunPath, {
        status: "started",
        stage: "gas_completed:import:データインポート",
        resumedAfterTrustedImportVerificationAt: new Date().toISOString(),
        error: undefined,
        failedAt: undefined
      });
    }
    await log("resident_run_resumed_after_import_dialog", { reportDate, files: expectedFiles });
  } else if (resumeAfterUploads) {
    const previous = await readDailyRun(root, reportDate);
    const knownPreImportSheetActivationFailure = previous?.status === "failed" &&
      previous?.stage === "drive_upload_completed" &&
      previous?.error === "Active sheet safety check failed for import";
    const knownPreImportGasFailure = previous?.status === "failed" &&
      previous?.stage === "gas_started:import:データインポート";
    if (!knownPreImportSheetActivationFailure && !knownPreImportGasFailure) {
      throw new Error("Post-upload resume safety stop: the previous attempt was not stopped before the first GAS action");
    }
    const knownPreImportGasErrors = [
      "Resident Chrome page command did not return a result",
      "Custom menu safety stop: approved action did not become visible: 集計用:データインポート"
    ];
    if (!knownPreImportSheetActivationFailure && !knownPreImportGasErrors.includes(previous.error)) {
      throw new Error(`Post-upload resume safety stop: unexpected previous error: ${previous.error || "missing"}`);
    }
    if (!previous.runDir || !Array.isArray(previous.files) || expectedFiles.some((name) => !previous.files.includes(name))) {
      throw new Error("Post-upload resume safety stop: the previous download workspace is incomplete");
    }
    files = expectedFiles.map((name) => path.join(previous.runDir, name));
    for (const file of files) await access(file);
    dailyRunPath = path.join(root, "state", `${reportDate}.json`);
    await updateDailyRun(dailyRunPath, {
      status: "started",
      stage: "drive_upload_completed",
      resumedAfterUploadsAt: new Date().toISOString(),
      error: undefined,
      failedAt: undefined
    });
  } else if (resumeAfterPartialDriveUpload) {
    const previous = await readDailyRun(root, reportDate);
    if (previous?.status !== "failed" ||
        previous?.stage !== "drive_upload_started" ||
        previous?.error !== "File chooser did not close after selecting the approved file") {
      throw new Error("Partial Drive resume safety stop: the exact chooser failure was not recorded");
    }
    if (!previous.runDir || !Array.isArray(previous.files) || expectedFiles.some((name) => !previous.files.includes(name))) {
      throw new Error("Partial Drive resume safety stop: the previous download workspace is incomplete");
    }
    files = expectedFiles.map((name) => path.join(previous.runDir, name));
    for (const file of files) await access(file);
    dailyRunPath = path.join(root, "state", `${reportDate}.json`);
    await updateDailyRun(dailyRunPath, {
      status: "started",
      stage: "drive_upload_started",
      resumedAfterPartialDriveUploadAt: new Date().toISOString(),
      error: undefined,
      failedAt: undefined
    });
    await log("resident_run_resumed_after_partial_drive_upload", { reportDate, files: expectedFiles });
  } else if (resumeAfterKnownMonthlyDriveDuplicate) {
    const previous = await readDailyRun(root, reportDate);
    if (!previous?.runDir || !Array.isArray(previous.files) || expectedFiles.some((name) => !previous.files.includes(name))) {
      throw new Error("Monthly duplicate resume safety stop: the previous download workspace is incomplete");
    }
    files = expectedFiles.map((name) => path.join(previous.runDir, name));
    for (const file of files) await access(file);
    dailyRunPath = path.join(root, "state", `${reportDate}.json`);
    await updateDailyRun(dailyRunPath, {
      status: "started",
      stage: "downloads_completed",
      resumedAfterMonthlyDriveDuplicateAt: new Date().toISOString(),
      error: undefined,
      failedAt: undefined
    });
    await log("resident_run_resumed_after_monthly_drive_duplicate", { reportDate, files: expectedFiles });
  } else if (resumeAfterDownloads) {
    const previous = await readDailyRun(root, reportDate);
    if (previous?.status !== "failed" || previous?.stage !== "drive_upload_started") {
      throw new Error("Resume safety stop: the previous attempt did not fail before Drive upload");
    }
    const knownDriveFolderFailure = previous.error === `Drive folder was not uniquely available: ${config.drive.folderName}` ||
      previous.error === "Drive folder was not uniquely available: " ||
      previous.error === "OCR safety stop: approved text matches=0" ||
      previous.error === "Address-bar focus safety stop: the selected text was not a browser URL";
    if (!knownDriveFolderFailure) {
      throw new Error(`Resume safety stop: unexpected previous error: ${previous.error || "missing"}`);
    }
    if (!previous.runDir || !Array.isArray(previous.files) || expectedFiles.some((name) => !previous.files.includes(name))) {
      throw new Error("Resume safety stop: the previous download workspace is incomplete");
    }
    files = expectedFiles.map((name) => path.join(previous.runDir, name));
    for (const file of files) await access(file);
    dailyRunPath = path.join(root, "state", `${reportDate}.json`);
    await updateDailyRun(dailyRunPath, {
      status: "started",
      stage: "downloads_completed",
      resumedAt: new Date().toISOString(),
      error: undefined,
      failedAt: undefined
    });
    await log("resident_run_resumed_after_downloads", { reportDate, files: expectedFiles });
  } else if (resumeAfterMonthlyDateAvailability) {
    const monthlyFile = path.join(existingRun.runDir || "", monthlyName);
    if (!existingRun.runDir) throw new Error("Date-availability resume safety stop: previous run directory is missing");
    await access(monthlyFile);
    dailyRunPath = path.join(root, "state", `${reportDate}.json`);
    downloadWorkspace = { runDir: existingRun.runDir };
    await updateDailyRun(dailyRunPath, {
      status: "started",
      stage: "downloads_started",
      resumedAfterDateAvailabilityAt: new Date().toISOString(),
      error: undefined,
      failedAt: undefined
    });
    const dailyFile = await downloadReport(adminTab, "Daily", dailyName);
    files = [monthlyFile, dailyFile];
    await updateDailyRun(dailyRunPath, { stage: "downloads_completed", files: expectedFiles });
    await log("resident_run_resumed_after_monthly", { reportDate, files: expectedFiles });
  } else {
    dailyRunPath = await beginDailyRun(root, reportDate);
    downloadWorkspace = await prepareDownloadWorkspace({ root, reportDate, downloadDir, canonicalNames: expectedFiles });
    if (downloadWorkspace.quarantined.length) {
      await log("resident_preexisting_downloads_quarantined", {
        quarantineDir: downloadWorkspace.quarantineDir,
        filenames: downloadWorkspace.quarantined.map(({ originalName }) => originalName)
      });
    }
    await updateDailyRun(dailyRunPath, {
      stage: "downloads_started",
      runId: downloadWorkspace.runId,
      runDir: downloadWorkspace.runDir,
      quarantineDir: downloadWorkspace.quarantineDir,
      quarantinedFiles: downloadWorkspace.quarantined.map(({ originalName }) => originalName)
    });
    const monthlyFile = await downloadReport(adminTab, "Monthly", monthlyName);
    const dailyFile = await downloadReport(adminTab, "Daily", dailyName);
    files = [monthlyFile, dailyFile];
    await updateDailyRun(dailyRunPath, { stage: "downloads_completed", files: expectedFiles });
  }

  const driveTab = await ensureDriveFolderTab(workspaceWindowId);
  if (resumeAfterUploads || resumeAfterImportConfirmed || resumeAfterMainMenuBlocked || resumeAfterMainMenuDiagnosticStop || resumeAfterMainImportConfirmed || resumeAfterMainChatworkConfirmed) {
    for (const filename of expectedFiles) {
      const state = await pageHasMarkers(driveTab, [filename]);
      if (!state.all) throw new Error(`Post-upload resume safety stop: Drive file is missing (${filename})`);
    }
    await log("resident_run_resumed_after_uploads", {
      reportDate,
      files: expectedFiles,
      importAlreadyCompleted: resumeAfterImportConfirmed || resumeAfterMainMenuBlocked || resumeAfterMainMenuDiagnosticStop || resumeAfterMainImportConfirmed || resumeAfterMainChatworkConfirmed
    });
  } else {
    await updateDailyRun(dailyRunPath, { stage: "drive_upload_started" });
    if (resumeAfterKnownMonthlyDriveDuplicate) await archiveExistingMonthlyDriveFile(driveTab);
    const uploadedDriveFiles = [];
    for (const file of files) {
      const filename = path.basename(file);
      if (resumeAfterPartialDriveUpload) {
        const rowCount = await runtime.driveVisibleRowExactNameCount(driveTab.windowId, filename);
        if (rowCount > 1) {
          throw new Error(`Partial Drive resume safety stop: duplicate exact rows=${rowCount} (${filename})`);
        }
        if (rowCount === 1) {
          uploadedDriveFiles.push(filename);
          await updateDailyRun(dailyRunPath, { driveUploadedFiles: [...uploadedDriveFiles] });
          await log("resident_drive_upload_reconciled_from_exact_row", { filename, rowCount });
          continue;
        }
      }
      await uploadFileToDrive(driveTab, file);
      uploadedDriveFiles.push(filename);
      await updateDailyRun(dailyRunPath, { driveUploadedFiles: [...uploadedDriveFiles] });
    }
    await updateDailyRun(dailyRunPath, { stage: "drive_upload_completed" });
  }

  const importSheet = config.sheets.find(({ key }) => key === "import");
  const mainSheet = config.sheets.find(({ key }) => key === "main");
  const departmentSheet = config.sheets.find(({ key }) => key === "department");
  if (resumeAfterImportConfirmed || resumeAfterMainMenuBlocked || resumeAfterMainMenuDiagnosticStop || resumeAfterMainImportConfirmed || resumeAfterMainChatworkConfirmed) {
    await log("resident_import_gas_not_repeated", { reportDate });
  } else {
    try {
      await runGasAction(sheetTabs.get("import"), importSheet, "データインポート");
      const verification = await verifyImportOutput(sheetTabs.get("import"), importSheet, "after-confirmed-dialog");
      await updateDailyRun(dailyRunPath, {
        importSheetVerifiedAt: new Date().toISOString(),
        importSheetVerification: verification,
        importDialogConfirmationMethod: "confirmed-dialog-and-sheet-date",
        error: undefined,
        failedAt: undefined
      });
      trustedImportVerification = true;
    } catch (error) {
      if (String(error?.message || error) !== "Timed out waiting for the GAS result dialog") throw error;
      const verification = await verifyImportOutput(sheetTabs.get("import"), importSheet, "after-dialog-timeout");
      const current = await readDailyRun(root, reportDate);
      const actionKey = "import:データインポート";
      const confirmedGasActions = [...new Set([...(current?.confirmedGasActions || []), actionKey])];
      const completedGasActions = [...new Set([...(current?.completedGasActions || []), actionKey])];
      await updateDailyRun(dailyRunPath, {
        status: "started",
        stage: "gas_completed:import:データインポート",
        confirmedGasActions,
        completedGasActions,
        gasCompletedAt: new Date().toISOString(),
        importSheetVerifiedAt: new Date().toISOString(),
        importSheetVerification: verification,
        importDialogConfirmationMethod: "sheet-date-verified-after-dialog-timeout",
        error: undefined,
        failedAt: undefined
      });
      trustedImportVerification = true;
      await log("resident_import_dialog_timeout_accepted_by_sheet_verification", { reportDate, verification });
      const importUiCleanup = await reconcileImportUiAfterApiVerification(
        sheetTabs.get("import"),
        importSheet
      );
      await updateDailyRun(dailyRunPath, { importUiCleanup });
    }
  }
  if (trustedImportVerification) {
    await log("resident_import_sheet_verification_reused", {
      reportDate,
      method: "recorded-visible-sheet-date"
    });
  } else {
    await verifyImportOutput(sheetTabs.get("import"), importSheet, "before-main-workflow");
  }
  if (resumeAfterMainImportConfirmed || resumeAfterMainChatworkConfirmed) {
    await log("resident_main_import_gas_not_repeated", { reportDate });
  } else {
    const beforeMainImport = await readMainImportOutput(mainSheet, "before-main-import-action");
    if (beforeMainImport.verified) {
      await recordGasActionCompletedByEvidence({
        sheetKey: "main",
        action: "①データインポート",
        evidence: {
          type: "main-a1-execution-date",
          method: "already-current-before-action",
          verification: beforeMainImport
        }
      });
      await updateDailyRun(dailyRunPath, {
        mainImportSheetVerifiedAt: new Date().toISOString(),
        mainImportSheetVerification: beforeMainImport,
        mainImportDialogConfirmationMethod: "a1-already-current-action-skipped"
      });
      await log("resident_main_import_gas_skipped_current_a1", { reportDate, executionDate });
    } else {
      const previousA1Date = beforeMainImport.mismatchSamples?.[0]?.date || null;
      if (beforeMainImport.expectedCellCount !== 1 ||
          beforeMainImport.nonEmptyCount !== 1 ||
          beforeMainImport.formulaErrorCount !== 0 ||
          previousA1Date !== reportDate) {
        throw new Error(
          `Main import A1 safety stop: expected pre-action date ${reportDate}, ` +
          `found ${beforeMainImport.firstValue || "blank"}`
        );
      }

      let mainImportActionError = null;
      try {
        await runGasAction(sheetTabs.get("main"), mainSheet, "①データインポート");
      } catch (error) {
        const current = await readDailyRun(root, reportDate);
        const actionWasSelected = [
          "gas_started:main:①データインポート",
          "gas_result_confirmed:main:①データインポート",
          "gas_completed:main:①データインポート"
        ].includes(current?.stage);
        if (!actionWasSelected) throw error;
        mainImportActionError = error;
        await log("resident_main_import_dialog_result_deferred_to_a1", {
          reportDate,
          message: error instanceof Error ? error.message : String(error)
        });
      }

      const afterMainImport = await readMainImportOutput(mainSheet, "after-main-import-action");
      if (!afterMainImport.verified) {
        if (mainImportActionError) throw mainImportActionError;
        throw new Error(
          `Main import A1 safety stop: expected ${executionDate}, ` +
          `found ${afterMainImport.firstValue || "blank"}`
        );
      }
      await recordGasActionCompletedByEvidence({
        sheetKey: "main",
        action: "①データインポート",
        evidence: {
          type: "main-a1-execution-date",
          method: mainImportActionError ? "verified-after-dialog-problem" : "verified-after-confirmed-dialog",
          verification: afterMainImport
        }
      });
      await updateDailyRun(dailyRunPath, {
        mainImportSheetVerifiedAt: new Date().toISOString(),
        mainImportSheetVerification: afterMainImport,
        mainImportDialogConfirmationMethod: mainImportActionError
          ? "a1-verified-after-dialog-problem"
          : "confirmed-dialog-and-a1-date"
      });
    }
  }
  if (resumeAfterMainChatworkConfirmed) {
    await log("resident_main_chatwork_gas_not_repeated", { reportDate });
  } else {
    await runGasAction(sheetTabs.get("main"), mainSheet, "②Chatworkに報告", {
      acceptedWarningLabels: gasAcceptedWarningLabels["main:②Chatworkに報告"]
    });
  }

  // Main ③ is a required daily action. Never infer that it can be skipped
  // from a Drive DOM count: a background or virtualized Drive tab can render
  // zero rows even while the exact files still exist.
  try {
    await runGasAction(sheetTabs.get("main"), mainSheet, "③使用済みファイル削除", {
      acceptedWarningLabels: gasAcceptedWarningLabels["main:③使用済みファイル削除"]
    });
  } catch (error) {
    const current = await readDailyRun(root, reportDate);
    if (![
      "gas_started:main:③使用済みファイル削除",
      "gas_result_confirmed:main:③使用済みファイル削除",
      "gas_warning_acknowledged:main:③使用済みファイル削除",
      "gas_completed:main:③使用済みファイル削除"
    ].includes(current?.stage)) throw error;
    const warning = error instanceof Error ? error.message : String(error);
    if (!current?.completedGasActions?.includes("main:③使用済みファイル削除")) {
      await recordGasActionCompletedByEvidence({
        sheetKey: "main",
        action: "③使用済みファイル削除",
        evidence: { type: "single-attempt-menu-selection", dialog: "unconfirmed" },
        warning: `Main cleanup action was selected once, but its dialog was not observable: ${warning}`
      });
    }
    await log("resident_main_cleanup_single_attempt_unconfirmed", { warning });
  }

  const activeDepartmentTab = await activateSheetTab(sheetTabs.get("department"), departmentSheet);
  await waitForSheetStable(activeDepartmentTab, departmentSheet.key);
  try {
    await runGasAction(activeDepartmentTab, departmentSheet, "Chatworkに報告");
  } catch (error) {
    const current = await readDailyRun(root, reportDate);
    const timedOutAfterSelection = current?.stage === "gas_started:department:Chatworkに報告" &&
      String(error instanceof Error ? error.message : error) === "Timed out waiting for the GAS result dialog";
    if (!timedOutAfterSelection) throw error;
    await recordGasActionCompletedByEvidence({
      sheetKey: "department",
      action: "Chatworkに報告",
      evidence: { type: "single-attempt-menu-selection", dialog: "timed-out" },
      warning: "Department Chatwork action was selected once, but its completion dialog was not observable"
    });
  }

  // This final API audit is deliberately non-blocking. Business processing and
  // both Chatwork actions have already run; an unavailable API or a remaining
  // file records a warning but cannot turn the successful run into a failure or
  // cause any GAS action to be repeated.
  const driveCleanupAudit = await auditDriveCleanupNonBlocking();

  for (const file of files) {
    await runtime.run("gio", ["trash", file]);
    try {
      await access(file);
      throw new Error(`Completion safety stop: local file still exists after trash (${file})`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await log("resident_local_files_trashed", { filenames: expectedFiles });
  await completeDailyRun(dailyRunPath, { remainingLocalFiles: [], driveCleanupAudit });
  await log("resident_run_completed", { reportDate, filenames: expectedFiles });
  console.log("RESIDENT_RUN_OK");
} catch (error) {
  if (dailyRunPath) await failDailyRun(dailyRunPath, error).catch(() => {});
  await log("resident_run_failed", { message: error instanceof Error ? error.message : String(error) });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await runtime.closeOpenFileChoosers().catch(() => {});
  await runtime.restoreUserState().catch(() => {});
}
