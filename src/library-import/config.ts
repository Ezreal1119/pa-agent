import { SyncError } from '../knowledge-sync/core.js';

export interface LibraryConfig { baseUrl: string; password: string }
export const MAX_BYTES = 100 * 1024 * 1024;
export const RESERVE_BYTES = 256 * 1024 * 1024;
export const EXTENSIONS = new Set(['.pdf', '.pptx', '.xlsx', '.docx']);
export function libraryConfig(env: Record<string, string | undefined>): LibraryConfig {
  return {baseUrl: (env.LIBRARY_IMPORT_BASE_URL || '').trim().replace(/\/+$/, ''), password: env.LIBRARY_IMPORT_ADMIN_PASSWORD || ''};
}
export function missingConfig(config: LibraryConfig) {
  return [!config.baseUrl && 'LIBRARY_IMPORT_BASE_URL', !config.password && 'LIBRARY_IMPORT_ADMIN_PASSWORD'].filter(Boolean) as string[];
}
export function checkBase(config: LibraryConfig) {
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new SyncError('LIBRARY_IMPORT_BASE_URL must be an HTTPS origin on port 443 without credentials, path or query.');
  return url.origin;
}
