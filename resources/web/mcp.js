'use strict';
const $ = id => document.getElementById(id);
const number = value => Number(value || 0).toLocaleString('en-US');
function stat(label, value) { const block=document.createElement('div');block.className='contact-stat';const name=document.createElement('span');name.textContent=label;const text=document.createElement('strong');text.textContent=value;block.append(name,text);return block; }
async function refresh() {
  $('mcp-refresh').disabled=true;
  try {
    const response=await fetch('/api/mcp/usage');
    if(response.status===401){location.assign('/login');return;}
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load MCP usage.');
    const t=data.totals;
    $('mcp-status').textContent=`${data.enabled?'Enabled':'Disabled'} · Endpoint: /mcp · Authentication: none · Tracking since ${new Date(data.since).toLocaleString('en-US')}`;
    $('mcp-summary').replaceChildren(stat('Submitted tasks',number(t.submitted)),stat('Input tokens',number(t.inputTokens)),stat('Output tokens',number(t.outputTokens)),stat('Total recorded tokens',number(t.totalTokens)),stat('Reported / model requests',`${number(t.reportedRequests)} / ${number(t.requests)}`),stat('Requests missing usage',number(t.missingRequests)));
    const body=$('mcp-tasks').querySelector('tbody');body.replaceChildren();$('mcp-empty').hidden=data.recentTasks.length>0;
    for(const task of data.recentTasks){
      const row=document.createElement('tr');
      for(const value of [`${task.task_id}\n${task.conversation_id}\n${new Date(task.created_at).toLocaleString('en-US')}`,`${task.status}\n${task.model||'Not started'}`,number(task.input_tokens),number(task.output_tokens),`${task.reported_requests} / ${task.model_requests}${task.reported_requests<task.model_requests?' · Incomplete':''}`]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}
      body.append(row);
    }
  } catch(error){$('mcp-status').textContent=error.message;}
  finally{$('mcp-refresh').disabled=false;}
}
$('mcp-refresh').addEventListener('click',refresh);void refresh();
