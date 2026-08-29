import { execFile, spawnSync } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const normalizeWindowId = (value) => `0x${Number(value).toString(16).padStart(8, "0")}`;
const isBrowserAddress = (value) => {
  try {
    return ["http:", "https:", "chrome:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const customMenuOcrAliases = (actionLabel) => {
  const aliases = new Set([
    actionLabel,
    actionLabel.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, "")
  ]);
  for (const alias of [...aliases]) {
    // On the small Linux VM, Tesseract consistently confuses the handakuten
    // in インポート with dakuten, or duplicates the following ボ glyph.
    if (alias.includes("ポート")) {
      aliases.add(alias.replace("ポート", "ボート"));
      aliases.add(alias.replace("ポート", "ポボート"));
    }
  }
  return [...aliases];
};

const gasDialogIsError = (text) => {
  // OCR covers the whole Chrome window, so stale sheet text or the temporary
  // "script is running" banner can contain error-like words outside the
  // actual result alert. An explicit completion phrase in the visible alert
  // is authoritative.
  if (/完了しました|正常に完了|completed successfully|successfully completed/i.test(text)) return false;
  return /error|エラー|失敗|exception/i.test(text);
};

export class ExistingChromeRuntime {
  constructor({ root, xauthority = path.join(os.homedir(), ".Xauthority"), log }) {
    this.root = root;
    this.xauthority = xauthority;
    this.log = log;
    this.env = null;
    this.originalClipboard = "";
    this.originalWindowId = null;
    this.originalUrl = null;
  }

  async run(command, args = [], options = {}) {
    const { stdout = "", stderr = "" } = await execFileAsync(command, args, {
      env: options.env || this.env || process.env,
      timeout: options.timeout || 30_000,
      maxBuffer: options.maxBuffer || 8 * 1024 * 1024
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  }

  async commandExists(command) {
    try {
      await this.run("/usr/bin/env", ["bash", "-lc", `command -v ${command}`], { env: process.env });
      return true;
    } catch {
      return false;
    }
  }

  async detectDisplay() {
    if (process.env.DISPLAY) return process.env.DISPLAY;
    const { stdout } = await this.run("pgrep", ["-a", "-u", String(process.getuid()), "Xorg"], { env: process.env });
    const displays = stdout.split("\n")
      .map((line) => line.match(/(?:^|\s)(:\d+)(?:\s|$)/)?.[1])
      .filter(Boolean);
    if (!displays.length) throw new Error("Chrome Remote Desktop display was not found");
    return displays.includes(":20") ? ":20" : displays[0];
  }

  readClipboard() {
    const result = spawnSync("xclip", ["-selection", "clipboard", "-o"], {
      encoding: "utf8",
      env: this.env,
      timeout: 5_000
    });
    return result.status === 0 ? result.stdout : "";
  }

  writeClipboard(text) {
    spawnSync("xclip", ["-selection", "clipboard", "-i"], {
      encoding: "utf8",
      env: this.env,
      input: text,
      timeout: 5_000
    });
  }

  async initialize({ preserveActiveDialog = false } = {}) {
    for (const tool of ["xdotool", "xclip", "wmctrl", "xwininfo", "xwd", "convert", "tesseract", "gio"]) {
      if (!(await this.commandExists(tool))) throw new Error(`Required command is missing: ${tool}`);
    }
    const display = await this.detectDisplay();
    this.env = { ...process.env, DISPLAY: display, XAUTHORITY: this.xauthority };
    this.originalClipboard = this.readClipboard();
    if (preserveActiveDialog) {
      // Capturing the active URL starts with Escape, which can dismiss a GAS
      // result dialog. Dedicated dialog-resume flows must leave it untouched.
      this.originalWindowId = null;
      this.originalUrl = null;
      await this.log("resident_chrome_runtime_ready", { display, preservedActiveDialog: true });
      return;
    }
    try {
      const active = (await this.run("xdotool", ["getactivewindow"])).stdout;
      this.originalWindowId = normalizeWindowId(active);
      const chromeWindows = await this.listChromeWindows();
      this.originalUrl = chromeWindows.includes(this.originalWindowId)
        ? await this.currentUrl(this.originalWindowId).catch(() => null)
        : null;
      if (!this.originalUrl) this.originalWindowId = null;
    } catch {
      this.originalWindowId = null;
      this.originalUrl = null;
    }
    await this.log("resident_chrome_runtime_ready", { display });
  }

  async restoreUserState() {
    try {
      if (this.originalWindowId && this.originalUrl) {
        await this.activateMatchingTab(this.originalWindowId, (url) => url === this.originalUrl);
        await this.run("xdotool", ["windowactivate", "--sync", this.originalWindowId]);
      }
    } catch {
      // Best effort: restoration must never hide the actual workflow result.
    }
    this.writeClipboard(this.originalClipboard);
  }

  async listChromeWindows() {
    const { stdout } = await this.run("wmctrl", ["-lx"]);
    return stdout.split("\n")
      .filter((line) => /\sgoogle-chrome\.Google-chrome\s/i.test(line))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  async activateWindow(windowId) {
    await this.run("xdotool", ["windowactivate", "--sync", windowId]);
    await delay(400);
  }

  async copyFocusedSelection({ attempts = 30, intervalMs = 100 } = {}) {
    const sentinel = `__VMRA_CLIPBOARD_${Date.now()}_${Math.random()}__`;
    this.writeClipboard(sentinel);
    await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+c"]);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await delay(intervalMs);
      const candidate = this.readClipboard();
      if (candidate && candidate !== sentinel) return candidate.trim();
      if (attempt > 0 && attempt % 10 === 0) {
        await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+c"]);
      }
    }
    return "";
  }

  async focusVerifiedAddressBar(windowId, { attempts = 3 } = {}) {
    let selected = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.activateWindow(windowId);
      // Escape exits an accidental Sheets cell-edit mode before Ctrl+L. No
      // text is sent until copying proves that the omnibox contains a browser
      // URL, so retrying this focus-only probe cannot execute a page action.
      await this.run("xdotool", ["key", "--clearmodifiers", "Escape"]);
      await delay(300 + ((attempt - 1) * 250));
      await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+l"]);
      await delay(700 + ((attempt - 1) * 300));
      selected = await this.copyFocusedSelection();
      if (isBrowserAddress(selected)) {
        await this.log("resident_address_bar_focus_verified", {
          windowId,
          origin: new URL(selected).origin,
          attempt
        });
        return selected;
      }
      await this.run("xdotool", ["key", "--clearmodifiers", "Escape"]).catch(() => {});
      await this.log("resident_address_bar_focus_retry", { windowId, attempt, attempts });
      if (attempt < attempts) await delay(600);
    }
    await this.log("resident_address_bar_focus_failed", { windowId, attempts });
    throw new Error("Address-bar focus safety stop: the selected text was not a browser URL");
  }

  async currentUrl(windowId) {
    const value = await this.focusVerifiedAddressBar(windowId);
    await this.run("xdotool", ["key", "--clearmodifiers", "Escape"]);
    return value;
  }

  async ensureWindowMaximized(windowId, { minimumWidth = 900, minimumHeight = 650 } = {}) {
    await this.run("wmctrl", ["-ir", windowId, "-b", "add,maximized_vert,maximized_horz"]);
    await delay(800);
    const { stdout } = await this.run("xdotool", ["getwindowgeometry", "--shell", windowId]);
    const width = Number(stdout.match(/^WIDTH=(\d+)$/m)?.[1] || 0);
    const height = Number(stdout.match(/^HEIGHT=(\d+)$/m)?.[1] || 0);
    if (width < minimumWidth || height < minimumHeight) {
      throw new Error(`Chrome window size safety stop: ${width}x${height}`);
    }
    await this.log("resident_window_maximized", { windowId, width, height });
    return { width, height };
  }

  async activateMatchingTab(windowId, matches, maxTabs = 15) {
    for (let index = 0; index < maxTabs; index += 1) {
      const url = await this.currentUrl(windowId);
      if (matches(url)) return { windowId, url };
      // Different tabs can legitimately have the same URL. URL equality is
      // therefore not proof that Ctrl+Tab returned to the starting tab. Scan
      // the bounded number of positions instead of stopping on a duplicate.
      if (index + 1 < maxTabs) {
        await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+Tab"]);
        await delay(500);
      }
    }
    await this.log("resident_window_scan_complete", { windowId, tabsChecked: maxTabs });
    return null;
  }

  async activateMatchingTabByPageLocation(windowId, matches, maxTabs = 15) {
    const seen = new Set();
    for (let index = 0; index < maxTabs; index += 1) {
      let url = null;
      let title = "";
      try {
        url = (await this.pageSummary(windowId)).url;
      } catch {
        title = (await this.run("xdotool", ["getwindowname", windowId])).stdout;
      }
      const signature = url || `title:${title}`;
      if (seen.has(signature)) {
        await this.log("resident_page_location_scan_complete", { windowId, tabsChecked: index });
        return null;
      }
      seen.add(signature);
      if (url && matches(url)) return { windowId, url };
      await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+Tab"]);
      await delay(800);
    }
    return null;
  }

  async findTab(matches) {
    const windows = await this.listChromeWindows();
    if (!windows.length) throw new Error("No visible Google Chrome windows were found; resident mode will not start Chrome");
    for (const windowId of windows) {
      const found = await this.activateMatchingTab(windowId, matches);
      if (found) return found;
    }
    return null;
  }

  async findTabByPageLocation(matches) {
    const windows = await this.listChromeWindows();
    if (!windows.length) throw new Error("No visible Google Chrome windows were found");
    for (const windowId of windows) {
      const found = await this.activateMatchingTabByPageLocation(windowId, matches);
      if (found) return found;
    }
    return null;
  }

  async openTab(windowId, url) {
    await this.submitAddressBarText(windowId, url, { submitKey: "alt+Return" });
    await delay(4_000);
    const expectedOrigin = new URL(url).origin;
    const opened = await this.activateMatchingTabByPageLocation(windowId, (candidate) => {
      try {
        return new URL(candidate).origin === expectedOrigin;
      } catch {
        return false;
      }
    });
    if (!opened) throw new Error(`Chrome did not open the requested resident tab: ${new URL(url).origin}`);
    return opened;
  }

  async navigateTab(windowId, url) {
    await this.submitAddressBarText(windowId, url);
    await delay(5_000);
    const current = await this.currentUrl(windowId);
    if (!current.startsWith(new URL(url).origin)) {
      throw new Error(`Chrome did not navigate to the requested origin: ${new URL(url).origin}`);
    }
    return { windowId, url: current };
  }

  async reloadTab(
    windowId,
    { timeoutMs = 120_000, pollIntervalMs = 2_000, forceReload = false, expectedUrlPrefix = null } = {}
  ) {
    const before = await this.typeAddressJavascript(
      windowId,
      "async()=>({url:location.href,readyState:document.readyState,timeOrigin:performance.timeOrigin})"
    );
    if (expectedUrlPrefix && !before.url.startsWith(expectedUrlPrefix)) {
      throw new Error(`Reload target safety stop: expected ${expectedUrlPrefix}, found ${before.url}`);
    }
    await this.activateWindow(windowId);
    const method = forceReload ? "ctrl+shift+r" : "ctrl+r";
    await this.run("xdotool", ["key", "--clearmodifiers", method]);
    await this.log("resident_tab_reload_requested", {
      windowId,
      url: before.url,
      method,
      beforeTimeOrigin: before.timeOrigin
    });

    const startedAt = Date.now();
    let lastState = null;
    while (Date.now() - startedAt < timeoutMs) {
      await delay(pollIntervalMs);
      try {
        lastState = await this.typeAddressJavascript(
          windowId,
          "async()=>({url:location.href,readyState:document.readyState,timeOrigin:performance.timeOrigin})"
        );
        const sameUrl = lastState.url === before.url;
        const newDocument = Number(lastState.timeOrigin) > Number(before.timeOrigin);
        if (sameUrl && newDocument && lastState.readyState === "complete") {
          const result = {
            windowId,
            url: lastState.url,
            method,
            beforeTimeOrigin: before.timeOrigin,
            afterTimeOrigin: lastState.timeOrigin
          };
          await this.log("resident_tab_reload_verified", result);
          return result;
        }
      } catch {
        // Chrome can briefly reject address-bar page commands while the new
        // document is loading. Retry until the verified timeout expires.
      }
    }

    throw new Error(
      `Resident tab reload verification timed out: url=${lastState?.url || "unavailable"}, ` +
      `readyState=${lastState?.readyState || "unavailable"}, ` +
      `beforeTimeOrigin=${before.timeOrigin}, afterTimeOrigin=${lastState?.timeOrigin || "unavailable"}`
    );
  }

  async navigateTabByPageLocation(windowId, url, matches, timeoutMs = 120_000) {
    await this.submitAddressBarText(windowId, url);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await delay(5_000);
      try {
        const state = await this.pageSummary(windowId);
        if (matches(state.url)) return { windowId, url: state.url };
        if (state.auth) throw new Error("Manual Google authentication is required after navigation");
      } catch (error) {
        if (/Manual Google authentication/.test(String(error))) throw error;
      }
    }
    throw new Error(`Chrome did not navigate to the verified target: ${new URL(url).origin}`);
  }

  async typeAddressJavascript(windowId, functionSource) {
    const marker = `__VMRA_RESULT_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
    const markerLiteral = JSON.stringify(marker);
    // Each command owns a marker-specific recovery slot. A shared slot allowed
    // a delayed restore from an older command to delete or overwrite the title
    // state of a newer command. The marker guard also prevents an old timer
    // from replacing a newer result title while it is being read.
    const script = `javascript:(async()=>{const m=${markerLiteral},k='__vmraOriginalTitle_'+m,t=document.title||'',fallback=location.hostname==='admin.example.com'?'Admin':location.hostname==='drive.google.com'?'Google Drive':location.hostname==='docs.google.com'?'Google Sheets':location.hostname,recovered=location.hostname==='docs.google.com'?String(document.querySelector('#docs-title-input')?.value||'').trim():'';window[k]=t.startsWith('__VMRA_RESULT_')||t===fallback?(recovered||fallback):t;const restore=()=>{if(document.title.startsWith(m))document.title=window[k]||recovered||fallback;delete window[k]};try{const f=(${functionSource}),v=await f();document.title=m+btoa(unescape(encodeURIComponent(JSON.stringify({ok:1,v}))));setTimeout(restore,30000)}catch(e){document.title=m+btoa(unescape(encodeURIComponent(JSON.stringify({ok:0,e:String(e&&e.message||e)}))));setTimeout(restore,30000)}})();void 0`;

    await this.submitAddressBarText(windowId, script);

    let payload = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(200);
      const { stdout: title } = await this.run("xdotool", ["getwindowname", windowId]);
      const start = title.indexOf(marker);
      if (start < 0) continue;
      const encoded = title.slice(start + marker.length).match(/^[A-Za-z0-9+/=]+/)?.[0];
      if (!encoded) continue;
      payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      break;
    }
    if (!payload) throw new Error("Resident Chrome page command did not return a result");

    const restoreScript = `javascript:(()=>{const m=${markerLiteral},k='__vmraOriginalTitle_'+m,fallback=location.hostname==='admin.example.com'?'Admin':location.hostname==='drive.google.com'?'Google Drive':location.hostname==='docs.google.com'?'Google Sheets':location.hostname,recovered=location.hostname==='docs.google.com'?String(document.querySelector('#docs-title-input')?.value||'').trim():'';if(document.title.startsWith(m))document.title=window[k]||recovered||fallback;delete window[k]})();void 0`;
    // Immediate restoration is cosmetic and must not hide a successful page
    // command. The marker-owned 30-second timer remains as a safe fallback.
    await this.submitAddressBarText(windowId, restoreScript).catch(async (error) => {
      await this.log("resident_title_restore_deferred", {
        windowId,
        marker,
        message: error instanceof Error ? error.message : String(error)
      });
    });
    await delay(800);

    if (!payload.ok) throw new Error(`Resident page command failed: ${payload.e}`);
    return payload.v;
  }

  async submitAddressBarText(windowId, text, { submitKey = "Return", inputAttempts = 3 } = {}) {
    const originalUrl = await this.focusVerifiedAddressBar(windowId);
    let lastInputError = null;

    for (let attempt = 1; attempt <= inputAttempts; attempt += 1) {
      try {
        // Reassert Ctrl+L immediately before input. Chrome deliberately strips
        // a pasted `javascript:` scheme, so that short prefix is the only text
        // ever typed. Return is pressed only after the complete command has
        // been copied back and verified, making pre-submit retries side-effect
        // free even when the VM temporarily misses a focus or paste event.
        await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+l"]);
        await delay(250 + ((attempt - 1) * 250));
        if (text.startsWith("javascript:")) {
          const prefix = "javascript:";
          await this.run("xdotool", ["type", "--delay", "20", "--clearmodifiers", "--", prefix], {
            timeout: 5_000
          });
          await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+a"]);
          const verifiedPrefix = await this.copyFocusedSelection();
          if (verifiedPrefix !== prefix) {
            throw new Error("the omnibox did not retain the verified javascript prefix");
          }
          await this.run("xdotool", ["key", "--clearmodifiers", "End"]);
          this.writeClipboard(text.slice(prefix.length));
          await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+v"]);
        } else {
          this.writeClipboard(text);
          await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+v"]);
        }
        await delay(500 + ((attempt - 1) * 250));
        await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+a"]);
        const pasted = await this.copyFocusedSelection();
        if (pasted !== text) {
          throw new Error("the omnibox did not contain the complete intended text");
        }
        await this.log("resident_address_bar_text_verified", { windowId, length: text.length, attempt });
        await this.run("xdotool", ["key", "--clearmodifiers", submitKey]);
        return;
      } catch (error) {
        lastInputError = error;
        await this.run("xdotool", ["key", "--clearmodifiers", "Escape"]).catch(() => {});
        await this.log("resident_address_bar_input_retry", {
          windowId,
          attempt,
          attempts: inputAttempts,
          message: error instanceof Error ? error.message : String(error)
        });
        if (attempt < inputAttempts) {
          await delay(700);
          await this.focusVerifiedAddressBar(windowId);
        }
      }
    }

    // All retries failed before Return, so no command was executed. Restore
    // the captured existing-tab URL to keep the next timer attempt recoverable.
    try {
      await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+l"]);
      await delay(300);
      this.writeClipboard(originalUrl);
      await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+v"]);
      await delay(500);
      await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+a"]);
      const restoredText = await this.copyFocusedSelection();
      if (restoredText !== originalUrl) {
        throw new Error("the original URL could not be restored atomically");
      }
      await this.run("xdotool", ["key", "--clearmodifiers", "Return"]);
      await delay(1_500);
      await this.log("resident_address_bar_original_url_restored", { windowId, origin: new URL(originalUrl).origin });
    } catch (restoreError) {
      await this.run("xdotool", ["key", "--clearmodifiers", "Escape"]).catch(() => {});
      await this.log("resident_address_bar_original_url_restore_failed", {
        windowId,
        message: restoreError instanceof Error ? restoreError.message : String(restoreError)
      });
    }
    throw new Error(
      `Address-bar typing safety stop: ${lastInputError instanceof Error ? lastInputError.message : String(lastInputError)}`
    );
  }

  async pageSummary(windowId, markers = []) {
    const encoded = Buffer.from(JSON.stringify(markers), "utf8").toString("base64");
    return this.typeAddressJavascript(windowId, `async()=>{const m=JSON.parse(decodeURIComponent(escape(atob('${encoded}')))),t=document.body?.innerText||'',u=location.href;return{url:u,markers:m.map(x=>t.includes(x)),auth:/^https:\\/\\/accounts\\.google\\.com\\//i.test(u)||/^https:\\/\\/admin\\.example\\.com\\/login(?:[/?#]|$)/i.test(u)}}`);
  }

  async visibleSheetsBlockingNotification(windowId) {
    return this.typeAddressJavascript(windowId, "async()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'},dark=e=>{const c=getComputedStyle(e).backgroundColor||'',m=c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);return m?Math.max(Number(m[1]),Number(m[2]),Number(m[3]))<140:false},nodes=[...document.querySelectorAll('[role=alert],[role=status],[class*=snackbar],[class*=toast]')].filter(e=>visible(e)&&dark(e)),items=nodes.map(e=>(e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean);return{visible:items.length>0,text:items.join(' | ').slice(0,500),count:items.length}}");
  }

  async accessiblePageSummary(windowId, markers = []) {
    const encoded = Buffer.from(JSON.stringify(markers), "utf8").toString("base64");
    return this.typeAddressJavascript(windowId, `async()=>{const m=JSON.parse(decodeURIComponent(escape(atob('${encoded}')))),t=[document.body?.innerText||'',[...document.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')||'').join(' ')].join(' '),u=location.href;return{url:u,markers:m.map(x=>t.includes(x)),auth:/^https:\/\/accounts\.google\.com\//i.test(u)}}`);
  }

  async clickExactText(windowId, label, { delayMs = 0 } = {}) {
    const encoded = Buffer.from(label, "utf8").toString("base64");
    return this.typeAddressJavascript(windowId, `async()=>{const d=s=>decodeURIComponent(escape(atob(s))),q=d('${encoded}'),v=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'},all=[...document.querySelectorAll('button,[role=button],[role=menuitem],[role=tab],[role=option],a,div,span')].filter(e=>v(e)&&(e.innerText||e.textContent||'').trim()===q),rank=e=>['BUTTON','A'].includes(e.tagName)||e.hasAttribute('role')?0:1,best=Math.min(...all.map(rank)),top=all.filter(e=>rank(e)===best),unique=[...new Map(top.map(e=>{const r=e.getBoundingClientRect();return[[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)].join(':'),e]})).values()];if(unique.length!==1)throw new Error('expected one visible exact control '+q+', found '+unique.length);const e=unique[0];setTimeout(()=>e.click(),${Number(delayMs)});return{label:q,scheduled:${Number(delayMs) > 0},tag:e.tagName,role:e.getAttribute('role')}}`);
  }

  async exactTextWindowCoordinates(windowId, label) {
    const encoded = Buffer.from(label, "utf8").toString("base64");
    return this.typeAddressJavascript(windowId, `async()=>{const d=s=>decodeURIComponent(escape(atob(s))),q=d('${encoded}'),v=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'},all=[...document.querySelectorAll('button,[role=button],[role=menuitem],a,div,span')].filter(e=>v(e)&&(e.innerText||e.textContent||'').trim()===q),rank=e=>['BUTTON','A'].includes(e.tagName)||e.hasAttribute('role')?0:1,best=Math.min(...all.map(rank)),top=all.filter(e=>rank(e)===best),unique=[...new Map(top.map(e=>{const r=e.getBoundingClientRect();return[[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)].join(':'),e]})).values()];if(unique.length!==1)throw new Error('expected one visible exact control '+q+', found '+unique.length);const r=unique[0].getBoundingClientRect(),dy=Math.max(0,outerHeight-innerHeight);return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2+dy)}}`);
  }

  async openSingleActionCustomMenu(windowId, menuLabel, { settleMs = 1_500 } = {}) {
    const menuCoordinates = await this.exactTextWindowCoordinates(windowId, menuLabel);
    await this.clickWindowCoordinates(windowId, menuCoordinates);
    await delay(settleMs);
    return { menuCoordinates };
  }

  async clickSingleActionCustomMenu(windowId, menuLabel, actionLabel, options = {}) {
    return this.clickCustomMenuActionByOrder(windowId, menuLabel, [actionLabel], actionLabel, options);
  }

  async clickCustomMenuActionByOrder(windowId, menuLabel, approvedActions, actionLabel, options = {}) {
    if (!Array.isArray(approvedActions) || approvedActions.length === 0) {
      throw new Error(`Custom menu safety stop: no approved actions for ${menuLabel}`);
    }
    if (new Set(approvedActions).size !== approvedActions.length) {
      throw new Error(`Custom menu safety stop: duplicate approved actions for ${menuLabel}`);
    }
    const actionIndex = approvedActions.indexOf(actionLabel);
    if (actionIndex < 0) {
      throw new Error(`Custom menu safety stop: action is not approved: ${menuLabel}:${actionLabel}`);
    }

    const aliases = customMenuOcrAliases(actionLabel);
    const attempts = Number(options.menuOpenAttempts ?? 6);
    let opened = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      opened = await this.openSingleActionCustomMenu(windowId, menuLabel, options);
      try {
        const actionCoordinates = await this.exactOcrTextCoordinates(windowId, aliases, "jpn+eng");
        await this.clickWindowCoordinates(windowId, actionCoordinates);
        await this.log("resident_gas_menu_action_verified", {
          menuLabel,
          actionLabel,
          actionIndex,
          attempt
        });
        return { ...opened, actionLabel, actionIndex, actionCoordinates, attempt };
      } catch (error) {
        if (!/OCR safety stop: approved text matches=0/.test(String(error))) throw error;
        try {
          const actionCoordinates = await this.exactPopupOcrTextScreenCoordinates(
            windowId,
            aliases,
            opened.menuCoordinates,
            "jpn+eng"
          );
          await this.clickScreenCoordinates(actionCoordinates);
          await this.log("resident_gas_menu_action_verified", {
            menuLabel,
            actionLabel,
            actionIndex,
            attempt,
            recognition: actionCoordinates.source
          });
          return { ...opened, actionLabel, actionIndex, actionCoordinates, attempt };
        } catch (popupError) {
          if (!/Popup OCR safety stop: approved text matches=0/.test(String(popupError))) throw popupError;
        }
        await this.run("xdotool", ["key", "--clearmodifiers", "Escape"]).catch(() => {});
        await this.log("resident_gas_menu_blocked_retry", { menuLabel, actionLabel, attempt });
        if (attempt < attempts) await delay(4_000);
      }
    }
    throw new Error(`Custom menu safety stop: approved action did not become visible: ${menuLabel}:${actionLabel}`);
  }

  async clickExactTextByPointer(windowId, label) {
    const coordinates = await this.exactTextWindowCoordinates(windowId, label);
    await this.clickWindowCoordinates(windowId, coordinates);
    return { label, coordinates };
  }

  async doubleClickExactText(windowId, label, { delayMs = 600 } = {}) {
    const encoded = Buffer.from(label, "utf8").toString("base64");
    return this.typeAddressJavascript(windowId, `async()=>{const d=s=>decodeURIComponent(escape(atob(s))),q=d('${encoded}'),v=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'},exact=[...document.querySelectorAll('button,[role=button],[role=gridcell],[role=row],a,div,span')].filter(e=>v(e)&&(e.innerText||e.textContent||'').trim()===q),targets=exact.map(e=>e.closest('[role=gridcell]')||e.closest('[role=row]')||e),unique=[...new Map(targets.filter(v).map(e=>{const r=e.getBoundingClientRect();return[[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)].join(':'),e]})).values()];if(unique.length!==1)throw new Error('expected one visible exact target '+q+', found '+unique.length);const e=unique[0];setTimeout(()=>e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,view:window,detail:2})),${Number(delayMs)});return{label:q,scheduled:true,role:e.getAttribute('role')}}`);
  }

  async doubleClickDriveRowExactName(windowId, label, { delayMs = 900 } = {}) {
    const encoded = Buffer.from(label, "utf8").toString("base64");
    return this.typeAddressJavascript(windowId, `async()=>{const d=s=>decodeURIComponent(escape(atob(s))),q=d('${encoded}'),v=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none'},rows=[...document.querySelectorAll('[role=row]')].filter(e=>v(e)&&((e.innerText||'').split('\\n')[0]||'').trim()===q),unique=[...new Map(rows.map(e=>{const r=e.getBoundingClientRect();return[[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)].join(':'),e]})).values()];if(unique.length!==1)throw new Error('expected one visible Drive row named '+q+', found '+unique.length);const e=unique[0];setTimeout(()=>e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,view:window,detail:2})),${Number(delayMs)});return{label:q,scheduled:true,role:e.getAttribute('role')}}`);
  }

  async driveRowExactNameCoordinates(windowId, label) {
    const encoded = Buffer.from(label, "utf8").toString("base64");
    return this.typeAddressJavascript(windowId, `async()=>{const d=s=>decodeURIComponent(escape(atob(s))),q=d('${encoded}'),rendered=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'},named=e=>(e.innerText||'').split('\\n').map(x=>x.trim()).includes(q)||[...e.querySelectorAll('[aria-label],[data-tooltip]')].some(x=>(x.getAttribute('aria-label')||x.getAttribute('data-tooltip')||'').trim()===q),rows=[...document.querySelectorAll('[role=row]')].filter(e=>rendered(e)&&named(e)),unique=[...new Map(rows.map(e=>{const r=e.getBoundingClientRect();return[[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)].join(':'),e]})).values()];if(unique.length!==1)throw new Error('expected one rendered Drive row containing exact name '+q+', found '+unique.length);const e=unique[0];e.scrollIntoView({block:'center',inline:'nearest'});await new Promise(r=>setTimeout(r,1200));const r=e.getBoundingClientRect(),dy=Math.max(0,outerHeight-innerHeight);if(r.bottom<=0||r.right<=0||r.top>=innerHeight||r.left>=innerWidth)throw new Error('Drive row did not become visible '+q);return{x:Math.round(r.left+Math.min(Math.max(r.width*.35,80),300)),y:Math.round(r.top+r.height/2+dy),label:q}}`);
  }

  async driveVisibleRowExactNameCount(windowId, label) {
    const encoded = Buffer.from(label, "utf8").toString("base64");
    return this.typeAddressJavascript(windowId, `async()=>{const d=s=>decodeURIComponent(escape(atob(s))),q=d('${encoded}'),rendered=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'},named=e=>(e.innerText||'').split('\\n').map(x=>x.trim()).includes(q)||[...e.querySelectorAll('[aria-label],[data-tooltip]')].some(x=>(x.getAttribute('aria-label')||x.getAttribute('data-tooltip')||'').trim()===q),rows=[...document.querySelectorAll('[role=row]')].filter(e=>rendered(e)&&named(e)),unique=[...new Map(rows.map(e=>{const r=e.getBoundingClientRect();return[[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)].join(':'),e]})).values()];return unique.length}`);
  }

  async renameDriveRowExactName(windowId, originalName, newName, { settleMs = 5_000 } = {}) {
    if (!originalName || !newName || originalName === newName) {
      throw new Error("Drive rename safety stop: invalid original or backup name");
    }
    const existingBackupCount = await this.driveVisibleRowExactNameCount(windowId, newName);
    if (existingBackupCount !== 0) {
      throw new Error(`Drive rename safety stop: backup name already exists (${newName})`);
    }
    const coordinates = await this.driveRowExactNameCoordinates(windowId, originalName);
    await this.clickWindowCoordinates(windowId, coordinates);
    await delay(1_500);
    await this.run("xdotool", ["key", "--clearmodifiers", "n"]);
    await delay(2_000);
    const dialogText = await this.ocrWindowText(windowId);
    if (!/(名前を変更|Rename)/i.test(dialogText)) {
      await this.run("xdotool", ["key", "--clearmodifiers", "Escape"]).catch(() => {});
      throw new Error(`Drive rename safety stop: rename dialog was not verified (${originalName})`);
    }
    await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+a"]);
    await this.run("xdotool", ["type", "--delay", "5", "--clearmodifiers", "--", newName], {
      timeout: 30_000
    });
    await this.run("xdotool", ["key", "--clearmodifiers", "Return"]);
    await delay(settleMs);
    const originalCount = await this.driveVisibleRowExactNameCount(windowId, originalName);
    const backupCount = await this.driveVisibleRowExactNameCount(windowId, newName);
    if (originalCount !== 0 || backupCount !== 1) {
      throw new Error(
        `Drive rename verification failed: original=${originalCount}, backup=${backupCount}, file=${originalName}`
      );
    }
    await this.log("resident_drive_file_renamed_for_backup", { originalName, newName });
    return { originalName, newName };
  }

  async setSelectFollowingLabel(windowId, label, value) {
    const encodedLabel = Buffer.from(label, "utf8").toString("base64");
    const encodedValue = Buffer.from(String(Number(value)), "utf8").toString("base64");
    const opened = await this.typeAddressJavascript(windowId, `async()=>{const d=s=>decodeURIComponent(escape(atob(s))),l=d('${encodedLabel}'),v=d('${encodedValue}'),vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'},n=[...document.querySelectorAll('label,span,div')].find(e=>vis(e)&&(e.innerText||e.textContent||'').trim()===l);if(!n)throw new Error('date label not found '+l);const p=n.parentElement,s=p&&p.querySelector('select');if(s){const o=[...s.options].find(x=>x.label===v||x.value===v||Number(x.label)===Number(v));if(!o)throw new Error('option '+v+' not found after '+l);s.value=o.value;s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));return{done:true,native:true}}const cur=p&&p.querySelector('[class*="-singleValue"]'),c=p&&(p.querySelector('[class*="-control"]')||p.querySelector('input'));if(!c)throw new Error('date control not found after '+l);if(cur&&Number((cur.innerText||cur.textContent||'').trim())===Number(v))return{done:true,native:false};const r=c.getBoundingClientRect(),dy=Math.max(0,outerHeight-innerHeight);return{done:false,native:false,coordinates:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2+dy)}}}`);
    if (opened.done) return { label, value: String(Number(value)), native: opened.native };
    await this.clickWindowCoordinates(windowId, opened.coordinates);
    await delay(1_500);
    // React Select exposes its rendered options while the menu is open. The
    // address bar cannot be used here because focusing it closes the menu, so
    // locate the exact approved numeric option with OCR and click it directly.
    const optionCoordinates = await this.numericOptionCoordinatesByScrolling(
      windowId,
      String(Number(value)),
      opened.coordinates
    );
    await this.clickWindowCoordinates(windowId, optionCoordinates);
    await delay(2_000);
    const verified = await this.typeAddressJavascript(windowId, `async()=>{const d=s=>decodeURIComponent(escape(atob(s))),l=d('${encodedLabel}'),v=d('${encodedValue}'),vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'},n=[...document.querySelectorAll('label,span,div')].find(e=>vis(e)&&(e.innerText||e.textContent||'').trim()===l),p=n&&n.parentElement,s=p&&p.querySelector('select'),cur=p&&(p.querySelector('[class*="-singleValue"]')||p.querySelector('input'));if(!n||!cur&&!s)throw new Error('date control not found after '+l);const actual=s?String(s.options[s.selectedIndex]?.label||s.value||''):String(cur.innerText||cur.textContent||cur.value||'').trim();return{selected:Number(actual)===Number(v),actual}}`);
    if (!verified.selected) {
      throw new Error(`Date selection verification failed after ${label}: expected ${Number(value)}, found ${verified.actual || "blank"}`);
    }
    return { label, value: String(Number(value)), native: false, optionCoordinates };
  }

  async numericOptionCoordinatesByScrolling(windowId, value, controlCoordinates, maxScans = 12) {
    const target = String(Number(value));
    let lastZeroMatchError = null;
    for (let scan = 0; scan < maxScans; scan += 1) {
      try {
        const coordinates = await this.ocrNumericOptionCoordinates(windowId, target, controlCoordinates);
        await this.log("resident_date_option_found", { target, scan: scan + 1, coordinates });
        return coordinates;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Date option OCR safety stop:.*matches=0(?:;|$)/.test(message)) throw error;
        lastZeroMatchError = error;
      }

      if (scan === maxScans - 1) break;
      // React Select only renders the visible portion of a long day list. Keep
      // the pointer inside the menu and move it slowly by three rows before
      // scanning again. Wheel scrolling does not select or submit an option.
      const menuPoint = { x: controlCoordinates.x, y: controlCoordinates.y + 70 };
      await this.activateWindow(windowId);
      await this.run("xdotool", [
        "mousemove", "--window", windowId,
        String(menuPoint.x), String(menuPoint.y)
      ]);
      for (let notch = 0; notch < 3; notch += 1) {
        await this.run("xdotool", ["click", "5"]);
        await delay(450);
      }
      await delay(1_200);
      await this.log("resident_date_option_scroll", { target, completedScan: scan + 1 });
    }
    throw new Error(
      `Date option scroll safety stop: ${target} was not uniquely visible after ${maxScans} scans; ` +
      `${lastZeroMatchError instanceof Error ? lastZeroMatchError.message : "no OCR match"}`
    );
  }

  async dialogState(windowId) {
    return this.typeAddressJavascript(windowId, "async()=>{const ds=[...document.querySelectorAll('[role=dialog],.modal-dialog')].filter(e=>e.getBoundingClientRect().width>0),d=ds.at(-1);if(!d)return{visible:false};const text=(d.innerText||'').trim().slice(0,240);return{visible:true,text,error:/error|エラー|失敗|exception/i.test(text)}}");
  }

  async probeAddressBarAvailableWithoutEscape(windowId) {
    await this.activateWindow(windowId);
    // Do not press Escape here: Escape can dismiss a browser-modal GAS result
    // dialog. Ctrl+L is harmless and is ignored while that modal owns focus.
    await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+l"]);
    await delay(700);
    const selected = await this.copyFocusedSelection({ attempts: 12, intervalMs: 100 });
    const available = isBrowserAddress(selected);
    if (available) {
      await this.run("xdotool", ["key", "--clearmodifiers", "Escape"]).catch(() => {});
    }
    await this.log("resident_dialog_focus_probe", { windowId, addressBarAvailable: available });
    return available;
  }

  async confirmDialog(windowId, dialog) {
    if (dialog?.okCoordinates) {
      await this.clickWindowCoordinates(windowId, dialog.okCoordinates);
      return "pointer";
    }
    if (dialog?.confirmation === "default-button-keyboard") {
      await this.activateWindow(windowId);
      await this.run("xdotool", ["key", "--clearmodifiers", "Return"]);
      return "keyboard";
    }
    throw new Error("GAS dialog confirmation safety stop: no approved confirmation method");
  }

  async waitForDialog(
    windowId,
    timeoutMs = 360_000,
    pollMs = 1_500,
    { successLabels = [], warningLabels = [] } = {}
  ) {
    const started = Date.now();
    let modalBlockedScans = 0;
    while (Date.now() - started < timeoutMs) {
      const regionText = await this.ocrGasDialogRegion(windowId).catch(async (error) => {
        await this.log("resident_gas_dialog_region_ocr_failed", {
          windowId,
          message: error instanceof Error ? error.message : String(error)
        });
        return "";
      });
      const normalizedRegionText = regionText.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
      const matchedSuccessLabel = successLabels.find((label) =>
        normalizedRegionText.includes(label.normalize("NFKC").replace(/\s+/g, "").toLowerCase()));
      if (matchedSuccessLabel) {
        return {
          visible: true,
          text: regionText.replace(/\s+/g, " ").trim().slice(0, 500),
          error: false,
          matchedSuccessLabel,
          okCoordinates: null,
          confirmation: "default-button-keyboard"
        };
      }
      const matchedWarningLabel = warningLabels.find((label) =>
        normalizedRegionText.includes(label.normalize("NFKC").replace(/\s+/g, "").toLowerCase()));
      if (matchedWarningLabel) {
        const addressBarAvailable = await this.probeAddressBarAvailableWithoutEscape(windowId);
        return {
          visible: true,
          text: regionText.replace(/\s+/g, " ").trim().slice(0, 500),
          error: false,
          warning: true,
          notification: addressBarAvailable,
          matchedWarningLabel,
          okCoordinates: null,
          confirmation: addressBarAvailable ? null : "default-button-keyboard"
        };
      }
      // Strict production callers supply the exact completion phrase for the
      // selected GAS action. Never approve an unknown modal using focus alone.
      if (successLabels.length > 0 || warningLabels.length > 0) {
        const addressBarAvailable = await this.probeAddressBarAvailableWithoutEscape(windowId);
        modalBlockedScans = addressBarAvailable ? 0 : modalBlockedScans + 1;
        if (!addressBarAvailable && regionText && gasDialogIsError(regionText)) {
          return {
            visible: true,
            text: regionText.replace(/\s+/g, " ").trim().slice(0, 500),
            error: true,
            matchedSuccessLabel: null,
            okCoordinates: null,
            confirmation: "default-button-keyboard"
          };
        }
        if (modalBlockedScans > 0) {
          await this.log("resident_gas_unknown_modal_waiting", {
            windowId,
            modalBlockedScans,
            expectedSuccessLabels: successLabels,
            acceptedWarningLabels: warningLabels,
            elapsedMs: Date.now() - started
          });
        }
        await delay(pollMs);
        continue;
      }

      try {
        const okCoordinates = await this.exactOcrTextCoordinates(windowId, ["OK"], "eng");
        const text = await this.ocrWindowText(windowId);
        return {
          visible: true,
          text: text.replace(/\s+/g, " ").trim().slice(0, 500),
          error: gasDialogIsError(text),
          okCoordinates,
          confirmation: "pointer"
        };
      } catch (error) {
        if (!/OCR safety stop: approved text matches=0/.test(String(error))) throw error;
      }

      // Chrome's compositor can render a browser-modal GAS alert outside the
      // XWD surface of the main Chrome window. In that case OCR sees the sheet
      // behind it, while Ctrl+L is consistently blocked by the visible modal.
      // Require two consecutive blocked probes before accepting this fallback.
      const addressBarAvailable = await this.probeAddressBarAvailableWithoutEscape(windowId);
      modalBlockedScans = addressBarAvailable ? 0 : modalBlockedScans + 1;
      if (modalBlockedScans >= 2) {
        return {
          visible: true,
          text: "GAS result dialog detected by two consecutive modal focus probes",
          error: false,
          okCoordinates: null,
          confirmation: "default-button-keyboard"
        };
      }
      await delay(pollMs);
    }
    throw new Error("Timed out waiting for the GAS result dialog");
  }

  async ocrGasDialogRegion(windowId, languages = "jpn+eng") {
    const artifactDir = path.join(this.root, "artifacts");
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const xwdPath = path.join(artifactDir, `gas-region-${stamp}.xwd`);
    const pngPath = path.join(artifactDir, `gas-region-${stamp}.png`);
    await mkdir(artifactDir, { recursive: true });
    try {
      await this.activateWindow(windowId);
      const { stdout: geometryText } = await this.run("xdotool", ["getwindowgeometry", "--shell", windowId]);
      const windowX = Number(geometryText.match(/^X=(-?\d+)$/m)?.[1] || 0);
      const windowY = Number(geometryText.match(/^Y=(-?\d+)$/m)?.[1] || 0);
      const windowWidth = Number(geometryText.match(/^WIDTH=(\d+)$/m)?.[1] || 1920);
      const windowHeight = Number(geometryText.match(/^HEIGHT=(\d+)$/m)?.[1] || 1080);
      const cropWidth = Math.max(500, Math.round(windowWidth * 0.7));
      const cropHeight = Math.max(300, Math.round(windowHeight * 0.55));
      const cropX = Math.max(0, Math.round(windowX + (windowWidth - cropWidth) / 2));
      const cropY = Math.max(0, Math.round(windowY + (windowHeight - cropHeight) / 2));
      await this.run("xwd", ["-root", "-silent", "-out", xwdPath]);
      await this.run("convert", [
        xwdPath,
        "-crop", `${cropWidth}x${cropHeight}+${cropX}+${cropY}`,
        "+repage",
        "-resize", "175%",
        "-colorspace", "Gray",
        "-contrast-stretch", "1%x1%",
        pngPath
      ], { timeout: 30_000 });
      return (await this.run(
        "tesseract",
        [pngPath, "stdout", "-l", languages, "--psm", "11"],
        { timeout: 30_000 }
      )).stdout;
    } finally {
      await rm(xwdPath, { force: true });
      await rm(pngPath, { force: true });
    }
  }

  async waitForDialogDismissed(
    windowId,
    timeoutMs = 120_000,
    { confirmationMethod = null, successLabels = [] } = {}
  ) {
    const started = Date.now();
    let addressBarClearScans = 0;
    let ocrClearScans = 0;
    let resultTextClearScans = 0;
    let keyboardConfirmationRetries = 0;
    while (Date.now() - started < timeoutMs) {
      // Strict production calls know the exact completion phrase. Require that
      // phrase itself to disappear twice; address-bar focus is not proof that
      // a Sheets/GAS result dialog was dismissed.
      if (successLabels.length > 0) {
        let regionReadSucceeded = false;
        let regionText = "";
        try {
          regionText = await this.ocrGasDialogRegion(windowId);
          regionReadSucceeded = true;
        } catch (error) {
          await this.log("resident_gas_dialog_dismissal_ocr_failed", {
            windowId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        const normalizedRegionText = regionText.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
        const resultStillVisible = successLabels.some((label) =>
          normalizedRegionText.includes(label.normalize("NFKC").replace(/\s+/g, "").toLowerCase()));
        resultTextClearScans = regionReadSucceeded && !resultStillVisible ? resultTextClearScans + 1 : 0;
        if (resultTextClearScans >= 2) {
          await this.log("resident_dialog_dismissed_by_result_text_clear", {
            windowId,
            confirmationMethod
          });
          return true;
        }
        if (resultStillVisible && confirmationMethod === "keyboard" && keyboardConfirmationRetries < 2) {
          await this.activateWindow(windowId);
          await this.run("xdotool", ["key", "--clearmodifiers", "Return"]);
          keyboardConfirmationRetries += 1;
          await this.log("resident_dialog_keyboard_confirmation_retried", {
            windowId,
            attempt: keyboardConfirmationRetries
          });
        }
        await delay(1_500);
        continue;
      }

      let ocrClear = false;
      try {
        await this.exactOcrTextCoordinates(windowId, ["OK"], "eng");
      } catch (error) {
        if (!/OCR safety stop: approved text matches=0/.test(String(error))) throw error;
        ocrClear = true;
      }

      ocrClearScans = ocrClear ? ocrClearScans + 1 : 0;

      // A pointer confirmation is only selected after OCR found the dialog's
      // exact OK button in the captured Chrome surface. In that case two
      // consecutive scans without OK are independent evidence that the same
      // dialog has disappeared. This avoids a false failure when Ctrl+L focus
      // probing is temporarily blocked by Sheets' post-script snackbar.
      if (confirmationMethod === "pointer" && ocrClearScans >= 2) {
        await this.log("resident_dialog_dismissed_by_ocr", {
          windowId,
          confirmationMethod
        });
        return true;
      }

      // Browser-modal GAS alerts block Ctrl+L. Once Ctrl+L works twice in a
      // row, the modal is gone even if OCR still finds an unrelated "OK" in
      // the sheet underneath it. Requiring OCR to be clear here produced a
      // false failure after a successful pointer confirmation.
      const addressBarAvailable = await this.probeAddressBarAvailableWithoutEscape(windowId);
      addressBarClearScans = addressBarAvailable ? addressBarClearScans + 1 : 0;
      if (addressBarClearScans >= 2) {
        await this.log("resident_dialog_dismissed_by_focus_probe", {
          windowId,
          ocrClear
        });
        return true;
      }
      await delay(1_500);
    }
    throw new Error("GAS dialog did not disappear after clicking OK");
  }

  async ocrWindowText(windowId, languages = "jpn+eng") {
    const artifactDir = path.join(this.root, "artifacts");
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const xwdPath = path.join(artifactDir, `dialog-${stamp}.xwd`);
    const pngPath = path.join(artifactDir, `dialog-${stamp}.png`);
    await mkdir(artifactDir, { recursive: true });
    try {
      await this.activateWindow(windowId);
      await this.run("xwd", ["-id", windowId, "-silent", "-out", xwdPath]);
      await this.run("convert", [xwdPath, pngPath], { timeout: 60_000 });
      return (await this.run("tesseract", [pngPath, "stdout", "-l", languages, "--psm", "11"], { timeout: 90_000 })).stdout;
    } finally {
      await rm(xwdPath, { force: true });
      await rm(pngPath, { force: true });
    }
  }

  async chooseFile(filePath, timeoutMs = 45_000) {
    await access(filePath);
    const started = Date.now();
    let chooserId = null;
    while (Date.now() - started < timeoutMs) {
      await delay(300);
      const active = (await this.run("xdotool", ["getactivewindow"])).stdout;
      const windowId = normalizeWindowId(active);
      const className = (await this.run("xdotool", ["getwindowclassname", active]).catch(() => ({ stdout: "" }))).stdout;
      if (!/chrome/i.test(className)) {
        chooserId = windowId;
        break;
      }
    }
    if (!chooserId) throw new Error("File chooser did not open");
    await this.run("xdotool", ["windowactivate", "--sync", chooserId]);
    await this.run("xdotool", ["key", "--clearmodifiers", "ctrl+l"]);
    await delay(1_000);
    await this.run("xdotool", ["type", "--delay", "1", "--clearmodifiers", "--", filePath], { timeout: 30_000 });
    await this.run("xdotool", ["key", "--clearmodifiers", "Return"]);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await delay(3_000);
      // wmctrl keeps withdrawn portal windows in its list after a successful
      // selection. Treat only a mapped/viewable chooser as still open; the
      // old existence-only check reactivated an already hidden chooser and
      // falsely failed even though Drive had accepted the file.
      const chooserInfo = await this.run("xwininfo", ["-id", chooserId]).catch(() => null);
      const chooserStillVisible = Boolean(chooserInfo && /Map State:\s+IsViewable/i.test(chooserInfo.stdout));
      if (!chooserStillVisible) {
        await this.log("resident_file_chooser_closed_after_selection", { attempt });
        return;
      }
      await this.run("xdotool", ["windowactivate", "--sync", chooserId]);
      await this.run("xdotool", ["key", "--clearmodifiers", "Return"]);
      await this.log("resident_file_chooser_confirm_retried", { attempt });
    }
    throw new Error("File chooser did not close after selecting the approved file");
  }

  async closeOpenFileChoosers() {
    const { stdout } = await this.run("wmctrl", ["-lx"]);
    const chooserIds = stdout.split("\n")
      .filter((line) => /xdg-desktop-portal-gtk\.Xdg-desktop-portal-gtk/i.test(line))
      .filter((line) => /\sOpen Files\s*$/i.test(line))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
    for (const windowId of chooserIds) {
      await this.run("wmctrl", ["-ic", windowId]).catch(() => {});
    }
    if (chooserIds.length) await this.log("resident_file_choosers_closed", { count: chooserIds.length });
    return chooserIds.length;
  }

  async exactOcrTextCoordinates(windowId, labels, languages = "jpn+eng") {
    const artifactDir = path.join(this.root, "artifacts");
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const xwdPath = path.join(artifactDir, `ocr-${stamp}.xwd`);
    const pngPath = path.join(artifactDir, `ocr-${stamp}.png`);
    await mkdir(artifactDir, { recursive: true });
    try {
      await this.activateWindow(windowId);
      await this.run("xwd", ["-id", windowId, "-silent", "-out", xwdPath]);
      await this.run("convert", [xwdPath, pngPath], { timeout: 60_000 });
      const { stdout } = await this.run("tesseract", [pngPath, "stdout", "-l", languages, "--psm", "11", "tsv"], { timeout: 90_000 });
      const rows = stdout.split("\n").slice(1).map((line) => line.split("\t")).filter((row) => row.length >= 12 && row[11]);
      const lines = new Map();
      for (const row of rows) {
        const key = row.slice(1, 5).join(":");
        const box = { left: Number(row[6]), top: Number(row[7]), width: Number(row[8]), height: Number(row[9]), text: row[11] };
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push(box);
      }
      const normalize = (value) => value.normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
      const approved = labels.map(normalize);
      const matches = [...lines.values()].filter((words) => {
        const text = normalize(words.map((word) => word.text).join(""));
        const withoutLeadingPlus = text.replace(/^[+＋]/, "");
        return approved.some((label) => text === label || withoutLeadingPlus === label);
      });
      if (matches.length !== 1) {
        throw new Error(`OCR safety stop: approved text matches=${matches.length}`);
      }
      const words = matches[0];
      const left = Math.min(...words.map((word) => word.left));
      const top = Math.min(...words.map((word) => word.top));
      const right = Math.max(...words.map((word) => word.left + word.width));
      const bottom = Math.max(...words.map((word) => word.top + word.height));
      return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
    } finally {
      await rm(xwdPath, { force: true });
      await rm(pngPath, { force: true });
    }
  }

  async exactPopupOcrTextScreenCoordinates(
    windowId,
    labels,
    anchorCoordinates,
    languages = "jpn+eng"
  ) {
    const artifactDir = path.join(this.root, "artifacts");
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const xwdPath = path.join(artifactDir, `popup-${stamp}.xwd`);
    const pngPath = path.join(artifactDir, `popup-${stamp}.png`);
    await mkdir(artifactDir, { recursive: true });
    try {
      await this.activateWindow(windowId);
      const { stdout: geometryText } = await this.run("xdotool", ["getwindowgeometry", "--shell", windowId]);
      const windowX = Number(geometryText.match(/^X=(-?\d+)$/m)?.[1] || 0);
      const windowY = Number(geometryText.match(/^Y=(-?\d+)$/m)?.[1] || 0);
      const windowWidth = Number(geometryText.match(/^WIDTH=(\d+)$/m)?.[1] || 1920);
      const windowHeight = Number(geometryText.match(/^HEIGHT=(\d+)$/m)?.[1] || 1080);
      // Keep the crop tight around the popup. A wide crop included toolbar and
      // sheet text, causing the first menu row to be merged with unrelated OCR.
      const cropLeft = Math.max(windowX, Math.round(windowX + anchorCoordinates.x - 30));
      const cropTop = Math.max(windowY, Math.round(windowY + anchorCoordinates.y + 8));
      const cropWidth = Math.max(1, Math.min(420, windowX + windowWidth - cropLeft));
      const cropHeight = Math.max(1, Math.min(300, windowY + windowHeight - cropTop));
      const scale = 4;
      await this.run("xwd", ["-root", "-silent", "-out", xwdPath]);
      await this.run("convert", [
        xwdPath,
        "-crop", `${cropWidth}x${cropHeight}+${cropLeft}+${cropTop}`,
        "+repage",
        "-resize", `${scale * 100}%`,
        "-colorspace", "Gray",
        "-contrast-stretch", "1%x1%",
        "-sharpen", "0x1",
        pngPath
      ], { timeout: 60_000 });
      const { stdout } = await this.run(
        "tesseract",
        [pngPath, "stdout", "-l", languages, "--psm", "11", "tsv"],
        { timeout: 90_000 }
      );
      const rows = stdout.split("\n").slice(1)
        .map((line) => line.split("\t"))
        .filter((row) => row.length >= 12 && row[11]);
      const lines = new Map();
      for (const row of rows) {
        const key = row.slice(1, 5).join(":");
        const box = {
          left: Number(row[6]),
          top: Number(row[7]),
          width: Number(row[8]),
          height: Number(row[9]),
          text: row[11]
        };
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push(box);
      }
      const normalize = (value) => value.normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
      const approved = labels.map(normalize);
      const matches = [...lines.values()].filter((words) => {
        const text = normalize(words.map((word) => word.text).join(""));
        const withoutLeadingSymbol = text.replace(/^[+＋①②③④⑤⑥⑦⑧⑨⑩1-9().]+/, "");
        return approved.some((label) => {
          const withoutOrdinal = label.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]/, "");
          return text === label ||
            withoutLeadingSymbol === withoutOrdinal ||
            text.endsWith(label) ||
            text.endsWith(withoutOrdinal);
        });
      });
      if (matches.length !== 1) {
        throw new Error(`Popup OCR safety stop: approved text matches=${matches.length}`);
      }
      const words = matches[0];
      const left = Math.min(...words.map((word) => word.left));
      const top = Math.min(...words.map((word) => word.top));
      const right = Math.max(...words.map((word) => word.left + word.width));
      const bottom = Math.max(...words.map((word) => word.top + word.height));
      return {
        x: Math.round(cropLeft + (left + right) / (2 * scale)),
        y: Math.round(cropTop + (top + bottom) / (2 * scale)),
        source: "root-popup-ocr"
      };
    } finally {
      await rm(xwdPath, { force: true });
      await rm(pngPath, { force: true });
    }
  }

  async ocrNumericOptionCoordinates(windowId, value, controlCoordinates) {
    const artifactDir = path.join(this.root, "artifacts");
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const xwdPath = path.join(artifactDir, `date-option-${stamp}.xwd`);
    const pngPath = path.join(artifactDir, `date-option-${stamp}.png`);
    await mkdir(artifactDir, { recursive: true });
    try {
      await this.activateWindow(windowId);
      await this.run("xwd", ["-id", windowId, "-silent", "-out", xwdPath]);
      const { stdout: geometryText } = await this.run("xdotool", ["getwindowgeometry", "--shell", windowId]);
      const windowWidth = Number(geometryText.match(/^WIDTH=(\d+)$/m)?.[1] || 1920);
      const windowHeight = Number(geometryText.match(/^HEIGHT=(\d+)$/m)?.[1] || 1080);
      // Numeric options are very small, and full-window OCR loses them among
      // the report table. Crop only the React Select menu area, then enlarge
      // and increase contrast before OCR. Coordinates are mapped back to the
      // original window after recognition.
      const cropLeft = Math.max(0, Math.round(controlCoordinates.x - 180));
      const cropTop = Math.max(0, Math.round(controlCoordinates.y - 45));
      const cropWidth = Math.max(1, Math.min(360, windowWidth - cropLeft));
      const cropHeight = Math.max(1, Math.min(430, windowHeight - cropTop));
      const scale = 4;
      await this.run("convert", [
        xwdPath,
        "-crop", `${cropWidth}x${cropHeight}+${cropLeft}+${cropTop}`,
        "+repage",
        "-resize", `${scale * 100}%`,
        "-colorspace", "Gray",
        "-contrast-stretch", "1%x1%",
        "-sharpen", "0x1",
        pngPath
      ], {
        timeout: 60_000
      });
      const { stdout } = await this.run(
        "tesseract",
        [pngPath, "stdout", "-l", "eng", "--psm", "6", "-c", "tessedit_char_whitelist=0123456789", "tsv"],
        { timeout: 90_000 }
      );
      const target = String(Number(value));
      const numericRows = stdout.split("\n").slice(1)
        .map((line) => line.split("\t"))
        .filter((row) => row.length >= 12 && /^\d+$/.test(row[11]?.trim() || ""));
      const visible = [...new Set(numericRows.map((row) => String(Number(row[11].trim()))))];
      const matches = numericRows
        .filter((row) => String(Number(row[11].trim())) === target)
        .map((row) => ({
          x: cropLeft + (Number(row[6]) + Number(row[8]) / 2) / scale,
          y: cropTop + (Number(row[7]) + Number(row[9]) / 2) / scale
        }));
      if (matches.length !== 1) {
        throw new Error(
          `Date option OCR safety stop: expected one ${target} near ${controlCoordinates.x},${controlCoordinates.y}; ` +
          `matches=${matches.length}; visible=[${visible.join(",")}]`
        );
      }
      return { x: Math.round(matches[0].x), y: Math.round(matches[0].y) };
    } finally {
      await rm(xwdPath, { force: true });
      await rm(pngPath, { force: true });
    }
  }

  async exactEmailCoordinates(windowId, email) {
    const artifactDir = path.join(this.root, "artifacts");
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const xwdPath = path.join(artifactDir, `account-${stamp}.xwd`);
    const pngPath = path.join(artifactDir, `account-${stamp}.png`);
    await mkdir(artifactDir, { recursive: true });
    try {
      await this.activateWindow(windowId);
      await this.run("xwd", ["-id", windowId, "-silent", "-out", xwdPath]);
      await this.run("convert", [xwdPath, pngPath], { timeout: 60_000 });
      const { stdout } = await this.run("tesseract", [pngPath, "stdout", "-l", "eng", "--psm", "11", "tsv"], { timeout: 90_000 });
      const rows = stdout.split("\n").slice(1).map((line) => line.split("\t")).filter((row) => row.length >= 12 && row[11]);
      const lines = new Map();
      for (const row of rows) {
        const key = row.slice(1, 5).join(":");
        const box = { left: Number(row[6]), top: Number(row[7]), width: Number(row[8]), height: Number(row[9]), text: row[11] };
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push(box);
      }
      const normalizedEmail = email.toLowerCase().replace(/\s+/g, "");
      const matches = [...lines.values()].filter((words) => words.map(({ text }) => text).join("").toLowerCase().replace(/\s+/g, "").includes(normalizedEmail));
      if (matches.length !== 1) throw new Error(`Manual authentication required: approved account OCR matches=${matches.length}`);
      const words = matches[0];
      const left = Math.min(...words.map((word) => word.left));
      const top = Math.min(...words.map((word) => word.top));
      const right = Math.max(...words.map((word) => word.left + word.width));
      const bottom = Math.max(...words.map((word) => word.top + word.height));
      return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
    } finally {
      await rm(xwdPath, { force: true });
      await rm(pngPath, { force: true });
    }
  }

  async clickWindowCoordinates(windowId, { x, y }) {
    await this.activateWindow(windowId);
    await this.run("xdotool", ["mousemove", "--window", windowId, String(x), String(y), "click", "1"]);
  }

  async clickScreenCoordinates({ x, y }) {
    await this.run("xdotool", ["mousemove", String(x), String(y), "click", "1"]);
  }
}

export const sleep = delay;
