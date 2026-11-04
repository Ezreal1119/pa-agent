import type { MaintenanceInput } from "./library-source.js";
import type { LibraryModel } from "./library-model.js";
export type LibraryJobKind = "translate" | "summaries" | "sync";
export interface ManagedTranslation {
    source: string;
    target: string;
    sourceHash: string;
    targetHash: string;
    language: "English" | "中文";
    model: string;
}
export interface LibraryJobItem {
    key: string;
    status: "updated" | "reused" | "skipped" | "planned" | "conflict" | "error";
    message?: string;
}
export interface PendingWrite {
    relative: string;
    before: string | null;
    after: string | null;
    staged?: string;
    directory?: boolean;
    backup?: string;
    translation?: ManagedTranslation;
    previousTranslation?: ManagedTranslation;
    previousSourceTranslation?: ManagedTranslation;
}
export interface LibraryJob {
    schemaVersion: 1;
    id: string;
    kind: LibraryJobKind;
    libraryPath: string;
    input: MaintenanceInput;
    status: "running" | "interrupted" | "completed" | "partial_failed" | "failed" | "cancelled";
    createdAt: string;
    updatedAt: string;
    ownerPid?: number;
    currentItem?: string;
    total: number;
    completed: number;
    counts: Record<LibraryJobItem["status"], number>;
    items: LibraryJobItem[];
    warnings: string[];
    error?: string;
    imageContext?: import("./image-scorer.js").ScoringContext;
    sync?: import("./library-sync.js").SyncProgress;
    pending?: {
        key: string;
        sources: Record<string, string | null>;
        writes: PendingWrite[];
        journal?: string;
    };
}
export interface LibraryMaintenanceOptions {
    dataDir: string;
    libraryPath: string;
    model?: LibraryModel;
    modelTimeoutMs?: number;
    onEvent?: (message: string) => void;
    imageChecker?: import("./image-scorer.js").ImageScorer;
}
export interface MaintenanceContext {
    root: string;
    directory: string;
    job: LibraryJob;
    signal: AbortSignal;
    model: LibraryModel;
    translations: Record<string, ManagedTranslation>;
    save(): void;
    record(item: LibraryJobItem): void;
    warning(message: string): void;
    commit(key: string, sources: Record<string, string | null>, writes: {
        relative: string;
        data: Buffer | null;
        directory?: boolean;
        before: string | null;
        translation?: ManagedTranslation;
        previousTranslation?: ManagedTranslation;
    }[]): void;
    textTranslation(text: string, language: "English" | "中文"): Promise<{
        text: string;
        model: string;
    }>;
}
