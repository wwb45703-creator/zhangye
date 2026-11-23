import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, fixturePage, rule, toCsv } from "./fixtures/ledger.mjs";
import * as delivery from "./fixtures/delivery-lines.mjs";
import { extractPackage, startBrowser, testFolder, until } from "./support/installed-browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = resolve(root, ".test-artifacts");
const screenshots = resolve(root, "docs/deployment/screenshots");
const packageInfo = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const requested = process.argv.slice(2);
const names = requested.length ? requested : ["edge", "chrome"];
assert.ok(names.every((name) => ["chrome", "edge"].includes(name)));
await mkdir(artifacts, { recursive: true });
await mkdir(screenshots, { recursive: true });
await writeFile(resolve(artifacts, "baseline-input.json"), JSON.stringify({ before, after, rule }), "utf8");
await writeFile(resolve(artifacts, "delivery-input.json"), JSON.stringify(delivery), "utf8");

const server = createServer((request, response) => {
  const stage = new URL(request.url, "http://127.0.0.1").pathname;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (stage === "/before") response.end(fixturePage(before, "采购订单 · 上期"));
  else if (stage === "/after") response.end(fixturePage(after, "采购订单 · 本期", true));
  else response.end("<!doctype html><meta charset=utf-8><p>此页面没有表格</p>");
}).listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

async function capture(browser, id, source, slot, count) {
  const popup = await browser.popup(id, source);
  await popup.click("#read-page");
  await until(() => popup.evaluate("!document.querySelector('#table-picker').hidden"), "Popup did not read a table");
  assert.equal(await popup.evaluate("document.querySelector('#source-table').options.length"), 1);
  assert.match(await popup.evaluate("document.querySelector('#popup-message').textContent"), /跳过 1 张/);
  if (process.env.ZHANGYE_POPUP_SCREENSHOT === "1" && slot === "before") {
    await popup.screenshot(resolve(screenshots, "popup.png"));
  }
  if (slot === "after") {
    assert.equal(await popup.evaluate("document.querySelector('#header-assumption').hidden"), false);
    assert.equal(await popup.evaluate("document.querySelector('[data-save=after]').disabled"), true);
    await popup.click("#confirm-header");
    assert.equal(await popup.evaluate("document.querySelector('[data-save=after]').disabled"), false);
  }
  await popup.click(`[data-save="${slot}"]`);
  await until(async () => {
    const stored = await popup.evaluate('chrome.storage.local.get("ledgerWorkspace")');
    const snapshot = stored.ledgerWorkspace?.[slot];
    if (!snapshot) return false;
    assert.equal(snapshot.rows.length, count);
    assert.equal(snapshot.meta.origin, origin);
    assert.ok(!snapshot.rows.some((row) => row.includes("HIDDEN") || row.includes("LEAK")));
    return true;
  }, `Snapshot for ${slot} was not saved`);
  return popup;
}

async function countResults(app, expected) {
  await app.locator("#result-content").waitFor({ state: "visible", timeout: 7000 });
  for (const [type, count] of Object.entries(expected)) {
    assert.equal(await app.locator(`.metric[data-type="${type}"] strong`).innerText(), String(count));
  }
}

async function importPeriod(app, slot, filename, table) {
  await app.locator(`[data-import="${slot}"]`).click();
  await app.locator("#csv-file").setInputFiles({
    name: filename, mimeType: "text/csv", buffer: Buffer.from("\uFEFF" + toCsv(table)),
  });
  await app.locator("#import-submit").click();
  await app.locator("#import-dialog").waitFor({ state: "hidden", timeout: 7000 });
}

async function run(name) {
  const temporary = await testFolder(artifacts);
  let browser;
  try {
    const extensionPath = resolve(temporary.folder, "unpacked");
    const profile = resolve(temporary.folder, "profile");
    await mkdir(profile);
    await extractPackage(resolve(root, "dist", `zhangye-${packageInfo.version}-${name}.zip`), extensionPath);
    browser = await startBrowser(name, profile);
    const version = (await browser.cdp.send("Browser.getVersion")).product;
    const { id } = await browser.cdp.send("Extensions.loadUnpacked", { path: extensionPath });
    const appUrl = `chrome-extension://${id}/workbench.html`;
    const reportPath = resolve(artifacts, `${name}.xlsx`);
    const backupPath = resolve(artifacts, `${name}-backup.json`);
    const errors = [];
    const requests = [];
    const watch = (app) => {
      app.on("pageerror", (error) => errors.push(error.message));
      app.on("request", (request) => {
        if (/^https?:/i.test(request.url())) requests.push(request.url());
      });
    };

    const source = browser.context.pages()[0];
    await source.goto(origin + "/before?example=must-not-store");
    const first = await capture(browser, id, source, "before", before.rows.length);
    await first.close();
    await source.goto(origin + "/after#example");
    const second = await capture(browser, id, source, "after", after.rows.length);
    const open = browser.context.waitForEvent("page", { timeout: 7000 });
    await second.click("#open-workbench").catch((error) => {
      if (!/closed|not found/i.test(error.message)) throw error;
    });
    let app = await open;
    watch(app);
    await app.waitForURL(appUrl);
    await app.setViewportSize({ width: 1280, height: 800 });
    await app.locator("#before-key").selectOption(rule.beforeKey);
    await app.locator("#after-key").selectOption(rule.afterKey);
    await app.locator("#compare").click();
    await countResults(app, { changed: 2, added: 2, missing: 1, review: 2 });
    assert.match(await app.locator("#result-summary").innerText(), /7 项需查看 · 1 条无变化/);
    assert.match(await app.locator("#scope-note").innerText(), /分页与筛选/);
    await app.locator('.metric[data-type="review"]').click();
    assert.equal(await app.locator("tbody tr[data-result-type=review]").count(), 2);
    await app.locator("#all-results").click();
    await app.locator("#result-search").fill("0007");
    assert.equal(await app.locator("tbody .result-key").innerText(), "0007");
    await app.getByRole("button", { name: "查看 0007 明细" }).click();
    assert.match(await app.locator("#detail-content").innerText(), /=1\+1/);
    await app.locator('#detail-dialog [data-close]').click();
    await app.locator("#result-search").fill("CG-001");
    await app.getByRole("button", { name: "查看 CG-001 明细" }).click();
    assert.match(await app.locator("#detail-content").innerText(), /<img src=x/);
    assert.equal(await app.locator("#detail-content img").count(), 0);
    await app.locator('#detail-dialog [data-close]').click();
    await app.locator("#result-search").fill("");

    await app.locator("#save-preset").click();
    await app.locator("#preset-name").fill("采购周核对");
    await app.locator("#preset-submit").click();
    await app.locator("#preset-dialog").waitFor({ state: "hidden" });
    await browser.context.setOffline(true);
    await app.locator("#preset-select").selectOption("");
    await app.locator("#preset-select").selectOption("采购周核对");
    await app.locator("#compare").click();
    await countResults(app, { changed: 2, added: 2, missing: 1, review: 2 });
    await browser.download(() => app.locator("#export").click(), reportPath);
    await app.locator("#manage").click();
    await browser.download(() => app.locator("#backup").click(), backupPath);
    const saved = await readFile(backupPath, "utf8");
    assert.ok(!saved.includes("must-not-store") && !saved.includes("/before") && !saved.includes("#example"));
    assert.equal(JSON.parse(saved).presets[0].name, "采购周核对");
    await browser.context.setOffline(false);

    await source.goto(name === "edge" ? "edge://version/" : "chrome://version/");
    const blocked = await browser.popup(id, source);
    await blocked.click("#read-page");
    await until(() => blocked.evaluate("document.querySelector('#popup-message').dataset.kind === 'error'"),
      "Restricted browser page did not show an error");
    assert.equal(await blocked.evaluate("document.querySelector('#table-picker').hidden"), true);
    await blocked.close();

    await browser.close();
    browser = await startBrowser(name, profile);
    // CDP loading is session-scoped. Reattach the same unpacked path and profile.
    const relaunched = await browser.cdp.send("Extensions.loadUnpacked", { path: extensionPath });
    assert.equal(relaunched.id, id);
    app = browser.context.pages()[0];
    watch(app);
    await app.goto(appUrl);
    await app.setViewportSize({ width: 1280, height: 800 });
    await app.locator("#preset-select").selectOption("采购周核对");
    await app.locator("#compare").click();
    await countResults(app, { changed: 2, added: 2, missing: 1, review: 2 });

    await app.locator('[data-import="after"]').click();
    await app.locator("#csv-file").setInputFiles({
      name: "损坏.csv", mimeType: "text/csv", buffer: Buffer.from("ID,值\n0007"),
    });
    await app.locator("#import-submit").click();
    await app.locator("#import-message").waitFor({ state: "visible" });
    assert.match(await app.locator("#import-message").innerText(), /列数/);
    await app.locator('#import-dialog [data-close]').click();
    assert.ok(await app.locator("#result-content").isVisible());

    await app.locator('[data-import="after"]').click();
    const other = await browser.context.newPage();
    await other.goto(appUrl);
    await other.locator("#preset-select").selectOption("采购周核对");
    await other.locator("#save-preset").click();
    await other.locator("#preset-name").fill("另一个窗口的规则");
    await other.locator("#preset-submit").click();
    await other.locator("#preset-dialog").waitFor({ state: "hidden" });
    await other.close();
    await app.locator("#csv-file").setInputFiles({
      name: "旧窗口.csv", mimeType: "text/csv", buffer: Buffer.from(toCsv(after)),
    });
    await app.locator("#import-submit").click();
    await app.locator("#import-message").waitFor({ state: "visible" });
    assert.match(await app.locator("#import-message").innerText(), /其他窗口/);
    await app.locator('#import-dialog [data-close]').click();
    assert.match(await app.locator('[data-slot="after"] .source-name').innerText(), /采购订单 · 本期/);

    await app.locator("#advance").click();
    await app.locator("[data-confirm-ok]").click();
    await app.locator('[data-slot="after"] .source-count').getByText("未添加").waitFor();
    assert.match(await app.locator('[data-slot="before"] .source-name').innerText(), /本期/);
    await app.locator('[data-import="after"]').click();
    await app.locator("#csv-file").setInputFiles({
      name: "采购订单本期.csv", mimeType: "text/csv", buffer: Buffer.from("\uFEFF" + toCsv(after)),
    });
    await app.locator("#import-submit").click();
    await app.locator("#import-dialog").waitFor({ state: "hidden" });
    await app.locator("#before-key").selectOption(rule.afterKey);
    await app.locator("#after-key").selectOption(rule.afterKey);
    await app.locator("#compare").click();
    await countResults(app, { changed: 0, added: 0, missing: 0, review: 0 });
    assert.match(await app.locator("#result-summary").innerText(), /6 条无变化/);

    await app.locator("#manage").click();
    await app.getByRole("button", { name: "删除本期", exact: true }).click();
    await app.locator("[data-confirm-ok]").click();
    await until(async () => (await app.locator("#manage-message").innerText()).includes("本期已删除"), "Single-period deletion failed");
    await app.locator("#restore-file").setInputFiles({
      name: "错误备份.json", mimeType: "application/json", buffer: Buffer.from('{"schema":999}'),
    });
    await until(async () => (await app.locator("#manage-message").innerText()).includes("版本"), "Malformed backup was not rejected");
    await app.locator("#restore-file").setInputFiles(backupPath);
    await app.locator("[data-confirm-ok]").click();
    await until(async () => (await app.locator("#manage-message").innerText()).includes("已恢复"), "Backup was not restored");
    await app.locator("#clear-data").click();
    await app.locator("[data-confirm-ok]").click();
    await until(async () => (await app.locator("#manage-message").innerText()).includes("已清除"), "Clear operation failed");
    await app.locator('#manage-dialog [data-close]').click();
    await app.locator("#load-demo").waitFor({ state: "visible" });
    if (name === "edge") await app.screenshot({ path: resolve(screenshots, "start.png") });

    await app.locator("#load-demo").click();
    await countResults(app, { changed: 3, added: 2, missing: 1, review: 2 });
    if (name === "edge") {
      await app.screenshot({ path: resolve(screenshots, "workbench.png") });
      await app.getByRole("button", { name: "查看 CG-1024 明细" }).click();
      await app.screenshot({ path: resolve(screenshots, "details.png") });
      await app.locator('#detail-dialog [data-close]').click();
    }
    await app.setViewportSize({ width: 390, height: 820 });
    assert.ok(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Page must not overflow at 390 px");

    await app.setViewportSize({ width: 1280, height: 800 });
    await importPeriod(app, "before", "交货明细合成上期.csv", delivery.before);
    await importPeriod(app, "after", "交货明细合成本期.csv", delivery.after);
    await app.locator("#before-key").selectOption("订单编号");
    await app.locator("#use-detail").check();
    assert.ok(await app.locator("#compare").isDisabled());
    await app.locator("#before-detail-key").selectOption("明细编号");
    assert.ok(await app.locator("#compare").isDisabled());
    await app.locator("#after-detail-key").selectOption("分录标识");
    await app.locator("#compare").click();
    await countResults(app, { changed: 1, added: 1, missing: 1, review: 2 });
    assert.match(await app.locator("#result-summary").innerText(), /5 项需查看 · 2 条无变化/);
    await app.getByRole("button", { name: "查看 CG-2408 / 010 明细" }).click();
    assert.match(await app.locator("#detail-content").innerText(), /2026-11-12/);
    await app.locator('#detail-dialog [data-close]').click();
    await app.locator("#save-preset").click();
    await app.locator("#preset-name").fill("交货明细");
    await app.locator("#preset-submit").click();
    await app.locator("#preset-dialog").waitFor({ state: "hidden" });
    await app.locator("#use-detail").uncheck();
    await app.locator("#preset-select").selectOption("交货明细");
    assert.equal(await app.locator("#before-detail-key").inputValue(), "明细编号");
    assert.equal(await app.locator("#after-detail-key").inputValue(), "分录标识");
    await app.locator("#compare").click();
    await browser.download(() => app.locator("#export").click(), resolve(artifacts, `${name}-delivery.xlsx`));
    if (name === "edge") await app.screenshot({ path: resolve(screenshots, "delivery-lines.png") });

    assert.equal(errors.length, 0, errors.join("\n"));
    assert.deepEqual(requests, []);

    // Simulate an unpacked update while keeping the installation path and browser profile.
    const manifestPath = resolve(extensionPath, "manifest.json");
    const next = JSON.parse(await readFile(manifestPath, "utf8"));
    const nextVersion = next.version.split(".").map((part, i) => i === 2 ? Number(part) + 1 : part).join(".");
    next.version = nextVersion;
    delete next.version_name;
    await browser.close();
    await writeFile(manifestPath, JSON.stringify(next), "utf8");
    browser = await startBrowser(name, profile);
    const upgraded = await browser.cdp.send("Extensions.loadUnpacked", { path: extensionPath });
    assert.equal(upgraded.id, id);
    app = browser.context.pages()[0];
    await app.goto(appUrl);
    await app.locator("#preset-select").selectOption("交货明细");
    await app.locator("#compare").click();
    await countResults(app, { changed: 1, added: 1, missing: 1, review: 2 });
    assert.equal(await app.locator("#version").innerText(), nextVersion);

    await browser.cdp.send("Extensions.uninstall", { id });
    const reinstall = await browser.cdp.send("Extensions.loadUnpacked", { path: extensionPath });
    assert.equal(reinstall.id, id);
    const fresh = await browser.context.newPage();
    await fresh.goto(appUrl);
    const stored = await fresh.evaluate(() => chrome.storage.local.get("ledgerWorkspace"));
    assert.equal(stored.ledgerWorkspace, undefined);
    console.log(`${version} PASS: packaged install, toolbar capture and header confirmation, one- and two-part keys, Excel export, restart, CSV, stale writes, backup/delete, local update, uninstall.`);
  } finally {
    try { await browser?.close(); } finally { await temporary.clean(); }
  }
}

try {
  for (const name of names) await run(name);
} finally {
  server.close();
}
