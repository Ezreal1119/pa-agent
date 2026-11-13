import { DAY } from './protocol.mjs';

export const QUESTION_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const notificationRecipient = (config, botId) => config.bots.find(bot => bot.botId === botId)?.notifyUserId ?? config.notifyUserId;
export const canReadDetails = (config, requester) => JSON.parse(requester.key)[1] === 'single' && Boolean(notificationRecipient(config, requester.botId)) && requester.userId === notificationRecipient(config, requester.botId);
const states = { running: '正在回答（以下为当前已输出内容）', completed: '已完成', failed: '回答失败', stopped: '已停止', interrupted: '已中断' };

/** The UUID identifies one admitted question, never the conversation's latest answer. */
export async function questionDetail(bridge, requester, id, signal) {
  const recipient = notificationRecipient(bridge.config, requester.botId);
  if (!canReadDetails(bridge.config, requester))
    return '此命令仅供当前机器人的消息通知接收账号在私聊中使用。';
  if (typeof id !== 'string' || !QUESTION_UUID.test(id)) return '用法：/patrick_detail <问题 UUID>，请复制新消息通知中的查询命令。';
  const source = bridge.store.data.jobs.find(job => job.id === id && job.botId === requester.botId && job.detailRecipient === recipient);
  if (!source || source.created < Date.now() - 30 * DAY) return '未找到该问题，或记录已过期。请使用当前机器人通知中的问题 UUID。';
  const heading = `问题 UUID：${id}`;
  if (!source.runId || !source.sessionId) {
    const notice = source.detailNotice ?? source.result?.text;
    return `${heading}\n${notice || (source.state === 'done' ? '该提问未产生 Agent 回答，可能已取消或仅发送了附件。' : source.state === 'recovering' ? '运行连接中断，尚未确认该次回答记录；没有自动重新执行，请稍后再查。' : '问题正在接收附件或排队，Agent 尚未开始回答，请稍后再次查询。')}`;
  }
  try {
    const result = await bridge.api.json(`/sessions/${source.sessionId}/runs/${source.runId}/detail`, 'GET', undefined, signal);
    if (!Object.hasOwn(states, result?.status) || typeof result.answer !== 'string') throw new Error('回答查询返回格式不正确。');
    return `${heading}\n状态：${states[result.status]}\n\n${result.answer || (result.status === 'running' ? '尚未输出回答正文，请稍后再次查询。' : '本次没有生成回答正文。')}`;
  } catch (error) {
    if (signal.aborted) throw error;
    return `${heading}\n${error.status === 404 ? '对应的回答记录已删除、过期或不可用。' : `查询暂未完成：${bridge.safeError(error)} 请稍后重新发送命令。`}`;
  }
}
