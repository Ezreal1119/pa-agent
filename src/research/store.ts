import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  localDay,
  scenes,
  ResearchError,
  admitted,
  citations,
  evidenceCheck,
  total,
  terminal,
  type Run,
  type Item,
  type Candidate,
  type Evidence,
  type Verdict,
} from "./domain.js";
export const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export async function atomic(file: string, value: unknown, guard?: () => void) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    const h = await fs.open(tmp, "wx", 0o600);
    try {
      await h.writeFile(JSON.stringify(value, null, 2));
      await h.sync();
    } finally {
      await h.close();
    }
    guard?.();
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
export async function read<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
const validId = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new ResearchError(400, "Invalid ID");
  return id;
};
export class ResearchStore {
  readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();
  private runIndex = new Map<string, ReturnType<typeof runSummary>>();
  constructor(dataDir: string) {
    this.root = path.join(dataDir, "research");
  }
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  async init() {
    await fs.mkdir(path.join(this.root, "library/items"), {
      recursive: true,
      mode: 0o700,
    });
    await fs.mkdir(path.join(this.root, "runs"), {
      recursive: true,
      mode: 0o700,
    });
    const entries = await fs.readdir(path.join(this.root, "runs"), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const r = await this.run(entry.name);
      if (!r) continue;
      if (!terminal(r)) {
        r.state = "interrupted";
        r.stopReason = "服务重启，已审核记录保留";
        r.finishedAt = new Date().toISOString();
        await this.saveRun(r);
      } else this.runIndex.set(r.id, runSummary(r));
    }
    await this.index();
  }
  async runs(): Promise<Run[]> {
    const dirs = await fs.readdir(path.join(this.root, "runs"), {
      withFileTypes: true,
    });
    const out: Run[] = [];
    for (const d of dirs)
      if (d.isDirectory() && /^[a-f0-9-]{36}$/.test(d.name)) {
        const r = await this.run(d.name);
        if (r) out.push(r);
      }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  run(id: string) {
    return read<Run>(path.join(this.root, "runs", validId(id), "run.json"));
  }
  saveRun(run: Run) {
    run.updatedAt = new Date().toISOString();
    return this.serial(async () => {
      await atomic(
        path.join(this.root, "runs", validId(run.id), "run.json"),
        run,
      );
      this.runIndex.set(run.id, runSummary(run));
    });
  }
  runSummaries() {
    return [...this.runIndex.values()].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
  }
  async evidence(runId: string, e: Evidence) {
    await atomic(
      path.join(
        this.root,
        "runs",
        validId(runId),
        "evidence",
        validId(e.id) + ".json",
      ),
      e,
    );
  }
  async loadEvidence(runId: string): Promise<Evidence[]> {
    const dir = path.join(this.root, "runs", validId(runId), "evidence");
    const files = await fs.readdir(dir).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    return (
      await Promise.all(
        files
          .filter((f) => f.endsWith(".json"))
          .map((f) => read<Evidence>(path.join(dir, f))),
      )
    ).filter((e): e is Evidence => !!e);
  }
  item(id: string) {
    return read<Item>(
      path.join(this.root, "library/items", validId(id) + ".json"),
    );
  }
  async items(): Promise<Item[]> {
    const files = await fs.readdir(path.join(this.root, "library/items"));
    return (
      await Promise.all(
        files
          .filter((f) => f.endsWith(".json"))
          .map((f) => read<Item>(path.join(this.root, "library/items", f))),
      )
    ).filter((e): e is Item => !!e);
  }
  async summaries(): Promise<ReturnType<typeof itemSummary>[]> {
    return (
      (await read<ReturnType<typeof itemSummary>[]>(
        path.join(this.root, "library/index.json"),
      )) ?? []
    );
  }
  async index() {
    const rows = [];
    for (const file of await fs.readdir(
      path.join(this.root, "library/items"),
    )) {
      if (!file.endsWith(".json")) continue;
      const item = await read<Item>(
        path.join(this.root, "library/items", file),
      );
      if (item) rows.push(itemSummary(item));
    }
    await atomic(path.join(this.root, "library/index.json"), rows);
  }
  async archive(id: string, reason: string) {
    if (!reason.trim() || reason.length > 2000)
      throw new ResearchError(400, "请填写归档原因（最多2000字）");
    return this.serial(async () => {
      const i = await this.item(id);
      if (!i) throw new ResearchError(404, "资讯不存在");
      i.archived = { reason, at: new Date().toISOString() };
      i.version++;
      i.updatedAt = i.archived.at;
      await atomic(path.join(this.root, "library/items", i.id + ".json"), i);
      await this.index();
      return i;
    });
  }
  async commit(
    run: Run,
    c: Candidate,
    v: Verdict,
    evidence: Evidence[],
    guard: () => void,
  ): Promise<
    | { id: string; kind: string; score: number; progressKey?: string }
    | undefined
  > {
    return this.serial(async () => {
      guard();
      if (!admitted(v, c, run.config)) return;
      evidenceCheck(c, evidence);
      const operation = run.id + ":" + c.id;
      const all = await this.items();
      const already = all.find((i) =>
        i.history.some((h) => h.operation === operation),
      );
      if (already)
        return { id: already.id, kind: "replay", score: already.score };
      let old = c.targetId ? all.find((i) => i.id === c.targetId) : undefined;
      if (
        c.action !== "new" &&
        (!old || old.archived || old.version !== c.expectedVersion)
      )
        throw new ResearchError(409, "条目版本已变化，请重新读取并提交");
      if (c.action === "new") {
        if (c.targetId) throw new ResearchError(400, "新条目不能指定 targetId");
        const urls = new Set(
          evidence
            .filter(
              (e) =>
                e.kind === "web" &&
                citations(c.article).some((r) => r.evidenceId === e.id),
            )
            .map((e) => canonicalUrl(e.locator)),
        );
        const duplicate = all.find(
          (i) =>
            i.article.eventKey.toLowerCase() ===
              c.article.eventKey.toLowerCase() ||
            i.id === v.duplicateOf ||
            (i.article.disclosureDate === c.article.disclosureDate &&
              i.evidence.some(
                (e) => e.kind === "web" && urls.has(canonicalUrl(e.locator)),
              ) &&
              i.article.companies.some((n) => c.article.companies.includes(n))),
        );
        if (duplicate)
          throw new ResearchError(
            409,
            `同一事件已存在：${duplicate.id}，请提交补充`,
          );
        if (!run.days.includes(c.article.disclosureDate))
          throw new ResearchError(400, "新事件披露日期不在本次十四天范围内");
      }
      if (
        old &&
        c.action !== "correction" &&
        old.article.facts.some(
          (fact) => !c.article.facts.some((next) => next.claim === fact.claim),
        )
      )
        throw new ResearchError(
          400,
          "补充必须保留原有事实；需要修正或删除旧事实时请使用 correction 并说明依据",
        );
      if (
        old &&
        c.action !== "correction" &&
        old.article.disclosureDate !== c.article.disclosureDate
      )
        throw new ResearchError(
          400,
          "补充不得改变归档日期；日期纠错请使用 correction",
        );
      if (c.action !== "new" && v.duplicateOf && v.duplicateOf !== old?.id)
        throw new ResearchError(409, "审核识别出不同的重复条目");
      for (const id of c.article.relatedIds)
        if (!all.some((i) => i.id === id))
          throw new ResearchError(400, "关联条目不存在");
      const refs = new Set(citations(c.article).map((r) => r.evidenceId));
      const used = evidence.filter((e) => refs.has(e.id));
      const now = new Date().toISOString();
      const score = total(v.scores, run.config.weights);
      const item: Item = {
        id: old?.id ?? randomUUID(),
        version: (old?.version ?? 0) + 1,
        article: c.article,
        evidence: used,
        score,
        review: v,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        history: [
          ...(old?.history ?? []),
          {
            operation,
            at: now,
            reason: c.reason,
            article: c.article,
            review: v,
            evidence: used,
          },
        ],
      };
      guard();
      await atomic(
        path.join(this.root, "library/items", item.id + ".json"),
        item,
        guard,
      );
      await this.index();
      return {
        id: item.id,
        kind: !old
          ? "new"
          : c.action === "sources"
            ? "sources"
            : v.material
              ? "update"
              : "sources",
        score,
        progressKey: hash(
          JSON.stringify([
            item.id,
            item.article.facts,
            item.article.competition,
            item.article.status,
          ]),
        ),
      };
    });
  }
}
export function manifest(i: Item) {
  return {
    id: i.id,
    version: i.version,
    date: i.article.disclosureDate,
    scene: i.article.scene,
    title: i.article.title,
    eventKey: i.article.eventKey,
    companies: i.article.companies,
    news: i.article.brief.news,
    score: i.score,
    updatedAt: i.updatedAt,
    archived: !!i.archived,
  };
}
export function itemSummary(i: Item) {
  return {
    ...manifest(i),
    brief: i.article.brief,
    tags: i.article.tags,
    status: i.article.status,
    urls: i.evidence.filter((e) => e.kind === "web").map((e) => e.locator),
  };
}
export function digest(items: Item[], days: string[]) {
  let text = `# UROVO 行业资讯：${days[0]} — ${days.at(-1)}\n\n`;
  for (const date of days) {
    text += `## ${date}\n\n`;
    const rows = items.filter(
      (i) =>
        !i.archived &&
        i.article.status === "active" &&
        i.article.disclosureDate === date,
    );
    if (!rows.length) {
      text += "暂无合格资讯；请结合覆盖状态查看是否已检索。\n\n";
      continue;
    }
    for (const [scene, label] of Object.entries(scenes)) {
      const group = rows
        .filter((i) => i.article.scene === scene)
        .sort((a, b) => b.score - a.score);
      if (!group.length) continue;
      text += `### ${label}\n\n`;
      for (const i of group) {
        text += `#### ${i.article.title}\n\n${i.article.brief.news}\n\n销售参考：${i.article.brief.sales}\n\n`;
        text +=
          i.evidence
            .filter((e) => e.kind === "web")
            .map((e) => `- ${e.locator}`)
            .join("\n") + "\n\n";
        if (localDay(i.updatedAt) > days.at(-1)!)
          text += `后续补充：${i.updatedAt}\n\n`;
      }
    }
  }
  return text;
}

export function canonicalUrl(value: string) {
  try {
    const u = new URL(value);
    u.hash = "";
    for (const key of [...u.searchParams.keys()])
      if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return value;
  }
}

export function runSummary(r: Run) {
  const { background, candidates, ...rest } = r;
  return structuredClone({
    ...rest,
    pending: candidates.filter((c) => !c.outcome).length,
    candidates: candidates.map((c) => ({
      id: c.id,
      title: c.article.title,
      action: c.action,
      outcome: c.outcome ?? "pending",
    })),
  });
}
