const statusLine = document.getElementById('sub-agents-status');
const errorLine = document.getElementById('sub-agents-error');
const list = document.getElementById('sub-agents-list');
const template = document.getElementById('sub-agent-card');
let token;

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Please sign in first.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Sub-agent settings could not be loaded.');
  return data;
}

function showError(error) {
  errorLine.textContent = error.message;
  errorLine.hidden = false;
}

function renderAgent(agent) {
  const card = template.content.cloneNode(true);
  const field = name => card.querySelector(`[data-field="${name}"]`);
  const control = card.querySelector('input');
  const state = field('state');
  const unavailable = field('unavailable');
  const internalTools = field('internal-tools');
  const mcpTools = field('mcp-tools');
  const label = `Enable ${agent.name}`;
  control.setAttribute('aria-label', label);
  field('name').textContent = agent.name;
  field('description').textContent = agent.description;
  field('supervisor-tool').textContent = agent.supervisorTool.name;
  field('supervisor-description').textContent = agent.supervisorTool.description;
  field('supervisor-guidance').textContent = agent.supervisorTool.guidance;
  field('prompt').textContent = agent.prompt || 'Prompt unavailable.';

  for (const tool of agent.internalTools) {
    const term = document.createElement('dt');
    const code = document.createElement('code');
    code.textContent = tool.name;
    term.append(code);
    const description = document.createElement('dd');
    description.textContent = tool.description;
    internalTools.append(term, description);
  }
  for (const tool of agent.mcpTools) {
    const item = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = tool;
    item.append(code);
    mcpTools.append(item);
  }

  function syncSwitch() {
    control.checked = agent.requested;
    control.disabled = Boolean(agent.unavailable && !agent.requested);
    state.textContent = agent.unavailable ? 'Unavailable' : agent.enabled ? 'On' : 'Off';
    unavailable.textContent = agent.unavailable || '';
    unavailable.hidden = !agent.unavailable;
  }

  syncSwitch();
  control.addEventListener('change', async () => {
    const enabled = control.checked;
    control.disabled = true;
    state.textContent = 'Saving…';
    errorLine.hidden = true;
    statusLine.textContent = '';
    try {
      const result = await api(`/api/sub-agents/${encodeURIComponent(agent.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Local-Token': token },
        body: JSON.stringify({ enabled }),
      });
      agent = result.agents.find(item => item.id === agent.id);
      statusLine.textContent = `${agent.name} ${agent.enabled ? 'enabled' : 'disabled'}.`;
    } catch (error) {
      showError(error);
    } finally {
      syncSwitch();
    }
  });
  list.append(card);
}

async function load() {
  const status = await api('/api/auth/status');
  if (!status.authenticated) {
    window.location.assign('/login');
    return;
  }
  token = status.token;
  const { agents } = await api('/api/sub-agents');
  agents.forEach(renderAgent);
  statusLine.textContent = agents.length ? '' : 'No sub-agents are configured.';
}

void load().catch(error => {
  statusLine.textContent = '';
  showError(error);
});
