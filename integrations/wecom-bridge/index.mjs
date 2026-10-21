import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import AiBot from '@wecom/aibot-node-sdk';
import { bridgeConfig } from './config.mjs';
import { AgentApi } from './api.mjs';
import { BridgeStore } from './store.mjs';
import { WecomBridge } from './bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv({ path: path.join(root, '.env'), quiet: true });
let bridge, runtimeConfig;
try {
  const config = bridgeConfig(process.env, root); runtimeConfig = config;
  if (!config.enabled) console.log('WeCom Bridge disabled (WECOM_ENABLED=false).');
  else {
    const api = new AgentApi(config.apiUrl, config.token, config.timeoutMs);
    // Stay connected to WeCom during independent Product Expert upgrades.
    // Authentication errors still require repairing the configured API token.
    try { await api.json('/status', 'GET', undefined, AbortSignal.timeout(3000)); }
    catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
      console.warn('Product Agent API is unavailable; Bridge remains online during the upgrade.');
    }
    const store = await new BridgeStore(config.directory).open();
    const clients = new Map();
    const redact = value => {
      let text = String(value);
      for (const secret of [config.token, ...config.bots.map(bot => bot.secret)]) text = text.split(secret).join('[REDACTED]');
      return text;
    };
    const logger = { debug() {}, info(message) { console.log(redact(message)); }, warn(message) { console.warn(redact(message)); }, error(message) { console.error(redact(message)); } };
    for (const bot of config.bots) clients.set(bot.botId, new AiBot.WSClient({ botId: bot.botId, secret: bot.secret, maxReconnectAttempts: -1, logger }));
    bridge = new WecomBridge({ config, store, api, clients }); await bridge.start();
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (closing) return; closing = true;
      void bridge.close().then(() => { process.exitCode = 0; }).catch(() => { console.error('WeCom Bridge shutdown failed.'); process.exitCode = 1; });
    });
    for (const [botId, client] of clients) {
      client.on('authenticated', () => { console.log(`WeCom authenticated: ${botId}`); bridge.authenticated(botId); });
      client.on('disconnected', () => { bridge.disconnected(botId); });
      client.on('error', error => {
        console.error('WeCom connection:', redact(error.message));
        // Invalid credentials have a bounded SDK retry budget; let systemd recover after repair.
        if (error.code === 'WS_AUTH_FAILURE_EXHAUSTED') { void bridge.close().finally(() => { process.exitCode = 1; }); }
      });
      // Entering a chat is silent; respond only to user messages.
      for (const type of ['text', 'image', 'file', 'mixed', 'voice', 'video']) client.on(`message.${type}`, frame => {
        void bridge.receive(botId, frame).catch(error => console.error('WeCom receive:', bridge.safeError(error)));
      });
      client.connect();
    }
  }
} catch (error) {
  let message = error.message;
  for (const secret of [process.env.WECOM_API_TOKEN, process.env.WECOM_BOT_SECRET, ...(runtimeConfig?.bots ?? []).map(bot => bot.secret)]) if (secret) message = message.split(secret).join('[REDACTED]');
  console.error('WeCom Bridge startup failed:', message);
  if (bridge) await bridge.close();
  process.exitCode = 1;
}
