// ─────────────────────────────────────────────────────────────────────────────
// 09-13 子3 W2（design §2）：写作页运行时间线（chainTimelineBySession）。
//
// 写章链事件的**累积式**时间线（子2 交接契约：resume done 帧重放 / artifact 帧不重放 →
// 累积消费无洞，不重建）。与 chainRunBySession（ChainRunCard 数据源）平级——本模块是
// 新消费面，ChainRunCard 零扰动。
//
// 核心语义：
// - **attempt 锚 = 到达序（append-only）**：同 nodeId 多 entry 按到达序即圈序——环重跑
//   seq 同 run 不变（跨 run 才 +1），不能作 attempt 锚（design F6 定谳）；seq 字段只用于
//   辨新 run 的流。同 attempt 的 artifact 覆写重发（through verdict）取末帧。
// - **正文流文本不进 timeline**（streamText 是当前流唯一源；历史圈正文只显产出摘要——
//   终稿全文在审阅卡，量控不双存）。text 通道 delta 只参与 run 边界判定，不积累。
// - **reasoning 走模块级 pending 缓冲 + 250ms 节流 flush**（chain-delta 高频，直写 = 每帧
//   entries 全量复制——mirror chainStreamBuffer 的 flushTimer 模式）；tool/artifact/done
//   低频事件直写。
// - **量控三层**：per-segment cap = REASONING_TAIL_CAP 数值（从 chainStreamBuffer import——
//   只复用数值不复用机制：链缓冲是 per-session 单槽尾窗，本模块是全量历史 + 会话总量 cap）；
//   会话总量 cap 256K，超则丢最旧 segment（LRU）；全局 reasoning 预算 2M chars（CR-19 分层
//   保留——超限从旧终态链起只清 reasoning 文本，仍超限丢最旧终态链；活跃/观察链不降级）。
// - **paused 窗口跳过**：run status paused 期间到达的 reasoning delta 不积累（mirror 链缓冲
//   CR-21 口径——审阅等待期思考不假滚动）。
// - **终态与新 run**：终态保留 entries（回看）；`runEnded` 标记后首条链事件 = 新 run →
//   重置（mirror chainStreamBuffer TERMINAL_STATUSES 语义——completed/error/aborted 终态、
//   paused 非终态 resume 续同链）。ended 标记由哨兵帧 / finalize（done/error 兜底）写入：
//   不读 peer chainRunBySession.status 判边界（reasoning 车道不翻 run 态——reasoning-first
//   新 run 会被反复误判重置）。escalateFindingsBySession[sid] 随新 run 重置同点失效（CR-3）。
// - **清理**：forgetChainTimeline / 会话删除同点清理（防跨 run 泄漏，mirror
//   forgetChainRunBuffer 调用点）。
//
// escalate findings 路由（design §2.2 / F5）也住本文件：escalate-pause 非 stage pause、不产
// pausedReview——裁决卡数据源只能走独立键 escalateFindingsBySession（leader 消息 tool
// metadata 松散通道 + resume IPC summary fallback 两路写入）。
// ─────────────────────────────────────────────────────────────────────────────

import { REVIEW_ATTRIBUTION_VALUES } from '@orison/shared-contracts';
import {
  CHAIN_RUN_SENTINEL_NODE_ID,
  REASONING_TAIL_CAP,
  type ChainNodeArtifactSummary,
  type ChainToolEventData,
} from './chainStreamBuffer';

// ── 数据结构（design §2.1） ──

/**
 * 时间线单节点 entry（append-only——每 attempt 一 entry，到达序即圈序）。
 */
export type TimelineNodeEntry = {
  nodeId: string;
  /** 流式轮次计数快照（同 run 环重跑不变；跨 run redo +1——辨新 run，非 attempt 锚）。 */
  seq: number;
  status: 'running' | 'done' | 'error' | 'blocked';
  /**
   * chain-node-artifact 产出快照（五 kind）。同 attempt 覆写重发（through verdict）取末帧；
   * 历史 attempt 各持自己的帧（append-only）。
   */
  summary?: ChainNodeArtifactSummary;
  tools: ChainToolEventData[];
  reasoning: Array<{ messageId: string; phase?: string; text: string }>;
  at: number;
};

/**
 * 单会话时间线。`runEnded` 是新 run 重置判据（哨兵终态 / finalize 兜底写入——design §2.1
 * 「同 session 终态后首条链事件 = 新 run → 重置」所需的终态记忆；终态期间 entries 保留回看，
 * 重置发生在下一 run 首条链事件时）。
 */
export type ChainTimelineState = {
  sessionId: string;
  entries: TimelineNodeEntry[];
  runEnded?: boolean;
  updatedAt: number;
};

/**
 * escalate findings 单条（防御投影后的视图——agent 侧 EscalateFinding 的 mirror 形态；
 * severity 二值 + grounding 三字段非空是硬要求，坏条目在投影层单独丢弃）。
 */
export type EscalateFindingsItem = {
  subClass?: string;
  severity: 'block' | 'warn';
  quote: string;
  location: string;
  explanation: string;
  attribution?: (typeof REVIEW_ATTRIBUTION_VALUES)[number];
};

/**
 * escalate findings 路由缓存条目（metadata.findings 松散通道形态）。items 空 = 「已审核」
 * 锚点（mirror write-chapter.ts 空 findings 仍附——后续空审核结果让旧卡降级）。
 *
 * CR-13：source/route 可选——resume IPC fallback 通道在 summary 无可推断字段（routeDecision /
 * planEscalate 都缺）时不造数据省略两键；metadata 通道两键恒在（extract 侧枚举校验）。
 */
export type EscalateFindingsEntry = {
  source?: 'reader-audit' | 'plan-review';
  route?: string;
  chapterId?: string;
  items: EscalateFindingsItem[];
  at: number;
};

/**
 * 时间线写回所需的 store 结构面（appStore 的 AppState 结构满足；结构性类型避免
 * appStore ↔ timeline 循环 import，mirror chainStreamBuffer 的 ChainBufferState 模式）。
 * 三键全 optional——最小测试 store 可缺省（缺省 = 时间线/escalate 不写，事件不炸）；
 * chainRunBySession 读侧只用于 paused 窗口跳过判定。
 */
export type ChainTimelineStateFace = {
  chainTimelineBySession?: Record<string, ChainTimelineState>;
  escalateFindingsBySession?: Record<string, EscalateFindingsEntry>;
  chainRunBySession?: Record<string, { status: string }>;
  /**
   * 写作页观察链指针（writingPageSlice——CR-19 全局量控保护面：当前观察链不降级）。
   * 缺省 = 无观察链（最小测试 store 可缺省）。
   */
  selectedChainSessionId?: string | null;
};

export type ChainTimelineStore<S extends ChainTimelineStateFace = ChainTimelineStateFace> = {
  getState: () => S;
  setState: (partial: Partial<S> | ((state: S) => Partial<S>)) => void;
};

/** 会话 reasoning 总量 cap（design §2.1：如 256K，超则丢最旧 segment LRU）。 */
export const SESSION_REASONING_TOTAL_CAP = 256 * 1024;

/**
 * 全局 reasoning 总预算（CR-19 分层保留——终态链 timeline 每章永久滞留，reasoning 是 ~10×
 * 载荷的大头）。单位 = text.length（UTF-16 code unit 数，与 per-session cap 同口径；2M chars
 * 是「2MB 字节预算」的近似锚——CJK 1 char ≈ 1 code unit，同 cap 家族口径一致不混字节制）。
 */
export const GLOBAL_TIMELINE_REASONING_CAP = 2 * 1024 * 1024;

/** 节流 flush 基准窗（mirror chainStreamBuffer BASE_FLUSH_MS；reasoning 已被 per-segment cap 钳制，无长文降频门）。 */
const TIMELINE_FLUSH_MS = 250;

// ── 模块级 pending 缓冲（reasoning delta 高频，不直写 store） ──

type TimelineReasoningPending = {
  /** 流标识 `${nodeId}#${seq}`——新流（新节点 / redo 新 seq）commit 旧段另起。 */
  key: string;
  nodeId: string;
  seq: number;
  /** 当前轮 messageId——同流换 generate 轮 commit 旧段另起（mirror 链缓冲换轮语义）。 */
  messageId: string;
  phase?: string;
  text: string;
};

/** sessionId → 当前 reasoning 待 flush 段（不进 store；跨 flush 窗存活）。 */
const timelinePendingReasoning = new Map<string, TimelineReasoningPending>();

let timelineFlushTimer: ReturnType<typeof setTimeout> | null = null;
let timelineLatestStore: ChainTimelineStore | null = null;

/** 测试 helper：清模块级缓冲 + 停计时器。 */
export function __clearChainTimelineState(): void {
  timelinePendingReasoning.clear();
  if (timelineFlushTimer !== null) {
    clearTimeout(timelineFlushTimer);
    timelineFlushTimer = null;
  }
  timelineLatestStore = null;
}

/**
 * 会话删除时清理模块级缓冲（store 侧键由 deleteAgentSession 清——本函数只管模块 Map +
 * 计时器；调用点 mirror forgetChainRunBuffer）。
 */
export function forgetChainTimeline(sessionId: string): void {
  timelinePendingReasoning.delete(sessionId);
  if (timelinePendingReasoning.size === 0) stopTimelineFlushTimer();
}

function stopTimelineFlushTimer(): void {
  if (timelineFlushTimer !== null) {
    clearTimeout(timelineFlushTimer);
    timelineFlushTimer = null;
  }
}

// ── store 写入 helper ──

/** 向后扫同 nodeId 的最后一个 entry 下标（到达序 = attempt 序，最后者即当前 attempt）。 */
function lastEntryIndexForNode(entries: TimelineNodeEntry[], nodeId: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].nodeId === nodeId) return i;
  }
  return -1;
}

/** 泛型 store → 基面 store（mirror chainStreamBuffer asBaseStore：单一写面收口，避泛型 Partial 赋值不可证）。 */
function asTimelineBaseStore<S extends ChainTimelineStateFace>(store: ChainTimelineStore<S>): ChainTimelineStore {
  return store as unknown as ChainTimelineStore;
}

function writeTimelineState<S extends ChainTimelineStateFace>(
  store: ChainTimelineStore<S>,
  sessionId: string,
  mutate: (tl: ChainTimelineState) => ChainTimelineState,
): void {
  const base = asTimelineBaseStore(store);
  const timelines = base.getState().chainTimelineBySession;
  if (timelines === undefined) return; // 最小测试 store 缺省面：不写
  const prev = timelines[sessionId];
  const next = mutate(prev ?? { sessionId, entries: [], updatedAt: Date.now() });
  if (next === prev) return;
  base.setState({ chainTimelineBySession: { ...timelines, [sessionId]: next } });
  enforceGlobalTimelineCap(base); // CR-19：entry 写入后触发全局预算分层保留
}

/**
 * 新 run 重置（终态记忆命中 = 本事件是新 run 首条链事件）：清 entries + 丢弃旧 run 尾部
 * pending（不落新 run）。终态期间的 entries 回看义务已由上一 run 的 ended 态承载完毕。
 *
 * CR-3：escalateFindingsBySession[sid] 同点失效——上一 run 的裁决卡跨 run 残留会在后续
 * stub/中断暂停（无 pausedReview）时渲染陈旧裁决卡且挂真动作。与时间线重置同一判据
 * （runEnded 消费），同一原子写落盘。
 */
function resetIfNewRun<S extends ChainTimelineStateFace>(
  store: ChainTimelineStore<S>,
  sessionId: string,
): void {
  const base = asTimelineBaseStore(store);
  const timelines = base.getState().chainTimelineBySession;
  if (timelines === undefined) return;
  if (!timelines[sessionId]?.runEnded) return;
  timelinePendingReasoning.delete(sessionId);
  if (timelinePendingReasoning.size === 0) stopTimelineFlushTimer();
  const escalate = base.getState().escalateFindingsBySession;
  const hadStaleEscalate = escalate !== undefined && sessionId in escalate;
  const nextTimelines = { ...timelines, [sessionId]: { sessionId, entries: [], updatedAt: Date.now() } };
  if (hadStaleEscalate) {
    const nextEscalate = { ...escalate };
    delete nextEscalate[sessionId];
    base.setState({ chainTimelineBySession: nextTimelines, escalateFindingsBySession: nextEscalate });
    return;
  }
  base.setState({ chainTimelineBySession: nextTimelines });
}

/**
 * runEnded 标记写入（哨兵终态 / finalize 兜底）：仅在既有时间线上标记——无条目的会话不
 * 建空态（终态记忆只在有东西可保留时才有意义）。等值跳过。
 */
function markTimelineEnded<S extends ChainTimelineStateFace>(
  store: ChainTimelineStore<S>,
  sessionId: string,
  ended: boolean,
): void {
  const base = asTimelineBaseStore(store);
  const timelines = base.getState().chainTimelineBySession;
  if (timelines === undefined) return;
  const prev = timelines[sessionId];
  if (!prev || (prev.runEnded ?? false) === ended) return; // 等值跳过（含 undefined≡false——paused 帧不实体化 false）
  base.setState({
    chainTimelineBySession: { ...timelines, [sessionId]: { ...prev, runEnded: ended } },
  });
}

// ── reasoning 量控 ──

function totalReasoningChars(entries: TimelineNodeEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    for (const seg of entry.reasoning) total += seg.text.length;
  }
  return total;
}

/**
 * 会话总量 cap（LRU 丢最旧 segment——entries 到达序扫描、段内首段先丢）。引用稳定：未超限
 * 返回原数组（等值跳过纪律）。
 */
function enforceReasoningTotalCap(entries: TimelineNodeEntry[]): TimelineNodeEntry[] {
  let total = totalReasoningChars(entries);
  if (total <= SESSION_REASONING_TOTAL_CAP) return entries;
  const next = entries.map((e) => ({ ...e, reasoning: [...e.reasoning] }));
  while (total > SESSION_REASONING_TOTAL_CAP) {
    const donor = next.find((e) => e.reasoning.length > 0);
    if (!donor) break;
    total -= donor.reasoning[0].text.length;
    donor.reasoning.shift();
  }
  return next;
}

/**
 * 全局 reasoning 预算（CR-19 分层保留，用户拍板方案）：终态链 timeline 每章永久滞留（stub
 * 会话正常使用不删除），reasoning 是大头——超 2MB 预算时**分层降级**：
 *
 * 1. 按终态时间从旧到新（updatedAt 在终态后不再刷新 ≈ 终态时间）逐链**只清 reasoning 文本**
 *    （entries 结构 / 产出 summary / tools 保留——回看降级非丢失）；
 * 2. 清完仍超限 → 丢最旧终态链**整条 timeline**（兜底；候选耗尽即止）。
 *
 * 活跃链（runEnded 非真）与当前观察链（selectedChainSessionId）不在候选集——永不降级。
 * 触发点：timeline 写入（writeTimelineState）与终态标记（哨兵非 paused / finalize）后。
 */
function enforceGlobalTimelineCap(store: ChainTimelineStore): void {
  const state = store.getState();
  const timelines = state.chainTimelineBySession;
  if (timelines === undefined) return;
  let total = 0;
  for (const tl of Object.values(timelines)) total += totalReasoningChars(tl.entries);
  if (total <= GLOBAL_TIMELINE_REASONING_CAP) return;
  const observed = state.selectedChainSessionId ?? null;
  const candidates = Object.values(timelines)
    .filter((tl) => (tl.runEnded ?? false) && tl.sessionId !== observed)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  if (candidates.length === 0) return;
  let next: Record<string, ChainTimelineState> | null = null;
  for (const tl of candidates) {
    if (total <= GLOBAL_TIMELINE_REASONING_CAP) break;
    const chars = totalReasoningChars(tl.entries);
    if (chars === 0) continue;
    total -= chars;
    next ??= { ...timelines };
    next[tl.sessionId] = {
      ...tl,
      entries: tl.entries.map((e) => (e.reasoning.length > 0 ? { ...e, reasoning: [] } : e)),
    };
  }
  for (const tl of candidates) {
    if (total <= GLOBAL_TIMELINE_REASONING_CAP) break;
    next ??= { ...timelines };
    delete next[tl.sessionId];
  }
  if (next !== null) store.setState({ chainTimelineBySession: next });
}

// ── reasoning pending → store 提交 ──

/**
 * pending 段落 store（commit 语义）：目标 = 该 nodeId 当前 attempt entry（最后命中且
 * running；否则新 entry——上一 attempt 已 closed 属环重跑新 attempt）。同 messageId 段原地
 * 更新（flush 窗幂等），异 messageId 追加新段。
 */
function commitTimelineReasoning<S extends ChainTimelineStateFace>(
  store: ChainTimelineStore<S>,
  sessionId: string,
  pending: TimelineReasoningPending,
): void {
  writeTimelineState(store, sessionId, (tl) => {
    const seg: { messageId: string; phase?: string; text: string } = {
      messageId: pending.messageId,
      ...(pending.phase !== undefined ? { phase: pending.phase } : {}),
      text: pending.text,
    };
    const idx = lastEntryIndexForNode(tl.entries, pending.nodeId);
    if (idx >= 0 && tl.entries[idx].status === 'running') {
      const target = tl.entries[idx];
      const lastSeg = target.reasoning[target.reasoning.length - 1];
      // 等值跳过（mirror 链缓冲 streamText 节流纪律——空转 flush 窗不产 store 写）。
      if (
        lastSeg
        && lastSeg.messageId === pending.messageId
        && lastSeg.text === pending.text
        && (lastSeg.phase ?? undefined) === (pending.phase ?? undefined)
      ) return tl;
      const reasoning = lastSeg?.messageId === pending.messageId
        ? [...target.reasoning.slice(0, -1), seg]
        : [...target.reasoning, seg];
      const entries = [...tl.entries];
      entries[idx] = { ...target, reasoning };
      return { ...tl, entries: enforceReasoningTotalCap(entries), updatedAt: Date.now() };
    }
    return {
      ...tl,
      entries: enforceReasoningTotalCap([...tl.entries, {
        nodeId: pending.nodeId,
        seq: pending.seq,
        status: 'running',
        tools: [],
        reasoning: [seg],
        at: Date.now(),
      }]),
      updatedAt: Date.now(),
    };
  });
}

function ensureTimelineFlushTimer<S extends ChainTimelineStateFace>(store: ChainTimelineStore<S>): void {
  timelineLatestStore = asTimelineBaseStore(store); // 泛型方差不可证——经基面收口（asBaseStore 同款）
  if (timelineFlushTimer !== null) return;
  timelineFlushTimer = setTimeout(() => {
    timelineFlushTimer = null;
    const target = timelineLatestStore;
    if (!target || timelinePendingReasoning.size === 0) return;
    for (const [sid, pending] of timelinePendingReasoning) {
      commitTimelineReasoning(target, sid, pending);
    }
    ensureTimelineFlushTimer(target);
  }, TIMELINE_FLUSH_MS);
}

// ── apply 函数族（dispatcher 调用入口） ──

/**
 * chain-delta 到达（时间线面）：text 通道只参与新 run 边界判定不积累（正文流 streamText
 * 单源）；reasoning 通道经模块级 pending 缓冲节流积累（messageId 换轮分段、phase 透传、
 * per-segment cap 保尾弃头）。run paused 期间跳过（CR-21 口径——审阅等待期思考不假滚动）。
 */
export function applyTimelineChainDelta<S extends ChainTimelineStateFace>(
  store: ChainTimelineStore<S>,
  sessionId: string,
  data: { nodeId: string; role?: string; phase?: string; channel?: 'text' | 'reasoning'; messageId: string; delta: string; seq: number },
): void {
  if (store.getState().chainTimelineBySession === undefined) return;
  resetIfNewRun(store, sessionId);
  if (data.channel !== 'reasoning') return; // text：run 边界判定已过，正文不进时间线
  if (store.getState().chainRunBySession?.[sessionId]?.status === 'paused') return; // CR-21

  const key = `${data.nodeId}#${data.seq}`;
  let pending = timelinePendingReasoning.get(sessionId);
  if (!pending || pending.key !== key) {
    // 新流（新节点 / redo 新 seq）——旧段落 store（换流低频，直写），另起 pending。
    if (pending) commitTimelineReasoning(store, sessionId, pending);
    pending = { key, nodeId: data.nodeId, seq: data.seq, messageId: data.messageId, ...(data.phase !== undefined ? { phase: data.phase } : {}), text: '' };
    timelinePendingReasoning.set(sessionId, pending);
  } else if (pending.messageId !== data.messageId) {
    // 同流换 generate 轮——旧轮段落 store，新轮另起（「点开实时滚动」关心当前轮思考）。
    commitTimelineReasoning(store, sessionId, pending);
    pending.messageId = data.messageId;
    if (data.phase !== undefined) pending.phase = data.phase;
    else delete pending.phase;
    pending.text = '';
  } else if (data.phase !== undefined) {
    pending.phase = data.phase;
  }
  pending.text += data.delta;
  if (pending.text.length > REASONING_TAIL_CAP) {
    pending.text = pending.text.slice(pending.text.length - REASONING_TAIL_CAP);
  }
  ensureTimelineFlushTimer(store);
}

/**
 * chain-tool 到达（调查层累积，低频直写）：追加进该 nodeId 当前 attempt entry；无开 entry
 * （环重跑首事件 / 事件丢失兜底）则新 entry。
 */
export function applyTimelineTool<S extends ChainTimelineStateFace>(
  store: ChainTimelineStore<S>,
  sessionId: string,
  data: ChainToolEventData,
): void {
  if (store.getState().chainTimelineBySession === undefined) return;
  resetIfNewRun(store, sessionId);
  writeTimelineState(store, sessionId, (tl) => {
    const idx = lastEntryIndexForNode(tl.entries, data.nodeId);
    if (idx >= 0 && tl.entries[idx].status === 'running') {
      const entries = [...tl.entries];
      entries[idx] = { ...entries[idx], tools: [...entries[idx].tools, data] };
      return { ...tl, entries, updatedAt: Date.now() };
    }
    return {
      ...tl,
      entries: [...tl.entries, {
        nodeId: data.nodeId,
        seq: -1, // tool 载荷无流计数——artifact/delta 到达时覆写
        status: 'running',
        tools: [data],
        reasoning: [],
        at: Date.now(),
      }],
      updatedAt: Date.now(),
    };
  });
}

/**
 * chain-node-artifact 到达（产出快照，低频直写）：**每 attempt 新 entry；同 attempt 覆写
 * 重发（through verdict）取末帧**——判据 = 该 nodeId 最后 entry 仍 running（artifact 结构性
 * 先于同节点 done 帧，closed 后再达即属新 attempt 的环重跑首帧）。
 */
export function applyTimelineArtifact<S extends ChainTimelineStateFace>(
  store: ChainTimelineStore<S>,
  sessionId: string,
  data: { nodeId: string; role?: string; seq: number; summary: ChainNodeArtifactSummary },
): void {
  if (store.getState().chainTimelineBySession === undefined) return;
  resetIfNewRun(store, sessionId);
  writeTimelineState(store, sessionId, (tl) => {
    const idx = lastEntryIndexForNode(tl.entries, data.nodeId);
    if (idx >= 0 && tl.entries[idx].status === 'running') {
      // 同 attempt 覆写（through verdict 重发）取末帧。
      const entries = [...tl.entries];
      entries[idx] = { ...entries[idx], seq: data.seq, summary: data.summary };
      return { ...tl, entries, updatedAt: Date.now() };
    }
    return {
      ...tl,
      entries: [...tl.entries, {
        nodeId: data.nodeId,
        seq: data.seq,
        status: 'running',
        summary: data.summary,
        tools: [],
        reasoning: [],
        at: Date.now(),
      }],
      updatedAt: Date.now(),
    };
  });
}

/**
 * chain-node-done 到达：普通 nodeId = attempt 收口（status 步进；closed 后再达 = resume
 * done 帧重放——累积无洞契约，absorb 不建重复 entry）；哨兵 = run 终态帧（pending 尾巴
 * force 落 store + 清缓冲；非 paused 终态标 runEnded——paused resume 续同链不清）。
 */
export function applyTimelineNodeDone<S extends ChainTimelineStateFace>(
  store: ChainTimelineStore<S>,
  sessionId: string,
  data: { nodeId: string; status: string },
): void {
  if (store.getState().chainTimelineBySession === undefined) return;
  resetIfNewRun(store, sessionId);

  if (data.nodeId === CHAIN_RUN_SENTINEL_NODE_ID) {
    // 终帧先落尾再清缓冲（mirror 链缓冲 CR-T1-051——丢 ≤250ms 尾巴）。
    const pending = timelinePendingReasoning.get(sessionId);
    if (pending) {
      commitTimelineReasoning(store, sessionId, pending);
      timelinePendingReasoning.delete(sessionId);
      if (timelinePendingReasoning.size === 0) stopTimelineFlushTimer();
    }
    // 终态映射 mirror chainStreamBuffer 哨兵分支：paused 非终态（resume 续同链，时间线
    // 跨 pause/resume 累积）；legacy 'auto_revise_pending' 按退役前语义归 completed（CR-22）。
    const ended = data.status !== 'paused';
    markTimelineEnded(store, sessionId, ended);
    if (ended) enforceGlobalTimelineCap(asTimelineBaseStore(store)); // CR-19：终态标记后触发
    return;
  }

  // 该节点流收口——pending 尾巴先落（mirror CR-T1-051：node-done 命中流节点）。
  const pending = timelinePendingReasoning.get(sessionId);
  if (pending && pending.nodeId === data.nodeId) {
    commitTimelineReasoning(store, sessionId, pending);
    timelinePendingReasoning.delete(sessionId);
    if (timelinePendingReasoning.size === 0) stopTimelineFlushTimer();
  }

  const status: TimelineNodeEntry['status'] =
    data.status === 'error' ? 'error' : data.status === 'blocked' ? 'blocked' : 'done';
  writeTimelineState(store, sessionId, (tl) => {
    const idx = lastEntryIndexForNode(tl.entries, data.nodeId);
    if (idx >= 0) {
      if (tl.entries[idx].status !== 'running') return tl; // resume done 帧重放：absorb（累积无洞）
      const entries = [...tl.entries];
      entries[idx] = { ...entries[idx], status };
      return { ...tl, entries, updatedAt: Date.now() };
    }
    // 无 entry（纯代码节点事件丢失 / done-only 路径）——建终态 entry。
    return {
      ...tl,
      entries: [...tl.entries, { nodeId: data.nodeId, seq: -1, status, tools: [], reasoning: [], at: Date.now() }],
      updatedAt: Date.now(),
    };
  });
}

/**
 * run 级兜底终态（dispatcher 'done' / 'error' 事件调用——mirror finalizeChainRun 调用点）：
 * pending 尾巴 force 落 store + 清缓冲 + 标 runEnded（entries 保留回看）。无时间线条目时
 * 仅清模块面（不建空态）。
 *
 * paused 早退（mirror finalizeChainRun「审阅面板在等，保持 paused」）：链停在 checkpoint 等
 * 审阅时 leader turn 结束不构成链终态——不标 runEnded（resume 续同链，时间线跨 pause/resume
 * 累积不重置）。peer chainRunBySession.status 由先行的 finalizeChainRun 写定（调用点序：
 * finalizeChainRun → finalizeChainTimeline），此处读它是终态后真值——与 apply 入口的边界
 * 判定不读 peer（reasoning 车道不翻 run 态）不冲突：本函数只在 finalize 事件沿触发。
 */
export function finalizeChainTimeline<S extends ChainTimelineStateFace>(
  store: ChainTimelineStore<S>,
  sessionId: string,
): void {
  const pending = timelinePendingReasoning.get(sessionId);
  if (pending) {
    commitTimelineReasoning(store, sessionId, pending);
    timelinePendingReasoning.delete(sessionId);
    if (timelinePendingReasoning.size === 0) stopTimelineFlushTimer();
  }
  if (store.getState().chainRunBySession?.[sessionId]?.status === 'paused') return;
  markTimelineEnded(store, sessionId, true);
  enforceGlobalTimelineCap(asTimelineBaseStore(store)); // CR-19：finalize 终态标记后触发
}

// ── escalate findings 路由（design §2.2 / F5） ──

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * findings 条目级防御投影（mirror agent chainRunner extractEscalateFindings 语义 + ui
 * ReviewFindingsCard extractReaderAuditFindings 守卫形态）：severity 二值过滤、grounding
 * 三字段（quote/location/explanation）非空硬要求、attribution 枚举外丢弃。**坏条目单独
 * 丢不弃整批**；items 空数组合法（「已审核」锚点语义）。
 */
export function projectEscalateFindingItems(rawItems: unknown): EscalateFindingsItem[] {
  if (!Array.isArray(rawItems)) return [];
  const items: EscalateFindingsItem[] = [];
  for (const raw of rawItems) {
    const f = recordOf(raw);
    if (!f) continue;
    if (f.severity !== 'block' && f.severity !== 'warn') continue; // drop info 噪声
    const quote = typeof f.quote === 'string' ? f.quote : '';
    const location = typeof f.location === 'string' ? f.location : '';
    const explanation = typeof f.explanation === 'string' ? f.explanation : '';
    if (!quote || !location || !explanation) continue; // grounding 硬要求
    const attribution = REVIEW_ATTRIBUTION_VALUES.find((v) => v === f.attribution);
    items.push({
      severity: f.severity,
      quote,
      location,
      explanation,
      ...(typeof f.subClass === 'string' ? { subClass: f.subClass } : {}),
      ...(attribution !== undefined ? { attribution } : {}),
    });
  }
  return items;
}

/**
 * leader 消息 tool metadata 松散通道抽取（write-chapter.ts 裁决载荷
 * `metadata.findings {source, route, chapterId?, items}`）。source 两值外 / items 非数组 →
 * null（不认）；条目级坏形态由 projectEscalateFindingItems 单独丢。
 */
export function extractEscalateFindingsFromMetadata(metadata: unknown): EscalateFindingsEntry | null {
  const meta = recordOf(metadata);
  if (!meta) return null;
  const findings = recordOf(meta.findings);
  if (!findings) return null;
  if (findings.source !== 'reader-audit' && findings.source !== 'plan-review') return null;
  if (!Array.isArray(findings.items)) return null;
  return {
    source: findings.source,
    route: typeof findings.route === 'string' ? findings.route : '',
    ...(typeof findings.chapterId === 'string' ? { chapterId: findings.chapterId } : {}),
    items: projectEscalateFindingItems(findings.items),
    at: Date.now(),
  };
}

/**
 * 写 escalateFindingsBySession[sessionId]（replace 语义——redo 仍 escalate 时挂 redo 的
 * findings，最新帧胜）。最小测试 store 缺省面不写。
 */
export function setEscalateFindings<S extends ChainTimelineStateFace>(
  store: ChainTimelineStore<S>,
  sessionId: string,
  entry: EscalateFindingsEntry,
): void {
  const base = asTimelineBaseStore(store);
  const state = base.getState();
  if (state.escalateFindingsBySession === undefined) return;
  base.setState({
    escalateFindingsBySession: { ...state.escalateFindingsBySession, [sessionId]: entry },
  });
}
