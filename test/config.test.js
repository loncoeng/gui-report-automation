import assert from "node:assert/strict";
import test from "node:test";
import { reportingDate, tokyoDateParts } from "../src/config.js";

test("Tokyo report date is the previous calendar day", () => {
  const instant = new Date("2026-08-11T22:30:00.000Z");
  assert.deepEqual(tokyoDateParts(instant), { month: "08", day: "12", year: "2026" });
  assert.equal(reportingDate(instant), "2026-08-11");
});

test("report date handles month boundaries", () => {
  const instant = new Date("2026-08-01T00:30:00.000Z");
  assert.equal(reportingDate(instant), "2026-07-31");
});
