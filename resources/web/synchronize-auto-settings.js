(() => {
  const get = id => document.getElementById(id);
  const dialog = get("auto-settings-dialog");
  const enabled = get("auto-schedule-enabled"), time = get("auto-schedule-time");
  let timer, base = "", saving = false, loading = false, requestId = 0;
  let refreshing = false, refreshedAt = 0;
  const current = () => ({ enabled: enabled.checked, frequency: "daily", time: time.value });
  const dirty = () => timer?.editable && JSON.stringify(current()) !== base;
  const beijing = value => value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }) + " Beijing time" : "No next trigger";
  const message = (text, state = "") => {
    get("auto-schedule-result").textContent = text;
    get("auto-schedule-result").dataset.state = state;
  };
  function summary(state) {
    get("sync-mode-label").textContent = state.available
      ? state.enabled ? state.active ? `Auto-sync · ${state.schedule?.time || ""} Beijing` : "Auto-sync · timer inactive" : "Manual sync"
      : "Auto-sync unavailable";
  }
  function controls() {
    for (const field of [enabled, time]) field.disabled = !timer?.editable || saving || loading;
    // Pause remains available if the local trigger/configuration is unavailable.
    get("auto-schedule-save").disabled = !dirty() || saving || loading || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time.value) || (enabled.checked && !timer?.trigger?.available);
    get("auto-schedule-save").textContent = saving ? "Applying…" : "Save schedule";
    get("auto-schedule-reload").disabled = saving || loading;
    get("auto-schedule-unsaved").textContent = dirty() ? "Unsaved schedule changes" : "";
    get("auto-settings-close").disabled = saving;
    get("auto-settings-x").disabled = saving;
  }
  function show(state) {
    timer = state;
    summary(state);
    get("auto-timer-current").textContent = state.available ? `Current: ${state.calendar} · ${beijing(state.nextRun)}` : "";
    const run = state.lastRun;
    get("auto-last-run").textContent = run
      ? `Last run: ${beijing(run.started)} · ${run.status.replaceAll("_", " ")} · ${run.selected} selected · ${run.held} held for manual handling` +
        (Object.keys(run.counts).length ? ` · ${Object.entries(run.counts).map(([key, value]) => `${value} ${key.replaceAll("_", " ")}`).join(" · ")}` : "") + (run.error ? ` · ${run.error}` : "")
      : "No scheduled run yet.";
    if (state.schedule) { enabled.checked = state.schedule.enabled; time.value = state.schedule.time; }
    base = JSON.stringify(current()); controls();
  }
  async function load() {
    const id = ++requestId;
    timer = undefined; loading = true; message("Loading…"); controls();
    try {
      const state = await api("settings/schedule");
      if (id !== requestId) return;
      show(state);
      const note = !state.editable ? state.note || "Install or update the VPS Auto-sync timer and settings helper first."
        : !state.trigger?.available ? state.trigger?.note || "The private Auto-sync trigger is unavailable. Check the Web service."
        : "Changes apply only after Save schedule succeeds.";
      message(note, state.editable && state.trigger?.available ? "" : "error");
    } catch (error) { if (id === requestId) message(error.message, "error"); }
    finally { if (id === requestId) { loading = false; controls(); } }
  }
  function close() {
    if (saving || (dirty() && !window.confirm("Discard unsaved Auto-sync schedule changes?"))) return;
    requestId++; loading = false; dialog.close(); get("auto-settings-open").focus();
  }
  get("auto-settings-open").onclick = async () => { if (dialog.open) return; dialog.showModal(); await load(); };
  get("auto-settings-close").onclick = close;
  get("auto-settings-x").onclick = close;
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  window.addEventListener("beforeunload", event => { if (dialog.open && (dirty() || saving)) { event.preventDefault(); event.returnValue = ""; } });
  for (const field of [enabled, time]) field.oninput = controls;
  get("auto-schedule-reload").onclick = () => { if (!dirty() || window.confirm("Discard schedule edits and reload systemd?")) return load(); };
  get("auto-schedule-save").onclick = async () => {
    if (get("auto-schedule-save").disabled) return;
    saving = true; controls();
    try {
      show(await api("settings/schedule", "PUT", { schedule: current(), revision: timer.revision }));
      message("Saved and applied to systemd.", "success");
    } catch (error) { message(`${error.message} Reload schedule to check the current state.`, "error"); }
    finally { saving = false; controls(); }
  };
  globalThis.refreshAutoSyncSchedule = async () => {
    if (refreshing || Date.now() - refreshedAt < 30000) return;
    refreshing = true;
    try { summary(await api("settings/schedule")); }
    catch { get("sync-mode-label").textContent = "Auto-sync status unavailable"; }
    finally { refreshing = false; refreshedAt = Date.now(); }
  };
})();
