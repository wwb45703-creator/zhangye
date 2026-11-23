import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importCsv } from "../extension/core/snapshot.js";
import { compareSnapshots } from "../extension/core/compare.js";
import * as expected from "./fixtures/delivery-lines.mjs";

const results = {};
for (const period of ["before", "after"]) {
  const name = `excel-export-${period}.csv`;
  const bytes = await readFile(new URL(`../.test-artifacts/${name}`, import.meta.url));
  results[period] = importCsv(bytes, name);
  assert.deepEqual(results[period].headers, expected[period].headers);
  assert.deepEqual(results[period].rows, expected[period].rows);
}

const comparison = compareSnapshots(results.before, results.after, expected.rule);
assert.deepEqual(comparison.counts, { changed: 1, added: 1, missing: 1, review: 2, unchanged: 2 });
console.log("CSV round-trip PASS: both headers and every business cell preserved.");
