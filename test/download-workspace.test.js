import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import {
  captureDownloadSnapshot,
  downloadFamilyPattern,
  moveDownloadIntoRun,
  prepareDownloadWorkspace,
  waitForFreshStableDownload
} from "../src/download-workspace.js";

const withTemporaryDirectories = async (callback) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "report-download-workspace-"));
  const downloadDir = path.join(temporaryRoot, "Downloads");
  const root = path.join(temporaryRoot, "automation");
  await mkdir(downloadDir);
  try {
    await callback({ temporaryRoot, downloadDir, root });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

test("download family accepts Chrome numbered names with or without a space", () => {
  const pattern = downloadFamilyPattern("ContractSummary_JP_2026-08.csv");
  assert.equal(pattern.test("ContractSummary_JP_2026-08.csv"), true);
  assert.equal(pattern.test("ContractSummary_JP_2026-08(1).csv"), true);
  assert.equal(pattern.test("ContractSummary_JP_2026-08 (2).csv"), true);
  assert.equal(pattern.test("ContractSummary_JP_2026-08-12.csv"), false);
  assert.equal(pattern.test("ContractSummary_JP_2026-07.csv"), false);
});

test("pre-existing matching and partial downloads are quarantined without touching unrelated files", async () => {
  await withTemporaryDirectories(async ({ downloadDir, root }) => {
    const monthly = "ContractSummary_JP_2026-08.csv";
    const daily = "ContractSummary_JP_2026-08-12.csv";
    await writeFile(path.join(downloadDir, monthly), "old-monthly");
    await writeFile(path.join(downloadDir, "ContractSummary_JP_2026-08(1).csv"), "old-numbered");
    await writeFile(path.join(downloadDir, `${daily}.crdownload`), "partial");
    await writeFile(path.join(downloadDir, "unrelated.csv"), "keep");

    const workspace = await prepareDownloadWorkspace({
      root,
      reportDate: "2026-08-12",
      downloadDir,
      canonicalNames: [monthly, daily],
      now: new Date("2026-08-13T00:00:00.000Z")
    });

    assert.deepEqual((await readdir(downloadDir)).sort(), ["unrelated.csv"]);
    assert.deepEqual((await readdir(workspace.quarantineDir)).sort(), [
      "ContractSummary_JP_2026-08(1).csv",
      "ContractSummary_JP_2026-08-12.csv.crdownload",
      monthly
    ].sort());
    assert.equal(await readFile(path.join(downloadDir, "unrelated.csv"), "utf8"), "keep");
  });
});

test("only the fresh numbered download is moved into the run folder under the canonical name", async () => {
  await withTemporaryDirectories(async ({ downloadDir, root }) => {
    const canonicalName = "ContractSummary_JP_2026-08.csv";
    const workspace = await prepareDownloadWorkspace({
      root,
      reportDate: "2026-08-12",
      downloadDir,
      canonicalNames: [canonicalName],
      now: new Date("2026-08-13T00:00:00.000Z")
    });
    const before = await captureDownloadSnapshot(downloadDir, canonicalName);
    const startedAtMs = Date.now();
    await writeFile(path.join(downloadDir, "ContractSummary_JP_2026-08 (3).csv"), "new-report");

    const candidate = await waitForFreshStableDownload({
      downloadDir,
      canonicalName,
      before,
      startedAtMs,
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      stableChecksRequired: 1,
      sleep: async () => {}
    });
    const destination = await moveDownloadIntoRun({ candidate, runDir: workspace.runDir, canonicalName });

    assert.equal(path.basename(destination), canonicalName);
    assert.equal(await readFile(destination, "utf8"), "new-report");
    await assert.rejects(() => access(candidate.path));
  });
});
