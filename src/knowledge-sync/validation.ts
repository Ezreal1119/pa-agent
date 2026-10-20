import path from "node:path";
import {
  excluded,
  fingerprint,
  relative,
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
      if (p.startsWith("product-knowledge-vault/"))
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
export function buildPlan(
  base: Map<string, string>,
  staged: Map<string, string>,
  d: Decision,
  markdown: string,
  feedback: string,
  deletion = false,
): Plan {
  if (d.action === "review")
    return { decision: d, changes: [], baseline: fingerprint(base) };
  if (deletion !== (d.action === "delete"))
    throw new SyncError("Wrong operation in candidate plan.");
  if (
    [...staged.values()].reduce(
      (sum, text) => sum + Buffer.byteLength(text),
      0,
    ) >
    8 * 1024 * 1024
  )
    throw new SyncError("Candidate index text exceeds 8 MiB.");
  const next = new Map(base),
    allowedDeletes = new Set(d.oldPaths);
  if (
    !d.products.length ||
    d.products.some(
      (p) => !p || p.includes("/") || p.includes("\\") || p.startsWith("."),
    )
  )
    throw new SyncError("Explicit canonical products are required.");
  if (!d.reason?.trim() || !d.summary?.trim())
    throw new SyncError("A decision and change explanation are required.");
  for (const old of d.oldPaths) {
    relative(old);
    if (
      excluded(old) ||
      !base.has(old) ||
      old.startsWith("product-knowledge-vault/")
    )
      throw new SyncError(`Invalid source replacement: ${old}`);
    if (!old.startsWith("_shared/") && !d.products.includes(old.split("/")[0]!))
      throw new SyncError(
        "Deleted source product is missing from the decision.",
      );
  }
  if (
    (d.action === "add" && d.oldPaths.length) ||
    (d.action === "update" && !d.oldPaths.length) ||
    (deletion && !d.oldPaths.length)
  )
    throw new SyncError("Invalid add/update/delete source list.");
  if (
    d.action === "update" &&
    (!d.versionEvidence.trim() || (d.authorizedException && !feedback.trim()))
  )
    throw new SyncError(
      "Update requires evidence of a newer version or administrator feedback.",
    );
  let newSource: string | undefined;
  if (!deletion) {
    newSource = relative(d.newPath ?? "");
    const parts = newSource.split("/");
    if (
      parts.length !== 4 ||
      !newSource.endsWith(".md") ||
      excluded(newSource) ||
      !/_\d{12}(?:_\d{2,})?$/.test(parts[2]!)
    )
      throw new SyncError(
        "Source must use product/type/key_YYYYMMDDHHmm/name.md.",
      );
    if (parts[0] === "_shared") {
      if (!/^[\w-]+$/.test(parts[1]!))
        throw new SyncError("Invalid shared source type.");
    } else {
      if (
        !d.products.includes(parts[0]!) ||
        !slots.has(parts[1]!) ||
        parts[1] !== d.slot
      )
        throw new SyncError("Source slot does not match the decision.");
    }
    for (const product of d.products)
      if (
        ![...base.keys()].some((p) => p.startsWith(`${product}/`)) &&
        !feedback.trim()
      )
        throw new SyncError("New products require administrator feedback.");
    if (base.has(newSource))
      throw new SyncError(
        "Choose a fresh timestamped source path; do not overwrite a source in place.",
      );
    if (!markdown.trim()) throw new SyncError("Empty converted Markdown.");
    next.set(newSource, markdown);
  }
  for (const old of allowedDeletes) next.delete(old);
  for (const [name, text] of staged) {
    relative(name);
    if (
      excluded(name) ||
      !name.startsWith("product-knowledge-vault/") ||
      !name.endsWith(".md") ||
      !text.trim()
    )
      throw new SyncError(`Candidate cannot edit this path: ${name}`);
    const hub = /^product-knowledge-vault\/products\/(.+)\.md$/.exec(name);
    if (hub && !d.products.includes(hub[1]!))
      throw new SyncError("Unrelated product Hub change.");
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new SyncError("Candidate knowledge page exceeds 2 MiB.");
    next.set(name, text);
  }
  const affected = dependents(base, d.oldPaths);
  for (const p of affected) {
    if (!d.reviewedPaths.includes(p))
      throw new SyncError(`Dependent page was not reviewed: ${p}`);
    const text = next.get(p) ?? "";
    if (references(text, base, p).some((old) => d.oldPaths.includes(old)))
      throw new SyncError(`Old source reference remains: ${p}`);
  }
  for (const product of d.products) {
    const hub = `product-knowledge-vault/products/${product}.md`;
    if (!staged.has(hub))
      throw new SyncError(`Product Hub must be updated: ${hub}`);
    const text = next.get(hub)!;
    for (const name of next.keys())
      if (name.startsWith(`${product}/`) && !text.includes(name))
        throw new SyncError(`Hub source coverage is incomplete: ${name}`);
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
      throw new SyncError(`Missing shared source backlink: ${hub}`);
  }
  if (
    newSource?.startsWith("_shared/") &&
    ![...staged].some(
      ([p, t]) =>
        p.startsWith("product-knowledge-vault/shared/") &&
        t.includes(newSource!) &&
        d.products.every((product) => t.includes(`products/${product}`)),
    )
  )
    throw new SyncError(
      "Shared sources require a shared node with all product backlinks.",
    );
  for (const name of [
    "product-knowledge-vault/index.md",
    "product-knowledge-vault/log.md",
  ])
    if (!staged.has(name))
      throw new SyncError(`Index/log must be maintained: ${name}`);
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
        throw new SyncError(`New unresolved link in ${p}: ${link.target}`);
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
        throw new SyncError(
          `Multiple current documents in ${product}/${slot}.`,
        );
      if (newSource?.startsWith(`${product}/${slot}/`) && dirs.size > 1)
        throw new SyncError(`Slot already occupied: ${product}/${slot}.`);
    }
  const changes = [...new Set([...base.keys(), ...next.keys()])]
    .filter((p) => base.get(p) !== next.get(p))
    .map((p) => ({
      path: p,
      before: base.get(p) ?? null,
      after: next.get(p) ?? null,
    }));
  if (changes.length > 100)
    throw new SyncError("Change set exceeds 100 files; narrow this task.");
  return { decision: d, changes, baseline: fingerprint(base) };
}
