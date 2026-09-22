import type { ModelConfig, ModelRef } from '@orison/shared-contracts';

/**
 * 09-12 子2 fallback chains：模型引用 → 人话显示名（「回退通知/当前模型 chip/终态徽标/
 * 链卡切换行」四处单源）。key 名 → 模型别名（缺别名回落 modelId）；查无（键删/跨项目
 * 配置）回落 `keyId / modelId` 原文——失效条目宁可难看不可误导（mirror 设置页 stale 先例）。
 */
export function modelDisplayName(modelConfig: ModelConfig | undefined, ref: ModelRef | undefined): string {
  if (!ref) return '';
  const key = modelConfig?.keys.find((k) => k.id === ref.keyId);
  if (!key) return `${ref.keyId} / ${ref.modelId}`;
  const model = key.models.find((m) => m.id === ref.modelId);
  return model?.alias && model.alias.length > 0 ? model.alias : `${key.name} / ${ref.modelId}`;
}

/**
 * 回退分类摘要 → 短标签 i18n key（classifyGenerationFailure 的 reason 形态 `kind: detail`，
 * 取 kind 前缀映射；未知 kind 原样回显——未来新增分类不炸 UI）。
 */
export function fallbackKindLabelKey(reason: string): string {
  const kind = reason.split(':')[0]?.trim() ?? '';
  switch (kind) {
    case 'auth': return 'agent.fallbackKindAuth';
    case 'quota': return 'agent.fallbackKindQuota';
    case 'timeout': return 'agent.fallbackKindTimeout';
    case 'server': return 'agent.fallbackKindServer';
    case 'network': return 'agent.fallbackKindNetwork';
    case 'config': return 'agent.fallbackKindConfig';
    // CR-10（c3-2 CR 批）：熔断跳家（trace/事件 reason 前缀 `circuit-open:`）与预算
    // 硬线（classifyGenerationFailure 新 kind）两回退 kind 补齐人话标签。
    case 'circuit-open': return 'agent.fallbackKindCircuitOpen';
    case 'budget': return 'agent.fallbackKindBudget';
    default: return '';
  }
}
