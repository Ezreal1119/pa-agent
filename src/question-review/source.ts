import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createInterface } from "node:readline";
import { digest } from "./privacy.js";
import { safe } from "./store.js";
import { emptyCoverage, type ReviewCase } from "./types.js";

const textOf = (content: any): string => typeof content === "string" ? content : Array.isArray(content) ? content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("\n") : "";
const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
export async function readCases(dataDir: string, from: string, to: string, signal?: AbortSignal) {
  const root = path.join(dataDir, "sessions"), coverage = emptyCoverage(), cases: ReviewCase[] = [];
  const files: string[] = [];
  const visit = async (dir: string) => {
    await safe(dir);
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === "ENOENT") return []; throw e; })) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) { coverage.unavailable++; continue; }
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
    }
  };
  await visit(root);
  for (const file of files.sort()) {
    signal?.throwIfAborted(); coverage.files++;
    await safe(file);
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (!handle) { coverage.unavailable++; continue; }
    const entries = new Map<string, any>(); let valid = false, sessionId = "";
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) { coverage.unavailable++; continue; }
      if (stat.size > 64 * 1024 * 1024) { coverage.oversized++; continue; }
      if (!stat.size) continue;
      const end = Buffer.alloc(1); await handle.read(end, 0, 1, stat.size - 1);
      const stream = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false });
      let pending: string | undefined;
      const accept = (line: string) => {
        if (line.length > 2 * 1024 * 1024) { coverage.oversized++; return; }
        try {
          const entry = JSON.parse(line);
          if (!valid) { if (entry.type === "session" && typeof entry.id === "string") { valid = true; sessionId = entry.id; } else coverage.corrupt++; return; }
          if (typeof entry.id === "string" && !entries.has(entry.id)) entries.set(entry.id, entry);
        } catch { coverage.corrupt++; }
      };
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        signal?.throwIfAborted(); if (pending !== undefined) accept(pending); pending = line;
      }
      if (pending !== undefined) { if (end[0] === 10) accept(pending); else coverage.corrupt++; }
    } finally { await handle.close(); }
    if (!valid) continue;
    const users = [...entries.values()].filter(e => e.type === "message" && e.message?.role === "user");
    const nearest = (entry: any): any => {
      let current = entry, steps = 0;
      while (current && steps++ < entries.size) {
        if (current.type === "message" && current.message?.role === "user") return current;
        current = entries.get(current.parentId);
      }
    };
    const turns = new Map(users.map(e => [e.id, { entry: e, answers: [] as string[], tools: [] as string[], metric: undefined as any, failedAnswer: false }]));
    const rounds = new Map<string, number>();
    const roundOf = (user: any): number => {
      const chain: any[] = []; let current = user;
      while (current && !rounds.has(current.id) && chain.length <= users.length) { chain.push(current); current = nearest(entries.get(current.parentId)); }
      let count = current ? rounds.get(current.id) ?? 0 : 0;
      for (const entry of chain.reverse()) rounds.set(entry.id, ++count);
      return rounds.get(user.id) ?? 0;
    };
    for (const entry of entries.values()) {
      const owner = nearest(entry); const turn = owner && turns.get(owner.id); if (!turn) continue;
      // A new run's start metric can be written before its user message, with
      // the previous round as parent. Never overwrite that previous completion.
      if (entry.type === "custom" && entry.customType === "web-run-metrics-v1" && entry.data?.round === roundOf(turn.entry)) turn.metric = entry.data;
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg?.role === "assistant") {
        turn.failedAnswer = ["error", "aborted"].includes(msg.stopReason);
        const answer = textOf(msg.content); if (answer) turn.answers.push(answer);
        if (Array.isArray(msg.content)) for (const call of msg.content) if (call?.type === "toolCall") turn.tools.push(JSON.stringify({ tool: call.name, arguments: call.arguments }));
      } else if (msg?.role === "toolResult") turn.tools.push(textOf(msg.content));
    }
    for (const turn of turns.values()) {
      const stamp = time(turn.metric?.startedAt ?? turn.entry.timestamp);
      if (!Number.isFinite(stamp)) { coverage.corrupt++; continue; }
      if (!(stamp >= time(from) && stamp < time(to))) continue;
      const question = textOf(turn.entry.message.content).trim();
      if (!question) { coverage.unavailable++; continue; }
      if (/^\/(?:firmware|clear|new|files|role|welcome|patrick_balance)(?:\s|$)/i.test(question)) continue;
      coverage.scanned++;
      if (turn.metric && turn.metric.status !== "completed" || turn.failedAnswer || !turn.answers.length) { coverage.unfinished++; continue; }
      const answer = turn.answers.join("\n"), rawTools = turn.tools.join("\n"), context: string[] = [];
      let before = entries.get(turn.entry.parentId), count = 0;
      while (before && count < 4) {
        const previous = nearest(before); if (!previous) break;
        const prior = turns.get(previous.id);
        if (prior) context.unshift(JSON.stringify({ question: textOf(prior.entry.message.content), answer: prior.answers.join("\n") }));
        count++; before = entries.get(previous.parentId);
      }
      if (question.length + answer.length > 180000) { coverage.oversized++; continue; }
      const priorText = context.join("\n");
      const limited = rawTools.length > 24000 || priorText.length > 16000 || /attachment|附件|fileId/i.test(question) && !rawTools;
      if (limited) coverage.evidenceLimited++;
      cases.push({ key: digest(JSON.stringify([sessionId, turn.entry.id, question, answer])), question, answer,
        context: priorText.slice(-16000), tools: rawTools.slice(0, 24000), limited });
    }
  }
  const unique = [...new Map(cases.map(c => [c.key, c])).values()]; coverage.eligible = unique.length; coverage.remaining = unique.length;
  return { cases: unique, coverage };
}
