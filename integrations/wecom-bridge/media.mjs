import { decryptFile } from '@wecom/aibot-node-sdk';
import { readBounded } from './api.mjs';
import { uploadName } from './protocol.mjs';

/** Bound encrypted bytes before buffering; use the official SDK's AES implementation. */
export async function downloadMedia(media, maxBytes, index, signal) {
  const url = new URL(media.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('企微附件下载地址无效。');
  const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]) });
  if (!response.ok) throw new Error('企微附件下载失败或已过期，请重新上传。');
  const encrypted = await readBounded(response, maxBytes + 32);
  const buffer = media.aeskey ? decryptFile(encrypted, media.aeskey) : encrypted;
  if (buffer.length > maxBytes) throw new Error('附件超过单文件上传限制。');
  const disposition = response.headers.get('content-disposition') ?? '';
  const raw = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? disposition.match(/filename="([^"]+)"|filename=([^;]+)/i)?.slice(1).find(Boolean);
  let name; try { name = raw && decodeURIComponent(raw.trim()); } catch {}
  return { buffer, name: uploadName(name, buffer, index) };
}
