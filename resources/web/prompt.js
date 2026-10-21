"use strict";
(() => {
  const $ = (id) => document.getElementById(`prompt-${id}`);
  const modal = $("dialog");
  let instructions = [],
    saved = [],
    revision = "",
    mode = "standard";
  let loading = false,
    saving = false,
    timer,
    controller,
    requestNumber = 0,
    expanded = false,
    pendingClose;
  const dirty = () => JSON.stringify(instructions) !== JSON.stringify(saved);
  const node = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  function error(message = "") {
    $("error").textContent = message;
    $("error").hidden = !message;
  }
  function status() {
    $("status").textContent = saving
      ? "Saving…"
      : loading
        ? "Loading…"
        : dirty()
          ? "Unsaved changes"
          : "Saved · Applies to the next run in existing conversations.";
    $("save").disabled =
      loading ||
      saving ||
      !dirty() ||
      instructions.some((s) => !s.trim()) ||
      instructions.length > 100;
    $("add").disabled = loading || saving || instructions.length >= 100;
    $("mode").disabled = loading || saving;
    $("reload").disabled = loading || saving;
    $("count").textContent = `${instructions.length} / 100 instructions`;
  }
  async function request(url, options = {}) {
    const auth = await fetch("/api/auth/status").then((r) => r.json());
    if (!auth.authenticated) {
      location.href = "/login";
      throw Error("Please sign in.");
    }
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Local-Token": auth.token,
      },
    });
    if (response.status === 401) {
      location.href = "/login";
      throw Error("Please sign in.");
    }
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "Prompt request failed.");
    return result;
  }
  function section(title, text, example = false, id) {
    const details = node("details");
    details.open = expanded;
    if (id) details.dataset.section = id;
    details.append(node("summary", title + (example ? " · Example" : "")));
    const pre = node("pre", text || "(Not included)");
    details.append(pre);
    return details;
  }
  function renderPreview(preview) {
    const holder = $("preview");
    holder.replaceChildren();
    holder.append(
      section(
        "Model parameters",
        JSON.stringify(
          { ...preview.model, reasoning: preview.reasoning },
          null,
          2,
        ),
      ),
    );
    const system = node("details");
    system.open = expanded;
    system.append(node("summary", "System message"));
    for (const part of preview.systemSections)
      system.append(section(part.title, part.content, part.example, part.id));
    const messages = node("details");
    messages.open = expanded;
    messages.append(node("summary", "Messages · Example"));
    for (const [i, message] of preview.messages.entries())
      messages.append(
        section(`${i + 1}. ${message.role}`, message.content, true),
      );
    const tools = node("details");
    tools.open = expanded;
    tools.append(node("summary", `Tools · ${preview.tools.length} enabled`));
    for (const tool of preview.tools)
      tools.append(section(tool.name, JSON.stringify(tool, null, 2)));
    holder.append(system, messages, tools);
    $("preview-status").textContent =
      "Preview uses the actual configuration and saved knowledge; session-specific content is illustrative.";
  }
  async function preview() {
    clearTimeout(timer);
    controller?.abort();
    const number = ++requestNumber;
    if (instructions.some((s) => !s.trim())) {
      $("preview-status").textContent =
        "Complete or delete blank instructions to update the preview.";
      return;
    }
    controller = new AbortController();
    $("preview-status").textContent = "Updating preview…";
    try {
      const result = await request("/api/prompt/preview", {
        method: "POST",
        body: JSON.stringify({ instructions, mode }),
        signal: controller.signal,
      });
      if (number === requestNumber && modal.open) renderPreview(result);
    } catch (e) {
      if (e.name !== "AbortError" && number === requestNumber) {
        $("preview-status").textContent = "Preview unavailable.";
        error(e.message);
      }
    }
  }
  function changed() {
    error();
    status();
    clearTimeout(timer);
    timer = setTimeout(preview, 200);
  }
  function editor() {
    $("instructions").replaceChildren();
    instructions.forEach((text, i) => {
      const row = node("li"),
        input = node("input"),
        remove = node("button", "Delete");
      input.type = "text";
      input.value = text;
      input.maxLength = 2000;
      input.setAttribute("aria-label", `Instruction ${i + 1}`);
      input.placeholder = "Enter an instruction…";
      input.addEventListener("input", () => {
        instructions[i] = input.value;
        changed();
      });
      remove.type = "button";
      remove.className = "secondary-button";
      remove.setAttribute("aria-label", `Delete instruction ${i + 1}`);
      remove.addEventListener("click", () => {
        instructions.splice(i, 1);
        editor();
        changed();
      });
      row.append(input, remove);
      $("instructions").append(row);
    });
    status();
  }
  async function load() {
    loading = true;
    status();
    error();
    try {
      const data = await request("/api/prompt");
      instructions = [...data.instructions];
      saved = [...data.instructions];
      revision = data.revision;
      editor();
      await preview();
    } catch (e) {
      error(e.message);
    } finally {
      loading = false;
      status();
    }
  }
  function close(action) {
    if (saving || loading) return;
    if (dirty()) {
      pendingClose = action;
      $("discard").hidden = false;
      return;
    }
    if (action === "reload") void load();
    else modal.close();
  }
  $("open").addEventListener("click", () => {
    modal.showModal();
    $("discard").hidden = true;
    void load();
  });
  for (const id of ["close", "cancel"])
    $(id).addEventListener("click", () => close("close"));
  modal.addEventListener("cancel", (event) => {
    event.preventDefault();
    close("close");
  });
  modal.addEventListener("close", () => {
    clearTimeout(timer);
    controller?.abort();
    ++requestNumber;
  });
  $("reload").addEventListener("click", () => close("reload"));
  $("keep").addEventListener("click", () => {
    $("discard").hidden = true;
  });
  $("discard-confirm").addEventListener("click", () => {
    $("discard").hidden = true;
    instructions = [...saved];
    if (pendingClose === "reload") void load();
    else modal.close();
  });
  $("add").addEventListener("click", () => {
    instructions.push("");
    editor();
    changed();
    $("instructions").lastElementChild.querySelector("input").focus();
  });
  $("mode").addEventListener("change", () => {
    mode = $("mode").value;
    void preview();
  });
  $("expand").addEventListener("click", () => {
    expanded = true;
    $("preview")
      .querySelectorAll("details")
      .forEach((n) => {
        n.open = true;
      });
  });
  $("collapse").addEventListener("click", () => {
    expanded = false;
    $("preview")
      .querySelectorAll("details")
      .forEach((n) => {
        n.open = false;
      });
  });
  $("save").addEventListener("click", async () => {
    if (saving || loading || !dirty()) return;
    saving = true;
    status();
    error();
    // Freeze the submitted values; editing is disabled until the save completes.
    $("instructions")
      .querySelectorAll("input,button")
      .forEach((n) => {
        n.disabled = true;
      });
    const submitted = [...instructions];
    try {
      const result = await request("/api/prompt", {
        method: "PUT",
        body: JSON.stringify({ instructions: submitted, revision }),
      });
      saved = [...result.instructions];
      instructions = [...saved];
      revision = result.revision;
      $("discard").hidden = true;
      editor();
      await preview();
    } catch (e) {
      error(e.message);
    } finally {
      saving = false;
      $("instructions")
        .querySelectorAll("input,button")
        .forEach((n) => {
          n.disabled = false;
        });
      status();
    }
  });
})();
