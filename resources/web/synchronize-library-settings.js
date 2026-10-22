(() => {
  const get = (id) => document.getElementById(id);
  const dialog = get("library-settings-dialog");
  const fields = ["enabled", "frequency", "day", "time"].map((name) =>
    get(`library-schedule-${name}`),
  );
  let timer,
    base = "",
    saving = false,
    loading = false,
    requestId = 0;
  let refreshing = false,
    refreshedAt = 0;
  const current = () => ({
    enabled: fields[0].checked,
    frequency: fields[1].value,
    time: fields[3].value,
    ...(fields[1].value === "weekly" ? { weekday: fields[2].value } : {}),
  });
  const dirty = () => timer?.editable && JSON.stringify(current()) !== base;
  const message = (text, state = "") => {
    get("library-schedule-result").textContent = text;
    get("library-schedule-result").dataset.state = state;
  };
  const beijing = (value) =>
    value
      ? new Date(value).toLocaleString("en-GB", {
          timeZone: "Asia/Shanghai",
          dateStyle: "medium",
          timeStyle: "short",
        }) + " Beijing time"
      : "No next trigger";
  function summary(state) {
    get("library-import-schedule").textContent = state.available
      ? `systemd · ${state.enabled ? "Enabled" : "Disabled"} · ${state.active ? "Active" : "Inactive"} · ${state.calendar || "No calendar"} · ${beijing(state.nextRun)}`
      : state.note || "Timer settings unavailable.";
  }
  function controls() {
    get("library-schedule-day-label").hidden = fields[1].value !== "weekly";
    for (const field of fields)
      field.disabled = !timer?.editable || saving || loading;
    get("library-schedule-save").disabled =
      !dirty() ||
      saving ||
      loading ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fields[3].value);
    get("library-schedule-save").textContent = saving
      ? "Applying…"
      : "Save schedule";
    get("library-schedule-reload").disabled = saving || loading;
    get("library-schedule-unsaved").textContent = dirty()
      ? "Unsaved schedule changes"
      : "";
    get("library-settings-close").disabled = saving;
    get("library-settings-x").disabled = saving;
  }
  function show(state) {
    timer = state;
    summary(state);
    get("library-timer-current").textContent = state.available
      ? `Current: ${state.calendar} · ${beijing(state.nextRun)}`
      : "";
    if (state.schedule) {
      fields[0].checked = state.schedule.enabled;
      fields[1].value = state.schedule.frequency;
      fields[2].value = state.schedule.weekday || "Mon";
      fields[3].value = state.schedule.time;
    }
    base = JSON.stringify(current());
    controls();
  }
  async function load() {
    const id = ++requestId;
    timer = undefined;
    loading = true;
    message("Loading…");
    controls();
    try {
      const state = await libraryImportApi("settings/schedule");
      if (id !== requestId) return;
      show(state);
      message(
        state.editable
          ? "Changes apply only after Save schedule succeeds."
          : state.note ||
              "Install or update the VPS timer settings helper first.",
        state.editable ? "" : "error",
      );
    } catch (error) {
      if (id === requestId) message(error.message, "error");
    } finally {
      if (id === requestId) {
        loading = false;
        controls();
      }
    }
  }
  function close() {
    if (
      saving ||
      (dirty() && !window.confirm("Discard unsaved Library schedule changes?"))
    )
      return;
    requestId++;
    loading = false;
    dialog.close();
    get("library-settings-open").focus();
  }
  get("library-settings-open").onclick = async () => {
    if (dialog.open) return;
    dialog.showModal();
    await load();
  };
  get("library-settings-close").onclick = close;
  get("library-settings-x").onclick = close;
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  window.addEventListener("beforeunload", (event) => {
    if (dialog.open && (dirty() || saving)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  for (const field of fields) field.oninput = controls;
  get("library-schedule-reload").onclick = () => {
    if (
      !dirty() ||
      window.confirm("Discard schedule edits and reload systemd?")
    )
      return load();
  };
  get("library-schedule-save").onclick = async () => {
    if (get("library-schedule-save").disabled) return;
    saving = true;
    controls();
    try {
      const state = await libraryImportApi("settings/schedule", "PUT", {
        schedule: current(),
        revision: timer.revision,
      });
      show(state);
      message("Saved and applied to systemd.", "success");
    } catch (error) {
      message(
        `${error.message} Reload schedule to check the current state.`,
        "error",
      );
    } finally {
      saving = false;
      controls();
    }
  };
  globalThis.refreshLibrarySchedule = async () => {
    if (refreshing || Date.now() - refreshedAt < 30000) return;
    refreshing = true;
    try {
      summary(await libraryImportApi("settings/schedule"));
    } catch (error) {
      get("library-import-schedule").textContent = error.message;
    } finally {
      refreshing = false;
      refreshedAt = Date.now();
    }
  };
})();
