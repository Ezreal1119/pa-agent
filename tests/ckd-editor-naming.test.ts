import assert from 'node:assert/strict';
import test from 'node:test';
import { operationSteps, suggestProcessName, fallbackName } from '../src/ckd/editor-naming.js';

test('name suggestion only uses operation steps and asks for a short verb-first name', async () => {
  const steps = '取PCBA，按方向放入治具，压紧。\n用镊子把FPC排线插入连接器，压紧卡扣。';
  let request: { system: string; prompt: string; maxTokens?: number } | undefined;
  const model = {
    async complete(input: { system: string; prompt: string; maxTokens?: number }) {
      request = input;
      return { text: '{"name":"装FPC并压紧"}' };
    }
  };
  const result = await suggestProcessName(model, steps, AbortSignal.timeout(5000));
  assert.equal(result.source, 'model');
  assert.equal(result.name, '装FPC并压紧');
  assert.match(request!.prompt, /取PCBA/u);
  assert.match(request!.prompt, /FPC排线/u);
  assert.doesNotMatch(request!.prompt, /自检/u, '不能把自检带进总结');
  assert.doesNotMatch(request!.prompt, /工序检查/u, '不能把工序检查带进总结');
  assert.match(request!.system, /8–12 个汉字/u);
  assert.equal(request!.maxTokens, 120);
});

test('name suggestion strips quotes and punctuation', async () => {
  const model = { async complete() { return { text: '"装主板锁螺丝。"' }; } };
  const result = await suggestProcessName(model, '锁螺丝', AbortSignal.timeout(5000));
  assert.equal(result.name, '装主板锁螺丝');
});

test('name suggestion falls back to the first step when the model fails', async () => {
  const model = { async complete() { throw new Error('model down'); } };
  const result = await suggestProcessName(model, '检查来料有没有刮花；取PCBA放入治具。', AbortSignal.timeout(5000));
  assert.equal(result.source, 'fallback');
  assert.ok(result.name.length > 0);
  assert.equal(result.name, fallbackName('检查来料有没有刮花；取PCBA放入治具。'));
  assert.equal(operationSteps(['第一段', '', ' 第二段 ']), '第一段\n第二段');
});
