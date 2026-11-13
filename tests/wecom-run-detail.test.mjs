import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { wecomRunDetail } from '../dist/web/run-detail.js';
import { RUN_METRICS_TYPE } from '../dist/web/run-metrics.js';

test('detail isolates its exact round and excludes tool results, thinking and a later answer',()=>{
 const manager=SessionManager.inMemory();
 manager.appendMessage({role:'user',content:'first',timestamp:1});
 manager.appendMessage({role:'assistant',content:[{type:'thinking',thinking:'PRIVATE REASONING'},{type:'toolCall',id:'tool',name:'read',arguments:{}},{type:'text',text:'Visible first part'}],timestamp:2});
 manager.appendMessage({role:'toolResult',toolCallId:'tool',toolName:'read',content:[{type:'text',text:'PRIVATE TOOL RESULT'}],timestamp:3});
 manager.appendMessage({role:'assistant',content:[{type:'text',text:'Visible final answer'}],timestamp:4});
 const run={id:'first',sequence:1,startedAt:new Date().toISOString(),round:1,status:'stopped',wecom:{botId:'bot',userId:'user'}};
 manager.appendCustomEntry(RUN_METRICS_TYPE,run);
 manager.appendMessage({role:'user',content:'second',timestamp:5});
 manager.appendMessage({role:'assistant',content:[{type:'text',text:'Different answer'}],timestamp:6});
 assert.deepEqual(wecomRunDetail(manager,'first'),{status:'stopped',answer:'Visible first part\n\nVisible final answer'});
 manager.appendCustomEntry(RUN_METRICS_TYPE,{...run,id:'interrupted',round:null,status:'running'});
 assert.deepEqual(wecomRunDetail(manager,'interrupted'),{status:'interrupted',answer:''});
 assert.deepEqual(wecomRunDetail(manager,'interrupted','interrupted','Live partial text'),{status:'running',answer:'Live partial text'});
 manager.appendCustomEntry(RUN_METRICS_TYPE,{...run,id:'failed',status:'failed'});
 assert.equal(wecomRunDetail(manager,'failed').status,'failed');
 assert.equal(wecomRunDetail(manager,'missing'),undefined);
 manager.appendCustomEntry(RUN_METRICS_TYPE,{...run,id:'browser',wecom:undefined});
 assert.equal(wecomRunDetail(manager,'browser'),undefined);
});
