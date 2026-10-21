// Library tab: browse and edit the live knowledge directory. Shares helpers
// ($, el, button, error, fileSize, dateLabel, diff, token) with synchronize.js.
const library = {
  files: [],
  loaded: false,
  open: new Set(),
  current: undefined,
  mode: "preview",
  draft: undefined,
};
async function libraryRequest(route, method = "GET", body) {
  const response = await fetch(`/api/sync/${route}`, {
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
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(Error(result.error || "Request failed."), {
      status: response.status,
    });
  return result;
}
const libraryDirty = () =>
  library.current?.text !== null &&
  library.draft !== undefined &&
  library.draft !== library.current?.text;
function confirmDiscard() {
  return (
    !libraryDirty() || window.confirm("Discard your unsaved edits to this file?")
  );
}
async function loadLibraryTree() {
  const { files } = await libraryRequest("library");
  library.files = files;
  library.loaded = true;
  $("library-count").textContent = files.length;
  renderLibraryTree();
}
function renderLibraryTree() {
  const query = $("library-filter").value.trim().toLowerCase();
  const files = query
    ? library.files.filter((f) => f.path.toLowerCase().includes(query))
    : library.files;
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part))
        node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }
  const render = (node, prefix) => {
    const list = el("ul");
    for (const [name, child] of node.dirs) {
      const dir = prefix ? `${prefix}/${name}` : name,
        item = el("li"),
        details = el("details");
      details.open = !!query || library.open.has(dir);
      details.ontoggle = () =>
        details.open ? library.open.add(dir) : library.open.delete(dir);
      details.append(el("summary", name), render(child, dir));
      item.append(details);
      list.append(item);
    }
    for (const file of node.files) {
      const item = el("li"),
        open = el("button", file.path.split("/").at(-1), "library-file");
      open.type = "button";
      open.title = file.path;
      if (!file.editable) open.classList.add("is-readonly");
      if (file.path === library.current?.path) {
        open.classList.add("selected");
        open.setAttribute("aria-current", "true");
      }
      open.onclick = () => openLibraryFile(file.path);
      item.append(open);
      list.append(item);
    }
    return list;
  };
  $("library-tree").replaceChildren(
    files.length
      ? render(root, "")
      : el("p", query ? "No matching files." : "No files.", "sync-subtle"),
  );
}
async function openLibraryFile(name, force = false) {
  if (!force && !confirmDiscard()) return;
  $("sync-error").hidden = true;
  try {
    library.current = await libraryRequest(
      `library/file?path=${encodeURIComponent(name)}`,
    );
    library.draft = undefined;
    library.mode = "preview";
    renderLibraryTree();
    renderLibraryViewer();
  } catch (e) {
    error(e);
  }
}
function libraryMarkdown(text) {
  const box = el("div", undefined, "library-preview");
  if (globalThis.marked && globalThis.DOMPurify)
    box.innerHTML = DOMPurify.sanitize(marked.parse(text));
  else box.append(el("pre", text));
  return box;
}
function renderLibraryViewer() {
  const file = library.current,
    holder = $("library-viewer");
  holder.replaceChildren();
  if (!file) return;
  const meta = library.files.find((f) => f.path === file.path);
  const head = el("div", undefined, "library-head"),
    title = el("div");
  title.append(
    el("h3", file.path),
    el(
      "p",
      `${fileSize(file.bytes)}${meta ? ` · modified ${dateLabel(meta.modified)}` : ""}${file.editable ? "" : " · read-only"}`,
      "sync-subtle",
    ),
  );
  head.append(title);
  const modes = el("div", undefined, "library-modes");
  if (file.text !== null) {
    const choices = [
      ...(/\.md$/i.test(file.path) ? [["preview", "Preview"]] : []),
      ["source", "Source"],
      ...(file.editable ? [["edit", libraryDirty() ? "Edit •" : "Edit"]] : []),
    ];
    if (
      !(library.mode === "review" && file.editable) &&
      !choices.some(([m]) => m === library.mode)
    )
      library.mode = choices[0][0];
    for (const [mode, label] of choices) {
      const b = el("button", label, "sync-button sync-button-quiet");
      b.type = "button";
      b.setAttribute("aria-pressed", String(library.mode === mode));
      b.onclick = () => {
        library.mode = mode;
        renderLibraryViewer();
      };
      modes.append(b);
    }
  }
  head.append(modes);
  holder.append(head);
  if (file.note) holder.append(el("p", file.note, "sync-hint"));
  if (file.text === null) {
    holder.append(
      el("p", "This file cannot be displayed as text.", "sync-subtle"),
    );
    return;
  }
  if (library.mode === "preview") holder.append(libraryMarkdown(file.text));
  else if (library.mode === "source")
    holder.append(el("pre", file.text, "library-source"));
  else if (library.mode === "edit") {
    const input = el("textarea", undefined, "library-editor");
    input.value = library.draft ?? file.text;
    input.spellcheck = false;
    input.setAttribute("aria-label", `Edit ${file.path}`);
    input.oninput = () => {
      library.draft = input.value;
      status.textContent = libraryDirty() ? "Unsaved changes" : "No changes";
    };
    const actions = el("div", undefined, "library-actions"),
      status = el(
        "span",
        libraryDirty() ? "Unsaved changes" : "No changes",
        "sync-subtle",
      );
    const review = el("button", "Review changes →", "sync-button sync-button-primary");
    review.type = "button";
    review.onclick = () => {
      if (!libraryDirty()) return;
      library.mode = "review";
      renderLibraryViewer();
    };
    const discard = el("button", "Discard", "sync-button sync-button-quiet");
    discard.type = "button";
    discard.onclick = () => {
      if (!confirmDiscard()) return;
      library.draft = undefined;
      renderLibraryViewer();
    };
    actions.append(status, discard, review);
    holder.append(input, actions);
  } else if (library.mode === "review") {
    const changes = diff({
      path: file.path,
      before: file.text,
      after: library.draft,
    });
    changes.open = true;
    const actions = el("div", undefined, "library-actions"),
      back = el("button", "← Keep editing", "sync-button sync-button-quiet"),
      save = el("button", "Save to library", "sync-button sync-button-primary");
    back.type = save.type = "button";
    back.onclick = () => {
      library.mode = "edit";
      renderLibraryViewer();
    };
    save.onclick = () => saveLibraryFile(save);
    actions.append(back, save);
    holder.append(
      el(
        "p",
        "Saving replaces the live file immediately. The previous version is backed up, but Sync indexes are not re-validated.",
        "sync-hint",
      ),
      changes,
      actions,
    );
  }
}
async function saveLibraryFile(saveButton) {
  $("sync-error").hidden = true;
  saveButton.disabled = true;
  try {
    const result = await libraryRequest("library/file", "PUT", {
      path: library.current.path,
      text: library.draft,
      expectedHash: library.current.hash,
    });
    const saved = library.current.path;
    await loadLibraryTree();
    await openLibraryFile(saved, true);
    $("library-viewer").prepend(
      el(
        "p",
        result.changed
          ? `Saved. Previous version backed up to ${result.backup}.`
          : "No changes to save.",
        "sync-request",
      ),
    );
  } catch (e) {
    saveButton.disabled = false;
    if (e.status === 409 && /changed after you opened/.test(e.message))
      e.message +=
        " Copy your edits, then click the file again to load the latest version.";
    error(e);
  }
}
globalThis.openLibrary = () => {
  if (!library.loaded) loadLibraryTree().catch(error);
};
$("library-filter").oninput = renderLibraryTree;
$("library-refresh").onclick = async () => {
  $("sync-error").hidden = true;
  try {
    await loadLibraryTree();
    if (library.current && !libraryDirty())
      await openLibraryFile(library.current.path, true);
  } catch (e) {
    error(e);
  }
};
window.addEventListener("beforeunload", (event) => {
  if (libraryDirty()) event.preventDefault();
});
if (!$("panel-library").hidden) globalThis.openLibrary();
