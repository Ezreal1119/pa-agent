import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileHash, resolveSources, sha, sourceOrderForSopType, walk, type Target } from "./library-source.js";
import { yieldLibraryTurn } from "./library-yield.js";

export type RawSnapshot = Map<string, string>;

function rawFile(relative: string): boolean {
    const parts = relative.split(path.sep);
    return ["processes_lib", "product_lib"].includes(parts[0] ?? "")
        && !parts.some(part => part === "derived" || part === "CN_derived")
        && !["summary.json", "overview.json"].includes(parts.at(-1) ?? "")
        && (parts.at(-1)?.toLowerCase() === "metadata" || /\.(?:txt|jsonl?|png|jpe?g)$/iu.test(parts.at(-1) ?? ""));
}

// Hash file contents, never mtime/size. Only digests remain in memory on small VPSes.
export async function scanRawLibrary(root: string, signal: AbortSignal): Promise<RawSnapshot> {
    const result: RawSnapshot = new Map();
    for (const absolute of walk(root)) {
        const relative = path.relative(root, absolute);
        if (!rawFile(relative)) continue;
        await yieldLibraryTurn(signal);
        result.set(relative, fileHash(absolute)!);
    }
    return result;
}

export function snapshotsEqual(left: RawSnapshot, right: RawSnapshot): boolean {
    return left.size === right.size && [...left].every(([file, hash]) => right.get(file) === hash);
}

// A deployed source/summary resolver change invalidates the shortcut on the next run.
export function summaryImplementationHash(): string {
    const moduleFile = fileURLToPath(import.meta.url);
    const directory = path.dirname(moduleFile);
    const extension = path.extname(moduleFile);
    const files = [
        moduleFile,
        path.join(directory, `library-summaries${extension}`),
        path.join(directory, `library-source${extension}`),
        path.resolve(directory, "../../resources/ckd-maintenance/summary-sync-core.cjs")
    ];
    return sha(Buffer.concat(files.map(file => fs.readFileSync(file))));
}

export function summarySourceSignature(root: string, target: Target, snapshot: RawSnapshot, implementation: string): string {
    const prefixes = [target.common, target.project].filter((value): value is string => !!value)
        .map(directory => path.relative(root, directory) + path.sep);
    const files = [...snapshot].filter(([relative]) => prefixes.some(prefix => relative.startsWith(prefix)));
    const resolved = resolveSources(target.common, target.project, target.sopType, target.language);
    const layout = sourceOrderForSopType(target.sopType).map(spec => {
        const item = resolved[spec.file]!;
        return [spec.file, item.source, item.selectedFile ?? null,
            item.filePath ? path.relative(root, item.filePath) : null,
            item.directoryPath ? path.relative(root, item.directoryPath) : null,
            item.directoryPresent ?? null,
            (item.photos ?? []).map(photo => [photo.index, photo.fileName, path.relative(root, photo.filePath)])];
    });
    return sha(JSON.stringify({ implementation, key: target.key, files, layout }));
}
