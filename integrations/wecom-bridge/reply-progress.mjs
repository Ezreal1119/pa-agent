import { splitUtf8, WECOM_TEXT_CHUNK_BYTES } from './protocol.mjs';

export const THINKING_INDICATOR = 'Thinking…';
const TEXT_UPDATE_MS = 2500;
const RETRY_UPDATE_MS = 250;
const MAX_STEPS = 12;

function action(indicator, label) { return { indicator, label }; }
const workspace = action('Searching the workspace…', 'Search the workspace');
const document = action('Reading your document…', 'Read the document');
const file = action('Preparing your file…', 'Prepare the file');
const toolActions = new Map(Object.entries({
  ask_ones_agent: action('Querying via the ONES Agent 🤖…', 'Query the ONES Agent'),
  ask_windows_tools_agent: action('Diagnosing via the Windows Tools Agent 🤖…', 'Diagnose with the Windows Tools Agent'),
  recall_memory: action('Checking relevant saved notes…', 'Check relevant saved notes'),
  memory: action('Working with saved notes…', 'Work with saved notes'),
  grep: workspace, find: workspace, ls: workspace,
  read: action('Reading reference material…', 'Read reference material'),
  search: action('Searching the web…', 'Search the web'),
  fetch: action('Reading a web page…', 'Read a web page'),
  get_file_link_from_library: action('Looking up download links…', 'Look up download links'),
  pdf_read: document, docx_read: document, pptx_read: document,
  excel_read: action('Reading your spreadsheet…', 'Read the spreadsheet'),
  image_read: action('Reviewing your image…', 'Review the image'),
  excel_create: file, excel_patch_template: file, text_file_create: file,
}));
const onesFields = 'Identify ONES work item types and fields';
const onesStepLabels = new Map(Object.entries({
  search_for_projects: 'Find relevant ONES projects',
  search_for_issue_types: onesFields,
  get_issue_fields: onesFields,
  search_for_issue_field_options: onesFields,
  query_issues_by_onesql: 'Search ONES work items',
  get_issue_details: 'Read ONES work item details',
  get_issue_activities: 'Check ONES work item activity',
  get_issue_status: 'Check available ONES statuses',
  get_list_of_issue_comments: 'Read ONES comments',
  get_issue_human_readable_keys: 'Resolve ONES work item numbers',
}));

function describeTool(name) {
  if (typeof name !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(name)) return action('Using a tool…', 'Use a tool');
  const readable = name.replace(/^[-_]+|[-_]+$/g, '').replace(/[-_]+/g, ' ').toLowerCase();
  return toolActions.get(name) ?? (readable ? action(`Running ${readable}…`, `Run ${readable}`) : action('Using a tool…', 'Use a tool'));
}

/** Keep the tag pair and process text intact within the SDK's 20,480-byte frame. */
export function withThinking(text, thinking) {
  if (!thinking) return text;
  const summary = splitUtf8(thinking, 20480 - WECOM_TEXT_CHUNK_BYTES - Buffer.byteLength('<think></think>\n\n'))[0];
  return `<think>${summary}</think>\n\n${text}`;
}

/** Only known event types and tool names reach the public process summary. */
export class ReplyProgress {
  #calls = new Map();
  #steps = new Map();
  #indicator = THINKING_INDICATOR;
  #text = '';
  #timer;
  #nextAt;
  #pending = false;
  #closed = false;
  #lastSent = THINKING_INDICATOR;
  #lastTextUpdate = 0;

  constructor(send) { this.send = send; }

  tool({ id, name, state }, nested = false) {
    if (state === 'running' && !this.#calls.has(id)) {
      const { indicator, label: fallback } = describeTool(name);
      const label = (nested && onesStepLabels.get(name)) || fallback;
      const step = this.#steps.get(label) ?? { running: 0, completed: 0, failed: 0 };
      this.#steps.set(label, step);
      this.#calls.set(id, { indicator: nested ? undefined : indicator, step });
      step.running++;
      if (!nested) this.#indicator = indicator;
      this.#schedule();
    } else if (state === 'done' || state === 'error') {
      const call = this.#calls.get(id);
      if (!call) return;
      this.#calls.delete(id);
      call.step.running--;
      call.step[state === 'done' ? 'completed' : 'failed']++;
      this.#indicator = [...this.#calls.values()].findLast(active => active.indicator)?.indicator ?? this.#indicator;
      this.#schedule(TEXT_UPDATE_MS);
    }
  }

  text(delta) {
    const immediate = Boolean(this.#indicator) && !this.#calls.size;
    if (immediate) this.#indicator = '';
    this.#text += delta;
    this.#schedule(immediate ? 0 : Math.max(0, this.#lastTextUpdate + TEXT_UPDATE_MS - Date.now()));
  }

  summary(final = false) {
    const lines = [];
    for (const [label, counts] of [...this.#steps.entries()].slice(0, MAX_STEPS)) {
      const statuses = [
        counts.completed && `${counts.completed} completed`,
        counts.failed && `${counts.failed} failed`,
        counts.running && `${counts.running} ${final ? 'interrupted' : 'in progress'}`,
      ].filter(Boolean);
      lines.push(`- ${label} · ${statuses.join(', ')}`);
    }
    if (this.#steps.size > MAX_STEPS) lines.push(`- ${this.#steps.size - MAX_STEPS} more actions`);
    return lines.join('\n');
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
  }

  #preview() {
    const body = [this.#indicator, this.#text].filter(Boolean).join('\n\n');
    return withThinking(splitUtf8(body)[0] ?? '', this.summary());
  }

  #schedule(delay = 0) {
    const due = Date.now() + delay;
    if (this.#closed || (this.#nextAt !== undefined && this.#nextAt <= due)) return;
    this.#nextAt = due;
    this.#arm();
  }

  #arm() {
    if (this.#closed || this.#pending || this.#nextAt === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#nextAt = undefined;
      void this.#flush();
    }, Math.max(0, this.#nextAt - Date.now()));
  }

  async #flush() {
    const content = this.#preview();
    if (this.#closed || content === this.#lastSent) return;
    this.#pending = true;
    this.#lastTextUpdate = Date.now();
    let skipped = false;
    try {
      skipped = await this.send(content) === 'skipped';
      if (!skipped) this.#lastSent = content;
    } catch {
      // Preview delivery is best effort. A later event can offer a new update.
      this.#lastSent = content;
    } finally {
      this.#pending = false;
    }
    if (skipped) this.#nextAt = Math.max(this.#nextAt ?? 0, Date.now() + RETRY_UPDATE_MS);
    this.#arm();
  }
}
