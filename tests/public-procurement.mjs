import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractPackage, startBrowser, testFolder, until } from "./support/installed-browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = resolve(root, ".test-artifacts");
const packageInfo = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const source = "https://ggzyfw.beijing.gov.cn/jyxxgzsx/20250723/5197228.html";
const field = "配置要求（技术参数或组件）";
const expectedKeys = ["33", "34", "35"];
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const engine = process.argv.includes("--microsoft") ? "Microsoft" : "Registered";

await mkdir(artifacts, { recursive: true });

async function capture(browser, id, page, workbench, option, slot) {
  const popup = await browser.popup(id, page);
  await popup.click("#read-page");
  await until(() => popup.evaluate("!document.getElementById('table-picker').hidden"), "No readable public tables");
  assert.equal(await popup.evaluate("document.getElementById('source-table').options.length"), 2);
  await popup.evaluate(`(() => {
    const picker = document.getElementById("source-table");
    picker.selectedIndex = ${option};
    picker.dispatchEvent(new Event("change"));
  })()`);
  if (await popup.evaluate("!document.getElementById('header-assumption').hidden")) {
    assert.ok(await popup.evaluate(`document.querySelector('[data-save="${slot}"]').disabled`));
    await popup.click("#confirm-header");
  }
  await popup.click(`[data-save="${slot}"]`);
  await until(() => workbench.evaluate(async (period) => {
    const persisted = await chrome.storage.local.get("ledgerWorkspace");
    return persisted.ledgerWorkspace?.[period]?.rows.length === 3;
  }, slot), `Could not save ${slot} rows`);
  await popup.close();
}

async function run(name) {
  const scratch = await testFolder(artifacts);
  let browser;
  try {
    const extension = resolve(scratch.folder, "extension");
    const profile = resolve(scratch.folder, "profile");
    await mkdir(profile);
    await extractPackage(resolve(root, "dist", `zhangye-${packageInfo.version}-${name}.zip`), extension);
    browser = await startBrowser(name, profile);
    const version = (await browser.cdp.send("Browser.getVersion")).product;
    const { id } = await browser.cdp.send("Extensions.loadUnpacked", { path: extension });
    const page = browser.context.pages()[0];
    const workbench = await browser.context.newPage();
    await workbench.goto(`chrome-extension://${id}/workbench.html`);
    await workbench.setViewportSize({ width: 1280, height: 800 });
    const response = await page.goto(source, { timeout: 12000, waitUntil: "domcontentloaded" });
    assert.ok(response?.ok(), `Official source returned HTTP ${response?.status()}`);

    // Read the two originals via the page, independently of the extension storage.
    const published = await page.locator("table:visible").evaluateAll((tables) => tables.map((table) => ({
      heading: table.previousElementSibling?.textContent.trim().replace(/\s/g, ""),
      data: Array.from(table.rows, (row) => Array.from(row.cells, (cell) => cell.innerText.trim())),
    })));
    assert.equal(published.length, 2);
    for (const [index, { heading, data }] of published.entries()) {
      assert.match(heading ?? "", index === 0 ? /^更正前[:：]?$/ : /^更正后[:：]?$/);
      assert.equal(data.length, 4);
      assert.equal(data[0].length, 5);
      assert.equal(data[0][3], field);
      assert.deepEqual(data.slice(1).map(([key]) => key), expectedKeys);
    }
    const expected = expectedKeys.map((key, i) => ({
      key, field,
      beforeDigest: digest(published[0].data[i + 1][3]),
      afterDigest: digest(published[1].data[i + 1][3]),
    }));
    assert.ok(expected.every(({ beforeDigest, afterDigest }) => beforeDigest !== afterDigest));

    await capture(browser, id, page, workbench, 0, "before");
    await capture(browser, id, page, workbench, 1, "after");
    await workbench.bringToFront();
    await workbench.locator("#before-key").selectOption("序号");
    await workbench.locator("#compare").click();
    await workbench.locator("#result-content").waitFor({ state: "visible", timeout: 5000 });
    for (const [type, number] of Object.entries({ changed: "3", added: "0", missing: "0", review: "0" })) {
      assert.equal(await workbench.locator(`.metric[data-type="${type}"] strong`).innerText(), number);
    }
    assert.match(await workbench.locator("#result-summary").innerText(), /0 条无变化/);
    assert.deepEqual(await workbench.locator("#results-body .result-key").allTextContents(), expectedKeys);
    for (const { key, beforeDigest, afterDigest } of expected) {
      await workbench.getByRole("button", { name: `查看 ${key} 明细` }).click();
      const detail = workbench.locator(".detail-table tbody");
      assert.equal(await detail.locator("th").textContent(), field);
      assert.equal(digest(await detail.locator(".old-value").textContent()), beforeDigest);
      assert.equal(digest(await detail.locator(".new-value").textContent()), afterDigest);
      await workbench.locator('#detail-dialog [data-close]').click();
    }

    const report = resolve(scratch.folder, "public-case.xlsx");
    const expectedFile = resolve(scratch.folder, "expected.json");
    await writeFile(expectedFile, JSON.stringify(expected), "utf8");
    await browser.download(() => workbench.locator("#export").click(), report);
    const excel = await promisify(execFile)("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(root, "tests/public-report.ps1"),
      "-Workbook", report, "-Expected", expectedFile, "-Engine", engine,
    ], { timeout: 35000, windowsHide: true });
    console.log(`${version} HTTP ${response.status()} PASS: 3+3 source rows, keys 33/34/35, 3 matching field changes. ${excel.stdout.trim()}`);
    if (name === "edge" && process.argv.includes("--screenshot")) {
      await workbench.screenshot({ path: resolve(root, "docs/product-validation/public-procurement.png") });
    }
  } finally {
    try { await browser?.close(); } finally { await scratch.clean(); }
  }
}

const names = process.argv.slice(2).filter((arg) => !["--screenshot", "--microsoft"].includes(arg));
assert.ok(names.every((name) => ["edge", "chrome"].includes(name)), "Choose edge, chrome, or both");
for (const name of names.length ? names : ["edge", "chrome"]) await run(name);
