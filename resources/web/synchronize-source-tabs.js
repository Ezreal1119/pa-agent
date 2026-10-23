(() => {
  const sources = ["sftp", "library", "wecom"];
  const get = (id) => document.getElementById(id);
  function select(source, updateUrl = true) {
    const selected = sources.includes(source) ? source : "sftp";
    for (const name of sources) {
      const active = name === selected;
      const tab = get(`source-tab-${name}`);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      get(`source-panel-${name}`).hidden = !active;
    }
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set("source", selected);
      window.history.replaceState(null, "", url);
    }
  }
  for (const [index, source] of sources.entries()) {
    const tab = get(`source-tab-${source}`);
    tab.onclick = () => select(source);
    tab.onkeydown = (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % sources.length;
      else if (event.key === "ArrowLeft") next = (index + sources.length - 1) % sources.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = sources.length - 1;
      else return;
      event.preventDefault();
      select(sources[next]);
      get(`source-tab-${sources[next]}`).focus();
    };
  }
  select(new URLSearchParams(location.search).get("source"), false);
})();
