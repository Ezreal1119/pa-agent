import test from 'node:test';
import assert from 'node:assert/strict';
import {balanceCommand,formatLibraryResult} from '../dist/web/wecom-commands.js';
const signal=()=>new AbortController().signal;
const balance={is_available:true,balance_infos:[{currency:'CNY',total_balance:'110.00',granted_balance:'10.00',topped_up_balance:'100.00'},{currency:'USD',total_balance:'0.00',granted_balance:'0.00',topped_up_balance:'0.00'}]};

test('balance uses official fixed GET, exact bearer, no request body, and preserves reported amounts/currencies',async()=>{
 const text=await balanceCommand('private-key',signal(),{request:async(url,init)=>{
  assert.equal(url,'https://api.deepseek.com/user/balance');assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer private-key');assert.equal(init.body,undefined);assert.equal(init.redirect,'error');return Response.json(balance);
 }});
 assert.match(text,/CNY：110.00/);assert.match(text,/赠送余额：10.00/);assert.match(text,/充值余额：100.00/);assert.match(text,/USD：0.00/);assert.ok(!text.includes('private-key'));
 assert.match(await balanceCommand('key',signal(),{request:async()=>Response.json({...balance,is_available:false})}),/当前不可用/);
});

test('balance missing key, upstream errors, malformed/oversize data, timeout and cancellation fail honestly once without leaking provider body',async()=>{
 let calls=0;await assert.rejects(balanceCommand('',signal(),{request:async()=>{calls++;}}),/DEEPSEEK_API_KEY/);assert.equal(calls,0);
 for(const status of [301,401,429,503])await assert.rejects(balanceCommand('secret',signal(),{request:async()=>{calls++;return new Response('secret private provider detail',{status});}}),error=>error.message.includes(`HTTP ${status}`)&&!error.message.includes('secret'));
 assert.equal(calls,4);
 for(const data of [null,[],{}, {is_available:true,balance_infos:[]},{...balance,balance_infos:[{...balance.balance_infos[0],total_balance:'secret'}]}])await assert.rejects(balanceCommand('secret',signal(),{request:async()=>Response.json(data)}),/格式不正确/);
 await assert.rejects(balanceCommand('key',signal(),{request:async()=>new Response('bad json')}),/格式不正确/);
 await assert.rejects(balanceCommand('key',signal(),{request:async()=>new Response('small',{headers:{'content-length':'16385'}})}),/大小限制/);
 let cancelled=false;await assert.rejects(balanceCommand('key',signal(),{request:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(16385));},cancel(){cancelled=true;}}))}),/大小限制/);assert.equal(cancelled,true);
 const controller=new AbortController();controller.abort();await assert.rejects(balanceCommand('key',controller.signal,{request:async()=>{throw new Error('must not call');}}),/已取消/);
 const wait=async(_url,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});
 const keepAlive=setTimeout(()=>{},1000);try{await assert.rejects(balanceCommand('key',signal(),{request:wait,timeoutMs:5}),/超时/);}finally{clearTimeout(keepAlive);}
 await assert.rejects(balanceCommand('key',signal(),{request:async()=>{throw new TypeError('secret network');}}),/无法连接/);
});

test('library rendering preserves every usable returned URL, labels alternatives and treats metadata only as text',()=>{
 const url='https://files.example/a(b).zip?token=a%2Bb&x=1';
 const text=formatLibraryResult({outcome:'matched',matches:[{name:'<@all> [evil](https://evil.example)',url,comment:'SDK'},{name:'manual.pdf',url:'https://files.example/manual.pdf'}, {url:'javascript:alert(1)'},{url:'https://user:pass@files.example/x'},{url:'https://files.example/<@all>'}]});
 assert.ok(text.includes(url));assert.match(text,/manual.pdf/);assert.match(text,/^1\. /m);assert.match(text,/^2\. manual.pdf$/m);assert.doesNotMatch(text,/^3\. /m);assert.ok(!text.includes('<@all>'));assert.ok(!text.includes('javascript:'));assert.ok(!text.includes('user:pass'));
 assert.match(formatLibraryResult({outcome:'no_match',matches:[{name:'candidate',url}]}),/仅为相关候选/);
 assert.match(formatLibraryResult({outcome:'no_match',matches:[]}),/未返回可用/);
 assert.match(formatLibraryResult({matches:[{url}]}),/候选文件/);
});
