export const WELCOME = `Hi，我是 AI Patrick 🤖

我可以帮你：
📚 查询 UROVO 产品规格和技术资料
💬 解答日常工作问题

快捷命令：
/role 设置我的角色和回答风格
/clear 清空当前对话，保留角色设置

直接发送问题即可，无需输入命令。`;

export function rolePrompt(text) {
  return `请输入你希望我扮演的角色，以及偏好的回答风格。例如：

【销售产品助理】
你是销售团队的产品助理，帮助我解答产品问题、开展推广和销售。优先给出明确结论和支持依据，避免过多技术细节。信息不明确时，请说明不确定之处，并建议下一步怎么做。

【技术支持助理】
你是一个技术支持工程师，帮助我分析产品使用和故障排查问题。先给出可能原因，再按优先级提供具体排查步骤。区分已确认的信息和推测，不要编造产品参数。缺少关键信息时，先问我最必要的问题。

【日常工作助理】
你是我的日常工作助理，帮助我整理信息、撰写邮件、总结讨论和推进任务。回答简洁自然，先说重点，再给必要说明。涉及工作安排时，明确下一步行动和待确认事项；信息不足时直接指出，不要自行补充事实。

当前角色与风格：
${text ?? '未设置'}

请直接发送新的设置内容；输入“取消”保留原设置，输入“清除”恢复默认设置。`;
}

/** Recognize controls before inbound trimming, file downloads, or Agent capacity checks. */
export function commandInput(body, scope, userId) {
  const raw = body.msgtype === 'text' && typeof body.text?.content === 'string' ? body.text.content : undefined;
  const parts = [];
  const collect = value => {
    if (value?.msgtype === 'text' && typeof value.text?.content === 'string') parts.push(value.text.content);
    for (const item of value?.mixed?.msg_item ?? []) collect(item);
  };
  collect(body);
  const text = parts.join('\n').trim();
  if (text.startsWith('/clear') || text === '/new' || text === '新建对话') return { kind: 'reset' };
  if (text.startsWith('/role')) return { kind: 'open' };
  if (text.startsWith('/welcome')) return { kind: 'welcome' };
  if (scope.awaitingUser !== userId) return;
  if (raw === undefined || body.quote || !text || raw.length > 12000 || raw.includes('\0')) return { kind: 'notice', text: '请发送不超过 12000 个字符的非空纯文本角色设置，或输入“取消”或“清除”。' };
  if (text === '取消') return { kind: 'cancel' };
  if (text === '清除') return { kind: 'clearRole' };
  return { kind: 'set', text: raw };
}

export async function welcome(client, frame) {
  // The platform's enter_chat event is private-chat only; reject explicit group frames.
  if (frame.body?.chattype === 'group') return;
  await client.replyWelcome(frame, { msgtype: 'text', text: { content: WELCOME } });
}

export async function processControl(bridge, job) {
  const controller = new AbortController(); bridge.controllers.add(controller); bridge.jobControllers.set(job.id, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(bridge.config.timeoutMs)]);
  try {
    bridge.assertCurrent(job);
    if (job.state === 'delivering') { await bridge.deliver(job, signal); return; }
    const route = `/role?scope=${encodeURIComponent(job.key)}`;
    let text;
    switch (job.control.kind) {
      case 'welcome': text = WELCOME; break;
      case 'open': text = rolePrompt((await bridge.api.json(route, 'GET', undefined, signal)).text); break;
      case 'set':
        await bridge.api.json(route, 'PUT', { text: job.control.text }, signal);
        text = '角色与回答风格已更新。'; break;
      case 'clearRole':
        await bridge.api.json(route, 'DELETE', {}, signal);
        text = '已清除自定义角色与回答风格，恢复默认设置。'; break;
      case 'cancel': text = '已取消，原角色与回答风格保持不变。'; break;
      case 'notice': text = job.control.text; break;
      case 'reset': {
        // Persist the prior ID on admission, before deleting its mapping. A retry
        // after either process restarts can still stop the old backend run.
        for (const id of job.oldSessionIds ?? []) {
          try { await bridge.api.json(`/sessions/${id}/stop`, 'POST', {}, signal); }
          catch (error) { if (error.status !== 404) throw error; }
        }
        await bridge.active.get(job.key);
        await Promise.allSettled((job.cancelledJobIds ?? []).flatMap(id => [...(bridge.progress.get(id) ?? [])]));
        for (const id of job.cancelledJobIds ?? []) bridge.progress.delete(id);
        bridge.assertCurrent(job);
        if (!job.newSessionId) {
          const { id } = await bridge.api.json('/sessions', 'POST', {}, signal);
          job.newSessionId = id; await bridge.store.save();
        }
        await bridge.api.json(`/sessions/${job.newSessionId}`, 'PATCH', { title: `企微 · ${JSON.parse(job.key)[1] === 'group' ? `群 ${job.target}` : job.userId}`.slice(0, 80) }, signal);
        bridge.assertCurrent(job);
        bridge.store.data.conversations[job.key] = { sessionId: job.newSessionId, updated: Date.now(), pending: {} };
        text = '已清除当前的会话历史。'; break;
      }
    }
    bridge.assertCurrent(job);
    job.result = { text, files: [] }; job.state = 'delivering';
    await bridge.store.save(); await bridge.deliver(job, signal);
  } catch (error) {
    if (bridge.closing || !bridge.isCurrent(job)) return;
    // Idempotent role writes and persisted reset progress can safely retry. Do
    // not report success or allow later questions past a failed control.
    if (error.status >= 400 && error.status < 500 && ![409, 429].includes(error.status)) {
      job.result = { text: bridge.safeError(error), files: [] }; job.state = 'delivering';
    }
    job.retryAt = Date.now() + 5000;
    if (job.state !== 'delivering' && !job.commandFailureNotified) {
      await bridge.client(job.botId).replyStream(job.frame, job.streamId, '命令暂未完成，正在重试，请稍候。', false).catch(() => {});
      job.commandFailureNotified = true;
    }
    bridge.log.warn('WeCom command deferred:', bridge.safeError(error));
    await bridge.store.save();
  } finally { bridge.controllers.delete(controller); bridge.jobControllers.delete(job.id); }
}
