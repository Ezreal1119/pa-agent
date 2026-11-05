/**
 * 逐工序录入页：把「一道工序该有什么」写进 Library 的工序文件夹。
 * 只做录入与保存，出表仍由工作台的「新建 SOP」触发，沿用原有工作流。
 */
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  // 生产环境页面挂在 /admin/ 下（nginx 反代到本服务），而接口是根路径 /api/…。
  // 不加这个前缀，fetch("/api/…") 会打到站点根，被 nginx 转到另一个上游（502）。
  const adminBase = location.pathname.startsWith("/admin") ? "/admin" : "";
  const MAX_EDGE = 1600;
  const JPEG_QUALITY = 0.82;

  const state = {
    projects: [],
    projectId: "",
    language: "中文",
    processes: [],
    /** 当前编辑的工序序号（1 开始）；null 表示还没保存过的新工序 */
    current: null,
    photos: [],
    dirty: false,
    dragFolder: null
  };

  /* ---------------------------------------------------------------- 基础 */

  const escapeHtml = value =>
    String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

  async function api(path, options = {}) {
    const { method = "GET", body } = options;
    const headers = { "X-CKD-UI": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(adminBase + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let value = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = null;
    }
    if (!response.ok) throw new Error((value && value.error) || `请求失败（${response.status}）`);
    return value;
  }

  function notice(message) {
    const box = $("notice");
    if (!message) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    box.hidden = false;
    box.textContent = message;
  }

  function setState(text, kind) {
    const node = $("save-state");
    node.textContent = text;
    node.className = `save-state${kind ? ` ${kind}` : ""}`;
  }

  function markDirty() {
    state.dirty = true;
    setState("有未保存的改动。", "dirty");
  }

  function markClean(text) {
    state.dirty = false;
    setState(text || "已保存。", "ok");
  }

  /* ------------------------------------------------------------ 项目与语言 */

  function renderProjects() {
    const select = $("project");
    if (!state.projects.length) {
      select.innerHTML = `<option value="">（还没有项目）</option>`;
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.innerHTML = state.projects
      .map(project => `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.displayName)}（${project.processCount} 道工序）</option>`)
      .join("");
    select.value = state.projectId;
  }

  async function loadProjects() {
    const value = await api("/api/editor");
    state.projects = value.projects || [];
    if (!state.projectId && state.projects.length) state.projectId = state.projects[0].projectId;
    if (state.projectId && !state.projects.some(project => project.projectId === state.projectId)) {
      state.projectId = state.projects[0] ? state.projects[0].projectId : "";
    }
    renderProjects();
    renderSopInfo();
  }

  /* ---------------------------------------------------------------- 工序列表 */

  function renderProcessList() {
    const list = $("process-list");
    if (!state.processes.length) {
      list.innerHTML = `<p class="process-empty">这个项目还没有工序，点右上角「＋」新建。</p>`;
      return;
    }
    list.innerHTML = state.processes
      .map(process => `
        <div class="process-item${process.order === state.current ? " selected" : ""}" draggable="true" data-folder="${escapeHtml(process.folder)}" data-order="${process.order}">
          <span class="process-index">${String(process.order).padStart(2, "0")}</span>
          <span class="process-name">${escapeHtml(process.metadata || "（未命名）")}</span>
          <span class="process-count">${process.photoCount} 图</span>
        </div>`)
      .join("");
  }

  async function loadProcesses() {
    if (!state.projectId) {
      state.processes = [];
      state.current = null;
      renderProcessList();
      showForm(false);
      return;
    }
    const value = await api(`/api/editor/process?project=${encodeURIComponent(state.projectId)}&language=${encodeURIComponent(state.language)}`);
    state.processes = value.processes || [];
    // 项目下拉里的「N 道工序」跟着刷新，否则建完工序还显示 0。
    const project = state.projects.find(item => item.projectId === state.projectId);
    if (project && project.processCount !== state.processes.length) {
      project.processCount = state.processes.length;
      renderProjects();
    }
    renderProcessList();
    if (state.current !== null && !state.processes.some(process => process.order === state.current)) {
      state.current = null;
      showForm(false);
    }
  }

  function showForm(visible) {
    $("empty").hidden = visible;
    $("process-form").hidden = !visible;
  }

  /* ---------------------------------------------------------------- 表单填充 */

  function photoUrl(name) {
    return `${adminBase}/api/editor/photo?project=${encodeURIComponent(state.projectId)}&language=${encodeURIComponent(state.language)}&order=${state.current}&name=${encodeURIComponent(name)}`;
  }

  function renderPhotos() {
    const container = $("photos");
    container.innerHTML = state.photos
      .map((photo, index) => `
        <div class="photo-card" data-index="${index}">
          <div class="photo-head"><span>第 ${index + 1} 张</span><button type="button" data-action="remove-photo">移除</button></div>
          <img src="${photo.url}" alt="第 ${index + 1} 张操作图">
          <textarea rows="3" placeholder="这张图对应的操作步骤" data-action="steps">${escapeHtml(photo.steps || "")}</textarea>
        </div>`)
      .join("");
    $("photo-count").textContent = `${state.photos.length} 张`;
  }

  function renderBom() {
    const body = $("bom-body");
    if (!state.bom.length) state.bom.push({ partno: "", spec: "", qty: "" });
    body.innerHTML = state.bom
      .map((row, index) => `
        <tr data-index="${index}">
          <td>${index + 1}</td>
          <td><input data-field="partno" value="${escapeHtml(row.partno)}" placeholder="料号" autocomplete="off"></td>
          <td><input data-field="spec" value="${escapeHtml(row.spec)}" placeholder="规格" autocomplete="off"></td>
          <td><input data-field="qty" value="${escapeHtml(row.qty)}" placeholder="必填" inputmode="decimal"></td>
          <td><button type="button" class="row-remove" data-action="remove-bom" aria-label="删除这一行">×</button></td>
        </tr>`)
      .join("");
  }

  function renderTools() {
    const body = $("tool-body");
    if (!state.tools.length) state.tools.push({ name: "", specs: "", qty: "" });
    body.innerHTML = state.tools
      .map((row, index) => `
        <tr data-index="${index}">
          <td>${index + 1}</td>
          <td><input data-field="name" value="${escapeHtml(row.name)}" placeholder="名称" autocomplete="off"></td>
          <td><input data-field="specs" value="${escapeHtml(row.specs)}" placeholder="规格" autocomplete="off"></td>
          <td><input data-field="qty" value="${escapeHtml(row.qty)}" placeholder="" inputmode="decimal"></td>
          <td><button type="button" class="row-remove" data-action="remove-tool" aria-label="删除这一行">×</button></td>
        </tr>`)
      .join("");
  }

  function fillForm(record) {
    $("metadata").value = record.metadata || "";
    $("prev-check").value = record.previousStationCheck || "";
    $("self-check").value = record.selfCheck || "";
    $("hours").value = record.hours === null || record.hours === undefined ? "" : String(record.hours);
    $("manpower").value = record.manpower === null || record.manpower === undefined ? "" : String(record.manpower);
    $("folder-label").textContent = (record.folder || "").toUpperCase();
    $("form-title").textContent = record.metadata || "新工序";

    state.photos = (record.photos || []).map((photo, index) => ({
      kind: "keep",
      name: photo.name,
      url: photoUrl(photo.name),
      steps: (record.paragraphs || [])[index] || ""
    }));
    state.bom = (record.bom || []).map(row => ({ partno: row.partno, spec: row.spec, qty: String(row.qty) }));
    state.tools = (record.tools || []).map(row => ({ name: row.name, specs: row.specs, qty: row.qty === null ? "" : String(row.qty) }));
    renderPhotos();
    renderBom();
    renderTools();
  }

  /**
   * 「作业前检查」留空时的默认值：取上一道工序的「自检」内容。
   * 上一道检查的正是它自己的自检项，所以默认沿用，用户仍可改。
   */
  async function previousSelfCheck(order) {
    const previous = state.processes
      .filter(process => process.order < order)
      .reduce((last, process) => (last && last.order > process.order ? last : process), null);
    if (!previous) return "";
    try {
      const value = await api(`/api/editor/process?project=${encodeURIComponent(state.projectId)}&language=${encodeURIComponent(state.language)}&order=${previous.order}&photos=0`);
      return (value && value.process && value.process.selfCheck) || "";
    } catch {
      return "";
    }
  }

  async function openProcess(order) {
    if (!state.projectId) return;
    if (state.dirty && !confirm("当前工序有未保存的改动，确定切换吗？")) return;
    const value = await api(`/api/editor/process?project=${encodeURIComponent(state.projectId)}&language=${encodeURIComponent(state.language)}&order=${order}&photos=0`);
    state.current = order;
    fillForm(value.process);
    if (!$("prev-check").value) {
      const inherited = await previousSelfCheck(order);
      if (inherited && !$("prev-check").value) $("prev-check").value = inherited;
    }
    renderProcessList();
    showForm(true);
    notice("");
    markClean("已加载。修改后点右下角保存。");
  }

  async function openBlankProcess() {
    if (!state.projectId) {
      notice("先新建或选择一个项目。");
      return;
    }
    if (state.dirty && !confirm("当前工序有未保存的改动，确定新建吗？")) return;
    const next = state.processes.reduce((max, process) => Math.max(max, process.order), 0) + 1;
    state.current = next;
    state.photos = [];
    state.bom = [{ partno: "", spec: "", qty: "" }];
    state.tools = [{ name: "", specs: "", qty: "" }];
    $("metadata").value = "";
    $("prev-check").value = "";
    $("self-check").value = "";
    $("hours").value = "";
    $("manpower").value = "";
    $("folder-label").textContent = `PROCESS_${String(next).padStart(2, "0")}`;
    $("form-title").textContent = "新工序";
    renderPhotos();
    renderBom();
    renderTools();
    renderProcessList();
    showForm(true);
    notice("");
    markDirty();
    setState("填好内容后点「保存到 Library」。", "dirty");
    $("metadata").focus();
    // 新工序默认带出上一道的自检内容，作为「作业前检查」。
    const inherited = await previousSelfCheck(next);
    if (inherited && !$("prev-check").value) {
      $("prev-check").value = inherited;
      $("prev-check").classList.add("inherited");
    }
  }

  /* ---------------------------------------------------------------- 图片 */

  /** 压到长边 1600、JPEG 0.82：一张手机图从 4 MB 降到 300 KB 左右。 */
  async function compress(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) throw new Error("图片压缩失败。");
    return { blob, dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY) };
  }

  async function addFiles(files) {
    const images = Array.from(files).filter(file => /^image\/(?:png|jpeg)$/u.test(file.type));
    if (!images.length) return;
    for (const file of images) {
      try {
        const compressed = await compress(file);
        state.photos.push({ kind: "new", dataUrl: compressed.dataUrl, url: URL.createObjectURL(compressed.blob), steps: "" });
      } catch (error) {
        notice(`处理 ${file.name} 时出错：${error.message}`);
      }
    }
    renderPhotos();
    markDirty();
  }

  /* ---------------------------------------------------------------- 保存 */

  function currentPhotosPayload() {
    return state.photos.map(photo => (photo.kind === "new" ? { dataUrl: photo.dataUrl } : { name: photo.name }));
  }

  async function save(event) {
    event.preventDefault();
    if (state.current === null) return;
    const metadata = $("metadata").value.trim();
    if (!metadata) {
      notice("工序名不能为空，它会写进 metadata.txt 并在 Excel 里显示。");
      $("metadata").focus();
      return;
    }
    const count = state.photos.length;
    if (count === 3) {
      notice("模板只支持 1 / 2 / 4 张图。3 张会没有对应版式，请改成 2 张或补一张到 4 张。");
      return;
    }
    if (count > 0 && state.photos.some(photo => !String(photo.steps || "").trim())) {
      notice("每张图都要写一段操作步骤；图和步骤数量不一致，打印出来会串位。");
      return;
    }
    const button = $("save");
    button.disabled = true;
    setState("正在保存…");
    try {
      const value = await api("/api/editor/process", {
        method: "POST",
        body: {
          projectId: state.projectId,
          language: state.language,
          order: state.current,
          metadata,
          bom: state.bom,
          tools: state.tools,
          paragraphs: state.photos.map(photo => photo.steps || ""),
          photos: currentPhotosPayload(),
          selfCheck: $("self-check").value,
          previousStationCheck: $("prev-check").value,
          hours: $("hours").value,
          manpower: $("manpower").value
        }
      });
      const result = value.result || {};
      state.photos = state.photos.map(photo => (photo.kind === "new"
        ? { kind: "keep", name: "", url: photo.url, steps: photo.steps }
        : photo));
      await loadProjects();
      await loadProcesses();
      // 组件顺序可能被服务端按 p1..pN 重排，重新读一次最稳。
      await openProcess(state.current);
      markClean(`已保存：${result.relativePath || ""}`);
      if (result.warnings && result.warnings.length) notice(result.warnings.join("\n"));
      else notice("");
    } catch (error) {
      setState(`保存失败：${error.message}`, "bad");
      notice(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function removeProcess() {
    if (state.current === null) return;
    if (!confirm(`确定删除 process_${String(state.current).padStart(2, "0")} 这道工序吗？文件夹会从 Library 里删除。`)) return;
    try {
      await api(`/api/editor/process?project=${encodeURIComponent(state.projectId)}&language=${encodeURIComponent(state.language)}&order=${state.current}`, { method: "DELETE" });
      state.current = null;
      state.dirty = false;
      await loadProjects();
      await loadProcesses();
      showForm(false);
      notice("");
      setState("已删除。", "ok");
    } catch (error) {
      notice(error.message);
    }
  }

  async function createProject() {
    const projectId = (prompt("项目文件夹名（product_lib 下的目录名，建议用项目代号）") || "").trim();
    if (!projectId) return;
    const displayName = (prompt("Excel 上显示的项目名（可留空，默认与文件夹名相同）") || "").trim();
    try {
      await api("/api/editor/projects", { method: "POST", body: { projectId, displayName } });
      state.projectId = projectId;
      await loadProjects();
      await loadProcesses();
      notice("");
    } catch (error) {
      notice(error.message);
    }
  }

  /* ---------------------------------------------------------------- 排序 */

  function bindDrag() {
    const list = $("process-list");
    list.addEventListener("dragstart", event => {
      const item = event.target.closest(".process-item");
      if (!item) return;
      state.dragFolder = item.dataset.folder;
      item.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.dataset.folder);
    });
    list.addEventListener("dragover", event => {
      const item = event.target.closest(".process-item");
      if (!item || !state.dragFolder) return;
      event.preventDefault();
      list.querySelectorAll(".drop-target").forEach(node => node.classList.remove("drop-target"));
      if (item.dataset.folder !== state.dragFolder) item.classList.add("drop-target");
    });
    list.addEventListener("drop", async event => {
      const item = event.target.closest(".process-item");
      event.preventDefault();
      const dragged = state.dragFolder;
      state.dragFolder = null;
      list.querySelectorAll(".dragging,.drop-target").forEach(node => node.classList.remove("dragging", "drop-target"));
      if (!item || !dragged) return;
      const order = state.processes.map(process => process.folder);
      const from = order.indexOf(dragged);
      const to = order.indexOf(item.dataset.folder);
      if (from < 0 || to < 0 || from === to) return;
      order.splice(to, 0, order.splice(from, 1)[0]);
      const editing = state.current;
      const editingFolder = editing === null ? null : `process_${String(editing).padStart(2, "0")}`;
      try {
        const value = await api("/api/editor/reorder", { method: "POST", body: { projectId: state.projectId, language: state.language, folders: order } });
        const moved = (value.result && value.result.mapping || []).find(entry => entry.from === editingFolder);
        state.current = moved ? Number(String(moved.to).replace("process_", "")) : null;
        await loadProcesses();
        if (state.current !== null) await openProcess(state.current);
      } catch (error) {
        notice(error.message);
        await loadProcesses();
      }
    });
    list.addEventListener("dragend", () => {
      state.dragFolder = null;
      list.querySelectorAll(".dragging,.drop-target").forEach(node => node.classList.remove("dragging", "drop-target"));
    });
  }

  /* ------------------------------------------------------------ SOP 基本信息 */

  /**
   * 封面信息不进 Library，只在本机按项目存一份：
   * 生成 Excel 时工作台的「基本信息」会带过去，由出表流程写进封面单元格。
   */
  const SOP_INFO_FIELDS = {
    name: "sop-name",
    author: "sop-author",
    reviewer: "sop-reviewer",
    document: "sop-document",
    version: "sop-version",
    versionNote: "sop-version-note",
    date: "sop-date",
    revisionReason: "sop-revision-reason",
    revisionContent: "sop-revision-content"
  };
  const sopInfoKey = projectId => `ckd-sop-info:${projectId}`;
  let sopInfoTimer = null;
  /** 已经渲染过基本信息的项目：重复渲染会冲掉用户正在输入但还没落盘的内容。 */
  let sopInfoRenderedFor = null;

  function readSopInfo() {
    const info = {};
    for (const [key, id] of Object.entries(SOP_INFO_FIELDS)) info[key] = $(id).value.trim();
    return info;
  }

  function renderSopInfo() {
    const panel = $("sop-info-panel");
    const projectId = state.projectId;
    if (sopInfoRenderedFor === projectId) return;
    sopInfoRenderedFor = projectId;
    $("sop-project").value = projectId || "";
    if (!projectId) {
      for (const id of Object.values(SOP_INFO_FIELDS)) $(id).value = "";
      panel.classList.add("disabled");
      $("sop-info-state").textContent = "先选项目";
      return;
    }
    panel.classList.remove("disabled");
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(sopInfoKey(projectId)) || "{}") || {};
    } catch {
      stored = {};
    }
    for (const [key, id] of Object.entries(SOP_INFO_FIELDS)) {
      const value = stored[key];
      $(id).value = typeof value === "string" ? value : "";
    }
    const project = state.projects.find(item => item.projectId === projectId);
    if (!$("sop-name").value) $("sop-name").value = `${project ? project.displayName : projectId} Assemble`;
    if (!$("sop-date").value) $("sop-date").value = new Date().toISOString().slice(0, 10);
    $("sop-info-state").textContent = stored.updatedAt ? "已存在本机" : "只存在本机";
  }

  function storeSopInfo() {
    if (!state.projectId) return;
    try {
      localStorage.setItem(sopInfoKey(state.projectId), JSON.stringify({ ...readSopInfo(), updatedAt: new Date().toISOString() }));
      localStorage.setItem("ckd-sop-info:last", state.projectId);
      $("sop-info-state").textContent = "已存在本机";
    } catch {
      // 隐私模式写不进 localStorage；这里静默失败，不影响录工序。
    }
  }

  function bindSopInfo() {
    for (const id of Object.values(SOP_INFO_FIELDS)) {
      $(id).addEventListener("input", () => {
        clearTimeout(sopInfoTimer);
        sopInfoTimer = setTimeout(storeSopInfo, 400);
      });
    }
  }

  /* ---------------------------------------------------------------- 事件 */

  function bind() {
    bindSopInfo();
    $("project").addEventListener("change", async event => {
      if (state.dirty && !confirm("当前工序有未保存的改动，确定切换项目吗？")) {
        event.target.value = state.projectId;
        return;
      }
      // 先把上一个项目的基本信息落盘，避免防抖还没触发就切走了。
      storeSopInfo();
      state.projectId = event.target.value;
      state.current = null;
      state.dirty = false;
      showForm(false);
      renderSopInfo();
      await loadProcesses();
      notice("");
    });

    $("language").addEventListener("change", async event => {
      if (state.dirty && !confirm("当前工序有未保存的改动，确定切换语言吗？")) {
        event.target.value = state.language;
        return;
      }
      state.language = event.target.value;
      state.current = null;
      state.dirty = false;
      showForm(false);
      await loadProcesses();
      notice("");
    });

    $("new-project").addEventListener("click", createProject);
    $("add-process").addEventListener("click", openBlankProcess);
    $("delete-process").addEventListener("click", removeProcess);
    $("process-form").addEventListener("submit", save);

    $("process-form").addEventListener("input", markDirty);
    $("metadata").addEventListener("input", event => {
      $("form-title").textContent = event.target.value.trim() || "新工序";
    });
    $("prev-check").addEventListener("input", event => event.target.classList.remove("inherited"));

    $("process-list").addEventListener("click", event => {
      const item = event.target.closest(".process-item");
      if (!item) return;
      openProcess(Number(item.dataset.order));
    });

    $("photo-input").addEventListener("change", async event => {
      await addFiles(event.target.files);
      event.target.value = "";
    });

    const dropzone = $("dropzone");
    ["dragenter", "dragover"].forEach(type => dropzone.addEventListener(type, event => {
      event.preventDefault();
      dropzone.classList.add("over");
    }));
    ["dragleave", "drop"].forEach(type => dropzone.addEventListener(type, () => dropzone.classList.remove("over")));
    dropzone.addEventListener("drop", async event => {
      event.preventDefault();
      if (event.dataTransfer && event.dataTransfer.files) await addFiles(event.dataTransfer.files);
    });

    $("photos").addEventListener("input", event => {
      if (event.target.dataset.action !== "steps") return;
      const card = event.target.closest(".photo-card");
      const index = Number(card.dataset.index);
      if (state.photos[index]) state.photos[index].steps = event.target.value;
    });
    $("photos").addEventListener("click", event => {
      if (event.target.dataset.action !== "remove-photo") return;
      const card = event.target.closest(".photo-card");
      const index = Number(card.dataset.index);
      const photo = state.photos[index];
      if (photo && photo.kind === "new" && photo.url) URL.revokeObjectURL(photo.url);
      state.photos.splice(index, 1);
      renderPhotos();
      markDirty();
    });

    $("add-bom").addEventListener("click", () => {
      state.bom.push({ partno: "", spec: "", qty: "" });
      renderBom();
      markDirty();
    });
    $("bom-body").addEventListener("input", event => {
      const row = event.target.closest("tr");
      const field = event.target.dataset.field;
      if (!row || !field) return;
      const index = Number(row.dataset.index);
      if (state.bom[index]) state.bom[index][field] = event.target.value;
    });
    $("bom-body").addEventListener("click", event => {
      if (event.target.dataset.action !== "remove-bom") return;
      const index = Number(event.target.closest("tr").dataset.index);
      state.bom.splice(index, 1);
      renderBom();
      markDirty();
    });

    $("add-tool").addEventListener("click", () => {
      state.tools.push({ name: "", specs: "", qty: "" });
      renderTools();
      markDirty();
    });
    $("tool-body").addEventListener("input", event => {
      const row = event.target.closest("tr");
      const field = event.target.dataset.field;
      if (!row || !field) return;
      const index = Number(row.dataset.index);
      if (state.tools[index]) state.tools[index][field] = event.target.value;
    });
    $("tool-body").addEventListener("click", event => {
      if (event.target.dataset.action !== "remove-tool") return;
      const index = Number(event.target.closest("tr").dataset.index);
      state.tools.splice(index, 1);
      renderTools();
      markDirty();
    });

    window.addEventListener("beforeunload", event => {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });

    bindDrag();
  }

  /* ---------------------------------------------------------------- 启动 */

  async function boot() {
    bind();
    try {
      await loadProjects();
      await loadProcesses();
      if (!state.projects.length) {
        notice("Library 里还没有项目。点左侧「＋ 新建项目」创建第一个。");
      } else if (state.processes.length) {
        // 直接打开第一道，省一次点击；没有工序时保持空态。
        await openProcess(state.processes[0].order);
      }
    } catch (error) {
      notice(`加载失败：${error.message}`);
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
