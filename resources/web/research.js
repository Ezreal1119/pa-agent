"use strict";
const $ = (id) => document.getElementById(id);
const sceneNames = {
  retail: "零售门店",
  logistics: "仓储物流",
  coldChain: "冷链",
  manufacturing: "工业制造",
  field: "医疗与现场服务",
  payment: "支付与移动收款",
  management: "跨行业设备管理",
};
const states = {
  running: "研究中",
  reviewing: "独立审核中",
  wrapping: "正在收尾",
  completed: "已完成",
  failed: "运行失败",
  interrupted: "已中断",
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
    throw new Error("请重新登录");
  }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "请求失败");
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
    `浏览 ${data.days[0]} 至 ${data.days.at(-1)}；新研究始终覆盖截止日期在内的十四天。`;
  $("export").href =
    "/api/research/export?" +
    new URLSearchParams({
      endDate: $("end-date").value,
      days: $("days").value,
    });
  $("count").textContent = data.items.length + " 条资讯";
  $("items").replaceChildren();
  for (const i of data.items) {
    const card = el("article", undefined, "card");
    card.append(
      el(
        "div",
        `${i.date} · ${sceneNames[i.scene]} · ${i.score} 分${i.status !== "active" ? " · " + i.status : ""}`,
        "meta",
      ),
      el("h3", i.title),
      el("p", i.brief.news),
      el("p", "销售参考：" + i.brief.sales, "sales"),
    );
    if (i.tags.length) card.append(el("p", i.tags.join(" / "), "meta"));
    if (i.updatedAfterCutoff)
      card.append(
        el(
          "p",
          "含截止日之后的补充：" +
            new Date(i.updatedAt).toLocaleString("zh-CN", {
              timeZone: "Asia/Shanghai",
            }),
          "meta",
        ),
      );
    const b = el("button", "查看详情与依据 →");
    b.onclick = () => showItem(i.id).catch(notice);
    card.append(b);
    $("items").append(card);
  }
  if (!data.items.length)
    $("items").append(
      el(
        "div",
        "这个范围暂无合格资讯。可查看每日覆盖，或运行一次研究。",
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
            ? `${s.count} 条`
            : s.status === "not_searched"
              ? "未检索"
              : "已检索无合格发现",
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
    el("h2", r ? "研究进度 · " + states[r.state] : "研究进度"),
  );
  if (!r) {
    box.append(el("p", "尚未运行", "muted"));
    return;
  }
  box.append(
    el(
      "p",
      `${r.days[0]} — ${r.endDate} · ${new Date(r.startedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
      "meta",
    ),
  );
  const pills = el("div", undefined, "pills");
  for (const text of [
    `搜索 ${r.metrics.search}`,
    `网页读取 ${r.metrics.fetch}`,
    `待审核 ${r.pending}`,
    `本次入库/补充 ${r.checkpoints.reduce((n, p) => n + p.changes.length, 0)}`,
  ])
    pills.append(el("span", text));
  box.append(pills);
  for (const p of r.checkpoints) {
    box.append(
      el(
        "p",
        `${(p.elapsedMs / 60000).toFixed(1)} 分钟${p.final ? " · 最终审核" : ""}：增量 ${p.points} 分，${p.continued ? "继续研究" : "收尾"}。${p.error ?? p.review?.summary ?? "没有待审核候选。"}`,
        "meta",
      ),
    );
  }
  if (r.stopReason) box.append(el("p", r.stopReason));
  if (r.errors.length) box.append(el("p", r.errors.join("\n"), "meta"));
  if (r.candidates.length) {
    const more = el("details");
    more.append(el("summary", "候选处理结果"));
    for (const c of r.candidates)
      more.append(el("p", c.title + "：" + c.outcome, "meta"));
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
        `${r.endDate} · ${states[r.state]}\n${new Date(r.startedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
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
      `${i.article.disclosureDate} · ${sceneNames[i.article.scene]} · 版本 ${i.version} · ${i.score} 分`,
      "meta",
    ),
  );
  line(b, "新闻摘要", i.article.brief.news);
  line(
    b,
    "事实与证据",
    i.article.facts
      .map(
        (f) =>
          f.claim +
          "\n" +
          f.citations.map((c) => "“" + c.quote + "”").join("\n"),
      )
      .join("\n\n"),
  );
  line(b, "部署情况", i.article.deployment);
  line(
    b,
    "竞争信息 · " +
      { confirmed: "已证实", inferred: "推断", undisclosed: "未披露" }[
        i.article.competition.status
      ],
    i.article.competition.detail,
  );
  line(b, "UROVO 业务关联", i.article.urovo.relevance);
  if (i.article.urovo.productClaims.length)
    line(
      b,
      "产品依据",
      i.article.urovo.productClaims
        .map(
          (p) =>
            p.claim +
            "\n" +
            p.citations.map((c) => "“" + c.quote + "”").join("\n"),
        )
        .join("\n\n"),
    );
  line(b, "详细分析", i.article.detail.analysis);
  line(b, "销售建议", i.article.detail.sales);
  line(b, "待确认问题", i.article.detail.questions.join("\n") || "无");
  line(b, "限制", i.article.detail.limitations.join("\n") || "无");
  const dimensions = {
    relevance: "业务相关",
    commercial: "商业参考",
    evidence: "证据有效性",
    importance: "行业重要度",
    novelty: "新增信息",
  };
  line(
    b,
    "审核依据",
    i.review.reason +
      "\n" +
      Object.entries(i.review.scores)
        .map(([k, v]) => dimensions[k] + "：" + v + " / 5")
        .join("\n"),
  );
  b.append(el("h4", "来源与产品依据"));
  for (const e of i.evidence) {
    const details = el("details");
    details.append(
      el(
        "summary",
        `${e.kind === "web" ? "网页" : "内部产品资料"} · ${e.title}`,
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
      el("p", "读取时间：" + e.fetchedAt, "meta"),
      el("pre", e.content),
    );
    b.append(details);
  }
  b.append(el("h4", "修订记录"));
  i.history.forEach((h, index) => {
    const version = el("details");
    version.append(
      el(
        "summary",
        `版本 ${index + 1} · ${new Date(h.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · ${h.reason}`,
      ),
    );
    line(version, "当时的资讯", h.article.brief.news);
    line(version, "当时的详细分析", h.article.detail.analysis);
    line(version, "当时的销售建议", h.article.detail.sales);
    line(
      version,
      "当时的限制",
      h.article.detail.limitations.join("\n") || "无",
    );
    b.append(version);
  });
  if (i.article.relatedIds.length) {
    b.append(el("h4", "关联进展"));
    for (const relatedId of i.article.relatedIds) {
      const related = el("button", "查看关联事件 →");
      related.onclick = () => showItem(relatedId).catch(notice);
      b.append(related);
    }
  }
  if (!i.archived) {
    const label = el("label", "归档原因");
    const reason = el("input");
    reason.maxLength = 2000;
    label.append(reason);
    const archive = el("button", "归档此条目");
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
