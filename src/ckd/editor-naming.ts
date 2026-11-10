import type { LibraryModel } from './library-model.js';

/**
 * 根据各图片坑位里的「操作步骤」生成工序名。
 * 工序检查、自检、工具、物料都不参与总结，避免名字被检查项带偏。
 */

const SYSTEM_PROMPT = [
  '你是电子制造 SOP 录入助手。只根据用户给出的「操作步骤」概括工序名：',
  '- 8–12 个汉字，动词开头，动宾结构；',
  '- 重复动作可以用 *N（例如 POGOPIN打钉*3）；',
  '- 不要标点、引号、解释，不要带“工序”二字。',
  '参考命名：POGOPIN打钉*3、装主板锁螺丝、合底壳，锁底壳螺丝。',
  '不要参考工序检查、自检、工具或物料信息。',
  '只输出 JSON：{"name":"..."}'
].join('\n');

export interface NameSuggestion { name: string; source: 'model' | 'fallback' }

export function operationSteps(paragraphs: unknown[]): string {
  return paragraphs
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean)
    .join('\n');
}

function cleanName(text: string): string {
  let value = text.trim();
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { name?: unknown }).name === 'string') {
      value = (parsed as { name: string }).name;
    }
  } catch {
    // 模型没按 JSON 返回时，直接当纯文本处理。
  }
  value = value.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/gu, '')
    .replace(/[，。；、,.!?！？]/gu, '')
    .replace(/^工序名[:：]\s*/u, '')
    .trim();
  return value.slice(0, 20);
}

/** 没有模型或模型失败时的兜底：取第一段步骤的前 12 个字。 */
export function fallbackName(steps: string): string {
  const first = steps.split(/[；;。\n]/u)[0] ?? '';
  return first
    .replace(/^(用|将|把)/u, '')
    .replace(/[，,、\s]/gu, '')
    .slice(0, 12);
}

export async function suggestProcessName(
  model: Pick<LibraryModel, 'complete'>,
  steps: string,
  signal: AbortSignal
): Promise<NameSuggestion> {
  try {
    const result = await model.complete({
      purpose: 'translate',
      system: SYSTEM_PROMPT,
      prompt: `操作步骤：\n${steps}\n请给出工序名。`,
      json: true,
      maxTokens: 120
    }, signal);
    const name = cleanName(result.text);
    if (name) return { name, source: 'model' };
  } catch {
    // 模型不可用时退回规则截取，不影响用户继续录入。
  }
  return { name: fallbackName(steps), source: 'fallback' };
}
