import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export async function verify(file:string,extension:string,signal:AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,['--max-old-space-size=384',fileURLToPath(new URL('./verify-worker.js',import.meta.url)),file,extension],{stdio:['ignore','ignore','pipe'],signal});
    let error='';child.stderr.on('data',chunk=>{error=(error+chunk.toString()).slice(-2000);});
    const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('close',(code,sig)=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Document integrity check failed${sig?` (${sig})`:''}: ${error || 'invalid, encrypted or resource limit exceeded'}`));});
  });
}
