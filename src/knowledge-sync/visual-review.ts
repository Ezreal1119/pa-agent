import { hash, SyncError } from "./core.js";

export type VisualIssue = {
  id: string;
  label: string;
  file: string;
  imageHash: string;
  issues: string[];
};
export type VisualReview = {
  sourceHash: string;
  revision: string;
  issues: VisualIssue[];
};
export type VisualResolution = {
  issueId: string;
  sourceHash: string;
  action: "accept" | "supplement";
  text?: string;
};
export type PartialVisualEvidence = VisualIssue & {
  sourceHash: string;
  text: string;
};
export type VisualReviewSubmission = {
  revision: string;
  decisions: { issueId: string; action: "accept" | "supplement" | "retry"; text?: string }[];
};
export function visualIssue(sourceHash: string, imageHash: string, file: string, label: string, text: string, issues: string[]): PartialVisualEvidence {
  return { id: hash(JSON.stringify({ sourceHash, imageHash, label, text, issues })), sourceHash, imageHash, file, label, text, issues };
}
export function visualReview(sourceHash: string, issues: VisualIssue[]): VisualReview {
  return { sourceHash, issues, revision: hash(JSON.stringify({ sourceHash, issues })) };
}
export function resolutionKey(resolutions: VisualResolution[] = []) {
  return hash(JSON.stringify([...resolutions].sort((a, b) => a.issueId.localeCompare(b.issueId))));
}
export class VisualReviewError extends Error {
  constructor(readonly review: VisualReview) {
    super(`Unresolved visual evidence: ${review.issues.length} region(s) need your decision. Readable content and completed regions are retained.`);
  }
}
export function validateVisualSubmission(value: unknown, review: VisualReview | undefined): VisualReviewSubmission {
  if (!review || !value || typeof value !== "object") throw new SyncError("No pending visual review.", 409);
  const input = value as VisualReviewSubmission;
  if (input.revision !== review.revision) throw new SyncError("Visual evidence changed. Refresh before deciding.", 409);
  if (!Array.isArray(input.decisions) || !input.decisions.length || input.decisions.length > review.issues.length ||
      new Set(input.decisions.map(d => d?.issueId)).size !== input.decisions.length ||
      input.decisions.some(d => !d || !review.issues.some(i => i.id === d.issueId) ||
        !["accept", "supplement", "retry"].includes(d.action) ||
        (d.action === "supplement" ? typeof d.text !== "string" || !d.text.trim() || d.text.length > 16000 : d.text !== undefined)))
    throw new SyncError("Choose valid visual issues and actions; supplements require 1–16000 characters.");
  return input;
}
export function visualResolutionNote(issue: VisualIssue, resolution: VisualResolution): string {
  return `\n\n### Visual evidence limitation — ${issue.label}\n\n` +
    `Unresolved source content (administrator reviewed):\n${issue.issues.map(s => `- ${s.replace(/\n/g, " ")}`).join("\n")}\n\n` +
    (resolution.action === "accept"
      ? "Administrator explicitly accepted this local omission. The unreadable content is unknown and must not be inferred."
      : `Administrator supplied the following missing content (not independently verified by OCR):\n\n${resolution.text}`);
}

/** Keep administrator supplements in the full report and source diff, not polling payloads. */
export const compactVisualResolutions = (resolutions?: VisualResolution[]) =>
  resolutions?.map(({ text: _text, ...resolution }) => resolution);
