import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/logger.js";
import { ExistingChromeRuntime } from "../src/gui-runtime.js";

const root = process.env.AUTOMATION_HOME || path.join(os.homedir(), "gui-report-automation");
const log = await createLogger(path.join(root, "logs"));
const runtime = new ExistingChromeRuntime({ root, log });
const folderId = "EXAMPLE_DRIVE_FOLDER_ID";
const names = ["ContractSummary_JP_2026-08.csv", "ContractSummary_JP_2026-08-13.csv"];

await runtime.initialize();
try {
  const tab = await runtime.findTabByPageLocation((url) => url.includes(`/drive/folders/${folderId}`));
  if (!tab) throw new Error("Drive diagnostic safety stop: approved folder tab not found");
  const active = await runtime.activateMatchingTabByPageLocation(tab.windowId, (url) =>
    url.includes(`/drive/folders/${folderId}`));
  if (!active) throw new Error("Drive diagnostic safety stop: approved folder tab activation failed");
  const encoded = Buffer.from(JSON.stringify(names), "utf8").toString("base64");
  const result = await runtime.typeAddressJavascript(active.windowId, `async()=>{const qs=JSON.parse(decodeURIComponent(escape(atob('${encoded}')))),vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'},describe=e=>{const r=e.getBoundingClientRect();return{tag:e.tagName,role:e.getAttribute('role'),aria:e.getAttribute('aria-label'),tooltip:e.getAttribute('data-tooltip'),class:String(e.className||'').slice(0,180),text:(e.innerText||e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,240),rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]}},ancestors=e=>{const a=[];for(let n=e,i=0;n&&i<7;n=n.parentElement,i++)a.push(describe(n));return a};return qs.map(q=>{const matches=[...document.querySelectorAll('*')].filter(e=>vis(e)&&[(e.innerText||'').trim(),(e.textContent||'').trim(),(e.getAttribute('aria-label')||'').trim(),(e.getAttribute('data-tooltip')||'').trim()].includes(q));return{name:q,matches:matches.slice(0,20).map(ancestors),bodyIncludes:(document.body?.innerText||'').includes(q)}})}`);
  console.log(JSON.stringify(result));
} finally {
  await runtime.restoreUserState().catch(() => {});
}
