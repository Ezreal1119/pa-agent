const $ = (id) => document.getElementById(id);
let token = "",
  selected = /^[a-f0-9-]{36}$/.test(location.hash.slice(1))
    ? location.hash.slice(1)
    : undefined,
  jobCache = "",
  incomingCache = "",
  historyCache = "",
  busy = false,
  polling = false;
const statusLabel = (value) =>
  ({
    needs_review: "Needs review",
    waiting_to_publish: "Waiting to publish",
    awaiting_confirmation: "Awaiting confirmation",
  })[value] || value.charAt(0).toUpperCase() + value.slice(1);
const drafts = new Map(),
  openCards = new Set();
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const button = (text, fn, cls = "secondary-button") => {
  const b = el("button", text, cls);
  b.type = "button";
  b.onclick = () => action(fn);
  return b;
};
function error(e) {
  $("sync-error").textContent = e.message || String(e);
  $("sync-error").hidden = false;
}
async function api(route, method = "GET", body) {
  const response = await fetch(`/api/sync/${route}`, {
    method,
    headers: {
      "X-Local-Token": token,
      ...(body instanceof File
        ? { "Content-Type": "application/octet-stream" }
        : body
          ? { "Content-Type": "application/json" }
          : {}),
    },
    body: body instanceof File ? body : body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) {
    location.href = "/login";
    throw Error("Please sign in.");
  }
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Request failed.");
  return result;
}
async function action(fn) {
  $("sync-error").hidden = true;
  try {
    await fn();
    await refresh();
  } catch (e) {
    error(e);
  }
}
async function choose(job) {
  selected = job.id;
  location.hash = job.id;
  jobCache = "";
  await renderJob(job);
  $("report").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
async function incoming() {
  const checked = new Set(
    [...$("incoming").querySelectorAll("input:checked")].map((n) => n.value),
  );
  const { files, maxFileBytes } = await api("incoming");
  const key = JSON.stringify({ files, maxFileBytes });
  if (key === incomingCache) return;
  incomingCache = key;
  $("incoming").replaceChildren();
  $("upload-status").textContent =
    `Up to ${(maxFileBytes / 1048576).toFixed(0)} MB per file`;
  if (!files.length) {
    $("incoming").append(el("p", "No incoming files."));
    return;
  }
  for (const file of files) {
    const row = el("label", undefined, "sync-input-row");
    const check = el("input");
    check.type = "checkbox";
    check.value = file.id;
    check.checked = checked.has(file.id);
    check.disabled = !!file.error;
    row.append(
      check,
      el("span", file.name),
      el("small", file.error || `${(file.bytes / 1024).toFixed(1)} KB`),
    );
    $("incoming").append(row);
  }
}
async function history() {
  const { jobs } = await api("jobs");
  if (!selected && jobs.length)
    selected =
      jobs.find((j) => ["running", "queued", "stopping"].includes(j.status))
        ?.id ?? jobs[0].id;
  busy = jobs.some((j) => ["queued", "running", "stopping"].includes(j.status));
  $("start").disabled = busy;
  $("preview").disabled = busy;
  const key = JSON.stringify({ jobs, selected });
  if (key !== historyCache) {
    historyCache = key;
    $("history").replaceChildren();
    for (const job of jobs) {
      const b = button(
        `${new Date(job.created).toLocaleString()}\n${job.kind === "delete" ? "Delete" : "Sync"} · ${statusLabel(job.status)}\n${Object.entries(
          job.counts,
        )
          .map(([k, v]) => `${v} ${statusLabel(k)}`)
          .join(" · ")}`,
        async () => choose(await api(`jobs/${job.id}`)),
      );
      b.classList.add("sync-history-item");
      if (job.id === selected) b.classList.add("selected");
      $("history").append(b);
    }
  }
  if (selected) await renderJob(await api(`jobs/${selected}`));
}
function diff(change) {
  const wrapper = el("details");
  wrapper.append(
    el(
      "summary",
      `${change.before === null ? "Add" : change.after === null ? "Remove" : "Update"} · ${change.path}`,
    ),
  );
  const a = (change.before ?? "").split("\n"),
    b = (change.after ?? "").split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  let end = 0;
  while (
    end < a.length - prefix &&
    end < b.length - prefix &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const text = [
    `@@ line ${prefix + 1} @@`,
    ...a.slice(prefix, a.length - end).map((l) => `- ${l}`),
    ...b.slice(prefix, b.length - end).map((l) => `+ ${l}`),
  ].join("\n");
  wrapper.append(el("pre", text, "sync-diff"));
  return wrapper;
}
async function renderJob(job) {
  const key = JSON.stringify(job);
  if (
    key === jobCache ||
    ($("report").contains(document.activeElement) &&
      document.activeElement.tagName === "TEXTAREA")
  )
    return;
  jobCache = key;
  const holder = $("report");
  holder.replaceChildren();
  const head = el("div", undefined, "sync-heading");
  head.append(
    el(
      "h3",
      `${job.kind === "delete" ? "Deletion preview" : "Sync report"} · ${statusLabel(job.status)}`,
    ),
  );
  if (["queued", "running", "stopping"].includes(job.status))
    head.append(button("Stop", () => api(`jobs/${job.id}/stop`, "POST", {})));
  holder.append(head);
  if(job.prompt)holder.append(el("p",`Request: ${job.prompt}`));
  if (job.status === "awaiting_confirmation")
    holder.append(
      button(
        "Confirm deletion",
        async () => choose(await api(`jobs/${job.id}/confirm`, "POST", {})),
        "primary-button",
      ),
    );
  for (const item of job.items) {
    const card = el("details", undefined, "sync-card");
    card.open = openCards.has(item.id) || job.items.length === 1;
    card.ontoggle = () =>
      card.open ? openCards.add(item.id) : openCards.delete(item.id);
    card.append(el("summary", `${item.name} · ${statusLabel(item.status)}`));
    card.append(
      el(
        "p",
        `${item.stage}${item.elapsedMs !== undefined ? ` · ${(item.elapsedMs / 1000).toFixed(1)} s` : ""}`,
      ),
    );
    const u = item.textUsage,
      v = item.visualUsage;
    card.append(
      el(
        "small",
        `Model: ${item.model || "—"} · Text input/output: ${u.input}/${u.output} · Vision input/output: ${v.input}/${v.output} · Recorded requests: ${u.recorded + v.recorded}/${u.requests + v.requests}`,
      ),
    );
    if (item.reason) card.append(el("p", item.reason));
    if (item.summary) card.append(el("p", item.summary));
    if (item.feedback) card.append(el("p", `Instructions: ${item.feedback}`));
    if (item.previous)
      card.append(el("small", `Previous attempt: ${item.previous}`));
    if (item.plan) {
      card.append(
        el(
          "p",
          `Products: ${item.plan.decision.products.join(", ")} · Slot: ${item.plan.decision.slot}`,
        ),
      );
      if (item.plan.decision.versionEvidence)
        card.append(el("p", item.plan.decision.versionEvidence));
      for (const c of item.plan.changes) card.append(diff(c));
    }
    if (item.coverage) {
      const d = el("details");
      d.append(
        el("summary", `Conversion coverage (${item.coverage.length})`),
        el("pre", item.coverage.join("\n")),
      );
      card.append(d);
    }
    if (item.sourceDeleted)
      card.append(el("p", "Original removed after successful processing."));
    else if(job.kind==='sync')card.append(el('p','Original retained.'));
    if (item.cleanupError) {
      card.append(el("p", `Cleanup pending: ${item.cleanupError}`));
      card.append(
        button("Retry cleanup", () =>
          api(`jobs/${job.id}/cleanup`, "POST", { itemId: item.id }),
        ),
      );
    }
    if (
      ["needs_review", "failed", "stopped", "interrupted"].includes(item.status)
    ) {
      const input = el("textarea");
      input.rows = 3;
      input.maxLength = 16000;
      input.placeholder = "Explain how to handle this file…";
      input.setAttribute("aria-label", `Instructions for ${item.name}`);
      input.value = drafts.get(item.id) || "";
      input.oninput = () => drafts.set(item.id, input.value);
      const label = el("label");
      const force = el("input");
      force.type = "checkbox";
      label.append(force, document.createTextNode(" Reconvert original"));
      const b = button("Re-Sync", async () =>
        choose(
          await api(`jobs/${job.id}/resync`, "POST", {
            itemId: item.id,
            feedback: input.value,
            forceConvert: force.checked,
          }),
        ),
      );
      b.disabled = busy;
      card.append(input, label, b);
    }
    holder.append(card);
  }
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    await incoming();
    await history();
  } finally {
    polling = false;
  }
}
$("refresh").onclick = () => action(refresh);
$("start").onclick = () =>
  action(async () => {
    const ids = [...$("incoming").querySelectorAll("input:checked")].map(
      (n) => n.value,
    );
    if (!ids.length) throw Error("Select incoming files first.");
    await choose(await api("jobs", "POST", { ids }));
  });
$("preview").onclick = () =>
  action(async () =>
    choose(
      await api("delete-preview", "POST", { prompt: $("delete-prompt").value }),
    ),
  );
$("upload").onchange = () =>
  action(async () => {
    const input = $("upload");
    input.disabled = true;
    try {
      for (const file of input.files) {
        $("upload-status").textContent = `Uploading ${file.name}…`;
        await api(
          `incoming?name=${encodeURIComponent(file.name)}`,
          "POST",
          file,
        );
      }
      input.value = "";
    } finally {
      input.disabled = false;
    }
  });
(async () => {
  try {
    const r = await fetch("/api/auth/status");
    const auth = await r.json();
    if (!auth.authenticated) {
      location.href = "/login";
      return;
    }
    token = auth.token;
    await refresh();
    setInterval(() => {
      if (!document.hidden) refresh().catch(error);
    }, 2000);
  } catch (e) {
    error(e);
  }
})();
