import type { ApiKeyEntry, ModelProtocol, ModelRef, NovelModelRuntime } from '@orison/shared-contracts';

export type NovelTextModelOption = {
  ref: ModelRef;
  label: string;
  /** 该模型所属 key 的协议形态——CLI 选项在指派面带「无工具调用」标识。 */
  protocol: ModelProtocol;
};

/**
 * 已启用 text 模型清单。CLI 键（antigravity-cli）默认排除：本清单的历史消费者
 * （NovelModelSelector / resolveNovelModelRuntime）撑的是 NovelModelRuntime 的 HTTP
 * 运行时（baseUrl/apiKey 直连），CLI 形态不在那条路上。`includeCli` 供任务档指派面
 *（ModelAssignmentSections）开启——CLI 模型经 gateway resolveModel 分派到协议层 CLI
 * 驱动，不走 NovelModelRuntime。
 */
export function listNovelTextModelRefs(
  keys: ApiKeyEntry[],
  opts: { includeCli?: boolean } = {},
): NovelTextModelOption[] {
  const out: NovelTextModelOption[] = [];
  for (const key of keys) {
    if (key.protocol === 'antigravity-cli' && opts.includeCli !== true) continue;
    for (const model of key.models) {
      if (!model.enabled || model.capability !== 'text') continue;
      out.push({
        ref: { keyId: key.id, modelId: model.id },
        label: `${key.name} - ${model.alias}`,
        protocol: key.protocol,
      });
    }
  }
  return out;
}

export function resolveNovelModelRuntime(
  keys: ApiKeyEntry[],
  preferredRef: ModelRef | null,
): NovelModelRuntime | null {
  const options = listNovelTextModelRefs(keys);
  const selected = preferredRef
    ? options.find((opt) => opt.ref.keyId === preferredRef.keyId && opt.ref.modelId === preferredRef.modelId)?.ref
    : options[0]?.ref;
  if (!selected) return null;

  const key = keys.find((entry) => entry.id === selected.keyId);
  const model = key?.models.find((entry) => entry.id === selected.modelId);
  if (!key || !model || !model.enabled || model.capability !== 'text') return null;
  // CLI 键无 HTTP 凭据（listNovelTextModelRefs 默认已滤，此处类型/运行时双守卫——
  // preferredRef 直指 CLI 模型时在此落 null，不构造残缺运行时）。
  if (key.protocol === 'antigravity-cli' || !key.baseUrl || !key.apiKey) return null;
  return {
    keyId: key.id,
    modelId: model.id,
    baseUrl: key.baseUrl,
    apiKey: key.apiKey,
  };
}
