(() => {
  const get = (id) => document.getElementById(id);
  const dialog = get("sftp-settings-dialog"),
    editor = get("sftp-paths-text");
  const fields = ["enabled", "frequency", "day", "time"].map((n) =>
    get(`sftp-schedule-${n}`),
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
    get("sftp-schedule-summary").textContent = state.available
      ? `systemd · ${state.enabled ? "Enabled" : "Disabled"}${state.active ? " · Active" : " · Inactive"} · ${state.calendar || "No calendar"} · ${beijing(state.nextRun)}`
      : state.note || "Timer settings unavailable.";
  }
  function controls() {
    get("sftp-paths-check").disabled = !paths || checking || savingPaths;
    get("sftp-paths-check").textContent = checking ? "Checking…" : "Check";
    get("sftp-paths-save").disabled =
      !pathsDirty() || checkedText !== editor.value || checking || savingPaths;
    get("sftp-paths-save").textContent = savingPaths ? "Saving…" : "Save paths";
    get("sftp-paths-reload").disabled = savingPaths || checking;
    editor.disabled = !paths || savingPaths;
    get("sftp-paths-unsaved").textContent = pathsDirty()
      ? "Unsaved changes · Check required after each edit"
      : "";
    get("sftp-schedule-day-label").hidden = fields[1].value !== "weekly";
    for (const field of fields)
      field.disabled = !timer?.editable || savingSchedule;
    get("sftp-schedule-save").disabled =
      !scheduleDirty() ||
      savingSchedule ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fields[3].value);
    get("sftp-schedule-save").textContent = savingSchedule
      ? "Applying…"
      : "Save schedule";
    get("sftp-schedule-reload").disabled = savingSchedule;
    get("sftp-schedule-unsaved").textContent = scheduleDirty()
      ? "Unsaved schedule changes"
      : "";
    get("sftp-settings-close").disabled = savingPaths || savingSchedule;
    get("sftp-settings-x").disabled = savingPaths || savingSchedule;
  }
  function showCheck(result) {
    message(
      "sftp-paths-result",
      result.valid
        ? `Check passed · ${result.count} paths`
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
      get("sftp-paths-result").append(ul);
    }
  }
  async function loadPaths() {
    const request = ++pathsRequest;
    paths = undefined;
    checkedText = undefined;
    controls();
    try {
      const saved = await importApi("settings/paths");
      if (request !== pathsRequest) return;
      paths = saved;
      editor.value = paths.text;
      get("sftp-editor-file").textContent = paths.file;
      message(
        "sftp-paths-result",
        "Edit the list, then click Check before saving.",
      );
      if (!paths.check.valid) showCheck(paths.check);
    } catch (error) {
      if (request === pathsRequest)
        message("sftp-paths-result", error.message, "error");
    }
    controls();
  }
  async function loadSchedule() {
    const request = ++scheduleRequest;
    timer = undefined;
    controls();
    try {
      const state = await importApi("settings/schedule");
      if (request !== scheduleRequest) return;
      timer = state;
      showTimerSummary(timer);
      get("sftp-timer-current").textContent = timer.available
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
        "sftp-schedule-result",
        timer.editable
          ? "Changes apply only after Save schedule succeeds."
          : timer.note || "Install the VPS timer settings helper first.",
        timer.editable ? "" : "error",
      );
    } catch (error) {
      if (request === scheduleRequest)
        message("sftp-schedule-result", error.message, "error");
    }
    controls();
  }
  function closeDialog() {
    if (savingPaths || savingSchedule) return;
    if (
      (pathsDirty() || scheduleDirty()) &&
      !window.confirm("Discard unsaved SFTP settings changes?")
    )
      return;
    pathsRequest++;
    scheduleRequest++;
    checkRequest++;
    checking = false;
    dialog.close();
    get("sftp-settings-open").focus();
  }
  get("sftp-settings-open").onclick = async () => {
    if (dialog.open) return;
    message("sftp-paths-result", "Loading…");
    message("sftp-schedule-result", "Loading…");
    dialog.showModal();
    await Promise.all([loadPaths(), loadSchedule()]);
  };
  get("sftp-settings-close").onclick = closeDialog;
  get("sftp-settings-x").onclick = closeDialog;
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
    message("sftp-paths-result", "Content changed. Run Check before saving.");
    controls();
  };
  for (const field of fields) field.oninput = controls;
  get("sftp-paths-reload").onclick = () => {
    if (
      !pathsDirty() ||
      window.confirm("Discard path edits and reload the saved list?")
    )
      void loadPaths();
  };
  get("sftp-schedule-reload").onclick = () => {
    if (
      !scheduleDirty() ||
      window.confirm("Discard schedule edits and reload systemd?")
    )
      void loadSchedule();
  };
  get("sftp-paths-check").onclick = async () => {
    if (checking || savingPaths || !paths) return;
    const request = ++checkRequest;
    const text = editor.value;
    checking = true;
    checkedText = undefined;
    controls();
    try {
      const result = await importApi("settings/paths/check", "POST", { text });
      if (request === checkRequest && editor.value === text) {
        checkedText = result.valid ? text : undefined;
        showCheck(result);
      }
    } catch (error) {
      if (request === checkRequest)
        message("sftp-paths-result", error.message, "error");
    } finally {
      if (request === checkRequest) {
        checking = false;
        controls();
      }
    }
  };
  get("sftp-paths-save").onclick = async () => {
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
      paths = await importApi("settings/paths", "PUT", {
        text: editor.value,
        revision: paths.revision,
      });
      checkedText = paths.text;
      editor.value = paths.text;
      message(
        "sftp-paths-result",
        `Saved · ${paths.check.count} paths. The next import uses this list.`,
        "success",
      );
      void refreshImports().catch(() => {});
    } catch (error) {
      message("sftp-paths-result", error.message, "error");
    } finally {
      savingPaths = false;
      controls();
    }
  };
  get("sftp-schedule-save").onclick = async () => {
    if (!scheduleDirty() || savingSchedule) return;
    savingSchedule = true;
    controls();
    try {
      timer = await importApi("settings/schedule", "PUT", {
        schedule: currentSchedule(),
        revision: timer.revision,
      });
      timerBase = JSON.stringify(currentSchedule());
      showTimerSummary(timer);
      get("sftp-timer-current").textContent =
        `Current: ${timer.calendar} · ${beijing(timer.nextRun)}`;
      message(
        "sftp-schedule-result",
        "Saved and applied to systemd.",
        "success",
      );
    } catch (error) {
      message(
        "sftp-schedule-result",
        `${error.message} Reload schedule to check the current state.`,
        "error",
      );
    } finally {
      savingSchedule = false;
      controls();
    }
  };
  globalThis.refreshSftpSchedule = async () => {
    if (refreshing || (scheduleRead && Date.now() - lastScheduleRead < 30000))
      return;
    refreshing = true;
    try {
      showTimerSummary(await importApi("settings/schedule"));
    } catch (error) {
      get("sftp-schedule-summary").textContent = error.message;
    } finally {
      refreshing = false;
      scheduleRead = true;
      lastScheduleRead = Date.now();
    }
  };
})();
