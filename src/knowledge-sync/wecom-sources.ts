/** Verified import provenance and backend-owned shared indexes. No model decides ownership. */
import fs from "node:fs/promises";
import path from "node:path";
import {
  hash,
  readJson,
  safePath,
  relative,
  PlanError,
  SyncError,
  type Decision,
} from "./core.js";
import { sectionHash, type Snapshot } from "../wecom-import/snapshot.js";
const marker = "<!-- wecom-source-index:v1 ";
const slots = new Set([
  "accessories",
  "specs",
  "brochure",
  "presentation",
  "user_guide",
  "others",
]);
const hex = /^[a-f0-9]{64}$/;
const fail = (s: string): never => {
  throw new PlanError([s]);
};
export const sourceKey = (docid: string, id: string) =>
  hash(docid + "\0" + id).slice(0, 24);
const clean = (s: string) => s.replace(/[\r\n|<>]/g, " ").trim();
const indexValid = (p: unknown): p is string =>
  typeof p === "string" &&
  /^product-knowledge-vault\/shared\/[A-Za-z0-9_-]+\.md$/.test(p);
const sourceValid = (p: unknown): p is string => {
  try {
    return (
      typeof p === "string" &&
      relative(p) === p &&
      p.endsWith(".md") &&
      !p.startsWith("product-knowledge-vault/") &&
      !p.split("/").some((s) => s.startsWith("."))
    );
  } catch {
    return false;
  }
};
export type Inventory = { id: string; title: string; contentHash: string };
export type WecomInput = {
  docid: string;
  id: string;
  title: string;
  sectionTitle: string;
  version?: string;
  inputHash: string;
  contentHash: string;
  inventory: Inventory[];
  route?: Route;
};
type Route = { indexPath: string; slot: string; legacySources: string[] };
type Member = {
  id: string;
  title: string;
  path: string;
  hash: string;
  contentHash: string;
  products: string[];
  hubs: string[];
  summary: string;
  withdrawn?: boolean;
};
type Index = {
  schema: 1;
  docid: string;
  indexPath: string;
  title: string;
  slot: string;
  inventory: Inventory[];
  members: Member[];
  legacySources: string[];
  legacyOverview?: string;
};
export type WecomContext = WecomInput & {
  indexPath: string;
  slot?: string;
  previous?: Member;
};
export async function incomingWecom(
  dataDir: string,
  name: string,
  inputHash: string,
): Promise<WecomInput | undefined> {
  if (!/^WeCom-[a-f0-9]{16}-.+\.md$/.test(path.basename(name))) return;
  const root = path.join(dataDir, "logs/wecom_sync");
  const state = await readJson<any>(path.join(root, "state.json"), undefined);
  if (
    !state ||
    state.version !== 1 ||
    !state.sources ||
    typeof state.sources !== "object"
  )
    throw new SyncError(
      "WeCom input has no trusted import record. Preserve it and restore the importer state.",
    );
  const matches: { docid: string; id: string; e: any; r: any }[] = [];
  for (const [key, e] of Object.entries<any>(state.sources)) {
    if (!e || hash(e.docid ?? "") !== key)
      throw new SyncError("Invalid WeCom import identity state.");
    if (e.pending?.outputs?.some((o: any) => o.target === name))
      throw new SyncError(
        "WeCom import is still publishing this document. Wait for it to finish.",
      );
    for (const [id, r] of Object.entries<any>(e.sections ?? {}))
      if (r?.target === name) matches.push({ docid: e.docid, id, e, r });
  }
  if (matches.length !== 1 || matches[0]!.r.markdownHash !== inputHash)
    throw new SyncError(
      "WeCom input differs from its verified delivered copy or has ambiguous provenance. Do not rename or edit imported inputs.",
    );
  const { docid, id, e, r } = matches[0]!;
  if (
    !/^[ew]3_[A-Za-z0-9_-]+$/.test(docid) ||
    !name.startsWith(`WeCom-${hash(docid + "\0" + id).slice(0, 16)}-`) ||
    !/^[a-f0-9-]{36}\.json$/.test(e.snapshotFile) ||
    !hex.test(e.snapshotHash)
  )
    throw new SyncError("Invalid WeCom snapshot identity.");
  const file = await safePath(path.join(root, "cache"), e.snapshotFile),
    stat = await fs.stat(file);
  if (stat.size > 16 * 1048576)
    throw new SyncError("WeCom snapshot exceeds 16 MiB.");
  const bytes = await fs.readFile(file);
  if (hash(bytes) !== e.snapshotHash)
    throw new SyncError("WeCom snapshot changed. Restore the trusted cache.");
  const snapshot = JSON.parse(bytes.toString("utf8")) as Snapshot;
  if (
    snapshot.schema !== 1 ||
    snapshot.docid !== docid ||
    !Array.isArray(snapshot.sections) ||
    snapshot.sections.length > 200 ||
    new Set(snapshot.sections.map((s) => s.key)).size !==
      snapshot.sections.length
  )
    throw new SyncError("Invalid WeCom snapshot.");
  const section = snapshot.sections.find((s) => s.key === id);
  if (!section || sectionHash(snapshot, section) !== r.hash)
    throw new SyncError("WeCom section does not match its import receipt.");
  const routes = await routesFor(dataDir);
  const route = routes[docid];
  return {
    docid,
    id,
    title: snapshot.title,
    sectionTitle: section.title,
    version: snapshot.version,
    inputHash,
    contentHash: r.hash,
    inventory: snapshot.sections.map((s) => ({
      id: s.key,
      title: s.title,
      contentHash: sectionHash(snapshot, s),
    })),
    ...(route ? { route } : {}),
  };
}
async function routesFor(dataDir: string): Promise<Record<string, Route>> {
  const policy = await readJson<any>(
    path.join(dataDir, "knowledge-sync/wecom-routing.json"),
    undefined,
  );
  if (policy) {
    if (
      policy.version !== 1 ||
      !policy.documents ||
      typeof policy.documents !== "object" ||
      Array.isArray(policy.documents)
    )
      throw new SyncError("Invalid WeCom routing configuration.");
    for (const [d, p] of Object.entries<any>(policy.documents))
      if (
        !/^[ew]3_[A-Za-z0-9_-]+$/.test(d) ||
        !p ||
        Object.keys(p).some(
          (k) => !["indexPath", "slot", "legacySources"].includes(k),
        ) ||
        !indexValid(p.indexPath) ||
        !slots.has(p.slot) ||
        !Array.isArray(p.legacySources) ||
        p.legacySources.length > 20 ||
        p.legacySources.some((v: any) => !sourceValid(v))
      )
        throw new SyncError(
          "Invalid WeCom route; only a fixed shared index, slot and legacy Markdown sources are accepted.",
        );
  }
  return policy?.documents ?? {};
}
export async function verifyRetirement(
  dataDir: string,
  base: Map<string, string>,
  decision: Decision,
) {
  if (!decision.oldPaths?.length) return;
  const routes = await routesFor(dataDir),
    records = indexes(base),
    docs = new Set<string>();
  for (const x of records)
    if (x.legacySources.some((p) => decision.oldPaths.includes(p)))
      docs.add(x.docid);
  for (const [d, r] of Object.entries(routes))
    if (r.legacySources.some((p) => decision.oldPaths.includes(p))) docs.add(d);
  if (!docs.size) return;
  if (decision.action !== "delete")
    fail(
      "A legacy complete workbook can only be retired through a separate Delete knowledge preview after migration.",
    );
  for (const docid of docs) {
    const x = records.find((x) => x.docid === docid);
    if (!x)
      fail(
        "Legacy workbook retirement is blocked: publish its verified WeCom worksheet replacements first.",
      );
    const root = path.join(dataDir, "logs/wecom_sync");
    const state = await readJson<any>(path.join(root, "state.json"), undefined),
      e = state?.sources?.[hash(docid)];
    if (
      !e ||
      e.docid !== docid ||
      e.pending ||
      !/^[a-f0-9-]{36}\.json$/.test(e.snapshotFile) ||
      !hex.test(e.snapshotHash)
    )
      fail(
        "Legacy retirement requires a complete verified latest import snapshot; wait for imports or restore their state.",
      );
    const file = await safePath(path.join(root, "cache"), e.snapshotFile);
    if ((await fs.stat(file)).size > 16 * 1048576)
      fail("Latest WeCom snapshot is oversized.");
    const bytes = await fs.readFile(file);
    if (hash(bytes) !== e.snapshotHash)
      fail("Latest WeCom snapshot changed; retirement is blocked.");
    const snapshot = JSON.parse(bytes.toString("utf8")) as Snapshot;
    if (
      snapshot.schema !== 1 ||
      snapshot.docid !== docid ||
      !Array.isArray(snapshot.sections) ||
      !snapshot.sections.length ||
      snapshot.sections.length > 200
    )
      fail("Invalid latest WeCom snapshot; retirement is blocked.");
    for (const s of snapshot.sections) {
      const m = x!.members.find(
        (m) =>
          m.id === s.key && !m.withdrawn && !decision.oldPaths.includes(m.path),
      );
      if (
        !m ||
        m.contentHash !== sectionHash(snapshot, s) ||
        !base.has(m.path) ||
        hash(base.get(m.path)!) !== m.hash
      )
        fail(
          `Legacy retirement is blocked: worksheet ${s.title} has no verified published replacement for the latest imported text.`,
        );
    }
  }
}
function namespace(docid: string, id: string, slot: string) {
  return `_shared/${slot}/wecom-${sourceKey(docid, id)}_`;
}
function ownedPath(p: string, docid: string, id: string, slot: string) {
  return (
    sourceValid(p) &&
    p.startsWith(namespace(docid, id, slot)) &&
    p.split("/").length === 4 &&
    /_\d{12}(?:_\d{2,})?$/.test(p.split("/")[2]!)
  );
}
export function indexes(base: Map<string, string>): Index[] {
  const records: Index[] = [];
  for (const [p, t] of base) {
    if (!p.startsWith("product-knowledge-vault/shared/") || !t.includes(marker))
      continue;
    const m = t.match(/<!-- wecom-source-index:v1 ([A-Za-z0-9_-]+) -->/g);
    if (m?.length !== 1)
      fail(
        `Invalid managed WeCom index: ${p}. Restore its backup; it cannot be reset.`,
      );
    let data: Index;
    try {
      data = JSON.parse(
        Buffer.from(m![0]!.slice(marker.length, -4), "base64url").toString(
          "utf8",
        ),
      );
    } catch {
      fail(`Invalid WeCom index metadata: ${p}.`);
    }
    const x = data!;
    if (
      x.schema !== 1 ||
      x.indexPath !== p ||
      !indexValid(p) ||
      !/^([ew]3_)[A-Za-z0-9_-]+$/.test(x.docid) ||
      typeof x.title !== "string" ||
      !slots.has(x.slot) ||
      !Array.isArray(x.inventory) ||
      x.inventory.length > 200 ||
      x.inventory.some(
        (s) =>
          typeof s.id !== "string" ||
          typeof s.title !== "string" ||
          !hex.test(s.contentHash),
      ) ||
      new Set(x.inventory.map((s) => s.id)).size !== x.inventory.length ||
      !Array.isArray(x.members) ||
      x.members.length > 1000 ||
      !Array.isArray(x.legacySources) ||
      x.legacySources.some((s) => !sourceValid(s)) ||
      (x.legacyOverview !== undefined && typeof x.legacyOverview !== "string")
    )
      fail(`Invalid WeCom source index: ${p}.`);
    const ids = new Set<string>();
    for (const member of x.members) {
      if (
        !member ||
        typeof member.id !== "string" ||
        ids.has(member.id) ||
        typeof member.title !== "string" ||
        !ownedPath(member.path, x.docid, member.id, x.slot) ||
        !hex.test(member.hash) ||
        !hex.test(member.contentHash) ||
        !Array.isArray(member.products) ||
        !member.products.length ||
        member.products.some(
          (p) => typeof p !== "string" || !p || /[\\/\x00-\x1f]/.test(p),
        ) ||
        !Array.isArray(member.hubs) ||
        member.hubs.length !== member.products.length ||
        member.hubs.some(
          (h) =>
            typeof h !== "string" ||
            !/^product-knowledge-vault\/products\/[^/]+\.md$/.test(h),
        ) ||
        typeof member.summary !== "string" ||
        member.summary.length > 500 ||
        (member.withdrawn !== undefined &&
          typeof member.withdrawn !== "boolean")
      )
        fail(`Invalid WeCom member in ${p}.`);
      ids.add(member.id);
    }
    if (records.some((r) => r.docid === x.docid))
      fail("A WeCom document has multiple competing managed indexes.");
    if (render(x) !== t)
      fail(
        `Managed WeCom index was edited outside Sync: ${p}. Restore its backup before continuing.`,
      );
    records.push(x);
  }
  return records;
}
export function contextFor(
  input: WecomInput,
  base: Map<string, string>,
): WecomContext {
  const all = indexes(base),
    existing = all.find((x) => x.docid === input.docid);
  const indexPath =
    input.route?.indexPath ??
    existing?.indexPath ??
    `product-knowledge-vault/shared/wecom-${hash(input.docid).slice(0, 24)}.md`;
  if (
    existing &&
    (existing.indexPath !== indexPath ||
      (input.route && existing.slot !== input.route.slot))
  )
    fail(
      "WeCom routing changed after publication. Restore the route; moving a document family requires a separate migration.",
    );
  if (all.some((x) => x.indexPath === indexPath && x.docid !== input.docid))
    fail("This shared index belongs to another WeCom document.");
  if (
    base.has(indexPath) &&
    !existing &&
    (!input.route || !input.route.legacySources.length)
  )
    fail(
      `Existing shared page ${indexPath} requires an explicit wecom-routing.json adoption with legacySources.`,
    );
  if (!existing && input.route?.legacySources.some((p) => !base.has(p)))
    fail(
      "Configured legacy source is missing. Verify the exact VPS Markdown paths before adopting the shared index.",
    );
  if (!existing && !input.route) {
    const normalize = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const titleKey = normalize(input.title);
    const candidates = [...base].filter(
      ([p, t]) =>
        p.startsWith("product-knowledge-vault/shared/") &&
        !t.includes(marker) &&
        titleKey !== "" &&
        normalize(t.match(/^#\s+(.+)$/m)?.[1] ?? "") === titleKey,
    );
    if (candidates.length)
      throw new PlanError(
        [
          `Existing document-family index found: ${candidates.map(([p]) => p).join(", ")}. Configure wecom-routing.json with its indexPath, semantic slot and legacySources before first Sync. No content has been replaced.`,
        ],
        true,
      );
  }
  const previous = existing?.members.find((m) => m.id === input.id);
  if (
    previous &&
    !previous.withdrawn &&
    (!base.has(previous.path) ||
      hash(base.get(previous.path)!) !== previous.hash)
  )
    fail(
      "Registered WeCom source is missing or manually changed. Restore it or explicitly withdraw it through Delete knowledge.",
    );
  if (
    !previous &&
    [...base.keys()].some(
      (p) =>
        p.startsWith(`_shared/`) &&
        p
          .split("/")[2]
          ?.startsWith(`wecom-${sourceKey(input.docid, input.id)}_`),
    )
  )
    fail(
      "An unregistered published WeCom section already exists. Restore the managed index instead of creating a duplicate.",
    );
  return {
    ...input,
    indexPath,
    slot: input.route?.slot ?? existing?.slot,
    previous,
  };
}
const linked = (p: string) =>
  p
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[()]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
function render(x: Index) {
  const esc = (s: string) =>
    clean(s).replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");
  let out = `# ${esc(x.title)}\n\nNavigation for this online document. Detailed facts remain in the linked worksheet/document sources.\n\nOnline source: https://doc.weixin.qq.com/${x.docid.startsWith("e3_") ? "sheet" : "doc"}/${x.docid}\n\n| Worksheet / document | Applicable products | Published text source | Summary |\n| --- | --- | --- | --- |\n`;
  for (const s of x.inventory) {
    const member = x.members.find((m) => m.id === s.id && !m.withdrawn);
    out += `| ${esc(s.title)} | ${member ? member.products.map(esc).join(", ") : "—"} | ${member ? `[Read source](${linked(member.path)})` : "Pending Sync"} | ${member ? esc(member.summary) : "Not yet published"} |\n`;
  }
  const removed = x.members.filter(
    (m) => !x.inventory.some((s) => s.id === m.id) && !m.withdrawn,
  );
  if (removed.length)
    out +=
      "\n## Upstream worksheets no longer listed\n\n" +
      removed
        .map(
          (m) =>
            `- ${esc(m.title)} — [retained source](${linked(m.path)}); removal requires administrator review.`,
        )
        .join("\n") +
      "\n";
  const products = [
    ...new Set(
      x.members.filter((m) => !m.withdrawn).flatMap((m) => m.products),
    ),
  ].sort();
  out +=
    "\n## Product discovery\n\n" +
    products
      .map((p) => {
        const m = x.members.find(
          (m) => !m.withdrawn && m.products.includes(p),
        )!;
        return `- [[${m.hubs[m.products.indexOf(p)]!.slice(24).replace(/\.md$/, "")}|${esc(p)}]]`;
      })
      .join("\n") +
    "\n";
  if (x.legacySources.length) {
    out +=
      "\n## Legacy complete source — migration in progress\n\nPublished worksheet text is current for its listed section. The legacy overview remains as a migration fallback and may contain historical image-derived evidence; review differences before relying on it.\n\n" +
      x.legacySources.map((p) => `- [Legacy source](${linked(p)})`).join("\n") +
      "\n";
    if (x.legacyOverview) out += "\n" + x.legacyOverview.trim() + "\n";
  }
  out += `\n${marker}${Buffer.from(JSON.stringify(x)).toString("base64url")} -->\n`;
  if (Buffer.byteLength(out) > 2 * 1048576)
    fail("Managed WeCom index exceeds 2 MiB.");
  return out;
}
export function hint(ctx: WecomContext) {
  return JSON.stringify({
    docid: ctx.docid,
    sectionId: ctx.id,
    document: ctx.title,
    worksheet: ctx.sectionTitle,
    version: ctx.version,
    indexPath: ctx.indexPath,
    slot: ctx.slot ?? "choose the document family semantic slot",
    allowedSlots: [...slots],
    requiredSourcePrefix: namespace(
      ctx.docid,
      ctx.id,
      ctx.slot ?? "<chosen-slot>",
    ),
    previousSource: ctx.previous?.withdrawn ? undefined : ctx.previous?.path,
    withdrawn: !!ctx.previous?.withdrawn,
    protectedLegacy: ctx.route?.legacySources ?? [],
  });
}
/** Called both by finish_sync and immediately before publication planning. */
export function prepareWecom(
  base: Map<string, string>,
  staged: Map<string, string>,
  decision: Decision,
  markdown: string,
  ctx: WecomContext | undefined,
  deletion: boolean,
  hub: (p: string) => string,
  feedback = "",
): {
  decision: Decision;
  staged: Map<string, string>;
  confirmationReason?: string;
} {
  const all = indexes(base);
  let d = { ...decision, oldPaths: [...decision.oldPaths] },
    next = new Map(staged);
  const controlled = new Set(all.map((x) => x.indexPath));
  if (ctx) controlled.add(ctx.indexPath);
  for (const [p, t] of staged)
    if (controlled.has(p) || t.includes(marker))
      fail(
        "Shared WeCom indexes are maintained by the backend. Read them, but do not stage or forge them.",
      );
  for (const x of all) {
    const touched = x.members.filter(
      (m) => !m.withdrawn && d.oldPaths.includes(m.path),
    );
    const legacy = x.legacySources.filter((p) => d.oldPaths.includes(p));
    if (!deletion) {
      if (legacy.length)
        fail(
          "A worksheet must never replace the legacy complete workbook. Retire it separately after migration.",
        );
      for (const m of touched)
        if (!ctx || ctx.docid !== x.docid || ctx.id !== m.id)
          fail(
            "A Sync input may only replace its own registered WeCom section.",
          );
    } else if (touched.length || legacy.length) {
      for (const m of touched)
        if (m.products.some((p) => !d.products.includes(p)))
          fail(
            "Deleting a managed section requires reviewing every associated product.",
          );
      if (legacy.length) {
        if (
          !x.inventory.length ||
          x.inventory.some((s) => {
            const m = x.members.find(
              (m) =>
                m.id === s.id && !m.withdrawn && !d.oldPaths.includes(m.path),
            );
            return (
              !m ||
              !base.has(m.path) ||
              m.contentHash !== s.contentHash ||
              hash(base.get(m.path)!) !== m.hash
            );
          })
        )
          fail(
            "Legacy workbook retirement is blocked until every expected worksheet has a verified published replacement.",
          );
      }
      const copy = structuredClone(x);
      for (const m of copy.members)
        if (touched.some((t) => t.id === m.id)) m.withdrawn = true;
      copy.legacySources = copy.legacySources.filter(
        (p) => !legacy.includes(p),
      );
      if (!copy.legacySources.length) delete copy.legacyOverview;
      next.set(copy.indexPath, render(copy));
    }
  }
  if (!ctx) return { decision: d, staged: next };
  if (hash(markdown) !== ctx.inputHash)
    fail("Converted WeCom text differs from the verified delivered input.");
  for (const p of staged.keys())
    if (p.startsWith("product-knowledge-vault/shared/") && !base.has(p))
      fail(
        "Do not create competing shared pages for a verified WeCom source; the backend maintains its family index.",
      );
  if (deletion || !["add", "update"].includes(d.action))
    fail(
      "Verified WeCom inputs use add/update or review, not associations or deletion.",
    );
  const existing = all.find((x) => x.docid === ctx.docid),
    previous = existing?.members.find((m) => m.id === ctx.id);
  const restore = !!previous?.withdrawn;
  const restoreInstruction = `RESTORE WECOM ${ctx.docid} ${ctx.id}`;
  if (restore && feedback.trim() !== restoreInstruction)
    throw new PlanError(
      [
        `This section was explicitly withdrawn. To restore its verified delivered input, submit exactly: ${restoreInstruction}. Publication still requires confirmation.`,
      ],
      true,
    );
  const expected = previous && !previous.withdrawn ? [previous.path] : [];
  const action = expected.length ? "update" : "add";
  if (
    d.action !== action ||
    d.oldPaths.length !== expected.length ||
    d.oldPaths.some((p) => !expected.includes(p))
  )
    fail(
      `WeCom section ownership requires action=${action} and oldPaths=${JSON.stringify(expected)}. It cannot replace another source or the whole workbook.`,
    );
  if (!slots.has(d.slot))
    fail(`Unsupported WeCom slot ${JSON.stringify(d.slot)}. Allowed slots: ${[...slots].join(", ")}. Choose one allowed slot for this document family; do not invent a new slot. No source has been published.`);
  const slot = ctx.slot ?? d.slot;
  if (!slots.has(slot) || d.slot !== slot)
    fail(`This WeCom document family requires slot ${JSON.stringify(slot)}. Preserve its registered slot and use the corresponding shared source prefix; moving a family requires a separate migration.`);
  if (!ownedPath(d.newPath ?? "", ctx.docid, ctx.id, slot))
    fail(
      `WeCom source must use ${namespace(ctx.docid, ctx.id, slot)}YYYYMMDDHHmm/<name>.md with slot ${slot}. Do not occupy product-local slots.`,
    );
  if (previous && previous.products.some((p) => !d.products.includes(p)))
    fail(
      "A WeCom section update must preserve its associated products; removing coverage requires separate review.",
    );
  const x: Index = existing
    ? structuredClone(existing)
    : {
        schema: 1,
        docid: ctx.docid,
        indexPath: ctx.indexPath,
        title: ctx.title,
        slot,
        inventory: [],
        members: [],
        legacySources: [...(ctx.route?.legacySources ?? [])],
        ...(base.has(ctx.indexPath)
          ? { legacyOverview: base.get(ctx.indexPath)! }
          : {}),
      };
  x.title = ctx.title;
  x.inventory = ctx.inventory;
  const member: Member = {
    id: ctx.id,
    title: ctx.sectionTitle,
    path: d.newPath!,
    hash: hash(markdown),
    contentHash: ctx.contentHash,
    products: [...d.products],
    hubs: d.products.map(hub),
    summary:
      ctx.id === "document"
        ? "Online document text"
        : "Worksheet text; details in linked source",
  };
  x.members = x.members.filter((m) => m.id !== ctx.id);
  x.members.push(member);
  next.set(x.indexPath, render(x));
  const index = "product-knowledge-vault/index.md",
    link = x.indexPath.slice(24).replace(/\.md$/, "");
  const indexText = next.get(index) ?? base.get(index) ?? "# Knowledge index\n";
  if (
    !indexText.includes(`[[${link}|`) &&
    !indexText.includes(`[[${link}]]`) &&
    !indexText.includes(x.indexPath)
  )
    next.set(index, indexText + `\n- [[${link}|${clean(ctx.title)}]]\n`);
  return {
    decision: d,
    staged: next,
    ...(restore
      ? {
          confirmationReason: `Confirm restoring withdrawn WeCom section: ${ctx.sectionTitle}. Existing independent sources remain unchanged.`,
        }
      : {}),
  };
}
