#!/usr/bin/env node
/** Fill SOP template xlsx from Process JSONL/text files and ordered instruction photos. */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

// Fixed layout from testing-sop-template-20260824-en.xlsx.
const DEFAULT_ROW_HEIGHT = 40;
const ROW_HEIGHT_LINE_FACTOR = 1.35;
const ROW_HEIGHT_PADDING = 8;
const CHAR_WIDTH_FACTOR = 0.75;
const MERGED_TEXT_WIDTH_FACTOR = 0.88;
const TEXT_HEIGHT_SAFETY_FACTOR = 1.05;
const DEFAULT_COL_WIDTH = 8.43;
const DEFAULT_ROW_HEIGHT_PX_FALLBACK = 15;
const BAND_BORDER_ROW_HEIGHT = 15;
const SPACER_ROW_HEIGHT = 15;
const BORDER_MEDIUM = { style: "medium" };
const BORDER_THIN = { style: "thin" };
const PX_TO_EMU = 9525;

const MATERIAL_HEADER_ROW = 7;
const MATERIAL_START_ROW = 8;
const MATERIAL_END_ROW = 16;
const TOOLS_HEADER_ROW = 18;
const TOOLS_START_ROW = 19;
const TOOLS_END_ROW = 27;
const BAND1_START_ROW = 5;
const BAND1_END_ROW = 55;
const BAND2_START_ROW = 57;
const BAND2_END_ROW = 107;
const BAND3_START_ROW = 109;
const BAND3_END_ROW = 159;
const LEFT_TABLE_COL_START = 1;
const LEFT_TABLE_COL_END = 4;
const STEPS_START_ROW = 7;
const STEPS_END_ROW = 16;
const STEPS_START_COL = 7;
const STEPS_END_COL = 21;
const NOTES_START_ROW = 29;
const NOTES_END_ROW = 36;
const NOTES_START_COL = 1;
const NOTES_END_COL = 6;
const PHOTO_START_ROW = 17;
const PHOTO_END_ROW = 36;
const PHOTO_START_COL = 7;
const PHOTO_END_COL = 21;
const ENV_START_ROW = 109;
const ENV_END_ROW = 159;
const ENV_START_COL = 1;
const ENV_END_COL = 4;
const TEXT_START_COL = 5;
const TEXT_END_COL = 12;

const TEMPLATE_SHEET_NAME = "TestTemplate";
const FACTORY_TEST_TEMPLATE_SHEET_NAME = "FactoryTestTemplate";
const ASSEMBLY_TEMPLATE_SHEET_NAME = "AssemblyTemplate";
const PRODUCTION_CHART_SHEET_NAME = "Production Arrange Chart";
const WORKSTATION_CHART_SHEET_NAME = "Workstation Layout Chart";
const TEMPLATE_LANGUAGE_ENGLISH = "English";
const TEMPLATE_LANGUAGE_CHINESE = "中文";
const TEMPLATE_FILE_BY_LANGUAGE = Object.freeze({
  [TEMPLATE_LANGUAGE_ENGLISH]: "urovo-sop-template.xlsx",
  [TEMPLATE_LANGUAGE_CHINESE]: "urovo-sop-template-zh.xlsx",
});
const WORKBOOK_LABELS = Object.freeze({
  [TEMPLATE_LANGUAGE_ENGLISH]: Object.freeze({
    title: "Standard Operating Procedure",
    author: "Author: ",
    page: "Page: ",
    product: "Product: ",
    standardTime: "Std. Time: ",
    seconds: " s",
  }),
  [TEMPLATE_LANGUAGE_CHINESE]: Object.freeze({
    title: "标准作业指导书",
    author: "编制人：",
    page: "页数：",
    product: "产品名：",
    standardTime: "标准工时：",
    seconds: " 秒",
  }),
});
const COVER_PROJECT_ROW = 4;
const COVER_PROJECT_COL = 1;
const COVER_DOCUMENT_ROW = 4;
const COVER_DOCUMENT_COL = 7;
const COVER_PAGE_COUNT_ROW = 4;
const COVER_PAGE_COUNT_COL = 4;
const PRC_PROJECT_ROW = 2;
const PRC_PROJECT_COL = 6;
const PRC_PAGE_COUNT_ROW = 2;
const PRC_PAGE_COUNT_COL = 8;
const PRC_START_ROW = 8;
const PRC_COL = 3;
const PRC_TOOLS_COL = 4;
const PRC_MAX_PROCESS_COUNT = 30;
const PRC_WORK_TIME_SECONDS = 40;
const WORKSTATION_START_ROW = 7;
const WORKSTATION_TEMPLATE_END_ROW = 16;
const WORKSTATION_DEFAULT_CYCLE_SECONDS = 30;
const WORKSTATION_TOOLS_LINE_FACTOR = 1.2;
const WORKSTATION_TOOLS_PADDING = 4;
const SHEET_NAME_MAX_LEN = 31;
const SHEET_NAME_INVALID_CHARS = new Set(["\\", "/", "[", "]", ":", "*", "?"]);
const COVER_PRC_ZOOM = 100;
const PROCESS_SHEET_ZOOM = 80;
const PHOTO_SCALE_FACTOR = 0.96;
const PHOTO_TILE_MARGIN_PX = 3;
const PHOTO_DIRECTORY = "photos";
const LEGACY_PHOTO_FILE = "instruction_photos.png";
const MAX_PHOTO_COUNT = 12;
const METADATA_FILES = ["metadata.txt", "metadata"];
const PHOTO_NAME_PATTERN = /^p(\d+)(?:-(.+))?\.(?:png|jpe?g)$/iu;
const ASSEMBLY_FILES = Object.freeze({
  material: "Bill_of_Materials.jsonl",
  tools: "Tools.jsonl",
  operation: "Operation_Instruction.txt",
  photos: "Operation_Photos",
  previousStationCheck: "Previous_Station_Check.txt",
  previousStationCheckPhoto: "previous_station_check_photo.png",
  selfCheck: "Self_Check.txt",
});
const ASSEMBLY_TABLE_BASE_ROWS = 5;
// Template uses built-in numFmtId 58 (locale date); explicit string for ExcelJS round-trip.
const DATE_NUMFMT = "yyyy/m/d";
const COVER_DATE_CELLS = ["B7", "F4"];
const PRC_DATE_CELL = "F3";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    const name = key.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    args[name] = value;
    i += 1;
  }

  if (!args.output) {
    throw new Error(
      "Usage: node fill_sop_sheet.js [--template <xlsx>] --output <xlsx> " +
        "[--data-dir <dir> | --project-dir <dir> --project-name <name> --document-no <no> --sop-name <name> [--author <name>] --process-list <json> [--process-fallback-dir <dir>]]"
    );
  }

  return {
    template: args.template || (args["sop-type"] === "assemble" ? undefined : path.resolve(__dirname, "urovo-sop-template.xlsx")),
    dataDir: args["data-dir"],
    projectDir: args["project-dir"],
    projectName: args["project-name"],
    documentNo: args["document-no"],
    sopName: args["sop-name"],
    author: args.author,
    revisionReason: args["revision-reason"],
    revisionContent: args["revision-content"],
    templateLanguage: args["template-language"] || TEMPLATE_LANGUAGE_ENGLISH,
    processList: args["process-list"],
    processFallbackDir: args["process-fallback-dir"],
    assetsDir: args["assets-dir"],
    output: args.output,
    sheet: args.sheet || TEMPLATE_SHEET_NAME,
    sopType: args["sop-type"] || "assembly_test",
  };
}

function parseProcessList(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid --process-list JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("--process-list must be a non-empty JSON array");
  }
  for (const item of parsed) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("--process-list must contain non-empty strings");
    }
  }
  return parsed;
}

function normalizedFileName(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function resolveCaseInsensitiveEntry(directory, canonicalName, expectedKind = "file") {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return null;
  const expected = normalizedFileName(canonicalName);
  const matches = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name !== ".DS_Store" && normalizedFileName(entry.name) === expected);
  if (matches.length > 1) {
    throw new Error(`${directory} contains ambiguous case-insensitive matches for ${canonicalName}: ${matches.map((entry) => entry.name).join(", ")}`);
  }
  const entry = matches[0];
  if (!entry) return null;
  if (entry.isSymbolicLink()) throw new Error(`Process content cannot contain symlinks: ${path.join(directory, entry.name)}`);
  const valid = expectedKind === "directory" ? entry.isDirectory() : entry.isFile();
  if (!valid) throw new Error(`${path.join(directory, entry.name)} must be a ${expectedKind}.`);
  return { name: entry.name, path: path.join(directory, entry.name) };
}

function readMetadata(folder, caseInsensitive = false) {
  const metadataPath = METADATA_FILES.map((fileName) => caseInsensitive
    ? resolveCaseInsensitiveEntry(folder, fileName)?.path
    : path.join(folder, fileName))
    .find((candidate) => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!metadataPath) {
    throw new Error(`Missing metadata file: expected ${METADATA_FILES.join(" or ")} in ${folder}`);
  }
  const content = fs.readFileSync(metadataPath, "utf8").trim();
  if (!content) {
    throw new Error(`Empty metadata file: ${metadataPath}`);
  }
  return content;
}

function validateProcessFolder(projectDir, folderName, processFallbackDir = null) {
  const candidates = [path.join(projectDir, folderName)];
  if (processFallbackDir) {
    candidates.push(path.join(processFallbackDir, folderName));
  }
  for (const folder of candidates) {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      continue;
    }
    const entries = fs.readdirSync(folder).filter((name) => name !== ".DS_Store");
    if (entries.length > 0) {
      return folder;
    }
  }
  throw new Error(
    `Process folder not found or empty: ${folderName} (tried: ${candidates.join(", ")})`
  );
}

function sanitizeSheetName(name) {
  const cleaned = [...name].filter((ch) => !SHEET_NAME_INVALID_CHARS.has(ch)).join("").trim();
  if (!cleaned) {
    throw new Error(`Invalid sheet name after sanitization: ${JSON.stringify(name)}`);
  }
  if (cleaned.length <= SHEET_NAME_MAX_LEN) return cleaned;
  // Keep a trailing step number visible when a translated process title exceeds Excel's limit.
  const numberedSuffix = cleaned.match(/\s*\d+$/u)?.[0];
  if (numberedSuffix && numberedSuffix.length < SHEET_NAME_MAX_LEN) {
    return `${cleaned.slice(0, SHEET_NAME_MAX_LEN - numberedSuffix.length).trimEnd()}${numberedSuffix}`;
  }
  return cleaned.slice(0, SHEET_NAME_MAX_LEN);
}

function sheetNameKey(name) {
  return String(name).toLocaleLowerCase("en-US");
}

function uniqueSheetName(name, seenSheetNames) {
  const baseName = sanitizeSheetName(name);
  if (!seenSheetNames.has(sheetNameKey(baseName))) return baseName;

  for (let index = 2; ; index += 1) {
    const suffix = ` (${index})`;
    const candidate = `${baseName.slice(0, SHEET_NAME_MAX_LEN - suffix.length).trimEnd()}${suffix}`;
    if (!seenSheetNames.has(sheetNameKey(candidate))) return candidate;
  }
}

function resolveProcesses(projectDir, processList, processFallbackDir = null, requireUniqueSheetNames = true, sopType = "assembly_test", reservedNames = []) {
  if (processList.length > PRC_MAX_PROCESS_COUNT) {
    throw new Error(
      `Too many processes (${processList.length}); ${PRODUCTION_CHART_SHEET_NAME} supports ${PRC_MAX_PROCESS_COUNT}`
    );
  }

  const reserved = new Set(reservedNames.map(sheetNameKey));
  const seenSheetNames = new Set(reserved);
  const processNames = new Set();
  return processList.map((folderName) => {
    const folder = validateProcessFolder(projectDir, folderName, processFallbackDir);
    const metadataName = readMetadata(folder, sopType === "assemble");
    let sheetName = sanitizeSheetName(metadataName);
    if (requireUniqueSheetNames && seenSheetNames.has(sheetNameKey(sheetName))) {
      if (processNames.has(sheetNameKey(sheetName)) && sopType !== "assemble") {
        throw new Error(`Duplicate sheet name: ${sheetName}`);
      }
      sheetName = uniqueSheetName(metadataName, seenSheetNames);
    }
    if (requireUniqueSheetNames) { processNames.add(sheetNameKey(sanitizeSheetName(metadataName))); seenSheetNames.add(sheetNameKey(sheetName)); }
    return { folder, metadataName, sheetName };
  });
}

function authorName(author) {
  return String(author || "").trim().replace(/^(?:Author\s*:|编制人\s*[：:])\s*/iu, "");
}

function normalizeTemplateLanguage(value) {
  const language = typeof value === "string" && value.trim()
    ? value.trim()
    : TEMPLATE_LANGUAGE_ENGLISH;
  if (!Object.hasOwn(TEMPLATE_FILE_BY_LANGUAGE, language)) {
    throw new Error(`Unsupported template language: ${language}`);
  }
  return language;
}

function workbookLabels(templateLanguage) {
  return WORKBOOK_LABELS[normalizeTemplateLanguage(templateLanguage)];
}

const CHINESE_SHEET_NAMES = Object.freeze({
  Cover: "封面",
  [PRODUCTION_CHART_SHEET_NAME]: "生产安排表",
  [WORKSTATION_CHART_SHEET_NAME]: "工站安排表",
});

/** Rename at the end, when all template lookups and generated links are complete. */
function localizeWorkbookSheetNames(workbook, templateLanguage) {
  if (templateLanguage !== TEMPLATE_LANGUAGE_CHINESE) return;
  const names = Object.entries(CHINESE_SHEET_NAMES).filter(([name]) => workbook.getWorksheet(name));
  for (const [before, after] of names) workbook.getWorksheet(before).name = after;
  const replaceReferences = (expression) => {
    for (const [before, after] of names) {
      expression = expression.split(`'${before}'!`).join(`'${after}'!`);
      // Only Cover has an unquoted identifier in the generated formulas.
      if (before === "Cover") expression = expression.replace(/(^|[^\p{L}\p{N}_.'\]])Cover!/gu, `$1'${after}'!`);
    }
    return expression;
  };
  for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
    if (cell.type === ExcelJS.ValueType.Merge || !cell.value || typeof cell.value !== "object" || !cell.value.formula) return;
    // Excel string literals (including escaped quotes) may contain user text; never rewrite those.
    const formula = cell.value.formula.split(/("(?:[^"]|"")*")/gu)
      .map((part, index) => index % 2 ? part : replaceReferences(part)).join("");
    if (formula !== cell.value.formula) cell.value = { ...cell.value, formula };
  }));
}

function authorLine(author, templateLanguage = TEMPLATE_LANGUAGE_ENGLISH) {
  const name = authorName(author);
  return name ? `${workbookLabels(templateLanguage).author}${name}` : "";
}

function fillAuthor(worksheet, cellRef, author, templateLanguage = TEMPLATE_LANGUAGE_ENGLISH) {
  const value = authorLine(author, templateLanguage);
  if (value) worksheet.getCell(cellRef).value = value;
}

function fillCover(worksheet, projectName, documentNo, sopName, author, pageCount, templateLanguage = TEMPLATE_LANGUAGE_ENGLISH) {
  worksheet.getCell(COVER_PROJECT_ROW, COVER_PROJECT_COL).value = `${projectName} ${sopName}`;
  worksheet.getCell(COVER_DOCUMENT_ROW, COVER_DOCUMENT_COL).value = documentNo;
  worksheet.getCell(COVER_PAGE_COUNT_ROW, COVER_PAGE_COUNT_COL).value = pageCount;
  fillAuthor(worksheet, "A17", author, templateLanguage);
  const name = authorName(author);
  const formulaAuthor = name.replace(/"/gu, '""');
  for (let row = 7; row <= 16; row += 1) {
    const version = worksheet.getCell(`A${row}`).value;
    const resolvedVersion = version && typeof version === "object" && "result" in version
      ? version.result
      : version;
    worksheet.getCell(`C${row}`).value = {
      formula: `IF(A${row}="","","${formulaAuthor}")`,
      result: resolvedVersion === null || resolvedVersion === undefined || String(resolvedVersion).trim() === ""
        ? ""
        : name
    };
  }
  applyDateNumFmt(worksheet, COVER_DATE_CELLS);
  worksheet.pageSetup.printArea = "A1:I17";
  worksheet.pageSetup.fitToPage = true;
  worksheet.pageSetup.fitToWidth = 1;
  worksheet.pageSetup.fitToHeight = 1;
  delete worksheet.pageSetup.scale;
}

function applyDateNumFmt(worksheet, cellRefs) {
  for (const ref of cellRefs) {
    worksheet.getCell(ref).numFmt = DATE_NUMFMT;
  }
}

function formatToolsAsText(records) {
  return records
    .map((record) => {
      const indexStr = String(record.index ?? "").trim();
      const name = record.name || "";
      const specs = record.specs || "";
      const qty = record.qty;

      const parts = [name];
      if (specs && String(specs).toUpperCase() !== "NA") {
        parts.push(`(${specs})`);
      }
      if (qty != null && qty !== "") {
        parts.push(`x${qty}`);
      }

      const line = parts.join(" ");
      if (!indexStr) {
        return line;
      }
      const separator = indexStr.includes(".") ? " " : ". ";
      return `${indexStr}${separator}${line}`;
    })
    .join("\n");
}

function assemblyPath(folder, canonicalName, expectedKind = "file") {
  return resolveCaseInsensitiveEntry(folder, canonicalName, expectedKind)?.path || null;
}

function loadToolsText(folder, sopType = "assembly_test") {
  const toolsPath = sopType === "assemble"
    ? assemblyPath(folder, ASSEMBLY_FILES.tools)
    : path.join(folder, "tools_fixtures_equipment.jsonl");
  return formatToolsAsText(toolsPath ? loadJsonl(toolsPath) : []);
}

function prepareProductionChartRows(worksheet, processCount) {
  if (!Number.isInteger(processCount) || processCount < 1 || processCount > PRC_MAX_PROCESS_COUNT) {
    throw new Error(`${PRODUCTION_CHART_SHEET_NAME} requires 1 to ${PRC_MAX_PROCESS_COUNT} Processes.`);
  }
  if (
    worksheet.getCell(`B${PRC_START_ROW}`).master.address !== `A${PRC_START_ROW}`
    || worksheet.getCell(`F${PRC_START_ROW}`).master.address !== `E${PRC_START_ROW}`
  ) {
    throw new Error(`${PRODUCTION_CHART_SHEET_NAME} row ${PRC_START_ROW} must merge A:B and E:F.`);
  }

  const prototypeRow = worksheet.getRow(PRC_START_ROW);
  const prototypeHeight = prototypeRow.height;
  const prototypeStyles = Array.from({ length: 8 }, (_, offset) =>
    cloneCellStyle(worksheet.getCell(PRC_START_ROW, offset + 1))
  );
  if (worksheet.getCell(`H${PRC_START_ROW}`).isMerged) {
    worksheet.unMergeCells(`H${PRC_START_ROW}`);
  }

  for (let offset = 0; offset < processCount; offset += 1) {
    const rowNumber = PRC_START_ROW + offset;
    const row = worksheet.getRow(rowNumber);
    row.hidden = false;
    if (prototypeHeight) row.height = prototypeHeight;
    if (rowNumber !== PRC_START_ROW) {
      if (!worksheet.getCell(rowNumber, 1).isMerged) worksheet.mergeCells(`A${rowNumber}:B${rowNumber}`);
      if (!worksheet.getCell(rowNumber, 5).isMerged) worksheet.mergeCells(`E${rowNumber}:F${rowNumber}`);
      for (let column = 1; column <= 8; column += 1) {
        const style = prototypeStyles[column - 1];
        if (style) worksheet.getCell(rowNumber, column).style = JSON.parse(JSON.stringify(style));
      }
    }
    for (const column of [1, 3, 4, 5, 7]) worksheet.getCell(rowNumber, column).value = null;
  }

  const endRow = PRC_START_ROW + processCount - 1;
  worksheet.getCell(PRC_START_ROW, 8).value = null;
  if (processCount > 1) worksheet.mergeCells(`H${PRC_START_ROW}:H${endRow}`);
  return endRow;
}

function fillProductionArrangeChart(
  worksheet,
  projectName,
  processEntries,
  pageCount = processEntries.length,
  templateLanguage = TEMPLATE_LANGUAGE_ENGLISH
) {
  const endRow = prepareProductionChartRows(worksheet, processEntries.length);
  const labels = workbookLabels(templateLanguage);
  worksheet.getCell(PRC_PROJECT_ROW, PRC_PROJECT_COL).value = projectName;
  worksheet.getCell(PRC_PAGE_COUNT_ROW, PRC_PAGE_COUNT_COL).value = {
    formula: 'IF(Cover!D4="","",Cover!D4)',
    result: pageCount,
  };
  worksheet.getCell("H4").value = {
    formula: `SUM(G${PRC_START_ROW}:G${endRow})&"${labels.seconds}"`,
    result: `${processEntries.length * PRC_WORK_TIME_SECONDS}${labels.seconds}`,
  };
  processEntries.forEach(([name, toolsText], offset) => {
    const row = PRC_START_ROW + offset;
    worksheet.getCell(row, 1).value = {
      formula: `IF(C${row}="","",COUNTA($C$${PRC_START_ROW}:C${row}))`,
      result: offset + 1,
    };
    worksheet.getCell(row, PRC_COL).value = name;
    const toolsCell = worksheet.getCell(row, PRC_TOOLS_COL);
    toolsCell.value = toolsText || null;
    if (toolsText) {
      toolsCell.alignment = { ...(toolsCell.alignment || {}), wrapText: true };
      worksheet.getRow(row).height = Math.ceil(
        estimateTextHeight(worksheet, toolsText, row, PRC_TOOLS_COL, PRC_TOOLS_COL)
      );
    }
    worksheet.getCell(row, 7).value = PRC_WORK_TIME_SECONDS;
  });
  worksheet.pageSetup.printArea = `A1:H${endRow}`;
  worksheet.pageSetup.fitToWidth = 1;
  worksheet.pageSetup.fitToHeight = 0;
  applyDateNumFmt(worksheet, [PRC_DATE_CELL]);
}

function prepareWorkstationChartRows(worksheet, processCount) {
  if (!Number.isInteger(processCount) || processCount < 1 || processCount > PRC_MAX_PROCESS_COUNT) {
    throw new Error(`${WORKSTATION_CHART_SHEET_NAME} requires 1 to ${PRC_MAX_PROCESS_COUNT} Processes.`);
  }

  const firstStyles = Array.from({ length: 6 }, (_, offset) =>
    cloneCellStyle(worksheet.getCell(WORKSTATION_START_ROW, offset + 1))
  );
  const middleStyles = Array.from({ length: 6 }, (_, offset) =>
    cloneCellStyle(worksheet.getCell(WORKSTATION_START_ROW + 1, offset + 1))
  );
  const lastStyles = Array.from({ length: 6 }, (_, offset) =>
    cloneCellStyle(worksheet.getCell(WORKSTATION_TEMPLATE_END_ROW, offset + 1))
  );
  const baseRowHeight = worksheet.getRow(WORKSTATION_START_ROW).height
    || worksheet.properties.defaultRowHeight
    || DEFAULT_ROW_HEIGHT;
  const endRow = WORKSTATION_START_ROW + processCount - 1;
  const preparedEndRow = Math.max(WORKSTATION_TEMPLATE_END_ROW, endRow);

  for (let rowNumber = WORKSTATION_START_ROW; rowNumber <= preparedEndRow; rowNumber += 1) {
    const active = rowNumber <= endRow;
    const row = worksheet.getRow(rowNumber);
    row.hidden = !active;
    if (!active) {
      for (let column = 1; column <= 6; column += 1) worksheet.getCell(rowNumber, column).value = null;
      continue;
    }

    row.height = baseRowHeight;
    const styles = processCount === 1 || rowNumber === endRow
      ? lastStyles
      : rowNumber === WORKSTATION_START_ROW
        ? firstStyles
        : middleStyles;
    for (let column = 1; column <= 6; column += 1) {
      const cell = worksheet.getCell(rowNumber, column);
      cell.value = null;
      const style = styles[column - 1];
      if (style) cell.style = JSON.parse(JSON.stringify(style));
      // 模板数据行（R7/R8）的框线在样式克隆后会丢，这里逐边补齐，避免工序行看起来是白底无边。
      // 「编制人 / 审核人」在 R27，不在本循环范围内，保持原来的无框线。
      const border = cell.border || {};
      cell.border = {
        top: border.top && border.top.style ? border.top : BORDER_THIN,
        left: border.left && border.left.style ? border.left : BORDER_THIN,
        bottom: border.bottom && border.bottom.style ? border.bottom : BORDER_THIN,
        right: border.right && border.right.style ? border.right : BORDER_THIN,
      };
    }
  }

  return { endRow, baseRowHeight };
}

function cachedCellResult(cell) {
  const value = cell?.value;
  if (value && typeof value === "object") {
    if ("result" in value) return value.result;
    return undefined;
  }
  return value ?? undefined;
}

function formulaWithOptionalResult(formula, result) {
  return result === null || result === undefined ? { formula } : { formula, result };
}

function fillWorkstationLayoutChart(
  worksheet,
  coverSheet,
  projectName,
  documentNo,
  processEntries
) {
  const { endRow, baseRowHeight } = prepareWorkstationChartRows(worksheet, processEntries.length);
  worksheet.getCell("D2").value = projectName;
  worksheet.getCell("D3").value = formulaWithOptionalResult(
    'IF(Cover!F4="","",Cover!F4)',
    cachedCellResult(coverSheet.getCell("F4"))
  );
  worksheet.getCell("D4").value = {
    formula: 'IF(Cover!G4="","",Cover!G4)',
    result: documentNo,
  };
  worksheet.getCell("D5").value = formulaWithOptionalResult(
    'IF(Cover!C4="","",Cover!C4)',
    cachedCellResult(coverSheet.getCell("C4"))
  );
  worksheet.getCell("F2").value = {
    formula: 'IF(Cover!D4="","",Cover!D4)',
    result: processEntries.length,
  };
  worksheet.getCell("F3").value = {
    formula: `SUM(F${WORKSTATION_START_ROW}:F${endRow})`,
    result: processEntries.length * WORKSTATION_DEFAULT_CYCLE_SECONDS,
  };
  worksheet.getCell("F4").value = {
    formula: `IF(MAX(F${WORKSTATION_START_ROW}:F${endRow})<=0,"",3600/MAX(F${WORKSTATION_START_ROW}:F${endRow}))`,
    result: 3600 / WORKSTATION_DEFAULT_CYCLE_SECONDS,
  };
  worksheet.getCell("F5").value = {
    formula: `COUNTA(B${WORKSTATION_START_ROW}:B${endRow})`,
    result: processEntries.length,
  };

  processEntries.forEach(([processName, toolsText], offset) => {
    const rowNumber = WORKSTATION_START_ROW + offset;
    for (let column = 1; column <= 6; column += 1) {
      const cell = worksheet.getCell(rowNumber, column);
      cell.alignment = {
        ...(cell.alignment || {}),
        ...(column === 1 || column === 2 || column === 3 || column === 6
          ? { horizontal: "center" }
          : {}),
        vertical: "middle",
      };
    }
    worksheet.getCell(rowNumber, 1).value = `OP${String(offset + 1).padStart(3, "0")}`;
    worksheet.getCell(rowNumber, 2).value = offset + 1;
    worksheet.getCell(rowNumber, 3).value = null;
    const stationCell = worksheet.getCell(rowNumber, 4);
    stationCell.value = processName;
    stationCell.alignment = {
      ...(stationCell.alignment || {}),
      horizontal: "left",
      vertical: "middle",
    };
    const toolsCell = worksheet.getCell(rowNumber, 5);
    toolsCell.value = toolsText || null;
    if (toolsText) {
      toolsCell.alignment = {
        ...(toolsCell.alignment || {}),
        vertical: "middle",
        wrapText: true,
      };
      worksheet.getRow(rowNumber).height = estimateWorkstationToolsRowHeight(
        worksheet,
        toolsText,
        rowNumber,
        baseRowHeight
      );
    }
    worksheet.getCell(rowNumber, 6).value = WORKSTATION_DEFAULT_CYCLE_SECONDS;
  });

  worksheet.getCell("D3").numFmt = DATE_NUMFMT;
  worksheet.pageSetup.printArea = `A1:F${endRow}`;
  worksheet.pageSetup.fitToPage = true;
  worksheet.pageSetup.fitToWidth = 1;
  worksheet.pageSetup.fitToHeight = 0;
  delete worksheet.pageSetup.scale;
}

function setProcessSheetTitle(worksheet, templateLanguage) {
  worksheet.getCell("E1").value = workbookLabels(templateLanguage).title;
}

function linkProcessSheetToChart(
  worksheet,
  chartRow,
  pageNumber,
  pageCount,
  processName,
  author,
  templateLanguage = TEMPLATE_LANGUAGE_ENGLISH
) {
  const labels = workbookLabels(templateLanguage);
  worksheet.getCell("E3").value = {
    formula: `'${PRODUCTION_CHART_SHEET_NAME}'!C${chartRow}`,
    result: processName,
  };
  worksheet.getCell("R3").value = {
    formula: `"${labels.standardTime}"&'${PRODUCTION_CHART_SHEET_NAME}'!G${chartRow}&"${labels.seconds}"`,
    result: `${labels.standardTime}${PRC_WORK_TIME_SECONDS}${labels.seconds}`,
  };
  worksheet.getCell("A37").value = {
    formula: `"${labels.page}"&${pageNumber}&"/"&Cover!D4`,
    result: `${labels.page}${pageNumber}/${pageCount}`,
  };
  fillAuthor(worksheet, "A38", author, templateLanguage);
}

function linkAssemblyProcessSheetToWorkstation(
  worksheet,
  chartRow,
  pageNumber,
  pageCount,
  processName,
  author,
  projectName,
  templateLanguage = TEMPLATE_LANGUAGE_ENGLISH,
  mapRow = row => row
) {
  const labels = workbookLabels(templateLanguage);
  worksheet.getCell("E3").value = {
    formula: `'${WORKSTATION_CHART_SHEET_NAME}'!D${chartRow}`,
    result: processName,
  };
  worksheet.getCell("R3").value = {
    formula: `"${labels.standardTime}"&'${WORKSTATION_CHART_SHEET_NAME}'!F${chartRow}&"${labels.seconds}"`,
    result: `${labels.standardTime}${WORKSTATION_DEFAULT_CYCLE_SECONDS}${labels.seconds}`,
  };
  worksheet.getCell("A5").value = {
    formula: `"${labels.product}"&'${WORKSTATION_CHART_SHEET_NAME}'!D2`,
    result: `${labels.product}${projectName}`,
  };
  worksheet.getCell(`A${mapRow(37)}`).value = {
    formula: `"${labels.page}"&${pageNumber}&"/"&Cover!D4`,
    result: `${labels.page}${pageNumber}/${pageCount}`,
  };
  fillAuthor(worksheet, `A${mapRow(38)}`, author, templateLanguage);
}

function setSheetZoom(worksheet, zoom) {
  const base = worksheet.views?.[0] || {
    workbookViewId: 0,
    rightToLeft: false,
    state: "normal",
    showRuler: true,
    showRowColHeaders: true,
    showGridLines: true,
  };
  worksheet.views = [{ ...base, zoomScale: zoom, zoomScaleNormal: zoom }];
}

function cloneCellStyle(sourceCell) {
  if (!sourceCell.style || Object.keys(sourceCell.style).length === 0) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(sourceCell.style));
}

function copyCellValue(sourceCell, targetCell) {
  const value = sourceCell.value;
  if (value == null) {
    return;
  }
  if (typeof value === "object" && value.formula) {
    // WPS cell-image relationships are discarded by ExcelJS. Do not preserve
    // their DISPIMG formulas because the generated workbook would show #NAME?.
    // Ordinary drawing images from the template are copied separately.
    if (String(value.formula).includes("DISPIMG")) {
      return;
    }
    targetCell.value = { ...value };
    return;
  }
  targetCell.value = value;
}

function copyWorksheetImages(sourceSheet, targetSheet, mapRow = row => row) {
  for (const image of sourceSheet.getImages()) {
    const range = image.range;
    // Customer Assembly templates use one-cell anchors with a fixed extent.
    if (range?.tl && !range.br && range.ext) {
      targetSheet.addImage(image.imageId, {
        tl: {
          nativeCol: range.tl.nativeCol,
          nativeRow: mapRow(range.tl.nativeRow + 1) - 1,
          nativeColOff: range.tl.nativeColOff,
          nativeRowOff: range.tl.nativeRowOff,
        },
        ext: { ...range.ext },
        editAs: range.editAs,
      });
      continue;
    }
    if (!range?.tl || !range?.br) {
      continue;
    }
    targetSheet.addImage(image.imageId, {
      tl: {
        nativeCol: range.tl.nativeCol,
        nativeRow: mapRow(range.tl.nativeRow + 1) - 1,
        nativeColOff: range.tl.nativeColOff,
        nativeRowOff: range.tl.nativeRowOff,
      },
      br: {
        nativeCol: range.br.nativeCol,
        nativeRow: mapRow(range.br.nativeRow + 1) - 1,
        nativeColOff: range.br.nativeColOff,
        nativeRowOff: range.br.nativeRowOff,
      },
      editAs: range.editAs,
    });
  }
}

function cloneWorksheet(workbook, sourceSheet, newName, assemblyLayout = null) {
  const mapRow = assemblyLayout?.mapRow || (row => row);
  const targetRows = row => {
    const extra = row === (assemblyLayout?.bomEndRow ?? 12) ? assemblyLayout?.bomExtra
      : row === (assemblyLayout?.toolsEndRow ?? 19) ? assemblyLayout?.toolsExtra : 0;
    return Array.from({ length: 1 + (extra || 0) }, (_, index) => mapRow(row) + index);
  };
  const maxRow = sourceSheet.rowCount || 0;
  const maxCol = sourceSheet.columnCount || 0;
  const targetSheet = workbook.addWorksheet(newName, {
    properties: JSON.parse(JSON.stringify(sourceSheet.properties || {})),
    pageSetup: JSON.parse(JSON.stringify(sourceSheet.pageSetup || {})),
    views: JSON.parse(JSON.stringify(sourceSheet.views || [])),
    headerFooter: JSON.parse(JSON.stringify(sourceSheet.headerFooter || {})),
  });
  targetSheet.state = sourceSheet.state;
  if (sourceSheet.autoFilter) {
    targetSheet.autoFilter = JSON.parse(JSON.stringify(sourceSheet.autoFilter));
  }

  for (let col = 1; col <= maxCol; col += 1) {
    const sourceColumn = sourceSheet.getColumn(col);
    const targetColumn = targetSheet.getColumn(col);
    const width = sourceColumn.width;
    if (width) {
      targetColumn.width = width;
    }
    if (sourceColumn.style && Object.keys(sourceColumn.style).length > 0) {
      targetColumn.style = JSON.parse(JSON.stringify(sourceColumn.style));
    }
    targetColumn.hidden = sourceColumn.hidden;
    targetColumn.outlineLevel = sourceColumn.outlineLevel;
  }

  // Apply merges before copying styles so band-end borders on merged edges survive.
  for (const merge of sourceSheet.model.merges || []) {
    const clean = merge.replace(/\$/g, "");
    if (!assemblyLayout) { targetSheet.mergeCells(clean); continue; }
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/u.exec(clean);
    if (!match) throw new Error(`Unsupported template merge: ${merge}`);
    const [, left, first, right, last] = match;
    targetSheet.mergeCells(`${left}${mapRow(Number(first))}:${right}${mapRow(Number(last))}`);
    if (first === last) for (const extraRow of targetRows(Number(first)).slice(1)) targetSheet.mergeCells(`${left}${extraRow}:${right}${extraRow}`);
  }

  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const sourceRow = sourceSheet.getRow(rowNumber);
    for (const targetRowNumber of targetRows(rowNumber)) {
      const targetRow = targetSheet.getRow(targetRowNumber);
      if (sourceRow.height) targetRow.height = sourceRow.height;
      targetRow.hidden = sourceRow.hidden;
      for (let colNumber = 1; colNumber <= maxCol; colNumber += 1) {
        const sourceCell = sourceRow.getCell(colNumber);
        const targetCell = targetRow.getCell(colNumber);
        copyCellValue(sourceCell, targetCell);
        const style = cloneCellStyle(sourceCell);
        if (style) targetCell.style = style;
      }
    }
  }

  // Reuse the embedded image resources and their template-relative anchors.
  // This keeps the two header drawings owned by TestTemplate, without loading
  // environment or logo files from outside the workbook.
  copyWorksheetImages(sourceSheet, targetSheet, mapRow);

  return targetSheet;
}

function removeTemplateWorksheet(workbook, worksheet) {
  if (worksheet) workbook.removeWorksheet(worksheet.id);
}

function fillFactoryTools(worksheet, processFolders) {
  const records = processFolders.flatMap((folder) =>
    loadJsonl(path.join(folder, "tools_fixtures_equipment.jsonl"))
  );
  const startRow = 8;
  const endRow = 16;
  clearTableRange(worksheet, startRow, endRow, 2, 6);
  records.slice(0, endRow - startRow + 1).forEach((record, offset) => {
    const row = startRow + offset;
    worksheet.getCell(row, 2).value = record.name;
    worksheet.getCell(row, 4).value = record.qty;
    worksheet.getCell(row, 5).value = record.specs;
  });
  return Math.max(0, records.length - (endRow - startRow + 1));
}

function fillFactoryTextBlock(worksheet, folder, filename, cellRef) {
  const text = folder ? loadTextFile(path.join(folder, filename)) : "";
  const cell = worksheet.getCell(cellRef);
  cell.value = text || null;
  if (text) cell.alignment = { ...(cell.alignment || {}), wrapText: true };
  return text;
}

function embedFactoryPhoto(workbook, worksheet, folder, range, warnings, processName) {
  const { rowStart, rowEnd, colStart, colEnd } = range;
  clearAnchorCell(worksheet, rowStart, colStart);
  removeImagesInArea(worksheet, rowStart, rowEnd, colStart, colEnd);
  if (!folder) return;
  const photos = resolveInstructionPhotos(folder);
  if (photos.length === 0) return;
  if (photos.length > 1) {
    warnings.push(`${processName}: Factory Test 每个 Process 只显示一张图片；已使用 ${photos[0].fileName}，忽略其余 ${photos.length - 1} 张。`);
  }
  const photo = photos[0];
  const [effectiveStart, effectiveEnd] = visibleRowBounds(worksheet, rowStart, rowEnd);
  const width = mergedWidthPx(worksheet, colStart, colEnd);
  const height = mergedHeightPx(worksheet, effectiveStart, effectiveEnd);
  const { width: imgW, height: imgH } = readImageSize(photo.filePath);
  const imageRange = computeContainLayoutInPixelRect(
    worksheet,
    effectiveStart,
    effectiveEnd,
    colStart,
    colEnd,
    {
      x: PHOTO_TILE_MARGIN_PX,
      y: PHOTO_TILE_MARGIN_PX,
      width: Math.max(1, width - PHOTO_TILE_MARGIN_PX * 2),
      height: Math.max(1, height - PHOTO_TILE_MARGIN_PX * 2)
    },
    imgW,
    imgH,
    PHOTO_SCALE_FACTOR
  );
  const imageId = workbook.addImage({ filename: photo.filePath, extension: imageExtension(photo.filePath) });
  worksheet.addImage(imageId, imageRange);
}

function linkFactoryTestSheet(
  worksheet,
  pageNumber,
  pageCount,
  processCount,
  author,
  templateLanguage = TEMPLATE_LANGUAGE_ENGLISH
) {
  const labels = workbookLabels(templateLanguage);
  const stepTitle = `STEP_${pageNumber}`;
  worksheet.getCell("E3").value = stepTitle;
  worksheet.getCell("R3").value = `${labels.standardTime}${processCount * PRC_WORK_TIME_SECONDS}${labels.seconds}`;
  worksheet.getCell("A37").value = {
    formula: `"${labels.page}"&${pageNumber}&"/"&Cover!D4`,
    result: `${labels.page}${pageNumber}/${pageCount}`
  };
  fillAuthor(worksheet, "A38", author, templateLanguage);
}

function fillFactoryTestSheet(workbook, worksheet, processPair, warnings) {
  const first = processPair[0];
  const second = processPair[1];
  const omittedTools = fillFactoryTools(
    worksheet,
    processPair.map((process) => process.folder)
  );
  if (omittedTools > 0) {
    warnings.push(`STEP Tools: ${processPair.map((process) => process.metadataName).join(" / ")} 合计超过 9 项，已按 Process 顺序保留前 9 项并省略 ${omittedTools} 项。`);
  }
  fillFactoryTextBlock(worksheet, first.folder, "operation_steps.txt", "G7");
  fillFactoryTextBlock(worksheet, second?.folder, "operation_steps.txt", "G22");
  const firstNotes = loadTextFile(path.join(first.folder, "technical_notes.txt"));
  const secondNotes = second ? loadTextFile(path.join(second.folder, "technical_notes.txt")) : "";
  const notesCell = worksheet.getCell("A18");
  notesCell.value = firstNotes || secondNotes || null;
  if (notesCell.value) notesCell.alignment = { ...(notesCell.alignment || {}), wrapText: true };
  embedFactoryPhoto(
    workbook,
    worksheet,
    first.folder,
    { rowStart: 7, rowEnd: 21, colStart: 12, colEnd: 21 },
    warnings,
    first.metadataName
  );
  embedFactoryPhoto(
    workbook,
    worksheet,
    second?.folder,
    { rowStart: 22, rowEnd: 36, colStart: 12, colEnd: 21 },
    warnings,
    second?.metadataName || "Factory Test Process"
  );
}

function buildStandardProcessSheets(
  workbook,
  templateSheet,
  processes,
  author,
  assetsDir,
  templateLanguage = TEMPLATE_LANGUAGE_ENGLISH
) {
  for (const [index, { folder, metadataName, sheetName }] of processes.entries()) {
    const processSheet = cloneWorksheet(workbook, templateSheet, sheetName);
    setProcessSheetTitle(processSheet, templateLanguage);
    linkProcessSheetToChart(
      processSheet,
      PRC_START_ROW + index,
      index + 1,
      processes.length,
      metadataName,
      author,
      templateLanguage
    );
    fillSheet(workbook, processSheet, folder, assetsDir);
    setSheetZoom(processSheet, PROCESS_SHEET_ZOOM);
  }
}

function buildFactoryTestProcessSheets(
  workbook,
  templateSheet,
  processes,
  author,
  templateLanguage = TEMPLATE_LANGUAGE_ENGLISH
) {
  const warnings = [];
  const pageCount = Math.ceil(processes.length / 2);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const processPair = processes.slice(pageIndex * 2, pageIndex * 2 + 2);
    const processSheet = cloneWorksheet(workbook, templateSheet, `STEP_${pageIndex + 1}`);
    setProcessSheetTitle(processSheet, templateLanguage);
    linkFactoryTestSheet(processSheet, pageIndex + 1, pageCount, processPair.length, author, templateLanguage);
    fillFactoryTestSheet(workbook, processSheet, processPair, warnings);
    setSheetZoom(processSheet, PROCESS_SHEET_ZOOM);
  }
  return warnings;
}

function buildProjectWorkbook(
  workbook,
  projectDir,
  assetsDir,
  projectName,
  documentNo,
  sopName,
  author,
  processList,
  processFallbackDir = null,
  sopType = "assembly_test",
  templateLanguage = TEMPLATE_LANGUAGE_ENGLISH
) {
  const language = normalizeTemplateLanguage(templateLanguage);
  const templateSheet = workbook.getWorksheet(TEMPLATE_SHEET_NAME);
  const factoryTestTemplateSheet = workbook.getWorksheet(FACTORY_TEST_TEMPLATE_SHEET_NAME);
  const assemblyTemplateSheet = workbook.getWorksheet(ASSEMBLY_TEMPLATE_SHEET_NAME);
  const coverSheet = workbook.getWorksheet("Cover");
  const prcSheet = workbook.getWorksheet(PRODUCTION_CHART_SHEET_NAME);
  const workstationSheet = workbook.getWorksheet(WORKSTATION_CHART_SHEET_NAME);
  if (!templateSheet) {
    throw new Error(`Sheet not found: ${TEMPLATE_SHEET_NAME}`);
  }
  if (sopType === "factory_test" && !factoryTestTemplateSheet) {
    throw new Error(`Sheet not found: ${FACTORY_TEST_TEMPLATE_SHEET_NAME}`);
  }
  if (sopType === "assemble" && !assemblyTemplateSheet) {
    throw new Error(`Sheet not found: ${ASSEMBLY_TEMPLATE_SHEET_NAME}`);
  }
  if (!coverSheet) {
    throw new Error("Sheet not found: Cover");
  }
  if (sopType !== "assemble" && !prcSheet) {
    throw new Error(`Sheet not found: ${PRODUCTION_CHART_SHEET_NAME}`);
  }
  if (sopType === "assemble" && !workstationSheet) {
    throw new Error(`Sheet not found: ${WORKSTATION_CHART_SHEET_NAME}`);
  }

  const factoryTest = sopType === "factory_test";
  const assembly = sopType === "assemble";
  const processes = resolveProcesses(
    projectDir,
    processList,
    assembly ? null : processFallbackDir,
    !factoryTest,
    sopType,
    [...workbook.worksheets.map(sheet => sheet.name), ...(language === TEMPLATE_LANGUAGE_CHINESE ? Object.values(CHINESE_SHEET_NAMES) : [])]
  );
  let pageCount = factoryTest ? Math.ceil(processes.length / 2) : processes.length;
  fillCover(coverSheet, projectName, documentNo, sopName, author, pageCount, language);
  setSheetZoom(coverSheet, COVER_PRC_ZOOM);
  if (assembly) {
    fillWorkstationLayoutChart(
      workstationSheet,
      coverSheet,
      projectName,
      documentNo,
      processes.map(({ folder, metadataName }) => [metadataName, loadToolsText(folder, sopType)])
    );
    setSheetZoom(workstationSheet, COVER_PRC_ZOOM);
  } else {
    fillProductionArrangeChart(
      prcSheet,
      projectName,
      processes.map(({ folder, metadataName }) => [metadataName, loadToolsText(folder, sopType)]),
      pageCount,
      language
    );
    setSheetZoom(prcSheet, COVER_PRC_ZOOM);
  }

  let warnings;
  if (factoryTest) warnings = buildFactoryTestProcessSheets(workbook, factoryTestTemplateSheet, processes, author, language);
  else if (assembly) {
    const generated = buildAssemblyProcessSheets(workbook, assemblyTemplateSheet, processes, author, projectName, language);
    warnings = generated.warnings;
    pageCount = generated.pageCount;
    coverSheet.getCell(COVER_PAGE_COUNT_ROW, COVER_PAGE_COUNT_COL).value = pageCount;
    workstationSheet.getCell("F2").value = { ...workstationSheet.getCell("F2").value, result: pageCount };
  } else { buildStandardProcessSheets(workbook, templateSheet, processes, author, assetsDir, language); warnings = []; }

  removeTemplateWorksheet(workbook, templateSheet);
  removeTemplateWorksheet(workbook, factoryTestTemplateSheet);
  removeTemplateWorksheet(workbook, assemblyTemplateSheet);
  removeTemplateWorksheet(workbook, assembly ? prcSheet : workstationSheet);
  localizeWorkbookSheetNames(workbook, language);
  return { warnings, pageCount };
}

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function formatToolIndex(indexValue) {
  const indexStr = String(indexValue);
  if (indexStr.includes(".")) {
    const [main, sub] = indexStr.split(".", 2);
    if (sub === "1") {
      return /^\d+$/.test(main) ? Number(main) : main;
    }
    return null;
  }
  return /^\d+$/.test(indexStr) ? Number(indexStr) : indexStr;
}

function colWidthPx(width) {
  const effectiveWidth = width == null ? DEFAULT_COL_WIDTH : width;
  return Math.floor(effectiveWidth * 7 + 5);
}

function rowHeightPx(height) {
  const effectiveHeight = height == null ? DEFAULT_ROW_HEIGHT_PX_FALLBACK : height;
  return Math.floor((effectiveHeight * 96) / 72);
}

function mergedWidthPx(worksheet, colStart, colEnd) {
  let total = 0;
  for (let col = colStart; col <= colEnd; col += 1) {
    const column = worksheet.getColumn(col);
    total += colWidthPx(column.width);
  }
  return total;
}

function mergedHeightPx(worksheet, rowStart, rowEnd) {
  let total = 0;
  for (let row = rowStart; row <= rowEnd; row += 1) {
    if (worksheet.getRow(row).hidden) {
      continue;
    }
    total += rowHeightPx(worksheet.getRow(row).height);
  }
  return total;
}

function visibleRowBounds(worksheet, rowStart, rowEnd) {
  const visible = [];
  for (let row = rowStart; row <= rowEnd; row += 1) {
    if (!worksheet.getRow(row).hidden) {
      visible.push(row);
    }
  }
  if (visible.length === 0) {
    return [rowStart, rowEnd];
  }
  return [visible[0], visible[visible.length - 1]];
}

function setRowHidden(worksheet, row, hidden) {
  worksheet.getRow(row).hidden = hidden;
}

function unhideBand(worksheet, startRow, endRow) {
  for (let row = startRow; row <= endRow; row += 1) {
    setRowHidden(worksheet, row, false);
  }
}

function estimateTextHeight(worksheet, text, row, colStart, colEnd) {
  const cell = worksheet.getCell(row, colStart);
  const fontSize = getFontSize(cell);
  const wrapText = cell.alignment && cell.alignment.wrapText;
  if (!text || !wrapText) {
    return DEFAULT_ROW_HEIGHT;
  }
  const totalWidthPx = mergedWidthPx(worksheet, colStart, colEnd);
  const lineCount = estimateLineCount(text, totalWidthPx, fontSize);
  return Math.max(
    DEFAULT_ROW_HEIGHT,
    lineCount * fontSize * ROW_HEIGHT_LINE_FACTOR + ROW_HEIGHT_PADDING
  );
}

function estimateTableRowHeight(worksheet, row) {
  if (row === MATERIAL_HEADER_ROW || row === TOOLS_HEADER_ROW) {
    return DEFAULT_ROW_HEIGHT;
  }
  const texts = [];
  for (const col of [2, 3]) {
    const value = worksheet.getCell(row, col).value;
    if (value != null) {
      texts.push(String(value));
    }
  }
  if (texts.length === 0) {
    return DEFAULT_ROW_HEIGHT;
  }
  const text = texts.reduce((a, b) => (a.length >= b.length ? a : b));
  return estimateTextHeight(worksheet, text, row, LEFT_TABLE_COL_START, LEFT_TABLE_COL_END);
}

function imageContainHeightPx(imgW, imgH, cellW, cellHMax) {
  const scale = Math.min(cellW / imgW, cellHMax / imgH);
  return Math.max(DEFAULT_ROW_HEIGHT, imgH * scale);
}

function rowHasTableContent(worksheet, row) {
  if (row === MATERIAL_HEADER_ROW || row === TOOLS_HEADER_ROW) {
    return true;
  }
  for (let col = LEFT_TABLE_COL_START; col <= LEFT_TABLE_COL_END; col += 1) {
    if (worksheet.getCell(row, col).value != null) {
      return true;
    }
  }
  return false;
}

function setCellBorderSide(cell, sides) {
  cell.border = {
    ...(cell.border || {}),
    ...sides,
  };
}

function rowIsSpacerLine(worksheet, row, col = TEXT_START_COL) {
  return worksheet.getCell(row, col).value === "";
}

function restoreSheetBandBorders(worksheet) {
  for (let row = BAND1_START_ROW; row <= BAND1_END_ROW; row += 1) {
    setCellBorderSide(worksheet.getCell(row, LEFT_TABLE_COL_START), { left: BORDER_MEDIUM });
    setCellBorderSide(worksheet.getCell(row, TEXT_END_COL), { right: BORDER_MEDIUM });
  }
  for (let row = BAND2_START_ROW; row <= BAND2_END_ROW; row += 1) {
    setCellBorderSide(worksheet.getCell(row, LEFT_TABLE_COL_START), { left: BORDER_MEDIUM });
    setCellBorderSide(worksheet.getCell(row, TEXT_END_COL), { right: BORDER_MEDIUM });
  }
  for (let row = BAND3_START_ROW; row <= BAND3_END_ROW; row += 1) {
    setCellBorderSide(worksheet.getCell(row, ENV_START_COL), { left: BORDER_MEDIUM });
    setCellBorderSide(worksheet.getCell(row, TEXT_END_COL), { right: BORDER_MEDIUM });
  }
  for (const bandEnd of [BAND1_END_ROW, BAND2_END_ROW, BAND3_END_ROW]) {
    for (let col = LEFT_TABLE_COL_START; col <= TEXT_END_COL; col += 1) {
      setCellBorderSide(worksheet.getCell(bandEnd, col), { bottom: BORDER_MEDIUM });
    }
  }
}

function rowHasMergedText(worksheet, row, col = TEXT_START_COL) {
  return worksheet.getCell(row, col).value != null;
}

function loadTextFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  return fs.readFileSync(filePath, "utf8").trim();
}

function estimateMergedBlockTextHeight(worksheet, text, anchorRow, colStart, colEnd) {
  if (!text) {
    return DEFAULT_ROW_HEIGHT;
  }
  const cell = worksheet.getCell(anchorRow, colStart);
  const fontSize = getFontSize(cell);
  const totalWidthPx = mergedWidthPx(worksheet, colStart, colEnd);
  const effectiveWidth = Math.max(1, Math.floor(totalWidthPx * MERGED_TEXT_WIDTH_FACTOR));
  const lineCount = estimateLineCount(text, effectiveWidth, fontSize);
  const rawHeight = lineCount * fontSize * ROW_HEIGHT_LINE_FACTOR + ROW_HEIGHT_PADDING;
  return Math.max(DEFAULT_ROW_HEIGHT, rawHeight * TEXT_HEIGHT_SAFETY_FACTOR);
}

function applyMergedBandContentLayout(
  worksheet,
  bandStart,
  bandEnd,
  target,
  rowNeeds,
  lastAnchorRow,
  bandHasContent
) {
  const contentRows = [];
  let accumulated = 0;
  const contentEnd = bandEnd - 1;

  for (let row = bandStart; row <= contentEnd; row += 1) {
    if (row <= lastAnchorRow || accumulated < target) {
      contentRows.push(row);
      accumulated += rowNeeds[row] || DEFAULT_ROW_HEIGHT;
    } else {
      break;
    }
  }

  if (contentRows.length === 0) {
    contentRows.push(bandStart);
  }

  const lastContent = contentRows[contentRows.length - 1];
  for (let row = lastContent + 1; row < bandEnd; row += 1) {
    setRowHidden(worksheet, row, true);
  }

  const defaultNeeds = Object.fromEntries(
    contentRows.map((row) => [row, rowNeeds[row] || DEFAULT_ROW_HEIGHT])
  );
  const current = contentRows.reduce((sum, row) => sum + defaultNeeds[row], 0);
  const scale = current > 0 ? target / current : 1;
  for (const row of contentRows) {
    worksheet.getRow(row).height = defaultNeeds[row] * scale;
  }
  finalizeBandEndRow(worksheet, bandEnd, bandHasContent);
}

function balanceTableMergedTextBand(
  worksheet,
  bandStart,
  bandEnd,
  textRow,
  textColStart,
  textColEnd
) {
  unhideBand(worksheet, bandStart, bandEnd);
  const leftRows = [];
  for (let row = bandStart; row <= bandEnd; row += 1) {
    if (rowHasTableContent(worksheet, row)) {
      leftRows.push(row);
    }
  }
  const rowNeeds = Object.fromEntries(
    leftRows.map((row) => [row, estimateTableRowHeight(worksheet, row)])
  );
  const leftTotal = leftRows.reduce((sum, row) => sum + rowNeeds[row], 0);

  const textVal = worksheet.getCell(textRow, textColStart).value;
  const text = textVal != null ? String(textVal).trim() : "";
  if (!text) {
    balanceTextTextBand(
      worksheet,
      bandStart,
      bandEnd,
      (row) => rowHasTableContent(worksheet, row),
      () => false,
      (row) => estimateTableRowHeight(worksheet, row),
      () => DEFAULT_ROW_HEIGHT
    );
    return;
  }

  const textTotal = estimateMergedBlockTextHeight(
    worksheet,
    text,
    textRow,
    textColStart,
    textColEnd
  );
  const target = Math.max(leftTotal, textTotal);
  const lastLeft = leftRows.length > 0 ? Math.max(...leftRows) : bandStart;
  applyMergedBandContentLayout(
    worksheet,
    bandStart,
    bandEnd,
    target,
    rowNeeds,
    lastLeft,
    (row) => rowHasTableContent(worksheet, row)
  );
}

function balanceImageMergedTextBand(
  worksheet,
  bandStart,
  bandEnd,
  imagePath,
  imageColStart,
  imageColEnd,
  textRow,
  textColStart,
  textColEnd
) {
  unhideBand(worksheet, bandStart, bandEnd);

  let imageTotal = DEFAULT_ROW_HEIGHT;
  const hasImage = Boolean(imagePath && fs.existsSync(imagePath));
  if (hasImage) {
    const { width: imgW, height: imgH } = readImageSize(imagePath);
    const cellW = mergedWidthPx(worksheet, imageColStart, imageColEnd);
    imageTotal = imageContainHeightPx(imgW, imgH, cellW, 10000);
  }

  const textVal = worksheet.getCell(textRow, textColStart).value;
  const text = textVal != null ? String(textVal).trim() : "";
  const textTotal = text
    ? estimateMergedBlockTextHeight(worksheet, text, textRow, textColStart, textColEnd)
    : DEFAULT_ROW_HEIGHT;

  if (!text && !hasImage) {
    balanceTextTextBand(
      worksheet,
      bandStart,
      bandEnd,
      () => false,
      () => false,
      () => DEFAULT_ROW_HEIGHT,
      () => DEFAULT_ROW_HEIGHT
    );
    return;
  }

  const target = Math.max(imageTotal, textTotal);
  applyMergedBandContentLayout(
    worksheet,
    bandStart,
    bandEnd,
    target,
    {},
    bandStart,
    () => false
  );
}

function rightTextRowHeight(worksheet, row) {
  if (rowIsSpacerLine(worksheet, row)) {
    return SPACER_ROW_HEIGHT;
  }
  return estimateTextHeight(
    worksheet,
    String(worksheet.getCell(row, TEXT_START_COL).value),
    row,
    TEXT_START_COL,
    TEXT_END_COL
  );
}

function finalizeBandEndRow(worksheet, bandEnd, hasContent) {
  setRowHidden(worksheet, bandEnd, false);
  if (!hasContent(bandEnd)) {
    worksheet.getRow(bandEnd).height = BAND_BORDER_ROW_HEIGHT;
  }
}

function balanceTextTextBand(
  worksheet,
  bandStart,
  bandEnd,
  leftRowHasContent,
  rightRowHasContent,
  leftRowHeight,
  rightRowHeight
) {
  unhideBand(worksheet, bandStart, bandEnd);
  const visibleRows = [];
  let leftTotal = 0;
  let rightTotal = 0;
  const rowNeeds = {};

  for (let row = bandStart; row <= bandEnd; row += 1) {
    const left = leftRowHasContent(row);
    const right = rightRowHasContent(row);
    if (!left && !right) {
      if (row === bandEnd) {
        visibleRows.push(row);
        rowNeeds[row] = BAND_BORDER_ROW_HEIGHT;
      } else {
        setRowHidden(worksheet, row, true);
      }
      continue;
    }
    visibleRows.push(row);
    let need = DEFAULT_ROW_HEIGHT;
    if (left) {
      const leftNeed = leftRowHeight(row);
      need = Math.max(need, leftNeed);
      leftTotal += leftNeed;
    }
    if (right) {
      const rightNeed = rightRowHeight(row);
      need = Math.max(need, rightNeed);
      rightTotal += rightNeed;
    }
    rowNeeds[row] = need;
  }

  if (visibleRows.length === 0) {
    return;
  }

  const target = Math.max(leftTotal, rightTotal);
  const current = visibleRows.reduce((sum, row) => sum + rowNeeds[row], 0);
  const scale = current > 0 ? target / current : 1;
  for (const row of visibleRows) {
    if (row === bandEnd && !leftRowHasContent(row) && !rightRowHasContent(row)) {
      worksheet.getRow(row).height = BAND_BORDER_ROW_HEIGHT;
    } else {
      worksheet.getRow(row).height = rowNeeds[row] * scale;
    }
  }
  finalizeBandEndRow(
    worksheet,
    bandEnd,
    (row) => leftRowHasContent(row) || rightRowHasContent(row)
  );
}

function balanceTableImageBand(worksheet, bandStart, bandEnd, imagePath, imageColStart, imageColEnd) {
  unhideBand(worksheet, bandStart, bandEnd);
  const leftRows = [];
  for (let row = bandStart; row <= bandEnd; row += 1) {
    if (rowHasTableContent(worksheet, row)) {
      leftRows.push(row);
    }
  }
  const rowNeeds = Object.fromEntries(leftRows.map((row) => [row, estimateTableRowHeight(worksheet, row)]));
  const leftTotal = leftRows.reduce((sum, row) => sum + rowNeeds[row], 0);

  let imageTotal = DEFAULT_ROW_HEIGHT;
  if (imagePath && fs.existsSync(imagePath)) {
    const { width: imgW, height: imgH } = readImageSize(imagePath);
    const cellW = mergedWidthPx(worksheet, imageColStart, imageColEnd);
    imageTotal = imageContainHeightPx(imgW, imgH, cellW, 10000);
  }

  const target = Math.max(leftTotal, imageTotal);
  const visibleRows = [];
  let accumulated = 0;
  const lastLeft = leftRows.length > 0 ? Math.max(...leftRows) : bandStart;

  for (let row = bandStart; row <= bandEnd; row += 1) {
    if (row <= lastLeft || accumulated < target || row === bandEnd) {
      visibleRows.push(row);
      accumulated += rowNeeds[row] || DEFAULT_ROW_HEIGHT;
    } else {
      setRowHidden(worksheet, row, true);
    }
  }

  if (visibleRows.length === 0) {
    return;
  }

  const defaultNeeds = Object.fromEntries(
    visibleRows.map((row) => [row, rowNeeds[row] || DEFAULT_ROW_HEIGHT])
  );
  const current = visibleRows.reduce((sum, row) => sum + defaultNeeds[row], 0);
  const scale = current > 0 ? target / current : 1;
  for (const row of visibleRows) {
    if (row === bandEnd && !(row in rowNeeds)) {
      worksheet.getRow(row).height = BAND_BORDER_ROW_HEIGHT;
    } else {
      worksheet.getRow(row).height = defaultNeeds[row] * scale;
    }
  }
  finalizeBandEndRow(worksheet, bandEnd, (row) => rowHasTableContent(worksheet, row));
}

function balanceImageTextBand(worksheet, bandStart, bandEnd, imagePath, imageColStart, imageColEnd) {
  unhideBand(worksheet, bandStart, bandEnd);
  const rightRows = [];
  for (let row = bandStart; row <= bandEnd; row += 1) {
    if (rowHasMergedText(worksheet, row)) {
      rightRows.push(row);
    }
  }
  const rowNeeds = Object.fromEntries(
    rightRows.map((row) => [
      row,
      rowIsSpacerLine(worksheet, row)
        ? SPACER_ROW_HEIGHT
        : estimateTextHeight(
            worksheet,
            String(worksheet.getCell(row, TEXT_START_COL).value),
            row,
            TEXT_START_COL,
            TEXT_END_COL
          ),
    ])
  );
  const rightTotal = rightRows.reduce((sum, row) => sum + rowNeeds[row], 0);

  let imageTotal = DEFAULT_ROW_HEIGHT;
  if (imagePath && fs.existsSync(imagePath)) {
    const { width: imgW, height: imgH } = readImageSize(imagePath);
    const cellW = mergedWidthPx(worksheet, imageColStart, imageColEnd);
    imageTotal = imageContainHeightPx(imgW, imgH, cellW, 10000);
  }

  const target = Math.max(rightTotal, imageTotal);
  const visibleRows = [];
  let accumulated = 0;
  const lastRight = rightRows.length > 0 ? Math.max(...rightRows) : bandStart;

  for (let row = bandStart; row <= bandEnd; row += 1) {
    if (row <= lastRight || accumulated < target || row === bandEnd) {
      visibleRows.push(row);
      accumulated += rowNeeds[row] || DEFAULT_ROW_HEIGHT;
    } else {
      setRowHidden(worksheet, row, true);
    }
  }

  if (visibleRows.length === 0) {
    return;
  }

  const defaultNeeds = Object.fromEntries(
    visibleRows.map((row) => [row, rowNeeds[row] || DEFAULT_ROW_HEIGHT])
  );
  const current = visibleRows.reduce((sum, row) => sum + defaultNeeds[row], 0);
  const scale = current > 0 ? target / current : 1;
  for (const row of visibleRows) {
    if (row === bandEnd && !(row in rowNeeds)) {
      worksheet.getRow(row).height = BAND_BORDER_ROW_HEIGHT;
    } else {
      worksheet.getRow(row).height = defaultNeeds[row] * scale;
    }
  }
  finalizeBandEndRow(worksheet, bandEnd, (row) => rowHasMergedText(worksheet, row));
}

function locateColumnOffset(worksheet, colStart, colEnd, offsetPx) {
  let remaining = Math.max(0, offsetPx);
  for (let col = colStart; col <= colEnd; col += 1) {
    const size = colWidthPx(worksheet.getColumn(col).width);
    if (remaining <= size || col === colEnd) {
      return { nativeCol: col - 1, nativeColOff: Math.round(remaining * PX_TO_EMU) };
    }
    remaining -= size;
  }
  return { nativeCol: colEnd - 1, nativeColOff: 0 };
}

function locateRowOffset(worksheet, rowStart, rowEnd, offsetPx) {
  let remaining = Math.max(0, offsetPx);
  for (let row = rowStart; row <= rowEnd; row += 1) {
    const size = rowHeightPx(worksheet.getRow(row).height);
    if (remaining <= size || row === rowEnd) {
      return { nativeRow: row - 1, nativeRowOff: Math.round(remaining * PX_TO_EMU) };
    }
    remaining -= size;
  }
  return { nativeRow: rowEnd - 1, nativeRowOff: 0 };
}

function computeContainLayoutInPixelRect(
  worksheet,
  rowStart,
  rowEnd,
  colStart,
  colEnd,
  rect,
  imgW,
  imgH,
  scaleFactor = 1
) {
  const scale = Math.min(rect.width / imgW, rect.height / imgH) * scaleFactor;
  const dispW = Math.max(1, Math.floor(imgW * scale));
  const dispH = Math.max(1, Math.floor(imgH * scale));
  const xOff = rect.x + Math.floor((rect.width - dispW) / 2);
  const yOff = rect.y + Math.floor((rect.height - dispH) / 2);
  return {
    tl: {
      ...locateColumnOffset(worksheet, colStart, colEnd, xOff),
      ...locateRowOffset(worksheet, rowStart, rowEnd, yOff),
    },
    br: {
      ...locateColumnOffset(worksheet, colStart, colEnd, xOff + dispW),
      ...locateRowOffset(worksheet, rowStart, rowEnd, yOff + dispH),
    },
  };
}

function photoGrid(count) {
  if (count < 1 || count > MAX_PHOTO_COUNT) {
    throw new Error(`Instruction photo count must be from 1 to ${MAX_PHOTO_COUNT}.`);
  }
  const rowCountsByPhotoCount = {
    1: [1],
    2: [2],
    3: [2, 1],
    4: [2, 2],
    5: [3, 2],
    6: [3, 3],
    7: [4, 3],
    8: [4, 4],
    9: [3, 3, 3],
    10: [4, 3, 3],
    11: [4, 4, 3],
    12: [4, 4, 4],
  };
  const rowCounts = rowCountsByPhotoCount[count];
  return {
    rows: rowCounts.length,
    cols: Math.max(...rowCounts),
    rowCounts,
  };
}

function resolveInstructionPhotos(dataDir, options = {}) {
  const directoryName = options.directoryName || PHOTO_DIRECTORY;
  const caseInsensitive = options.caseInsensitive === true;
  const directoryMatch = caseInsensitive
    ? resolveCaseInsensitiveEntry(dataDir, directoryName, "directory")
    : (fs.existsSync(path.join(dataDir, directoryName))
        ? { name: directoryName, path: path.join(dataDir, directoryName) }
        : null);
  const directory = directoryMatch?.path || path.join(dataDir, directoryName);
  if (!directoryMatch) {
    const legacyFile = options.legacyFile === undefined ? LEGACY_PHOTO_FILE : options.legacyFile;
    if (!legacyFile) return [];
    const legacyMatch = caseInsensitive
      ? resolveCaseInsensitiveEntry(dataDir, legacyFile)
      : (fs.existsSync(path.join(dataDir, legacyFile))
          ? { name: legacyFile, path: path.join(dataDir, legacyFile) }
          : null);
    return legacyMatch
      ? [{ index: 1, fileName: legacyMatch.name, filePath: legacyMatch.path }]
      : [];
  }
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Instruction photos path must be a plain directory: ${directory}`);
  }
  const photos = [];
  const indexes = new Map();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })
    .filter((item) => item.name !== ".DS_Store")
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || entry.isDirectory()) {
      throw new Error(`Instruction photos directory cannot contain symlinks or subdirectories: ${filePath}`);
    }
    if (!entry.isFile()) continue;
    const match = PHOTO_NAME_PATTERN.exec(entry.name);
    if (!match) {
      const warning = `Ignoring instruction photo with invalid name: ${filePath}`;
      if (Array.isArray(options.warnings)) options.warnings.push(warning);
      else console.warn(warning);
      continue;
    }
    const index = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new Error(`Instruction photo index must be from 1 to ${MAX_PHOTO_COUNT}: ${filePath}`);
    }
    if (index > MAX_PHOTO_COUNT) {
      const warning = `Ignoring instruction photo above the supported p${MAX_PHOTO_COUNT} limit: ${filePath}`;
      if (Array.isArray(options.warnings)) options.warnings.push(warning);
      else console.warn(warning);
      continue;
    }
    if (indexes.has(index)) {
      throw new Error(`Instruction photo index p${index} is duplicated: ${indexes.get(index)} and ${filePath}`);
    }
    indexes.set(index, filePath);
    photos.push({ index, fileName: entry.name, filePath });
  }
  photos.sort((left, right) => left.index - right.index || left.fileName.localeCompare(right.fileName));
  if (photos.length > MAX_PHOTO_COUNT) {
    throw new Error(`Instruction photos directory cannot contain more than ${MAX_PHOTO_COUNT} valid photos: ${directory}`);
  }
  if (photos.length > 1) {
    const missing = [];
    for (let index = photos[0].index; index <= photos.at(-1).index; index += 1) {
      if (!indexes.has(index)) missing.push(`p${index}`);
    }
    if (missing.length) {
      const warning = `Instruction photo indexes are non-contiguous; missing ${missing.join(", ")}: ${directory}`;
      if (Array.isArray(options.warnings)) options.warnings.push(warning);
      else console.warn(warning);
    }
  }
  return photos;
}

function estimateLineCount(text, totalWidthPx, fontSize) {
  if (!text) {
    return 1;
  }
  const avgCharWidth = Math.max(fontSize * CHAR_WIDTH_FACTOR, 1);
  const charsPerLine = Math.max(1, Math.floor(totalWidthPx / avgCharWidth));
  let lineCount = 0;
  for (const paragraph of String(text).split("\n")) {
    lineCount += Math.max(1, Math.ceil(paragraph.length / charsPerLine));
  }
  return Math.max(1, lineCount);
}

function estimateWorkstationToolsRowHeight(worksheet, text, row, baseRowHeight) {
  const cell = worksheet.getCell(row, 5);
  const fontSize = getFontSize(cell);
  const availableWidth = mergedWidthPx(worksheet, 5, 5);
  let lineCount = 0;

  for (const paragraph of String(text).split("\n")) {
    let visualWidth = 0;
    for (const character of paragraph) {
      visualWidth += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/u.test(character)
        ? fontSize
        : fontSize * 0.55;
    }
    lineCount += Math.max(1, Math.ceil(visualWidth / availableWidth));
  }

  return Math.max(
    baseRowHeight,
    Math.ceil(lineCount * fontSize * WORKSTATION_TOOLS_LINE_FACTOR + WORKSTATION_TOOLS_PADDING)
  );
}

function getFontSize(cell) {
  return cell.font && cell.font.size ? cell.font.size : 11;
}

function autoFitRowHeight(worksheet, row, text, colStart = TEXT_START_COL, colEnd = TEXT_END_COL) {
  const cell = worksheet.getCell(row, colStart);
  const fontSize = getFontSize(cell);
  const wrapText = cell.alignment && cell.alignment.wrapText;
  if (!text || !wrapText) {
    return;
  }

  const totalWidthPx = mergedWidthPx(worksheet, colStart, colEnd);
  const lineCount = estimateLineCount(text, totalWidthPx, fontSize);
  const height = Math.max(
    DEFAULT_ROW_HEIGHT,
    lineCount * fontSize * ROW_HEIGHT_LINE_FACTOR + ROW_HEIGHT_PADDING
  );
  worksheet.getRow(row).height = height;
}

function clearTableRange(worksheet, startRow, endRow, startCol, endCol) {
  for (let row = startRow; row <= endRow; row += 1) {
    for (let col = startCol; col <= endCol; col += 1) {
      worksheet.getCell(row, col).value = null;
    }
  }
}

function clearMergedTextRange(worksheet, startRow, endRow, startCol) {
  for (let row = startRow; row <= endRow; row += 1) {
    worksheet.getCell(row, startCol).value = null;
  }
}

function mergeRangeLabel(row, colStart, colEnd) {
  const colLetter = (col) => worksheetColumnLetter(col);
  return `${colLetter(colStart)}${row}:${colLetter(colEnd)}${row}`;
}

function worksheetColumnLetter(col) {
  let letter = "";
  let current = col;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    current = Math.floor((current - 1) / 26);
  }
  return letter;
}

function ensureRowMerge(worksheet, row, colStart = TEXT_START_COL, colEnd = TEXT_END_COL) {
  const target = mergeRangeLabel(row, colStart, colEnd);
  const existing = new Set(
    (worksheet.model.merges || []).map((item) => item.replace(/\$/g, ""))
  );
  if (!existing.has(target)) {
    worksheet.mergeCells(target);
  }
}

function fillMaterialDetails(worksheet, records) {
  clearTableRange(worksheet, MATERIAL_START_ROW, MATERIAL_END_ROW, 2, 6);
  records.slice(0, MATERIAL_END_ROW - MATERIAL_START_ROW + 1).forEach((record, offset) => {
    const row = MATERIAL_START_ROW + offset;
    worksheet.getCell(row, 2).value = record.name;
    worksheet.getCell(row, 4).value = record.qty;
    worksheet.getCell(row, 5).value = record.specs;
  });
}

function fillToolsFixtures(worksheet, records) {
  clearTableRange(worksheet, TOOLS_START_ROW, TOOLS_END_ROW, 2, 6);
  records.slice(0, TOOLS_END_ROW - TOOLS_START_ROW + 1).forEach((record, offset) => {
    const row = TOOLS_START_ROW + offset;
    worksheet.getCell(row, 2).value = record.name;
    worksheet.getCell(row, 4).value = record.qty;
    worksheet.getCell(row, 5).value = record.specs;
  });
}

function fillMergedTextBlock(
  worksheet,
  dataDir,
  filename,
  anchorRow,
  colStart = TEXT_START_COL,
  colEnd = TEXT_END_COL
) {
  const text = loadTextFile(path.join(dataDir, filename));
  const cell = worksheet.getCell(anchorRow, colStart);
  cell.value = text || null;
  if (text) {
    cell.alignment = { ...(cell.alignment || {}), wrapText: true };
  }
}

function fillOperationSteps(worksheet, dataDir) {
  fillMergedTextBlock(
    worksheet,
    dataDir,
    "operation_steps.txt",
    STEPS_START_ROW,
    STEPS_START_COL,
    STEPS_END_COL
  );
}

function fillTechnicalNotes(worksheet, dataDir) {
  fillMergedTextBlock(
    worksheet,
    dataDir,
    "technical_notes.txt",
    NOTES_START_ROW,
    NOTES_START_COL,
    NOTES_END_COL
  );
}

function imageExtension(filePath) {
  return path.extname(filePath).toLowerCase() === ".png" ? "png" : "jpeg";
}

function readImageSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (imageExtension(filePath) === "png") {
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Invalid PNG: ${filePath}`);
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error(`Invalid JPEG: ${filePath}`);
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset++] !== 0xff) break;
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  throw new Error(`Invalid JPEG: ${filePath}`);
}

function imageOverlapsArea(image, rowStart, rowEnd, colStart, colEnd) {
  const range = image.range || image.model?.range || image;
  const tl = range.tl || range;
  const br = range.br;
  const topRow = (tl.nativeRow ?? tl.row ?? 0) + 1;
  const leftCol = (tl.nativeCol ?? tl.col ?? 0) + 1;
  const bottomRow = br ? (br.nativeRow ?? br.row ?? 0) + 1 : topRow;
  const rightCol = br ? (br.nativeCol ?? br.col ?? 0) + 1 : leftCol;

  const rowOverlap = topRow <= rowEnd && bottomRow >= rowStart;
  const colOverlap = leftCol <= colEnd && rightCol >= colStart;
  return rowOverlap && colOverlap;
}

function clearAnchorCell(worksheet, row, col) {
  worksheet.getCell(row, col).value = null;
}

function removeImagesInArea(worksheet, rowStart, rowEnd, colStart, colEnd) {
  if (!Array.isArray(worksheet._media)) {
    return;
  }

  worksheet._media = worksheet._media.filter((item) => {
    if (item.type !== "image" || !item.range) {
      return true;
    }
    return !imageOverlapsArea(item, rowStart, rowEnd, colStart, colEnd);
  });
}

function embedPhotoGrid(workbook, worksheet, photos, range) {
  const { rowStart, rowEnd, colStart, colEnd } = range;
  clearAnchorCell(worksheet, rowStart, colStart);
  removeImagesInArea(
    worksheet,
    rowStart,
    rowEnd,
    colStart,
    colEnd
  );
  if (photos.length === 0) return;

  const [effectiveStart, effectiveEnd] = visibleRowBounds(worksheet, rowStart, rowEnd);
  const regionWidth = mergedWidthPx(worksheet, colStart, colEnd);
  const regionHeight = mergedHeightPx(worksheet, effectiveStart, effectiveEnd);
  const grid = photoGrid(photos.length);
  const tileWidth = regionWidth / grid.cols;
  const tileHeight = regionHeight / grid.rows;

  let position = 0;
  grid.rowCounts.forEach((rowCount, row) => {
    const rowOffset = (grid.cols - rowCount) * tileWidth / 2;
    for (let colInRow = 0; colInRow < rowCount; colInRow += 1) {
      const photo = photos[position];
      position += 1;
      const rect = {
        x: rowOffset + colInRow * tileWidth + PHOTO_TILE_MARGIN_PX,
        y: row * tileHeight + PHOTO_TILE_MARGIN_PX,
        width: Math.max(1, tileWidth - PHOTO_TILE_MARGIN_PX * 2),
        height: Math.max(1, tileHeight - PHOTO_TILE_MARGIN_PX * 2),
      };
      const { width: imgW, height: imgH } = readImageSize(photo.filePath);
      const imageRange = computeContainLayoutInPixelRect(
        worksheet,
        effectiveStart,
        effectiveEnd,
        colStart,
        colEnd,
        rect,
        imgW,
        imgH,
        PHOTO_SCALE_FACTOR
      );
      const imageId = workbook.addImage({ filename: photo.filePath, extension: imageExtension(photo.filePath) });
      worksheet.addImage(imageId, imageRange);
    }
  });
}

function embedAssets(workbook, worksheet, assetsDir, dataDir) {
  embedPhotoGrid(
    workbook,
    worksheet,
    resolveInstructionPhotos(dataDir),
    {
      rowStart: PHOTO_START_ROW,
      rowEnd: PHOTO_END_ROW,
      colStart: PHOTO_START_COL,
      colEnd: PHOTO_END_COL,
    }
  );
}

function fillSheet(workbook, worksheet, dataDir, assetsDir) {
  fillMaterialDetails(worksheet, loadJsonl(path.join(dataDir, "material_details.jsonl")));
  fillToolsFixtures(worksheet, loadJsonl(path.join(dataDir, "tools_fixtures_equipment.jsonl")));
  fillOperationSteps(worksheet, dataDir);
  fillTechnicalNotes(worksheet, dataDir);
  embedAssets(workbook, worksheet, assetsDir, dataDir);
}

function normalizeFiniteQty(value) {
  const normalized = typeof value === "string" && value.trim() ? Number(value.trim()) : value;
  return typeof normalized === "number" && Number.isFinite(normalized) ? normalized : null;
}

function validateAssemblyBom(records, filePath) {
  records.forEach((record, offset) => {
    const line = offset + 1;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`${filePath} line ${line} must be a JSON object.`);
    }
    for (const key of ["index", "partno", "spec"]) {
      if (typeof record[key] !== "string") {
        throw new Error(`${filePath} line ${line} field ${key} must be a string.`);
      }
    }
    const qty = normalizeFiniteQty(record.qty);
    if (qty === null) throw new Error(`${filePath} line ${line} field qty must be a finite number or numeric string.`);
    record.qty = qty;
  });
}

function fillAssemblyTable(worksheet, records, startRow, rowCount, mapper) {
  const endRow = startRow + rowCount - 1;
  clearTableRange(worksheet, startRow, endRow, 1, 6);
  records.slice(0, rowCount).forEach((record, offset) => {
    const row = startRow + offset;
    const values = mapper(record);
    worksheet.getCell(row, 1).value = values.index;
    worksheet.getCell(row, 2).value = values.name;
    worksheet.getCell(row, 4).value = values.qty;
    worksheet.getCell(row, 5).value = values.spec;
  });
}

function fillAssemblyText(worksheet, folder, canonicalName, cellRef) {
  const filePath = assemblyPath(folder, canonicalName);
  const text = filePath ? loadTextFile(filePath) : "";
  const cell = worksheet.getCell(cellRef);
  cell.value = text || null;
  if (text) cell.alignment = { ...(cell.alignment || {}), wrapText: true };
  return text;
}

function embedSingleAssemblyPhoto(workbook, worksheet, filePath, range) {
  const { rowStart, rowEnd, colStart, colEnd } = range;
  // A21:F30 is one merged text region in AssemblyTemplate. A27 therefore
  // points back to the A21 master cell; clearing it would erase the text that
  // the photo is intentionally allowed to overlay.
  removeImagesInArea(worksheet, rowStart, rowEnd, colStart, colEnd);
  if (!filePath) return;
  const [effectiveStart, effectiveEnd] = visibleRowBounds(worksheet, rowStart, rowEnd);
  const width = mergedWidthPx(worksheet, colStart, colEnd);
  const height = mergedHeightPx(worksheet, effectiveStart, effectiveEnd);
  const { width: imgW, height: imgH } = readImageSize(filePath);
  const imageRange = computeContainLayoutInPixelRect(
    worksheet,
    effectiveStart,
    effectiveEnd,
    colStart,
    colEnd,
    {
      x: PHOTO_TILE_MARGIN_PX,
      y: PHOTO_TILE_MARGIN_PX,
      width: Math.max(1, width - PHOTO_TILE_MARGIN_PX * 2),
      height: Math.max(1, height - PHOTO_TILE_MARGIN_PX * 2),
    },
    imgW,
    imgH,
    PHOTO_SCALE_FACTOR
  );
  const imageId = workbook.addImage({ filename: filePath, extension: imageExtension(filePath) });
  worksheet.addImage(imageId, imageRange);
}

/** Add real table rows, reclaiming only reserved check-area space to retain the page's
 * physical height. Keep at least 80% of the original right-hand photo area. If either
 * constraint is exhausted, the existing continuation mechanism retains the remainder.
 * Rebuild mapped rows/merges rather than splicing merged ExcelJS worksheets in place. */
function assemblyLayout(template, folder, bom, tools) {
  const height = row => template.getRow(row).height || template.properties.defaultRowHeight || 30;
  const sum = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => height(first + i)).reduce((a, b) => a + b, 0);
  const text = name => { const file = assemblyPath(folder, name); return file ? loadTextFile(file) : ""; };
  const checkPhoto = Boolean(assemblyPath(folder, ASSEMBLY_FILES.previousStationCheckPhoto));
  const previousEnd = checkPhoto ? 26 : 30;
  const previousHeight = sum(21, previousEnd), selfHeight = sum(32, 36);
  const previousNeed = Math.max(60, estimateMergedBlockTextHeight(template, text(ASSEMBLY_FILES.previousStationCheck), 21, 1, 6)) + (checkPhoto ? 12 : 0);
  const selfNeed = Math.max(60, estimateMergedBlockTextHeight(template, text(ASSEMBLY_FILES.selfCheck), 32, 1, 21));
  const previousSpare = Math.max(0, previousHeight - previousNeed), selfSpare = Math.max(0, selfHeight - selfNeed);
  const photoAllowance = sum(16, 30) * 0.2, bomHeight = height(12), toolsHeight = height(19);
  let bomExtra = 0, toolsExtra = 0;
  const needBom = Math.max(0, bom.length - ASSEMBLY_TABLE_BASE_ROWS), needTools = Math.max(0, tools.length - ASSEMBLY_TABLE_BASE_ROWS);
  // Alternate allocations so a large BOM cannot displace a short tools overflow.
  for (;;) {
    let changed = false;
    for (const kind of ["tools", "bom"]) {
      if (kind === "bom" ? bomExtra >= needBom : toolsExtra >= needTools) continue;
      const nextBom = bomExtra + (kind === "bom" ? 1 : 0), nextTools = toolsExtra + (kind === "tools" ? 1 : 0);
      const extraHeight = nextBom * bomHeight + nextTools * toolsHeight;
      const previousReduction = Math.max(0, extraHeight - selfSpare);
      if (previousReduction > previousSpare + 0.001 || previousReduction > photoAllowance + nextTools * toolsHeight + 0.001) continue;
      bomExtra = nextBom; toolsExtra = nextTools; changed = true;
    }
    if (!changed) break;
  }
  const addedHeight = bomExtra * bomHeight + toolsExtra * toolsHeight;
  const selfReduction = Math.min(selfSpare, addedHeight), previousReduction = addedHeight - selfReduction;
  const mapRow = row => row + (row >= 13 ? bomExtra : 0) + (row >= 20 ? toolsExtra : 0);
  return { bomExtra, toolsExtra, bomRows: ASSEMBLY_TABLE_BASE_ROWS + bomExtra, toolsRows: ASSEMBLY_TABLE_BASE_ROWS + toolsExtra, mapRow,
    compact(worksheet) {
      for (const [first, last, total, reduction] of [[21, previousEnd, previousHeight, previousReduction], [32, 36, selfHeight, selfReduction]]) {
        if (!reduction) continue;
        for (let row = first; row <= last; row++) worksheet.getRow(mapRow(row)).height = height(row) * (total - reduction) / total;
      }
    }
  };
}

function fillAssemblySheet(workbook, worksheet, folder, processName, warnings, overflowTables, layout, bom, tools) {
  const mapRow = layout.mapRow;
  fillAssemblyTable(worksheet, bom, 8, layout.bomRows, (record) => ({ index: record.index, name: record.partno, qty: record.qty, spec: record.spec }));
  if (bom.length > layout.bomRows) overflowTables.push({ processName, kind: "bom", file: ASSEMBLY_FILES.material, inlineCount: layout.bomRows, records: bom.slice(layout.bomRows) });
  fillAssemblyTable(worksheet, tools, mapRow(15), layout.toolsRows, (record) => ({ index: record.index, name: record.name, qty: record.qty, spec: record.specs }));
  if (tools.length > layout.toolsRows) overflowTables.push({ processName, kind: "tools", file: ASSEMBLY_FILES.tools, inlineCount: layout.toolsRows, records: tools.slice(layout.toolsRows) });
  layout.compact(worksheet);

  const operation = fillAssemblyText(worksheet, folder, ASSEMBLY_FILES.operation, "G7");
  if (!operation) {
    warnings.push(`${processName}: ${ASSEMBLY_FILES.operation} is missing or empty; generated an empty-content page.`);
  }
  fillAssemblyText(worksheet, folder, ASSEMBLY_FILES.previousStationCheck, `A${mapRow(21)}`);
  fillAssemblyText(worksheet, folder, ASSEMBLY_FILES.selfCheck, `A${mapRow(32)}`);

  const operationPhotos = resolveInstructionPhotos(folder, {
    directoryName: ASSEMBLY_FILES.photos,
    legacyFile: null,
    caseInsensitive: true,
    warnings,
  });
  embedPhotoGrid(workbook, worksheet, operationPhotos, {
    rowStart: mapRow(16),
    rowEnd: mapRow(30),
    colStart: 7,
    colEnd: 21,
  });
  embedSingleAssemblyPhoto(
    workbook,
    worksheet,
    assemblyPath(folder, ASSEMBLY_FILES.previousStationCheckPhoto),
    { rowStart: mapRow(27), rowEnd: mapRow(30), colStart: 1, colEnd: 6 }
  );

  worksheet.pageSetup.orientation = "landscape";
  worksheet.pageSetup.fitToPage = true;
  worksheet.pageSetup.fitToWidth = 1;
  worksheet.pageSetup.fitToHeight = 1;
  worksheet.pageSetup.printArea = `A1:U${mapRow(38)}`;
  delete worksheet.pageSetup.scale;
}

/** Retain rows that cannot fit the expanded process page in printable continuation pages. */
function appendAssemblyTables(workbook, tables, processPageCount, templateLanguage) {
  const perPage = 20, sheets = [], seen = new Set(workbook.worksheets.map(sheet => sheetNameKey(sheet.name)));
  if (templateLanguage === TEMPLATE_LANGUAGE_CHINESE) Object.values(CHINESE_SHEET_NAMES).forEach(name => seen.add(sheetNameKey(name)));
  const chinese = templateLanguage === TEMPLATE_LANGUAGE_CHINESE;
  for (const table of tables) {
    const names = [];
    for (let offset = 0; offset < table.records.length; offset += perPage) {
      const prefix = chinese ? (table.kind === "bom" ? "物料续表" : "工具续表") : (table.kind === "bom" ? "BOM Continuation" : "Tools Continuation");
      const name = uniqueSheetName(prefix, seen); seen.add(sheetNameKey(name)); names.push(name);
      const sheet = workbook.addWorksheet(name);
      sheet.columns = [{ width: 10 }, { width: 36 }, { width: 12 }, { width: 85 }];
      sheet.mergeCells("A1:D1"); sheet.getCell("A1").value = table.processName;
      sheet.mergeCells("A2:D2"); sheet.getCell("A2").value = `${table.file} — ${chinese ? `续表（前${table.inlineCount}行见工序页）` : `Continuation (first ${table.inlineCount} rows on process page)`}`;
      const headers = chinese ? ["序号", table.kind === "bom" ? "料号" : "工具名称", "数量", "规格"] : ["Index", table.kind === "bom" ? "Part No." : "Tool", "Qty", "Specification"];
      sheet.getRow(4).values = headers;
      const records = table.records.slice(offset, offset + perPage);
      for (const [index, record] of records.entries()) {
        const row = sheet.getRow(5 + index);
        row.values = [record.index, table.kind === "bom" ? record.partno : record.name, record.qty, table.kind === "bom" ? record.spec : record.specs];
        row.height = 30;
      }
      const footer = 5 + records.length;
      sheet.mergeCells(`A${footer}:D${footer}`);
      for (let row = 1; row <= footer; row++) sheet.getRow(row).eachCell(cell => {
        cell.font = { name: "Arial", size: row <= 2 ? 11 : 10, bold: row === 1 || row === 4 };
        cell.alignment = { vertical: "middle", wrapText: true };
        if (row >= 4 && row < footer) cell.border = Object.fromEntries(["top", "left", "bottom", "right"].map(edge => [edge, { style: "thin" }]));
      });
      for (let row = 5; row < footer; row++) sheet.getRow(row).height = Math.ceil(Math.max(30,
        ...[1, 2, 3, 4].map(col => estimateTextHeight(sheet, String(sheet.getCell(row, col).value ?? ""), row, col, col))));
      sheet.pageSetup = { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 1, printArea: `A1:D${footer}` };
      setSheetZoom(sheet, PROCESS_SHEET_ZOOM);
      sheets.push({ sheet, footer });
    }
    table.sheetNames = names;
  }
  const pageCount = processPageCount + sheets.length, labels = workbookLabels(templateLanguage);
  sheets.forEach(({ sheet, footer }, index) => {
    sheet.getCell(`A${footer}`).value = { formula: `"${labels.page}"&${processPageCount + index + 1}&"/"&Cover!D4`, result: `${labels.page}${processPageCount + index + 1}/${pageCount}` };
  });
  return pageCount;
}

function buildAssemblyProcessSheets(
  workbook,
  templateSheet,
  processes,
  author,
  projectName,
  templateLanguage = TEMPLATE_LANGUAGE_ENGLISH
) {
  const warnings = [];
  const overflowTables = [], processSheets = [];
  for (const [index, { folder, metadataName, sheetName }] of processes.entries()) {
    const bomPath = assemblyPath(folder, ASSEMBLY_FILES.material);
    const bom = bomPath ? loadJsonl(bomPath) : [];
    validateAssemblyBom(bom, bomPath || path.join(folder, ASSEMBLY_FILES.material));
    const toolsPath = assemblyPath(folder, ASSEMBLY_FILES.tools);
    const tools = toolsPath ? loadJsonl(toolsPath) : [];
    const layout = assemblyLayout(templateSheet, folder, bom, tools);
    const processSheet = cloneWorksheet(workbook, templateSheet, sheetName, layout);
    setProcessSheetTitle(processSheet, templateLanguage);
    linkAssemblyProcessSheetToWorkstation(
      processSheet,
      WORKSTATION_START_ROW + index,
      index + 1,
      processes.length,
      metadataName,
      author,
      projectName,
      templateLanguage,
      layout.mapRow
    );
    fillAssemblySheet(workbook, processSheet, folder, metadataName, warnings, overflowTables, layout, bom, tools);
    processSheets.push({ sheet: processSheet, footerRow: layout.mapRow(37) });
    setSheetZoom(processSheet, PROCESS_SHEET_ZOOM);
  }
  const pageCount = appendAssemblyTables(workbook, overflowTables, processes.length, templateLanguage);
  processSheets.forEach(({ sheet, footerRow }, index) => {
    sheet.getCell(`A${footerRow}`).value = { ...sheet.getCell(`A${footerRow}`).value, result: `${workbookLabels(templateLanguage).page}${index + 1}/${pageCount}` };
  });
  for (const table of overflowTables) warnings.push(templateLanguage === TEMPLATE_LANGUAGE_CHINESE
    ? `${table.processName}：${table.file} 前${table.inlineCount}行见工序页，其余 ${table.records.length} 行已完整保存在「${table.sheetNames.join("、")}」。`
    : `${table.processName}: ${table.file}: first ${table.inlineCount} rows are on the process page; all ${table.records.length} remaining rows are in ${table.sheetNames.join(", ")}.`);
  return { warnings, pageCount };
}

/**
 * English output typography: Calibri everywhere; Bill of Materials / Tools-Fixtures
 * table bodies at 14pt. Chinese output must not call this.
 */
function applyEnglishTypography(workbook) {
  const seen = new Set();
  const textOf = cell => {
    try { return String(cell.text || ""); } catch { return String(cell.value ?? ""); }
  };
  const setFont = (cell, size) => {
    const target = cell.master || cell;
    if (seen.has(target.address)) return;
    seen.add(target.address);
    const patch = font => {
      const next = { ...(font || {}), name: "Calibri", charset: 0 };
      if (size) next.size = size;
      delete next.scheme;
      return next;
    };
    const value = target.value;
    if (value && typeof value === "object" && Array.isArray(value.richText)) {
      for (const run of value.richText) run.font = patch(run.font);
      target.font = patch(target.font);
    } else {
      target.font = patch(target.font);
    }
  };
  const sectionLabel = /^(?:\d+[.)]\s*)?(Bill of Materials|Tools\/Fixtures|BOM Continuation|Tools Continuation|Previous Station Check|Self-Check|Technical Requirements|Operation Instruction)\b/i;
  for (const sheet of workbook.worksheets) {
    seen.clear();
    sheet.eachRow({ includeEmpty: false }, row => {
      row.eachCell({ includeEmpty: true }, cell => setFont(cell));
    });
    const sections = [];
    for (let row = 1; row <= sheet.rowCount; row++) {
      const match = sectionLabel.exec(textOf(sheet.getCell(row, 1)).trim());
      if (match) sections.push({ row, kind: match[1] });
    }
    // The body pass must be allowed to restyle cells that already received the Calibri pass.
    seen.clear();
    for (let index = 0; index < sections.length; index++) {
      const section = sections[index], continuation = /Continuation$/i.test(section.kind);
      if (!/^(Bill of Materials|Tools\/Fixtures|BOM Continuation|Tools Continuation)$/i.test(section.kind)) continue;
      // Main table: section title, column header, then data. Continuation: title/brief/blank/header, then data.
      const start = section.row + (continuation ? 4 : 2);
      const end = (sections[index + 1]?.row ?? sheet.rowCount + 1) - 1;
      const lastColumn = continuation ? 4 : 6;
      for (let row = start; row <= end; row++) {
        if (continuation && row === sheet.rowCount) continue; // page-number footer
        for (let column = 1; column <= lastColumn; column++) setFont(sheet.getCell(row, column), 14);
      }
    }
  }
}

async function buildCkdSop(options) {
  const templateLanguage = normalizeTemplateLanguage(options.templateLanguage);
  const templatePath = path.resolve(
    options.template || path.resolve(__dirname, options.sopType === "assemble"
      ? "assemble-sop-template.xlsx" : TEMPLATE_FILE_BY_LANGUAGE[templateLanguage])
  );
  const assetsDir = path.resolve(options.assetsDir || path.dirname(templatePath));
  const outputPath = path.resolve(options.output);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(templatePath, outputPath);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);

  const projectDir = options.projectDir || options.projectName;

  if (projectDir) {
    const missing = [];
    if (!options.projectName) {
      missing.push("projectName");
    }
    if (!options.documentNo) {
      missing.push("documentNo");
    }
    if (!options.sopName) {
      missing.push("sopName");
    }
    if (!options.processList) {
      missing.push("processList");
    }
    if (missing.length > 0) {
      throw new Error(`Project mode requires: ${missing.join(", ")}`);
    }
    const useCustomerAssembly = options.sopType === "assemble" && workbook.getWorksheet("1格模版");
    const projectResult = useCustomerAssembly
      ? require("./assembly-template.cjs").buildAssemblyWorkbook(workbook, { ...options, projectDir: path.resolve(projectDir), templateLanguage }, {
        resolveProcesses, parseProcessList, resolveInstructionPhotos, cloneWorksheet, setSheetZoom, loadToolsText, loadJsonl, assemblyPath,
        validateAssemblyBom, fillAssemblyTable, embedSingleAssemblyPhoto, appendAssemblyTables, authorName,
        mergedWidthPx, uniqueSheetName, sheetNameKey,
      }) : buildProjectWorkbook(
      workbook,
      path.resolve(projectDir),
      assetsDir,
      options.projectName,
      options.documentNo,
      options.sopName,
      options.author,
      Array.isArray(options.processList)
        ? parseProcessList(JSON.stringify(options.processList))
        : parseProcessList(options.processList),
      options.processFallbackDir ? path.resolve(options.processFallbackDir) : null,
      options.sopType || "assembly_test",
      templateLanguage
    );
    options.generationWarnings = projectResult.warnings;
  } else {
    if (!options.dataDir) {
      throw new Error("Single-sheet mode requires --data-dir (or use --project-dir for project mode)");
    }
    const worksheet = workbook.getWorksheet(options.sheet || TEMPLATE_SHEET_NAME);
    if (!worksheet) {
      throw new Error(`Sheet not found: ${options.sheet || TEMPLATE_SHEET_NAME}`);
    }
    fillSheet(workbook, worksheet, path.resolve(options.dataDir), assetsDir);
  }

  if (templateLanguage === TEMPLATE_LANGUAGE_ENGLISH) applyEnglishTypography(workbook);

  await workbook.xlsx.writeFile(outputPath);
  return {
    outputPath,
    sheetCount: workbook.worksheets.length,
    warnings: options.generationWarnings || []
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await buildCkdSop(args);
  console.log(`Wrote ${result.outputPath}`);
}

module.exports = {
  buildCkdSop,
  fillProductionArrangeChart,
  fillWorkstationLayoutChart,
  photoGrid,
  resolveInstructionPhotos
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
