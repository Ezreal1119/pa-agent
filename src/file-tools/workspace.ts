import fs from "node:fs/promises";
import path from "node:path";
import type { FileToolConfig } from "./config.js";
export interface WorkspaceResolvedPath { absolutePath: string; displayPath: string; relativePath: string; root: { kind: "workspace"; root: string }; }
export interface WorkerScope { input: string; output: string; displayPath: string; config: FileToolConfig; visualRequested?: boolean; region?: { left: number; top: number; width: number; height: number }; }
let scope: WorkerScope | undefined;
export function setWorkerScope(value: WorkerScope) { scope = value; }
export function workerScope(): WorkerScope { if (!scope) throw new Error("File worker scope was not initialized."); return scope; }
export async function resolveReadablePath(requested: string, _options?: unknown): Promise<WorkspaceResolvedPath> {
  const job = workerScope();
  if (path.resolve(requested) !== job.input) throw new Error("File is outside this job's read scope.");
  const stat = await fs.lstat(job.input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > job.config.maxFileBytes) throw new Error("Invalid or oversized input file.");
  return { absolutePath: job.input, displayPath: job.displayPath, relativePath: path.basename(job.input), root: { kind: "workspace", root: path.dirname(job.input) } };
}
export async function resolveWorkspaceDestinationPath(requested: string) {
  const job = workerScope(); if (path.resolve(requested) !== job.output) throw new Error("Only the job output may be created.");
  return { absolutePath: job.output, displayPath: path.basename(job.output) };
}
export const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function readString(input: unknown, key: string): string { if (!isRecord(input) || typeof input[key] !== "string" || !(input[key] as string).trim()) throw new Error(`${key} is required.`); return (input[key] as string).trim(); }
export function readOptionalString(input: unknown, key: string): string | undefined { if (!isRecord(input) || input[key] === undefined) return; if (typeof input[key] !== "string") throw new Error(`${key} must be a string.`); return input[key] as string; }
export function readOptionalNumber(input: unknown, key: string): number | undefined { if (!isRecord(input) || input[key] === undefined) return; if (typeof input[key] !== "number" || !Number.isFinite(input[key])) throw new Error(`${key} must be a number.`); return input[key] as number; }
export function safePathParameterDescription(value: string): string { return value + " Output must be a new .xlsx filename in the current session outputs."; }
