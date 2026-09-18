import type { AgentMessage } from '../../shared/store/agentSlice';
import { parseChildTag } from './toolMeta';
import { childTagPrefix } from '../../shared/store/agentStreamBuffer';
import { isChildGroupDispatchActive } from '../../shared/store/agentEvents';

/**
 * Story 3.5 Step 8: pure message-stream grouping for the agent panel.
 *
 * Two layers, strictly ordered:
 * 1. Batch grouping — **contract field** (`AgentMessage.batchId`, stamped by
 *    the runtime's pure code, never by the LLM). Consecutive messages sharing
 *    a batchId collapse into one `<BatchGroup>`. Messages WITHOUT a batchId
 *    (old sessions, user replies, child events) render flat in between — V1
 *    accepts the group/gap split. NOT a text regex — that's the ChildExecution
 *    Group content-prefix debt we deliberately do not replicate.
 * 2. Child-tag grouping — the pre-existing `[skill:role:dN]` / `[subagent:role]`
 *    content-prefix parse (3.3 debt, unchanged). Runs on the non-batch runs at
 *    the top level AND inside a batch group's body (nested execution).
 *
 * Report messages (`batchKind === 'report'`, the anchor-closing L0 panorama)
 * never join a batch group: the group is collapsed by default and the L0 text
 * must stay visible below the group (design §5.2 — L0 is the leader's closing
 * message itself).
 */

export type SingleGroup = { type: 'single'; message: AgentMessage };
export type ChildGroupModel = {
  type: 'child-group';
  source: 'skill' | 'subagent';
  role: string;
  depth: number;
  messages: AgentMessage[];
};
export type BatchGroupModel = { type: 'batch'; batchId: string; messages: AgentMessage[] };
export type MessageGroup = SingleGroup | ChildGroupModel | BatchGroupModel;
/** What `groupChildTags` can produce (no batch layer — used inside batch bodies). */
export type ChildTagOrSingleGroup = SingleGroup | ChildGroupModel;

/**
 * Pre-existing child-tag grouping (content-prefix regex, 3.3 debt — unchanged
 * behavior, extracted so BatchGroup bodies can reuse the nested render path).
 */
export function groupChildTags(messages: AgentMessage[]): ChildTagOrSingleGroup[] {
  const groups: ChildTagOrSingleGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const tag = parseChildTag(msg.content ?? '');
    if (!tag) {
      groups.push({ type: 'single', message: msg });
      i++;
      continue;
    }
    const batch: AgentMessage[] = [msg];
    let j = i + 1;
    while (j < messages.length) {
      const nextTag = parseChildTag(messages[j].content ?? '');
      if (!nextTag || nextTag.source !== tag.source || nextTag.role !== tag.role || nextTag.depth !== tag.depth) break;
      batch.push(messages[j]);
      j++;
    }
    if (batch.length >= 2) {
      groups.push({ type: 'child-group', source: tag.source, role: tag.role, depth: tag.depth, messages: batch });
    } else {
      groups.push({ type: 'single', message: msg });
    }
    i = j;
  }
  return groups;
}

/**
 * Top-level grouping: consecutive same-batchId progress messages → batch
 * groups; everything else (report messages, untagged messages, child runs)
 * flows through the existing child-tag/single logic unchanged. Old messages
 * without batchId render exactly as before (backward compatible).
 */
export function groupMessages(messages: AgentMessage[]): MessageGroup[] {
  const out: MessageGroup[] = [];
  // Consecutive non-batch messages pending child-tag grouping.
  let run: AgentMessage[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    out.push(...groupChildTags(run));
    run = [];
  };
  for (const msg of messages) {
    const batchId = msg.batchId;
    if (batchId && msg.batchKind !== 'report') {
      // Only EXTEND the previous group when nothing intervened (consecutive
      // semantics — a user reply or a no-batchId message in between starts a
      // new group even for the same batchId; V1 accepts the split).
      const last = out[out.length - 1];
      if (!(run.length === 0 && last && last.type === 'batch' && last.batchId === batchId)) {
        flushRun();
        out.push({ type: 'batch', batchId, messages: [] });
      }
      (out[out.length - 1] as BatchGroupModel).messages.push(msg);
      continue;
    }
    run.push(msg);
  }
  flushRun();
  return out;
}

/**
 * Per batch, the id of the LAST report-kind assistant message — the anchor-
 * closing L0 panorama `<BatchReportCard>` attaches to (exactly one card per
 * batch).
 *
 * end_batch flips the stamp to 'report' mid-turn, so every message emitted
 * after it in the same turn also carries batchKind='report' (the end_batch
 * tool result, intermediate assistant texts with further tool calls). Naively
 * attaching a card to every report message renders duplicates — this selects
 * the single attach point: the final assistant report message (the L0 text
 * itself, which is the turn's last message).
 */
export function lastReportMessageByBatch(messages: AgentMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.batchKind === 'report' && m.batchId) {
      map.set(m.batchId, m.id);
    }
  }
  return map;
}

// ── dogfood T1 Stage 5（design §6.4/§7.3/§7.4，D5）：子 agent 组活跃派生 ──

// ── dogfood T1 CR-T1-041：runtime 合成 user 消息过滤（重试钮载荷） ──

/**
 * Runtime 注入的合成 user 消息内容前缀（agent 包 loop.ts 两处——length 续写指令与
 * present_result 打回提醒；后者不发 UI 事件但会随 done 对账 fetch 入 store）。合成
 * 标记方案需 agent 包 + 持久化面改动（CR 明示不做），UI 侧按内容前缀特征过滤。
 */
const SYNTHETIC_USER_PREFIXES: readonly string[] = [
  'Continue from where you left off.',
  '你停下来向用户呈现结果前，必须先调用 present_result 工具',
];

/** 是否 runtime 合成 user 消息（按内容前缀特征——见 SYNTHETIC_USER_PREFIXES）。 */
export function isSyntheticUserContent(content: string | undefined | null): boolean {
  if (!content) return false;
  return SYNTHETIC_USER_PREFIXES.some((p) => content.startsWith(p));
}

/**
 * 重试钮载荷（CR-T1-041）：末条**真人** user 消息内容。length 续写注入的
 * 'Continue from where you left off...' 经对账入 store 后，末条 user 可能是内部
 * 指令——重试钮重发它 = 用户答非所问；扫尾时跳过合成消息取更早的真人消息。
 * CR-P2（09-13 稳定化 CR 批）：kind='session_state_note' 同跳——状态注记是 user-role
 * 系统广播且恒垫在 turn 尾（错误轮末条就是它），不跳 = 重试钮把整段快照当作者输入重发。
 */
export function lastRetryableUserContent(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (m.kind === 'session_state_note') continue;
    if (isSyntheticUserContent(m.content)) continue;
    return m.content;
  }
  return null;
}

/** 组「当前动作」：N = 组内 tool 消息计数，工具名 = 最新 tool 消息的最新 toolResult 名。 */
export type ChildGroupAction = {
  step: number;
  toolName?: string;
};

/**
 * 组头部「第 N 步 · 工具名」的纯派生（design §6.4）。工具名取 toolResult 的
 * toolName/toolId 原文（渲染侧经 toolMeta 的 toolLabel 映射翻译——dogfood #38）。
 */
export function childGroupAction(messages: AgentMessage[]): ChildGroupAction {
  let step = 0;
  let toolName: string | undefined;
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    step += 1;
    const results = m.toolResults ?? [];
    const last = results[results.length - 1];
    if (last) toolName = last.toolName ?? last.toolId ?? toolName;
  }
  return { step, toolName };
}

/** 活跃 child 角色组（面板头部聚合徽标的 chip 数据源）。 */
export type ChildActivityRole = { source: 'skill' | 'subagent'; role: string };

/** 面板头部聚合徽标数据（design §7.4：图标 + 角色 chip 组 + 「第 N 步」摘要）。 */
export type ChildActivitySummary = {
  roles: ChildActivityRole[];
  /** 「第 N 步」取最活跃（最近一个）活跃组的 tool 步数。 */
  step: number;
  toolName?: string;
};

/** 组内是否有 streaming 占位（live 信号——组级活跃判定的「正在生成」位）。 */
export function hasLivePlaceholder(messages: AgentMessage[]): boolean {
  return messages.some((m) => m.streaming === true);
}

/**
 * 从消息流派生活跃 child 组（design §6.4 面板头部徽标 + ChildExecutionGroup 活跃判定共用
 * 语义）。dogfood T1 CR-T1-036：活跃判定升级为**整次派发级**——live 占位在，或 leader run
 * 在途且该组在迟滞窗内有 child 事件（agentEvents 按 tag 维度记录；child 多 turn 间隙占位
 * 翻转不再把徽标打 null / 误发完成）。复用 groupChildTags 的连续段分组（分组键 = 前缀
 * source/role/depth——childSessionId 不参与，既有 3.3 分组债的既成语义）。无活跃组
 * 返回 null（徽标空即无，不占位）。
 */
export function deriveChildActivity(
  messages: AgentMessage[],
  leaderRunning: boolean = false,
): ChildActivitySummary | null {
  const active: ChildGroupModel[] = [];
  for (const g of groupChildTags(messages)) {
    if (g.type !== 'child-group') continue;
    const tag = childTagPrefix({ source: g.source, role: g.role, depth: g.depth });
    if (isChildGroupDispatchActive(tag, hasLivePlaceholder(g.messages), leaderRunning)) {
      active.push(g);
    }
  }
  if (active.length === 0) return null;
  const roles: ChildActivityRole[] = [];
  for (const g of active) {
    if (!roles.some((r) => r.source === g.source && r.role === g.role)) {
      roles.push({ source: g.source, role: g.role });
    }
  }
  // 「最活跃组」= 最近一个（消息流尾部）——正在推进的那个。
  const action = childGroupAction(active[active.length - 1].messages);
  return { roles, ...action };
}
