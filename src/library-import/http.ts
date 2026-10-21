import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export class ImportError extends Error {
  constructor(message: string, readonly fatal = false, readonly retryable = false) { super(message); }
}
const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked.addSubnet(ip,bits,'ipv4');
// Only global-unicast IPv6 is accepted; also exclude transition/documentation ranges.
for (const [ip,bits] of [['2001::',32],['2001:2::',48],['2001:10::',28],['2001:20::',28],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) blocked.addSubnet(ip,bits,'ipv6');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
function publicIP(ip: string, family: number) { return family === 4 ? !blocked.check(ip,'ipv4') : global6.check(ip,'ipv6') && !blocked.check(ip,'ipv6'); }
export async function publicUrl(value: string, signal?: AbortSignal) {
  let url: URL; try {url=new URL(value);} catch {throw new ImportError('Invalid download URL.');}
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || /[\x00-\x20\x7f]/.test(value)) throw new ImportError('Only public HTTPS URLs on port 443 without credentials are accepted.');
  signal?.throwIfAborted();
  const addresses = isIP(host) ? [{address:host,family:isIP(host)}] : await new Promise<{address:string;family:number}[]>((resolve,reject)=>{
    const cancel=()=>reject(signal?.reason || new Error('Cancelled DNS lookup.'));
    signal?.addEventListener('abort',cancel,{once:true});
    void dns.lookup(host,{all:true,verbatim:true}).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',cancel));
    if(signal?.aborted)cancel();
  });
  if (!addresses.length || addresses.some(a=>!publicIP(a.address,a.family))) throw new ImportError('URL resolves to a non-public network address.');
  return {url, address:addresses[0]!};
}
/** Pin the validated DNS address for this connection; do not let a second lookup rebind it. */
export async function request(value: string, signal: AbortSignal, headers: Record<string,string> = {}, redirects = 0): Promise<IncomingMessage> {
  const {url,address}=await publicUrl(value,signal); signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    // Some public file origins reject Node's default request without a User-Agent.
    // Keep this default separate from explicit headers so anonymous redirects still work.
    const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0',...headers},signal,agent:false,lookup:((_host: string, options: {all?: boolean}, callback: (...args: any[])=>void)=> options?.all ? callback(null,[address]) : callback(null,address.address,address.family)) as any},res=>{
      const status=res.statusCode || 0;
      if (status>=300 && status<400) {
        res.destroy();
        // Authenticated API requests must never follow a redirect, even on the same host.
        if (Object.keys(headers).length || !res.headers.location || redirects>=5) return reject(new ImportError('Unexpected or excessive HTTP redirect.'));
        let next:string;try{next=new URL(res.headers.location,url).href;}catch{return reject(new ImportError('Invalid redirect URL.'));}
        void request(next,signal,{},redirects+1).then(resolve,reject);return;
      }
      if (status<200 || status>=300) {res.destroy();return reject(new ImportError(`Remote HTTP ${status}.`,status===401 || status===403,status===408 || status===429 || status>=500));}
      if (res.headers['content-encoding'] && res.headers['content-encoding']!=='identity') {res.destroy();return reject(new ImportError('Encoded download responses are not supported.'));}
      resolve(res);
    });
    req.setTimeout(30000,()=>req.destroy(new ImportError('Remote connection timed out.',false,true)));
    req.on('error',reject);
  });
}
export async function jsonRequest(value: string, password: string | undefined, signal: AbortSignal): Promise<any> {
  const res=await request(value,signal,password?{'X-Admin-Password':password}:{});
  const chunks:Buffer[]=[];let size=0;
  try {for await(const chunk of res){size+=chunk.length;if(size>32*1024*1024)throw new ImportError('Upstream JSON exceeds 32 MiB.');chunks.push(Buffer.from(chunk));}}
  finally {res.destroy();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ImportError('Upstream returned invalid JSON.');}
}
export function transient(error:unknown) {
  const e=error as NodeJS.ErrnoException & {cause?:NodeJS.ErrnoException};
  return error instanceof ImportError ? error.retryable : e.name==='TimeoutError' || ['ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN','ENOTFOUND','EPIPE','ERR_STREAM_PREMATURE_CLOSE','UND_ERR_CONNECT_TIMEOUT'].includes(e.code || e.cause?.code || '');
}
export async function retry<T>(fn: (attempt:number)=>Promise<T>, signal:AbortSignal):Promise<T> {
  for(let attempt=1;;attempt++)try{return await fn(attempt);}catch(e){if(signal.aborted || attempt>=3 || !transient(e))throw e;await delay(attempt*1000,undefined,{signal});}
}

/** Normalize a local deadline into a retryable error, without retrying administrator cancellation. */
export async function deadline<T>(signal:AbortSignal, milliseconds:number, fn:(timed:AbortSignal)=>Promise<T>):Promise<T> {
  const timeout=AbortSignal.timeout(milliseconds),timed=AbortSignal.any([signal,timeout]);
  try{return await fn(timed);}catch(error){if(!signal.aborted && timeout.aborted)throw new ImportError('Operation exceeded its time limit.',false,true);throw error;}
}
