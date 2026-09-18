/**
 * CR-24（09-12 子2 review 批）：modelDisplayName 显示名三级回退序钉死——
 * 模型别名 → key.name / modelId（键在、模型缺或别名空）→ keyId / modelId（键失联）。
 * 失效条目宁可难看不可误导；回退序是通知条/当前模型 chip/终态徽标/链卡切换行四处
 * 共用单源（modelDisplay.ts），此处防回退序回归（缺模型错落 keyId 会把可读的
 * 供应商名换成机器 id）。
 */
import { describe, expect, it } from 'vitest';
import type { ApiKeyEntry, ModelConfig, ModelRef } from '@orison/shared-contracts';
import { fallbackKindLabelKey, modelDisplayName } from '../src/shared/model/modelDisplay';

const key: ApiKeyEntry = {
  id: 'key_001',
  name: '主中转',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  models: [
    { id: 'gpt-4o', alias: 'GPT 4o', capability: 'text', enabled: true },
    { id: 'no-alias-model', alias: '', capability: 'text', enabled: true },
  ],
};
const config: ModelConfig = { keys: [key] };

function ref(modelId: string, keyId = 'key_001'): ModelRef {
  return { keyId, modelId };
}

describe('modelDisplayName 三级回退（CR-24）', () => {
  it('模型在且别名非空 → 别名', () => {
    expect(modelDisplayName(config, ref('gpt-4o'))).toBe('GPT 4o');
  });

  it('模型在但别名为空 → key.name / modelId（供应商人话名，非 keyId）', () => {
    expect(modelDisplayName(config, ref('no-alias-model'))).toBe('主中转 / no-alias-model');
  });

  it('键在、模型缺（指派活得比模型久）→ key.name / modelId（非 keyId）', () => {
    expect(modelDisplayName(config, ref('deleted-model'))).toBe('主中转 / deleted-model');
  });

  it('键失联（键删/跨项目配置）→ keyId / modelId 原文', () => {
    expect(modelDisplayName(config, ref('gpt-4o', 'key_gone'))).toBe('key_gone / gpt-4o');
    expect(modelDisplayName(undefined, ref('gpt-4o'))).toBe('key_001 / gpt-4o');
  });

  it('无 ref → 空串', () => {
    expect(modelDisplayName(config, undefined)).toBe('');
  });
});

describe('fallbackKindLabelKey 分类前缀映射', () => {
  it('六类已知 kind → i18n key；未知 kind → 空串（调用方回显原文前缀）', () => {
    expect(fallbackKindLabelKey('quota: HTTP 429')).toBe('agent.fallbackKindQuota');
    expect(fallbackKindLabelKey('auth: bad key')).toBe('agent.fallbackKindAuth');
    expect(fallbackKindLabelKey('timeout: 60s')).toBe('agent.fallbackKindTimeout');
    expect(fallbackKindLabelKey('server: 502')).toBe('agent.fallbackKindServer');
    expect(fallbackKindLabelKey('network: fetch failed')).toBe('agent.fallbackKindNetwork');
    expect(fallbackKindLabelKey('config: key gone')).toBe('agent.fallbackKindConfig');
    expect(fallbackKindLabelKey('mystery: something')).toBe('');
  });
});
