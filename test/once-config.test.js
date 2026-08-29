import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));

test("one-time config keeps workflow targets aligned with the base config", async () => {
  const base = await readJson(new URL("../config/automation.json", import.meta.url));
  const once = await readJson(new URL("../config/automation.once.example.json", import.meta.url));

  assert.deepEqual(once.sheets, base.sheets);
  assert.deepEqual(once.waits, base.waits);
  assert.equal(base.waits.actionSettleMs, 5000);
  assert.equal(base.waits.navigationSettleMs, 10000);
  assert.equal(base.waits.gasDialogTimeoutMs, 360000);
  assert.equal(base.waits.postGasOkSettleMs, 20000);
  assert.equal(base.waits.sheetStableWindowMs, 30000);
  assert.equal(once.safety.onlyReportDate, "2026-08-14");
  assert.equal(Object.entries(once.safety).filter(([key]) => key !== "onlyReportDate").every(([, value]) => value === true), true);
  assert.equal(base.safety.allowGoogleSignInRecovery, false);
  assert.equal(once.safety.allowGoogleSignInRecovery, true);
  assert.equal(once.admin.googleAccountMatch, "source-account");
  assert.equal(once.admin.googleAccountEmail, "source-account@example.com");
  assert.equal(base.admin.googleAccountEmail, "source-account@example.com");
});

test("one-time timer is limited to 2026-08-15 08:30 JST", async () => {
  const timer = await readFile(new URL("../systemd/gui-report-automation-once.timer", import.meta.url), "utf8");
  const service = await readFile(new URL("../systemd/gui-report-automation-once.service", import.meta.url), "utf8");

  assert.match(timer, /^OnCalendar=2026-08-15 08:30:00 Asia\/Tokyo$/m);
  assert.match(timer, /^Persistent=false$/m);
  assert.match(service, /automation\.once\.example\.json/);
  assert.match(service, /npm run resident-live/);
  assert.doesNotMatch(service, /^User=/m);
});

test("recurring service uses an explicit live config with all guarded capabilities enabled", async () => {
  const base = await readJson(new URL("../config/automation.json", import.meta.url));
  const live = await readJson(new URL("../config/automation.live.json", import.meta.url));
  const service = await readFile(new URL("../systemd/gui-report-automation.service", import.meta.url), "utf8");

  assert.deepEqual(live.sheets, base.sheets);
  assert.deepEqual(live.waits, base.waits);
  assert.deepEqual(live.skipDaysOfMonth, [2]);
  assert.equal(live.schedule.enabled, true);
  assert.equal(live.safety.onlyReportDate, null);
  assert.equal(Object.entries(live.safety).filter(([key]) => key !== "onlyReportDate").every(([, value]) => value === true), true);
  assert.match(service, /AUTOMATION_CONFIG=.*automation\.live\.json/);
  assert.match(service, /npm run resident-live/);
  assert.doesNotMatch(service, /^User=/m);
});
