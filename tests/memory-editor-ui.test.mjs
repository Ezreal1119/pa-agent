import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
class Element {
  constructor(){this.events={};this._value='';this.textContent='';this.hidden=false;this.disabled=false;this.children=[];this.open=false;}
  set value(v){this._value=String(v).replace(/\r\n/g,'\n');} get value(){return this._value;}
  addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
  async fire(name,event={}){for(const fn of this.events[name]??[])await fn({currentTarget:this,preventDefault(){},...event});}
  showModal(){this.open=true;} close(){this.open=false;void this.fire('close');}focus(){} append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}click(){this.clicked=true;}remove(){}
  set innerHTML(value){throw Error('Untrusted memory must never be inserted as HTML');}
}
const tick=()=>new Promise(r=>setImmediate(r));
async function fixture(includeInjection=false){
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const document={getElementById:get,createElement:()=>new Element(),body:new Element()};
  let confirmation=false,rejectSave=false,deferred,downloadError=false;
  const records={main:{text:'# Skill Memories\r\n\r\nMAIN <script>text</script>',revision:'main-1'},extra:{text:'EXTRA original',revision:'extra-1'}};
  const calls=[],prompts=[],events=[];const listeners={};
  const storage=new Map(includeInjection?[['main-memory-preview','preview-1']]:[]);
  const ready={id:'preview-1',status:'ready',prompt:'Existing instructions',summary:'Preview',questions:[],changes:[],usage:{input:0,output:0,requests:0,recorded:0},model:'mock'};
  const sandbox=vm.createContext({document,window:{confirm:msg=>{prompts.push(msg);return confirmation;},location:{replace(){}},addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn),dispatchEvent:event=>{events.push(event);for(const fn of listeners[event.type]??[])fn(event);}},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},setTimeout:()=>0,clearTimeout(){},refreshStatus:async()=>{},URL:{createObjectURL:()=> 'blob:mock',revokeObjectURL(){}},fetch:async()=>downloadError?{ok:false,status:500,json:async()=>({error:'Download unavailable'})}:{ok:true,status:200,blob:async()=>({})},api:async(route,options={})=>{
    calls.push({route,...options});
    if(route.includes('/previews/'))return ready;
    const kind=route.split('/').at(-1);
    if(options.method==='PUT'){
      if(rejectSave)throw Error('Version conflict. Reload.');
      const payload=JSON.parse(options.body);assert.equal(payload.revision,records[kind].revision);
      records[kind]={text:payload.text,revision:kind+'-2'};return {...records[kind],changed:true};
    }
    if(deferred){const promise=deferred;deferred=undefined;return promise;}
    return {...records[kind]};
  }});
  if(includeInjection)vm.runInContext(await fs.readFile('resources/web/memory-injection.js','utf8'),sandbox);
  vm.runInContext(await fs.readFile('resources/web/memory-editor.js','utf8'),sandbox);
  return {get,records,calls,prompts,events,async open(kind){await get('memory-injection-edit-'+kind).fire('click');await tick();},set confirmation(v){confirmation=v;},set rejectSave(v){rejectSave=v;},set deferred(v){deferred=v;},set downloadError(v){downloadError=v;},document};
}
test('editor handles CRLF without false dirtiness, explicit save, conflict draft retention and unsaved close/reload',async()=>{
  const f=await fixture();await f.open('main');
  const text=f.get('memory-editor-text'),save=f.get('memory-editor-save'),modal=f.get('memory-editor-dialog');
  assert.equal(save.disabled,true);assert.match(text.value,/<script>text<\/script>/);
  text.value+='\nNew fact';await text.fire('input');assert.equal(save.disabled,false);assert.match(f.get('memory-editor-status').textContent,/Unsaved/);
  f.rejectSave=true;await save.fire('click');assert.match(f.get('memory-editor-error').textContent,/conflict/);assert.match(text.value,/New fact/);assert.equal(modal.open,true);
  await f.get('memory-editor-close').fire('click');assert.equal(modal.open,true);
  await f.get('memory-editor-reload').fire('click');assert.match(text.value,/New fact/);
  f.rejectSave=false;await save.fire('click');assert.equal(save.disabled,true);assert.match(f.records.main.text,/\r\nNew fact/);assert.equal(f.records.extra.text,'EXTRA original');assert.equal(f.events[0].detail.kind,'main');
  text.value+='\nUnsaved';await text.fire('input');f.confirmation=true;await modal.fire('cancel');assert.equal(modal.open,false);
});
test('closed/reopened editors ignore stale reads; extra download uses separate filename and reports failures',async()=>{
  const f=await fixture();let resolve;f.deferred=new Promise(r=>resolve=r);await f.open('main');
  await f.get('memory-editor-close').fire('click');await f.open('extra');assert.equal(f.get('memory-editor-text').value,'EXTRA original');
  resolve({text:'OLD main response',revision:'old'});await tick();assert.equal(f.get('memory-editor-text').value,'EXTRA original');
  f.get('memory-editor-text').value='Changed extra';await f.get('memory-editor-text').fire('input');await f.get('memory-editor-save').fire('click');assert.equal(f.records.extra.text,'Changed extra');assert.match(f.records.main.text,/MAIN/);
  await f.get('memory-injection-download-extra').fire('click');assert.equal(f.document.body.children.at(-1).download,'MEMORY_EXTRA.md');
  f.downloadError=true;await f.get('memory-injection-download-extra').fire('click');assert.match(f.get('memory-injection-error').textContent,/Download unavailable/);
});
test('successful direct main save invalidates existing injection preview; extra save does not invalidate main preview',async()=>{
  const f=await fixture(true);await f.get('memory-injection-open').fire('click');await tick();assert.equal(f.get('memory-injection-confirm').hidden,false);
  await f.open('extra');f.get('memory-editor-text').value+=' updated';await f.get('memory-editor-text').fire('input');await f.get('memory-editor-save').fire('click');assert.equal(f.get('memory-injection-confirm').hidden,false);
  await f.get('memory-editor-close').fire('click');await f.open('main');f.get('memory-editor-text').value+=' updated';await f.get('memory-editor-text').fire('input');await f.get('memory-editor-save').fire('click');
  assert.equal(f.get('memory-injection-confirm').hidden,true);assert.match(f.get('memory-injection-status').textContent,/edited directly/);
  const count=f.calls.length;await f.get('memory-injection-confirm').fire('click');assert.equal(f.calls.length,count);
});
