import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ExistingChromeRuntime } from "../src/gui-runtime.js";

test("resident page commands do not use eval, which Google Sheets blocks", async () => {
  const source = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  assert.equal(source.includes("eval("), false);
});

test("resident page command results do not echo the original title into the result payload", async () => {
  const source = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  assert.match(source, /__vmraOriginalTitle/);
  assert.equal(source.includes("JSON.stringify({ok:1,v,o})"), false);
  assert.equal(source.includes("JSON.stringify({ok:0,e:String(e&&e.message||e),o})"), false);
});

test("address-bar page commands verify focus and the complete atomic paste", async () => {
  const source = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  assert.match(source, /focusVerifiedAddressBar/);
  assert.match(source, /submitAddressBarText/);
  assert.match(source, /"ctrl\+v"/);
  assert.match(source, /pasted !== text/);
  assert.match(source, /resident_address_bar_text_verified/);
  assert.match(source, /Address-bar typing safety stop/);
  assert.equal(source.includes('["type", "--delay", "10"'), false);
});

test("address-bar focus stops before any text input when the copied selection is not a URL", async () => {
  const events = [];
  const commands = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  runtime.activateWindow = async () => {};
  runtime.copyFocusedSelection = async () => "t";
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  await assert.rejects(
    runtime.focusVerifiedAddressBar("sheet-window", { attempts: 1 }),
    /Address-bar focus safety stop/
  );
  assert.equal(commands.some(([, args]) => args.includes("ctrl+v") || args[0] === "type"), false);
  assert.deepEqual(events.at(-1), {
    event: "resident_address_bar_focus_failed",
    details: { windowId: "sheet-window", attempts: 1 }
  });
});

test("address-bar focus retries a transient non-URL selection before stopping", async () => {
  const events = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  const selections = ["t", "https://docs.google.com/spreadsheets/d/example/edit"];
  runtime.activateWindow = async () => {};
  runtime.copyFocusedSelection = async () => selections.shift();
  runtime.run = async () => ({ stdout: "", stderr: "" });

  const selected = await runtime.focusVerifiedAddressBar("sheet-window", { attempts: 2 });

  assert.equal(selected, "https://docs.google.com/spreadsheets/d/example/edit");
  assert.equal(events.some(({ event }) => event === "resident_address_bar_focus_retry"), true);
  assert.equal(events.at(-1).event, "resident_address_bar_focus_verified");
  assert.equal(events.at(-1).details.attempt, 2);
});

test("address-bar submission verifies the pasted text before Return", async () => {
  const commands = [];
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  const intended = "javascript:void 0";
  const copiedSelections = ["javascript:", intended];
  runtime.focusVerifiedAddressBar = async () => "https://docs.google.com/spreadsheets/d/example/edit";
  runtime.writeClipboard = () => {};
  runtime.copyFocusedSelection = async () => copiedSelections.shift();
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  await runtime.submitAddressBarText("sheet-window", intended);

  assert.equal(commands.some(([, args]) => args.includes("ctrl+v")), true);
  assert.equal(commands.some(([, args]) => args[0] === "type" && args.at(-1) === "javascript:"), true);
  assert.equal(commands.some(([, args]) => args[0] === "type" && args.at(-1) === intended), false);
  assert.equal(commands.at(-1)[1].at(-1), "Return");
});

test("failed address-bar JavaScript typing restores the original existing-tab URL", async () => {
  const events = [];
  const commands = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  const originalUrl = "https://docs.google.com/spreadsheets/d/example/edit";
  const copiedSelections = ["javascript:", "incomplete", originalUrl];
  runtime.focusVerifiedAddressBar = async () => originalUrl;
  runtime.writeClipboard = () => {};
  runtime.copyFocusedSelection = async () => copiedSelections.shift();
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  await assert.rejects(
    runtime.submitAddressBarText("sheet-window", "javascript:void 0", { inputAttempts: 1 }),
    /Address-bar typing safety stop/
  );

  assert.equal(events.some(({ event }) => event === "resident_address_bar_original_url_restored"), true);
  assert.equal(commands.filter(([, args]) => args.at(-1) === "Return").length, 1);
});

test("address-bar input retries only before Return and submits exactly once", async () => {
  const events = [];
  const commands = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  const intended = "javascript:void 0";
  const copiedSelections = ["incomplete", "javascript:", intended];
  runtime.focusVerifiedAddressBar = async () => "https://docs.google.com/spreadsheets/d/example/edit";
  runtime.writeClipboard = () => {};
  runtime.copyFocusedSelection = async () => copiedSelections.shift();
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  await runtime.submitAddressBarText("sheet-window", intended, { inputAttempts: 2 });

  assert.equal(events.some(({ event }) => event === "resident_address_bar_input_retry"), true);
  assert.equal(events.filter(({ event }) => event === "resident_address_bar_text_verified").length, 1);
  assert.equal(commands.filter(([, args]) => args.at(-1) === "Return").length, 1);
});

test("resident tab refresh uses the existing Chrome tab", async () => {
  const events = [];
  const commands = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  runtime.activateWindow = async (windowId) => commands.push(["activate", windowId]);
  const pageStates = [
    { url: "https://admin.example.com/reports/daily", readyState: "complete", timeOrigin: 1000 },
    { url: "https://admin.example.com/reports/daily", readyState: "complete", timeOrigin: 2000 }
  ];
  runtime.typeAddressJavascript = async () => pageStates.shift();
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  const result = await runtime.reloadTab("admin-window", { pollIntervalMs: 1 });

  assert.deepEqual(commands, [
    ["activate", "admin-window"],
    ["xdotool", ["key", "--clearmodifiers", "ctrl+r"]]
  ]);
  assert.deepEqual(events, [
    {
      event: "resident_tab_reload_requested",
      details: {
        windowId: "admin-window",
        url: "https://admin.example.com/reports/daily",
        method: "ctrl+r",
        beforeTimeOrigin: 1000
      }
    },
    {
      event: "resident_tab_reload_verified",
      details: {
        windowId: "admin-window",
        url: "https://admin.example.com/reports/daily",
        method: "ctrl+r",
        beforeTimeOrigin: 1000,
        afterTimeOrigin: 2000
      }
    }
  ]);
  assert.equal(result.afterTimeOrigin, 2000);
});

test("forced resident refresh verifies the active admin URL and bypasses cache", async () => {
  const events = [];
  const commands = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  runtime.activateWindow = async (windowId) => commands.push(["activate", windowId]);
  const pageStates = [
    { url: "https://admin.example.com/reports/daily", readyState: "complete", timeOrigin: 1000 },
    { url: "https://admin.example.com/reports/daily", readyState: "complete", timeOrigin: 2000 }
  ];
  runtime.typeAddressJavascript = async () => pageStates.shift();
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  const result = await runtime.reloadTab("admin-window", {
    pollIntervalMs: 1,
    forceReload: true,
    expectedUrlPrefix: "https://admin.example.com/reports/daily"
  });

  assert.deepEqual(commands, [
    ["activate", "admin-window"],
    ["xdotool", ["key", "--clearmodifiers", "ctrl+shift+r"]]
  ]);
  assert.equal(events[0].event, "resident_tab_reload_requested");
  assert.equal(events[0].details.method, "ctrl+shift+r");
  assert.equal(events[0].details.url, "https://admin.example.com/reports/daily");
  assert.equal(result.afterTimeOrigin, 2000);
});

test("forced resident refresh refuses a different active tab", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  runtime.typeAddressJavascript = async () => ({
    url: "https://docs.google.com/spreadsheets/d/example/edit",
    readyState: "complete",
    timeOrigin: 1000
  });

  await assert.rejects(
    runtime.reloadTab("project-window", {
      forceReload: true,
      expectedUrlPrefix: "https://admin.example.com/reports/daily"
    }),
    /Reload target safety stop/
  );
});

test("resident tab refresh refuses an unchanged document", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  runtime.activateWindow = async () => {};
  runtime.run = async () => ({ stdout: "", stderr: "" });
  runtime.typeAddressJavascript = async () => ({
    url: "https://admin.example.com/reports/daily",
    readyState: "complete",
    timeOrigin: 1000
  });

  await assert.rejects(
    runtime.reloadTab("admin-window", { timeoutMs: 5, pollIntervalMs: 1 }),
    /reload verification timed out/
  );
});

test("date controls support the React Select controls used by 対象管理画面", async () => {
  const source = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  assert.match(source, /-singleValue/);
  assert.match(source, /-control/);
  assert.match(source, /clickWindowCoordinates\(windowId, opened\.coordinates\)/);
  assert.match(source, /numericOptionCoordinatesByScrolling/);
  assert.match(source, /resident_date_option_scroll/);
  assert.match(source, /tessedit_char_whitelist=0123456789/);
  assert.match(source, /-contrast-stretch/);
  assert.match(source, /visible=\[\$\{visible\.join/);
  assert.match(source, /Date selection verification failed/);
  assert.equal(source.includes("expected one visible option"), false);
});

test("React date selection uses a real pointer and verifies the final value", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  const commands = [];
  const pageResults = [
    { done: false, native: false, coordinates: { x: 120, y: 340 } },
    { selected: true, actual: "13" }
  ];
  runtime.typeAddressJavascript = async () => pageResults.shift();
  runtime.numericOptionCoordinatesByScrolling = async () => ({ x: 200, y: 500 });
  runtime.clickWindowCoordinates = async (windowId, coordinates) => commands.push(["click", windowId, coordinates]);
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  const selected = await runtime.setSelectFollowingLabel("admin-window", "Day", "13");

  assert.deepEqual(selected, { label: "Day", value: "13", native: false, optionCoordinates: { x: 200, y: 500 } });
  assert.deepEqual(commands[0], ["click", "admin-window", { x: 120, y: 340 }]);
  assert.deepEqual(commands[1], ["click", "admin-window", { x: 200, y: 500 }]);
});

test("long React date menus scroll slowly until the exact target becomes visible", async () => {
  const events = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  const commands = [];
  let scans = 0;
  runtime.ocrNumericOptionCoordinates = async () => {
    scans += 1;
    if (scans < 3) throw new Error("Date option OCR safety stop: expected one 13 near 283,553; matches=0");
    return { x: 283, y: 690 };
  };
  runtime.activateWindow = async () => {};
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  const coordinates = await runtime.numericOptionCoordinatesByScrolling(
    "admin-window",
    "13",
    { x: 283, y: 553 }
  );

  assert.deepEqual(coordinates, { x: 283, y: 690 });
  assert.equal(scans, 3);
  assert.equal(commands.filter(([command, args]) => command === "xdotool" && args[0] === "click" && args[1] === "5").length, 6);
  assert.deepEqual(events.at(-1), {
    event: "resident_date_option_found",
    details: { target: "13", scan: 3, coordinates: { x: 283, y: 690 } }
  });
});

test("date scrolling stops closed when OCR is ambiguous", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  runtime.ocrNumericOptionCoordinates = async () => {
    throw new Error("Date option OCR safety stop: expected one 13 near 283,553; matches=2");
  };

  await assert.rejects(
    runtime.numericOptionCoordinatesByScrolling("admin-window", "13", { x: 283, y: 553 }),
    /matches=2/
  );
});

test("live runs verify the target date before creating state or downloading CSV files", async () => {
  const source = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const availabilityCheck = source.indexOf("await verifyAdminReportDateAvailable(adminTab);");
  const refresh = source.indexOf("await runtime.reloadTab(adminTab.windowId, {");
  const dailySelection = source.indexOf('await runtime.clickExactText(adminTab.windowId, "Daily");');
  const beginState = source.indexOf("dailyRunPath = await beginDailyRun(root, reportDate);");
  const monthlyDownload = source.indexOf('await downloadReport(adminTab, "Monthly", monthlyName)');

  assert.ok(availabilityCheck > 0);
  assert.ok(refresh > 0);
  assert.ok(dailySelection > refresh);
  assert.ok(beginState > availabilityCheck);
  assert.ok(monthlyDownload > beginState);
  assert.match(source, /resident_run_skipped_existing_state/);
  assert.match(source, /resident_report_date_available/);
  assert.match(source, /resident_admin_refresh_started/);
  assert.match(source, /resident_admin_refresh_ok/);
  assert.match(source, /forceReload: true/);
  assert.match(source, /expectedUrlPrefix: config\.admin\.url/);
  assert.match(source, /resident_report_date_retry_wait/);
  assert.match(source, /dateAvailabilityRetryDelayMs/);
  assert.match(source, /attempt <= 2/);
  assert.match(source, /knownDateAvailabilityFailure/);
  assert.match(source, /resident_run_resumed_after_monthly/);
  assert.match(source, /expected one visible option \$\{Number\(reportDay\)\} after Day, found 0/);
  assert.match(source, /Date-availability resume safety stop: previous run directory is missing/);
});

test("timer retries inspect existing state before initializing or focusing Chrome", async () => {
  const source = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const stateRead = source.indexOf("existingRun = await readDailyRun(root, reportDate);");
  const existingStateSkip = source.indexOf('await log("resident_run_skipped_existing_state"');
  const chromeInitialize = source.indexOf("await runtime.initialize();");
  const tabPreflight = source.indexOf("await verifyResidentTabs();");

  assert.ok(stateRead > 0);
  assert.ok(existingStateSkip > stateRead);
  assert.ok(chromeInitialize > existingStateSkip);
  assert.ok(tabPreflight > chromeInitialize);
  assert.match(source, /chromeInitialized: false/);
});

test("recurring timer retries availability every 30 minutes and still skips each month day 2", async () => {
  const source = await readFile(new URL("../systemd/gui-report-automation.timer", import.meta.url), "utf8");
  assert.match(source, /OnCalendar=\*-\*-01,03\.\.31 06:30:00 Asia\/Tokyo/);
  assert.match(source, /OnCalendar=\*-\*-01,03\.\.31 07\.\.09:00:00 Asia\/Tokyo/);
  assert.match(source, /OnCalendar=\*-\*-01,03\.\.31 07\.\.09:30:00 Asia\/Tokyo/);
  assert.match(source, /Persistent=false/);
});

test("page-command titles have marker-owned recovery and guarded timed restore", async () => {
  const source = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  assert.match(source, /location\.hostname==='drive\.google\.com'\?'Google Drive'/);
  assert.match(source, /k='__vmraOriginalTitle_'\+m/);
  assert.match(source, /if\(document\.title\.startsWith\(m\)\)document\.title=window\[k\]\|\|recovered\|\|fallback/);
  assert.match(source, /querySelector\('#docs-title-input'\)\?\.value/);
  assert.match(source, /t===fallback\?\(recovered\|\|fallback\):t/);
  assert.match(source, /setTimeout\(restore,30000\)/);
  assert.match(source, /resident_title_restore_deferred/);
  assert.equal(source.includes("k='__vmraOriginalTitle',"), false);
  assert.equal(source.includes("window.__vmraOriginalTitle"), false);
  assert.equal(source.includes("t.startsWith('__VMRA_RESULT_')?'Admin':t"), false);
});

test("navigation-causing double clicks are scheduled after the page-command result is returned", async () => {
  const source = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  assert.match(source, /doubleClickExactText\(windowId, label, \{ delayMs = 600 \}/);
  assert.match(source, /setTimeout\(\(\)=>e\.dispatchEvent\(new MouseEvent\('dblclick'/);
  assert.match(source, /closest\('\[role=gridcell\]'\)/);
});

test("Drive folder opening selects one visible result row by its exact first-line name", async () => {
  const source = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  assert.match(source, /doubleClickDriveRowExactName/);
  assert.match(source, /querySelectorAll\('\[role=row\]'\)/);
  assert.match(source, /split\('\\\\n'\)\[0\]/);
});

test("Drive uses the configured folder ID and resume is limited to the known pre-upload failure", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const limitedSource = await readFile(new URL("../tools/limited-upload-import-test.js", import.meta.url), "utf8");
  assert.match(liveSource, /drive\.google\.com\/drive\/folders\/\$\{config\.drive\.folderId\}/);
  assert.match(liveSource, /Drive folder ID verification failed/);
  assert.match(liveSource, /waitForPageMarkers\(driveTab, "drive-folder"/);
  assert.match(liveSource, /runtime\.activateMatchingTab\(workspaceWindowId/);
  assert.match(liveSource, /Expected exactly two resident Chrome windows/);
  assert.match(liveSource, /findRequiredTabInWindows\("drive-folder", workspaceWindowIds/);
  assert.match(liveSource, /findRequiredTabInWindows\(sheet\.key, \[driveTab\.windowId\]/);
  assert.match(liveSource, /Drive and the three workspace sheets are not in one Chrome profile window/);
  assert.match(liveSource, /resident_drive_file_upload_selected_by_menu_order/);
  assert.match(liveSource, /selection: "second_item_after_home"/);
  assert.match(liveSource, /await runtime\.activateWindow\(driveTab\.windowId\)/);
  assert.match(liveSource, /\["key", "--clearmodifiers", "Home"\]/);
  assert.match(liveSource, /\["key", "--clearmodifiers", "Down"\]/);
  assert.match(limitedSource, /\["key", "--clearmodifiers", "Home"\]/);
  assert.match(limitedSource, /\["key", "--clearmodifiers", "Down"\]/);
  assert.match(limitedSource, /await runtime\.chooseFile\(testFilePath\)/);
  assert.match(liveSource, /previous\?\.stage !== "drive_upload_started"/);
  assert.match(liveSource, /knownDriveFolderFailure/);
  assert.match(liveSource, /OCR safety stop: approved text matches=0/);
  assert.match(liveSource, /Drive folder was not uniquely available: /);
  assert.match(liveSource, /Address-bar focus safety stop: the selected text was not a browser URL/);
  assert.match(liveSource, /resident_run_resumed_after_downloads/);
});

test("file chooser selection waits for the chooser window to close on a low-spec VM", async () => {
  const source = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  assert.match(source, /await access\(filePath\)/);
  assert.match(source, /chooseFile\(filePath, timeoutMs = 45_000\)/);
  assert.match(source, /this\.run\("xwininfo", \["-id", chooserId\]\)/);
  assert.match(source, /Map State:\\s\+IsViewable/);
  assert.match(source, /resident_file_chooser_confirm_retried/);
  assert.match(source, /resident_file_chooser_closed_after_selection/);
  assert.match(source, /File chooser did not close after selecting the approved file/);
});

test("an exact chooser failure resumes by reconciling each visible Drive row", async () => {
  const source = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  assert.match(source, /resumeAfterPartialDriveUpload/);
  assert.match(source, /knownPartialDriveUploadFailure/);
  assert.match(source, /File chooser did not close after selecting the approved file/);
  assert.match(source, /resident_run_resumed_after_partial_drive_upload/);
  assert.match(source, /resident_drive_upload_reconciled_from_exact_row/);
  assert.match(source, /Partial Drive resume safety stop: duplicate exact rows=/);
  assert.match(source, /driveUploadedFiles: \[\.\.\.uploadedDriveFiles\]/);
});

test("a single stale monthly Drive file is archived only for the exact guarded resume", async () => {
  const source = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");

  assert.match(source, /knownMonthlyDriveDuplicate/);
  assert.match(source, /downloads_completed/);
  assert.match(source, /Address-bar focus safety stop: the selected text was not a browser URL/);
  assert.match(source, /resumeAfterKnownMonthlyDriveDuplicate/);
  assert.match(source, /resident_run_resumed_after_monthly_drive_duplicate/);
  assert.match(source, /resident_drive_existing_monthly_archived/);
  assert.match(source, /driveVisibleRowExactNameCount\(driveTab\.windowId, monthlyName\)/);
  assert.match(source, /count !== 1/);
  assert.match(source, /\.stale-backup-\$\{backupStamp\}\.csv/);
  assert.match(source, /renameDriveRowExactName\(driveTab\.windowId, monthlyName, backupName\)/);
  assert.doesNotMatch(source, /archiveExistingMonthlyDriveFile\(driveTab, dailyName\)/);
});

test("Drive upload ignores stale body-text toasts and verifies exact visible rows", async () => {
  const source = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  assert.match(source, /const existingRowCount = await runtime\.driveVisibleRowExactNameCount/);
  assert.match(source, /const rowCount = await runtime\.driveVisibleRowExactNameCount/);
  assert.doesNotMatch(source, /const before = await pageHasMarkers\(driveTab, \[filename\]\)/);
});

test("import-only retry is locked to the approved import sheet and cannot run downstream GAS actions", async () => {
  const source = await readFile(new URL("../tools/limited-import-only-retry.js", import.meta.url), "utf8");
  assert.match(source, /ALLOW_IMPORT_GAS_RETRY/);
  assert.match(source, /ALLOW_APPROVED_CSV_UPLOAD/);
  assert.match(source, /APPROVED_MONTHLY_CSV/);
  assert.match(source, /APPROVED_DAILY_CSV/);
  assert.match(source, /OWN_TEST_ARTIFACT_NAME/);
  assert.match(source, /EXAMPLE_IMPORT_SPREADSHEET_ID/);
  assert.match(source, /state\.status !== "manual_completed"/);
  assert.match(source, /ContractSummary_JP_\$\{reportYear\}-\$\{reportMonth\}\.csv/);
  assert.match(source, /ContractSummary_JP_\$\{reportDate\}\.csv/);
  assert.match(source, /csvNames\.length !== 2/);
  assert.match(source, /approved CSV must come from this report date run directory/);
  assert.match(source, /limited_approved_csv_upload_ok/);
  assert.match(source, /TXT upload-test artifact is still present/);
  assert.equal(source.includes('["key", "--clearmodifiers", "Delete"]'), false);
  assert.match(source, /"データインポート"/);
  assert.equal(source.includes("①データインポート"), false);
  assert.equal(source.includes("集計用GAS"), false);
  assert.equal(source.includes("数字報告用"), false);
  assert.equal(source.includes("Chatwork"), false);
  assert.match(source, /runtime\.chooseFile\(filePath\)/);
  assert.match(source, /limited_import_menu_action_clicked/);
  assert.match(source, /clickSingleActionCustomMenu\(tab\.windowId, importSheet\.menu, "データインポート"\)/);
});

test("single-action GAS menus use verified OCR pointer clicks instead of sheet-affecting keys", async () => {
  const source = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  assert.match(source, /openSingleActionCustomMenu/);
  assert.match(source, /clickSingleActionCustomMenu/);
  assert.match(source, /await this\.clickWindowCoordinates\(windowId, menuCoordinates\)/);
  assert.match(source, /resident_gas_menu_action_verified/);
  assert.match(source, /resident_gas_menu_blocked_retry/);
  assert.match(source, /exactOcrTextCoordinates\(windowId, aliases, "jpn\+eng"\)/);
  assert.match(source, /"mousemove", "--window", windowId/);
  assert.match(source, /\[role=menuitem\]/);
  assert.equal(source.includes("r.left+r.width/2+dx"), false);
});

test("multi-action GAS menus click only the OCR-verified approved action", async () => {
  const events = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  const commands = [];
  runtime.openSingleActionCustomMenu = async () => ({ menuCoordinates: { x: 10, y: 20 } });
  runtime.exactOcrTextCoordinates = async () => ({ x: 30, y: 40 });
  runtime.clickWindowCoordinates = async (windowId, coordinates) => commands.push(["click", windowId, coordinates]);
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  const actions = ["①データインポート", "②Chatworkに報告", "③使用済みファイル削除"];
  const selected = await runtime.clickCustomMenuActionByOrder("window", "集計用", actions, "③使用済みファイル削除");

  assert.equal(selected.actionIndex, 2);
  assert.deepEqual(selected.actionCoordinates, { x: 30, y: 40 });
  assert.deepEqual(commands, [["click", "window", { x: 30, y: 40 }]]);
  assert.equal(events.at(-1).event, "resident_gas_menu_action_verified");
  await assert.rejects(
    runtime.clickCustomMenuActionByOrder("window", "集計用", actions, "未承認の処理"),
    /action is not approved/
  );
});

test("GAS state becomes started only after the approved menu action is selected", async () => {
  const source = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const ready = source.indexOf("stage: `gas_ready:${sheet.key}:${action}`");
  const selected = source.indexOf("selected = await runtime.clickCustomMenuActionByOrder");
  const started = source.indexOf("stage: `gas_started:${sheet.key}:${action}`");
  assert.ok(ready > 0);
  assert.ok(selected > ready);
  assert.ok(started > selected);
  assert.match(source, /gasMenuSelectedAt/);
});

test("a visible dark Sheets notification is cleared by reloading only the existing approved tab", async () => {
  const runtimeSource = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  assert.match(runtimeSource, /visibleSheetsBlockingNotification/);
  assert.match(runtimeSource, /\[role=alert\],\[role=status\],\[class\*=snackbar\],\[class\*=toast\]/);
  assert.match(liveSource, /resident_sheets_blocking_notification_detected/);
  assert.match(liveSource, /resident_sheets_blocking_notification_cleared_by_reload/);
  assert.match(liveSource, /reloadTab\(activeTab\.windowId, \{ expectedUrlPrefix \}\)/);
  assert.match(liveSource, /after-menu-recognition-failure/);
  assert.equal(liveSource.includes("openTab("), false);
});

test("GAS actions reuse a sheet tab whose configured gid was already verified", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  assert.match(liveSource, /ensureConfiguredSheetActive/);
  assert.match(liveSource, /gidFromUrl\(activeTab\.url\) === String\(sheet\.expectedGid\)/);
  assert.match(liveSource, /if \(!sheet\.expectedGid \|\| gidFromUrl/);
});

test("resident discovery accepts a workbook on its startup sheet and verifies gid only before GAS", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const preflightSource = await readFile(new URL("../src/gui-preflight.js", import.meta.url), "utf8");
  const dryRunSource = await readFile(new URL("../src/gui-dry-run.js", import.meta.url), "utf8");

  assert.match(liveSource, /activateMatchingTab\(tab\.windowId, \(url\) =>\s*url\.includes\(`\/spreadsheets\/d\/\$\{sheet\.spreadsheetId\}\/`\)\)/);
  assert.match(liveSource, /runtime\.navigateTab\(activeTab\.windowId, targetUrl\)/);
  assert.match(liveSource, /resident_configured_sheet_navigated/);
  assert.match(liveSource, /failureLabel = "Active sheet safety check failed"/);
  assert.doesNotMatch(preflightSource, /sheet\.spreadsheetId[\s\S]{0,160}sheet\.expectedGid/);
  assert.doesNotMatch(dryRunSource, /sheet\.spreadsheetId[\s\S]{0,160}sheet\.expectedGid/);
});

test("sheet stability ignores transient notifications and counts the first clean sample", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  assert.match(liveSource, /\[role=alert\],\[role=status\],\[class\*=snackbar\],\[class\*=toast\]/);
  assert.match(liveSource, /t=t\.split\(x\)\.join\(''\)/);
  assert.match(liveSource, /previousHash = state\.h;[\s\S]*stableSince = Date\.now\(\);/);
});

test("custom GAS menus use a root-popup OCR pointer fallback when the window capture misses the menu", async () => {
  const events = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  const commands = [];
  runtime.openSingleActionCustomMenu = async () => ({ menuCoordinates: { x: 100, y: 50 } });
  runtime.exactOcrTextCoordinates = async () => {
    throw new Error("OCR safety stop: approved text matches=0");
  };
  runtime.exactPopupOcrTextScreenCoordinates = async (_windowId, labels) => {
    assert.ok(labels.includes("データインボート"));
    assert.ok(labels.includes("データインポボート"));
    return { x: 300, y: 200, source: "root-popup-ocr" };
  };
  runtime.clickScreenCoordinates = async (coordinates) => commands.push(["screen-click", coordinates]);

  const actions = ["①データインポート", "②Chatworkに報告", "③使用済みファイル削除"];
  const selected = await runtime.clickCustomMenuActionByOrder("window", "集計用", actions, "①データインポート");

  assert.equal(selected.actionIndex, 0);
  assert.deepEqual(selected.actionCoordinates, { x: 300, y: 200, source: "root-popup-ocr" });
  assert.deepEqual(commands, [["screen-click", { x: 300, y: 200, source: "root-popup-ocr" }]]);
  assert.equal(events.at(-1).details.recognition, "root-popup-ocr");
});

test("post-main-menu resume is locked to the exact pre-action failure and skips completed work", async () => {
  const source = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  assert.match(source, /--resume-after-main-menu-blocked/);
  assert.match(source, /gas_started:main:①データインポート/);
  assert.match(source, /Custom menu safety stop: approved action did not become visible: 集計用:①データインポート/);
  assert.match(source, /prior import completion evidence is missing/);
  assert.match(source, /resident_run_resumed_after_main_menu_blocked/);
  assert.match(source, /resumeAfterImportConfirmed \|\| resumeAfterMainMenuBlocked/);
});

test("post-diagnostic main-menu resume is locked to the exact stopped pre-action state", async () => {
  const source = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const packageSource = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.match(source, /--resume-after-main-menu-diagnostic-stop/);
  assert.match(source, /status !== "started"/);
  assert.match(source, /stage !== "gas_started:main:①データインポート"/);
  assert.match(source, /resumedAfterMainMenuDiagnosticStopAt/);
  assert.match(source, /resident_run_resumed_after_main_menu_diagnostic_stop/);
  assert.match(packageSource, /resident-resume-after-main-menu-diagnostic-stop/);
});

test("main GAS recognition utility opens the menu but never clicks the recognized first action", async () => {
  const source = await readFile(new URL("../src/verify-main-gas-menu.js", import.meta.url), "utf8");
  assert.match(source, /データインボート/);
  assert.match(source, /データインポボート/);
  assert.match(source, /main\.actions\[0\] !== "①データインポート"/);
  assert.match(source, /firstActionOcrAliases/);
  assert.match(source, /matches: 1/);
  assert.match(source, /clicked: false/);
  assert.match(source, /clickWindowCoordinates\(tab\.windowId, menuCoordinates\)/);
  assert.equal(source.includes("clickWindowCoordinates(tab.windowId, recognizedCoordinates)"), false);
  assert.match(source, /if \(menuOpened\)/);
  assert.match(source, /"Escape"/);
});

test("limited 1-to-10 test stops after recognizing the first main GAS action", async () => {
  const source = await readFile(new URL("../tools/limited-through-main-menu-test.js", import.meta.url), "utf8");
  assert.match(source, /ALLOW_LIMITED_THROUGH_MAIN_MENU_TEST/);
  assert.match(source, /waitForMarkers\(activeImportPreflight, "import", \[importSheet\.menu\]\)/);
  assert.equal(source.includes('waitForMarkers(importTab, "import", [...importSheet.requiredSheets'), false);
  assert.match(source, /limited_main_menu_test_marker_check/);
  assert.match(source, /activeImportPreflight/);
  assert.match(source, /import marker check ran on the wrong tab/);
  assert.match(source, /activeMainPreflight/);
  assert.match(source, /main marker check ran on the wrong tab/);
  assert.match(source, /clickSingleActionCustomMenu\(activeImportTab\.windowId, importSheet\.menu, "データインポート"\)/);
  assert.match(source, /limited_main_menu_test_import_gas_completed/);
  assert.match(source, /\["①データインポート", "データインポート"\]/);
  assert.match(source, /limited_main_menu_test_first_action_recognized_only/);
  assert.match(source, /clicked: false/);
  assert.match(source, /stoppedBeforeMainGas: true/);
  assert.equal(source.includes("clickWindowCoordinates(activeMainTab.windowId, recognizedCoordinates)"), false);
  assert.equal(source.includes("②Chatworkに報告"), false);
  assert.equal(source.includes("③使用済みファイル削除"), false);
  assert.equal(source.includes('runtime.run("gio"'), false);
});

test("duplicate continuation archives exact Drive rows and still stops before main GAS", async () => {
  const source = await readFile(new URL("../tools/limited-resume-after-duplicate.js", import.meta.url), "utf8");
  const runtimeSource = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  assert.match(source, /ALLOW_LIMITED_DUPLICATE_ARCHIVE/);
  assert.match(source, /LIMITED_REPORT_DATE/);
  assert.match(source, /LIMITED_DOWNLOAD_RUN_DIR/);
  assert.match(source, /pretest-backup-\$\{backupStamp\}/);
  assert.match(source, /renameDriveRowExactName/);
  assert.match(source, /driveVisibleRowExactNameCount/);
  assert.match(source, /clickSingleActionCustomMenu\(activeImportTab\.windowId, "集計用", "データインポート"\)/);
  assert.match(source, /\["①データインポート", "データインポート"\]/);
  assert.match(source, /clicked: false/);
  assert.match(source, /stoppedBeforeMainGas: true/);
  assert.equal(source.includes("clickWindowCoordinates(activeMainTab.windowId, recognizedCoordinates)"), false);
  assert.equal(source.includes("②Chatworkに報告"), false);
  assert.equal(source.includes("③使用済みファイル削除"), false);
  assert.equal(source.includes('["key", "--clearmodifiers", "Delete"]'), false);
  assert.match(runtimeSource, /Drive rename safety stop: rename dialog was not verified/);
  assert.match(runtimeSource, /originalCount !== 0 \|\| backupCount !== 1/);
  assert.match(runtimeSource, /split\('\\\\n'\)\.map\(x=>x\.trim\(\)\)\.includes\(q\)/);
  assert.match(runtimeSource, /scrollIntoView\(\{block:'center',inline:'nearest'\}\)/);
});

test("confirmed-upload continuation cannot upload again and stops before main GAS", async () => {
  const source = await readFile(new URL("../tools/limited-after-confirmed-uploads.js", import.meta.url), "utf8");
  assert.match(source, /ALLOW_LIMITED_AFTER_CONFIRMED_UPLOADS/);
  assert.match(source, /resident_run_resumed_after_uploads/);
  assert.match(source, /exact same-day upload proof was not found/);
  assert.match(source, /import GAS was already started for this report date/);
  assert.match(source, /clickSingleActionCustomMenu\(activeImportTab\.windowId, "集計用", "データインポート"\)/);
  assert.match(source, /limited_confirmed_upload_import_gas_completed/);
  assert.match(source, /\["①データインポート", "データインポート"\]/);
  assert.match(source, /clicked: false/);
  assert.match(source, /stoppedBeforeMainGas: true/);
  assert.equal(source.includes("chooseFile("), false);
  assert.equal(source.includes("renameDriveRowExactName"), false);
  assert.equal(source.includes("②Chatworkに報告"), false);
  assert.equal(source.includes("③使用済みファイル削除"), false);
  assert.equal(source.includes("clickWindowCoordinates(activeMainTab.windowId, recognizedCoordinates)"), false);
});

test("main and department GAS mappings are fixed and use verified existing-tab navigation", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  assert.match(liveSource, /activeSheet: "日次集計"/);
  assert.match(liveSource, /expectedGid: "100000001"/);
  assert.match(liveSource, /actions: \["①データインポート", "②Chatworkに報告", "③使用済みファイル削除"\]/);
  assert.match(liveSource, /activeSheet: "実績サマリ"/);
  assert.match(liveSource, /expectedGid: "100000002"/);
  assert.match(liveSource, /activeSheet: "部門別サマリ"/);
  assert.match(liveSource, /expectedGid: "100000003"/);
  assert.match(liveSource, /runtime\.navigateTab\(activeTab\.windowId, targetUrl\)/);
  assert.match(liveSource, /clickCustomMenuActionByOrder/);
  assert.match(liveSource, /resident_gas_menu_action_selected/);
  assert.match(liveSource, /activateSheetTab/);
  assert.match(liveSource, /resident_gas_tab_activated/);
  assert.match(liveSource, /activateMatchingTab\(tab\.windowId/);
  assert.match(liveSource, /const activeDepartmentTab = await activateSheetTab/);
});

test("resident run resumes only the exact pre-import sheet activation failure after Drive completed", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  assert.match(liveSource, /existingRun\?\.stage === "drive_upload_completed"/);
  assert.match(liveSource, /existingRun\?\.error === "Active sheet safety check failed for import"/);
  assert.match(liveSource, /resumeAfterUploads = resumeAfterUploads \|\| knownPreImportSheetActivationFailure/);
});

test("post-upload retry is limited to the known pre-GAS failure and verifies both Drive files", async () => {
  const source = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const packageSource = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.match(source, /--resume-after-uploads/);
  assert.match(source, /gas_started:import:データインポート/);
  assert.match(source, /Resident Chrome page command did not return a result/);
  assert.match(source, /Custom menu safety stop: approved action did not become visible: 集計用:データインポート/);
  assert.match(source, /resident_run_resumed_after_uploads/);
  assert.match(source, /Post-upload resume safety stop: Drive file is missing/);
  assert.match(packageSource, /resident-resume-after-uploads/);
});

test("GAS completion monitoring falls back to a non-typing modal focus probe", async () => {
  const runtimeSource = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const retrySource = await readFile(new URL("../tools/limited-import-only-retry.js", import.meta.url), "utf8");
  assert.match(runtimeSource, /exactOcrTextCoordinates\(windowId, \["OK"\], "eng"\)/);
  assert.match(runtimeSource, /ocrWindowText/);
  assert.match(runtimeSource, /probeAddressBarAvailableWithoutEscape/);
  assert.match(runtimeSource, /modalBlockedScans >= 2/);
  assert.match(runtimeSource, /default-button-keyboard/);
  assert.match(runtimeSource, /confirmDialog/);
  assert.match(runtimeSource, /waitForDialogDismissed/);
  assert.match(liveSource, /confirmDialog\(activeTab\.windowId, dialog\)/);
  assert.match(liveSource, /resident_post_gas_settle_completed/);
  assert.match(liveSource, /postGasOkSettleMs/);
  assert.match(liveSource, /successLabels/);
  assert.match(liveSource, /after-dialog-dismissal/);
  assert.match(liveSource, /ensureWindowMaximized/);
  assert.match(retrySource, /confirmDialog\(tab\.windowId, dialog\)/);
});

test("modal focus probe never types and only escapes a verified address bar", async () => {
  const events = [];
  const commands = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  runtime.activateWindow = async () => {};
  runtime.copyFocusedSelection = async () => "https://docs.google.com/spreadsheets/d/example/edit";
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  assert.equal(await runtime.probeAddressBarAvailableWithoutEscape("sheet-window"), true);
  assert.deepEqual(commands, [
    ["xdotool", ["key", "--clearmodifiers", "ctrl+l"]],
    ["xdotool", ["key", "--clearmodifiers", "Escape"]]
  ]);
  assert.equal(commands.some(([, args]) => args[0] === "type" || args.includes("ctrl+v")), false);
  assert.deepEqual(events.at(-1), {
    event: "resident_dialog_focus_probe",
    details: { windowId: "sheet-window", addressBarAvailable: true }
  });
});

test("two blocked focus probes detect a compositor GAS modal", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  runtime.ocrGasDialogRegion = async () => "";
  runtime.exactOcrTextCoordinates = async () => {
    throw new Error("OCR safety stop: approved text matches=0");
  };
  runtime.probeAddressBarAvailableWithoutEscape = async () => false;

  const dialog = await runtime.waitForDialog("sheet-window", 100, 0);

  assert.equal(dialog.visible, true);
  assert.equal(dialog.error, false);
  assert.equal(dialog.okCoordinates, null);
  assert.equal(dialog.confirmation, "default-button-keyboard");
});

test("non-strict dialog dismissal can use two clear focus probes for an unrelated OK", async () => {
  const events = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  runtime.exactOcrTextCoordinates = async () => ({ x: 100, y: 100 });
  runtime.probeAddressBarAvailableWithoutEscape = async () => true;

  assert.equal(await runtime.waitForDialogDismissed("sheet-window", 5_000), true);
  assert.deepEqual(events.at(-1), {
    event: "resident_dialog_dismissed_by_focus_probe",
    details: { windowId: "sheet-window", ocrClear: false }
  });
});

test("strict dialog dismissal requires the known success text to disappear", async () => {
  const events = [];
  const commands = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  const regionTexts = ["投稿完了しました OK", "通常のシート", "通常のシート"];
  runtime.ocrGasDialogRegion = async () => regionTexts.shift();
  runtime.activateWindow = async () => {};
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    return { stdout: "", stderr: "" };
  };

  assert.equal(
    await runtime.waitForDialogDismissed("sheet-window", 5_000, {
      confirmationMethod: "keyboard",
      successLabels: ["投稿完了しました"]
    }),
    true
  );
  assert.equal(commands.filter(([, args]) => args.includes("Return")).length, 1);
  assert.deepEqual(events.at(-1), {
    event: "resident_dialog_dismissed_by_result_text_clear",
    details: { windowId: "sheet-window", confirmationMethod: "keyboard" }
  });
});

test("strict dialog dismissal never accepts address-bar focus while the result remains visible", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  runtime.ocrGasDialogRegion = async () => "投稿完了しました OK";
  runtime.activateWindow = async () => {};
  runtime.run = async () => ({ stdout: "", stderr: "" });
  runtime.probeAddressBarAvailableWithoutEscape = async () => true;

  await assert.rejects(
    runtime.waitForDialogDismissed("sheet-window", 20, {
      confirmationMethod: "keyboard",
      successLabels: ["投稿完了しました"]
    }),
    /GAS dialog did not disappear/
  );
});

test("GAS windows are maximized and verified before OCR menu selection", async () => {
  const events = [];
  const commands = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  runtime.run = async (command, args) => {
    commands.push([command, args]);
    if (args[0] === "getwindowgeometry") {
      return { stdout: "WIDTH=1024\nHEIGHT=744\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  assert.deepEqual(await runtime.ensureWindowMaximized("sheet-window"), { width: 1024, height: 744 });
  assert.deepEqual(commands[0], [
    "wmctrl",
    ["-ir", "sheet-window", "-b", "add,maximized_vert,maximized_horz"]
  ]);
  assert.equal(events.at(-1).event, "resident_window_maximized");
});

test("an explicit Japanese completion dialog overrides unrelated OCR error text", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  runtime.ocrGasDialogRegion = async () => "";
  runtime.exactOcrTextCoordinates = async () => ({ x: 100, y: 100 });
  runtime.ocrWindowText = async () => "unrelated error text on sheet インポート完了しました OK";

  const dialog = await runtime.waitForDialog("sheet-window", 100, 0);

  assert.equal(dialog.error, false);
  assert.deepEqual(dialog.okCoordinates, { x: 100, y: 100 });
});

test("strict GAS dialog monitoring accepts only the configured completion text", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  runtime.ocrGasDialogRegion = async () => "インポート完了しました OK";
  runtime.probeAddressBarAvailableWithoutEscape = async () => false;

  const dialog = await runtime.waitForDialog("sheet-window", 100, 0, {
    successLabels: ["インポート完了しました"]
  });

  assert.equal(dialog.error, false);
  assert.equal(dialog.matchedSuccessLabel, "インポート完了しました");
  assert.equal(dialog.confirmation, "default-button-keyboard");
});

test("an accepted maximum warning snackbar is not treated as a modal OK dialog", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  runtime.ocrGasDialogRegion = async () => "最大値を超えました";
  runtime.probeAddressBarAvailableWithoutEscape = async () => true;

  const dialog = await runtime.waitForDialog("sheet-window", 100, 0, {
    successLabels: ["投稿完了しました"],
    warningLabels: ["最大値を超えました"]
  });

  assert.equal(dialog.warning, true);
  assert.equal(dialog.notification, true);
  assert.equal(dialog.confirmation, null);
});

test("an accepted maximum warning modal keeps the approved keyboard OK path", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  runtime.ocrGasDialogRegion = async () => "最大実行時間を超えました OK";
  runtime.probeAddressBarAvailableWithoutEscape = async () => false;

  const dialog = await runtime.waitForDialog("sheet-window", 100, 0, {
    successLabels: ["投稿完了しました"],
    warningLabels: ["最大実行時間を超えました"]
  });

  assert.equal(dialog.warning, true);
  assert.equal(dialog.notification, false);
  assert.equal(dialog.confirmation, "default-button-keyboard");
});

test("pointer-confirmed dialog dismissal accepts two consecutive OCR-clear scans", async () => {
  const events = [];
  const runtime = new ExistingChromeRuntime({
    root: "/tmp",
    log: async (event, details) => events.push({ event, details })
  });
  runtime.exactOcrTextCoordinates = async () => {
    throw new Error("OCR safety stop: approved text matches=0");
  };
  runtime.probeAddressBarAvailableWithoutEscape = async () => false;

  assert.equal(
    await runtime.waitForDialogDismissed("sheet-window", 5_000, { confirmationMethod: "pointer" }),
    true
  );
  assert.deepEqual(events.at(-1), {
    event: "resident_dialog_dismissed_by_ocr",
    details: { windowId: "sheet-window", confirmationMethod: "pointer" }
  });
});

test("main import dialog resume and continuation cannot rerun main action one", async () => {
  const dialogSource = await readFile(new URL("../src/resume-main-import-dialog.js", import.meta.url), "utf8");
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const packageSource = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.match(dialogSource, /gas_started:main:①データインポート/);
  assert.match(dialogSource, /インポート完了しました/);
  assert.match(dialogSource, /GAS dialog did not disappear after clicking OK/);
  assert.match(dialogSource, /Timed out waiting for the GAS result dialog/);
  assert.match(dialogSource, /resultDialogTimedOut/);
  assert.match(dialogSource, /verified-dismissed-after-pointer-confirmation/);
  assert.match(dialogSource, /gas_completed:main:①データインポート/);
  assert.match(dialogSource, /resumedAfterMainImportDialogAt/);
  assert.match(dialogSource, /resident_main_import_dialog_admin_window_skipped/);
  assert.match(liveSource, /--resume-after-main-import-confirmed/);
  assert.match(liveSource, /knownPostMainImportStableCheckFailure/);
  assert.match(liveSource, /readGasCompletionEvidence/);
  assert.match(liveSource, /resident_gas_dialog_dismissed/);
  assert.match(liveSource, /resident_post_gas_settle_completed/);
  assert.match(liveSource, /existingGasEvidence\.importConfirmed/);
  assert.match(liveSource, /existingGasEvidence\.mainImportConfirmed/);
  assert.match(liveSource, /confirmed-before-stability-check/);
  assert.match(liveSource, /resident_main_import_gas_not_repeated/);
  assert.match(packageSource, /resume-main-import-dialog/);
  assert.match(packageSource, /resident-resume-after-main-import-confirmed/);
});

test("main import uses the keyless A1 execution date and recovers without a second GAS click", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const liveConfig = await readFile(new URL("../config/automation.live.json", import.meta.url), "utf8");
  assert.match(liveSource, /readSheetDateRange/);
  assert.match(liveSource, /const executionDate/);
  assert.match(liveSource, /resident_main_import_a1_checked/);
  assert.match(liveSource, /before-main-import-action/);
  assert.match(liveSource, /after-main-import-action/);
  assert.match(liveSource, /timer-recovery-before-chrome/);
  assert.match(liveSource, /resident_main_import_gas_skipped_current_a1/);
  assert.match(liveSource, /resident_main_import_recovered_by_a1_before_chrome/);
  assert.match(liveConfig, /"sheetName": "実績サマリ"/);
  assert.match(liveConfig, /"column": "A"/);
  assert.match(liveConfig, /"startRow": 1/);
  assert.match(liveConfig, /"endRow": 1/);
});

test("known GAS warnings and observable Drive cleanup continue without blind retries", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const mainCleanupIndex = liveSource.indexOf(
    'await runGasAction(sheetTabs.get("main"), mainSheet, "③使用済みファイル削除"'
  );
  const departmentIndex = liveSource.indexOf("const activeDepartmentTab = await activateSheetTab");
  const cleanupAuditIndex = liveSource.indexOf("const driveCleanupAudit = await auditDriveCleanupNonBlocking()");
  assert.match(liveSource, /gasAcceptedWarningLabels/);
  assert.match(liveSource, /最大値を超えました/);
  assert.match(liveSource, /resident_gas_warning_notification_requires_reload/);
  assert.match(liveSource, /resident_file_chooser_linger_reconciled_by_drive_row/);
  assert.match(liveSource, /readDriveExactFileCounts/);
  assert.match(liveSource, /resident_drive_cleanup_verified_by_api/);
  assert.match(liveSource, /drive-cleanup-audit-unavailable/);
  assert.match(liveSource, /drive-cleanup-files-remaining/);
  assert.match(liveSource, /const driveCleanupAudit = await auditDriveCleanupNonBlocking\(\)/);
  assert.match(liveSource, /completeDailyRun\(dailyRunPath, \{ remainingLocalFiles: \[\], driveCleanupAudit \}\)/);
  assert.doesNotMatch(liveSource, /resident_main_cleanup_gas_skipped_drive_already_clean/);
  assert.doesNotMatch(liveSource, /drive-exact-rows-absent-before-action/);
  assert.match(liveSource, /single-attempt-menu-selection/);
  assert.match(liveSource, /unconfirmedGasActions/);
  assert.ok(mainCleanupIndex >= 0);
  assert.ok(departmentIndex > mainCleanupIndex);
  assert.ok(cleanupAuditIndex > departmentIndex);
});

test("API-proven import completion clears only a remaining modal and notification without blocking", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  assert.match(liveSource, /reconcileImportUiAfterApiVerification/);
  assert.match(liveSource, /resident_import_api_verified_modal_confirmation_sent/);
  assert.match(liveSource, /api-verified-default-button-once/);
  assert.match(liveSource, /resident_import_post_api_notification_detected/);
  assert.match(liveSource, /recordNonBlockingWarning\("import-ui-cleanup"/);
  assert.match(liveSource, /const addressBarAvailable = await runtime\.probeAddressBarAvailableWithoutEscape/);
  assert.match(liveSource, /if \(!addressBarAvailable\)/);
});

test("systemd service serializes cross-manager execution with flock", async () => {
  const source = await readFile(new URL("../systemd/gui-report-automation.service", import.meta.url), "utf8");
  assert.match(source, /\/usr\/bin\/flock --nonblock --conflict-exit-code 75/);
  assert.match(source, /gui-report-automation\/run\.lock/);
  assert.match(source, /SuccessExitStatus=75/);
});

test("post-import resume skips the completed import GAS", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const resumeSource = await readFile(new URL("../src/resume-import-dialog.js", import.meta.url), "utf8");
  const packageSource = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.match(liveSource, /--resume-after-import-confirmed/);
  assert.match(liveSource, /resident_import_gas_not_repeated/);
  assert.match(liveSource, /knownRepeatedVerificationFailure/);
  assert.match(liveSource, /resident_import_sheet_verification_reused/);
  assert.match(liveSource, /recorded-visible-sheet-date/);
  assert.match(liveSource, /resumedAfterImportDialogAt/);
  assert.match(resumeSource, /preserveActiveDialog: true/);
  assert.match(resumeSource, /Timed out waiting for the GAS result dialog/);
  assert.match(resumeSource, /GAS dialog did not disappear after clicking OK/);
  assert.match(resumeSource, /Address-bar typing safety stop: the omnibox did not contain the complete intended text/);
  assert.match(resumeSource, /verified-dismissed-after-pointer-confirmation/);
  assert.match(resumeSource, /spreadsheets\/d\/\$\{importSheet\.spreadsheetId\}/);
  assert.match(resumeSource, /activateMatchingTab/);
  assert.match(packageSource, /resident-resume-after-import-confirmed/);
});

test("post-main-Chatwork resume requires user delivery evidence and skips completed GAS actions", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const packageSource = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.match(liveSource, /--resume-after-main-chatwork-confirmed/);
  assert.match(liveSource, /mainChatworkUserConfirmedAt/);
  assert.match(liveSource, /user-confirmed-message-received/);
  assert.match(liveSource, /resident_main_import_gas_not_repeated/);
  assert.match(liveSource, /resident_main_chatwork_gas_not_repeated/);
  assert.match(packageSource, /resident-resume-after-main-chatwork-confirmed/);
});

test("scheduled resident workflow requires existing Chrome tabs and never creates a Drive tab", async () => {
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  const preflightSource = await readFile(new URL("../src/gui-preflight.js", import.meta.url), "utf8");
  const driveHelper = liveSource.slice(
    liveSource.indexOf("const ensureDriveFolderTab"),
    liveSource.indexOf("const waitForDriveFilename")
  );
  assert.doesNotMatch(liveSource, /runtime\.openTab\(/);
  assert.doesNotMatch(driveHelper, /runtime\.(?:openTab|navigateTab)\(/);
  assert.match(liveSource, /resident mode will not create or navigate a tab/);
  assert.doesNotMatch(preflightSource, /startChromeIfNeeded/);
  assert.match(preflightSource, /preflight will not start Chrome or create profiles/);
});

test("import dialog resume locates the approved spreadsheet by ID before using a title fallback", async () => {
  const source = await readFile(new URL("../src/resume-import-dialog.js", import.meta.url), "utf8");
  const idLookup = source.indexOf("activateMatchingTab(windowId");
  const titleFallback = source.indexOf("Google Sheets");
  assert.ok(idLookup >= 0);
  assert.ok(titleFallback > idLookup);
  assert.match(source, /sheetWindows\.length === 0/);
});

test("authentication checks are URL based and cannot match ordinary sheet text", async () => {
  const source = await readFile(new URL("../src/gui-runtime.js", import.meta.url), "utf8");
  const liveSource = await readFile(new URL("../src/gui-live.js", import.meta.url), "utf8");
  assert.equal(source.includes("location.href+' '+t"), false);
  assert.equal(liveSource.includes("location.href+' '+t"), false);
  assert.match(source, /accounts\\\\\.google/);
  assert.match(liveSource, /accounts\\\\\.google/);
});

test("tab scan is bounded even when a one-tab project window repeats", async () => {
  const events = [];
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async (event, details) => events.push({ event, details }) });
  let reads = 0;
  let switches = 0;
  runtime.currentUrl = async () => {
    reads += 1;
    return "https://admin.example.com/reports/daily";
  };
  runtime.run = async (command, args) => {
    if (command === "xdotool" && args.at(-1) === "ctrl+Tab") switches += 1;
    return { stdout: "", stderr: "" };
  };

  const found = await runtime.activateMatchingTab(
    "project-window",
    (url) => url.includes("docs.google.com"),
    3
  );

  assert.equal(found, null);
  assert.equal(reads, 3);
  assert.equal(switches, 2);
  assert.deepEqual(events, [
    { event: "resident_window_scan_complete", details: { windowId: "project-window", tabsChecked: 3 } }
  ]);
});

test("duplicate URLs do not stop a tab scan before a later Drive tab", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  const urls = [
    "https://admin.example.com/reports/daily",
    "https://docs.google.com/spreadsheets/d/import/edit",
    "https://admin.example.com/reports/daily",
    "https://drive.google.com/drive/folders/example"
  ];
  let reads = 0;
  let switches = 0;
  runtime.currentUrl = async () => urls[reads++];
  runtime.run = async (command, args) => {
    if (command === "xdotool" && args.at(-1) === "ctrl+Tab") switches += 1;
    return { stdout: "", stderr: "" };
  };

  const found = await runtime.activateMatchingTab(
    "workspace-window",
    (url) => url.includes("/drive/folders/example"),
    4
  );

  assert.deepEqual(found, {
    windowId: "workspace-window",
    url: "https://drive.google.com/drive/folders/example"
  });
  assert.equal(reads, 4);
  assert.equal(switches, 3);
});

test("tab scan still finds a target in the next tab", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  const urls = [
    "https://admin.example.com/reports/daily",
    "https://docs.google.com/spreadsheets/d/example/edit"
  ];
  let reads = 0;
  runtime.currentUrl = async () => urls[reads++];
  runtime.run = async () => ({ stdout: "", stderr: "" });

  const found = await runtime.activateMatchingTab("workspace-window", (url) => url.includes("/spreadsheets/d/example/"));

  assert.deepEqual(found, {
    windowId: "workspace-window",
    url: "https://docs.google.com/spreadsheets/d/example/edit"
  });
});

test("page-location tab scan skips Chrome New Tab pages without using the clipboard", async () => {
  const runtime = new ExistingChromeRuntime({ root: "/tmp", log: async () => {} });
  let pageReads = 0;
  let switches = 0;
  runtime.pageSummary = async () => {
    pageReads += 1;
    if (pageReads === 1) throw new Error("Chrome internal page");
    return { url: "https://drive.google.com/drive/folders/example" };
  };
  runtime.run = async (command, args) => {
    if (command === "xdotool" && args.at(-1) === "ctrl+Tab") switches += 1;
    return { stdout: "New Tab - Google Chrome", stderr: "" };
  };

  const found = await runtime.activateMatchingTabByPageLocation(
    "workspace-window",
    (url) => url.includes("/drive/folders/")
  );

  assert.deepEqual(found, {
    windowId: "workspace-window",
    url: "https://drive.google.com/drive/folders/example"
  });
  assert.equal(switches, 1);
});
