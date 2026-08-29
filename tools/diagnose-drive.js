import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/logger.js";
import { ExistingChromeRuntime } from "../src/gui-runtime.js";

const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });

try {
  await runtime.initialize();
  const results = [];
  for (const windowId of await runtime.listChromeWindows()) {
    const title = (await runtime.run("xdotool", ["getwindowname", windowId])).stdout;
    try {
      const page = await runtime.pageSummary(windowId, ["レポート保存"]);
      results.push({ windowId, title, page });
    } catch (error) {
      results.push({ windowId, title, error: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log(JSON.stringify(results));
} finally {
  await runtime.restoreUserState().catch(() => {});
}
