/**
 * 逐工序录入页：把「一道工序该有什么」写进 Library 的工序文件夹。
 * 只做录入与保存，出表仍由工作台的「导出 SOP」触发，沿用原有工作流。
 */
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  // 生产环境页面挂在 /admin/ 下（nginx 反代到本服务），而接口是根路径 /api/…。
  // 不加这个前缀，fetch("/api/…") 会打到站点根，被 nginx 转到另一个上游（502）。
  const adminBase = location.pathname.startsWith("/admin") ? "/admin" : "";
  // 管理员可以用 ?library=<账号> 打开某个人的库；员工没有这个参数，服务端固定用自己的库。
  const libraryParam = new URLSearchParams(location.search).get("library") || "";
  const MAX_EDGE = 1600;
  const JPEG_QUALITY = 0.82;
  /** 每道工序默认工具：未勾选时灰显、不保存，勾选后才写入 Tools.jsonl。 */
  const DEFAULT_TOOLS = [
    { name: "镊子", specs: "", qty: "1" },
    { name: "静电环", specs: "", qty: "1" },
    { name: "电批", specs: "", qty: "1" }
  ];

  const state = {
    projects: [],
    projectId: "",
    language: "中文",
    processes: [],
    /** 当前编辑的工序序号（1 开始）；null 表示还没保存过的新工序 */
    current: null,
    photos: [],
    dirty: false,
    /** 当前项目不是自己负责的：只读，保存与增删都被拦住 */
    readOnly: false,
    dragFolder: null,
    /** 当前资料库 {id, name, master, path} 与可选列表（仅管理员） */
    library: null,
    libraries: null,
    /** 当前项目的 BOM：料号（小写）→ {partno,name,qty} */
    bomIndex: new Map(),
    bomInfo: null,
    bom: [],
    /** 项目类型：目前只开放 assemble；其他类型后续再接入 */
    projectType: "assemble",
    defaultTools: DEFAULT_TOOLS.map(tool => ({ ...tool, checked: false }))
  };

  /* ---------------------------------------------------------------- 基础 */

  /** 管理员打开的库：所有读写在 URL 上带 library=<账号>，服务端据此选库。 */
  function withLibrary(path) {
    if (!libraryParam) return path;
    return `${path}${path.includes("?") ? "&" : "?"}library=${encodeURIComponent(libraryParam)}`;
  }

  const escapeHtml = value =>
    String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

  async function api(path, options = {}) {
    const { method = "GET", body } = options;
    const headers = { "X-CKD-UI": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(adminBase + withLibrary(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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

  /** 发布失败的逐条原因，显示在右侧独立栏。 */
  function renderPublishIssues(issues) {
    const box = $("publish-issues");
    const rail = $("publish-rail");
    const layout = document.querySelector(".editor-layout");
    if (layout) layout.classList.toggle("has-issues", Boolean(issues && issues.length));
    if (!box) return;
    if (!issues || !issues.length) {
      box.hidden = true;
      box.replaceChildren();
      if (rail) rail.hidden = true;
      return;
    }
    const title = document.createElement("strong");
    title.textContent = "以下工序还不能保存到 Library：";
    const list = document.createElement("ul");
    for (const item of issues) {
      const li = document.createElement("li");
      li.textContent = `${item.folder}：${item.message}`;
      list.append(li);
    }
    box.replaceChildren(title, list);
    box.hidden = false;
    if (rail) rail.hidden = false;
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

  function selectedProject() {
    return state.projects.find(project => project.projectId === state.projectId);
  }

  function syncProjectInput() {
    const input = $("project-search");
    if (!input) return;
    input.value = selectedProject()?.displayName || "";
  }

  function projectMatches(query) {
    const text = query.trim().toLowerCase();
    return text
      ? state.projects.filter(project => `${project.projectId} ${project.displayName}`.toLowerCase().includes(text))
      : state.projects;
  }

  let projectMenuIndex = -1;

  function closeProjectMenu() {
    const menu = $("project-options"), input = $("project-search");
    if (menu) menu.hidden = true;
    if (input) input.setAttribute("aria-expanded", "false");
    projectMenuIndex = -1;
  }

  function renderProjectMenu(query = "") {
    const menu = $("project-options"), input = $("project-search");
    if (!menu || !input) return;
    const matches = projectMatches(query);
    projectMenuIndex = -1;
    menu.replaceChildren(...matches.map(project => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "project-option";
      item.dataset.projectId = project.projectId;
      item.setAttribute("role", "option");
      item.textContent = `${project.displayName}（${project.processCount} 道工序）`;
      item.addEventListener("mousedown", event => event.preventDefault());
      item.addEventListener("click", () => chooseProject(project.projectId));
      return item;
    }));
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "project-option empty";
      empty.textContent = "没有匹配的项目";
      menu.append(empty);
    }
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function chooseProject(projectId) {
    const select = $("project");
    if (!select) return;
    select.value = projectId;
    if (select.value !== state.projectId) select.dispatchEvent(new Event("change"));
    syncProjectInput();
    closeProjectMenu();
  }

  function renderProjects() {
    const select = $("project");
    if (!select) return;
    if (!state.projects.length) {
      select.innerHTML = `<option value="">（还没有项目）</option>`;
      select.disabled = true;
      syncProjectInput();
      return;
    }
    select.disabled = false;
    select.innerHTML = state.projects
      .map(project => `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.displayName)}（${project.processCount} 道工序）</option>`)
      .join("");
    select.value = state.projectId;
    syncProjectInput();
    renderWriteGuard();
  }

  /** 现在按资料库隔离，员工只能看到自己的库，项目本身不再有「只读」概念。 */
  function renderWriteGuard() {
    state.readOnly = false;
    const banner = $("readonly-banner");
    if (banner) banner.hidden = true;
    for (const id of ["save", "delete-process", "add-process"]) {
      const button = $(id);
      if (button) button.disabled = false;
    }
  }

  /** 管理员：资料库下拉；员工：只显示「资料库：自己的库」。 */
  function renderLibrary() {
    const label = $("library-label");
    if (label) label.textContent = state.library?.name ? `资料库：${state.library.name}` : "";
    const field = $("library-field"), select = $("library");
    if (!field || !select) return;
    if (!state.libraries?.length) { field.hidden = true; return; }
    field.hidden = false;
    select.replaceChildren(...state.libraries.map(library => new Option(
      `${library.name}（${library.projects ?? 0} 个项目）`,
      library.master ? "master" : library.account
    )));
    select.value = state.library?.id || "master";
  }

  async function loadProjects() {
    const value = await api("/api/editor");
    state.projects = value.projects || [];
    state.library = value.library || null;
    state.libraries = value.libraries || null;
    renderLibrary();
    if (!state.projectId && state.projects.length) state.projectId = state.projects[0].projectId;
    if (state.projectId && !state.projects.some(project => project.projectId === state.projectId)) {
      state.projectId = state.projects[0] ? state.projects[0].projectId : "";
    }
    renderProjects();
    renderSopInfo();
    void loadBom();
  }

  /* ---------------------------------------------------------------- BOM */
  function applyProjectType() {
    const assemble = state.projectType === "assemble";
    $("import-bom").hidden = !assemble;
    $("bom-status").hidden = !assemble;
  }

  function normalizePartno(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  function renderBomStatus(info) {
    const el = $("bom-status");
    if (!el) return;
    el.textContent = info ? `已导入：${info.fileName}（${info.rows.length} 行）` : "未导入 BOM";
  }

  async function loadBom() {
    if (!state.projectId) {
      state.bomIndex = new Map();
      state.bomInfo = null;
      renderBomStatus(null);
      return;
    }
    try {
      const value = await api(`/api/editor/bom?project=${encodeURIComponent(state.projectId)}`);
      const info = value.bom || null;
      state.bomInfo = info;
      state.bomIndex = new Map((info?.rows || []).map(row => [normalizePartno(row.partno), row]));
      renderBomStatus(info);
    } catch {
      state.bomIndex = new Map();
      state.bomInfo = null;
      renderBomStatus(null);
    }
  }

  async function importBomFile(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("读取 BOM 文件失败。"));
      reader.readAsDataURL(file);
    });
    const data = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
    const value = await api("/api/editor/bom", { method: "POST", body: { projectId: state.projectId, fileName: file.name, data } });
    state.bomInfo = value.bom;
    state.bomIndex = new Map((value.bom?.rows || []).map(row => [normalizePartno(row.partno), row]));
    renderBomStatus(value.bom);
    notice(`已导入 BOM：${value.bom.fileName}（${value.bom.rows.length} 行）。输入料号会自动带出名称，用量 1 会自动填数量。`);
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
          ${process.draft ? '<span class="process-draft">草稿</span>' : ""}
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
    return `${adminBase}/api/editor/photo?project=${encodeURIComponent(state.projectId)}&language=${encodeURIComponent(state.language)}&order=${state.current}&name=${encodeURIComponent(name)}${libraryParam ? `&library=${encodeURIComponent(libraryParam)}` : ""}`;
  }

  function emptySlot(steps = "") {
    return { kind: "empty", name: "", url: "", steps };
  }

  function ensureSlots() {
    while (state.photos.length < 4) state.photos.push(emptySlot());
  }

  function renderPhotos() {
    ensureSlots();
    const container = $("photos");
    container.innerHTML = state.photos
      .map((photo, index) => `
        <div class="photo-card slot-card" data-index="${index}" draggable="true">
          <div class="photo-head"><span>第 ${index + 1} 位</span><button type="button" data-action="remove-photo"${photo.url ? "" : " disabled"}>清空图片</button></div>
          <div class="slot-body">
            <div class="slot-image" data-action="pick-photo" title="点击选择图片，或直接粘贴截图">
              ${photo.url ? `<img src="${photo.url}" alt="第 ${index + 1} 张操作图">` : '<span class="slot-empty">未配图<br>点击选择 / 粘贴</span>'}
            </div>
            <textarea rows="3" placeholder="第 ${index + 1} 段操作步骤（可只写文字）" data-action="steps">${escapeHtml(photo.steps || "")}</textarea>
          </div>
        </div>`)
      .join("");
    $("photo-count").textContent = `${state.photos.filter(photo => photo.url).length} / ${state.photos.length} 张`;
  }

  function renderBom() {
    const body = $("bom-body");
    if (!state.bom.length) state.bom.push({ partno: "", spec: "", qty: "" });
    body.innerHTML = state.bom
      .map((row, index) => `
        <tr data-index="${index}">
          <td>${index + 1}</td>
          <td><input data-field="partno" value="${escapeHtml(row.partno)}" placeholder="料号" autocomplete="off"></td>
          <td><input data-field="spec" value="${escapeHtml(row.spec)}" placeholder="名称" autocomplete="off"></td>
          <td><input data-field="qty" value="${escapeHtml(row.qty)}" placeholder="必填" inputmode="decimal"></td>
          <td><button type="button" class="row-remove" data-action="remove-bom" aria-label="删除这一行">×</button></td>
        </tr>`)
      .join("");
  }

  function renderTools() {
    const body = $("tool-body");
    const defaults = state.defaultTools.map((tool, index) => `
      <tr class="default-tool${tool.checked ? "" : " muted-tool"}" data-default="${index}">
        <td><input type="checkbox" data-action="default-tool" ${tool.checked ? "checked" : ""} aria-label="启用${escapeHtml(tool.name)}"></td>
        <td><input data-default-field="name" value="${escapeHtml(tool.name)}" ${tool.checked ? "" : "disabled"} autocomplete="off"></td>
        <td><input data-default-field="specs" value="${escapeHtml(tool.specs)}" placeholder="规格" ${tool.checked ? "" : "disabled"} autocomplete="off"></td>
        <td><input data-default-field="qty" value="${escapeHtml(tool.qty)}" inputmode="decimal" ${tool.checked ? "" : "disabled"}></td>
        <td></td>
      </tr>`).join("");
    if (!state.tools.length) state.tools.push({ name: "", specs: "", qty: "" });
    const custom = state.tools
      .map((row, index) => `
        <tr data-index="${index}">
          <td>${index + 1}</td>
          <td><input data-field="name" value="${escapeHtml(row.name)}" placeholder="名称" autocomplete="off"></td>
          <td><input data-field="specs" value="${escapeHtml(row.specs)}" placeholder="规格" autocomplete="off"></td>
          <td><input data-field="qty" value="${escapeHtml(row.qty)}" placeholder="" inputmode="decimal"></td>
          <td><button type="button" class="row-remove" data-action="remove-tool" aria-label="删除这一行">×</button></td>
        </tr>`)
      .join("");
    body.innerHTML = defaults + custom;
  }

  function fillForm(record) {
    $("metadata").value = record.metadata || "";
    $("prev-check").value = record.previousStationCheck || "";
    $("self-check").value = record.selfCheck || "";
    $("hours").value = record.hours === null || record.hours === undefined ? "" : String(record.hours);
    $("manpower").value = record.manpower === null || record.manpower === undefined ? "" : String(record.manpower);
    $("folder-label").textContent = (record.folder || "").toUpperCase();
    $("form-title").textContent = record.metadata || "新工序";

    const photos = record.photos || [];
    const paragraphs = record.paragraphs || [];
    const count = Math.max(4, photos.length, paragraphs.length);
    state.photos = Array.from({ length: count }, (_, index) => {
      const photo = photos[index] || null;
      return {
        kind: photo ? "keep" : "empty",
        name: photo ? photo.name : "",
        url: photo ? photoUrl(photo.name) : "",
        steps: paragraphs[index] || ""
      };
    });
    state.bom = (record.bom || []).map(row => ({ partno: row.partno, spec: row.spec, qty: String(row.qty) }));
    // 已保存的工具里，命中的默认工具回填成勾选状态；其余作为自定义行。
    const defaults = DEFAULT_TOOLS.map(tool => ({ ...tool, checked: false }));
    const customTools = [];
    for (const row of record.tools || []) {
      const target = defaults.find(tool => tool.name === row.name && !tool.checked);
      const qty = row.qty === null || row.qty === undefined ? "" : String(row.qty);
      if (target) { target.checked = true; target.specs = row.specs || ""; target.qty = qty; }
      else customTools.push({ name: row.name, specs: row.specs, qty });
    }
    state.defaultTools = defaults;
    state.tools = customTools.length ? customTools : [{ name: "", specs: "", qty: "" }];
    renderPhotos();
    renderBom();
    renderTools();
    renderPublishIssues([]);
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

  async function openProcess(order, options = {}) {
    if (!state.projectId) return;
    if (!options.force && state.dirty && !confirm("当前工序还有未保存的改动，切换后会丢失，确定切换吗？")) return;
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
    if (state.readOnly) { notice("这个项目不是你负责的，只能查看。"); return; }
    if (!state.projectId) {
      notice("先新建或选择一个项目。");
      return;
    }
    if (state.dirty && !confirm("当前工序有未保存的改动，确定新建吗？")) return;
    const next = state.processes.reduce((max, process) => Math.max(max, process.order), 0) + 1;
    state.current = next;
    state.photos = [];
    state.bom = [{ partno: "", spec: "", qty: "" }];
    state.defaultTools = DEFAULT_TOOLS.map(tool => ({ ...tool, checked: false }));
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
    renderPublishIssues([]);
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

  async function addFiles(files, targetIndex = null) {
    const images = Array.from(files).filter(file => /^image\/(?:png|jpeg)$/u.test(file.type));
    if (!images.length) return;
    let preferred = targetIndex;
    for (const file of images) {
      let index = preferred !== null ? preferred : state.photos.findIndex(photo => !photo.url);
      preferred = null;
      if (index < 0) {
        notice("坑位都已配图，请先清空一个再上传。");
        break;
      }
      try {
        const compressed = await compress(file);
        const previous = state.photos[index];
        state.photos[index] = {
          kind: "new", dataUrl: compressed.dataUrl, url: URL.createObjectURL(compressed.blob),
          steps: previous ? previous.steps || "" : ""
        };
      } catch (error) {
        notice(`处理 ${file.name} 时出错：${error.message}`);
      }
    }
    renderPhotos();
    markDirty();
  }

  /* ---------------------------------------------------------------- 保存 */

  function currentPhotosPayload() {
    return state.photos.map(photo => (photo.kind === "new"
      ? { dataUrl: photo.dataUrl }
      : photo.kind === "keep" ? { name: photo.name } : null));
  }

  async function persist(draft) {
    if (state.readOnly) { notice("这个项目不是你负责的，只能查看。需要修改请联系管理员调整负责人。"); return false; }
    if (state.current === null) return false;
    renderPublishIssues([]);
    const metadata = $("metadata").value.trim();
    if (!draft) {
      if (!metadata) {
        notice("工序名不能为空，它会写进 metadata.txt 并在 Excel 里显示。");
        $("metadata").focus();
        return false;
      }
      const count = state.photos.length;
      if (count === 3) {
        notice("模板只支持 1 / 2 / 4 张图。3 张会没有对应版式，请改成 2 张或补一张到 4 张。");
        return false;
      }
      if (count > 0 && state.photos.some(photo => !String(photo.steps || "").trim())) {
        notice("每张图都要写一段操作步骤；图和步骤数量不一致，打印出来会串位。");
        return false;
      }
    }
    const button = draft ? $("save-draft") : $("save");
    button.disabled = true;
    setState(draft ? "正在保存草稿…" : "正在保存…");
    try {
      const value = await api("/api/editor/process", {
        method: "POST",
        body: {
          projectId: state.projectId,
          language: state.language,
          order: state.current,
          metadata,
          bom: state.bom,
          tools: [
            ...state.defaultTools.filter(tool => tool.checked).map(tool => ({ name: tool.name, specs: tool.specs, qty: tool.qty })),
            ...state.tools
          ],
          paragraphs: state.photos.map(photo => photo.steps || ""),
          photos: currentPhotosPayload(),
          selfCheck: $("self-check").value,
          previousStationCheck: $("prev-check").value,
          hours: $("hours").value,
          manpower: $("manpower").value,
          draft
        }
      });
      const result = value.result || {};
      state.photos = state.photos.map(photo => (photo.kind === "new"
        ? { kind: "keep", name: "", url: photo.url, steps: photo.steps }
        : photo));
      await loadProjects();
      await loadProcesses();
      // 刚从服务端保存成功，重新读取当前工序时不要再弹「未保存」确认。
      await openProcess(state.current, { force: true });
      markClean(draft ? "已保存草稿（还没保存到 Library）" : `已保存：${result.relativePath || ""}`);
      if (result.warnings && result.warnings.length) notice(result.warnings.join("\n"));
      else notice("");
      return true;
    } catch (error) {
      setState(`保存失败：${error.message}`, "bad");
      notice(error.message);
      return false;
    } finally {
      button.disabled = false;
    }
  }

  /** 「保存到 Library」：先把当前工序落成草稿，再统一校验并发布全部草稿。 */
  async function save(event) {
    event.preventDefault();
    if (!(await persist(true))) return;
    setState("正在保存到 Library…");
    try {
      const value = await api("/api/editor/publish", {
        method: "POST",
        body: { projectId: state.projectId, language: state.language }
      });
      await loadProjects();
      await loadProcesses();
      await openProcess(state.current, { force: true });
      const issues = value.issues || [];
      if (issues.length) {
        setState(`还有 ${issues.length} 道工序没保存成功`, "bad");
        renderPublishIssues(issues);
        notice("");
        return;
      }
      renderPublishIssues([]);
      markClean(`已保存到 Library：${(value.published || []).length} 道工序`);
      notice("");
      // 保存成功后再问要不要同步英文，避免不必要地调用模型。
      const choice = await askSync();
      if (choice !== "none") {
        try {
          await api("/api/editor/sync", {
            method: "POST",
            body: { projectId: state.projectId, translate: choice === "translate", summaries: true }
          });
          notice(choice === "translate" ? "后台开始同步翻译和摘要，完成后可直接导出。" : "后台开始更新摘要。");
        } catch (error) {
          notice(`同步请求失败：${error.message}`);
        }
      }
    } catch (error) {
      setState(`保存失败：${error.message}`, "bad");
      notice(error.message);
    }
  }

  async function saveDraft(event) {
    if (event) event.preventDefault();
    if (!(await persist(true))) return;
    notice("已保存当前工序为草稿；点「保存到 Library」后才会参与出表。");
  }

  async function removeProcess() {
    if (state.readOnly) { notice("这个项目不是你负责的，只能查看。"); return; }
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

  /* ------------------------------------------------------------ 新建项目 */

  // Electron 的渲染进程不支持 window.prompt()（调用直接抛错），所以改页面内 dialog。
  let projectDialogResolve = null;

  function setProjectError(message) {
    const box = $("create-project-error");
    box.hidden = !message;
    box.textContent = message || "";
  }

  function askSync() {
    const dialog = $("sync-dialog");
    dialog.returnValue = "none";
    dialog.showModal();
    return new Promise(resolve => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue || "none"), { once: true });
    });
  }

  function openCreateProjectDialog() {
    const dialog = $("create-project-dialog");
    $("create-project-id").value = "";
    setProjectError("");
    dialog.showModal();
    $("create-project-id").focus();
    return new Promise(resolve => { projectDialogResolve = resolve; });
  }

  function bindProjectDialog() {
    const dialog = $("create-project-dialog");
    // 取消、Esc、点关闭都会走到这里，统一 resolve(null)。
    dialog.addEventListener("close", () => {
      const resolve = projectDialogResolve;
      projectDialogResolve = null;
      if (resolve) resolve(null);
    });
    $("create-project-cancel").addEventListener("click", () => dialog.close());
    $("create-project-id").addEventListener("input", () => setProjectError(""));
    $("create-project-form").addEventListener("submit", event => {
      event.preventDefault();
      const projectId = $("create-project-id").value.trim();
      if (!projectId) { setProjectError("项目文件夹名不能为空。"); $("create-project-id").focus(); return; }
      // 其余规则（非法字符、重名、保留名）由服务端 validateProjectId / createProject 统一拦截。
      const resolve = projectDialogResolve;
      projectDialogResolve = null;
      dialog.close();
      if (resolve) resolve({ projectId });
    });
  }

  async function createProject() {
    const input = await openCreateProjectDialog();
    if (!input) return;
    try {
      await api("/api/editor/projects", { method: "POST", body: input });
      state.projectId = input.projectId;
      state.current = null;
      state.processes = [];
      state.dirty = false;
      showForm(false);
      await loadProjects();
      await loadProcesses();
      notice("");
      setState(`已新建项目 ${input.projectId}。`, "ok");
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
    // SOP 名称不再自动填，避免和客户实际叫法不一致；留空由用户自己写。
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
    // 项目类型：目前只有 assemble 支持 BOM 导入，后续接入其他类型时在这里扩展。
    $("project-type").addEventListener("change", event => {
      state.projectType = event.target.value;
      applyProjectType();
    });
    applyProjectType();
    // 桌面端的「返回工作台」：录入页是独立窗口，主窗口还开着，关闭自己并切回主窗口。
    $("back-to-workbench").addEventListener("click", event => {
      if (!window.ckdEditor) return; // 浏览器里保持普通链接
      event.preventDefault();
      if (state.dirty && !confirm("当前工序有未保存的改动，确定返回工作台吗？")) return;
      window.ckdEditor.focusMain();
      window.ckdEditor.close();
    });
    $("library").addEventListener("change", event => {
      const value = event.target.value;
      if (state.dirty && !confirm("当前工序有未保存的改动，确定切换资料库吗？")) {
        event.target.value = state.library?.id || "master";
        return;
      }
      const url = new URL(location.href);
      if (value === "master") url.searchParams.delete("library");
      else url.searchParams.set("library", value);
      location.href = url.toString();
    });
    $("project-search").addEventListener("focus", () => {
      const input = $("project-search");
      input.select();
      renderProjectMenu("");
    });
    $("project-search").addEventListener("click", () => {
      if ($("project-options").hidden) renderProjectMenu("");
    });
    $("project-search").addEventListener("input", () => renderProjectMenu($("project-search").value));
    $("project-search").addEventListener("blur", () => {
      setTimeout(() => { closeProjectMenu(); syncProjectInput(); }, 120);
    });
    $("project-search").addEventListener("keydown", event => {
      const menu = $("project-options");
      const options = () => [...menu.querySelectorAll(".project-option:not(.empty)")];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (menu.hidden) renderProjectMenu($("project-search").value);
        const items = options();
        if (!items.length) return;
        projectMenuIndex = (projectMenuIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((item, index) => item.classList.toggle("active", index === projectMenuIndex));
        items[projectMenuIndex].scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const items = options();
        const target = projectMenuIndex >= 0 ? items[projectMenuIndex] : items[0];
        if (target) target.click();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeProjectMenu();
        syncProjectInput();
        $("project-search").blur();
      }
    });
    $("project").addEventListener("change", async event => {
      if (state.dirty && !confirm("当前工序有未保存的改动，确定切换项目吗？")) {
        event.target.value = state.projectId;
        return;
      }
      // 先把上一个项目的基本信息落盘，避免防抖还没触发就切走了。
      storeSopInfo();
      state.projectId = event.target.value;
      syncProjectInput();
      closeProjectMenu();
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
    bindProjectDialog();
    $("add-process").addEventListener("click", openBlankProcess);
    $("delete-process").addEventListener("click", removeProcess);
    $("save-draft").addEventListener("click", saveDraft);
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

    let pickIndex = null, dragIndex = null;
    $("photo-input").addEventListener("change", async event => {
      const index = pickIndex;
      pickIndex = null;
      await addFiles(event.target.files, index);
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
      const card = event.target.closest(".slot-card");
      const index = Number(card.dataset.index);
      if (state.photos[index]) state.photos[index].steps = event.target.value;
    });
    $("photos").addEventListener("click", event => {
      const card = event.target.closest(".slot-card");
      if (!card) return;
      const index = Number(card.dataset.index);
      if (event.target.dataset.action === "remove-photo") {
        // 只清空图片，保留这个坑位的步骤文字，避免用户重新录入。
        const photo = state.photos[index];
        if (photo && photo.kind === "new" && photo.url) URL.revokeObjectURL(photo.url);
        state.photos[index] = { kind: "empty", name: "", url: "", steps: photo?.steps || "" };
        renderPhotos();
        markDirty();
        return;
      }
      if (event.target.closest('[data-action="pick-photo"]')) {
        pickIndex = index;
        $("photo-input").click();
      }
    });
    $("photos").addEventListener("dragstart", event => {
      const card = event.target.closest(".slot-card");
      if (!card) return;
      dragIndex = Number(card.dataset.index);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    $("photos").addEventListener("dragover", event => {
      if (event.target.closest(".slot-card")) event.preventDefault();
    });
    $("photos").addEventListener("drop", event => {
      const card = event.target.closest(".slot-card");
      if (!card || dragIndex === null) return;
      event.preventDefault();
      const to = Number(card.dataset.index);
      const from = dragIndex;
      dragIndex = null;
      if (to === from) return;
      const copy = [...state.photos];
      [copy[from], copy[to]] = [copy[to], copy[from]];
      state.photos = copy;
      renderPhotos();
      markDirty();
    });
    // 直接粘贴截图到录入页：填第一个空坑位。
    document.addEventListener("paste", event => {
      if ($("process-form").hidden) return;
      const files = Array.from(event.clipboardData?.files || []).filter(file => /^image\//u.test(file.type));
      if (!files.length) return;
      event.preventDefault();
      void addFiles(files);
    });

    $("suggest-name").addEventListener("click", async () => {
      if (state.readOnly) { notice("这个项目不是你负责的，只能查看。"); return; }
      const paragraphs = state.photos.map(photo => (photo.steps || "").trim()).filter(Boolean);
      if (!paragraphs.length) { notice("先填写操作步骤，再生成工序名。"); return; }
      const button = $("suggest-name");
      button.disabled = true;
      try {
        const value = await api("/api/editor/name-suggestion", {
          method: "POST",
          body: { projectId: state.projectId, paragraphs }
        });
        if (value.name) {
          $("metadata").value = value.name;
          markDirty();
          notice(`已根据操作步骤生成：${value.name}（可手动修改）`);
        }
      } catch (error) {
        notice(`生成工序名失败：${error.message}`);
      } finally {
        button.disabled = false;
      }
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
    // 输入料号后查 BOM：名称自动带出；用量 1 时数量自动填 1，其余留空。
    $("bom-body").addEventListener("change", event => {
      const input = event.target;
      if (input.dataset.field !== "partno") return;
      const row = input.closest("tr");
      if (!row) return;
      const index = Number(row.dataset.index);
      const record = state.bom[index];
      if (record) record.partno = input.value;
      const hit = state.bomIndex.get(normalizePartno(input.value));
      if (!hit) return;
      let changed = false;
      const nameInput = row.querySelector('[data-field="spec"]');
      if (nameInput && !nameInput.value.trim() && hit.name) {
        nameInput.value = hit.name;
        if (record) record.spec = hit.name;
        changed = true;
      }
      const qtyInput = row.querySelector('[data-field="qty"]');
      if (qtyInput && !qtyInput.value.trim() && hit.qty === 1) {
        qtyInput.value = "1";
        if (record) record.qty = "1";
        changed = true;
      }
      if (changed) markDirty();
    });
    $("import-bom").addEventListener("click", () => {
      if (state.projectType !== "assemble") { notice("只有装配项目支持导入 BOM。"); return; }
      if (!state.projectId) { notice("先选择项目。"); return; }
      $("bom-input").click();
    });
    $("bom-input").addEventListener("change", async event => {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      try {
        await importBomFile(file);
      } catch (error) {
        notice(`导入 BOM 失败：${error.message}`);
      }
    });

    $("add-tool").addEventListener("click", () => {
      state.tools.push({ name: "", specs: "", qty: "" });
      renderTools();
      markDirty();
    });
    $("tool-body").addEventListener("input", event => {
      // 默认工具行（镊子/静电环/电批）：改了才参与保存。
      const defaultRow = event.target.closest("[data-default]");
      if (defaultRow) {
        const tool = state.defaultTools[Number(defaultRow.dataset.default)];
        const defaultField = event.target.dataset.defaultField;
        if (tool && defaultField) { tool[defaultField] = event.target.value; markDirty(); }
        return;
      }
      const row = event.target.closest("tr");
      const field = event.target.dataset.field;
      if (!row || !field) return;
      const index = Number(row.dataset.index);
      if (state.tools[index]) state.tools[index][field] = event.target.value;
    });
    $("tool-body").addEventListener("change", event => {
      if (event.target.dataset.action !== "default-tool") return;
      const row = event.target.closest("[data-default]");
      const tool = row ? state.defaultTools[Number(row.dataset.default)] : undefined;
      if (!tool) return;
      tool.checked = event.target.checked;
      if (tool.checked && !tool.qty) tool.qty = "1";
      renderTools();
      markDirty();
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
