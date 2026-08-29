import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beginDailyRun, completeDailyRun, failDailyRun, readDailyRun } from "../src/run-state.js";

const withTemporaryRoot = async (callback) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "report-automation-state-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("a report date can be started only once", async () => {
  await withTemporaryRoot(async (root) => {
    await beginDailyRun(root, "2026-08-11", new Date("2026-08-12T00:00:00Z"));
    await assert.rejects(() => beginDailyRun(root, "2026-08-11"), /already attempted/);
  });
});

test("completed and failed attempts remain blocked for the same report date", async () => {
  await withTemporaryRoot(async (root) => {
    const completedPath = await beginDailyRun(root, "2026-08-11");
    await completeDailyRun(completedPath, { remainingLocalFiles: [] });
    assert.equal((await readDailyRun(root, "2026-08-11")).status, "completed");
    await assert.rejects(() => beginDailyRun(root, "2026-08-11"), /status=completed/);

    const failedPath = await beginDailyRun(root, "2026-08-12");
    await failDailyRun(failedPath, new Error("uncertain GAS result"));
    assert.equal((await readDailyRun(root, "2026-08-12")).status, "failed");
    await assert.rejects(() => beginDailyRun(root, "2026-08-12"), /status=failed/);
  });
});
