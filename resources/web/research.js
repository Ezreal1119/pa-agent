"use strict";
const $ = (id) => document.getElementById(id);
const sceneNames = {
  retail: "Retail stores",
  logistics: "Warehousing and logistics",
  coldChain: "Cold chain",
  manufacturing: "Manufacturing",
  field: "Healthcare and field services",
  payment: "Payments and mobile checkout",
  management: "Cross-industry device management",
};
const states = {
  running: "Researching",
  reviewing: "Independent review",
  wrapping: "Wrapping up",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
};
let token = "",
  activeId = null,
  selectedRun = null,
  lastRevision = "",
  polling = false;
function el(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = String(text);
  if (className) n.className = className;
  return n;
}
function line(parent, label, text) {
  parent.append(el("h4", label), el("p", text));
}
function notice(e) {
  $("notice").textContent = e instanceof Error ? e.message : String(e ?? "");
}
async function api(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-local-token": token,
      ...options.headers,
    },
  });
  if (r.status === 401) {
    location.href = "/login";
    throw new Error("Please sign in again.");
  }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "Request failed.");
  return data;
}
function params() {
  return new URLSearchParams({
    endDate: $("end-date").value,
    days: $("days").value,
    scene: $("scene").value,
    tag: $("tag").value.trim(),
  });
}
async function browse() {
  const p = params();
  const data = await api("/api/research/items?" + p);
  $("range").textContent =
    `Browsing ${data.days[0]} to ${data.days.at(-1)}. New research always covers the 14 days ending on the selected date.`;
  $("export").href =
    "/api/research/export?" +
    new URLSearchParams({
      endDate: $("end-date").value,
      days: $("days").value,
    });
  $("count").textContent = data.items.length + " news items";
  $("items").replaceChildren();
  for (const i of data.items) {
    const card = el("article", undefined, "card");
    card.append(
      el(
        "div",
        `${i.date} · ${sceneNames[i.scene]} · ${i.score} points${i.status !== "active" ? " · " + i.status : ""}`,
        "meta",
      ),
      el("h3", i.title),
      el("p", i.brief.news),
      el("p", "Sales insights: " + i.brief.sales, "sales"),
    );
    if (i.tags.length) card.append(el("p", i.tags.join(" / "), "meta"));
    if (i.updatedAfterCutoff)
      card.append(
        el(
          "p",
          "Includes updates after the end date: " +
            new Date(i.updatedAt).toLocaleString("en-US", {
              timeZone: "Asia/Shanghai",
            }),
          "meta",
        ),
      );
    const b = el("button", "View details and evidence →");
    b.onclick = () => showItem(i.id).catch(notice);
    card.append(b);
    $("items").append(card);
  }
  if (!data.items.length)
    $("items").append(
      el(
        "div",
        "No qualifying news in this range. Check daily coverage or start a research run.",
        "panel",
      ),
    );
  $("coverage").replaceChildren();
  for (const d of data.coverage) {
    const box = el("details", undefined, "coverage-day");
    box.append(el("summary", d.date));
    for (const s of d.scenes) {
      const row = el("div", undefined, "coverage-row");
      row.append(
        el("span", sceneNames[s.scene]),
        el(
          "span",
          s.status === "found"
            ? `${s.count} items`
            : s.status === "not_searched"
              ? "Not searched"
              : "Searched; no qualifying results",
        ),
      );
      box.append(row);
    }
    $("coverage").append(box);
  }
}
function progress(r) {
  const box = $("progress");
  box.replaceChildren(
    el("h2", r ? "Research progress · " + states[r.state] : "Research progress"),
  );
  if (!r) {
    box.append(el("p", "No runs yet", "muted"));
    return;
  }
  box.append(
    el(
      "p",
      `${r.days[0]} — ${r.endDate} · ${new Date(r.startedAt).toLocaleString("en-US", { timeZone: "Asia/Shanghai" })}`,
      "meta",
    ),
  );
  const pills = el("div", undefined, "pills");
  for (const text of [
    `Searches ${r.metrics.search}`,
    `Pages read ${r.metrics.fetch}`,
    `Pending review ${r.pending}`,
    `Added or updated this run ${r.checkpoints.reduce((n, p) => n + p.changes.length, 0)}`,
  ])
    pills.append(el("span", text));
  box.append(pills);
  for (const p of r.checkpoints) {
    box.append(
      el(
        "p",
        `${(p.elapsedMs / 60000).toFixed(1)} min${p.final ? " · Final review" : ""}: +${p.points} points; ${p.continued ? "continuing research" : "wrapping up"}. ${p.error ?? p.review?.summary ?? "No candidates pending review."}`,
        "meta",
      ),
    );
  }
  if (r.stopReason) box.append(el("p", r.stopReason));
  if (r.errors.length) box.append(el("p", r.errors.join("\n"), "meta"));
  if (r.candidates.length) {
    const more = el("details");
    more.append(el("summary", "Candidate results"));
    for (const c of r.candidates)
      more.append(el("p", c.title + ": " + c.outcome, "meta"));
    box.append(more);
  }
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const state = await api("/api/research/runs");
    activeId = state.active?.id ?? null;
    $("start").disabled = !!activeId;
    $("stop").disabled = !activeId;
    const current = selectedRun
      ? state.runs.find((r) => r.id === selectedRun)
      : (state.active ?? state.runs[0]);
    progress(current);
    $("runs").replaceChildren();
    for (const r of state.runs) {
      const b = el(
        "button",
        `${r.endDate} · ${states[r.state]}\n${new Date(r.startedAt).toLocaleString("en-US", { timeZone: "Asia/Shanghai" })}`,
        "run",
      );
      b.onclick = () => {
        selectedRun = r.id;
        progress(r);
      };
      $("runs").append(b);
    }
    const rev = state.runs
      .map((r) => r.id + ":" + r.checkpoints.length + ":" + r.state)
      .join("|");
    if (lastRevision && rev !== lastRevision) await browse();
    lastRevision = rev;
  } catch (e) {
    notice(e);
  } finally {
    polling = false;
  }
}
async function showItem(id) {
  const i = await api("/api/research/items/" + id);
  const b = $("detail-body");
  b.replaceChildren(
    el("h2", i.article.title),
    el(
      "p",
      `${i.article.disclosureDate} · ${sceneNames[i.article.scene]} · Version ${i.version} · ${i.score} points`,
      "meta",
    ),
  );
  line(b, "News summary", i.article.brief.news);
  line(
    b,
    "Facts and evidence",
    i.article.facts
      .map(
        (f) =>
          f.claim +
          "\n" +
          f.citations.map((c) => "“" + c.quote + "”").join("\n"),
      )
      .join("\n\n"),
  );
  line(b, "Deployment", i.article.deployment);
  line(
    b,
    "Competitive intelligence · " +
      { confirmed: "Confirmed", inferred: "Inferred", undisclosed: "Undisclosed" }[
        i.article.competition.status
      ],
    i.article.competition.detail,
  );
  line(b, "UROVO business relevance", i.article.urovo.relevance);
  if (i.article.urovo.productClaims.length)
    line(
      b,
      "Product evidence",
      i.article.urovo.productClaims
        .map(
          (p) =>
            p.claim +
            "\n" +
            p.citations.map((c) => "“" + c.quote + "”").join("\n"),
        )
        .join("\n\n"),
    );
  line(b, "Detailed analysis", i.article.detail.analysis);
  line(b, "Sales recommendations", i.article.detail.sales);
  line(b, "Open questions", i.article.detail.questions.join("\n") || "None");
  line(b, "Limitations", i.article.detail.limitations.join("\n") || "None");
  const dimensions = {
    relevance: "Business relevance",
    commercial: "Commercial value",
    evidence: "Evidence quality",
    importance: "Industry significance",
    novelty: "Novelty",
  };
  line(
    b,
    "Review rationale",
    i.review.reason +
      "\n" +
      Object.entries(i.review.scores)
        .map(([k, v]) => dimensions[k] + ": " + v + " / 5")
        .join("\n"),
  );
  b.append(el("h4", "Sources and product evidence"));
  for (const e of i.evidence) {
    const details = el("details");
    details.append(
      el(
        "summary",
        `${e.kind === "web" ? "Web page" : "Internal product documents"} · ${e.title}`,
      ),
    );
    if (e.kind === "web") {
      try {
        const u = new URL(e.locator);
        if (["https:", "http:"].includes(u.protocol)) {
          const a = el("a", e.locator);
          a.href = u.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          details.append(a);
        }
      } catch {}
    } else details.append(el("p", e.locator));
    details.append(
      el("p", "Retrieved at: " + e.fetchedAt, "meta"),
      el("pre", e.content),
    );
    b.append(details);
  }
  b.append(el("h4", "Revision history"));
  i.history.forEach((h, index) => {
    const version = el("details");
    version.append(
      el(
        "summary",
        `Version ${index + 1} · ${new Date(h.at).toLocaleString("en-US", { timeZone: "Asia/Shanghai" })} · ${h.reason}`,
      ),
    );
    line(version, "Previous news summary", h.article.brief.news);
    line(version, "Previous detailed analysis", h.article.detail.analysis);
    line(version, "Previous sales recommendations", h.article.detail.sales);
    line(
      version,
      "Previous limitations",
      h.article.detail.limitations.join("\n") || "None",
    );
    b.append(version);
  });
  if (i.article.relatedIds.length) {
    b.append(el("h4", "Related developments"));
    for (const relatedId of i.article.relatedIds) {
      const related = el("button", "View related event →");
      related.onclick = () => showItem(relatedId).catch(notice);
      b.append(related);
    }
  }
  if (!i.archived) {
    const label = el("label", "Archive reason");
    const reason = el("input");
    reason.maxLength = 2000;
    label.append(reason);
    const archive = el("button", "Archive this item");
    archive.onclick = async () => {
      try {
        await api("/api/research/items/" + id + "/archive", {
          method: "POST",
          body: JSON.stringify({ reason: reason.value }),
        });
        $("detail").close();
        await browse();
      } catch (e) {
        notice(e);
      }
    };
    b.append(label, archive);
  }
  if (!$("detail").open) $("detail").showModal();
}
$("detail-close").onclick = () => $("detail").close();
$("browse").onclick = () => browse().catch(notice);
$("start").onclick = async () => {
  try {
    notice("");
    $("start").disabled = true;
    const r = await api("/api/research/runs", {
      method: "POST",
      body: JSON.stringify({ endDate: $("end-date").value }),
    });
    selectedRun = null;
    activeId = r.id;
    await poll();
  } catch (e) {
    notice(e);
    $("start").disabled = false;
  }
};
$("stop").onclick = async () => {
  if (!activeId) return;
  try {
    await api("/api/research/runs/" + activeId + "/stop", {
      method: "POST",
      body: "{}",
    });
    await poll();
  } catch (e) {
    notice(e);
  }
};
(async () => {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  $("end-date").value = date;
  $("end-date").max = date;
  for (const [key, name] of Object.entries(sceneNames)) {
    const o = el("option", name);
    o.value = key;
    $("scene").append(o);
  }
  const auth = await api("/api/auth/status");
  token = auth.token;
  if (!auth.authenticated) {
    location.href = "/login";
    return;
  }
  await browse();
  await poll();
  setInterval(poll, 3000);
})().catch(notice);
