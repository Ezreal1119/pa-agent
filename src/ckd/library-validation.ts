import fs from "node:fs/promises";
import path from "node:path";
import { isInside } from "./store.js";
import { validate } from "./validation.js";
import { jsonErrorLocation } from "./json-syntax.js";
import sharp from 'sharp';
import {inspectImage,MAX_IMAGE_BYTES} from './image-input.js';

const sopTypes = ["assemble", "assembly_test", "pcba_test", "aging_test", "factory_test"] as const;
export interface LibraryValidationOptions {
  sopType?: typeof sopTypes[number] | "all";
  templateLanguage?: "English" | "中文" | "all";
}
export interface LibrarySyntaxError {
  file: string;
  line: number | null;
  column: number | null;
  code: "invalid_json" | "invalid_jsonl" | "read_error" | "invalid_utf8" | "symlink" | "invalid_image";
  message: string;
}
export interface LibraryValidationReport {
  valid: boolean;
  scope: { sopType: string; templateLanguage: string };
  scannedFiles: number;
  checkedEntries: number;
  invalidFiles: number;
  errorCount: number;
  errors: LibrarySyntaxError[];
  checkedAssetFiles?:number;
}
function selected(relative: string, options: LibraryValidationOptions): boolean {
  const parts = relative.split("/");
  const type = parts[0] === "product_lib" ? parts[2] : parts[0] === "processes_lib" ? parts[1] : undefined;
  const typed = sopTypes.includes(type as typeof sopTypes[number]);
  const filteredType = options.sopType && options.sopType !== "all";
  const filteredLanguage = options.templateLanguage && options.templateLanguage !== "all";
  if (!typed) {
    // Shared root and project metadata apply to every selection. Untyped archives are full-scan only.
    return (!filteredType && !filteredLanguage) || parts.length === 1 || (parts[0] === "product_lib" && parts.length <= 3);
  }
  if (filteredType && type !== options.sopType) return false;
  if (!filteredLanguage) return true;
  const directory = parts[0] === "product_lib" ? parts[3] : parts[2];
  if (parts[0] === "product_lib" && parts.length === 4) return true; // sops.json
  const chinese = directory === "CN_process" || directory === "CN_derived";
  return chinese === (options.templateLanguage === "中文");
}
/** Read-only syntax scan. No repairs, model calls, Catalog construction or task creation. */
export async function validateCkdLibrary(libraryPath: string, options: LibraryValidationOptions = {},checkAssets=false): Promise<LibraryValidationReport> {
  validate({ type: "object", properties: { sopType: { enum: ["all", ...sopTypes] }, templateLanguage: { enum: ["all", "English", "中文"] } }, additionalProperties: false }, options);
  const root = await fs.realpath(libraryPath);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("CKD Library must be a directory.");
  const report: LibraryValidationReport = { valid: true, scope: { sopType: options.sopType ?? "all", templateLanguage: options.templateLanguage ?? "all" }, scannedFiles: 0, checkedEntries: 0, invalidFiles: 0, errorCount: 0, errors: [] };
  const add = (file: string, code: LibrarySyntaxError["code"], message: string, line: number | null = null, column: number | null = null) => report.errors.push({ file, line, column, code, message });
  const visit = async (directory: string): Promise<void> => {
    const relativeDirectory = path.relative(root, directory).split(path.sep).join("/");
    try {
      if (!isInside(root, await fs.realpath(directory))) { add(relativeDirectory, "symlink", "目录超出 Library，未读取。"); return; }
      const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const file = path.join(directory, entry.name); const relative = path.relative(root, file).split(path.sep).join("/");
        const json = /\.jsonl?$/iu.test(entry.name);
        const asset=checkAssets&&(/\.(?:txt|png|jpe?g)$/iu.test(entry.name)||entry.name.toLowerCase()==='metadata');
        if (entry.isSymbolicLink()) { if ((json || asset || !path.extname(entry.name)) && selected(relative, options)) add(relative, "symlink", "不读取符号链接，请使用 Library 内的普通文件或目录。"); continue; }
        if (entry.isDirectory()) { await visit(file); continue; }
        if(asset&&entry.isFile()&&selected(relative,options)){
          report.checkedAssetFiles=(report.checkedAssetFiles??0)+1;
          try{
            if(!isInside(root,await fs.realpath(file)))throw new Error('文件超出Library。');
            if(/\.(?:png|jpe?g)$/iu.test(entry.name)){
              if((await fs.stat(file)).size>MAX_IMAGE_BYTES)throw new Error('原图超过10 MiB入口限制。');
              const bytes=await fs.readFile(file);inspectImage(bytes);await sharp(bytes,{limitInputPixels:40_000_000,failOn:'error'}).metadata();
            }else new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await fs.readFile(file));
          }catch(error){const image=/\.(?:png|jpe?g)$/iu.test(entry.name);add(relative,image?'invalid_image':'invalid_utf8',`${image?'图片格式或尺寸无法读取':'文本无法按UTF-8读取'}，可能未解密、损坏或格式/编码不支持；请检查源文件并重新上传。${error instanceof Error?error.message:''}`);}
          continue;
        }
        if (!json || !entry.isFile() || !selected(relative, options)) continue;
        report.scannedFiles++;
        let text: string;
        try {
          if (!isInside(root, await fs.realpath(file))) { add(relative, "symlink", "文件超出 Library，未读取。"); continue; }
          const bytes = await fs.readFile(file);
          try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
          catch { add(relative, "invalid_utf8", "文件包含无效 UTF-8 字节，无法解析 JSON。"); continue; }
        } catch (error) { add(relative, "read_error", error instanceof Error ? error.message : String(error)); continue; }
        if (/\.jsonl$/iu.test(entry.name)) {
          const lines = text.split(/\r?\n/u);
          for (let index = 0; index < lines.length; index++) {
            const original = lines[index]!; const line = original.trim(); if (!line) continue;
            report.checkedEntries++;
            try { JSON.parse(line); }
            catch (error) { const location = jsonErrorLocation(line, error); add(relative, "invalid_jsonl", error instanceof Error ? error.message : String(error), index + 1, original.indexOf(line) + location.column); }
          }
        } else {
          report.checkedEntries++;
          try { JSON.parse(text); }
          catch (error) { const location = jsonErrorLocation(text, error); add(relative, "invalid_json", error instanceof Error ? error.message : String(error), location.line, location.column); }
        }
      }
    } catch (error) { add(relativeDirectory || ".", "read_error", error instanceof Error ? error.message : String(error)); }
  };
  await visit(root);
  report.errorCount = report.errors.length; report.invalidFiles = new Set(report.errors.map(error => error.file)).size; report.valid = report.errorCount === 0;
  return report;
}
