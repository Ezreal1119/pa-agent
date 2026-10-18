import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {splitUtf8, DAY} from './protocol.mjs';

const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replace(/[\\`*_{}\[\]()#!|]/g,'\\$&');
const clock = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function notificationText(entry, name) {
  const lines=['🔔 Product Expert 收到一条新消息','',`对话人：${escape(name || entry.userId)}`,`类型：${entry.chatType==='group'?'群聊':'私聊'}`];
  if(entry.chatType==='group')lines.push(`群聊：${escape(entry.chatId)}`);
  lines.push(`时间：${clock.format(new Date(entry.at))}`,'',...(entry.text || '（仅发送附件）').split('\n').map(line=>`> ${escape(line)}`));
  if(entry.attachments?.length)lines.push('',`附件：${entry.attachments.map(escape).join('、')}`);
  return lines.join('\n');
}
export function notificationInput(body) {
  const texts=[],attachments=[];
  const visit=(value,quoted=false)=>{
    if(!value || typeof value!=='object')return;
    if(!quoted && typeof value.text?.content==='string')texts.push(value.text.content);
    if(!quoted && typeof value.voice?.content==='string')texts.push(value.voice.content);
    for(const [kind,label] of [['file','文件'],['image','图片'],['video','视频']])if(value[kind]?.url)attachments.push(String(value[kind].filename||value[kind].name||label).slice(0,180));
    for(const item of (Array.isArray(value.mixed?.msg_item)?value.mixed.msg_item:[]))visit(item,quoted);
  };
  visit(body);visit(body?.quote,true);
  return{text:texts.join('\n').slice(0,12000),attachments:attachments.slice(0,20)};
}

/** Durable observation + notification outbox. Its delivery never occupies an Agent slot. */
export class MessageObserver {
  constructor({directory,api,clients,isConnected,recipientFor,log=console,now=Date.now}){
    Object.assign(this,{api,clients,isConnected,recipientFor,log,now});this.file=path.join(directory,'message-events.json');this.entries=[];this.writes=Promise.resolve();this.closed=false;
  }
  async open(){
    try{
      const stat=await fs.lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024)throw new Error('Invalid message event outbox.');
      const data=JSON.parse(await fs.readFile(this.file,'utf8'));if(data.version!==1||!Array.isArray(data.entries))throw new Error('Invalid message event outbox.');this.entries=data.entries;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    this.lastPrune=this.now();if(this.prune())await this.save();
    this.timer=setInterval(()=>this.pump(),1000);this.timer.unref?.();this.pump();return this;
  }
  save(){
    const work=this.writes.then(async()=>{
      const temporary=`${this.file}.${randomUUID()}.tmp`;
      try{const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify({version:1,entries:this.entries}));await handle.sync();}finally{await handle.close();}await fs.rename(temporary,this.file);}finally{await fs.rm(temporary,{force:true});}
    });this.writes=work.catch(()=>{});return work;
  }
  prune(){
    let changed=false;
    for(const entry of this.entries)if(!entry.done && entry!==this.current && entry.at<this.now()-30*DAY){entry.done=this.now();for(const key of ['text','attachments','parts','notifyTo','ready'])delete entry[key];changed=true;}
    const count=this.entries.length;
    const completed=new Set(this.entries.filter(e=>e.done && e.done>=this.now()-7*DAY).slice(-10000));
    this.entries=this.entries.filter(e=>!e.done || completed.has(e));
    return changed || count!==this.entries.length;
  }
  async enqueue(who,input){
    if(this.closed || this.entries.some(e=>e.botId===who.botId && e.msgid===who.msgid))return;
    this.prune();
    if(this.entries.filter(e=>!e.done).length>=500){this.log.warn('WeCom notification/identity queue full; incoming chat continues.');return;}
    const target=this.recipientFor(who.botId);
    const notifyTo=target && who.userId!==target ? target : undefined;
    const [,chatType,chatId]=JSON.parse(who.key);
    const entry={botId:who.botId,userId:who.userId,msgid:who.msgid,chatType,...(chatType==='group'?{chatId}:{}),at:this.now(),...(notifyTo?{notifyTo,text:input.text,attachments:input.attachments,ready:!input.attachments.length}:{}),sent:0,attempts:0};
    this.entries.push(entry);await this.save();this.pump();
  }
  async attachments(botId,msgid,names){
    const entry=this.entries.find(e=>e.botId===botId&&e.msgid===msgid);
    if(!entry || entry.done || entry.parts || !entry.notifyTo)return;
    entry.attachments=names;entry.ready=true;await this.save();this.pump();
  }
  pump(){
    if(this.closed)return;
    if(this.now()-this.lastPrune>=3600000){this.lastPrune=this.now();if(this.prune())void this.save().catch(error=>this.log.warn('WeCom event cleanup:',error.message));}
    if(this.active)return;
    const heads=new Map();for(const entry of this.entries)if(!entry.done&&!heads.has(entry.botId))heads.set(entry.botId,entry);
    const entry=[...heads.values()].find(e=>(e.retryAt??0)<=this.now()&&(!e.notifyTo||this.isConnected(e.botId))&&(!e.notifyTo||e.ready||e.at+5000<=this.now()));
    if(!entry)return;
    this.current=entry;
    this.active=this.deliver(entry).catch(error=>{entry.retryAt=this.now()+15000;this.log.warn('WeCom observer storage:',error.message);}).finally(()=>{this.active=undefined;this.current=undefined;this.pump();});
  }
  async deliver(entry){
    this.controller=new AbortController();
    try{
      if(entry.at < this.now()-30*DAY){entry.done=this.now();for(const key of ['text','attachments','parts','notifyTo','ready'])delete entry[key];await this.save();return;}
      const contact=await this.api.json('/contacts','POST',{botId:entry.botId,userId:entry.userId,chatType:entry.chatType,...(entry.chatId?{chatId:entry.chatId}:{}),at:entry.at},AbortSignal.any([this.controller.signal,AbortSignal.timeout(3000)]));
      if(this.closed)return;
      const target=this.recipientFor(entry.botId);
      // Reconfiguration takes effect on unsent notifications too; never send old work to another recipient.
      if(entry.notifyTo && target===entry.notifyTo && entry.userId!==target){
        if(!entry.parts){entry.parts=splitUtf8(notificationText(entry,contact.contact?.name));await this.save();}
        for(let index=entry.sent;index<entry.parts.length;index++){
          if(this.closed)return;
          await this.clients.get(entry.botId).sendMessage(entry.notifyTo,{msgtype:'markdown',markdown:{content:entry.parts[index]}});
          entry.sent=index+1;await this.save();
        }
      }
      entry.done=this.now();for(const key of ['text','attachments','parts','notifyTo','ready'])delete entry[key];await this.save();
    }catch(error){
      if(this.closed)return;
      if(!entry.sent)delete entry.parts;
      entry.attempts++;entry.retryAt=this.now()+Math.min(300000,5000*2**Math.min(entry.attempts-1,6));
      this.log.warn('WeCom notification/identity deferred:',error.name==='AbortError'||error.name==='TimeoutError'?'API timeout':error.message);await this.save();
    }finally{this.controller=undefined;}
  }
  async idle(timeout=10000){
    const deadline=Date.now()+timeout;
    while(this.active||this.entries.some(e=>!e.done&&!(e.retryAt>this.now()))){if(Date.now()>deadline)throw new Error('Observer idle timeout');await new Promise(r=>setTimeout(r,10));}
    await this.writes;
  }
  async close(){this.closed=true;clearInterval(this.timer);this.controller?.abort();await this.active;await this.writes;}
}
