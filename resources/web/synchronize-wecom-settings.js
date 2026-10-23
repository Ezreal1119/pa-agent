(() => {
  const get = (id) => document.getElementById(id);
  const dialog = get("wecom-settings-dialog"),
    editor = get("wecom-paths-text");
  const fields = ["enabled", "frequency", "day", "time"].map((n) =>
    get(`wecom-schedule-${n}`),
  );
  let paths,
    checkedText,
    checking = false,
    savingPaths = false,
    savingSchedule = false;
  let timer,
    timerBase = "",
    scheduleRead = false,
    lastScheduleRead = 0,
    refreshing = false;
  let pathsRequest = 0,
    scheduleRequest = 0,
    checkRequest = 0;
  const pathsDirty = () => paths && editor.value !== paths.text;
  const currentSchedule = () => ({
    enabled: fields[0].checked,
    frequency: fields[1].value,
    time: fields[3].value,
    ...(fields[1].value === "weekly" ? { weekday: fields[2].value } : {}),
  });
  const scheduleDirty = () =>
    timer?.editable && JSON.stringify(currentSchedule()) !== timerBase;
  const message = (id, text, state = "") => {
    const node = get(id);
    node.replaceChildren();
    node.textContent = text;
    node.dataset.state = state;
  };
  const beijing = (value) =>
    value
      ? new Date(value).toLocaleString("en-GB", {
          timeZone: "Asia/Shanghai",
          dateStyle: "medium",
          timeStyle: "short",
        }) + " Beijing time"
      : "No next trigger";
  function showTimerSummary(state) {
    get("wecom-schedule-summary").textContent = state.available
      ? `systemd · ${state.enabled ? "Enabled" : "Disabled"}${state.active ? " · Active" : " · Inactive"} · ${state.calendar || "No calendar"} · ${beijing(state.nextRun)}`
      : state.note || "Timer settings unavailable.";
  }
  function controls() {
    get("wecom-paths-check").disabled = !paths || checking || savingPaths;
    get("wecom-paths-check").textContent = checking ? "Checking…" : "Check";
    get("wecom-paths-save").disabled =
      !pathsDirty() || checkedText !== editor.value || checking || savingPaths;
    get("wecom-paths-save").textContent = savingPaths
      ? "Saving…"
      : "Save documents";
    get("wecom-paths-reload").disabled = savingPaths || checking;
    editor.disabled = !paths || savingPaths;
    get("wecom-paths-unsaved").textContent = pathsDirty()
      ? checkedText === editor.value
        ? "Unsaved changes · Ready to save"
        : "Unsaved changes · Check required after each edit"
      : "";
    get("wecom-schedule-day-label").hidden = fields[1].value !== "weekly";
    for (const field of fields)
      field.disabled = !timer?.editable || savingSchedule;
    get("wecom-schedule-save").disabled =
      !scheduleDirty() ||
      savingSchedule ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fields[3].value);
    get("wecom-schedule-save").textContent = savingSchedule
      ? "Applying…"
      : "Save schedule";
    get("wecom-schedule-reload").disabled = savingSchedule;
    get("wecom-schedule-unsaved").textContent = scheduleDirty()
      ? "Unsaved schedule changes"
      : "";
    get("wecom-settings-close").disabled = savingPaths || savingSchedule;
    get("wecom-settings-x").disabled = savingPaths || savingSchedule;
  }
  function showCheck(result) {
    message(
      "wecom-paths-result",
      result.valid
        ? `Check passed · ${result.count} ${result.count === 1 ? "document" : "documents"}`
        : `Check failed · ${result.errors.length} ${result.errors.length === 1 ? "problem" : "problems"}`,
      result.valid ? "success" : "error",
    );
    if (!result.valid) {
      const ul = document.createElement("ul");
      for (const error of result.errors) {
        const li = document.createElement("li");
        li.textContent = `${error.line ? `Line ${error.line}: ` : ""}${error.message}`;
        ul.append(li);
      }
      get("wecom-paths-result").append(ul);
    }
  }
  async function loadPaths() {
    const request = ++pathsRequest;
    paths = undefined;
    checkedText = undefined;
    controls();
    try {
      const saved = await wecomImportApi("settings/docs");
      if (request !== pathsRequest) return;
      paths = saved;
      editor.value = paths.text;
      get("wecom-editor-file").textContent = paths.file;
      message(
        "wecom-paths-result",
        "Edit the list, then click Check before saving.",
      );
      if (!paths.check.valid) showCheck(paths.check);
    } catch (error) {
      if (request === pathsRequest)
        message("wecom-paths-result", error.message, "error");
    }
    controls();
  }
  async function loadSchedule() {
    const request = ++scheduleRequest;
    timer = undefined;
    controls();
    try {
      const state = await wecomImportApi("settings/schedule");
      if (request !== scheduleRequest) return;
      timer = state;
      showTimerSummary(timer);
      get("wecom-timer-current").textContent = timer.available
        ? `Current: ${timer.calendar} · ${beijing(timer.nextRun)}`
        : "";
      if (timer.schedule) {
        fields[0].checked = timer.schedule.enabled;
        fields[1].value = timer.schedule.frequency;
        fields[2].value = timer.schedule.weekday || "Mon";
        fields[3].value = timer.schedule.time;
      }
      timerBase = JSON.stringify(currentSchedule());
      message(
        "wecom-schedule-result",
        timer.editable
          ? "Changes apply only after Save schedule succeeds."
          : timer.note || "Install the VPS timer settings helper first.",
        timer.editable ? "" : "error",
      );
    } catch (error) {
      if (request === scheduleRequest)
        message("wecom-schedule-result", error.message, "error");
    }
    controls();
  }
  function closeDialog() {
    if (savingPaths || savingSchedule) return;
    if (
      (pathsDirty() || scheduleDirty()) &&
      !window.confirm("Discard unsaved WeCom settings changes?")
    )
      return;
    pathsRequest++;
    scheduleRequest++;
    checkRequest++;
    checking = false;
    dialog.close();
    get("wecom-settings-open").focus();
  }
  get("wecom-settings-open").onclick = async () => {
    if (dialog.open) return;
    message("wecom-paths-result", "Loading…");
    message("wecom-schedule-result", "Loading…");
    dialog.showModal();
    await Promise.all([loadPaths(), loadSchedule()]);
  };
  get("wecom-settings-close").onclick = closeDialog;
  get("wecom-settings-x").onclick = closeDialog;
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  window.addEventListener("beforeunload", (event) => {
    if (
      dialog.open &&
      (pathsDirty() || scheduleDirty() || savingPaths || savingSchedule)
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  editor.oninput = () => {
    checkedText = undefined;
    message("wecom-paths-result", "Content changed. Run Check before saving.");
    controls();
  };
  for (const field of fields) field.oninput = controls;
  get("wecom-paths-reload").onclick = () => {
    if (
      !pathsDirty() ||
      window.confirm("Discard document edits and reload the saved list?")
    )
      void loadPaths();
  };
  get("wecom-schedule-reload").onclick = () => {
    if (
      !scheduleDirty() ||
      window.confirm("Discard schedule edits and reload systemd?")
    )
      void loadSchedule();
  };
  get("wecom-paths-check").onclick = async () => {
    if (checking || savingPaths || !paths) return;
    const request = ++checkRequest;
    const text = editor.value;
    checking = true;
    checkedText = undefined;
    controls();
    try {
      const result = await wecomImportApi("settings/docs/check", "POST", {
        text,
      });
      if (request === checkRequest && editor.value === text) {
        checkedText = result.valid ? text : undefined;
        showCheck(result);
      }
    } catch (error) {
      if (request === checkRequest)
        message("wecom-paths-result", error.message, "error");
    } finally {
      if (request === checkRequest) {
        checking = false;
        controls();
      }
    }
  };
  get("wecom-paths-save").onclick = async () => {
    if (
      !pathsDirty() ||
      checkedText !== editor.value ||
      checking ||
      savingPaths
    )
      return;
    savingPaths = true;
    controls();
    try {
      paths = await wecomImportApi("settings/docs", "PUT", {
        text: editor.value,
        revision: paths.revision,
      });
      checkedText = paths.text;
      editor.value = paths.text;
      message(
        "wecom-paths-result",
        `Saved · ${paths.check.count} ${paths.check.count === 1 ? "document" : "documents"}. The next import uses this list.`,
        "success",
      );
      void refreshWecomImports().catch(() => {});
    } catch (error) {
      message("wecom-paths-result", error.message, "error");
    } finally {
      savingPaths = false;
      controls();
    }
  };
  get("wecom-schedule-save").onclick = async () => {
    if (!scheduleDirty() || savingSchedule) return;
    savingSchedule = true;
    controls();
    try {
      timer = await wecomImportApi("settings/schedule", "PUT", {
        schedule: currentSchedule(),
        revision: timer.revision,
      });
      timerBase = JSON.stringify(currentSchedule());
      showTimerSummary(timer);
      get("wecom-timer-current").textContent =
        `Current: ${timer.calendar} · ${beijing(timer.nextRun)}`;
      message(
        "wecom-schedule-result",
        "Saved and applied to systemd.",
        "success",
      );
    } catch (error) {
      message(
        "wecom-schedule-result",
        `${error.message} Reload schedule to check the current state.`,
        "error",
      );
    } finally {
      savingSchedule = false;
      controls();
    }
  };
  globalThis.refreshWecomSchedule = async () => {
    if (refreshing || (scheduleRead && Date.now() - lastScheduleRead < 30000))
      return;
    refreshing = true;
    try {
      showTimerSummary(await wecomImportApi("settings/schedule"));
    } catch (error) {
      get("wecom-schedule-summary").textContent = error.message;
    } finally {
      refreshing = false;
      scheduleRead = true;
      lastScheduleRead = Date.now();
    }
  };
})();
