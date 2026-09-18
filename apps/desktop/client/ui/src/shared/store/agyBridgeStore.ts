import { create } from 'zustand';
import type {
  AgyBridgeConsentState,
  AgyBridgeStatusView,
  ModelConfig,
} from '@orison/shared-contracts';
import { fetchAgyBridgeStatus } from '../api/agyBridge';

// ── agy MCP 工具桥：UI 侧模块级 store（09-12 子4 W6，design §4.3/§8）──
//
// 持有两块机器级瞬态（无项目态、无 push 事件——slice 三要件一个不占，mirror
// confirmStore/toastStore 的模块 store 先例，不进 appStore 组装）：
//   - `status`：最近一次 `agy-bridge:status` 读面（状态机四态 + 冲突规则 + 副本根路径）。
//     刷新点 = App 启动 / 同意对话框打开 / 同意或关闭写后回显 / 设置页小节挂载。
//     shell 侧每次现读（用户手改 agy settings 即时反映）——本缓存只是 UI 派生用快照，
//     敏感操作前组件自行重拉，不把它当权威。
//   - `ask`：知情同意对话框的待答请求（agent 对话流 `agy_bridge_consent|` 前缀错误事件
//     转来；App 级对话框据此挂载）。declined 不进 ask——已拒绝是用户的既定选择
//     （AC6：降级纯文本，不再征询）。
//
// 本模块零 appStore/agentEvents import（防循环：agentEvents → 本 store 单向）。

/** 同意对话框待答态（错误事件前缀解析产物）。 */
export type AgyBridgeConsentAsk = {
  state: 'missing-consent' | 'conflict';
  conflicts: string[];
};

type AgyBridgeState = {
  status: AgyBridgeStatusView | null;
  ask: AgyBridgeConsentAsk | null;
  setStatus: (view: AgyBridgeStatusView | null) => void;
  /** 状态面刷新（App 启动 / 对话框打开 / 设置页挂载；失败保持原值不覆盖）。 */
  refreshStatus: () => Promise<AgyBridgeStatusView | null>;
  openAsk: (ask: AgyBridgeConsentAsk) => void;
  closeAsk: () => void;
};

export const useAgyBridgeStore = create<AgyBridgeState>((set) => ({
  status: null,
  ask: null,
  setStatus: (view) => set({ status: view }),
  refreshStatus: async () => {
    const view = await fetchAgyBridgeStatus();
    if (view !== null) set({ status: view });
    return view;
  },
  openAsk: (ask) => set({ ask }),
  closeAsk: () => set({ ask: null }),
}));

/** 测试复位。 */
export function __resetAgyBridgeStoreForTest(): void {
  useAgyBridgeStore.setState({ status: null, ask: null });
}

// ── 错误前缀解析（agent AgyBridgeConsentRequiredError 的机器可读形态）──

/** 前缀错误可承载的全部同意态（含 declined——turn 硬门三态全发，CR-27）。 */
export type AgyBridgeConsentErrorState = 'missing-consent' | 'conflict' | 'declined';

export const AGY_BRIDGE_CONSENT_ERROR_PREFIX = 'agy_bridge_consent|';

/** decodeURIComponent 容错壳（坏转义序列不得炸事件分发——按原文回退）。 */
function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * `agy_bridge_consent|state=<state>`（conflict 另附 `|rules=<rule;rule...>`）前缀解析。
 * 非 admitted 形态返回 null（按普通错误处理）——前缀族之外的错误不误吞。
 * mirror shell 侧 project_run_active|heldBy= 结构化拒绝族的消费形态。
 * rules 逐条 encodeURIComponent（CR-7——用户规则原文可含 '|' / ';' 分隔符，未编码则
 * 此处按分隔符切开 = round-trip 损坏）；解码坏转义序列按原文回退（分发面不炸）。
 */
export function parseAgyBridgeConsentError(
  message: string,
): { state: AgyBridgeConsentErrorState; conflicts: string[] } | null {
  if (!message.startsWith(AGY_BRIDGE_CONSENT_ERROR_PREFIX)) return null;
  const parts = message.slice(AGY_BRIDGE_CONSENT_ERROR_PREFIX.length).split('|');
  const statePart = parts[0] ?? '';
  if (!statePart.startsWith('state=')) return null;
  const state = statePart.slice('state='.length);
  if (state !== 'missing-consent' && state !== 'conflict' && state !== 'declined') return null;
  const rulesPart = parts.find((p) => p.startsWith('rules='));
  const conflicts = rulesPart !== undefined
    ? rulesPart.slice('rules='.length).split(';').filter((r) => r.length > 0).map(safeDecodeURIComponent)
    : [];
  return { state, conflicts };
}

// ── 「桥车道在跑」UI 派生（「桥」徽标数据源）──

/**
 * 会话对话车道当前是否经桥运行的 UI 派生（纯函数）。桥车道判定真源在 shell
 * （protocol + 同意态 + 桥面），UI 不重复 lane resolver 全逻辑——用**充分条件组**：
 * 同意态 ok 且对话档模型（activeModel ?? 档位指派）是 CLI 协议 → 桥徽标可见。
 * 近似边界（文档化接受）：对话档未显式指派（default 哨兵解析不出协议）或桥面为空的
 * 极端情形下徽标缺省不显示——徽标是可辨识性标注非正确性断言（design §8「可选」）。
 */
export function deriveBridgeLaneActive(input: {
  modelConfig: ModelConfig | undefined;
  taskDialogue: { keyId?: string; modelId?: string } | undefined;
  activeModel: { keyId: string; modelId: string } | undefined;
  consentState: AgyBridgeConsentState | undefined;
}): boolean {
  if (input.consentState !== 'ok') return false;
  const ref = input.activeModel
    ?? (input.taskDialogue?.keyId && input.taskDialogue?.modelId ? input.taskDialogue : undefined);
  if (ref === undefined || ref.keyId === 'default') return false;
  const key = input.modelConfig?.keys.find((k) => k.id === ref.keyId);
  return key?.protocol === 'antigravity-cli';
}
