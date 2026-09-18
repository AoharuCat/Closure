// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 6（design §4 / §6.2 / §7.5，r1）：写章链运行态 + delta 缓冲。
//
// chain-delta 高频事件**不直进 zustand**（r4/r7 一致结论）——模块级 Map 按 (nodeId, seq)
// 维度累积当前流（新 seq / 新 messageId 轮 = 新段），节流 flush 才写 store 的
// chainRunBySession[sid].streamText（ChainRunCard 消费）。快照间隔自适应：累积 >20K 字符
// 时拉长到 500ms（防线性 MD 解析成本，design §6.2 尾坑）。
//
// 09-13 子2 W1（R5 channel 守卫）：chain-delta 按 channel 分流——text 走上述正文车道
// （行为零变化）；reasoning 走 chainReasoningBuffers 独立缓冲键（不进正文 entry 生命周期，
// flush 写独立 reasoningPreview 字段——ChainRunCard 零消费；尾窗 20K 保尾弃头）。
//
// 状态机（ChainRunState.status）：
// - running：链 run 在途（ChainRunCard 全卡：步进条 + 流式正文）。
// - paused：checkpoint pause / 挂起——卡片降级为**仅步进条**（让位 ChapterReviewPanel，
//   design §7.5「不叠加两卡」）。
// - completed：run 终态正常（accept / 环收敛终态）——卡片卸载
//   （审阅/落盘流程接管：ChapterReviewPanel / PatchReviewPanel / ReviewFindingsCard）。
// - aborted / error：中断/失败——卡片保留已累积文本 + 「已中断/失败」标 + 重试钮
//   （abort 半 JSON 不落盘，UI 缓冲侧标注中断——r1 坑；leader 路径重试 = 重发末条 user 消息）。
//
// 终态后再收到非哨兵链事件 = 新 run（redo / 下一章）→ 重置状态从头累积。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 链 run 级终态帧的哨兵 nodeId——mirror agent 包 `CHAIN_RUN_SENTINEL_NODE_ID`
 * （`@orison/desktop-agent` 导出单源；UI 包不依赖 agent 包，本地镜像此常量。
 * 真实节点 id 不含双下划线前后缀，哨兵无碰撞）。
 */
export const CHAIN_RUN_SENTINEL_NODE_ID = '__chain_run__';

/**
 * 写章链节点权威序——mirror agent 包 `CHAPTER_CHAIN_NODE_IDS`
 * （`apps/desktop/agent/src/nodes/chapter-chain.ts`，链装配权威序）。UI 包不依赖 agent
 * 包，本地镜像驱动步进条「未来节点」空心点（agent 包侧改链序时须同步此表）。
 *
 * 链流程重排（09-13 W1d 装配）：新链序 = 规划环（brief-compiler→brief-reviewer）→ 自审环 7 节点
 * （revision-optimizer→**draft-writer**→revision-guard→lint→multi-review→completeness→route——写手
 * 单位置在环体内〔optimizer 紧后〕：首圈整章首写 / 环回圈带编译意图改稿，AC5「环体 7 节点」）→
 * 提取段（world-extractor×5→world-merge→emotion-verify→promise-emergence→arc-emergence→
 * chapter-summary→storytime-drift→mention-ledger→story-sync→feedback-ledger）——targeted-revision
 * 移除（职能并入环内 C1 编译 + 写手 directive 重跑）。W1a 镜像曾列写手在 optimizer 前——W1d 装配
 * 定稿对调（环内改稿语义必需：环回 pointer 跳回 optimizer 后写手必须在环体内才会重跑）。
 */
export const CHAIN_NODE_ORDER: readonly string[] = [
  'brief-compiler-node',
  'brief-reviewer-node',
  'revision-optimizer-node',
  'draft-writer-agent',
  'revision-guard-agent',
  'lint-node',
  'multi-review-agent',
  'completeness-verify-node',
  'route-agent',
  'world-extractor-physical',
  'world-extractor-cognitive',
  'world-extractor-emotional',
  'world-extractor-relational',
  'world-extractor-factional',
  'world-merge-node',
  'emotion-verify-node',
  'promise-emergence-node',
  'arc-emergence-node',
  'chapter-summary-node',
  'storytime-drift-node',
  'mention-ledger-node',
  'story-sync-agent',
  'feedback-ledger-node',
];

/** 节点步进条显示名（机械去后缀——英文 id 随 #38 另簇中文化，此处只做可读化）。 */
export function chainNodeLabel(nodeId: string): string {
  return nodeId.replace(/-(node|agent)$/, '');
}

// ── 09-13 子2 W3：节点产出快照（chain-node-artifact 事件）载荷镜像 ──
//
// mirror agent 包 `ChainNodeArtifactSummary` / `ChainNodeArtifactFindingRow` /
// `ChainNodeArtifactData`（apps/desktop/agent/src/types.ts 单源 + 发射形态表
// nodes/chain-node-artifact.ts）。UI 包不依赖 agent 包，本地镜像（CHAIN_NODE_ORDER 先例——
// agent 侧改五 kind / 载荷字段时须同步本镜像）。**本波（子2 W3）零消费**——dispatcher 对
// unknown 变体 default 忽略（已核实）；子3 写作页时间线（产出卡模板）是消费方。

/** findings kind 单行（label = 维度/实体标签，severity = 源 artifact 原值透传）。 */
export type ChainNodeArtifactFindingRow = {
  label: string;
  severity: string;
  /** 正文或对照引文（agent 侧已截断 200）。 */
  quote: string;
  /** 一句话说明（agent 侧已截断 200）。 */
  note: string;
};

/** 产出快照五 kind（brief-card / items〔封顶 50〕/ findings / route-decision / line）。 */
export type ChainNodeArtifactSummary =
  | { kind: 'brief-card'; brief: Record<string, unknown> }
  | { kind: 'items'; label: string; items: string[]; total: number }
  | {
      kind: 'findings';
      verdict?: string;
      summary: string;
      findings: ChainNodeArtifactFindingRow[];
      total: number;
    }
  | { kind: 'route-decision'; decision: string; reason: string }
  | { kind: 'line'; line: string };

/**
 * chain-node-artifact 事件载荷。seq = 发射时该节点流式轮次计数器**当前值快照（不消耗）**——
 * 与本轮流式 delta 同 seq 归组；从未开流（纯代码位 / no-op 圈）= -1（无 attempt 锚）。
 */
export type ChainNodeArtifactData = {
  nodeId: string;
  role: string;
  seq: number;
  summary: ChainNodeArtifactSummary;
};

// ── 09-13 子2 W4：链内工具调用（chain-tool 事件）+ 哨兵 pauseKind 载荷镜像 ──
//
// mirror agent 包 `ChainToolEventData` / `ChainNodeDonePauseKind`（apps/desktop/agent/src/types.ts
// 单源；发射 seam = nodes/agent-loop.ts 工具执行循环体 + workflow deriveSentinelPauseKind 投影）。
// UI 包不依赖 agent 包，本地镜像（CHAIN_NODE_ORDER 先例——agent 侧改字段时须同步本镜像）。
// **本波零消费**——dispatcher 对 unknown 变体 default 忽略（已核实零改动）；子3 写作页时间线
//（调查层 + 暂停档理由）是消费方。

/** 链内工具调用事件载荷（nodeId 当前恒 'draft-writer-agent'——链内唯一带工具的节点位）。 */
export type ChainToolEventData = {
  nodeId: string;
  toolName: string;
  /** 调用参数摘要（agent 侧截断 200）。 */
  inputSummary: string;
  /** 结果规模（当前档 = 输出字符数；结构化计数档待 seam 升级——机会主义）。 */
  resultCount?: number;
  status: 'ok' | 'error';
};

/**
 * 哨兵 paused 帧暂停理由（mirror agent 包 ChainNodeDonePauseKind——五暂停面：escalate 灰区裁决 /
 * brief 规划卡人审 / draft 出发核查挂起 / revision-guard 保义护栏软违规 / final 终稿人审）。
 * 子3 时间线暂停档即时理由数据源（现有 metadata/summary 通道是 run 结束后的，不够即时）。
 */
export type ChainNodeDonePauseKind = 'final' | 'escalate' | 'brief' | 'draft' | 'revision-guard';

export type ChainRunStatus = 'running' | 'completed' | 'error' | 'aborted' | 'paused';

/** 单会话链运行态（ChainRunCard 数据源；ephemeral——刷新即丢，run 本身随主进程死，语义一致）。 */
export type ChainRunState = {
  sessionId: string;
  status: ChainRunStatus;
  /** 已完成节点（chain-node-done 'done' 累积；步进条实心点）。 */
  completedNodes: string[];
  /** 当前步进锚点（最近一次 node-done 的节点；步进条呼吸点）。 */
  currentNodeId: string | null;
  /** 失败/受阻节点（node-done 'error' / 'blocked'）。 */
  errorNodeId: string | null;
  /** 流式正文元数据（当前 (nodeId, seq) 流）。 */
  streamNodeId: string | null;
  streamRole: string | null;
  streamPhase: string | null;
  /** 已 flush 的流式正文累积（终态保留——中断态呈现「已流出部分」）。 */
  streamText: string;
  /**
   * 09-13 子2 W1（R5 / plan-review H1 定案）：当前流尾窗思考预览（reasoning 通道 flush 面）。
   * **独立于正文车道**：不进 streamText（ChainRunCard 零消费——正文渲染管线不触）；纯观测 +
   * AC5 断言便利。子3 回看消费点 = dispatcher 原始事件（chainTimelineBySession），本字段只保
   * 「当前流尾窗」（H1(a)：per-session 单槽不保历史）。缺省无（无 reasoning 流 / 未 flush）。
   */
  reasoningPreview?: string;
  /** 流仍在途（正文区 caret / 三点 loading 判定）。 */
  streaming: boolean;
  /**
   * 09-12 子2 fallback chains（design §8⑤）：链内最近一次模型切换（model-fallback 事件
   * 带 nodeId——链卡「当前模型」chip 的切换态数据源）。缺省无（未发生过回退 = 主指派
   * 模型在跑，chip 不标切换）。新 run 重置。
   */
  modelSwitch?: {
    from: { keyId: string; modelId: string };
    to: { keyId: string; modelId: string };
    reason: string;
    nodeLabel: string;
    at: number;
  };
  updatedAt: number;
};

/**
 * 缓冲写回所需的 store 结构面（appStore 的 AppState 结构满足；结构性类型避免
 * appStore ↔ buffer 循环 import，mirror agentStreamBuffer 模式）。
 */
export type ChainBufferState = {
  chainRunBySession: Record<string, ChainRunState>;
  /**
   * dogfood T1 CR-T1-049：finalizeChainRun 终态同步 run 态（agentRunStates）所需的结构面。
   * agentEvents 传入的 store 结构满足（AgentDispatchState 超集）；最小测试 store 可缺省
   * （缺省不写——链缓冲行为独立可测）。类型 import 自 agentEvents（type-only，无运行时环）。
   */
  setAgentRunState?: (sessionId: string, patch: import('./agentEvents').AgentRunStatePatch) => void;
};

export type ChainBufferStore<S extends ChainBufferState = ChainBufferState> = {
  getState: () => S;
  setState: (partial: Partial<S> | ((state: S) => Partial<S>)) => void;
};

/** 终态集合（再收到非哨兵链事件 = 新 run → 重置）。paused 非终态（resume 续同链）。 */
const TERMINAL_STATUSES: ReadonlySet<ChainRunStatus> = new Set(['completed', 'error', 'aborted']);

type ChainBufferEntry = {
  /** 流标识 `${nodeId}#${seq}`——新流（redo 重跑 seq+1）开新段。 */
  key: string;
  nodeId: string;
  role: string;
  phase: string | null;
  /** 当前轮 messageId（makeAgentLoop 预分配轮 assistantId）——同流内换轮 = 新段。 */
  messageId: string;
  text: string;
  /**
   * dogfood T1 CR-T1-051：上次 flush 时刻——>20K 长文降频（500ms）按 entry 生效。旧
   * nextFlushDelayMs 全局扫描会让 A 会话超 20K 拖慢 B 会话的 flush（块5 附注跨会话耦合）。
   */
  lastFlushAt: number;
};

/** sessionId → 当前流缓冲（不进 store；跨 flush 窗存活）。 */
const chainBuffers = new Map<string, ChainBufferEntry>();

/**
 * 09-13 子2 W1（R5 / plan-review H1 定案）：reasoning 独立缓冲键——**不进** (nodeId,seq) 正文
 * entry 生命周期（首款不建/重建正文 entry、不写 store.streamText、不翻 streaming——消解
 * 「abort 于 E 段时后续节点首条 reasoning 清空正文预览」的边缘回归〔H1(c)〕、不被正文 flush
 * 降频门管）。per-session 单槽（H1(a)：只保当前流尾窗，历史回看归 dispatcher 原始事件）。
 * 同轮追加、messageId 变化即重置（mirror 正文 entry 换轮语义，M3）；尾窗 cap 保尾弃头。
 */
type ChainReasoningEntry = {
  /** 流标识 `${nodeId}#${seq}`——新流（新节点 / redo 新 seq）重开段，mirror 正文 entry。 */
  key: string;
  nodeId: string;
  /** 当前轮 messageId——同流内换 generate 轮即重置文本。 */
  messageId: string;
  text: string;
};

/** sessionId → 当前 reasoning 尾窗（不进 store 正文车道；flush 写 reasoningPreview）。 */
const chainReasoningBuffers = new Map<string, ChainReasoningEntry>();

/**
 * reasoning 尾窗 cap（design §6 量控：20K 保尾弃头——时间线关心当前思考，非全量留存）。
 * 09-13 子3 W2：export 供 chainTimeline 复用**数值**（时间线 per-segment cap 同值）——
 * 非机制复用（链缓冲是 per-session 单槽尾窗；时间线是全量历史 + 会话总量 cap，两套生命周期）。
 */
export const REASONING_TAIL_CAP = 20000;

/** 计时器停摆判据：正文与 reasoning 缓冲两 Map 均空（09-13 子2 W1 起双 Map）。 */
function noChainBuffersLeft(): boolean {
  return chainBuffers.size === 0 && chainReasoningBuffers.size === 0;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 基准 flush 间隔 250ms（design §6.2）；>20K 字符自适应拉长到 500ms（§6.2 尾坑）。 */
const BASE_FLUSH_MS = 250;
const LONG_FLUSH_MS = 500;
const LONG_TEXT_THRESHOLD = 20000;

let latestStore: ChainBufferStore | null = null;

/** 测试 helper：清模块级缓冲 + 停计时器。 */
export function __clearChainStreamState(): void {
  chainBuffers.clear();
  chainReasoningBuffers.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  latestStore = null;
}

function asBaseStore<S extends ChainBufferState>(store: ChainBufferStore<S>): ChainBufferStore {
  return store as unknown as ChainBufferStore;
}

function writeForSession(
  store: ChainBufferStore,
  sessionId: string,
  patch: (prev: ChainRunState | undefined) => ChainRunState,
): void {
  const state = store.getState();
  const prev = state.chainRunBySession[sessionId];
  const next = patch(prev);
  if (prev === next) return;
  store.setState({ chainRunBySession: { ...state.chainRunBySession, [sessionId]: next } });
}

function freshRun(sessionId: string): ChainRunState {
  return {
    sessionId,
    status: 'running',
    completedNodes: [],
    currentNodeId: null,
    errorNodeId: null,
    streamNodeId: null,
    streamRole: null,
    streamPhase: null,
    streamText: '',
    streaming: false,
    updatedAt: Date.now(),
  };
}

/**
 * chain-delta 到达：终态后首条 delta = 新 run（重置）；缓冲按 (nodeId, seq) 开段（新流 /
 * 同流换 messageId 轮均重置文本）；确保 store 记录在 + status running + streaming。
 *
 * 09-13 子2 W1（R5 channel 守卫）：按 channel 分流——text（或缺省）走既有正文车道**行为零
 * 变化**；reasoning 走独立缓冲键（appendChainReasoning）——不进正文 entry 生命周期、不写
 * streamText、不翻 streaming/不建卡（正文流语义与既有 UI 解信封依赖不变）。
 *
 * CR-21（W-CR 批）：run paused 后 reasoning 增量**跳过缓冲**——pause 窗口（停在 checkpoint 等审阅）
 * 内到达的 reasoning 是在途尾帧，照缓冲会让 flush 继续突变 reasoningPreview（审阅等待期「当前思考」
 * 假滚动——与 text 车道 paused 语义不一致：text 把 paused 后 delta 视为 redo 重开流回 running，
 * reasoning 是纯观测尾窗非卡片生命周期信号，late frame 丢弃而非复活）。run resume（node-done /
 * text delta 把 status 翻回 running）后 reasoning 增量照常入缓冲。
 */
export function applyChainDelta<S extends ChainBufferState>(
  store: ChainBufferStore<S>,
  sessionId: string,
  data: { nodeId: string; role: string; phase?: string; channel?: 'text' | 'reasoning'; messageId: string; delta: string; seq: number },
): void {
  const base = asBaseStore(store);
  if (data.channel === 'reasoning') {
    const prevRun = base.getState().chainRunBySession[sessionId];
    if (prevRun?.status === 'paused') return; // CR-21：paused 态跳过 reasoning 缓冲写入
    appendChainReasoning(sessionId, data);
    ensureFlushTimer(base);
    return;
  }
  const state = base.getState();
  const prev = state.chainRunBySession[sessionId];
  if (prev === undefined || TERMINAL_STATUSES.has(prev.status) || prev.status === 'paused') {
    // 终态后首条 delta = 新 run（重置）；paused 后 delta = redo 重跑已开流 → 回 running
    //（精简态只属于「停在 checkpoint 等审阅」窗口）。delta 只在 run 在途时流动。
    writeForSession(base, sessionId, (p) =>
      p === undefined || TERMINAL_STATUSES.has(p.status)
        ? freshRun(sessionId)
        : { ...p, status: 'running', streaming: true, updatedAt: Date.now() },
    );
  }

  const key = `${data.nodeId}#${data.seq}`;
  let entry = chainBuffers.get(sessionId);
  if (!entry || entry.key !== key) {
    entry = { key, nodeId: data.nodeId, role: data.role, phase: data.phase ?? null, messageId: data.messageId, text: '', lastFlushAt: Date.now() };
    chainBuffers.set(sessionId, entry);
    writeForSession(base, sessionId, (p) => ({
      ...(p ?? freshRun(sessionId)),
      streamNodeId: data.nodeId,
      streamRole: data.role,
      streamPhase: data.phase ?? null,
      streamText: '',
      streaming: true,
      updatedAt: Date.now(),
    }));
  } else if (entry.messageId !== data.messageId) {
    // 同流内换 generate 轮（阶段二查询轮后另起写作轮）——新轮文本另起一段。
    entry.messageId = data.messageId;
    entry.text = '';
  } else {
    entry.phase = data.phase ?? entry.phase;
  }
  entry.text += data.delta;
  ensureFlushTimer(base);
}

/**
 * reasoning 增量入独立缓冲（09-13 子2 W1 R5）：per-session 单槽——新流（新 nodeId#seq）重开段、
 * 同流换 messageId 轮重置（mirror 正文 entry 语义，M3）；追加后超 REASONING_TAIL_CAP 保尾弃头。
 * **零 store 副作用**（不建卡 / 不写正文——flush 窗到点由 flushChainReasoning 写 reasoningPreview）。
 */
function appendChainReasoning(
  sessionId: string,
  data: { nodeId: string; messageId: string; delta: string; seq: number },
): void {
  const key = `${data.nodeId}#${data.seq}`;
  let entry = chainReasoningBuffers.get(sessionId);
  if (!entry || entry.key !== key) {
    // 新流（新节点 / redo 新 seq）——重开段（旧流尾窗整体替换，单槽语义）。
    entry = { key, nodeId: data.nodeId, messageId: data.messageId, text: '' };
    chainReasoningBuffers.set(sessionId, entry);
  } else if (entry.messageId !== data.messageId) {
    // 同流内换 generate 轮——新轮思考另起（「点开实时滚动」关心当前轮思考）。
    entry.messageId = data.messageId;
    entry.text = '';
  }
  entry.text += data.delta;
  if (entry.text.length > REASONING_TAIL_CAP) {
    entry.text = entry.text.slice(entry.text.length - REASONING_TAIL_CAP);
  }
}

/**
 * chain-node-done 到达：哨兵 nodeId = run 级终态帧（status → 卡片状态机映射）；普通 nodeId =
 * 节点步进（completedNodes 累积 / 当前锚点 / error 节点标注）。终态后普通事件 = 新 run（重置）。
 */
/**
 * 09-12 子2 fallback chains（design §7/§8⑤）：链内模型切换事件（ChainStreamEvent
 * 'model-fallback'，data 带 nodeId/role）→ ChainRunState.modelSwitch（链卡「当前模型」
 * chip 的切换态）。不建卡（无 chainRunBySession 条目时只写 notice 面，卡由 delta/步进
 * 事件驱动建立——切换可能先于首条 delta 到达，写卡会抢跑出空卡）。终态/缺省条目防御
 * 跳过（新 run 的 delta 重置自然清旧切换）。
 */
export function applyChainModelFallback<S extends ChainBufferState>(
  store: ChainBufferStore<S>,
  sessionId: string,
  data: {
    from: { keyId: string; modelId: string };
    to: { keyId: string; modelId: string };
    reason: string;
    nodeId: string;
    role?: string;
  },
): void {
  const base = asBaseStore(store);
  const prev = base.getState().chainRunBySession[sessionId];
  if (prev === undefined || TERMINAL_STATUSES.has(prev.status)) return;
  writeForSession(base, sessionId, (p) => ({
    ...(p ?? prev),
    modelSwitch: {
      from: data.from,
      to: data.to,
      reason: data.reason,
      nodeLabel: chainNodeLabel(data.nodeId),
      at: Date.now(),
    },
    updatedAt: Date.now(),
  }));
}

export function applyChainNodeDone<S extends ChainBufferState>(
  store: ChainBufferStore<S>,
  sessionId: string,
  data: { nodeId: string; status: string },
): void {
  const base = asBaseStore(store);

  if (data.nodeId === CHAIN_RUN_SENTINEL_NODE_ID) {
    // CR-T1-051：终帧先 flush 后删——「中断保留已流出文本」承诺此前只兑现到上个 flush 点
    //（丢 ≤500ms 尾巴）。force 跳过 per-entry 降频门（终态一帧定形，尾巴必须落）。
    // 09-13 子2 W1：reasoning 尾窗同点 flush 后清（mirror 正文——防跨 run 泄漏）。
    flushChainBuffers(base, { force: true });
    chainBuffers.delete(sessionId);
    chainReasoningBuffers.delete(sessionId);
    if (noChainBuffersLeft()) stopFlushTimer();
    // run 终态映射：blocked 归 error（链未走通）；paused 保留累积（步进条降级态可见）。
    // CR-22（W-CR 批）：legacy 'auto_revise_pending'（09-13 W1a 前的哨兵终态值——环收敛 break 交
    // leader 的中转态）按退役前语义映射 completed——dev 热重载 / 持久化时间线回放会把旧帧重放进
    // dispatcher，落 else 归 error 会把健康的复跑卡错标失败。生产链已不再产该值（W1a 链内回环）。
    let status: ChainRunStatus;
    if (data.status === 'completed' || data.status === 'auto_revise_pending') status = 'completed';
    else if (data.status === 'paused') status = 'paused';
    else if (data.status === 'aborted') status = 'aborted';
    else status = 'error'; // 'error' | 'blocked' | 未知终态归失败
    writeForSession(base, sessionId, (p) => ({
      ...(p ?? freshRun(sessionId)),
      status,
      streaming: false,
      updatedAt: Date.now(),
    }));
    return;
  }

  const state = base.getState();
  const prev = state.chainRunBySession[sessionId];
  if (prev === undefined || TERMINAL_STATUSES.has(prev.status)) {
    writeForSession(base, sessionId, (p) => (p === undefined || TERMINAL_STATUSES.has(p.status) ? freshRun(sessionId) : p!));
  }
  const isNodeError = data.status === 'error' || data.status === 'blocked';
  writeForSession(base, sessionId, (p) => {
    const cur = p ?? freshRun(sessionId);
    const completedNodes =
      data.status === 'done' && !cur.completedNodes.includes(data.nodeId)
        ? [...cur.completedNodes, data.nodeId]
        : cur.completedNodes;
    return {
      ...cur,
      // paused 后 resume/redo 续跑（新节点事件到达）→ 回 running（全卡形态；paused 精简态
      // 只属于「停在 checkpoint 等审阅」窗口）。
      status: cur.status === 'paused' ? 'running' : cur.status,
      completedNodes,
      currentNodeId: data.nodeId,
      errorNodeId: isNodeError ? data.nodeId : cur.errorNodeId,
      // dogfood T1 CR-T1-050：普通 node-done 命中流节点 → streaming 收口（此前只在哨兵复位
      // ——draft-writer done 后整个 JSON 节点尾期正文区恒流式态 = auto 档数十分钟假「正在
      // 写作」+ caret 残留）。streamText 保留（终态呈现「已流出部分」；JSON 节点期正文区
      // 让位占位——组件侧按 streaming 判定，design §7.5）。
      streaming: data.nodeId === cur.streamNodeId ? false : cur.streaming,
      updatedAt: Date.now(),
    };
  });
}

/**
 * dogfood T1 CR-T1-029：会话删除时修剪模块级缓冲（store 侧 chainRunBySession 条目由
 * deleteAgentSession 清——本函数只管模块 Map + 计时器）。
 */
export function forgetChainRunBuffer(sessionId: string): void {
  chainBuffers.delete(sessionId);
  chainReasoningBuffers.delete(sessionId); // 09-13 子2 W1：同点清理 reasoning 尾窗（mirror 正文键）
  if (noChainBuffersLeft()) stopFlushTimer();
}

/**
 * run 级兜底终态（dispatcher 'done' / 'error' 事件调用）：链仍 running 时标中断/失败——
 * 正常完成路径哨兵帧先到（status 已 completed），此处只兜「链中途被掐」（abort / 流错误）。
 */
export function finalizeChainRun<S extends ChainBufferState>(
  store: ChainBufferStore<S>,
  sessionId: string,
  status: 'aborted' | 'error',
): void {
  const base = asBaseStore(store);
  // CR-T1-051：终帧先 flush 后删（同哨兵分支——force 跳过降频门，中断尾巴不丢）。
  flushChainBuffers(base, { force: true });
  chainBuffers.delete(sessionId);
  chainReasoningBuffers.delete(sessionId); // 09-13 子2 W1：同点清理（mirror 哨兵分支）
  if (noChainBuffersLeft()) stopFlushTimer();
  // dogfood T1 CR-T1-049：终态同步 run 态（agentRunStates）——finalize 是链终态漏斗（done/
  // error 事件兜底路径），dogfood stub 会话的链车道无 done 事件复位（普通 node-done 分支置
  // running）→ 不在此归位则 stub 会话永久 running 徽标 + 停止钮。aborted 归 idle（mirror
  // 哨兵映射——中断非 error 相位）。paused 早退保持（审阅等待由键控槽承载，run 态已 idle）。
  base.getState().setAgentRunState?.(sessionId, {
    phase: status === 'error' ? 'error' : 'idle',
    activity: undefined,
  });
  const prev = base.getState().chainRunBySession[sessionId];
  if (prev === undefined) return;
  if (prev.status === 'paused') return; // 审阅面板在等（ChapterReviewPanel 接管），保持 paused
  if (TERMINAL_STATUSES.has(prev.status)) return; // 哨兵帧已定终态（正常完成 / 显式中断）
  writeForSession(base, sessionId, (p) => ({
    ...(p ?? freshRun(sessionId)),
    status,
    streaming: false,
    updatedAt: Date.now(),
  }));
}

function ensureFlushTimer(store: ChainBufferStore): void {
  latestStore = store;
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const target = latestStore;
    if (!target || noChainBuffersLeft()) return;
    flushChainBuffers(target);
    // dogfood T1 CR-T1-051：计时器恒按基准窗重排——长文降频改为 per-entry 门（flushChainBuffers
    // 内按 entry.lastFlushAt + 文本长度判）。旧 nextFlushDelayMs 全局扫描会让 A 会话超 20K
    // 拖慢 B 会话的 flush（块5 附注跨会话耦合）；>20K 的 entry 隔一窗（500ms）才写。
    ensureFlushTimer(target);
  }, BASE_FLUSH_MS);
}

function stopFlushTimer(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/**
 * 节流 flush：缓冲累积文本 → store streamText（每 250/500ms 一次 set，memo 友好）。
 * per-entry 降频（CR-T1-051）：>20K 长文隔窗到 500ms 才写，短文会话不受拖累；
 * `force`（终帧前最后落盘）跳过降频门——中断尾巴必须落，同点不重写（streamText 等值跳过）。
 *
 * 09-13 子2 W1（R5）：reasoning 尾窗 flush 同窗（flushChainReasoning）——独立字段
 * reasoningPreview，不受正文降频门 / 锚点匹配约束（reasoning 容量已被尾窗 cap 钳制）。
 */
function flushChainBuffers(store: ChainBufferStore, opts: { force?: boolean } = {}): void {
  const now = Date.now();
  for (const [sessionId, entry] of chainBuffers) {
    const prev = store.getState().chainRunBySession[sessionId];
    if (prev === undefined || prev.streamNodeId !== entry.nodeId) continue;
    if (prev.streamText === entry.text) continue;
    if (!opts.force) {
      const delayMs = entry.text.length > LONG_TEXT_THRESHOLD ? LONG_FLUSH_MS : BASE_FLUSH_MS;
      if (now - entry.lastFlushAt < delayMs) continue;
    }
    entry.lastFlushAt = now;
    writeForSession(store, sessionId, (p) => ({
      ...(p ?? freshRun(sessionId)),
      streamText: entry.text,
      updatedAt: now,
    }));
  }
  flushChainReasoning(store, now);
}

/**
 * reasoning 尾窗 → store reasoningPreview。**不建卡**（run 条目不存在 / 终态时跳过——mirror
 * applyChainModelFallback 不建卡形态：reasoning 单独到达不抢跑空卡）；不翻 streaming（正文
 * 车道生命周期）；等值跳过（同 streamText 节流纪律）。
 */
function flushChainReasoning(store: ChainBufferStore, now: number): void {
  for (const [sessionId, entry] of chainReasoningBuffers) {
    const prev = store.getState().chainRunBySession[sessionId];
    if (prev === undefined || TERMINAL_STATUSES.has(prev.status)) continue;
    if (prev.reasoningPreview === entry.text) continue;
    writeForSession(store, sessionId, (p) => ({
      ...(p ?? freshRun(sessionId)),
      reasoningPreview: entry.text,
      updatedAt: now,
    }));
  }
}
