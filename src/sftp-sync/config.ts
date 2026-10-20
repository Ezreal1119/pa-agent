import path from 'node:path';
import { SyncError } from '../knowledge-sync/core.js';

export interface SftpConfig {
  host: string; port: number; username: string; password: string; fingerprint: string;
  pathsFile: string; timeoutMs: number; fileTimeoutMs: number; attempts: number;
  maxBytes: number; reserveBytes: number; legacyKex: boolean;
}
export function sftpConfig(cwd: string, dataDir: string, env: Record<string, string | undefined>): SftpConfig {
  const number = (name: string, fallback: number, min: number, max: number) => {
    const n = Number(env[name] || fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new SyncError(`Invalid ${name}.`);
    return n;
  };
  return {
    host: (env.SFTP_HOST || '').trim(), port: number('SFTP_PORT', 22, 1, 65535),
    username: (env.SFTP_USERNAME || '').trim(), password: env.SFTP_PASSWORD || '',
    fingerprint: (env.SFTP_HOST_FINGERPRINT || '').trim(),
    pathsFile: path.resolve(cwd, env.SFTP_PATHS_FILE || path.join(dataDir, 'sftp_sync_paths.jsonl')),
    timeoutMs: number('SFTP_CONNECT_TIMEOUT_MS', 20000, 100, 120000),
    fileTimeoutMs: number('SFTP_FILE_TIMEOUT_MS', 600000, 100, 3600000),
    attempts: number('SFTP_MAX_ATTEMPTS', 3, 1, 5), maxBytes: 100 * 1048576,
    reserveBytes: number('SFTP_DISK_RESERVE_BYTES', 256 * 1048576, 0, 10 * 1024 ** 3),
    legacyKex: env.SFTP_LEGACY_KEX === 'true',
  };
}
export function missingConfig(config: SftpConfig) {
  return ['host', 'username', 'password', 'fingerprint'].filter(k => !config[k as keyof SftpConfig])
    .map(k => ({host:'SFTP_HOST',username:'SFTP_USERNAME',password:'SFTP_PASSWORD',fingerprint:'SFTP_HOST_FINGERPRINT'})[k]);
}
export const allowedExtensions = new Set(['.pdf','.docx','.xlsx','.pptx','.png','.jpg','.jpeg','.webp','.txt','.md']);
export function validateRemotePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value) || value.split('/').slice(1).some(p => !p || p === '.' || p === '..'))
    throw new SyncError('path must be an absolute SFTP file path without traversal or control characters.');
  const name = path.posix.basename(value);
  if (name.startsWith('.') || /^(?:README|SKILL|MEMORY|MEMORY_EXTRA|SYNC|SYNC_PROMPT)\.md$/i.test(name) || !allowedExtensions.has(path.posix.extname(name).toLowerCase()))
    throw new SyncError('Unsupported or reserved incoming filename. Use PDF, DOCX, XLSX, PPTX, images, TXT or Markdown.');
  return value;
}
export function parsePaths(text: string) {
  const entries: { path: string; line: number; error?: string }[] = [], seen = new Set<string>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length > 10000) throw new SyncError('The JSONL list exceeds 10000 lines.');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 1 || !Object.hasOwn(item, 'path')) throw new Error('Each line accepts only {"path":"/remote/file"}.');
      const p = validateRemotePath(item.path);
      if (seen.has(p)) continue;
      seen.add(p); entries.push({path:p, line:index+1});
    } catch (e) {
      // Never echo invalid JSON: a misplaced credential must not enter reports.
      entries.push({path:'',line:index+1,error:e instanceof SyntaxError ? 'Invalid JSON.' : (e as Error).message});
    }
  }
  if (!entries.length) throw new SyncError('The JSONL list contains no paths.');
  return entries;
}
