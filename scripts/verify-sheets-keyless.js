import os from "node:os";
import path from "node:path";
import { loadConfig, reportingDate } from "../src/config.js";
import { verifyImportSheetReportDate } from "../src/import-sheet-verification.js";

const reportDate = process.argv[2] || reportingDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
  throw new Error("Usage: node scripts/verify-sheets-keyless.js [YYYY-MM-DD]");
}

const config = await loadConfig();
const importSheet = config.sheets.find(({ key }) => key === "import");
const result = await verifyImportSheetReportDate({
  sheet: importSheet,
  reportDate,
  auth: config.sheetsReadVerification
});

console.log(JSON.stringify({
  verified: result.verified,
  source: result.source,
  reportDate,
  sheetName: result.sheetName,
  range: result.range,
  expectedCellCount: result.expectedCellCount,
  nonEmptyCount: result.nonEmptyCount,
  formulaErrorCount: result.formulaErrorCount,
  mismatchCount: result.mismatchCount,
  host: os.hostname(),
  config: path.basename(process.env.AUTOMATION_CONFIG || "automation.json")
}));
