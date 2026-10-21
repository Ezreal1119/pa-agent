const $ = (id) => document.getElementById(id);
let token = "",
  selected = /^[a-f0-9-]{36}$/.test(location.hash.slice(1))
    ? location.hash.slice(1)
    : undefined,
  jobCache = "",
  incomingCache = "",
  historyCache = "",
  busy = false,
  polling = false,
  uploading = false,
  maxFileBytes = 100 * 1048576;
const tabNames = ["incoming", "reports", "delete", "imports", "library"];
const requestedTab = new URLSearchParams(location.search).get("tab");
let activeTab = tabNames.includes(requestedTab)
  ? requestedTab
  : selected
    ? "reports"
    : "incoming";
function setTab(name, updateUrl = true) {
  activeTab = tabNames.includes(name) ? name : "incoming";
  for (const tab of tabNames) {
    const isActive = tab === activeTab;
    const button = $(`tab-${tab}`);
    button.setAttribute("aria-selected", String(isActive));
    button.tabIndex = isActive ? 0 : -1;
    $(`panel-${tab}`).hidden = !isActive;
  }
  if (activeTab === "library") globalThis.openLibrary?.();
  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set("tab", activeTab);
    url.hash = activeTab === "reports" && selected ? selected : "";
    window.history.replaceState(null, "", url);
  }
}
const selectedChoices = new Map();
const drafts = new Map(),
  openCards = new Set(),
  reconvertIds = new Set();
const statusLabel = (value) =>
  ({
    needs_review: "Needs your decision",
    queued: "Pending",
    converted: "Converted · waiting",
    waiting_to_publish: "Publishing",
    awaiting_confirmation: "Awaiting confirmation",
  })[value] ||
  (value.charAt(0).toUpperCase() + value.slice(1)).replaceAll("_", " ");
const statusHint = (status, kind) =>
  ({
    needs_review:
      "The agent needs a business decision from you, such as product identity, version order or a new product. Answer below, then Re-Sync.",
    failed:
      "Nothing was published. Automatic checks or processing failed; Re-Sync retries, with optional guidance.",
    stopped: "Nothing was published. Re-Sync to continue.",
    interrupted: "Nothing was published. Re-Sync to continue.",
    awaiting_confirmation:
      kind === "delete"
        ? "Review the deletion diff, then confirm. To change it, give instructions below."
        : undefined,
  })[status];
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const button = (text, fn, cls = "sync-button") => {
  const b = el("button", text, cls);
  b.type = "button";
  b.onclick = () => action(fn);
  return b;
};
const badge = (status) => {
  const span = el("span", statusLabel(status), "sync-badge");
  span.dataset.status = status;
  return span;
};
const selectedIds = () =>
  [...$("incoming").querySelectorAll("input:checked")].map((n) => n.value);
const fileSize = (bytes) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
const dateLabel = (value) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
function error(e) {
  $("sync-error").textContent = e.message || String(e);
  $("sync-error").hidden = false;
}
function updateControls() {
  const checks = [...$("incoming").querySelectorAll("input:not(:disabled)")],
    count = selectedIds().length;
  $("start").disabled = busy || uploading || !count;
  $("preview").disabled = busy;
  for (const b of $("incoming").querySelectorAll(".sync-file-remove"))
    b.disabled = busy;
  $("select-all").disabled = !checks.length;
  $("select-all").checked = !!checks.length && count === checks.length;
  $("select-all").indeterminate = count > 0 && count < checks.length;
  $("selection-status").textContent = busy
    ? "A maintenance task is running."
    : count
      ? `${count} ${count === 1 ? "file" : "files"} selected`
      : "Select files to start a sync.";
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
  if (response.status === 413) {
    await response.body?.cancel();
    throw Error(
      `File exceeds the ${Math.round(maxFileBytes / 1048576)} MB upload limit. If the file is smaller, check the reverse proxy upload limit.`,
    );
  }
  const result = await readJson(response);
  if (!response.ok) throw Error(result.error || "Request failed.");
  return result;
}
/** Proxies answer with HTML pages (502/504) while the service restarts. */
async function readJson(response) {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    throw Error(
      `Server temporarily unavailable (HTTP ${response.status}). The page keeps retrying; running tasks are not affected.`,
    );
  }
  return response.json();
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
  setTab("reports");
  jobCache = "";
  await renderJob(job);
  $("report").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
async function incoming() {
  const checked = new Set(selectedIds());
  const response = await api("incoming");
  maxFileBytes = response.maxFileBytes;
  const files = response.files.filter(
    (f) => !/(?:^|\/)readme\.md$/i.test(f.name),
  );
  const key = JSON.stringify({ files, maxFileBytes });
  if (key === incomingCache) return;
  incomingCache = key;
  $("incoming").replaceChildren();
  $("incoming-count").textContent = files.length;
  $("tab-incoming-count").textContent = files.length;
  if (!uploading)
    $("upload-status").textContent =
      `Up to ${Math.round(maxFileBytes / 1048576)} MB per file · README.md is ignored`;
  if (!files.length)
    $("incoming").append(
      el(
        "div",
        "No incoming files. Upload documents to get started.",
        "sync-empty-files",
      ),
    );
  for (const file of files) {
    const row = el("label", undefined, "sync-input-row"),
      check = el("input");
    check.type = "checkbox";
    check.value = file.id;
    check.checked = checked.has(file.id);
    check.disabled = !!file.error;
    check.onchange = updateControls;
    const extension = file.name.split(".").at(-1).toUpperCase(),
      icon = el("span", extension, "sync-file-icon");
    icon.setAttribute("aria-hidden", "true");
    const detail = el("span", undefined, "sync-file-detail");
    detail.append(
      el("strong", file.name),
      el(
        "small",
        file.error || `${extension} document`,
        file.error ? "sync-file-error" : undefined,
      ),
    );
    const remove = el("button", "Delete", "sync-file-remove");
    remove.type = "button";
    remove.disabled = busy;
    remove.title = `Delete ${file.name} from incoming files`;
    remove.onclick = (event) => {
      event.preventDefault();
      if (
        !confirm(
          `Delete "${file.name}" from incoming files? The uploaded file is removed and cannot be synced or Re-Synced until uploaded again.`,
        )
      )
        return;
      action(async () => {
        await api(`incoming?id=${encodeURIComponent(file.id)}`, "DELETE");
        incomingCache = "";
      });
    };
    row.append(
      check,
      icon,
      detail,
      el("span", fileSize(file.bytes), "sync-file-size"),
      remove,
    );
    $("incoming").append(row);
  }
  updateControls();
}
async function loadHistory() {
  const { jobs } = await api("jobs");
  if (!selected && jobs.length)
    selected =
      jobs.find((j) => ["running", "queued", "stopping"].includes(j.status))
        ?.id ?? jobs[0].id;
  busy = jobs.some((j) => ["queued", "running", "stopping"].includes(j.status));
  updateControls();
  $("report-count").textContent = jobs.length;
  $("tab-report-count").textContent = jobs.length;
  $("reports-layout").classList.toggle("is-empty", !jobs.length);
  const key = JSON.stringify({ jobs, selected });
  if (key !== historyCache) {
    historyCache = key;
    $("history").replaceChildren();
    for (const job of jobs) {
      const b = button(
        "",
        async () => choose(await api(`jobs/${job.id}`)),
        "sync-history-item",
      );
      b.append(
        el(
          "strong",
          `${job.kind === "delete" ? "Deletion" : "Sync"} · ${job.count} ${job.count === 1 ? "file" : "files"}`,
        ),
        el("time", dateLabel(job.created)),
        badge(job.status),
      );
      b.append(
        el(
          "small",
          Object.entries(job.counts)
            .map(
              ([status, count]) =>
                `${count} ${statusLabel(status).toLowerCase()}`,
            )
            .join(" · "),
        ),
      );
      if (job.id === selected) {
        b.classList.add("selected");
        b.setAttribute("aria-current", "true");
      }
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
  wrapper.append(
    el(
      "pre",
      [
        `@@ line ${prefix + 1} @@`,
        ...a.slice(prefix, a.length - end).map((l) => `- ${l}`),
        ...b.slice(prefix, b.length - end).map((l) => `+ ${l}`),
      ].join("\n"),
    ),
  );
  return wrapper;
}
function metric(label, value) {
  const box = el("div", undefined, "sync-metric");
  box.append(el("small", label), el("strong", value));
  return box;
}
// Older reports may contain explicit "选项 A / Option A" lines rather than
// structured choices. Expose only those literal proposals, never invent consent.
function reviewChoices(item) {
  const d = item.plan?.decision;
  if (item.status !== "needs_review") return [];
  if (Array.isArray(d?.reviewOptions) && d.reviewOptions.length >= 2)
    return d.reviewOptions;
  const options = [];
  for (const raw of (item.reason || "").split("\n")) {
    const line = raw.trim().replace(/^(?:[-*•]\s*)+/, "");
    const match = /^(?:选项|Option)\s*([A-H1-8])\s*[:：.)、-]\s*(.+)$/i.exec(line);
    if (!match) continue;
    const text = match[2].trim();
    if (!text || text.length > 6000) continue;
    const split = text.search(/[。；;]|\.\s/);
    const title = split > 0 ? text.slice(0, split) : text;
    options.push({ id: `legacy-${match[1].toLowerCase()}`, label: title.slice(0, 120),
      description: (split > 0 ? text.slice(split + 1).trim() : text).slice(0, 1000), instructions: text });
  }
  return options.length >= 2 && options.length <= 8 && new Set(options.map(o => o.id)).size === options.length ? options : [];
}
function reviewQuestion(item, choices) {
  if (item.plan?.decision.reviewQuestion) return item.plan.decision.reviewQuestion;
  if (choices.length) {
    const line = (item.reason || "").split("\n").find(s => /(?:需要.*(?:回答|决定).*问题|(?:question|decision)\s*:)/i.test(s));
    if (line) return line.replace(/^\s*[-*•]\s*/, "").replace(/^.*?[:：]\s*/, "").slice(0, 500);
  }
  return "How should this document be handled?";
}
async function renderJob(job) {
  const key = JSON.stringify({ job, busy });
  if (
    key === jobCache ||
    ($("report").contains(document.activeElement) &&
      document.activeElement.tagName === "TEXTAREA")
  )
    return;
  jobCache = key;
  const holder = $("report");
  holder.replaceChildren();
  const head = el("div", undefined, "sync-report-heading"),
    title = el("div");
  title.append(
    el("h3", job.kind === "delete" ? "Deletion preview" : "Sync report"),
    badge(job.status),
  );
  head.append(title);
  if (["queued", "running", "stopping"].includes(job.status))
    head.append(button("Stop", () => api(`jobs/${job.id}/stop`, "POST", {})));
  holder.append(head, el("p", dateLabel(job.created), "sync-report-date"));
  if (job.prompt) holder.append(el("p", job.prompt, "sync-request"));
  if (job.kind === "delete" && job.status === "awaiting_confirmation")
    holder.append(
      button(
        "Confirm deletion",
        async () => choose(await api(`jobs/${job.id}/confirm`, "POST", {})),
        "sync-button sync-button-danger sync-confirm",
      ),
    );
  for (const item of job.items) {
    const card = el("details", undefined, "sync-card");
    card.open = openCards.has(item.id) || job.items.length === 1;
    card.ontoggle = () =>
      card.open ? openCards.add(item.id) : openCards.delete(item.id);
    const summary = el("summary");
    summary.append(
      el("span", item.name, "sync-card-title"),
      badge(item.status),
    );
    card.append(summary);
    const content = el("div", undefined, "sync-card-body"),
      stage = el("div", undefined, "sync-stage");
    stage.append(
      el("span", item.stage),
      el(
        "span",
        item.elapsedMs !== undefined
          ? `${(item.elapsedMs / 1000).toFixed(1)} s`
          : "",
      ),
    );
    content.append(stage);
    const u = item.textUsage,
      v = item.visualUsage,
      metrics = el("div", undefined, "sync-metrics");
    metrics.append(
      metric(
        "Text tokens · input / output",
        `${u.input.toLocaleString()} / ${u.output.toLocaleString()}`,
      ),
      metric(
        "Vision tokens · input / output",
        `${v.input.toLocaleString()} / ${v.output.toLocaleString()}`,
      ),
      metric(
        "Requests with recorded usage",
        `${u.recorded + v.recorded} / ${u.requests + v.requests}`,
      ),
      metric("Model", item.model || "—"),
    );
    content.append(metrics);
    const hint = statusHint(item.status, job.kind);
    if (hint) content.append(el("p", hint, "sync-hint"));
    const choices = reviewChoices(item);
    let decisionAnchor, decisionEvidence;
    if (item.status === "needs_review") {
      content.append(el("p", reviewQuestion(item, choices), "sync-decision-question"));
      const evidence = el("details", undefined, "sync-decision-evidence");
      decisionEvidence = evidence;
      decisionAnchor = el("div", undefined, "sync-decision-actions");
      evidence.append(el("summary", "Decision details and evidence"));
      if (item.reason) evidence.append(el("p", item.reason));
      if (item.summary) evidence.append(el("p", item.summary));
      content.append(decisionAnchor, evidence);
    } else {
      if (item.reason?.includes("\n")) {
        const list = el("ul", undefined, "sync-problems");
        for (const line of item.reason.split("\n").filter(Boolean)) list.append(el("li", line));
        content.append(list);
      } else if (item.reason) content.append(el("p", item.reason));
      if (item.summary) content.append(el("p", item.summary));
    }
    if (item.feedback)
      content.append(
        el("p", `Your instructions: ${item.feedback}`, "sync-request"),
      );
    if (item.attempts?.length) {
      const history = el("details", undefined, "sync-attempts"),
        list = el("ol");
      history.append(
        el(
          "summary",
          `Attempt ${item.attempts.length + 1} · ${item.attempts.length} earlier ${item.attempts.length === 1 ? "attempt" : "attempts"}`,
        ),
      );
      for (const a of item.attempts) {
        const entry = el("li");
        entry.append(
          el(
            "strong",
            `${statusLabel(a.status)}${a.finished ? ` · ${dateLabel(a.finished)}` : ""}`,
          ),
        );
        if (a.feedback)
          entry.append(el("p", `Instructions: ${a.feedback}`, "sync-subtle"));
        if (a.reason) entry.append(el("p", a.reason.slice(0, 1200)));
        list.append(entry);
      }
      history.append(list);
      content.append(history);
    }
    if (item.plan) {
      const d = item.plan.decision;
      content.append(
        el(
          "p",
          `Products: ${d.products.join(", ") || "—"} · Slot: ${d.slot || "—"}`,
          "sync-subtle",
        ),
      );
      if (d.versionEvidence) (decisionEvidence || content).append(el("p", d.versionEvidence));
      for (const change of item.plan.changes) content.append(diff(change));
    }
    if (item.coverage) {
      const details = el("details");
      details.append(
        el("summary", `Conversion coverage · ${item.coverage.length} checks`),
        el("pre", item.coverage.join("\n")),
      );
      content.append(details);
    }
    if (job.kind === "sync")
      content.append(
        el(
          "p",
          item.sourceDeleted
            ? "Original removed after successful processing."
            : "Original retained.",
          "sync-subtle",
        ),
      );
    if (item.cleanupError) {
      content.append(el("p", `Cleanup pending: ${item.cleanupError}`));
      const b = button("Retry cleanup", () =>
        api(`jobs/${job.id}/cleanup`, "POST", { itemId: item.id }),
      );
      b.disabled = busy;
      content.append(b);
    }
    if (job.kind === "sync" && item.status === "awaiting_confirmation") {
      content.append(
        el(
          "p",
          item.plan?.confirmationReason ||
            "Review the changes before publishing.",
          "sync-request",
        ),
      );
      const confirm = button(
        "Confirm publication",
        async () =>
          choose(
            await api(`jobs/${job.id}/confirm`, "POST", { itemId: item.id }),
          ),
        "sync-button sync-button-primary sync-confirm",
      );
      confirm.disabled = busy;
      content.append(confirm);
    }
    if (
      [
        "needs_review",
        "failed",
        "stopped",
        "interrupted",
        "awaiting_confirmation",
      ].includes(item.status)
    ) {
      const feedback = el("div", undefined, "sync-feedback"),
        label = el(
          "label",
          item.status === "awaiting_confirmation"
            ? "Or request changes (optional)"
            : item.status === "needs_review"
              ? "Additional instructions"
              : job.kind === "delete"
                ? "Instructions for deletion preview"
                : "Instructions for Re-Sync (optional)",
        ),
        input = el("textarea");
      input.id = `feedback-${item.id}`;
      label.htmlFor = input.id;
      input.rows = 3;
      input.maxLength = 16000;
      input.placeholder = item.status === "needs_review"
        ? "Add details, or describe a different decision in your own words…"
        : job.kind === "delete"
          ? "Clarify what to delete or keep, and which related pages should be checked…"
          : "Explain the correct product, version or how this file should be handled…";
      input.setAttribute("aria-label", `Instructions for ${item.name}`);
      input.value = drafts.get(item.id) || "";
      input.oninput = () => { drafts.set(item.id, input.value); updateSubmit(); };
      let clearChoice;
      const choiceCards = [];
      const choicePreview = el("details", undefined, "sync-choice-preview"),
        choiceText = el("p");
      choicePreview.append(el("summary", "View selected instructions"), choiceText);
      const updateSubmit = () => {
        const chosen = choices.find(o => o.id === selectedChoices.get(item.id));
        b.disabled = busy || (choices.length > 0 && !chosen && !input.value.trim());
        if (clearChoice) clearChoice.disabled = busy || !chosen;
        choicePreview.hidden = !chosen;
        choiceText.textContent = chosen?.instructions || "";
        for (const card of choiceCards) card.node.dataset.selected = String(card.id === chosen?.id);
      };
      if (choices.length) {
        const group = el("fieldset", undefined, "sync-decision-options");
        group.append(el("legend", "Choose an option"));
        for (const option of choices) {
          const card = el("label", undefined, "sync-decision-option"),
            radio = el("input"), text = el("span", undefined, "sync-option-copy");
          radio.type = "radio";
          radio.name = `decision-${item.id}`;
          radio.value = option.id;
          radio.checked = selectedChoices.get(item.id) === option.id;
          radio.disabled = busy;
          radio.onchange = () => { if (radio.checked) { selectedChoices.set(item.id, option.id); updateSubmit(); } };
          text.append(el("strong", option.label), el("span", option.description));
          card.append(radio, text);
          choiceCards.push({ id: option.id, node: card, radio });
          group.append(card);
        }
        clearChoice = button("Clear selection", () => {
          selectedChoices.delete(item.id);
          for (const card of choiceCards) card.radio.checked = false;
          updateSubmit();
        }, "sync-button sync-clear-choice");
        feedback.append(group, clearChoice, choicePreview,
          el("p", "Nothing is applied until you submit. Choose an option or write your own instructions below.", "sync-subtle"));
      }
      const suggestion = item.plan?.decision.suggestedFeedback;
      if (job.kind === "sync" && item.status === "needs_review" && suggestion && !choices.length) {
        const box = el("div", undefined, "sync-suggestion"),
          use = button("Use suggested instructions", () => {
            input.value = suggestion;
            drafts.set(item.id, suggestion);
            updateSubmit();
            input.focus();
          });
        use.disabled = busy;
        box.append(
          el("strong", "AI-suggested instructions"),
          el("p", suggestion, "sync-suggestion-text"),
          el(
            "p",
            "Review and edit before submitting. Nothing is authorized until you click Re-Sync.",
            "sync-subtle",
          ),
          use,
        );
        feedback.append(box);
      }
      const actions = el("div", undefined, "sync-feedback-actions"),
        forceLabel = el("label"),
        force = el("input");
      force.type = "checkbox";
      force.checked = reconvertIds.has(item.id);
      force.onchange = () =>
        force.checked
          ? reconvertIds.add(item.id)
          : reconvertIds.delete(item.id);
      forceLabel.append(force, document.createTextNode("Reconvert original"));
      const b = button(
        job.kind === "delete" ? "Regenerate deletion preview →" : "Re-Sync →",
        async () => {
          const chosen = choices.find(o => o.id === selectedChoices.get(item.id));
          const instruction = chosen
            ? `${chosen.instructions}${input.value.trim() ? `\n\nAdditional instructions:\n${input.value}` : ""}`
            : input.value;
          if (instruction.length > 16000) throw new Error("Combined instructions must be at most 16000 characters.");
          const next = await api(`jobs/${job.id}/resync`, "POST", {
            itemId: item.id,
            feedback: instruction,
            ...(job.kind === "sync" ? { forceConvert: force.checked } : {}),
          });
          // Re-Sync replaces this card in place with a new attempt ID.
          const attempt = next.items?.find((i) =>
            i.attempts?.some((a) => a.id === item.id),
          );
          if (attempt) {
            openCards.add(attempt.id);
            drafts.delete(item.id);
            selectedChoices.delete(item.id);
            reconvertIds.delete(item.id);
          }
          await choose(next);
        },
        item.status === "awaiting_confirmation"
          ? "sync-button"
          : "sync-button sync-button-primary",
      );
      updateSubmit();
      if (job.kind === "sync") actions.append(forceLabel);
      actions.append(b);
      feedback.append(label, input, actions);
      (decisionAnchor || content).append(feedback);
    }
    card.append(content);
    holder.append(card);
  }
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    await incoming();
    await loadHistory();
    await refreshImports();
  } finally {
    polling = false;
  }
}
async function uploadFiles(files) {
  if (uploading) return;
  const accepted = Array.from(files).filter(
    (file) => !/^readme\.md$/i.test(file.name),
  );
  if (!accepted.length) {
    $("upload-status").textContent =
      "README.md is ignored. No documents to upload.";
    $("upload").value = "";
    return;
  }
  const oversized = accepted.find((file) => file.size > maxFileBytes);
  if (oversized)
    throw Error(
      `${oversized.name} exceeds the ${Math.round(maxFileBytes / 1048576)} MB upload limit.`,
    );
  uploading = true;
  $("upload").disabled = true;
  updateControls();
  try {
    for (const [index, file] of accepted.entries()) {
      $("upload-status").textContent =
        `Uploading ${index + 1} of ${accepted.length} · ${file.name}`;
      await api(`incoming?name=${encodeURIComponent(file.name)}`, "POST", file);
    }
  } finally {
    uploading = false;
    $("upload").disabled = false;
    $("upload").value = "";
    incomingCache = "";
    updateControls();
  }
}
for (const [index, name] of tabNames.entries()) {
  const tab = $(`tab-${name}`);
  tab.onclick = () => setTab(name);
  tab.onkeydown = (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabNames.length;
    else if (event.key === "ArrowLeft")
      next = (index + tabNames.length - 1) % tabNames.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabNames.length - 1;
    else return;
    event.preventDefault();
    setTab(tabNames[next]);
    $(`tab-${tabNames[next]}`).focus();
  };
}
setTab(activeTab, false);
$("refresh").onclick = () => action(refresh);
$("select-all").onchange = () => {
  for (const input of $("incoming").querySelectorAll("input:not(:disabled)"))
    input.checked = $("select-all").checked;
  updateControls();
};
$("start").onclick = () =>
  action(async () => {
    const ids = selectedIds();
    if (!ids.length) throw Error("Select incoming files first.");
    await choose(await api("jobs", "POST", { ids }));
  });
$("preview").onclick = () =>
  action(async () =>
    choose(
      await api("delete-preview", "POST", { prompt: $("delete-prompt").value }),
    ),
  );
$("upload").onchange = () => action(() => uploadFiles($("upload").files));
const dropZone = $("drop-zone");
let dragDepth = 0;
dropZone.ondragenter = (e) => {
  e.preventDefault();
  dragDepth++;
  dropZone.classList.add("drag-over");
};
dropZone.ondragover = (e) => e.preventDefault();
dropZone.ondragleave = (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropZone.classList.remove("drag-over");
  }
};
dropZone.ondrop = (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer?.files.length)
    action(() => uploadFiles(e.dataTransfer.files));
};
let selectedImport,
  importCache = "",
  importHistoryCache = "",
  importStarting = false;
async function importApi(route, method = "GET", body) {
  const res = await fetch(`/api/sftp-sync/${route}`, {
    method,
    headers: {
      "X-Local-Token": token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/login";
    throw Error("Please sign in.");
  }
  const data = await readJson(res);
  if (!res.ok) throw Error(data.error || "Import request failed.");
  return data;
}
async function refreshImports() {
  const state = await importApi("status");
  $("import-config").textContent = !state.configured
    ? `Set ${state.missing.join(", ")} in .env, then restart.`
    : state.recoveryError || state.listError
      ? state.recoveryError || state.listError
      : `${state.paths} configured ${state.paths === 1 ? "path" : "paths"}${state.invalid ? ` · ${state.invalid} invalid lines` : ""}`;
  $("import-paths").textContent = state.pathsFile;
  $("import-run").disabled =
    importStarting ||
    !!state.running ||
    !state.configured ||
    !!state.listError ||
    (!state.paths && !state.invalid);
  $("import-run").textContent = state.running ? "Import running…" : "Run now →";
  const reports = state.reports;
  if (!selectedImport && reports.length)
    selectedImport = state.running || reports[0].id;
  const key = JSON.stringify({ reports, selectedImport });
  if (key !== importHistoryCache) {
    importHistoryCache = key;
    $("import-history").replaceChildren();
    for (const run of reports) {
      const b = button(
        "",
        async () => {
          selectedImport = run.id;
          importCache = "";
          await refreshImports();
        },
        "sync-history-item",
      );
      b.append(
        el("strong", "SFTP import"),
        el("time", dateLabel(run.created)),
        badge(run.status),
        el(
          "small",
          Object.entries(run.counts)
            .map(([s, n]) => `${n} ${s.replaceAll("_", " ")}`)
            .join(" · "),
        ),
      );
      if (run.id === selectedImport) {
        b.classList.add("selected");
        b.setAttribute("aria-current", "true");
      }
      $("import-history").append(b);
    }
  }
  if (!selectedImport) return;
  const run = await importApi(`runs/${selectedImport}`),
    encoded = JSON.stringify(run);
  if (encoded === importCache) return;
  importCache = encoded;
  const holder = $("import-report");
  holder.replaceChildren();
  const heading = el("div", undefined, "sync-report-heading"),
    title = el("div");
  title.append(el("h3", "Import report"), badge(run.status));
  heading.append(title);
  if (run.status === "running")
    heading.append(
      button("Stop", () => importApi(`runs/${run.id}/stop`, "POST", {})),
    );
  holder.append(heading, el("p", dateLabel(run.created), "sync-report-date"));
  if (run.error) holder.append(el("p", run.error, "sync-file-error"));
  for (const item of run.items) {
    const card = el("details", undefined, "sync-card"),
      summary = el("summary"),
      body = el("div", undefined, "sync-card-body");
    card.open = ["failed", "interrupted"].includes(item.status);
    summary.append(
      el("span", item.path || `JSONL line ${item.line}`, "sync-card-title"),
      badge(item.status),
    );
    body.append(
      el(
        "p",
        `Line ${item.line} · ${item.attempts} ${item.attempts === 1 ? "attempt" : "attempts"}${item.bytes !== undefined ? ` · ${fileSize(item.bytes)}` : ""}`,
      ),
    );
    if (item.error) body.append(el("p", item.error, "sync-file-error"));
    if (item.target) body.append(el("p", `Incoming file: ${item.target}`));
    if (item.hash) body.append(el("code", `SHA256 ${item.hash}`));
    card.append(summary, body);
    holder.append(card);
  }
}
$("import-run").onclick = () =>
  action(async () => {
    if (importStarting) return;
    importStarting = true;
    $("import-run").disabled = true;
    try {
      const run = await importApi("runs", "POST", {});
      selectedImport = run.id;
      importCache = "";
    } finally {
      importStarting = false;
    }
  });
(async () => {
  try {
    const response = await fetch("/api/auth/status"),
      auth = await response.json();
    if (!auth.authenticated) {
      location.href = "/login";
      return;
    }
    token = auth.token;
    await refresh();
    let pollFailed = false;
    setInterval(() => {
      if (document.hidden) return;
      refresh().then(
        () => {
          if (pollFailed) $("sync-error").hidden = true;
          pollFailed = false;
        },
        (e) => {
          pollFailed = true;
          error(e);
        },
      );
    }, 2000);
  } catch (e) {
    error(e);
  }
})();
