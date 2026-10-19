import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { safeDirectory } from "../file-tools/store.js";

export type Observation = { botId: string; userId: string; chatType: "single" | "group"; chatId?: string; at: number };
export type TokenUsage = { input: number; output: number; requests: number; reportedRequests: number };
type Stats = { since: number; questions: number; inputTokens: number; outputTokens: number; requests: number; reportedRequests: number; finishedRuns: number; coveredRuns: number };
type RunSnapshot = { id: string; sequence: number; startedAt: string; status: string; usage?: TokenUsage; wecom?: Observation };
type Cursor = { sequence: number; runId: string; contactId: string; usage: TokenUsage; finished: boolean; covered: boolean };
type Database = { version: 1; contacts: Contact[]; cursors?: Record<string, Cursor> };
const count = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const validUsage = (u: TokenUsage) => u && [u.input, u.output, u.requests, u.reportedRequests].every(count) && u.reportedRequests <= u.requests;
type Contact = { id: string; botId: string; userId: string; name: string; firstSeen: number; lastSeen: number; types: string[]; groups: string[]; stats?: Stats };
export const contactId = (botId: string, userId: string) => createHash("sha256").update(JSON.stringify([botId, userId])).digest("hex");
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(value);
export function observation(input: unknown): Observation {
  const value = input as Observation;
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !["botId", "userId", "chatType", "chatId", "at"].includes(key)) || !identity(value.botId) || !identity(value.userId) || !["single", "group"].includes(value.chatType) || value.chatType === "group" && !identity(value.chatId) || !Number.isSafeInteger(value.at) || value.at < 0 || value.at > Date.now() + 86400000) throw new Error("Invalid WeCom identity record.");
  return { botId: value.botId, userId: value.userId, chatType: value.chatType, ...(value.chatType === "group" ? { chatId: value.chatId } : {}), at: value.at };
}

/** Sole writer is the Web backend; Bridge registers identities over the scoped API. */
export class WecomContacts {
  private readonly directory: string;
  private readonly file: string;
  private tail = Promise.resolve();
  constructor(dataDir: string) {
    let ancestor = path.resolve(dataDir);
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    this.directory = path.join(realpathSync(ancestor), path.relative(ancestor, path.resolve(dataDir)), "wecom");
    this.file = path.join(this.directory, "contacts.json");
  }
  private async read(): Promise<Database> {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error("WeCom contacts must be stored in a bounded regular file.");
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.contacts) || data.contacts.some((c: Contact) => !c || !identity(c.botId) || !identity(c.userId) || c.id !== contactId(c.botId, c.userId) || typeof c.name !== "string" || c.name.length > 80 || /[\u0000-\u001f\u007f]/.test(c.name) || !Number.isSafeInteger(c.firstSeen) || !Number.isSafeInteger(c.lastSeen) || !Array.isArray(c.types) || c.types.some(type => !["single", "group"].includes(type)) || !Array.isArray(c.groups) || c.groups.length > 100 || c.groups.some(id => !identity(id)))) throw new Error("Invalid WeCom contact data; existing names will not be reset.");
      if (data.contacts.some((c: Contact) => c.stats && (![c.stats.since, c.stats.questions, c.stats.inputTokens, c.stats.outputTokens, c.stats.requests, c.stats.reportedRequests, c.stats.finishedRuns, c.stats.coveredRuns].every(count) || c.stats.coveredRuns > c.stats.finishedRuns || c.stats.finishedRuns > c.stats.questions || c.stats.reportedRequests > c.stats.requests))) throw new Error("Invalid WeCom statistics.");
      const ids = new Set(data.contacts.map((contact: Contact) => contact.id));
      if (data.cursors && (typeof data.cursors !== "object" || Array.isArray(data.cursors) || Object.entries(data.cursors).some(([id, item]) => {
        const c = item as Cursor;
        return !identity(id) || !c || !count(c.sequence) || !identity(c.runId) || !ids.has(c.contactId) || !validUsage(c.usage) || typeof c.finished !== "boolean" || typeof c.covered !== "boolean";
      }))) throw new Error("Invalid WeCom statistics cursor.");
      return data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, contacts: [] }; throw error; }
  }
  private merge(contacts: Contact[], item: Observation) {
    const id = contactId(item.botId, item.userId);
    let contact = contacts.find(c => c.id === id);
    if (!contact) {
      if (contacts.length >= 10000) throw new Error("The WeCom contact limit has been reached.");
      contact = { id, botId: item.botId, userId: item.userId, name: "", firstSeen: item.at, lastSeen: item.at, types: [], groups: [] }; contacts.push(contact);
    }
    contact.firstSeen = Math.min(contact.firstSeen, item.at); contact.lastSeen = Math.max(contact.lastSeen, item.at);
    if (!contact.types.includes(item.chatType)) contact.types.push(item.chatType);
    if (item.chatId && !contact.groups.includes(item.chatId) && contact.groups.length < 100) contact.groups.push(item.chatId);
    return contact;
  }
  private work<T>(change: (contacts: Contact[], data: Database) => Promise<T> | T): Promise<T> {
    const work = this.tail.then(async () => {
      await safeDirectory(this.directory);
      const data = await this.read(); const result = await change(data.contacts, data);
      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error("The WeCom contacts and statistics file has reached its size limit.");
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, serialized, { flag: "wx", mode: 0o600 }); await fs.rename(temporary, this.file); }
      finally { await fs.rm(temporary, { force: true }); }
      return result;
    });
    this.tail = work.then(() => {}, () => {}); return work;
  }
  record(input: unknown) { const value = observation(input); return this.work(contacts => structuredClone(this.merge(contacts, value))); }
  /** Per-session monotonic cursor: retries/recovery cannot count a run or its usage twice.
   * Keep cursors after session deletion; storage grows with sessions, not tool/model requests. */
  recordRun(sender: Observation, sessionId: string, run: RunSnapshot) {
    return this.work((contacts, data) => this.applyRun(contacts, data, sender, sessionId, run));
  }
  recoverSession(sessionId: string, runs: RunSnapshot[]) {
    const attributed = runs.filter(run => run.wecom && run.usage);
    if (!attributed.length) return Promise.resolve();
    // One read/write for the whole recovered session, even with years of runs.
    return this.work((contacts, data) => {
      for (const run of attributed) this.applyRun(contacts, data, run.wecom!, sessionId, run);
    });
  }
  private applyRun(contacts: Contact[], data: Database, sender: Observation, sessionId: string, run: RunSnapshot) {
    const who = observation(sender);
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(sessionId) || !identity(run.id) || !count(run.sequence) || run.sequence < 1 || !Number.isFinite(Date.parse(run.startedAt)) || !validUsage(run.usage!)) throw new Error("Invalid WeCom run statistics.");
    const contact = this.merge(contacts, who);
    const cursors = data.cursors ??= {};
    const previous = Object.hasOwn(cursors, sessionId) ? cursors[sessionId] : undefined;
    if (previous && run.sequence < previous.sequence) return;
    if (previous && run.sequence === previous.sequence && (run.id !== previous.runId || previous.contactId !== contact.id)) throw new Error("The WeCom run identity conflicts with its statistics cursor.");
    const sameRun = previous?.runId === run.id;
    const usage = structuredClone(run.usage!);
    if (sameRun && (usage.requests < previous!.usage.requests || usage.reportedRequests < previous!.usage.reportedRequests || usage.input < previous!.usage.input || usage.output < previous!.usage.output)) return;
    const finished = run.status !== "running";
    if (sameRun && previous!.finished && !finished) return;
    const covered = finished && usage.requests > 0 && usage.reportedRequests === usage.requests;
    const stats = contact.stats ??= { since: Date.parse(run.startedAt), questions: 0, inputTokens: 0, outputTokens: 0, requests: 0, reportedRequests: 0, finishedRuns: 0, coveredRuns: 0 };
    stats.since = Math.min(stats.since, Date.parse(run.startedAt));
    if (!sameRun) stats.questions++;
    stats.inputTokens += usage.input - (sameRun ? previous!.usage.input : 0);
    stats.outputTokens += usage.output - (sameRun ? previous!.usage.output : 0);
    stats.requests += usage.requests - (sameRun ? previous!.usage.requests : 0);
    stats.reportedRequests += usage.reportedRequests - (sameRun ? previous!.usage.reportedRequests : 0);
    stats.finishedRuns += Number(finished) - Number(sameRun && previous!.finished);
    stats.coveredRuns += Number(covered) - Number(sameRun && previous!.covered);
    cursors[sessionId] = { sequence: run.sequence, runId: run.id, contactId: contact.id, usage, finished, covered };
  }
  rename(id: string, input: unknown) {
    const value = input as { name: string };
    if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || typeof value.name !== "string" || value.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value.name)) throw new Error("Display names must be at most 80 characters without line breaks or control characters. Leave empty to clear.");
    return this.work(contacts => { const contact = contacts.find(c => c.id === id); if (!contact) return undefined; contact.name = value.name.trim(); return structuredClone(contact); });
  }
  list() {
    return this.work(async contacts => {
      // Import identities already seen before this feature existed; never write bridge-state.json.
      let state;
      try {
        const file = path.join(this.directory, "bridge-state.json"); const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error("WeCom mappings must be stored in a bounded regular file.");
        state = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const [key, entry] of Object.entries(state?.conversations ?? {})) {
        const [botId, type, userId] = JSON.parse(key); const at = (entry as { updated: number }).updated;
        if (type === "single") this.merge(contacts, observation({ botId, userId, chatType: "single", at }));
      }
      for (const job of state?.jobs ?? []) {
        if (!job.userId || !job.botId || !job.key) continue;
        const [, type, target] = JSON.parse(job.key);
        this.merge(contacts, observation({ botId: job.botId, userId: job.userId, chatType: type, ...(type === "group" ? { chatId: target } : {}), at: job.created }));
      }
      return structuredClone(contacts).sort((a, b) => b.lastSeen - a.lastSeen);
    });
  }
}
