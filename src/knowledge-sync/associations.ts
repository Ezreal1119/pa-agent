import path from "node:path";
import {
  fingerprint,
  hash,
  excluded,
  relative,
  timestamp,
  PlanError,
  type Decision,
  type Plan,
  type SourceMatch,
} from "./core.js";

type IndexOps = {
  references: (
    text: string,
    base: Map<string, string>,
    from?: string,
  ) => string[];
  resolveHub: (base: Map<string, string>, product: string) => string;
};
const vault = "product-knowledge-vault/";
const marker = "<!-- knowledge-sync:source-association:v1 -->";
const slots = new Set([
  "brochure",
  "specs",
  "user_guide",
  "presentation",
  "accessories",
  "others",
]);
const nodePath = (source: string) =>
  `${vault}shared/source-association-${hash(source).slice(0, 24)}.md`;
function productsIn(base: Map<string, string>, hints: string[] = []) {
  return [
    ...new Set(
      [...base.keys()]
        .filter(
          (p) =>
            !excluded(p) && !p.startsWith(vault) && !p.startsWith("_shared/"),
        )
        .map((p) => p.split("/")[0]!)
        .concat(hints),
    ),
  ].filter(
    (p) => !!p && !p.includes("/") && !p.includes("\\") && !p.startsWith("."),
  );
}
/** Coverage must follow a real Hub -> source or Hub -> shared node -> source edge. */
export function sourceCoverage(
  base: Map<string, string>,
  source: string,
  hints: string[],
  ops: IndexOps,
) {
  const shared = [...base]
    .filter(([p]) => p.startsWith(`${vault}shared/`))
    .map(([p, t]) => ({ path: p, refs: ops.references(t, base, p) }))
    .filter((node) => node.refs.includes(source));
  const covered: string[] = [],
    declared = new Set(hints);
  if (!source.startsWith("_shared/")) declared.add(source.split("/")[0]!);
  for (const product of productsIn(base, [...declared])) {
    const hub = ops.resolveHub(base, product),
      text = base.get(hub);
    if (text === undefined) continue;
    const refs = ops.references(text, base, hub);
    if (
      refs.includes(source) ||
      shared.some((node) => refs.includes(node.path))
    )
      covered.push(product);
    if (shared.some((node) => node.refs.includes(hub))) declared.add(product);
  }
  return {
    coveredProducts: covered.sort(),
    products: [...new Set([...declared, ...covered])].sort(),
  };
}
/** Only nodes created by this additive workflow add the extra update/delete guard. */
export function managedSourceProducts(
  base: Map<string, string>,
  source: string,
  ops: IndexOps,
) {
  // Source replacement uses a fresh path. Follow the marker and live link,
  // rather than losing the guard when an existing node points to that revision.
  if (
    ![...base].some(
      ([node, text]) =>
        node.startsWith(`${vault}shared/`) &&
        text.includes(marker) &&
        ops.references(text, base, node).includes(source),
    )
  )
    return [];
  return sourceCoverage(base, source, [], ops).products;
}
function append(text: string, addition: string) {
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n${addition}\n`;
}
function markdownLink(from: string, to: string, label: string) {
  const url = path.posix
    .relative(path.posix.dirname(from), to)
    .split("/")
    .map((p) =>
      encodeURIComponent(p).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  return `[${label}](<${url}>)`;
}

/** An additive, backend-generated index transaction. No source edits or model-written pages. */
export function buildAssociationPlan(
  base: Map<string, string>,
  staged: Map<string, string>,
  d: Decision,
  match: SourceMatch | undefined,
  ops: IndexOps,
): Plan {
  const fail = (message: string, review = false): never => {
    throw new PlanError([message], review);
  };
  if (!match || d.existingSource !== match.path)
    fail("Association must identify the backend-verified existing source.");
  const verified = match!;
  try {
    relative(verified.path);
  } catch {
    fail("Invalid existing source path.");
  }
  if (
    excluded(verified.path) ||
    verified.path.startsWith(vault) ||
    !verified.path.endsWith(".md") ||
    !base.has(verified.path) ||
    hash(base.get(verified.path)!) !== verified.markdownHash
  )
    fail(
      "Existing source changed or is missing. Recheck the input; no association was written.",
    );
  if (staged.size || d.oldPaths.length || d.newPath || d.productHubs?.length)
    fail(
      "Associate is index-only: do not stage pages, replace sources, provide newPath or override Hubs.",
    );
  if (!d.reason?.trim() || !d.summary?.trim())
    fail("Association requires a decision explanation.");
  if (
    !Array.isArray(d.products) ||
    !d.products.length ||
    d.products.length > 50 ||
    new Set(d.products).size !== d.products.length
  )
    fail("Association requires 1–50 unique canonical products.");
  const coverage = sourceCoverage(base, verified.path, verified.products, ops);
  if (coverage.products.some((p) => !d.products.includes(p)))
    fail(
      "Association must preserve every existing product and the source owner.",
    );
  if (d.slot !== verified.slot || !slots.has(d.slot))
    fail("Association cannot change the source document slot.");
  const hubs = new Map<string, string>();
  for (const product of d.products) {
    if (
      typeof product !== "string" ||
      !product ||
      product.includes("/") ||
      product.includes("\\") ||
      product.startsWith(".") ||
      /[\x00-\x1f\x7f]/.test(product)
    )
      fail("Invalid canonical association product.");
    const hub = ops.resolveHub(base, product);
    if (
      !base.has(hub) ||
      ![...base.keys()].some((p) => p.startsWith(`${product}/`))
    )
      fail(
        `Association requires an existing canonical product and Hub: ${product}. Resolve product creation separately.`,
        true,
      );
    if (d.slot !== "others" && !coverage.coveredProducts.includes(product)) {
      const occupied = [...base.keys()].some(
        (p) => p !== verified.path && p.startsWith(`${product}/${d.slot}/`),
      );
      const sharedRefs = ops
        .references(base.get(hub)!, base, hub)
        .some(
          (p) =>
            p !== verified.path &&
            (p.startsWith("_shared/") || p.startsWith(`${vault}shared/`)),
        );
      if (occupied || sharedRefs)
        fail(
          `Association cannot decide a current-slot replacement for ${product}/${d.slot}. Review the existing document and versions separately.`,
          true,
        );
    }
    if ([...hubs.values()].includes(hub))
      fail("Different association products must have distinct resolved Hubs.");
    hubs.set(product, hub);
  }
  if (d.products.every((p) => coverage.coveredProducts.includes(p)))
    return { decision: d, changes: [], baseline: fingerprint(base) };
  const node = nodePath(verified.path),
    existing = base.get(node);
  if (
    existing !== undefined &&
    (!existing.includes(marker) ||
      !ops.references(existing, base, node).includes(verified.path))
  )
    fail(
      "Shared association node conflicts with existing content. Nothing was overwritten.",
    );
  const next = new Map(base);
  let nodeText =
    existing ??
    `# Shared source coverage\n\n${marker}\n\nSource: ${markdownLink(node, verified.path, "Published Markdown")}\n\nDocument slot: ${verified.slot}\n\n## Applicable products\n`;
  for (const [product, hub] of hubs) {
    if (!ops.references(nodeText, base, node).includes(hub))
      nodeText = append(
        nodeText,
        `- ${markdownLink(node, hub, "Product Hub")} — ${JSON.stringify(product)}`,
      );
  }
  next.set(node, nodeText);
  for (const [product, hub] of hubs) {
    const before = base.get(hub)!;
    if (!ops.references(before, next, hub).includes(node))
      next.set(
        hub,
        append(
          before,
          `### Additional shared source coverage\n\n- ${markdownLink(hub, node, "Shared document")} · ${verified.slot} · ${JSON.stringify(product)}\n- ${markdownLink(hub, verified.path, "Published source Markdown")}`,
        ),
      );
  }
  const index = `${vault}index.md`;
  if (existing === undefined) {
    const before = base.get(index) ?? "# Knowledge index\n";
    if (!ops.references(before, next, index).includes(node))
      next.set(
        index,
        append(
          before,
          `- ${markdownLink(index, node, "Shared source coverage")}`,
        ),
      );
  }
  const log = `${vault}log.md`,
    entry = (d.logEntry ?? `${d.summary}\n\n${d.reason}`).trim();
  if (!entry || Buffer.byteLength(entry) > 16000)
    fail("Association log entry must contain 1–16000 UTF-8 bytes.");
  next.set(
    log,
    append(
      base.get(log) ?? "",
      `### ${timestamp()} · associate · ${d.products.map((p) => JSON.stringify(p)).join(", ")}\n\n${entry}`,
    ),
  );
  for (const [name, text] of next) {
    if (text === base.get(name)) continue;
    if (
      !name.startsWith(vault) ||
      excluded(name) ||
      !name.endsWith(".md") ||
      Buffer.byteLength(text) > 2 * 1024 * 1024
    )
      fail("Association produced an invalid or excessive index change.");
    if (base.has(name) && !text.startsWith(base.get(name)!))
      fail("Association cannot remove or rewrite existing index contents.");
  }
  const final = sourceCoverage(next, verified.path, d.products, ops);
  if (d.products.some((p) => !final.coveredProducts.includes(p)))
    fail("Association has incomplete Hub-to-source coverage.");
  if (
    [...hubs.values()].some(
      (hub) => !ops.references(next.get(node)!, next, node).includes(hub),
    )
  )
    fail("Association shared node is missing product backlinks.");
  const changes = [...next]
    .filter(([p, t]) => base.get(p) !== t)
    .map(([p, t]) => ({ path: p, before: base.get(p) ?? null, after: t }));
  if (changes.length > 100) fail("Association exceeds 100 changed indexes.");
  return {
    decision: d,
    changes,
    baseline: fingerprint(base),
    confirmationReason: `Confirm shared source coverage: ${verified.path} → ${d.products.join(", ")}. Source Markdown remains unchanged.`,
  };
}
