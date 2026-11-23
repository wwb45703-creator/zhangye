import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { crc32 } from "../../extension/core/zip.js";

const executable = {
  chrome: process.env.ZHANGYE_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  edge: process.env.ZHANGYE_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
};

export async function until(check, explanation, timeout = 7000) {
  const end = Date.now() + timeout;
  let error;
  do {
    try {
      const value = await check();
      if (value) return value;
    } catch (caught) {
      error = caught;
    }
    await sleep(80);
  } while (Date.now() < end);
  throw new Error(explanation, { cause: error });
}

// Playwright ignores the toolbar popup target. Attach to that target explicitly.
async function popupProtocol(endpoint) {
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Popup debug transport timed out")), 8000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Popup debug transport failed")); }, { once: true });
  });
  let requestId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    const handler = pending.get(data.id);
    if (!handler) return;
    clearTimeout(handler.timer);
    pending.delete(data.id);
    if (data.error) handler.reject(new Error(data.error.message));
    else handler.resolve(data.result);
  });
  return {
    call(method, params, sessionId) {
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 6000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    close: () => ws.close(),
  };
}

export async function startBrowser(name, profile) {
  const portFile = resolve(profile, "DevToolsActivePort");
  await unlink(portFile).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  const process = spawn(executable[name], [
    "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--window-size=1280,800", "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  // An absent browser should be reported through the same bounded startup path.
  let launchError;
  process.on("error", (error) => { launchError = error; });
  let browser;
  let raw;
  try {
    const endpoint = await until(async () => {
      const [port, path] = (await readFile(portFile, "utf8")).trim().split(/\r?\n/);
      return /^\d+$/.test(port) && path ? `ws://127.0.0.1:${port}${path}` : null;
    }, `Could not start ${name}: ${executable[name]}`);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 8000 });
    const context = browser.contexts()[0];
    const cdp = await browser.newBrowserCDPSession();
    raw = await popupProtocol(endpoint);
    const downloadPath = resolve(profile, "test-downloads");
    await mkdir(downloadPath, { recursive: true });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath, eventsEnabled: true });
    return {
      cdp, context,
      async download(click, target) {
        let guid;
        let timer;
        let onProgress;
        const onBegin = (event) => {
          if (event.url.startsWith("blob:chrome-extension://")) guid = event.guid;
        };
        const completed = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Browser download did not finish")), 7000);
          onProgress = (event) => {
            if (event.guid !== guid || event.state === "inProgress") return;
            if (event.state === "completed") resolve(guid);
            else reject(new Error("Browser cancelled the export"));
          };
        });
        cdp.on("Browser.downloadWillBegin", onBegin);
        cdp.on("Browser.downloadProgress", onProgress);
        try {
          const [file] = await Promise.all([completed, click()]);
          assert.match(file, /^[0-9a-f-]{36}$/i);
          await copyFile(resolve(downloadPath, file), target);
        } finally {
          clearTimeout(timer);
          cdp.off("Browser.downloadWillBegin", onBegin);
          cdp.off("Browser.downloadProgress", onProgress);
        }
      },
      async popup(id, tab) {
        await tab.bringToFront();
        const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] });
        const target = targetInfos.find(({ url }) => url === tab.url());
        assert.ok(target, "Source tab must be open");
        await cdp.send("Extensions.triggerAction", { id, targetId: target.targetId });
        const popupTarget = await until(async () => {
          const response = await cdp.send("Target.getTargets", { filter: [{ exclude: false }] });
          return response.targetInfos.find(({ type, url }) => type === "page" && url === `chrome-extension://${id}/popup.html`);
        }, "Toolbar popup did not open");
        const { sessionId } = await raw.call("Target.attachToTarget", { targetId: popupTarget.targetId, flatten: true });
        const evaluate = async (expression) => {
          const response = await raw.call("Runtime.evaluate", {
            expression, awaitPromise: true, returnByValue: true, userGesture: true,
          }, sessionId);
          if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? "Popup script error");
          return response.result.value;
        };
        await until(() => evaluate("document.querySelector('#read-page')?.disabled === false"), "Popup initialization failed");
        return {
          evaluate,
          click: (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),
          async screenshot(path) {
            const response = await raw.call("Page.captureScreenshot", { format: "png" }, sessionId);
            await writeFile(path, Buffer.from(response.data, "base64"));
          },
          async close() {
            await evaluate("window.close()").catch(() => {});
            await until(async () => {
              const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ exclude: false }] });
              return !targetInfos.some(({ targetId }) => targetId === popupTarget.targetId);
            }, "Popup did not close");
          },
        };
      },
      async close() {
        raw.close();
        const exit = process.exitCode === null ? once(process, "exit") : Promise.resolve();
        await cdp.send("Browser.close").catch(() => {});
        const timer = setTimeout(() => process.kill(), 5000);
        try { await exit; } finally { clearTimeout(timer); }
        await browser.close();
      },
    };
  } catch (error) {
    raw?.close();
    await browser?.close();
    process.kill();
    throw launchError ?? error;
  }
}

export async function extractPackage(archive, destination) {
  const zip = await readFile(archive);
  const seen = new Set();
  for (let cursor = 0; zip.readUInt32LE(cursor) === 0x04034b50;) {
    const length = zip.readUInt32LE(cursor + 18);
    const nameLength = zip.readUInt16LE(cursor + 26);
    const extraLength = zip.readUInt16LE(cursor + 28);
    const name = zip.toString("utf8", cursor + 30, cursor + 30 + nameLength);
    const dataStart = cursor + 30 + nameLength + extraLength;
    const bytes = zip.subarray(dataStart, dataStart + length);
    assert.match(name, /^[\w-]+(?:\.[\w]+)?(?:\/[\w-]+(?:\.[\w]+)?)*$/);
    assert.equal(zip.readUInt16LE(cursor + 8), 0);
    assert.equal(crc32(bytes), zip.readUInt32LE(cursor + 14));
    assert.ok(!seen.has(name));
    seen.add(name);
    const target = resolve(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    cursor = dataStart + length;
  }
  assert.ok(seen.has("manifest.json"), "Package must contain a root manifest");
}

export async function testFolder(parent) {
  const base = await realpath(parent);
  const folder = await mkdtemp(resolve(base, "zhangye-"));
  return {
    folder,
    async clean() {
      const final = await realpath(folder);
      assert.equal(dirname(final), base);
      assert.ok(basename(final).startsWith("zhangye-"));
      await rm(final, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    },
  };
}
