import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { makeZip } from "../extension/core/zip.js";
import { toCsv } from "../tests/fixtures/ledger.mjs";
import * as delivery from "../tests/fixtures/delivery-lines.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "extension");
const destination = resolve(root, "dist");
const manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8"));
const packageInfo = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (manifest.version !== packageInfo.version) throw new Error("manifest 与 package.json 版本不一致。");

const files = [];
for (const item of await readdir(source, { recursive: true, withFileTypes: true })) {
  if (!item.isFile()) continue;
  const path = resolve(item.parentPath, item.name);
  const name = relative(source, path).split(sep).join("/");
  if (!/^[\w./-]+$/.test(name) || name.split("/").some((part) => part.startsWith(".")) ||
      !/\.(?:js|json|html|css|png|svg)$/.test(name)) {
    throw new Error(`运行目录中有未识别的打包文件 ${name}`);
  }
  files.push([name, await readFile(path)]);
}
files.sort(([a], [b]) => a.localeCompare(b, "en"));
const names = new Set(files.map(([name]) => name));
for (const name of ["manifest.json", `_locales/${manifest.default_locale}/messages.json`,
  manifest.action.default_popup, manifest.options_ui.page,
  manifest.background.service_worker, ...Object.values(manifest.icons)]) {
  if (!names.has(name)) throw new Error(`缺少 ${name}`);
}
await mkdir(destination, { recursive: true });
const zip = makeZip(files);
const hashes = [];
for (const browser of ["edge", "chrome"]) {
  const name = `zhangye-${manifest.version}-${browser}.zip`;
  await writeFile(resolve(destination, name), zip);
  hashes.push(`${createHash("sha256").update(zip).digest("hex")}  ${name}`);
  console.log(`Built ${name} (${zip.length} bytes)`);
}
const trialName = `zhangye-${manifest.version}-trial.zip`;
const trial = makeZip([
  ["trial-instructions.txt", "\uFEFF" + await readFile(resolve(root, "docs/product-validation/trial-instructions.txt"), "utf8")],
  ["feedback.txt", "\uFEFF" + await readFile(resolve(root, "docs/product-validation/trial-feedback.txt"), "utf8")],
  ["samples/delivery-before.csv", "\uFEFF" + toCsv(delivery.before)],
  ["samples/delivery-after.csv", "\uFEFF" + toCsv(delivery.after)],
  ...files.map(([name, data]) => [`extension/${name}`, data]),
]);
await writeFile(resolve(destination, trialName), trial);
hashes.push(`${createHash("sha256").update(trial).digest("hex")}  ${trialName}`);
console.log(`Built ${trialName} (${trial.length} bytes)`);
await writeFile(resolve(destination, "SHA256SUMS.txt"), hashes.join("\n") + "\n");
