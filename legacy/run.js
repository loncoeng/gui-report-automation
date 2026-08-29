import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";
import { access, mkdir, readdir } from "node:fs/promises";
import { loadConfig, reportingDate, tokyoDateParts } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { beginDailyRun, completeDailyRun, failDailyRun, updateDailyRun } from "../src/run-state.js";

const args = new Set(process.argv.slice(2));
const preflightOnly = args.has("--preflight");
const dryRun = args.has("--dry-run") || preflightOnly;
const liveRequested = args.has("--live");
const config = await loadConfig();
const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const downloadDir = path.join(root, "downloads");
const log = await createLogger(path.join(root, "logs"));
// Chrome 136+ rejects remote debugging against its default user-data directory.
// Keep automation in a dedicated, persistent directory instead.
const userDataDir = process.env.CHROME_USER_DATA_DIR || path.join(root, "chrome-data");
const actionSettleMs = config.waits?.actionSettleMs ?? 2_000;
const navigationSettleMs = config.waits?.navigationSettleMs ?? 4_000;
const pollIntervalMs = config.waits?.pollIntervalMs ?? 3_000;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const today = tokyoDateParts();
const dayOfMonth = Number(today.day);
const reportDate = reportingDate();
const [reportYear, reportMonth, reportDay] = reportDate.split("-");
const todayText = `${today.year}/${today.month}/${today.day}`;
const reportText = `${Number(reportMonth)}/${Number(reportDay)}分のデイリーレポートです`;
let dailyRunPath = null;

await log("run_started", { dryRun, liveRequested, dayOfMonth, reportDate });

if (config.skipDaysOfMonth.includes(dayOfMonth)) {
  await log("run_skipped", { reason: "monthly_sheet_update_day", dayOfMonth });
  process.exit(0);
}

await access(userDataDir);
await mkdir(downloadDir, { recursive: true });

const launchProfile = (profileDirectory, options = {}) => chromium.launchPersistentContext(userDataDir, {
  channel: config.browser.channel,
  headless: config.browser.headless,
  timeout: options.timeout ?? 30_000,
  // Keep Chrome's normal Linux keyring integration so the existing login cookies
  // remain readable. Playwright otherwise injects flags intended for test profiles.
  ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
  args: [`--profile-directory=${profileDirectory}`, "--disable-dev-shm-usage", "--no-sandbox"],
  locale: "ja-JP",
  timezoneId: config.timezone,
  acceptDownloads: options.acceptDownloads ?? false,
  downloadsPath: downloadDir
});

const pageBody = async (page) => page.locator("body").innerText({ timeout: 20_000 });

const authenticatedAdminPage = async (context) => {
  for (const candidate of context.pages()) {
    if (!candidate.url().startsWith(config.admin.url)) continue;
    const bodyText = await pageBody(candidate).catch(() => "");
    if (bodyText.includes(config.admin.authenticatedMarker)) return candidate;
  }
  return null;
};

const waitForAuthenticatedAdmin = async (context, timeout) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const authenticated = await authenticatedAdminPage(context);
    if (authenticated) return authenticated;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
};

const waitForFedCmDialog = async (session, timeout = 15_000) => {
  if (!session) return null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    session.once("FedCm.dialogShown", (dialog) => {
      clearTimeout(timer);
      resolve(dialog);
    });
  });
};

const recoverAdminGoogleSignIn = async (context, page) => {
  if (config.safety.allowGoogleSignInRecovery !== true) {
    throw new Error("対象管理画面 session is not authenticated and Google sign-in recovery is disabled");
  }

  const approvedEmail = config.admin.googleAccountEmail;
  if (!approvedEmail) throw new Error("Google sign-in recovery requires an exact approved email address");
  await log("google_signin_recovery_started", { accountEmail: approvedEmail });
  const signInCandidates = config.admin.googleSignInLabels.map((label) => page.getByText(label, { exact: true }));
  const visibleButtons = [];
  for (const candidateLocator of signInCandidates) {
    const count = await candidateLocator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidateLocator.nth(index);
      if (await candidate.isVisible().catch(() => false)) visibleButtons.push(candidate);
    }
  }
  if (visibleButtons.length !== 1) {
    throw new Error(`Manual authentication required: expected one Sign in with Google control, found ${visibleButtons.length}`);
  }

  let fedCmSession = null;
  try {
    fedCmSession = await context.newCDPSession(page);
    await fedCmSession.send("FedCm.enable", { disableRejectionDelay: true });
  } catch {
    fedCmSession = null;
  }
  const fedCmDialogPromise = waitForFedCmDialog(fedCmSession);
  const popupPromise = context.waitForEvent("page", { timeout: 10_000 }).catch(() => null);
  await visibleButtons[0].click({ timeout: 15_000 });

  const immediate = await waitForAuthenticatedAdmin(context, 5_000);
  if (immediate) {
    await log("google_signin_recovery_ok", { accountSelectionRequired: false });
    return immediate;
  }

  const fedCmDialog = await fedCmDialogPromise;
  if (fedCmDialog) {
    const accounts = Array.isArray(fedCmDialog.accounts) ? fedCmDialog.accounts : [];
    const matchingIndexes = accounts
      .map((account, index) => ({ account, index }))
      .filter(({ account }) => account.email === approvedEmail);
    if (fedCmDialog.dialogType !== "AccountChooser" || accounts.length !== 1 || matchingIndexes.length !== 1) {
      throw new Error(`Manual authentication required: FedCM must show exactly one approved account (shown=${accounts.length}, approved=${matchingIndexes.length})`);
    }
    await log("google_signin_account_selected", { accountEmail: approvedEmail, method: "fedcm" });
    await fedCmSession.send("FedCm.selectAccount", {
      dialogId: fedCmDialog.dialogId,
      accountIndex: matchingIndexes[0].index
    });
    const authenticated = await waitForAuthenticatedAdmin(context, config.admin.googleSignInTimeoutMs ?? 90_000);
    if (!authenticated) {
      throw new Error("Manual authentication required: FedCM account was selected but 対象管理画面 login did not complete");
    }
    await log("google_signin_recovery_ok", { accountSelectionRequired: true, method: "fedcm" });
    return authenticated;
  }

  const popup = await popupPromise;

  const authPage = popup || page;
  await authPage.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  if (!authPage.url().startsWith("https://accounts.google.com/")) {
    throw new Error(`Manual authentication required: unexpected Google sign-in page (${new URL(authPage.url()).origin})`);
  }

  const accountCandidates = authPage.locator("[data-identifier]");
  const matchingAccounts = [];
  const accountCount = await accountCandidates.count();
  for (let index = 0; index < accountCount; index += 1) {
    const candidate = accountCandidates.nth(index);
    const identifier = await candidate.getAttribute("data-identifier");
    if (identifier === approvedEmail && await candidate.isVisible().catch(() => false)) matchingAccounts.push(candidate);
  }

  // Google does not consistently expose data-identifier on every account
  // chooser variant. Fall back to the visible email text, while still
  // requiring exactly one exact match so another signed-in account can never
  // be selected by accident.
  if (matchingAccounts.length === 0) {
    const emailCandidates = authPage.getByText(approvedEmail, { exact: true });
    const emailCandidateCount = await emailCandidates.count();
    for (let index = 0; index < emailCandidateCount; index += 1) {
      const candidate = emailCandidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) matchingAccounts.push(candidate);
    }
  }
  await log("google_signin_accounts_observed", {
    dataIdentifierCount: accountCount,
    approvedMatchCount: matchingAccounts.length
  });
  if (matchingAccounts.length !== 1) {
    const pageText = await pageBody(authPage).catch(() => "");
    const manualReason = /2-Step Verification|2段階認証|Enter your password|パスワード|Verify it'?s you|本人確認|captcha/i
      .test(pageText) ? "two-step verification, password, CAPTCHA, or identity check is visible" : "exactly one approved account was not available";
    throw new Error(`Manual authentication required: ${manualReason}`);
  }

  await log("google_signin_account_selected", { accountEmail: approvedEmail, method: "web", shownAccountCount: accountCount });
  await matchingAccounts[0].click({ timeout: 15_000 });
  const authenticated = await waitForAuthenticatedAdmin(context, config.admin.googleSignInTimeoutMs ?? 90_000);
  if (!authenticated) {
    throw new Error("Manual authentication required: Google account was selected but 対象管理画面 login did not complete");
  }
  await log("google_signin_recovery_ok", { accountSelectionRequired: true, method: "web" });
  return authenticated;
};

const inspectProfile = async ({ profileDirectory, label, checks }) => {
  await log("profile_check_started", { label, profileDirectory });
  const context = await launchProfile(profileDirectory);
  try {
    const page = context.pages()[0] || await context.newPage();
    for (const check of checks) {
      await page.goto(check.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await pause(navigationSettleMs);
      let bodyText = await pageBody(page);
      let missing = check.markers.filter((marker) => !bodyText.includes(marker));
      if (missing.length && check.allowGoogleSignInRecovery) {
        const authenticatedPage = await recoverAdminGoogleSignIn(context, page);
        bodyText = await pageBody(authenticatedPage);
        missing = check.markers.filter((marker) => !bodyText.includes(marker));
      }
      if (missing.length) throw new Error(`${label}:${check.key} missing markers: ${missing.join(", ")}`);
      await log("page_check_ok", { label, key: check.key, title: await page.title() });
    }
  } finally {
    await context.close();
  }
};

const clickText = async (page, labels, options = {}) => {
  for (const label of labels) {
    const target = page.getByText(label, { exact: options.exact ?? true }).last();
    if (await target.isVisible().catch(() => false)) {
      await target.click({ timeout: 15_000 });
      await pause(actionSettleMs);
      return label;
    }
  }
  throw new Error(`Visible control not found: ${labels.join(" / ")}`);
};

const selectDatePart = async (page, nearbyLabel, value) => {
  const labels = page.getByText(nearbyLabel, { exact: true });
  const count = await labels.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = labels.nth(i).locator("xpath=following::select[1]");
    if (await candidate.count()) {
      await candidate.selectOption({ label: String(Number(value)) }).catch(async () => {
        await candidate.selectOption(String(Number(value)));
      });
      await pause(actionSettleMs);
      return;
    }
  }
  throw new Error(`Date selector not found: ${nearbyLabel}`);
};

const downloadReport = async (page, mode, expectedName) => {
  await clickText(page, [mode]);
  await selectDatePart(page, "Year", reportYear);
  await selectDatePart(page, "Month", reportMonth);
  if (mode === "Daily") await selectDatePart(page, "Day", reportDay);
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await clickText(page, ["Download"]);
  const download = await downloadPromise;
  if (download.suggestedFilename() !== expectedName) {
    throw new Error(`Unexpected download filename: ${download.suggestedFilename()} (expected ${expectedName})`);
  }
  const target = path.join(downloadDir, expectedName);
  await download.saveAs(target);
  await log("download_ok", { mode, filename: expectedName });
  return target;
};

const downloadReports = async () => {
  const context = await launchProfile(config.browser.sourceProfileDirectory, { acceptDownloads: true });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(config.admin.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const bodyText = await pageBody(page);
    if (!bodyText.includes(config.admin.authenticatedMarker)) throw new Error("対象管理画面 session is not authenticated");
    const jp = page.getByLabel("JP").or(page.locator('input[type="checkbox"]').filter({ has: page.getByText("JP") }));
    if (await jp.count() && !(await jp.first().isChecked().catch(() => true))) await jp.first().check();
    const monthlyName = `ContractSummary_JP_${reportYear}-${reportMonth}.csv`;
    const dailyName = `ContractSummary_JP_${reportDate}.csv`;
    return [
      await downloadReport(page, "Monthly", monthlyName),
      await downloadReport(page, "Daily", dailyName)
    ];
  } finally {
    await context.close();
  }
};

const uploadToDrive = async (files) => {
  const context = await launchProfile(config.browser.workspaceProfileDirectory);
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto("https://drive.google.com/drive/my-drive", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const folder = page.getByText(config.drive.folderName, { exact: true }).first();
    await folder.waitFor({ state: "visible", timeout: 30_000 });
    await folder.dblclick();
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await pause(navigationSettleMs);
    await clickText(page, ["新規", "New"]);
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 15_000 });
    await clickText(page, ["ファイルをアップロード", "File upload"]);
    const chooser = await chooserPromise;
    await chooser.setFiles(files);
    for (const file of files) {
      await page.getByText(path.basename(file), { exact: true }).last().waitFor({ state: "visible", timeout: 120_000 });
    }
    await log("drive_upload_ok", { filenames: files.map(path.basename) });
  } finally {
    await context.close();
  }
};

const waitForGasResult = async (page, action) => {
  const dialog = page.getByRole("dialog").last();
  await dialog.waitFor({ state: "visible", timeout: 180_000 });
  const result = await dialog.innerText();
  if (/error|エラー|失敗|exception/i.test(result)) throw new Error(`${action} failed: ${result}`);
  const ok = dialog.getByRole("button", { name: /OK|閉じる|Close/i }).last();
  if (await ok.isVisible().catch(() => false)) await ok.click();
  await pause(actionSettleMs);
  await log("gas_action_ok", { action, result: result.slice(0, 300) });
};

const runMenuAction = async (page, menu, action) => {
  if (dailyRunPath) await updateDailyRun(dailyRunPath, { stage: `gas_started:${action}` });
  await clickText(page, [menu]);
  await clickText(page, [action]);
  await waitForGasResult(page, action);
  if (dailyRunPath) await updateDailyRun(dailyRunPath, { stage: `gas_completed:${action}` });
};

const waitForReportReady = async (page, sheetKey, { reloadWhenStale = false } = {}) => {
  const timeout = config.waits?.sheetReadyTimeoutMs ?? 240_000;
  const stableWindow = config.waits?.sheetStableWindowMs ?? 10_000;
  const reloadAfter = config.waits?.staleReloadAfterMs ?? 15_000;
  const startedAt = Date.now();
  let stableSince = null;
  let reloaded = false;

  while (Date.now() - startedAt < timeout) {
    const bodyText = await pageBody(page);
    const hasExpectedDate = bodyText.includes(todayText) || bodyText.includes(`${Number(today.month)}/${Number(today.day)}`);
    const hasExpectedReport = bodyText.includes(reportText);
    const hasFormulaError = /#N\/A|#REF!|#VALUE!|#ERROR!/.test(bodyText);

    if (hasExpectedDate && hasExpectedReport && !hasFormulaError) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableWindow) {
        await log("sheet_ready", { sheetKey, todayText, reportText, stableWindow });
        return;
      }
    } else {
      stableSince = null;
    }

    if (reloadWhenStale && !reloaded && Date.now() - startedAt >= reloadAfter && (!hasExpectedDate || !hasExpectedReport)) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      reloaded = true;
      await log("sheet_reload_for_refresh", { sheetKey });
    }
    await page.waitForTimeout(pollIntervalMs);
  }

  throw new Error(`Sheet did not become ready: ${sheetKey} (expected ${todayText} and ${reportText}, without formula errors)`);
};

const openSheet = async (page, sheet) => {
  const gidQuery = sheet.expectedGid ? `?gid=${sheet.expectedGid}#gid=${sheet.expectedGid}` : "";
  await page.goto(`https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit${gidQuery}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await pause(navigationSettleMs);
  for (const required of sheet.requiredSheets) {
    await page.getByText(required, { exact: true }).last().waitFor({ state: "visible", timeout: 30_000 });
  }
  if (sheet.activeSheet) await clickText(page, [sheet.activeSheet]);
  if (sheet.expectedGid && !page.url().includes(`gid=${sheet.expectedGid}`)) {
    throw new Error(`Unexpected active sheet for ${sheet.key}: ${page.url()}`);
  }
};

const runSheetsWorkflow = async () => {
  const context = await launchProfile(config.browser.workspaceProfileDirectory);
  try {
    const page = context.pages()[0] || await context.newPage();
    const importSheet = config.sheets.find(({ key }) => key === "import");
    const mainSheet = config.sheets.find(({ key }) => key === "main");
    const departmentSheet = config.sheets.find(({ key }) => key === "department");

    await openSheet(page, importSheet);
    await runMenuAction(page, importSheet.menu, "データインポート");

    await openSheet(page, mainSheet);
    for (const action of mainSheet.actions) {
      await clickText(page, [mainSheet.activeSheet]);
      await runMenuAction(page, mainSheet.menu, action);
      if (action === "①データインポート") await waitForReportReady(page, mainSheet.key);
    }

    await openSheet(page, departmentSheet);
    await clickText(page, [departmentSheet.activeSheet]);
    await waitForReportReady(page, departmentSheet.key, { reloadWhenStale: true });
    await runMenuAction(page, departmentSheet.menu, "Chatworkに報告");
  } finally {
    await context.close();
  }
};

const assertLiveSafety = () => {
  if (!liveRequested) throw new Error("Live mode requires --live");
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

try {
  if (liveRequested && !dryRun) assertLiveSafety();
  await inspectProfile({
    profileDirectory: config.browser.sourceProfileDirectory,
    label: "project",
    checks: [{
      key: "source-admin",
      url: config.admin.url,
      markers: [config.admin.authenticatedMarker],
      allowGoogleSignInRecovery: liveRequested && !dryRun
    }]
  });
  await inspectProfile({
    profileDirectory: config.browser.workspaceProfileDirectory,
    label: "workspace",
    checks: config.sheets.map((sheet) => ({
      key: sheet.key,
      url: `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit`,
      markers: sheet.requiredSheets
    }))
  });
  await log("preflight_ok", { reportDate });

  if (preflightOnly || dryRun) {
    await log("execution_blocked", { reason: "dry_run_or_preflight" });
    process.exit(0);
  }

  dailyRunPath = await beginDailyRun(root, reportDate);
  await updateDailyRun(dailyRunPath, { stage: "downloads_started" });
  const files = await downloadReports();
  await updateDailyRun(dailyRunPath, { stage: "downloads_completed", files: files.map(path.basename) });
  await updateDailyRun(dailyRunPath, { stage: "drive_upload_started" });
  await uploadToDrive(files);
  await updateDailyRun(dailyRunPath, { stage: "drive_upload_completed" });
  await runSheetsWorkflow();
  const remaining = (await readdir(downloadDir)).filter((name) => files.map(path.basename).includes(name));
  await completeDailyRun(dailyRunPath, { remainingLocalFiles: remaining });
  await log("run_completed", { reportDate, remainingLocalFiles: remaining });
} catch (error) {
  if (dailyRunPath) await failDailyRun(dailyRunPath, error).catch(() => {});
  await log("run_failed", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
