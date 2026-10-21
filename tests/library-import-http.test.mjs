// Simulated HTTP fixtures only; no DNS, network, model or real download is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { request } from '../dist/library-import/http.js';

function transport(t, responses) {
  const calls=[];
  t.mock.method(https,'get',(url,options,callback)=>{
    calls.push({url:url.href,options});
    const response=responses.shift();
    assert(response,'Unexpected request.');
    const req=new EventEmitter();req.setTimeout=()=>req;
    queueMicrotask(()=>callback(Object.assign(Readable.from([]),response)));
    return req;
  });
  return calls;
}

test('library public download supplies User-Agent on the initial request and each redirect without credentials',async t=>{
  const calls=transport(t,[{statusCode:302,headers:{location:'https://1.0.0.1/final.pdf'}},{statusCode:200,headers:{'content-type':'application/pdf'}}]);
  const response=await request('https://1.1.1.1/file.pdf',new AbortController().signal);
  try{
    assert.equal(calls.length,2);
    for(const {options} of calls){
      assert.equal(options.headers['User-Agent'],'Mozilla/5.0');
      assert.deepEqual(Object.keys(options.headers),['User-Agent']);
      assert.equal(options.headers['X-Admin-Password'],undefined);
      assert.equal(options.headers.Authorization,undefined);
    }
    assert.equal(calls[1].url,'https://1.0.0.1/final.pdf');
    calls[1].options.lookup('ignored.example',{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'1.0.0.1',family:4}]);});
  }finally{response.destroy();}
});

test('library authenticated API redirect is still rejected without forwarding its password',async t=>{
  const calls=transport(t,[{statusCode:302,headers:{location:'https://1.0.0.1/file.pdf'}}]);
  await assert.rejects(()=>request('https://1.1.1.1/api/sync-reports',new AbortController().signal,{'X-Admin-Password':'fixture-secret'}),/redirect/);
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.headers['User-Agent'],'Mozilla/5.0');
  assert.equal(calls[0].options.headers['X-Admin-Password'],'fixture-secret');
});

test('library public redirects still reject a private-network destination',async t=>{
  const calls=transport(t,[{statusCode:302,headers:{location:'https://127.0.0.1/file.pdf'}}]);
  await assert.rejects(()=>request('https://1.1.1.1/file.pdf',new AbortController().signal),/non-public/);
  assert.equal(calls.length,1);
});
