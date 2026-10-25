import { createHash } from "node:crypto";
import type { Run, Scene } from "./domain.js";
import { canonicalUrl } from "./store.js";

export interface Lead {
  id: string;
  url: string;
  title: string;
  summary: string;
  sourceFingerprint?: string;
  publishedAt: string;
  scenes: Scene[];
  state: "unread" | "read" | "unavailable" | "submitted" | "deferred";
  priority: "high" | "normal" | "low";
  reason?: string;
  evidenceId?: string;
  seenAt?: string;
  attemptedAt?: string;
  cooldown?: boolean;
  lastOutcome?: string;
  classification?: "new" | "update" | "duplicate" | "irrelevant" | "pending";
}
export function registerLeads(run: Run, results: unknown, scene: Scene) {
  const leads = (run.leads ??= []);
  if (!Array.isArray(results)) return;
  for (const result of results) {
    if (!result || typeof result !== "object" || typeof result.url !== "string")
      continue;
    let url: string;
    try {
      const parsed = new URL(result.url);
      if (!["https:", "http:"].includes(parsed.protocol)) continue;
      url = canonicalUrl(parsed.toString());
    } catch {
      continue;
    }
    const fingerprint = typeof result.summary === "string" || typeof result.snippet === "string" ? createHash("sha256").update(JSON.stringify([result.title ?? "", result.summary ?? "", result.snippet ?? "", result.date ?? ""])).digest("hex") : undefined;
    const old = leads.find((l) => l.url === url);
    if (old) {
      if (!old.scenes.includes(scene)) old.scenes.push(scene);
      const nextSummary = String(result.summary ?? result.snippet ?? old.summary).slice(0,1200);
      const nextTitle = String(result.title ?? old.title).slice(0,400);
      if (old.summary !== nextSummary || old.title !== nextTitle || (fingerprint && old.sourceFingerprint && fingerprint !== old.sourceFingerprint)) {
        old.title = nextTitle; old.summary = nextSummary; old.state = "unread";
        old.classification = undefined; old.cooldown = false;
      }
      old.sourceFingerprint = fingerprint ?? old.sourceFingerprint;
      old.seenAt = new Date().toISOString();
      continue;
    }
    // Bounded metadata only. Search snippets never become evidence.
    if (leads.length >= 240) continue;
    leads.push({
      id: createHash("sha256").update(url).digest("hex").slice(0, 20),
      url,
      title: String(result.title ?? "").slice(0, 400),
      summary: String(result.summary ?? result.snippet ?? "").slice(0, 1200),
      sourceFingerprint: fingerprint,
      publishedAt: String(result.date ?? "").slice(0, 60),
      scenes: [scene],
      seenAt: new Date().toISOString(),
      state: "unread",
      priority: "normal",
    });
  }
}
export function pendingLeads(run: Run, limit = 12) {
  return (run.leads ?? [])
    .filter((l) => l.state === "unread" || l.state === "read")
    .sort(
      (a, b) =>
        ({ high: 0, normal: 1, low: 2 })[a.priority] -
        { high: 0, normal: 1, low: 2 }[b.priority],
    )
    .slice(0, limit);
}
