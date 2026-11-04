import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isInside } from "./store.js";
export const sopTypes = ["assemble", "assembly_test", "pcba_test", "aging_test", "factory_test"] as const;
export type Language = "English" | "中文";
export interface MaintenanceInput {
    projectId?: string;
    sopType?: string;
    processId?: string;
    dryRun?: boolean;
    templateLanguage?: Language;
    force?: boolean;
}
export interface SourceSpec {
    key: string;
    file: string;
    kind: "text" | "jsonl" | "image" | "imageSet";
    candidates?: string[];
    legacyFile?: string;
    legacyDirectory?: string;
    caseInsensitive?: boolean;
}
export interface ResolvedSource extends SourceSpec {
    source: string;
    filePath?: string;
    selectedFile?: string;
    directoryPath?: string;
    directoryPresent?: boolean;
    photos?: {
        index: number;
        fileName: string;
        filePath: string;
    }[];
    warnings?: string[];
}
export type Resolved = Record<string, ResolvedSource>;
export interface Hashes {
    effectiveContentHash: string;
    previousEffectiveContentHash: string;
    legacyFingerprint: string;
}
const core = createRequire(import.meta.url)("../../resources/ckd-maintenance/summary-sync-core.cjs") as {
    sourceOrderForSopType(type: string): SourceSpec[];
    resolveSources(common: string | null, project: string | null, type: string, language: Language): Resolved;
    fingerprints(resolved: Resolved): Hashes;
    fileSources(resolved: Resolved): Record<string, string>;
};
export const { sourceOrderForSopType, resolveSources, fingerprints, fileSources } = core;
export const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const fileHash = (file: string): string | null => {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(file);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return null;
        throw error;
    }
    if (stat.isSymbolicLink())
        throw new Error(`Library symlink is not allowed: ${file}`);
    if (stat.isDirectory()) {
        const entries = fs.readdirSync(file, { withFileTypes: true }).filter(e => !e.name.startsWith(".") && !["summary.json", "overview.json"].includes(e.name)).sort((a, b) => a.name.localeCompare(b.name));
        return sha(JSON.stringify(entries.map(e => [e.name, fileHash(path.join(file, e.name))])));
    }
    return sha(fs.readFileSync(file));
};
export function safePath(root: string, relative: string): string {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).some(part => part === ".." || part === "." || !part))
        throw new Error("Invalid Library relative path.");
    const target = path.resolve(root, relative);
    if (!isInside(root, target))
        throw new Error("Path escapes Library.");
    let current = root;
    for (const part of path.relative(root, target).split(path.sep)) {
        current = path.join(current, part);
        try {
            if (fs.lstatSync(current).isSymbolicLink())
                throw new Error(`Library symlink is not allowed: ${relative}`);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
        }
    }
    return target;
}
export function walk(root: string): string[] {
    if (!fs.existsSync(root))
        return [];
    if (fs.lstatSync(root).isSymbolicLink())
        throw new Error(`Library symlink is not allowed: ${root}`);
    const result: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith("."))
            continue;
        const file = path.join(root, entry.name);
        if (entry.isSymbolicLink())
            throw new Error(`Library symlink is not allowed: ${file}`);
        if (entry.isDirectory())
            result.push(...walk(file));
        else if (entry.isFile())
            result.push(file);
    }
    return result;
}
export function directories(root: string): string[] {
    if (!fs.existsSync(root))
        return [];
    if (fs.lstatSync(root).isSymbolicLink())
        throw new Error(`Library symlink is not allowed: ${root}`);
    return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith(".") && !["CN_process", "derived", "CN_derived"].includes(e.name)).map(e => e.name).sort();
}
export function readObject(file: string): Record<string, any> | undefined {
    if (!fs.existsSync(file))
        return undefined;
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Expected JSON object: ${file}`);
    return value as Record<string, any>;
}
export function validateInput(kind: string, raw: MaintenanceInput): MaintenanceInput {
    if(kind==="sync"){
        if(!raw||typeof raw!=="object"||Array.isArray(raw)||Object.keys(raw).some(k=>k!=="dryRun")||(raw.dryRun!==undefined&&typeof raw.dryRun!=="boolean"))throw new Error("Library sync accepts only optional boolean dryRun; scope is the full configured Library.");
        return {...raw};
    }
    const allowed = new Set(["projectId", "sopType", "processId", "dryRun", ...(kind === "summaries" ? ["templateLanguage", "force"] : [])]);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Expected maintenance input object.");
    for (const [key, value] of Object.entries(raw)) {
        if (!allowed.has(key))
            throw new Error(`Unknown maintenance option: ${key}`);
        if (["dryRun", "force"].includes(key)) {
            if (typeof value !== "boolean")
                throw new Error(`${key} must be boolean.`);
        }
        else if (typeof value !== "string" || !value.trim() || /[\\/\u0000]/u.test(value) || [".", ".."].includes(value))
            throw new Error(`Invalid ${key}.`);
    }
    if (raw.sopType && !sopTypes.includes(raw.sopType as typeof sopTypes[number]))
        throw new Error("Unsupported sopType.");
    if (raw.templateLanguage && !["English", "中文"].includes(raw.templateLanguage))
        throw new Error("Unsupported templateLanguage.");
    return { ...raw };
}
export interface Target {
    key: string;
    sopType: string;
    language: Language;
    processId: string;
    projectId?: string;
    common: string | null;
    project: string | null;
    output: string;
}
export function targets(root: string, input: MaintenanceInput): Target[] {
    const projects = directories(safePath(root, "product_lib"));
    if (input.projectId && !projects.includes(input.projectId))
        throw new Error("Unknown projectId.");
    for (const project of input.projectId ? [input.projectId] : projects) {
        const definition = readObject(safePath(root, `product_lib/${project}/project.json`));
        if (!definition || definition.projectId !== project)
            throw new Error(`Project ID must match directory: ${project}`);
    }
    const result: Target[] = [];
    for (const sopType of sopTypes.filter(t => !input.sopType || t === input.sopType)) {
        for (const language of input.templateLanguage ? [input.templateLanguage] : ["English", "中文"] as Language[]) {
            const commonRoot = safePath(root, `processes_lib/${sopType}${language === "中文" ? "/CN_process" : ""}`);
            const commonIds = sopType === "assemble" && language === "English" ? [] : directories(commonRoot);
            const common = (id: string) => commonIds.includes(id) ? safePath(root, path.relative(root, path.join(commonRoot, id))) : null;
            if (!input.projectId)
                for (const processId of commonIds.filter(id => !input.processId || input.processId === id))
                    result.push({ key: `${sopType}/${language}/common/${processId}`, sopType, language, processId, common: common(processId), project: null, output: common(processId)! });
            for (const projectId of input.projectId ? [input.projectId] : projects) {
                const rawRoot = safePath(root, `product_lib/${projectId}/${sopType}/${language === "中文" ? "CN_process" : "processes"}`);
                for (const processId of directories(rawRoot).filter(id => !input.processId || input.processId === id))
                    result.push({ key: `${sopType}/${language}/${projectId}/${processId}`, sopType, language, processId, projectId, common: common(processId), project: safePath(root, path.relative(root, path.join(rawRoot, processId))), output: safePath(root, `product_lib/${projectId}/${sopType}/${language === "中文" ? "CN_derived" : "derived"}/${processId}`) });
            }
        }
    }
    if (!result.length && (input.projectId || input.sopType || input.processId))
        throw new Error("Filters did not match any Process target.");
    return result;
}
export function readUtf8(file: string): string {
    const bytes=fs.readFileSync(file);
    try{return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);}
    catch{throw new Error(`文件无法按UTF-8读取，可能未解密、损坏或编码不支持：${file}。请在源电脑确认解密并以UTF-8保存后重新上传。`);}
}
