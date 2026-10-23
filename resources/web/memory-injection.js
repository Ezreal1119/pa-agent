'use strict';
(() => {
  const el = id => document.getElementById(`memory-injection-${id}`);
  const modal = el('dialog');
  let current = null;
  let invalidatedPreview = null;
  let timer;
  let sending = false;
  let attachment = null;
  let selectedFile = null;
  const maxAttachmentBytes = 30 * 1024 * 1024;
  let savedId = sessionStorage.getItem('main-memory-preview') || '';
  const labels = {planning: 'Preparing preview… You may close this dialog and return later.', ready: 'Review every change, then confirm.', needs_clarification: 'More information is needed. Edit your instructions and generate a new preview.', committing: 'Saving main memory… Waiting for active questions if necessary.', committed: 'Main memory updated. Changes apply to the next run.', failed: 'No new confirmation is available. Generate a new preview.', conflict: 'Main memory changed. Generate a new preview.'};
  const active = () => sending || ['planning', 'committing'].includes(current?.status);
  function error(message = '') { el('error').textContent = message; el('error').hidden = !message; }
  const attachmentUnchanged = () => !selectedFile && (current?.attachment?.id || '') === (attachment?.id || '');
  function attachmentView() {
    const file = selectedFile || attachment;
    el('attachment').hidden = !file;
    el('attachment-name').textContent = file?.name || '';
    const bytes = selectedFile?.size ?? attachment?.bytes;
    el('attachment-size').textContent = bytes === undefined ? '' : `${(bytes / 1048576).toFixed(2)} MB`;
    el('attach').textContent = file ? 'Replace file' : 'Attach file';
  }
  function controls() {
    el('preview').disabled = active() || !el('prompt').value.trim();
    const unchanged = current?.prompt === el('prompt').value && attachmentUnchanged() && current?.id !== invalidatedPreview;
    el('attach').disabled = active();
    el('file').disabled = active();
    el('attachment-remove').disabled = active();
    attachmentView();
    el('confirm').hidden = current?.status !== 'ready' || !unchanged;
    el('confirm').disabled = active();
    el('status').textContent = current?.id === invalidatedPreview ? 'Main memory was edited directly. Generate a new preview.' : current ? (!unchanged && !active() ? 'Instructions or attachment changed. Generate a new preview.' : labels[current.status] || current.status) : 'No changes until you confirm.';
  }
  function render(job) {
    current = job;
    el('result').hidden = !job.summary && !job.questions.length && !job.changes.length;
    el('summary').textContent = job.summary;
    el('questions').replaceChildren();
    for (const question of job.questions) {const item = document.createElement('li'); item.textContent = question; el('questions').append(item);}
    el('questions').hidden = !job.questions.length;
    el('changes').replaceChildren();
    for (const change of job.changes) {
      const card = document.createElement('details'); card.className = 'memory-change'; card.open = true;
      const heading = document.createElement('summary');
      const action = document.createElement('span'); action.className = `memory-action ${change.action}`; action.textContent = change.action.toUpperCase();
      const id = document.createElement('code'); id.textContent = change.id; heading.append(action, id); card.append(heading);
      const reason = document.createElement('p'); reason.className = 'memory-change-reason'; reason.textContent = change.reason; card.append(reason);
      const comparison = document.createElement('div'); comparison.className = 'memory-comparison';
      for (const [label, value] of [['Before', change.before], ['After', change.after]]) {
        const column = document.createElement('div'); const title = document.createElement('strong'); title.textContent = label;
        const content = document.createElement('pre'); content.textContent = value || (label === 'Before' ? 'New entry' : 'Entry will be removed');
        column.append(title, content); comparison.append(column);
      }
      card.append(comparison); el('changes').append(card);
    }
    el('usage').textContent = `${job.model} · Recorded text tokens: ${job.usage.input.toLocaleString()} input / ${job.usage.output.toLocaleString()} output · ${job.usage.recorded}/${job.usage.requests} requests with usage${job.visualUsage ? ` · Recorded vision tokens: ${job.visualUsage.input.toLocaleString()} input / ${job.visualUsage.output.toLocaleString()} output · ${job.visualUsage.recorded}/${job.visualUsage.requests} requests with usage` : ''}`;
    error(job.error || ''); controls();
  }
  async function poll() {
    clearTimeout(timer);
    if (!savedId || !modal.open) return;
    try {
      const id = savedId;
      const job = await api(`/api/memory-injection/previews/${id}`);
      if (savedId !== id) return;
      render(job);
      if (['planning', 'committing'].includes(job.status)) timer = setTimeout(poll, 1200);
    } catch (err) { error(err.message); }
  }
  document.getElementById('memory-injection-open').addEventListener('click', async () => {
    modal.showModal();
    if (savedId && !current) {
      try { const job = await api(`/api/memory-injection/previews/${savedId}`); el('prompt').value = job.prompt; attachment = job.attachment || null; selectedFile = null; render(job); }
      catch (err) { savedId = ''; sessionStorage.removeItem('main-memory-preview'); error(err.message); }
    }
    controls(); void poll(); el('prompt').focus();
  });
  for (const id of ['close', 'cancel']) el(id).addEventListener('click', () => modal.close());
  modal.addEventListener('close', () => clearTimeout(timer));
  el('download').addEventListener('click', async () => {
    const button = el('download');
    button.disabled = true; button.textContent = 'Downloading…'; error();
    try {
      const response = await fetch('/api/memory-injection/download');
      if (response.status === 401) { window.location.replace('/login'); return; }
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Memory download failed.'); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'MEMORY.md';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { error(err.message); }
    finally { button.disabled = false; button.textContent = 'Download Memory File'; }
  });
  el('attach').addEventListener('click', () => { if (!active()) el('file').click(); });
  el('file').addEventListener('change', async () => {
    const file = el('file').files?.[0];
    el('file').value = '';
    if (!file || active()) return;
    if (!file.size || file.size > maxAttachmentBytes) { error('Choose one non-empty file of up to 30 MB.'); return; }
    sending = true; error(); controls();
    try {
      if (attachment) await api(`/api/memory-injection/attachments/${attachment.id}`, {method: 'DELETE'});
      attachment = null;
      selectedFile = file;
    } catch (err) { error(err.message); }
    finally { sending = false; controls(); }
  });
  el('attachment-remove').addEventListener('click', async () => {
    if (active()) return;
    sending = true; error(); controls();
    try {
      if (attachment) await api(`/api/memory-injection/attachments/${attachment.id}`, {method: 'DELETE'});
      attachment = null; selectedFile = null;
    } catch (err) { error(err.message); }
    finally { sending = false; controls(); }
  });
  el('prompt').addEventListener('input', controls);
  el('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (active() || !el('prompt').value.trim()) return;
    const prompt = el('prompt').value;
    sending = true; error(); controls(); el('status').textContent = 'Starting preview…';
    try {
      if (selectedFile) {
        el('status').textContent = 'Uploading attachment…';
        attachment = await api(`/api/memory-injection/attachments?name=${encodeURIComponent(selectedFile.name)}`, {
          method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: selectedFile,
        });
        selectedFile = null;
        attachmentView();
      }
      el('status').textContent = attachment ? 'Reading attachment and preparing preview…' : 'Starting preview…';
      const job = await api('/api/memory-injection/previews', {method: 'POST', body: JSON.stringify({prompt, ...(attachment ? {attachmentId: attachment.id} : {})})});
      savedId = job.id; sessionStorage.setItem('main-memory-preview', savedId); render(job); void poll();
    } catch (err) {error(err.message);}
    finally {sending = false; controls();}
  });
  window.addEventListener('memory-file-saved', event => {
    if (event.detail?.kind === 'main' && current) { invalidatedPreview = current.id; controls(); }
  });
  el('confirm').addEventListener('click', async () => {
    if (active() || current?.id === invalidatedPreview || current?.status !== 'ready' || current.prompt !== el('prompt').value || !attachmentUnchanged()) return;
    sending = true; error(); controls();
    try {
      render(await api(`/api/memory-injection/previews/${savedId}/confirm`, {method: 'POST', body: '{}'}));
      void poll();
      void refreshStatus().catch(() => {});
    } catch (err) {error(err.message);}
    finally {sending = false; controls();}
  });
})();
