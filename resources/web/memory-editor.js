'use strict';
(() => {
  const el = id => document.getElementById(`memory-editor-${id}`);
  const modal = el('dialog');
  let kind = 'main', before = '', revision = '', loaded = false, loading = false, saving = false, generation = 0, crlf = false;
  const dirty = () => loaded && el('text').value !== before;
  function error(message = '') { el('error').textContent = message; el('error').hidden = !message; }
  function controls(message) {
    el('text').disabled = !loaded || loading || saving;
    el('save').disabled = !dirty() || loading || saving;
    el('reload').disabled = loading || saving;
    el('close').disabled = saving; el('cancel').disabled = saving;
    el('status').textContent = message ?? (saving ? 'Saving… Waiting for active questions if necessary.' : loading ? 'Loading…' : dirty() ? 'Unsaved changes' : loaded ? 'Saved content. Changes apply to the next run.' : 'Unable to load memory.');
  }
  const discard = () => !dirty() || window.confirm('Discard unsaved memory changes?');
  function close() { if (saving || !discard()) return; modal.close(); }
  async function load() {
    const request = ++generation, selected = kind;
    loading = true; loaded = false; el('text').value = ''; error(); controls();
    try {
      const result = await api(`/api/memory-injection/files/${selected}`);
      if (request !== generation || !modal.open) return;
      crlf = result.text.includes('\r\n'); revision = result.revision; el('text').value = result.text; before = el('text').value; loaded = true;
    } catch (err) { if (request === generation && modal.open) error(err.message); }
    finally { if (request === generation && modal.open) { loading = false; controls(); if (loaded) el('text').focus(); } }
  }
  for (const selected of ['main', 'extra']) document.getElementById(`memory-injection-edit-${selected}`).addEventListener('click', () => {
    if (modal.open) return;
    kind = selected; before = ''; revision = ''; loaded = false;
    el('title').textContent = selected === 'main' ? 'Edit Memory' : 'Edit Extra Memory';
    el('description').textContent = selected === 'main' ? 'Main business memory · memory/urovo-product-expert/MEMORY.md' : 'Extra agent memory · memory/urovo-product-expert/MEMORY_EXTRA.md. This file stays separate from main memory.';
    modal.showModal(); void load();
  });
  for (const id of ['close', 'cancel']) el(id).addEventListener('click', close);
  modal.addEventListener('cancel', event => { event.preventDefault(); close(); });
  modal.addEventListener('close', () => { generation++; loading = false; loaded = false; });
  el('text').addEventListener('input', () => controls());
  el('reload').addEventListener('click', () => { if (!saving && !loading && discard()) void load(); });
  el('save').addEventListener('click', async () => {
    if (!dirty() || saving || loading) return;
    const value = el('text').value;
    const text = crlf ? value.replace(/\r?\n/g, '\r\n') : value, selected = kind;
    saving = true; error(); controls();
    try {
      const result = await api(`/api/memory-injection/files/${selected}`, {method: 'PUT', body: JSON.stringify({text, revision})});
      revision = result.revision; el('text').value = result.text; before = el('text').value;
      if (result.changed) window.dispatchEvent(new CustomEvent('memory-file-saved', {detail: {kind: selected}}));
      if (typeof refreshStatus === 'function') void refreshStatus().catch(() => {});
    } catch (err) { error(err.message); }
    finally { saving = false; controls(); }
  });
  document.getElementById('memory-injection-download-extra').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = 'Downloading…';
    try {
      const response = await fetch('/api/memory-injection/download-extra');
      if (response.status === 401) { window.location.replace('/login'); return; }
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Extra memory download failed.'); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'MEMORY_EXTRA.md'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      document.getElementById('memory-injection-error').hidden = true;
    } catch (err) { const target = document.getElementById('memory-injection-error'); target.textContent = err.message; target.hidden = false; }
    finally { button.disabled = false; button.textContent = 'Download Extra Memory'; }
  });
})();
