import path from 'node:path';
import { FILE_EXTENSIONS } from '../../dist/file-tools/config.js';

export const DAY = 86400000;
export function identity(botId, body) {
  if (!body?.from?.userid || !body.msgid || !['single', 'group'].includes(body.chattype)) throw new Error('企微消息缺少用户、消息 ID 或会话类型。');
  const target = body.chattype === 'group' ? body.chatid : body.from.userid;
  if (!target) throw new Error('群消息缺少 chatid。');
  return { key: JSON.stringify([botId, body.chattype, target]), target, userId: body.from.userid, msgid: body.msgid, botId };
}
export function inbound(body) {
  const texts = [], media = [];
  const collect = (value, quote = false) => {
    if (!value) return;
    if (!quote && value.msgtype === 'text' && typeof value.text?.content === 'string') texts.push(value.text.content);
    if (!quote && value.msgtype === 'voice' && typeof value.voice?.content === 'string') texts.push(value.voice.content);
    for (const kind of ['image', 'file']) if (value[kind]?.url) media.push({ kind, url: value[kind].url, aeskey: value[kind].aeskey });
    for (const item of value.mixed?.msg_item ?? []) collect(item, quote);
  };
  if (body.msgtype === 'video') throw new Error('暂不支持视频，请发送 PDF、DOCX、PPTX、XLSX、图片或 UTF-8 纯文本文件。');
  collect(body); collect(body.quote, true);
  const unique = [...new Map(media.map(item => [item.url, item])).values()];
  if (unique.length > 20) throw new Error('一次最多接收 20 个附件。');
  const text = texts.join('\n').trim();
  if (text.length > 12000) throw new Error('问题最多 12000 个字符。');
  if (!text && !unique.length) throw new Error('请发送文字问题或文件。');
  return { text, media: unique };
}
export function splitUtf8(text, limit = 18000) {
  const result = []; let part = '', size = 0;
  for (const char of String(text)) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > limit && part) { result.push(part); part = ''; size = 0; }
    part += char; size += bytes;
  }
  if (part) result.push(part);
  return result;
}
export function uploadName(name, buffer, index = 1) {
  let filename = path.posix.basename(String(name ?? '').replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(-180);
  if (!filename) {
    const ext = buffer.subarray(0, 4).toString() === '%PDF' ? '.pdf' : buffer.subarray(0, 4).equals(Buffer.from([137,80,78,71])) ? '.png' : buffer[0] === 255 && buffer[1] === 216 ? '.jpg' : buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP' ? '.webp' : '';
    if (!ext) throw new Error('未取得有效文件名，请重新上传带原始文件名的附件。');
    filename = `wecom-${index}${ext}`;
  }
  if (!FILE_EXTENSIONS.has(path.extname(filename).toLowerCase())) throw new Error('支持 PDF、DOCX、PPTX、XLSX、图片和 TXT/MD/LOG/JAVA/JSON/CSV/HTML/XML/YAML/PY/JS/TS 等 UTF-8 纯文本；暂不支持旧版 DOC/PPT/XLS 或可执行文件。');
  return filename;
}
export function resultFromDone(done, runId, seenOutputs = []) {
  const messages = (done.messages ?? []).filter(item => item.role === 'assistant' && item.run?.id === runId);
  const files = new Map(seenOutputs.map(file => [file.id, file]));
  for (const message of messages) for (const file of message.outputs ?? []) files.set(file.id, file);
  const text = messages.findLast(item => item.text)?.text ?? '';
  return { text: text || (done.failed ? '本轮未能完成，请稍后重试。' : files.size ? '文件已生成，请查收。' : '本轮没有生成文字回答。'), files: [...files.values()] };
}
