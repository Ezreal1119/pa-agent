import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function ui(){
 const nodes=new Map(),requests=[];let pending,fail=false,confirm=false;
 const get=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,disabled:false,textContent:'',dataset:{},events:{},addEventListener(k,fn){this.events[k]=fn;},showModal(){this.open=true;},close(){this.open=false;},focus(){},set innerHTML(v){throw Error('Use textContent');}});return nodes.get(id);};
 let state={available:true,editable:true,enabled:false,active:false,calendar:'*-*-* 07:00:00 Asia/Shanghai',nextRun:null,revision:'v1',schedule:{enabled:false,frequency:'daily',time:'07:00'},trigger:{available:true},lastRun:null};
 const context=vm.createContext({document:{getElementById:get},window:{addEventListener(){},confirm:()=>confirm},api:async(route,method,body)=>{requests.push({route,method,body});if(method==='PUT'){if(fail)throw Error('Timer changed elsewhere');state={...state,revision:'v2',schedule:body.schedule,enabled:body.schedule.enabled,active:body.schedule.enabled};}else if(pending)return pending;return state;}});
 vm.runInContext(await fs.readFile('resources/web/synchronize-auto-settings.js','utf8'),context);await get('auto-settings-open').onclick();
 return {get,requests,context,state:v=>state=v,fail:v=>fail=v,confirm:v=>confirm=v,pending:v=>pending=v};
}
test('Auto-sync Settings stays off until explicit save, sends daily Beijing time and displays last results safely',async()=>{
 const f=await ui(),g=f.get;assert.equal(g('auto-schedule-enabled').checked,false);assert.equal(g('auto-schedule-save').disabled,true);
 g('auto-schedule-time').value='08:30';g('auto-schedule-enabled').checked=true;g('auto-schedule-time').oninput();await g('auto-schedule-save').onclick();
 assert.deepEqual(JSON.parse(JSON.stringify(f.requests.at(-1))),{route:'settings/schedule',method:'PUT',body:{schedule:{enabled:true,frequency:'daily',time:'08:30'},revision:'v1'}});
 assert.match(g('sync-mode-label').textContent,/08:30 Beijing/);assert.match(g('auto-schedule-result').textContent,/Saved and applied/);assert.equal(g('auto-schedule-save').disabled,true);
 f.state({available:true,editable:true,enabled:true,active:true,calendar:'daily',nextRun:null,revision:'v3',schedule:{enabled:true,frequency:'daily',time:'08:30'},trigger:{available:true},lastRun:{started:new Date().toISOString(),status:'completed',selected:3,held:2,counts:{published:2,needs_review:1},error:'<script>untrusted</script>'}});
 await g('auto-schedule-reload').onclick();assert.match(g('auto-last-run').textContent,/2 published/);assert.match(g('auto-last-run').textContent,/2 held/);assert.match(g('auto-last-run').textContent,/<script>/);
});
test('invalid time, unavailable helper, conflicts, unsaved close and stale reloads are handled',async()=>{
 const f=await ui(),g=f.get;g('auto-schedule-time').value='';g('auto-schedule-time').oninput();assert.equal(g('auto-schedule-save').disabled,true);
 g('auto-schedule-time').value='09:00';g('auto-schedule-time').oninput();f.fail(true);await g('auto-schedule-save').onclick();assert.match(g('auto-schedule-result').textContent,/changed elsewhere/);assert.equal(g('auto-schedule-time').value,'09:00');
 g('auto-settings-close').onclick();assert.equal(g('auto-settings-dialog').open,true);f.confirm(true);g('auto-settings-close').onclick();
 f.state({available:false,editable:false,note:'Install Auto-sync helper'});await g('auto-settings-open').onclick();assert.equal(g('auto-schedule-time').disabled,true);assert.match(g('auto-schedule-result').textContent,/Install Auto-sync/);
 let resolve;f.pending(new Promise(r=>resolve=r));const old=g('auto-schedule-reload').onclick();g('auto-settings-close').onclick();f.pending(undefined);await g('auto-settings-open').onclick();resolve({available:true,editable:true,schedule:{enabled:true,frequency:'daily',time:'11:00'},trigger:{available:true}});await old;assert.equal(g('auto-schedule-time').disabled,true);
});
