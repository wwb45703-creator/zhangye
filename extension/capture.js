// Return a bounded structured result to scripting.executeScript in the isolated world.
(() => {
  const MAX_TABLES = 5;
  const MAX_VISIBLE_TABLES = 30;
  const MAX_ROWS = 5000;
  const MAX_COLUMNS = 48;
  const MAX_BYTES = 1_500_000;
  const MAX_CELL = 4096;
  const encoder = new TextEncoder();

  const visible = (element) => element.getClientRects().length > 0 &&
    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const cellText = (cell) => (cell.innerText ?? cell.textContent ?? "").trim();
  const tables = [];
  let unsupported = 0;
  let limited = false;
  let scanned = 0;
  let totalBytes = 0;

  for (const table of document.getElementsByTagName("table")) {
    if (!visible(table)) continue;
    if (++scanned > MAX_VISIBLE_TABLES || tables.length >= MAX_TABLES) {
      limited = true;
      break;
    }
    if (table.querySelector("table") || table.closest("td, th") ||
        table.rows.length > MAX_ROWS + 20) {
      unsupported++;
      continue;
    }

    const allRows = Array.from(table.rows).filter((row) => visible(row) && row.parentElement.tagName !== "TFOOT");
    const headRows = allRows.filter((row) => row.parentElement === table.tHead);
    const headerRow = headRows[0] ?? allRows[0];
    if (!headerRow || headRows.length > 1) {
      unsupported++;
      continue;
    }
    const needsHeaderConfirmation = headRows.length === 0 &&
      !Array.from(headerRow.cells).every((cell) => cell.tagName === "TH");
    const width = headerRow.cells.length;
    if (width < 2 || width > MAX_COLUMNS || allRows.length > MAX_ROWS + 1) {
      unsupported++;
      continue;
    }

    let textUnits = 0;
    const readRow = (row) => {
      if (row.cells.length !== width) return null;
      const cells = [];
      for (const cell of row.cells) {
        if (cell.colSpan !== 1 || cell.rowSpan !== 1 || !visible(cell)) return null;
        const value = cellText(cell);
        textUnits += value.length;
        if (value.length > MAX_CELL || textUnits > MAX_BYTES) return null;
        cells.push(value);
      }
      return cells;
    };

    const headers = readRow(headerRow);
    if (!headers || headers.some((name) => !name || name.length > 96) ||
        new Set(headers).size !== headers.length) {
      unsupported++;
      continue;
    }
    const rows = [];
    let valid = true;
    for (const row of allRows) {
      if (row === headerRow) continue;
      const values = readRow(row);
      if (!values) {
        valid = false;
        break;
      }
      rows.push(values);
    }
    if (!valid) {
      unsupported++;
      continue;
    }

    const label = (table.caption && visible(table.caption) ? cellText(table.caption) : "").slice(0, 120);
    const snapshot = {
      headers,
      rows,
      meta: { kind: "web", label: label || `网页表格 ${scanned}`, at: new Date().toISOString(), origin: location.origin },
    };
    const bytes = encoder.encode(JSON.stringify(snapshot)).length;
    if (bytes > MAX_BYTES) {
      unsupported++;
      continue;
    }
    if (totalBytes + bytes > MAX_BYTES * 2) {
      limited = true;
      break;
    }
    totalBytes += bytes;
    tables.push({ ...snapshot, needsHeaderConfirmation });
  }
  return { tables, unsupported, limited };
})();
