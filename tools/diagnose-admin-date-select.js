import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { ExistingChromeRuntime } from "../src/gui-runtime.js";
import { createLogger } from "../src/logger.js";

const dayArgument = process.argv[2];
const day = Number(dayArgument);
if (!Number.isInteger(day) || day < 1 || day > 31) {
  throw new Error("Usage: node src/diagnose-admin-date-select.js DAY (1-31)");
}

const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const config = await loadConfig();
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });

try {
  await runtime.initialize();
  const adminTab = await runtime.findTab((url) => url.startsWith(config.admin.url));
  if (!adminTab) throw new Error("The open 対象管理画面 report tab was not found");

  const result = await runtime.setSelectFollowingLabel(adminTab.windowId, "Day", String(day));
  await log("admin_day_selection_diagnostic_ok", { day, windowId: adminTab.windowId, result });
  console.log(`ADMIN_DAY_SELECTION_OK day=${day}`);
} catch (error) {
  await log("admin_day_selection_diagnostic_failed", {
    day,
    message: error instanceof Error ? error.message : String(error)
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await runtime.restoreUserState().catch(() => {});
}
