import type { ModelConfig } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { deriveBridgeLaneActive, useAgyBridgeStore } from '../../shared/store/agyBridgeStore';

/**
 * 「桥车道在跑」hook（09-12 子4 W6，design §8「桥」徽标数据源）——会话对话车道
 * 当前经桥运行 = 同意态 ok 且对话档模型（activeModel ?? 档位指派）是 CLI 协议
 * （充分条件组派生，纯函数见 agyBridgeStore.deriveBridgeLaneActive——近似边界在那里
 * 文档化：徽标是可辨识性标注非正确性断言）。子代理消息在消费侧用 childTag 排除
 * （桥只接 dialogue leader 车道，R6）。
 */
export function useAgyBridgeLaneActive(): boolean {
  const modelConfig = useAppStore((s) => s.modelConfig as ModelConfig | undefined);
  const sessionId = useAppStore((s) => s.agentSessionId);
  const activeModel = useAppStore((s) =>
    sessionId !== null ? s.activeModelBySession[sessionId] : undefined,
  );
  const consentState = useAgyBridgeStore((s) => s.status?.state);
  const taskDialogue = modelConfig?.taskModels?.dialogue;
  return deriveBridgeLaneActive({ modelConfig, taskDialogue, activeModel, consentState });
}
