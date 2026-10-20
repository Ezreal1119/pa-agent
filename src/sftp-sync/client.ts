import { Client, type SFTPWrapper, type Stats } from 'ssh2';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { SftpConfig } from './config.js';

export interface RemoteClient {
  stat(p: string): Promise<Stats>;
  read(p: string): Readable;
  close(): void;
}
export function hostFingerprint(key: Buffer) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}
export function connect(config: SftpConfig, signal: AbortSignal): Promise<RemoteClient> {
  return new Promise((resolve, reject) => {
    const client = new Client(); let ready = false, closed = false; let sftp: SFTPWrapper;
    const fail = (error: Error) => { if (!ready) {reject(error);close();} };
    const abort = () => { fail(new Error('Import stopped.')); client.destroy(); };
    const close = () => { if (closed) return; closed = true; signal.removeEventListener('abort', abort); client.destroy(); };
    if (signal.aborted) { reject(new Error('Import stopped.')); return; }
    signal.addEventListener('abort', abort, {once:true});
    client.on('error', fail);
    client.on('close', () => { signal.removeEventListener('abort', abort); if (!ready) reject(new Error('SFTP connection closed before ready.')); });
    client.on('ready', () => client.sftp((error, channel) => {
      if (error) { reject(error); close(); return; }
      ready = true; sftp = channel;
      resolve({
        stat: p => new Promise((ok, bad) => sftp.lstat(p, (err, stat) => err ? bad(err) : ok(stat))),
        read: p => sftp.createReadStream(p, {highWaterMark: 128 * 1024}),
        close,
      });
    }));
    try {
      client.connect({host:config.host,port:config.port,username:config.username,password:config.password,
        ...(config.legacyKex ? {algorithms:{kex:{append:['diffie-hellman-group14-sha1'],prepend:[],remove:[]}}} : {}),
        readyTimeout:config.timeoutMs,keepaliveInterval:10000,keepaliveCountMax:2,
        hostVerifier: (key: Buffer) => {
          if (hostFingerprint(key) === config.fingerprint) return true;
          reject(Object.assign(new Error('SFTP host fingerprint mismatch. Verify the server key before changing SFTP_HOST_FINGERPRINT.'),{code:'HOST_KEY_MISMATCH'}));
          return false;
        }});
    } catch(e) { reject(e); close(); }
  });
}
