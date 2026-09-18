import {
  detectPerspectiveGap,
  projectPerspective,
  promiseActionSchema,
  selectScenesForEpisode,
  reduceSubject,
  type PerspectiveDivergence,
  type PromiseAction,
  type PromiseActionInput,
  type PromiseBeat,
  type PromiseEntry,
  type ReducedState,
  type ReusableAgentNodeContract,
  type SceneGraph,
  type WorldPatch,
} from '@orison/shared-contracts';
import { CHAIN_ARTIFACT_ITEMS_CAP } from './chain-node-artifact';
import type { AgentNode, NodeResult, NodeRunInput, RunSnapshot } from '../contracts/run';
import { createLlmNode, type LlmNodeDeps } from './llm-node';
import { extractJson } from './extract-json';
import { fetchWorldPatchesViaTool } from './world-state-query';
import { registry } from '../tool/registry';
import { logger } from '../logger';

// ── Story 6.5 Promise 涌现登记节点（design §3 / ADR-3 / ADR-14 / conclusions §3.7）──
//
// 挂 chapter-chain 的 `world-merge-node` 后、`story-sync-agent` 前（revision 闭环外，跑一次）。读全轴
// patches（认知轴 + 关系轴）+ draft.initial 正文（grounding 裁判权威）+ 既有 Promise（避重复登记）→
// LLM 判定「哪些 gap 是 Promise + 跨轴 fact join + 命名叙事工具 + 本章推进」→ 经 promise_ledger_update
// builtin 写 promise_registry。
//
// 🔑 范式红线（cognition.ts:13-16 / creative-vs-mechanical，继承 6.1）：节点内**两段分工**——
// - **段 1 纯代码**（detectAxisPerspectiveGaps）：取认知轴 + 关系轴 patches → reduceSubject → per-axis
//   `projectPerspective` + `detectPerspectiveGap`（cognition.ts 复用）→ 产 per-axis PerspectiveGap[]。
//   **不跨轴 join**（跨轴归 LLM 段）。纯代码只报 `*_vs_*` 方向，**不命名叙事工具**（dramatic_irony 与
//   suspense 纯结构重叠不可纯代码区分）。
// - **段 2 LLM**（createLlmNode，promise-emergence-agent.yaml）：读 per-axis gaps + draft.initial 正文 +
//   既有 Promise 列表 + scene_graph → 语义判断（全归 LLM）：① 哪些 gap 是 Promise（plant→payoff 读者债）；
//   ② 跨轴 fact join（同 subject + 同 fact 主题 = 既有 Promise 新 beat；否则新 Promise 赋 factKey）；
//   ③ 命名叙事工具（伏笔/戏剧反讽/悬念/误导 → category tags）；④ 本章推进判定（plant / advance / setback /
//   payoff beat）→ 输出 promiseActionSchema[]（每条 beat 带 grounding 正文原文 + emergedFromGap 摘要）。
//
// CR-E3 graceful（mirror world-extractor-node.ts:253-280 增强性质哲学）：节点失败（LLM parse 失败 / builtin
// 未注册 / 无 gap / gaps 未被判为 Promise）→ 空 `promise_emergence` artifact + warning，**不破 chain**。
// Promise 登记是增强非硬约束——无 Promise 不阻塞写作（落地公理：Promise 落地检查归 Reader-Audit，登记
// 缺失只意味着本章没新增读者债追踪，非致命）。
//
// 链段节点（非 CONTRACTS[] 子 agent）：mirror world-merge-node / world-extractor-node 先例——链段节点经
// createChapterChainNodes 装配，不进 agentContracts.ts CONTRACTS[]（orchestration-pattern.md:137 子 agent /
// 链段节点不进 CONTRACTS[] 约定）。
//
// expected_downstream_consumers:
// - Story 6.5 Phase D2：brief-compiler #7 compilePromiseTasks 读 promise_registry（本章推进节拍）+ Reader-Audit
//   promise-landing 维（落地检查）。本节点产 promise_emergence artifact（登记摘要），下游消费 promise_registry
//   （经 promise_ledger_update 写入 creative field）。

// ════════════════════════════════════════════════════════════════════════════
// 段 1 纯代码：per-axis perspective gap 检测（cognition.ts 复用，无 LLM/无语义）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 单条 per-axis perspective gap（段 1 纯代码产，喂 LLM 段）。
 *
 * 段 1 只做 within-轴 gap 检测（同轴 objective vs reader_perceived 分层差异）；跨轴 join（认知轴
 * characterPerceived vs 关系轴 objective）归 LLM 段语义判断。每条 gap 带 subjectId + 实际 views 值，
 * 供 LLM 跨轴 fact 对齐 + Promise 判定 + 命名。
 */
export interface AxisGap {
  /** 来源轴（cognition.ts gap 检测适用轴：认知 + 关系，均承载 objective/reader_perceived 分层）。 */
  axis: 'cognitive' | 'relational';
  /** gap 所属主体 id（认知轴=角色，关系轴=关系主体；LLM 跨轴 join 用）。 */
  subjectId: string;
  /** gap 的 fact JSON Pointer path（如 /believes/国王；LLM 跨轴 fact 对齐用）。 */
  factPath: string;
  /** 结构性分歧方向（纯代码报 *_vs_*，不命名叙事工具）。 */
  divergences: readonly PerspectiveDivergence[];
  /** 客观/作者设计层 value（分层 value 内 objective）。 */
  objective?: unknown;
  /** 读者感知层 value（分层 value 内 reader_perceived）。 */
  readerPerceived?: unknown;
  /**
   * 角色感知层 value（认知轴单值 value 投影；跨轴 join 时 LLM 段填）。
   * 段 1 within-轴检测时此字段通常为 undefined（认知轴分层 value 投影出 objective/readerPerceived 两层）。
   */
  characterPerceived?: unknown;
}

/** plain object 判定（mirror cognition.ts isPlainObject）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 判 value 是否承载 perspective 分层（mirror cognition.ts isLayeredValue）。
 * reader_perceived 是强信号（非常用词）；单独 objective 不够（{objective:'任务目标'} 非分层，CR-E4）。
 */
function isLayeredValue(v: unknown): boolean {
  return isPlainObject(v) && 'reader_perceived' in v;
}

/**
 * 遍历 reduced state 收集所有承载分层 value 的 fact path（within-轴 gap 候选）。
 *
 * 只收集 isLayeredValue 的 path（单值 value 投影出 {characterPerceived} 仅一视图，无 within-轴分歧可能——
 * 跨轴 characterPerceived vs objective 归 LLM 段）。递归进嵌套 plain object（非分层）找更深层分层 value，
 * 不递归进分层 value 的 objective/reader_perceived 子层（那是视图层非 fact）。
 */
function collectLayeredFactPaths(state: ReducedState): string[] {
  const paths: string[] = [];
  walk(state, '');
  return paths;

  function walk(value: unknown, prefix: string): void {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${prefix}/${i}`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, val] of Object.entries(value)) {
        const path = `${prefix}/${key}`;
        if (isLayeredValue(val)) {
          paths.push(path);
        }
        // 递归进嵌套非分层 plain object 找更深层分层 value。
        if (isPlainObject(val) && !isLayeredValue(val)) {
          walk(val, path);
        }
      }
    }
  }
}

/**
 * 从全轴 patches 检测 per-axis perspective gaps（认知轴 + 关系轴）。**纯函数**（无 LLM/无 db/无副作用）。
 *
 * 范式判据（ADR-3 / cognition.ts:13-16）：gap 检测 = 纯代码结构比较（projectPerspective +
 * detectPerspectiveGap 复用 6.1），只报 `*_vs_*` 方向，**不命名叙事工具 + 不判 Promise**（归 LLM 段）。
 *
 * 对认知轴 + 关系轴分别：收集唯一 subjectId → reduceSubject（at=undefined 取最新累积状态）→
 * collectLayeredFactPaths → per-path projectPerspective + detectPerspectiveGap → 收集非 null gap。
 *
 * **不跨轴 join**（design §3.3 / §4 D6）：跨轴 fact 对齐（认知轴 /believes/X + 关系轴 /status/Y 是否同 fact）
 * = 语义判断归 LLM 段。段 1 只产 within-轴 gaps（同轴 objective vs reader_perceived 分层差异）。
 *
 * @param patches  全部候选 patches（自行 filter cognitive + relational；通常传项目全集）。
 * @returns        per-axis AxisGap[]（认知轴 + 关系轴；无 gap → 空数组）。
 */
export function detectAxisPerspectiveGaps(patches: readonly WorldPatch[]): AxisGap[] {
  const gaps: AxisGap[] = [];
  const axes = ['cognitive', 'relational'] as const;

  for (const axis of axes) {
    const axisPatches = patches.filter((p) => p.axis === axis);
    if (axisPatches.length === 0) continue;

    // 收集唯一 subjectId（first-seen 序，与叙事出现序一致）。
    const subjectIds: string[] = [];
    const seen = new Set<string>();
    for (const p of axisPatches) {
      if (p.subjectId && !seen.has(p.subjectId)) {
        seen.add(p.subjectId);
        subjectIds.push(p.subjectId);
      }
    }

    for (const subjectId of subjectIds) {
      // at=undefined 取最新累积状态（全部 patches 叠加，反映本章末认知/关系状态）。
      const { state } = reduceSubject(axisPatches, subjectId);
      const factPaths = collectLayeredFactPaths(state);
      for (const factPath of factPaths) {
        const views = projectPerspective(state, factPath);
        const gap = detectPerspectiveGap(views, factPath);
        if (gap) {
          gaps.push({
            axis,
            subjectId,
            factPath: gap.factPath,
            divergences: gap.divergences,
            objective: views.objective,
            readerPerceived: views.readerPerceived,
            characterPerceived: views.characterPerceived,
          });
        }
      }
    }
  }
  return gaps;
}

// ════════════════════════════════════════════════════════════════════════════
// 段 2 LLM 输出解析（robust，mirror parseAxisExtraction 哲学：坏条目丢弃不全丢）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 解析 LLM 涌现登记输出为 PromiseAction[]（robust：root JSON.parse 失败抛→触发重试；逐条 safeParse 丢坏保留好）。
 *
 * 接受 `{ actions: [...] }`（prompt 约定形态）或裸 `[...]`（LLM 偶发直返数组）。先试整体 parse（裸数组/裸
 * 对象直通），再试 extractJson（fenced / 前导文字，object-oriented）。逐条 safeParse promiseActionSchema
 * （discriminated union：add_promise/add_beat/update_beat/remove_promise/remove_beat）——坏条目丢弃，好条目保留
 * （mirror parseAxisExtraction / CR-4.1-07 哲学）。
 *
 * @param content LLM 返回原始 content（可能带 ```json 围栏 / 前导文字 / 裸数组）。
 * @throws root JSON.parse 失败（触发 createLlmNode 重试→兜底 error artifact）。
 * @returns    PromiseAction[]（全坏条目 → 空数组，非抛——caller 据长度判是否写盘）。
 */
export function parsePromiseEmergenceOutput(content: string): PromiseAction[] {
  // 抽取 root：先试整体 parse（裸数组/裸对象直通，避 extractJson object-oriented 限制），再试 extractJson
  // （fenced / 前导文字）。两者都失败 → 第二个 JSON.parse 抛 → createLlmNode 重试。
  const trimmed = content.trim();
  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch {
    root = JSON.parse(extractJson(content));
  }

  // 归一：{ actions: [...] } / 裸 [...] / 其他 → unknown[]。
  let rawActions: unknown[];
  if (Array.isArray(root)) {
    rawActions = root;
  } else if (root && typeof root === 'object' && 'actions' in root) {
    const obj = root as { actions?: unknown };
    rawActions = Array.isArray(obj.actions) ? obj.actions : [];
  } else {
    rawActions = [];
  }

  // 逐条 safeParse（坏条目丢，好条目保留）。
  const actions: PromiseAction[] = [];
  for (const raw of rawActions) {
    const result = promiseActionSchema.safeParse(raw);
    if (result.success) actions.push(result.data);
  }
  return actions;
}

// ════════════════════════════════════════════════════════════════════════════
// builtin 工具调用 helper（mirror world-state-query fetchWorldPatchesViaTool 的 registry 模式）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 经 query_promise builtin 取既有 Promise 列表（避重复登记）。graceful：工具未注册/失败 → undefined。
 *
 * @returns  { promises, beats }（空 registry 也返空数组非 undefined——供 LLM 判「无既有 Promise」）；
 *           undefined = 工具未注册 / 调用失败 / metadata 缺失（caller 降级，LLM 段收空列表 + warning）。
 */
async function fetchExistingPromises(
  projectPath: string,
): Promise<{ promises: PromiseEntry[]; beats: PromiseBeat[] } | undefined> {
  const tool = registry.get('query_promise');
  if (!tool) return undefined;
  try {
    const result = await tool.execute(
      {},
      {
        projectPath,
        // query_promise handler 仅用 projectDir（resolveProjectId），sessionId 走 toolExecution 通道不读；
        // 节点无 sessionId（chain node 不持 session 引用），传空串 placeholder（handler 忽略，mirror
        // fetchWorldPatchesViaTool）。
        sessionId: '',
        abort: new AbortController().signal,
      },
    );
    const meta = result.metadata as { promises?: PromiseEntry[]; beats?: PromiseBeat[] } | undefined;
    if (!meta || !Array.isArray(meta.promises) || !Array.isArray(meta.beats)) return undefined;
    return { promises: meta.promises, beats: meta.beats };
  } catch (err) {
    logger.warn(
      { projectPath, err: err instanceof Error ? err.message : String(err) },
      'promise-emergence-node: query_promise failed → graceful undefined (LLM 段收空既有列表)',
    );
    return undefined;
  }
}

/**
 * promise_emergence 节点产出 artifact（登记摘要 + 落盘结果）。
 */
export interface PromiseEmergenceArtifact {
  /** 段 1 检测到的 per-axis gap 数（纯代码产，喂 LLM 段）。 */
  gapsDetected: number;
  /** LLM 段产出的合法 PromiseAction 数（safeParse 后）。 */
  actionsProduced: number;
  /**
   * 09-13 子2 W3（design §2 items kind）：本圈登记的 PromiseAction 原始清单——产出快照投影
   *（chain-node-artifact items）的数据源。节点 artifact 形态不敷投影的**唯一节点侧补字段**
   *（design §2「个别节点 artifact 形态不敷投影时才节点侧补字段」条款）；additive optional
   *（无 actions / graceful 跳过缺省）。CR 批 CR-4：封顶 CHAIN_ARTIFACT_ITEMS_CAP（50）——
   * 全量计数看 actionsProduced（落盘不受 cap 影响 builtin 已携全量）。
   */
  actions?: PromiseAction[];
  /** 登记跳过原因（无 gap / 无 patches / LLM 失败 / 无 action 时填，CR-E3 graceful）。 */
  skipped?: string;
  /** A1：actions 是否已自动落盘到 promise_registry creative field（autoApply 模式，mirror 6.6 world-state 自动写）。 */
  applied?: boolean;
  /** promise_ledger_update builtin 返的 metadata（autoApply 模式：{ok,applied,promiseCount,beatCount}；审计用）。 */
  fieldPatch?: unknown;
  /** 写入失败原因（builtin 未注册 / 抛错 / locked field；节点不破 chain，记 warning）。 */
  writeError?: string;
}

/**
 * 经 promise_ledger_update builtin 写入 Promise actions。graceful：工具未注册/失败 → 记 writeError，不破 chain。
 *
 * 🔑 A1（CR-A1 critical，block AC2）：emergence 是自动链段节点（LLM 从 gap 涌现，非人决策），传 **autoApply:true**
 * 让 handler 直接落盘 promise_registry creative field（mirror 6.6 world-state 自动写 closure_world_patch，不经
 * PatchReview）。Promise 是实际轨（factual beats），应自动落盘。原实现走 field_patch envelope 但 envelope 永不
 * 被消费（summarizeRunSnapshot 不提 promise_emergence / write_chapter metadata 只记 chapter_candidate field_patch），
 * 致 emergence 产的 Promise 永不到 project.yaml（feature 无效 + AC2 违反）。autoApply 绕开 PatchReview 直接落盘闭环。
 *
 * handler autoApply 返 `{ok, applied:true, promiseCount, beatCount}` metadata（非 field_patch envelope，已落盘）。
 * 节点把 metadata 记入 artifact（applied=true 标落盘成功，下游可观测）。
 *
 * @returns  { applied, fieldPatch } 成功 / { error } 失败 / undefined = 工具未注册。
 */
async function writePromiseActions(
  actions: PromiseActionInput[],
  projectPath: string,
): Promise<{ applied?: boolean; fieldPatch?: unknown; error?: string } | undefined> {
  const tool = registry.get('promise_ledger_update');
  if (!tool) {
    logger.warn(
      'promise-emergence-node: promise_ledger_update tool not registered → skip write (emergence still produces artifact)',
    );
    return { error: 'promise_ledger_update tool not registered' };
  }
  try {
    const result = await tool.execute(
      // A1：autoApply=true → handler 直接 onFieldEdited(source:'agent') 落盘 promise_registry（绕开 PatchReview）。
      { actions, autoApply: true },
      {
        projectPath,
        sessionId: '',
        abort: new AbortController().signal,
      },
    );
    const meta = result.metadata as { applied?: boolean } | undefined;
    return { applied: meta?.applied === true, fieldPatch: result.metadata };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { projectPath, err: msg },
      'promise-emergence-node: promise_ledger_update failed → graceful skip (actions produced but not persisted)',
    );
    return { error: msg };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// promise-emergence-node 节点（段 1 纯代码 → 段 2 LLM → 写入 builtin）
// ════════════════════════════════════════════════════════════════════════════

const PROMISE_EMERGENCE_CONTRACT: ReusableAgentNodeContract = {
  nodeId: 'promise-emergence-node',
  displayName: 'Promise Emergence Node',
  inputSchemaName: 'promiseEmergenceInput',
  outputSchemaName: 'promiseEmergence',
  // world_state.events（merge 产物，全轴 patches 汇聚标志）/ draft.initial（正文 grounding 裁判权威）/
  // scene_graph（beat sceneRef 挂载 + 本章场定位）。
  requiredArtifactKeys: ['world_state.events', 'draft.initial', 'scene_graph'],
  producedArtifactKeys: ['promise_emergence'],
  // 经 promise_ledger_update builtin 写 promise_registry creative field（field_patch envelope）。
  sideEffects: ['persist_artifact'],
};

/** 安全取 artifact record（过滤非对象/数组）。mirror world-extractor-node artifactAsRecord。 */
function artifactAsRecord(run: RunSnapshot, key: string): Record<string, unknown> | undefined {
  const raw = run.artifacts[key];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function scalarOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** 从 chapter_brief_input artifact 解析 episodeId（mirror world-extractor-node resolveEpisodeId）。 */
function resolveEpisodeId(chapterBriefInput: unknown): string | undefined {
  if (!chapterBriefInput || typeof chapterBriefInput !== 'object') return undefined;
  const obj = chapterBriefInput as Record<string, unknown>;
  if ('episodeId' in obj && typeof obj.episodeId === 'string' && obj.episodeId.length > 0) {
    return obj.episodeId;
  }
  return undefined;
}

/**
 * 构造 Promise 涌现登记节点（段 1 纯代码 → 段 2 LLM → 写入 builtin）。
 *
 * run 流程：
 *  1. **段 1 纯代码**：fetchWorldPatchesViaTool（query_world_slice builtin 取项目全集 patches）→
 *     detectAxisPerspectiveGaps（reduceSubject + projectPerspective + detectPerspectiveGap 复用 6.1）→
 *     AxisGap[]。无 patches / 无 gap → 空 artifact + skipped reason（CR-E3 graceful，跳 LLM 调用省成本）。
 *  2. fetchExistingPromises（query_promise builtin，避重复登记）。
 *  3. **段 2 LLM**（createLlmNode，promise-emergence-agent.yaml）：buildPrompt 注入 gaps + draftText +
 *     existingPromises + sceneGraph vars → 单次 generate（+ 重试）→ parsePromiseEmergenceOutput →
 *     PromiseAction[]。LLM 失败（初试+重试）→ 空 artifact + skipped reason（CR-E3 graceful）。
 *  4. **写入**：writePromiseActions（promise_ledger_update builtin）→ field_patch envelope 记入 artifact。
 *     builtin 未注册 / 失败 → 记 writeError，不破 chain（actions 产出但未落盘，artifact 仍正常）。
 *
 * 闭包传段 1 输出给 buildPrompt：createLlmNode 的 buildPrompt(run) 是 sync 的（不能 await fetch），
 * 故段 1 的 async 结果在 outer run 内 await 完成后 stash 进闭包，buildPrompt 读闭包变量（节点链段顺序驱动
 * 无并发，闭包 race-free；节点挂 revision 闭环外跑一次，闭包单次设置）。
 *
 * @param deps LLM deps（generate/modelRef/signal，createLlmNode 用）。
 */
export function createPromiseEmergenceNode(deps: LlmNodeDeps): AgentNode {
  // 段 1 输出 stash（outer run 设置，inner buildPrompt 读取）。链段顺序驱动，无并发 race。
  let stashedGaps: AxisGap[] = [];
  let stashedExisting: { promises: PromiseEntry[]; beats: PromiseBeat[] } | undefined;

  const innerNode = createLlmNode(
    {
      nodeId: 'promise-emergence-node',
      role: 'promise-emergence-agent',
      contract: PROMISE_EMERGENCE_CONTRACT,
      buildPrompt: (run: RunSnapshot) => {
        const draft = artifactAsRecord(run, 'draft.initial');
        const sceneGraph = run.artifacts['scene_graph'] as SceneGraph | undefined;
        const episodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
        return {
          // 段 1 检测到的 gaps（纯代码产，含 subjectId/axis/factPath/divergences/views 值）。
          perspectiveGaps: JSON.stringify(stashedGaps),
          draftText: scalarOf(draft?.text),
          // 既有 Promise（避重复登记，跨轴 join 锚——同 factKey 的既有 Promise 加 beat 非新建）。
          existingPromises: JSON.stringify(stashedExisting ?? { promises: [], beats: [] }),
          // 本章场（beat sceneRef 挂 Scene.id，LLM 选目标场）。
          sceneGraph: JSON.stringify(selectScenesForEpisode(sceneGraph, episodeId)),
          episodeId: episodeId ?? '（未提供）',
        };
      },
      parseOutput: (content: string) => {
        const actions = parsePromiseEmergenceOutput(content);
        // 返中间 artifact（__raw 标记）；outer wrapper 提取 actions 调 builtin 后产最终 artifact。
        return { stateKey: 'promise_emergence', artifact: { __raw: true, actions } };
      },
    },
    deps,
  );

  return {
    contract: PROMISE_EMERGENCE_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run } = input;

      // ── 段 1 纯代码：取 patches + 检测 gaps ──
      const patches = await fetchWorldPatchesViaTool(run.projectPath);
      if (!patches || patches.length === 0) {
        logger.warn(
          { projectPath: run.projectPath },
          'promise-emergence-node: no world-state patches (query_world_slice unavailable/empty) → skip emergence',
        );
        return emptyEmergenceArtifact(0, 'no world-state patches (query_world_slice unavailable or empty)');
      }
      const gaps = detectAxisPerspectiveGaps(patches);
      if (gaps.length === 0) {
        // 无 gap = 本章无 perspective 分歧（无信息差读者债涌现）——非失败，graceful 跳过。
        return emptyEmergenceArtifact(0, 'no perspective gaps detected (no within-axis objective/reader divergence)');
      }
      stashedGaps = gaps;

      // ── 取既有 Promise（避重复登记）──
      stashedExisting = await fetchExistingPromises(run.projectPath);

      // ── 段 2 LLM：判 Promise + 跨轴 join + 命名 ──
      const innerResult = await innerNode.run(input);
      if (
        innerResult.artifact &&
        typeof innerResult.artifact === 'object' &&
        (innerResult.artifact as { error?: boolean }).error === true
      ) {
        // createLlmNode 兜底 error artifact（LLM 初试+重试均失败）→ CR-E3 graceful 转空 emergence。
        logger.warn(
          { nodeId: 'promise-emergence-node' },
          'promise-emergence-node: LLM failed after retries → graceful empty emergence (chain continues)',
        );
        return emptyEmergenceArtifact(gaps.length, 'LLM emergence failed after retries');
      }
      const rawArtifact = innerResult.artifact as { __raw?: boolean; actions?: PromiseAction[] } | undefined;
      const actions = rawArtifact?.actions ?? [];
      if (actions.length === 0) {
        // LLM 判定本章 gaps 均不构成 Promise（或产物全被 safeParse 丢）——非失败，graceful 跳过写盘。
        return emptyEmergenceArtifact(gaps.length, 'LLM produced no valid Promise actions (gaps not judged as Promise)');
      }

      // ── 写入：经 promise_ledger_update builtin（autoApply=true，A1 自动落盘 creative field）──
      const writeResult = await writePromiseActions(actions, run.projectPath);

      const artifact: PromiseEmergenceArtifact = {
        gapsDetected: gaps.length,
        actionsProduced: actions.length,
      };
      // 09-13 子2 W3：原始 actions 随 artifact 携带（产出快照 items 投影源；additive）。
      // CR 批 CR-4：artifact 侧封顶 CHAIN_ARTIFACT_ITEMS_CAP（与产出快照投影 cap 同常数）——
      // LLM 超额产出无界进 run.artifacts 会膨胀 persist 的 chainSnapshot。**落盘不受影响**
      //（上方 writePromiseActions 已携全量写 promise_registry）；全量计数经 actionsProduced
      // 注明（投影 total 读它——截断可观测「N/total」）。
      if (actions.length > 0) {
        artifact.actions = actions.slice(0, CHAIN_ARTIFACT_ITEMS_CAP);
      }
      // A1：autoApply 模式 handler 直接落盘 → record applied outcome（mirror 6.6 world-state 自动写）。
      if (writeResult?.applied === true) artifact.applied = true;
      if (writeResult?.fieldPatch !== undefined) artifact.fieldPatch = writeResult.fieldPatch;
      if (writeResult?.error !== undefined) artifact.writeError = writeResult.error;
      return { stateKey: 'promise_emergence', artifact };
    },
  };
}

/** 构造空 emergence artifact（CR-E3 graceful，不破 chain）。 */
function emptyEmergenceArtifact(gapsDetected: number, reason: string): NodeResult {
  return {
    stateKey: 'promise_emergence',
    artifact: {
      gapsDetected,
      actionsProduced: 0,
      skipped: reason,
    } satisfies PromiseEmergenceArtifact,
  };
}
