import path from "node:path";
import {
  excluded,
  fingerprint,
  timestamp,
  relative,
  PlanError,
  SyncError,
  type Decision,
  type Plan,
} from "./core.js";
const slots = new Set([
  "brochure",
  "specs",
  "user_guide",
  "presentation",
  "accessories",
  "others",
]);
export function references(
  text: string,
  files: Map<string, string>,
  from = "",
): string[] {
  const found: string[] = [];
  for (const name of files.keys()) {
    const vault = name.startsWith("product-knowledge-vault/")
      ? name.slice(24).replace(/\.md$/, "")
      : null;
    if (
      text.includes(name) ||
      (vault &&
        (text.includes(`[[${vault}|`) ||
          text.includes(`[[${vault}]]`) ||
          text.includes(`[[${vault}.md`)))
    )
      found.push(name);
  }
  for (const link of links(text)) {
    let target = link.target.split("#")[0]!;
    try {
      target = decodeURIComponent(target);
    } catch {}
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    const candidates = link.wiki
      ? [
          `product-knowledge-vault/${target.replace(/\.md$/, "")}.md`,
          path.posix.normalize(
            path.posix.join(
              path.posix.dirname(from),
              `${target.replace(/\.md$/, "")}.md`,
            ),
          ),
        ]
      : [
          target,
          path.posix.normalize(
            path.posix.join(path.posix.dirname(from), target),
          ),
        ];
    for (const candidate of candidates)
      if (files.has(candidate)) found.push(candidate);
    if (link.wiki && !target.includes("/"))
      for (const name of files.keys())
        if (path.posix.basename(name, ".md") === target.replace(/\.md$/, ""))
          found.push(name);
  }
  return [...new Set(found)];
}
const indexes = new WeakMap<Map<string, string>, Map<string, string[]>>();
export function primeIndex(base: Map<string, string>) {
  let index = indexes.get(base);
  if (!index) {
    index = new Map();
    for (const [p, t] of base)
      if (
        p.startsWith("product-knowledge-vault/") &&
        p !== "product-knowledge-vault/log.md"
      )
        index.set(p, references(t, base, p));
    indexes.set(base, index);
  }
  return index;
}
export function dependents(base: Map<string, string>, paths: string[]) {
  const found = new Set(paths);
  let added = true;
  const index = primeIndex(base);
  while (added) {
    added = false;
    for (const [p, refs] of index)
      if (!found.has(p) && refs.some((r) => found.has(r))) {
        found.add(p);
        added = true;
      }
  }
  return [...found].filter((p) => !paths.includes(p));
}

function links(text: string) {
  return [...text.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]|\]\(([^)]+)\)/g)].map(
    (m) => ({
      target: (m[1] ?? m[2] ?? "").trim().replace(/^<|>$/g, ""),
      wiki: !!m[1],
    }),
  );
}
const hubPattern = /^product-knowledge-vault\/products\/[^/]+\.md$/;
const hubKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
/**
 * The Hub the backend expects for a product directory: the same-named page, or
 * the single existing Hub whose name differs only in spacing/punctuation/case
 * (for example `K388 Pro` → `K388-Pro.md`).
 */
export function resolveHub(base: Map<string, string>, product: string) {
  const canonical = `product-knowledge-vault/products/${product}.md`;
  if (base.has(canonical)) return canonical;
  const key = hubKey(product);
  if (!key) return canonical;
  const matches = [...base.keys()].filter(
    (p) => hubPattern.test(p) && hubKey(path.posix.basename(p, ".md")) === key,
  );
  return matches.length === 1 ? matches[0]! : canonical;
}
/** Map original binaries in oldPaths to their Markdown companion; drop duplicates. */
export function normalizeOldPaths(
  base: Map<string, string>,
  oldPaths: string[],
) {
  const result: string[] = [];
  for (const p of oldPaths) {
    let target = p;
    if (!base.has(p) && !p.endsWith(".md")) {
      const companion = `${p.replace(/\.[^./]+$/, "")}.md`;
      if (base.has(companion)) target = companion;
      else if (
        oldPaths.some(
          (o) =>
            o !== p &&
            base.has(o) &&
            path.posix.dirname(o) === path.posix.dirname(p),
        )
      )
        continue;
    }
    if (!result.includes(target)) result.push(target);
  }
  return result;
}
const reviewProblems = [/^New products require administrator feedback/];
export function buildPlan(
  base: Map<string, string>,
  staged: Map<string, string>,
  d: Decision,
  markdown: string,
  feedback: string,
  deletion = false,
): Plan {
  if (
    d.suggestedFeedback !== undefined &&
    (d.action !== "review" ||
      typeof d.suggestedFeedback !== "string" ||
      !d.suggestedFeedback.trim() ||
      d.suggestedFeedback.length > 16000)
  )
    throw new SyncError(
      "Suggested instructions are review-only drafts of at most 16000 characters.",
    );
  if (d.action === "review")
    return { decision: d, changes: [], baseline: fingerprint(base) };
  const problems: string[] = [];
  const fail = (message: string) => {
    if (!problems.includes(message)) problems.push(message);
  };
  const valid = (p: string) => {
    try {
      relative(p);
      return true;
    } catch {
      return false;
    }
  };
  if (deletion !== (d.action === "delete"))
    fail(
      deletion
        ? "Wrong operation in candidate plan: a deletion preview must use action=delete (or review)."
        : "Wrong operation in candidate plan: a synced input must use add, update or review.",
    );
  if (
    [...staged.values()].reduce(
      (sum, text) => sum + Buffer.byteLength(text),
      0,
    ) >
    8 * 1024 * 1024
  )
    fail("Candidate index text exceeds 8 MiB.");
  d = {
    ...d,
    products: d.products ?? [],
    oldPaths: normalizeOldPaths(base, d.oldPaths ?? []),
    reviewedPaths: d.reviewedPaths ?? [],
  };
  // Per-attempt Hub selection, never a persistent product mapping. Only a Hub
  // other than the resolved one requires a separate administrator confirmation.
  const resolved = new Map(d.products.map((p) => [p, resolveHub(base, p)]));
  const hubs = new Map(resolved);
  const selectedProducts = new Set<string>();
  for (const selection of d.productHubs ?? []) {
    if (
      !d.products.includes(selection.product) ||
      selectedProducts.has(selection.product)
    ) {
      fail("Hub selection must identify each affected product at most once.");
      continue;
    }
    if (
      !valid(selection.path) ||
      !hubPattern.test(selection.path) ||
      excluded(selection.path)
    ) {
      fail(`Invalid product Hub selection: ${selection.path}`);
      continue;
    }
    if (
      selection.path !== resolved.get(selection.product) &&
      !base.has(selection.path)
    ) {
      fail(
        `Choose an existing Hub or the resolved Hub path for ${selection.product}: ${resolved.get(selection.product)}`,
      );
      continue;
    }
    hubs.set(selection.product, selection.path);
    selectedProducts.add(selection.product);
  }
  if (new Set(hubs.values()).size !== hubs.size)
    fail("Different products cannot share one product Hub.");
  const noncanonical = [...hubs].filter(([p, h]) => h !== resolved.get(p));
  const confirmationReason = noncanonical.length
    ? `Confirm product Hub selection: ${noncanonical.map(([p, h]) => `${p} → ${h}`).join("; ")}`
    : undefined;
  // Historical log content is owned by the backend and can only be appended.
  staged = new Map(staged);
  const logPath = "product-knowledge-vault/log.md";
  const previousLog = base.get(logPath) ?? "";
  const entry = (d.logEntry ?? `${d.summary}\n\n${d.reason}`).trim();
  if (!entry || Buffer.byteLength(entry) > 16000)
    fail("Log entry must contain 1–16000 UTF-8 bytes.");
  const appendedLog = `${previousLog}${previousLog.endsWith("\n") || !previousLog ? "" : "\n"}\n### ${timestamp()} · ${d.action} · ${d.products.join(", ")}\n\n${entry}\n`;
  if (Buffer.byteLength(appendedLog) > 2 * 1024 * 1024)
    fail("Appended knowledge log exceeds 2 MiB.");
  staged.set(logPath, appendedLog);
  const next = new Map(base),
    allowedDeletes = new Set(d.oldPaths);
  if (
    !d.products.length ||
    d.products.some(
      (p) => !p || p.includes("/") || p.includes("\\") || p.startsWith("."),
    )
  )
    fail("Explicit canonical products are required.");
  if (!d.reason?.trim() || !d.summary?.trim())
    fail("A decision and change explanation are required.");
  for (const old of d.oldPaths) {
    if (
      !valid(old) ||
      excluded(old) ||
      !base.has(old) ||
      old.startsWith("product-knowledge-vault/")
    ) {
      fail(
        `Invalid source replacement: ${old} — oldPaths must list current source Markdown paths from list_knowledge (not originals or Vault pages).`,
      );
      allowedDeletes.delete(old);
      continue;
    }
    if (!old.startsWith("_shared/") && !d.products.includes(old.split("/")[0]!))
      fail(
        `Deleted source product is missing from the decision: ${old.split("/")[0]}`,
      );
  }
  if (d.action === "add" && d.oldPaths.length)
    fail("Invalid add/update/delete source list: add must not list oldPaths.");
  if (d.action === "update" && !d.oldPaths.length)
    fail(
      "Invalid add/update/delete source list: update must list the replaced oldPaths.",
    );
  if (deletion && !d.oldPaths.length)
    fail(
      "Invalid add/update/delete source list: delete must list the removed oldPaths.",
    );
  if (
    d.action === "update" &&
    (!d.versionEvidence?.trim() || (d.authorizedException && !feedback.trim()))
  )
    fail("Update requires evidence of a newer version or administrator feedback.");
  let newSource: string | undefined;
  if (!deletion) {
    const candidate = d.newPath ?? "";
    const parts = candidate.split("/");
    if (
      !valid(candidate) ||
      parts.length !== 4 ||
      !candidate.endsWith(".md") ||
      excluded(candidate) ||
      !/_\d{12}(?:_\d{2,})?$/.test(parts[2]!)
    )
      fail("Source must use product/type/key_YYYYMMDDHHmm/name.md.");
    else if (parts[0] === "_shared" && !/^[\w-]+$/.test(parts[1]!))
      fail("Invalid shared source type.");
    else if (
      parts[0] !== "_shared" &&
      (!d.products.includes(parts[0]!) ||
        !slots.has(parts[1]!) ||
        parts[1] !== d.slot)
    )
      fail("Source slot does not match the decision.");
    else if (base.has(candidate))
      fail(
        "Choose a fresh timestamped source path; do not overwrite a source in place.",
      );
    else newSource = candidate;
    for (const product of d.products)
      if (
        ![...base.keys()].some((p) => p.startsWith(`${product}/`)) &&
        !feedback.trim()
      )
        fail("New products require administrator feedback.");
    if (!markdown.trim()) fail("Empty converted Markdown.");
    if (newSource) next.set(newSource, markdown);
  }
  for (const old of allowedDeletes) next.delete(old);
  for (const [name, text] of staged) {
    if (
      !valid(name) ||
      excluded(name) ||
      !name.startsWith("product-knowledge-vault/") ||
      !name.endsWith(".md") ||
      !text.trim()
    ) {
      fail(`Candidate cannot edit this path: ${name}`);
      continue;
    }
    if (
      /^product-knowledge-vault\/products\/.+\.md$/.test(name) &&
      ![...hubs.values()].includes(name)
    ) {
      fail(
        `Unrelated product Hub change: ${name}. Expected Hub(s): ${[...hubs.values()].join(", ") || "none"}. Add its product to products or leave this Hub unchanged.`,
      );
      continue;
    }
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      fail(`Candidate knowledge page exceeds 2 MiB: ${name}`);
    next.set(name, text);
  }
  const affected = dependents(base, d.oldPaths);
  for (const p of affected) {
    if (!d.reviewedPaths.includes(p))
      fail(`Dependent page was not reviewed: ${p}`);
    const text = next.get(p) ?? "";
    if (references(text, base, p).some((old) => d.oldPaths.includes(old)))
      fail(`Old source reference remains: ${p}`);
  }
  for (const product of d.products) {
    const hub = hubs.get(product)!;
    if (!staged.has(hub)) {
      fail(`Product Hub must be updated: ${hub}`);
      continue;
    }
    const text = next.get(hub) ?? "";
    for (const name of next.keys())
      if (name.startsWith(`${product}/`) && !text.includes(name))
        fail(`Hub source coverage is incomplete: ${hub} must list ${name}`);
    if (
      newSource?.startsWith("_shared/") &&
      !text.includes(newSource) &&
      ![...staged].some(
        ([p, t]) =>
          p.startsWith("product-knowledge-vault/shared/") &&
          t.includes(newSource!) &&
          text.includes(p.slice(24).replace(/\.md$/, "")),
      )
    )
      fail(`Missing shared source backlink: ${hub}`);
  }
  if (
    newSource?.startsWith("_shared/") &&
    ![...staged].some(
      ([p, t]) =>
        p.startsWith("product-knowledge-vault/shared/") &&
        t.includes(newSource!) &&
        d.products.every((product) =>
          t.includes(hubs.get(product)!.slice(24).replace(/\.md$/, "")),
        ),
    )
  )
    fail("Shared sources require a shared node with all product backlinks.");
  // The catalog index only lists Hubs and shared nodes; it must change when one is created.
  const indexPath = "product-knowledge-vault/index.md";
  const created = [...staged.keys()].filter(
    (p) =>
      /^product-knowledge-vault\/(?:products|shared)\//.test(p) && !base.has(p),
  );
  if (created.length && !staged.has(indexPath))
    fail(
      `Index must be maintained when creating ${created.join(", ")}: ${indexPath}`,
    );
  for (const [p, t] of next) {
    if (!staged.has(p)) continue;
    const before = base.get(p) ?? "";
    for (const link of links(t)) {
      if (
        before.includes(link.target) ||
        /^(?:https?:|mailto:|#)/.test(link.target)
      )
        continue;
      let target = link.target.split("#")[0]!;
      try {
        target = decodeURIComponent(target);
      } catch {}
      if (link.wiki)
        target = `product-knowledge-vault/${target.replace(/\.md$/, "")}.md`;
      else if (!next.has(target))
        target = path.posix.normalize(
          path.posix.join(path.posix.dirname(p), target),
        );
      if (!next.has(target))
        fail(`New unresolved link in ${p}: ${link.target}`);
    }
  }
  // Validate single-slot constraints only for affected products, counting live Markdown.
  for (const product of d.products)
    for (const slot of [...slots].filter((s) => s !== "others")) {
      const dirs = new Set(
        [...next.keys()]
          .filter((p) => p.startsWith(`${product}/${slot}/`))
          .map((p) => p.split("/")[2]),
      );
      const oldDirs = new Set(
        [...base.keys()]
          .filter((p) => p.startsWith(`${product}/${slot}/`))
          .map((p) => p.split("/")[2]),
      );
      if (
        dirs.size > 1 &&
        (dirs.size > oldDirs.size ||
          [...staged.keys()].some((p) => p.startsWith(`${product}/${slot}/`)))
      )
        fail(`Multiple current documents in ${product}/${slot}.`);
      if (newSource?.startsWith(`${product}/${slot}/`) && dirs.size > 1)
        fail(`Slot already occupied: ${product}/${slot}.`);
    }
  const changes = [...new Set([...base.keys(), ...next.keys()])]
    .filter((p) => base.get(p) !== next.get(p))
    .map((p) => ({
      path: p,
      before: base.get(p) ?? null,
      after: next.get(p) ?? null,
    }));
  if (changes.length > 100)
    fail("Change set exceeds 100 files; narrow this task.");
  if (problems.length)
    throw new PlanError(
      problems,
      problems.every((p) => reviewProblems.some((r) => r.test(p))),
    );
  return {
    decision: d,
    changes,
    baseline: fingerprint(base),
    ...(confirmationReason ? { confirmationReason } : {}),
  };
}
