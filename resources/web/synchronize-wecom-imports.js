let selectedWecomImport,
  wecomReportCache = "",
  wecomHistoryCache = "",
  wecomStarting = false;
async function wecomImportApi(route, method = "GET", body) {
  const response = await fetch(`/api/wecom-import/${route}`, {
    method,
    headers: {
      "X-Local-Token": token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) {
    location.href = "/login";
    throw Error("Please sign in.");
  }
  const data = await readJson(response);
  if (!response.ok) throw Error(data.error || "WeCom import request failed.");
  return data;
}
async function refreshWecomImports() {
  void globalThis.refreshWecomSchedule?.();
  const state = await wecomImportApi("status");
  $("wecom-import-config").textContent =
    state.recoveryError ||
    state.listError ||
    state.configurationError ||
    `${state.documents} configured ${state.documents === 1 ? "document" : "documents"} · ${state.docsFile}`;
  $("wecom-import-run").disabled =
    wecomStarting ||
    !!state.running ||
    !state.configured ||
    !!state.listError ||
    !!state.recoveryError ||
    !state.documents;
  $("wecom-import-run").textContent = state.running
    ? "Import running…"
    : "Run now →";
  if (!selectedWecomImport && state.reports.length)
    selectedWecomImport = state.running || state.reports[0].id;
  const historyKey = JSON.stringify([state.reports, selectedWecomImport]);
  if (historyKey !== wecomHistoryCache) {
    wecomHistoryCache = historyKey;
    $("wecom-import-history").replaceChildren();
    for (const report of state.reports) {
      const entry = button(
        "",
        async () => {
          selectedWecomImport = report.id;
          wecomReportCache = "";
          await refreshWecomImports();
        },
        "sync-history-item",
      );
      entry.append(
        el("strong", "WeCom import"),
        el("time", dateLabel(report.created)),
        badge(report.status),
        el(
          "small",
          Object.entries(report.counts)
            .map(([status, count]) => `${count} ${status.replaceAll("_", " ")}`)
            .join(" · "),
        ),
      );
      if (report.id === selectedWecomImport) {
        entry.classList.add("selected");
        entry.setAttribute("aria-current", "true");
      }
      $("wecom-import-history").append(entry);
    }
  }
  if (!selectedWecomImport) return;
  const report = await wecomImportApi(`runs/${selectedWecomImport}`),
    encoded = JSON.stringify(report);
  if (encoded === wecomReportCache) return;
  const holder = $("wecom-import-report");
  const expanded = new Set(
    [...holder.querySelectorAll("details[data-docid][open]")].map(
      (node) => node.dataset.docid,
    ),
  );
  wecomReportCache = encoded;
  holder.replaceChildren();
  const heading = el("div", undefined, "sync-report-heading"),
    title = el("div");
  title.append(el("h3", "WeCom import report"), badge(report.status));
  heading.append(title);
  if (["running", "stopping"].includes(report.status))
    heading.append(
      button("Stop", () =>
        wecomImportApi(`runs/${report.id}/stop`, "POST", {}),
      ),
    );
  holder.append(
    heading,
    el("p", dateLabel(report.created), "sync-report-date"),
  );
  if (report.error) holder.append(el("p", report.error, "sync-file-error"));
  if (report.removedSources?.length)
    holder.append(
      el(
        "p",
        `Removed from list: ${report.removedSources.join(", ")}. Existing knowledge is retained.`,
        "sync-subtle",
      ),
    );
  for (const item of report.items) {
    const card = el("details", undefined, "sync-card"),
      summary = el("summary"),
      body = el("div", undefined, "sync-card-body");
    card.dataset.docid = item.docid;
    card.open =
      expanded.has(item.docid) ||
      ["failed", "interrupted"].includes(item.status);
    summary.append(
      el("span", item.description, "sync-card-title"),
      badge(item.status),
    );
    body.append(el("p", item.docid, "sync-subtle"));
    if (item.title) body.append(el("p", `Document: ${item.title}`));
    if (item.version) body.append(el("p", `Document version: ${item.version}`));
    if (item.stage) body.append(el("p", item.stage));
    if (item.error) body.append(el("p", item.error, "sync-file-error"));
    if (item.coverage?.length) {
      const details = el("details"),
        label = el(
          "summary",
          `Reading coverage · ${item.coverage.length} checks`,
        ),
        list = el("ul");
      for (const check of item.coverage) list.append(el("li", check));
      details.append(label, list);
      body.append(details);
    }
    for (const output of item.outputs) {
      const line = el("div", undefined, "wecom-import-output");
      line.append(
        el("strong", output.title),
        badge(output.status),
        el("p", `Incoming file: ${output.target}`, "sync-subtle"),
        el("code", `SHA256 ${output.hash}`),
      );
      body.append(line);
    }
    if (item.removedSheets?.length)
      body.append(
        el(
          "p",
          `Removed worksheets: ${item.removedSheets.join(", ")}. Existing knowledge is retained.`,
          "sync-subtle",
        ),
      );
    card.append(summary, body);
    holder.append(card);
  }
}
$("wecom-import-run").onclick = () =>
  action(async () => {
    if (wecomStarting) return;
    wecomStarting = true;
    $("wecom-import-run").disabled = true;
    try {
      const run = await wecomImportApi("runs", "POST", {});
      selectedWecomImport = run.id;
      wecomReportCache = "";
    } finally {
      wecomStarting = false;
    }
  });
