import assert from "node:assert/strict";
import test from "node:test";
import {
  importVerificationConfig,
  readSheetDateRange,
  verifyImportSheetReportDate
} from "../src/import-sheet-verification.js";

const sheet = { spreadsheetId: "sheet-id" };
const auth = {
  mode: "gce-service-account-impersonation",
  targetServiceAccount: "reader@example-project.iam.gserviceaccount.com",
  tokenLifetimeSeconds: 600,
  requestTimeoutMs: 1_000
};

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

const successfulFetch = (values, requests = []) => async (url, options = {}) => {
  requests.push({ url: String(url), options });
  if (String(url).startsWith("http://metadata.google.internal/")) {
    return jsonResponse({ access_token: "metadata-token", expires_in: 3599 });
  }
  if (String(url).startsWith("https://iamcredentials.googleapis.com/")) {
    return jsonResponse({ accessToken: "impersonated-token", expireTime: "2026-08-25T00:10:00Z" });
  }
  return jsonResponse({ range: "日次集計!C2:C5", values });
};

test("import verification defaults to daily sorted Point column C from row 2", () => {
  assert.deepEqual(importVerificationConfig(sheet), {
    sheetName: "日次集計",
    column: "C",
    startRow: 2,
    endRow: 5
  });
});

test("keyless Sheets API verification accepts exactly four matching report-date cells", async () => {
  const requests = [];
  const result = await verifyImportSheetReportDate({
    sheet,
    reportDate: "2026-08-19",
    auth,
    fetchImpl: successfulFetch([["2026/8/19"], ["2026年8月19日"], ["2026-08-19"], ["2026/08/19"]], requests)
  });

  assert.equal(result.verified, true);
  assert.equal(result.nonEmptyCount, 4);
  assert.equal(result.source, "sheets-api-keyless-impersonation");
  assert.equal(requests.length, 3);
  assert.equal(requests[0].options.headers["Metadata-Flavor"], "Google");
  assert.equal(requests[1].options.headers.Authorization, "Bearer metadata-token");
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    scope: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    lifetime: "600s"
  });
  assert.equal(requests[2].options.headers.Authorization, "Bearer impersonated-token");
  assert.match(requests[2].url, /%E6%97%A5%E6%AC%A1%E9%9B%86%E8%A8%88!C2%3AC5/);
});

test("generic keyless date reader supports the main sheet A1 execution date", async () => {
  const mainSheet = {
    spreadsheetId: "main-sheet-id",
    successVerification: {
      sheetName: "実績サマリ",
      column: "A",
      startRow: 1,
      endRow: 1
    }
  };
  const requests = [];
  const result = await readSheetDateRange({
    sheet: mainSheet,
    expectedDate: "2026-08-27",
    auth,
    fetchImpl: successfulFetch([["2026/08/27"]], requests)
  });

  assert.equal(result.verified, true);
  assert.equal(result.sheetName, "実績サマリ");
  assert.equal(result.range, "A1:A1");
  assert.equal(result.firstValue, "2026/08/27");
  assert.match(requests[2].url, /%E5%AE%9F%E7%B8%BE%E3%82%B5%E3%83%9E%E3%83%AA!A1%3AA1/);
});

test("generic date reader returns mismatch evidence without approving the action", async () => {
  const mainSheet = {
    spreadsheetId: "main-sheet-id",
    successVerification: { sheetName: "実績サマリ", column: "A", startRow: 1, endRow: 1 }
  };
  const result = await readSheetDateRange({
    sheet: mainSheet,
    expectedDate: "2026-08-27",
    auth,
    fetchImpl: successfulFetch([["2026/08/26"]])
  });

  assert.equal(result.verified, false);
  assert.equal(result.mismatchCount, 1);
  assert.deepEqual(result.mismatchSamples, [{ value: "2026/08/26", date: "2026-08-26" }]);
});

test("verification stops on empty, mismatched, missing, or formula-error output", async () => {
  for (const values of [
    [],
    [["2026/08/19"], ["2026/08/19"], ["2026/08/18"], ["2026/08/19"]],
    [["2026/08/19"], ["2026/08/19"], ["2026/08/19"]],
    [["2026/08/19"], ["#REF!"], ["2026/08/19"], ["2026/08/19"]]
  ]) {
    await assert.rejects(
      verifyImportSheetReportDate({
        sheet,
        reportDate: "2026-08-19",
        auth,
        fetchImpl: successfulFetch(values)
      }),
      /Import sheet verification safety stop/
    );
  }
});

test("verification fails closed when metadata, impersonation, or Sheets API fails", async () => {
  for (const failingUrl of ["metadata", "iamcredentials", "sheets"]) {
    const fetchImpl = async (url) => {
      const value = String(url);
      if ((failingUrl === "metadata" && value.includes("metadata.google.internal")) ||
          (failingUrl === "iamcredentials" && value.includes("iamcredentials.googleapis.com")) ||
          (failingUrl === "sheets" && value.includes("sheets.googleapis.com"))) {
        return jsonResponse({ error: "denied" }, 403);
      }
      if (value.includes("metadata.google.internal")) return jsonResponse({ access_token: "metadata-token" });
      if (value.includes("iamcredentials.googleapis.com")) return jsonResponse({ accessToken: "impersonated-token" });
      return jsonResponse({ values: [["2026/08/19"], ["2026/08/19"], ["2026/08/19"], ["2026/08/19"]] });
    };
    await assert.rejects(
      verifyImportSheetReportDate({ sheet, reportDate: "2026-08-19", auth, fetchImpl }),
      /Import sheet verification safety stop/
    );
  }
});

test("verification rejects missing or non-keyless auth configuration", async () => {
  await assert.rejects(
    verifyImportSheetReportDate({
      sheet,
      reportDate: "2026-08-19",
      auth: {},
      fetchImpl: successfulFetch([])
    }),
    /invalid keyless authentication configuration/
  );
});
