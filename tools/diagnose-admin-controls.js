import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/logger.js";
import { ExistingChromeRuntime } from "../src/gui-runtime.js";

const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });

try {
  await runtime.initialize();
  const adminTab = await runtime.findTab((url) => url.startsWith("https://admin.example.com/"));
  if (!adminTab) throw new Error("対象管理画面 tab was not found");
  const year = await runtime.typeAddressJavascript(adminTab.windowId, "async()=>{const n=[...document.querySelectorAll('label,span,div')].find(e=>(e.innerText||e.textContent||'').trim()==='Year'&&e.getBoundingClientRect().width>0),p=n&&n.parentElement;if(!p)return[];return[...p.querySelectorAll('*')].slice(0,10).map(e=>[e.tagName,e.getAttribute('type')||'',String(e.className||'').slice(0,32),e.getAttribute('aria-haspopup')||'',String(e.value||'').slice(0,12),(e.innerText||'').trim().slice(0,12)])}");
  console.log(`YEAR_CHILDREN ${JSON.stringify(year)}`);
} finally {
  await runtime.restoreUserState().catch(() => {});
}
