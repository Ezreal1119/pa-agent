/** Customer's 2026-11 Assembly templates. Other SOP types keep their existing generator. */
const fs = require("node:fs");

const TEMPLATE_NAMES = {
  中文: { cover: "封面", chart: "排位图", templates: ["1格模版", "2格模版", "4格模版"], authorRow: 22 },
  English: { cover: "Cover", chart: "Workstation Layout Chart", templates: ["1 compartments Template ", "2 compartments Template ", "4 compartments Template"], authorRow: 26 },
};
// Rows/columns are one-based. Every image has its own caption, in reading order.
const TILES = {
  1: [[6, 29, 7, 22, 30, 35]],
  2: [[6, 29, 7, 14, 30, 35], [6, 29, 15, 22, 30, 35]],
  4: [[6, 18, 7, 14, 19, 20], [6, 18, 15, 22, 19, 20], [21, 33, 7, 14, 34, 35], [21, 33, 15, 22, 34, 35]],
};
const quoteSheet = name => `'${name.replace(/'/gu, "''")}'`;
const literal = value => String(value).replace(/"/gu, '""');
const rowHeight = (sheet, row) => sheet.getRow(row).height || sheet.properties.defaultRowHeight || 30;
const blockHeight = (sheet, first, last) => Array.from({ length: last - first + 1 }, (_, i) => rowHeight(sheet, first + i)).reduce((a, b) => a + b, 0);

function instructionParagraphs(value) {
  const text = String(value || "").replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  if (!text) return [];
  const blocks = text.split(/\n[\t ]*\n+/u).map(part => part.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks;
  // Numbered steps may have wrapped continuation lines; retain those with their step.
  const lines = text.split("\n");
  const numbered = /^\s*(?:\d+[、．)）]|\d+\.(?!\d)|[（(]\d+[）)]|[一二三四五六七八九十]+[、．.]|(?:step|步骤)\s*\d+\b)/iu;
  if (lines.some(line => numbered.test(line))) {
    const result = [];
    for (const line of lines) {
      if (!result.length || numbered.test(line)) result.push(line);
      else result[result.length - 1] += `\n${line}`;
    }
    return result.map(part => part.trim()).filter(Boolean);
  }
  return lines.map(line => line.trim()).filter(Boolean);
}

function buildAssemblyWorkbook(workbook, options, h) {
  options = { ...options, author: h.authorName(options.author) };
  for (const [key, max] of [["revisionReason", 1000], ["revisionContent", 4000]]) {
    if (options[key] !== undefined && typeof options[key] !== "string") throw new Error(`${key} must be text.`);
    options[key] = (options[key] || "").trim();
    if (options[key].length > max) throw new Error(`${key} must not exceed ${max} characters.`);
  }
  const chinese = options.templateLanguage === "中文", names = TEMPLATE_NAMES[options.templateLanguage];
  const cover = workbook.getWorksheet(names.cover), chart = workbook.getWorksheet(names.chart);
  const templateSheets = names.templates.map(name => workbook.getWorksheet(name));
  if (!cover || !chart || templateSheets.some(sheet => !sheet)) throw new Error("Customer Assembly workbook is missing the selected language's cover, chart or 1/2/4-cell templates.");
  const sourceSheets = [...workbook.worksheets];
  const list = Array.isArray(options.processList) ? options.processList : h.parseProcessList(options.processList);
  const processes = h.resolveProcesses(options.projectDir, list, null, true, "assemble", sourceSheets.map(sheet => sheet.name));
  const warnings = [], tables = [], textRequests = [], pages = [];
  const seen = new Set([...sourceSheets.map(sheet => h.sheetNameKey(sheet.name)), ...processes.map(item => h.sheetNameKey(item.sheetName))]);
  const coverRef = quoteSheet(names.cover), chartRef = quoteSheet(names.chart);
  const labels = chinese
    ? { author: "编制人：", page: "页数：", continuation: "说明续页", full: "全文见", unmatched: "未配图操作说明", operation: "操作说明", previous: "前站检查", self: "自检" }
    : { author: "Author: ", page: "Page: ", continuation: "Instruction Continuation", full: "Full text in", unmatched: "Instructions without matching photos", operation: "Operation", previous: "Previous station check", self: "Self-check" };
  const freshName = prefix => {
    const name = h.uniqueSheetName(prefix, seen); seen.add(h.sheetNameKey(name)); return name;
  };
  const textFile = (folder, name) => { const file = h.assemblyPath(folder, name); return file ? fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, "").trim() : ""; };
  const paper = (sheet, area, orientation = "landscape") => {
    Object.assign(sheet.pageSetup, { paperSize: 9, orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 1, printArea: area });
    delete sheet.pageSetup.scale;
  };
  const formula = (sheet, cell, expression, result) => { sheet.getCell(cell).value = { formula: expression, ...(result == null ? {} : { result }) }; };
  const chineseText = /[\p{Script=Han}\u3000-\u303f\uff01-\uff60]/u;
  function fontPatch(cell, patch) {
    const font = { ...cell.font, ...patch };
    // A theme font would otherwise take precedence over an explicitly requested face.
    delete font.scheme;
    cell.style = { ...cell.style, font };
  }
  function styleRange(sheet, first, last, left, right, patch) {
    const masters = new Set();
    for (let row = first; row <= last; row++) for (let col = left; col <= right; col++) {
      const cell = sheet.getCell(row, col).master;
      if (!masters.has(cell.address)) { masters.add(cell.address); fontPatch(cell, patch); }
    }
  }
  // Apply process fonts before measuring tables, captions or check-text capacity.
  for (const template of templateSheets) {
    fontPatch(template.getCell("E1"), { size: 36 });
    for (const [left, right] of [[1, 4], [19, 22]]) styleRange(template, 3, 5, left, right, { size: 16 });
    for (const row of [6, 15, 22, 30, 36]) fontPatch(template.getCell(row, 1), { name: "黑体", size: 16 });
    for (const [first, last] of [[7, 14], [16, 21], [23, 29], [31, 35]]) {
      styleRange(template, first, last, 1, 6, { name: "黑体", size: 16,
        ...(first >= 23 ? { color: { argb: "FFFF0000" }, underline: true } : {}) });
    }
  }
  templateSheets.forEach((template, index) => {
    for (const [, , left, , first] of TILES[[1, 2, 4][index]]) fontPatch(template.getCell(first, left), { name: "黑体", size: 22 });
  });
  cover.getCell("A1").style = { ...cover.getCell("A1").style,
    alignment: { ...cover.getCell("A1").alignment, vertical: "middle" } };
  // Formula results cannot be rich text. Preserve their formulas and configure the
  // minor theme's Chinese fallback; ordinary mixed text uses explicit font runs.
  if (workbook._themes?.theme1) workbook._themes.theme1 = workbook._themes.theme1.replace(
    /<a:minorFont>[\s\S]*?<\/a:minorFont>/u,
    block => block.replace(/(<a:font script="Han[st]" typeface=")[^"]*("\/?>)/gu, "$1黑体$2")
  );
  function styleChartCell(cell) {
    const text = typeof cell.value === "string" ? cell.value : null;
    const hasChinese = text && chineseText.test(text);
    fontPatch(cell, { name: hasChinese ? "黑体" : "Calibri", charset: hasChinese ? 134 : 0 });
    cell.alignment = { ...cell.alignment, horizontal: "center", vertical: "middle", wrapText: true };
    if (text && chineseText.test(text) && /[A-Za-z0-9]/u.test(text)) {
      cell.value = { richText: (text.match(/[\p{Script=Han}\u3000-\u303f\uff01-\uff60]+|[^\p{Script=Han}\u3000-\u303f\uff01-\uff60]+/gu) || [])
        .map(run => ({ text: run, font: { ...cell.font, name: chineseText.test(run) ? "黑体" : "Calibri", charset: chineseText.test(run) ? 134 : 0 } })) };
    } else if (cell.value && typeof cell.value === "object" && "formula" in cell.value) {
      cell.font = { ...cell.font, scheme: "minor" };
    }
  }
  // Conservative point-height estimate with CJK/full-width glyphs and explicit line breaks.
  function textHeight(sheet, text, row, firstCol, lastCol, compact = false) {
    if (text == null || text === "") return 0;
    const size = sheet.getCell(row, firstCol).font?.size || 11, width = Math.max(1, h.mergedWidthPx(sheet, firstCol, lastCol) * 0.88);
    let lines = 0;
    for (const line of String(text).split("\n")) {
      let used = 0;
      for (const character of line) used += size * 4 / 3 * (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/u.test(character) ? 1 : 0.6);
      lines += Math.max(1, Math.ceil(used / width));
    }
    return lines * size * (compact ? 1.2 : 1.4) + (compact ? 6 : 10);
  }
  function writeText(sheet, text, range, processName, label, preserveAlignment = false) {
    const [first, last, left, right] = range, cell = sheet.getCell(first, left);
    // Imported cells can share a style object. Detach before changing alignment.
    cell.style = { ...cell.style, alignment: { ...cell.alignment,
      ...(preserveAlignment ? {} : { horizontal: "left", vertical: "top" }), wrapText: true } };
    if (!text) { cell.value = null; return; }
    if (textHeight(sheet, text, first, left, right) <= blockHeight(sheet, first, last) - 4) { cell.value = text; return; }
    const name = freshName(labels.continuation);
    textRequests.push({ name, processName, label, text, font: { ...cell.font } });
    const reference = `${labels.full}「${name}」`;
    // A short excerpt is useful on the process page; the continuation retains the complete original.
    const chars = Array.from(text); let low = 0, high = chars.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const preview = `${chars.slice(0, mid).join("")}…\n${reference}`;
      if (textHeight(sheet, preview, first, left, right) <= blockHeight(sheet, first, last) - 4) low = mid; else high = mid - 1;
    }
    cell.value = low ? `${chars.slice(0, low).join("")}…\n${reference}` : reference;
    warnings.push(`${processName}: ${label} ${chinese ? "超过原区容量，完整内容保存在" : "exceeds the original area; full text retained in"}「${name}」。`);
  }
  function tablePlan(template, records, first, last, protectedRows = []) {
    const base = last - first + 1, total = blockHeight(template, first, last);
    const fixed = protectedRows.reduce((sum, row) => sum + rowHeight(template, row), 0);
    const maximum = Math.max(base, Math.floor((total - fixed) / 24) + protectedRows.length);
    for (let count = Math.min(records.length, maximum); count >= 0; count--) {
      const rows = Math.max(base, count), heights = Array.from({ length: rows }, () => 24);
      const fits = heights.every((_, index) => {
        const row = first + index, record = index < count ? records[index] : null;
        const needed = record ? Math.max(24, ...[[record.index, 1, 1], [record.partno ?? record.name, 2, 3], [record.qty, 4, 4], [record.spec ?? record.specs, 5, 6]]
          .map(([value, left, right]) => textHeight(template, value, Math.min(row, last), left, right, true))) : 24;
        heights[index] = protectedRows.includes(row) ? rowHeight(template, row) : needed;
        return needed <= heights[index];
      });
      const used = heights.reduce((sum, height) => sum + height, 0);
      if (fits && used <= total + .001) {
        const spare = Math.max(0, total - used) / (rows - protectedRows.length);
        for (let i = 0; i < rows; i++) if (!protectedRows.includes(first + i)) heights[i] += spare;
        return { rows, inline: count, extra: rows - base, heights };
      }
    }
  }
  function layoutFor(template, bom, tools, slots) {
    const b = tablePlan(template, bom, 8, 14), t = tablePlan(template, tools, 17, 21, slots === 4 ? [19, 20] : []);
    const mapRow = row => row + (row >= 15 ? b.extra : 0) + (row >= 22 ? t.extra : 0);
    return { bomEndRow: 14, toolsEndRow: 21, bomExtra: b.extra, toolsExtra: t.extra, mapRow, b, t,
      compact(sheet) {
        for (let i = 0; i < b.rows; i++) sheet.getRow(8 + i).height = b.heights[i];
        for (let row = mapRow(17); row <= mapRow(21) + t.extra; row++) {
          sheet.getRow(row).height = t.heights[row - mapRow(17)];
        }
      }
    };
  }
  function fitCaptions(sheet, template, slots, map, captions) {
    const bands = new Map();
    TILES[slots].forEach(([first, last, left, right, start, end], i) => {
      const key = `${start}:${end}`, need = textHeight(sheet, captions[i], map(start), left, right) + 4;
      if (!bands.has(key)) bands.set(key, { first, last, start, end, need });
      else bands.get(key).need = Math.max(bands.get(key).need, need);
    });
    for (const { first, last, start, end, need } of bands.values()) {
      const captionHeight = blockHeight(sheet, map(start), map(end));
      if (need <= captionHeight) continue;
      const donors = [];
      for (let row = map(first); row <= map(last); row++) {
        // Never reclaim check-text/photo space or another caption band.
        if (row >= map(23) && row <= map(29) || row >= map(31) && row <= map(35)) continue;
        let minimum = 24;
        for (let col = 1; col <= 6; col++) {
          const cell = sheet.getCell(row, col);
          if (cell.master.address !== cell.address || cell.value == null) continue;
          let right = col;
          for (const merge of sheet.model.merges || []) {
            const match = /^([A-F])(\d+):([A-F])(\d+)$/u.exec(merge);
            if (match && match[1].charCodeAt(0) - 64 === col && Number(match[2]) === row && match[2] === match[4]) right = match[3].charCodeAt(0) - 64;
          }
          const tableRow = row >= map(7) && row <= map(14) || row >= map(16) && row <= map(21);
          minimum = Math.max(minimum, textHeight(sheet, cell.text, row, col, right, tableRow));
        }
        const spare = Math.max(0, rowHeight(sheet, row) - minimum);
        if (spare) donors.push({ row, spare });
      }
      const available = donors.reduce((sum, donor) => sum + donor.spare, 0);
      // Captions can borrow image space, but images keep at least 80% of the source height.
      const photoBudget = Math.max(0, blockHeight(sheet, map(first), map(last)) - blockHeight(template, first, last) * 0.8);
      const extra = Math.min(need - captionHeight, available, photoBudget);
      if (!extra) continue;
      for (const { row, spare } of donors) sheet.getRow(row).height -= extra * spare / available;
      for (let row = map(start); row <= map(end); row++) sheet.getRow(row).height += extra / (map(end) - map(start) + 1);
    }
  }

  // The customer's cover has a different revision-history/footer height in each language.
  const documentName = `${options.projectName} ${options.sopName}`;
  cover.getCell("A4").value = documentName;
  cover.getCell("G4").value = options.documentNo;
  cover.getCell("E4").value = 1;
  const now = new Date(), today = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000) + 25569;
  formula(cover, "B7", "TODAY()", today);
  formula(cover, "F4", 'IF(B7="","",B7)', today);
  for (const cell of ["B7", "F4"]) cover.getCell(cell).numFmt = "yyyy/m/d";
  // First record describes this generation even when no original version was supplied.
  cover.getCell("C7").value = options.author || null;
  cover.getCell("C7").style = { ...cover.getCell("C7").style, alignment: { ...cover.getCell("C7").alignment, wrapText: true } };
  for (let row = 8; row < names.authorRow; row++) formula(cover, `C${row}`, `IF(A${row}="","","${literal(options.author || "")}")`, "");
  const nameHeight = Math.ceil(textHeight(cover, documentName, 4, 1, 2) + 4);
  const revisionHeight = Math.ceil(Math.max(textHeight(cover, options.author, 7, 3, 3),
    textHeight(cover, options.revisionReason, 7, 4, 5), textHeight(cover, options.revisionContent, 7, 6, 8)) + 4);
  const blankRows = [];
  for (let row = 8; row < names.authorRow; row++) {
    // C is our conditional author formula; ExcelJS may omit an empty-string cached result.
    const blank = [1, 2, 4, 5, 6, 7, 8, 9].map(col => cover.getCell(row, col).value).every(value => value == null || value === "" || typeof value === "object" && value.result === "");
    if (blank) blankRows.push({ row, spare: Math.max(0, rowHeight(cover, row) - 24) });
  }
  let available = blankRows.reduce((sum, item) => sum + item.spare, 0);
  function growCoverRow(row, needed) {
    const extra = Math.max(0, Math.min(needed - rowHeight(cover, row), available, 400 - rowHeight(cover, row)));
    if (!extra) return;
    cover.getRow(row).height += extra;
    for (const item of blankRows) {
      const borrowed = extra * item.spare / available;
      cover.getRow(item.row).height -= borrowed;
      item.spare -= borrowed;
    }
    available = Math.max(0, available - extra);
  }
  // Name and revision rows share the same blank-space budget; never shrink fonts.
  growCoverRow(4, nameHeight);
  growCoverRow(7, revisionHeight);
  writeText(cover, documentName, [4, 4, 1, 2], documentName, chinese ? "文件名称" : "Document name", true);
  const revisionTitle = `${options.projectName} ${options.sopName}`;
  writeText(cover, options.revisionReason, [7, 7, 4, 5], revisionTitle, chinese ? "修订原因" : "Revision reason", true);
  writeText(cover, options.revisionContent, [7, 7, 6, 8], revisionTitle, chinese ? "修订内容" : "Revision content", true);
  cover.getCell(`A${names.authorRow}`).value = `${labels.author}${options.author || ""}`;
  paper(cover, `A1:I${names.authorRow}`, "portrait"); h.setSheetZoom(cover, 100);

  const chartExtra = Math.max(0, processes.length - 20), chartFooter = 27 + chartExtra;
  if (chartExtra) chart.spliceRows(27, 0, ...Array.from({ length: chartExtra }, () => []));
  chart.getCell("C2").value = options.projectName;
  for (const [target, source, cached] of [["C3", "F4", today], ["C4", "G4", options.documentNo], ["C5", "C4", undefined]]) formula(chart, target, `IF(${coverRef}!${source}="","",${coverRef}!${source})`, cached);
  chart.getCell("C3").numFmt = "yyyy/m/d";
  const chartEnd = 6 + processes.length;
  for (let row = 7; row < chartFooter; row++) {
    const active = row <= chartEnd; chart.getRow(row).hidden = !active;
    if (row > 26) for (let col = 1; col <= 6; col++) chart.getCell(row, col).style = JSON.parse(JSON.stringify(chart.getCell(26, col).style));
    for (let col = 1; col <= 6; col++) chart.getCell(row, col).value = null;
    if (!active) continue;
    const item = processes[row - 7], toolsFile = h.assemblyPath(item.folder, "Tools.jsonl");
    const toolsText = (toolsFile ? h.loadJsonl(toolsFile) : []).map(record => [record.name || "",
      record.qty != null && record.qty !== "" ? `x${record.qty}` : "",
      record.specs && String(record.specs).toUpperCase() !== "NA" ? `(${record.specs})` : ""].filter(Boolean).join(" ")).join("\n");
    chart.getRow(row).values = [`OP${String(row - 6).padStart(3, "0")}`, row - 6, null, item.metadataName, toolsText || null, 30];
    chart.getRow(row).height = Math.max(30, textHeight(chart, toolsText, row, 5, 5), textHeight(chart, item.metadataName, row, 4, 4));
    chart.getRow(row).eachCell(cell => { cell.alignment = { ...cell.alignment, vertical: "middle", wrapText: true }; });
  }
  formula(chart, "F3", `SUM(F7:F${chartEnd})`, processes.length * 30);
  formula(chart, "F4", `IF(MAX(F7:F${chartEnd})<=0,"",3600/MAX(F7:F${chartEnd}))`, 120);
  formula(chart, "F5", `COUNTA(B7:B${chartEnd})`, processes.length);
  chart.mergeCells(`A${chartFooter}:C${chartFooter}`); chart.mergeCells(`D${chartFooter}:F${chartFooter}`);
  chart.getCell(`A${chartFooter}`).value = `${labels.author}${options.author || ""}`;
  chart.getRow(chartFooter).height = Math.max(30, textHeight(chart, chart.getCell(`A${chartFooter}`).value, chartFooter, 1, 3));
  chart.getCell(`A${chartFooter}`).alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  for (let row = 1; row <= chartFooter; row++) for (let col = 1; col <= 6; col++) {
    const cell = chart.getCell(row, col);
    if (cell.master.address === cell.address) styleChartCell(cell);
    else cell.style = cell.master.style;
  }
  chart.pageSetup.printTitlesRow = "1:6";
  paper(chart, `A1:F${chartFooter}`, "portrait"); chart.pageSetup.fitToHeight = 0; h.setSheetZoom(chart, 100);

  for (const [processIndex, process] of processes.entries()) {
    const { folder, metadataName, sheetName } = process;
    const bomFile = h.assemblyPath(folder, "Bill_of_Materials.jsonl"), toolsFile = h.assemblyPath(folder, "Tools.jsonl");
    const bom = bomFile ? h.loadJsonl(bomFile) : [], tools = toolsFile ? h.loadJsonl(toolsFile) : [];
    h.validateAssemblyBom(bom, bomFile || "Bill_of_Materials.jsonl");
    const photos = h.resolveInstructionPhotos(folder, { directoryName: "Operation_Photos", legacyFile: null, caseInsensitive: true, warnings });
    const operation = textFile(folder, "Operation_Instruction.txt"), paragraphs = instructionParagraphs(operation);
    if (!operation) warnings.push(`${metadataName}: Operation_Instruction.txt is missing or empty; generated an empty-content page.`);
    if (!photos.length) warnings.push(`${metadataName}: ${chinese ? "无操作图片，使用1格模板保留操作说明。" : "No operation photos; used the 1-cell template and retained the instructions."}`);
    else if (paragraphs.length !== photos.length) warnings.push(`${metadataName}: ${chinese ? `图文数量不一致：${photos.length}张图、${paragraphs.length}段说明，按顺序对应；缺少说明的格子留空，多余说明单独保留。` : `Photo/instruction count mismatch: ${photos.length} photos, ${paragraphs.length} paragraphs; paired in order, missing captions left blank and excess instructions retained separately.`}`);
    if (photos.length > 4) warnings.push(`${metadataName}: ${chinese ? "操作图片超过4张，按原顺序每页最多4张保留在续页。" : "More than 4 operation photos; retained in order on additional pages of at most 4 photos."}`);
    if (photos.length && paragraphs.length > photos.length) textRequests.push({ name: freshName(labels.continuation), processName: metadataName, label: labels.unmatched, text: paragraphs.slice(photos.length).join("\n\n") });
    const groups = Math.max(1, Math.ceil(photos.length / 4));
    for (let group = 0; group < groups; group++) {
      const selected = photos.slice(group * 4, group * 4 + 4), slots = selected.length <= 1 ? 1 : selected.length === 2 ? 2 : 4;
      const template = templateSheets[slots === 1 ? 0 : slots === 2 ? 1 : 2], layout = layoutFor(template, bom, tools, slots), map = layout.mapRow;
      const sheet = h.cloneWorksheet(workbook, template, group ? freshName(sheetName) : sheetName, layout); layout.compact(sheet);
      h.fillAssemblyTable(sheet, bom, 8, layout.b.rows, record => ({ index: record.index, name: record.partno, qty: record.qty, spec: record.spec }));
      h.fillAssemblyTable(sheet, tools, map(17), layout.t.rows, record => ({ index: record.index, name: record.name, qty: record.qty, spec: record.specs }));
      // Only a prefix is placed inline; tables that exceed readable row heights go to continuation sheets.
      for (let i = layout.b.inline; i < layout.b.rows; i++) for (const col of [1, 2, 4, 5]) sheet.getCell(8 + i, col).value = null;
      for (let i = layout.t.inline; i < layout.t.rows; i++) for (const col of [1, 2, 4, 5]) sheet.getCell(map(17) + i, col).value = null;
      if (!group) for (const [kind, records, plan, file] of [["bom", bom, layout.b, "Bill_of_Materials.jsonl"], ["tools", tools, layout.t, "Tools.jsonl"]]) {
        if (records.length > plan.inline) tables.push({ processName: metadataName, kind, file, inlineCount: plan.inline, records: records.slice(plan.inline) });
      }
      formula(sheet, "E3", `${chartRef}!D${7 + processIndex}`, metadataName);
      for (const [cell, source, label, cached] of [["A3", "G4", chinese ? "文件编号：" : "Doc No.: ", options.documentNo], ["A4", "C4", chinese ? "版本号：" : "Version: ", ""]]) formula(sheet, cell, `"${label}"&${coverRef}!${source}`, label + cached);
      formula(sheet, "A5", `"${chinese ? "产品名：" : "Product: "}"&${chartRef}!C2`, `${chinese ? "产品名：" : "Product: "}${options.projectName}`);
      formula(sheet, "S3", `"${chinese ? "标准工时：" : "Std. Time: "}"&${chartRef}!F${7 + processIndex}&"${chinese ? " 秒" : " s"}"`, chinese ? "标准工时：30 秒" : "Std. Time: 30 s");
      sheet.getCell("S4").value = chinese ? "标准人力：1" : "Std. Operator: 1";
      formula(sheet, "S5", `"${chinese ? "日期：" : "Effective Date: "}"&TEXT(${coverRef}!F4,"yyyy/m/d")`, `${chinese ? "日期：" : "Effective Date: "}${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`);
      sheet.getCell(`A${map(36)}`).value = `${labels.author}${options.author || ""}`;
      const captions = TILES[slots].map((_, i) => photos.length ? (selected[i] ? paragraphs[group * 4 + i] || "" : "") : operation);
      fitCaptions(sheet, template, slots, map, captions);
      TILES[slots].forEach(([first, last, left, right, captionFirst, captionLast], i) => {
        if (selected[i]) h.embedSingleAssemblyPhoto(workbook, sheet, selected[i].filePath, { rowStart: map(first), rowEnd: map(last), colStart: left, colEnd: right });
        writeText(sheet, captions[i], [map(captionFirst), map(captionLast), left, right], metadataName, `${labels.operation} ${group * 4 + i + 1}`);
      });
      const previousPhoto = h.assemblyPath(folder, "previous_station_check_photo.png");
      if (previousPhoto) {
        const border = { ...sheet.getCell(map(23), 1).border };
        sheet.unMergeCells(`A${map(23)}:F${map(29)}`);
        sheet.mergeCells(`A${map(23)}:F${map(26)}`); sheet.mergeCells(`A${map(27)}:F${map(29)}`);
        for (let row = map(23); row <= map(29); row++) for (let col = 1; col <= 6; col++) {
          const cell = sheet.getCell(row, col), edges = {};
          if (row === map(23) && border.top) edges.top = border.top;
          if (row === map(29) && border.bottom) edges.bottom = border.bottom;
          if (col === 1 && border.left) edges.left = border.left;
          if (col === 6 && border.right) edges.right = border.right;
          cell.style = { ...cell.style, border: edges };
        }
        h.embedSingleAssemblyPhoto(workbook, sheet, previousPhoto, { rowStart: map(27), rowEnd: map(29), colStart: 1, colEnd: 6 });
      }
      // Splitting the check-text/photo merge creates new cell styles.
      styleRange(sheet, map(23), map(29), 1, 6, { name: "黑体", size: 16, color: { argb: "FFFF0000" }, underline: true });
      writeText(sheet, textFile(folder, "Previous_Station_Check.txt"), [map(23), map(previousPhoto ? 26 : 29), 1, 6], metadataName, labels.previous);
      writeText(sheet, textFile(folder, "Self_Check.txt"), [map(31), map(35), 1, 6], metadataName, labels.self);
      paper(sheet, `A1:V${map(36)}`); h.setSheetZoom(sheet, 80); pages.push({ sheet, footer: `U${map(36)}` });
    }
  }

  // Append printable, bounded text pages; a long paragraph is split without deleting characters.
  for (const request of textRequests) {
    let remaining = request.text, part = 0;
    while (remaining) {
      const name = part++ ? freshName(labels.continuation) : request.name, sheet = workbook.addWorksheet(name);
      for (let col = 1; col <= 6; col++) sheet.getColumn(col).width = 14;
      for (const row of [1, 2, 3, 4, 5, 6]) { sheet.mergeCells(`A${row}:F${row}`); sheet.getRow(row).height = row === 5 ? 660 : 24; }
      sheet.getCell("A1").value = request.processName; sheet.getCell("A2").value = request.label;
      sheet.getCell("A3").value = `${labels.author}${options.author || ""}`;
      for (const row of [1, 2, 3, 5, 6]) {
        sheet.getCell(`A${row}`).font = row === 5 && request.font ? { ...request.font } : { name: "Arial", size: 11, bold: row <= 2 };
        sheet.getCell(`A${row}`).alignment = { horizontal: "left", vertical: "top", wrapText: true };
      }
      const chars = Array.from(remaining); let low = 1, high = chars.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (textHeight(sheet, chars.slice(0, mid).join(""), 5, 1, 6) <= 650) low = mid; else high = mid - 1;
      }
      const chunk = chars.slice(0, low).join(""); sheet.getCell("A5").value = chunk; remaining = chars.slice(low).join("");
      paper(sheet, "A1:F6", "portrait"); h.setSheetZoom(sheet, 100); pages.push({ sheet, footer: "A6" });
    }
  }
  const beforeTables = workbook.worksheets.length;
  h.appendAssemblyTables(workbook, tables, pages.length, options.templateLanguage);
  for (const sheet of workbook.worksheets.slice(beforeTables)) pages.push({ sheet, footer: `A${sheet.rowCount}` });
  for (const table of tables) warnings.push(`${table.processName}: ${table.file}: ${chinese ? `原页${table.inlineCount}行，其余${table.records.length}行完整保存在` : `${table.inlineCount} rows inline; all ${table.records.length} remaining rows retained in`}「${table.sheetNames.join("、")}」。`);
  cover.getCell("D4").value = pages.length;
  formula(chart, "F2", `IF(${coverRef}!D4="","",${coverRef}!D4)`, pages.length);
  pages.forEach(({ sheet, footer }, index) => formula(sheet, footer, `"${labels.page}"&${index + 1}&"/"&${coverRef}!D4`, `${labels.page}${index + 1}/${pages.length}`));
  for (const sheet of sourceSheets) if (sheet !== cover && sheet !== chart) workbook.removeWorksheet(sheet.id);
  // Start with the chosen cover and chart; don't ship the other language or unused blank templates.
  return { warnings, pageCount: pages.length };
}

module.exports = { buildAssemblyWorkbook, instructionParagraphs };
