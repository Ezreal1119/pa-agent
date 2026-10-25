import path from 'node:path';

function number(value, fallback, min, max, name) {
  const result = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be ${min}–${max}.`);
  return result;
}
export function bridgeConfig(env, cwd) {
  if (!['true', 'false', undefined, ''].includes(env.WECOM_ENABLED)) throw new Error('WECOM_ENABLED must be true or false.');
  const enabled = env.WECOM_ENABLED === 'true';
  if (!enabled) return { enabled: false };
  let bots;
  try { bots = env.WECOM_BOTS ? JSON.parse(env.WECOM_BOTS) : [{ botId: env.WECOM_BOT_ID, secret: env.WECOM_BOT_SECRET }]; }
  catch { throw new Error('WECOM_BOTS 不是有效 JSON，请检查格式。'); }
  if (!Array.isArray(bots) || !bots.length || bots.length > 20 || bots.some(bot => !bot || typeof bot.botId !== 'string' || !bot.botId.trim() || typeof bot.secret !== 'string' || !bot.secret.trim()) || new Set(bots.map(bot => bot.botId)).size !== bots.length) throw new Error('请配置唯一的 WECOM_BOT_ID / WECOM_BOT_SECRET，或 WECOM_BOTS JSON 数组。');
  const notifyUserId = env.WECOM_NOTIFY_USER_ID?.trim() || '';
  for (const value of [notifyUserId, ...bots.map(bot => bot.notifyUserId ?? '')]) if (typeof value !== 'string' || value.length > 256 || /[\s\u0000-\u001f\u007f]/.test(value)) throw new Error('WECOM_NOTIFY_USER_ID / notifyUserId 必须是有效的企微用户标识。');
  const dataDir = path.resolve(cwd, env.AGENT_DATA_DIR || '.data');
  return { enabled, bots, notifyUserId, balanceNotifications: Boolean(notifyUserId), dataDir, directory: path.join(dataDir, 'wecom'), apiUrl: env.WECOM_AGENT_URL || `http://127.0.0.1:${env.WEB_PORT || 4321}`, token: env.WECOM_API_TOKEN,
    concurrency: number(env.WECOM_MAX_CONCURRENT_RUNS, 2, 1, 8, 'WECOM_MAX_CONCURRENT_RUNS'),
    queueLimit: number(env.WECOM_QUEUE_LIMIT, 8, 1, 100, 'WECOM_QUEUE_LIMIT'),
    maxFileBytes: Math.min(number(env.FILE_MAX_BYTES, 30 * 1024 * 1024, 1, Number.MAX_SAFE_INTEGER, 'FILE_MAX_BYTES'), 30 * 1024 * 1024),
    timeoutMs: number(env.WECOM_RUN_TIMEOUT_MS, 15 * 60000, 10000, 60 * 60000, 'WECOM_RUN_TIMEOUT_MS') };
}
