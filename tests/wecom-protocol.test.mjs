import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { identity, inbound, splitUtf8, uploadName, resultFromDone } from '../integrations/wecom-bridge/protocol.mjs';
import { bridgeConfig } from '../integrations/wecom-bridge/config.mjs';
import { BridgeStore } from '../integrations/wecom-bridge/store.mjs';
import { sse, readBounded, AgentApi } from '../integrations/wecom-bridge/api.mjs';
import { downloadMedia } from '../integrations/wecom-bridge/media.mjs';
import { RunGate } from '../dist/web/run-gate.js';

const body = (user, chat, msgid = 'message') => ({ from: { userid: user }, chattype: chat ? 'group' : 'single', chatid: chat, msgid });
test('single users are isolated, a group shares context across senders, and bots are namespaced', () => {
 assert.notEqual(identity('bot', body('a')).key, identity('bot', body('b')).key);
 assert.equal(identity('bot', body('a','group')).key, identity('bot', body('b','group')).key);
 assert.notEqual(identity('bot1',body('a','group')).key,identity('bot2',body('a','group')).key);
 assert.equal(identity('bot',body('a','group')).target,'group');
 assert.throws(()=>identity('bot',{from:{userid:'a'},chattype:'group',msgid:'x'}),/chatid/);
});
test('text, mixed media, quoted files and voice transcription are extracted without quote instructions', () => {
 const result=inbound({msgtype:'mixed',mixed:{msg_item:[{msgtype:'text',text:{content:'看这个'}},{msgtype:'image',image:{url:'https://example/image',aeskey:'key'}}]},quote:{msgtype:'file',file:{url:'https://example/file',aeskey:'key2'}}});
 assert.equal(result.text,'看这个');assert.equal(result.media.length,2);
 assert.equal(inbound({msgtype:'voice',voice:{content:'语音文字'}}).text,'语音文字');
 assert.throws(()=>inbound({msgtype:'video'}),/视频/);
 assert.throws(()=>inbound({msgtype:'mixed',mixed:{msg_item:Array.from({length:21},(_,i)=>({msgtype:'image',image:{url:`https://example/${i}`}}))}}),/20/);
});
test('UTF-8 splitting respects Chinese/emoji byte limits and file names are constrained', () => {
 const text='中文😀'.repeat(10000);const parts=splitUtf8(text);assert.ok(parts.length>1);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>Buffer.byteLength(p)<=18000));
 assert.equal(uploadName('../../标书.xlsx',Buffer.alloc(1)),'标书.xlsx');
 for (const extension of ['txt','JAVA','md','log','json','jsonl','csv','html','xml','yaml','py','js','ts']) assert.equal(uploadName(`notes.${extension}`,Buffer.from('UTF-8 文本')),`notes.${extension}`);
 assert.throws(()=>uploadName('old.xls',Buffer.alloc(1)),/旧版/);
 assert.equal(uploadName(undefined,Buffer.from('%PDF-1.0')),'wecom-1.pdf');
 const result=resultFromDone({messages:[{role:'assistant',text:'检索中',run:{id:'run'}},{role:'assistant',text:'最终回答，没有文件名',run:{id:'run'},outputs:[{id:'output'}]},{role:'assistant',text:'旧回答',run:{id:'old'}}]},'run');
 assert.equal(result.text,'最终回答，没有文件名');assert.equal(result.files[0].id,'output');
});
test('bridge config defaults off, validates multiple bot credentials and loopback API URL', () => {
 assert.deepEqual(bridgeConfig({},'/tmp'),{enabled:false});
 const env={WECOM_ENABLED:'true',WECOM_BOTS:JSON.stringify([{botId:'a',secret:'s'},{botId:'b',secret:'t'}])};
 assert.equal(bridgeConfig(env,'/tmp').bots.length,2);
 assert.equal(bridgeConfig({...env,FILE_MAX_BYTES:String(40*1024*1024)},'/tmp').maxFileBytes,30*1024*1024);
 assert.throws(()=>bridgeConfig({...env,WECOM_BOTS:'bad'},'/tmp'),/有效 JSON/);
 assert.throws(()=>bridgeConfig({...env,WECOM_BOTS:'[{"botId":"a","secret":"x"},{"botId":"a","secret":"y"}]'},'/tmp'),/唯一/);
 assert.throws(()=>new AgentApi('https://example.com','t'.repeat(64)),/本机/);
});
test('bounded downloader decrypts official AES format, rejects oversized streams before allocation', async () => {
 const original=globalThis.fetch;const data=Buffer.from('%PDF-1.0 测试');const key=randomBytes(32);const pad=32-data.length%32;const cipher=createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);const encrypted=Buffer.concat([cipher.update(Buffer.concat([data,Buffer.alloc(pad,pad)])),cipher.final()]);
 try {
  globalThis.fetch=async()=>new Response(encrypted,{headers:{'Content-Disposition':"attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.pdf"}});
  const file=await downloadMedia({url:'https://example.invalid/file',aeskey:key.toString('base64')},1024,1);assert.deepEqual(file.buffer,data);assert.equal(file.name,'测试.pdf');
  await assert.rejects(downloadMedia({url:'http://127.0.0.1/file'},100,1),/无效/);
  await assert.rejects(readBounded(new Response(Buffer.alloc(101)),100),/限制/);
  await assert.rejects(readBounded(new Response(Buffer.alloc(1),{headers:{'content-length':'101'}}),100),/限制/);
 } finally {globalThis.fetch=original;}
});
test('SSE parser handles fragmented UTF-8, heartbeat frames and structured output',async()=>{
 const bytes=Buffer.from('event: text\r\ndata: {"delta":"中文"}\r\n\r\n: heartbeat\r\n\r\nevent: done\r\ndata: {"failed":false}\r\n\r\n');
 const stream=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.subarray(i,i+7));c.close();}});const result=[];for await(const event of sse(stream))result.push(event);
 assert.deepEqual(result,[{event:'text',data:{delta:'中文'}},{event:'done',data:{failed:false}}]);
});
test('durable bridge store rejects duplicate processes and corrupt state without losing mappings',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-store-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const a=await new BridgeStore(directory).open();a.data.conversations.hello={sessionId:'session'};await a.save();
 await assert.rejects(new BridgeStore(directory).open(),/另一个/);await a.close();
 const b=await new BridgeStore(directory).open();assert.equal(b.data.conversations.hello.sessionId,'session');await b.close();
 assert.equal((await fs.stat(path.join(directory,'bridge-state.json'))).mode&0o777,0o600);
 if(process.platform==='linux'){await fs.writeFile(path.join(directory,'bridge.lock'),JSON.stringify({pid:process.pid,nonce:'old',marker:'previous-boot:0'}));const recovered=await new BridgeStore(directory).open();await recovered.close();}
 await fs.writeFile(path.join(directory,'bridge-state.json'),'corrupt');await assert.rejects(new BridgeStore(directory).open());assert.equal(await fs.readFile(path.join(directory,'bridge-state.json'),'utf8'),'corrupt');
});
test('shared run gate enforces capacity, bounds waiting and removes aborted jobs',async()=>{
 const gate=new RunGate(1,1);const a=new AbortController(), b=new AbortController();const release=await gate.acquire(a.signal);const pending=gate.acquire(b.signal);
 assert.deepEqual(gate.snapshot(),{active:1,waiting:1,limit:1,queueLimit:1});await assert.rejects(gate.acquire(new AbortController().signal),/queue/);
 b.abort();await assert.rejects(pending,/cancelled/);assert.equal(gate.snapshot().waiting,0);release();assert.equal(gate.snapshot().active,0);
});
