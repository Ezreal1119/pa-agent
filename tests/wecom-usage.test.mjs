import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WecomContacts } from '../dist/web/wecom-contacts.js';
import { sdkTokens, visionTokens } from '../dist/web/run-metrics.js';

test('SDK cache and thinking subsets are counted once, raw vision usage is supported, missing usage remains unknown',()=>{
 assert.deepEqual(sdkTokens({input:600,cacheRead:350,cacheWrite:50,output:100,reasoning:70,totalTokens:1100}),{input:1000,output:100});
 assert.equal(sdkTokens({input:0,cacheRead:0,cacheWrite:0,output:0}),undefined);
 assert.equal(sdkTokens({input:-1,output:1}),undefined);
 assert.deepEqual(visionTokens({prompt_tokens:1000,completion_tokens:100,total_tokens:1100,prompt_tokens_details:{cached_tokens:350}}),{input:1000,output:100});
 assert.equal(visionTokens(undefined),undefined);assert.equal(visionTokens({prompt_tokens:4}),undefined);
});

test('cumulative contact statistics use one cursor per session and reject duplicate/outdated snapshots after restart',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'contact-usage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let book=new WecomContacts(root);const now=Date.now();const sender={botId:'bot',userId:'a',chatType:'group',chatId:'group',at:now};
 const run={id:'run-first',sequence:1,startedAt:new Date(now).toISOString(),status:'running',usage:{input:0,output:0,requests:0,reportedRequests:0}};
 await book.recordRun(sender,'session-1',run);await book.recordRun(sender,'session-1',run);
 const done={...run,status:'completed',usage:{input:100,output:10,requests:1,reportedRequests:1}};
 await Promise.all([book.recordRun(sender,'session-1',done),book.recordRun(sender,'session-1',done)]);
 book=new WecomContacts(root);await book.recoverSession('session-1',[{...done,wecom:sender}]);await book.recordRun(sender,'session-1',run); // stale running snapshot cannot undo final data
 const second={...done,id:'run-second',sequence:2};const b={...sender,userId:'b'};
 await book.recordRun(b,'session-1',second);await book.recordRun(sender,'session-1',done); // older A run cannot increment A again
 const a=(await book.list()).find(c=>c.userId==='a');assert.equal(a.stats.questions,1);assert.equal(a.stats.inputTokens,100);assert.equal(a.stats.finishedRuns,1);
 const contactB=(await book.list()).find(c=>c.userId==='b');assert.equal(contactB.stats.questions,1);
 await assert.rejects(book.recordRun(sender,'session-1',second),/conflicts/);
 const disk=JSON.parse(await fs.readFile(path.join(root,'wecom/contacts.json'),'utf8'));assert.equal(Object.keys(disk.cursors).length,1);
 assert.equal((await fs.stat(path.join(root,'wecom/contacts.json'))).mode&0o777,0o600);
});

test('private session display names survive bridge job cleanup and keep group cursors separate', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'contact-display-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let book=new WecomContacts(root);const at=Date.now();
 const sender={botId:'bot',userId:'u',chatType:'single',at};
 const contact=await book.record(sender);await book.rename(contact.id,{name:'张三'});
 const run={id:'run-first',sequence:1,startedAt:new Date(at).toISOString(),status:'completed',usage:{input:0,output:0,requests:0,reportedRequests:0}};
 await book.recordRun(sender,'private-session',run);
 await book.recordRun({...sender,chatType:'group',chatId:'group'},'group-session',{...run,id:'run-group'});
 book=new WecomContacts(root);
 const file=path.join(root,'wecom/contacts.json'),before=await fs.readFile(file,'utf8');
 let titles=await book.sessionTitles(['private-session','group-session','unknown-session']);
 assert.equal(titles.get('private-session').displayTitle,'企微 · 张三');assert.equal(titles.size,1);
 assert.equal(await fs.readFile(file,'utf8'),before,'listing names must not write statistics');
 const legacy=JSON.parse(before);delete legacy.cursors['private-session'].chatType;await fs.writeFile(file,JSON.stringify(legacy));
 titles=await book.sessionTitles(['private-session']);assert.equal(titles.size,0,'an ambiguous legacy scope must not be guessed');
 await book.recoverSession('private-session',[{...run,wecom:sender}]);
 titles=await book.sessionTitles(['private-session']);assert.equal(titles.get('private-session').displayTitle,'企微 · 张三');
 const actual=path.join(root,'wecom/original-state.json');await fs.writeFile(actual,JSON.stringify({conversations:{},jobs:[]}));await fs.symlink(actual,path.join(root,'wecom/bridge-state.json'));
 await assert.rejects(book.sessionTitles(['private-session']),/regular file/);
});
