import { randomUUID } from 'node:crypto';
import {
  detectArcStagnation,
  selectScenesForEpisode,
  verificationVerdictSchema,
  type AppearanceGapStat,
  type ArcStagnationInfo,
  type GenerateFallbackEntry,
  type ResearchBrief,
  type ResearchBriefDeviation,
  type SceneGraph,
  type ThinkingControl,
  type VerificationVerdict,
} from '@orison/shared-contracts';
import { makeAgentLoop } from './agent-loop';
import {
  applyEscalateBelt,
  runPhaseWithParse,
  WRITER_READONLY_TOOL_IDS,
  type WriterVerifier,
  type WriterVerifyInput,
  type WriterVerificationOutcome,
} from './writer-node';
import { fetchExistingArcBeats, resolveEpisodeIndex } from './arc-emergence-node';
import { fetchAppearanceGapStatsViaTools } from './mention-query';
import { loadAgentPrompt } from '../prompt/agentPrompt';
import { renderTemplate } from '../prompt/template';
import { isAbortError, type GenerateFn } from './llm-node';
import { extractJson } from './extract-json';
import { registry } from '../tool/registry';
import { logger } from '../logger';
import type { SessionMessage, ToolDefinition } from '../types';

// ── Story 8.4 Step 3（A4-A6，design §1.5/§1.6）：资料员转岗核实协议（代查 → 核实）──
//
// 资料（核实）员 = 独立子循环（makeAgentLoop 复用，design §1.1 同一机制底座）：输入 = 任务卡 + 写手调查
// 简报 + **机械弹药包**（纯代码算好随请求递入），产出 verificationVerdict（四判定清单 + gaps + suggestions
// + archive_issues）。**许可 = 四判定清单全过（机械可审计，非主观满足感）**——pass↔checklist 一致性由
// shared-contracts verificationVerdictSchema refine 钉死；suggestions 不进 pass 计算（AC-3）。
//
// 🔑 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：
// - **纯代码（弹药段取数 + shared 单源纯函数）**：出场间隔统计（Story 8.7 S9 起双源——出场账 mention 行
//   优先〔提及也算露面〕，无账/窗缺的 subject 退世界状态 patches 口径，`buildAppearanceGapStats` shared
//   单源纯函数，取数腿 mention-query.ts 共用）+ 弧停滞信号（复用 8.2 detectArcStagnation 单源）+ 产出映射
//   （pass/escalate 机械判定）。弹药只作**建议依据**（suggestions.basis），不进 pass 计算——「谁该出场」是
//   创作判断，机械统计只供事实（「多久没露面」）。
// - **LLM（retrieval-agent.yaml 转岗 prompt）**：对照任务卡反向找缺失（四判定）、抽查出处真伪、矛盾识别、
//   建议的语义包装（「让 15 章没出场的少女 C 背景露一面」）、档案议题识别。
// - **escalate 机械 belt（design §1.5）**：简报 issues 含 contradiction 或 deviations 非空 → escalate
//   （机械判定非 LLM 判——verdict.escalate 是 LLM 可选信号，但写手节点侧对简报本身做机械检查兜底：
//   偏离/矛盾必须人决断，不因核查清单全过而放行）。
//
// **口径注记（8.4 已知盲区的 S9 补全）**：间隔统计主口径 = 出场账（登场与被提及都算露面——「被提及但
// 状态没变」的轻度出场 8.4 patches 口径看不见，8.7 mention 账补全）；出场账未覆盖的主体（建卡前/无桥/
// 账未建立）退世界状态口径（实为「最后状态变化距今」，轻度出场会被高估间隔）——逐条 `basis` 标注，核实
// 员可区分。
//
// graceful（增强层哲学，mirror Director/retrieval 既有姿态）：核实子循环失败（工具环境不可用 / 连续工具
// 错误 / verdict parse 两试失败 / 熔断）→ 返 pass（无 verdict）+ `degraded: true`（R2-盲3：降级直通
// 非真许可——写手节点据此**不置 verified**，档案标「曾降级」下轮核实重跑）+ warn——**不假 gaps 也不假
// escalate**（infra 失败 ≠ 内容缺漏），写作照常（写手核心交付物是正文，mirror design §5「简报是增强层
// 非硬约束」）。abort 例外——传播（取消语义不吞）。
//
// expected_downstream_consumers:
// - Story 8.4 Step 3：chapter-chain.ts 装配 createWriterNode({...llmDeps, verifier: createResearchVerifier(...)})
//   （生产接线）；写手节点消费 outcome 三态（pass 直进阶段二 / gaps 补查回合 / escalate 挂起族）。
// - Story 8.4 Step 4（A7/A8，已接）：escalate / verify_exhausted 挂起 → writer 节点产 pause 型
//   挂起载荷（research_brief.suspended → decideCheckpointPause 全档位暂停）。
// - Story 8.4 Step 6（A3 存档）：verdict 全量写章档案（本 step 只落 research_brief artifact 内嵌）。

/** 核实子循环轮数上限（独立保险丝——与写手 50 轮、核实 3 回合互不复用计数，design §2.3 三条预算线）。 */
export const VERIFIER_MAX_ROUNDS = 20;

/** 核实收束标记（核实员输出 verdict JSON 后另起一行单独写）。 */
const VERIFIER_STOP_MARKER = '<VERIFICATION_VERDICT_READY>';

/**
 * 资料员工具集 = 写手同款只读十三件（Story 8.7 S8 扩 catalog/get_entry/query_mentions；含认知图——核实「角色此刻知道什么」对照）。
 * **无档案写权限**（archive_issues 只报告不改卡）——classifyTool 全 'read' 测试钉死（AC-4）。
 */
export const VERIFIER_TOOL_IDS = WRITER_READONLY_TOOL_IDS;

// ── 机械弹药包（纯代码，dispatch 前算好随请求递入）──

/**
 * 弹药包（纯代码产物；降级注记记哪路数据源不可得——弹药是建议依据，缺了不阻断核实）。
 *
 * `intervals` = `AppearanceGapStat[]`（Story 8.7 S9 起**双源**：出场账 mention 行优先——提及也算露面；
 * 无账/窗缺的 subject 退世界状态 patches 口径，逐条 `basis` 标注口径）。统计本体 = shared-contracts
 * `buildAppearanceGapStats` 单源纯函数（三暴露面共用：query_mentions gap_stats 视图 / 本弹药面 /
 * 4.4 completeness L1），本文件不重写口径。
 */
export interface VerifierAmmo {
  intervals: AppearanceGapStat[];
  stagnantArcs: ArcStagnationInfo[];
  /** 数据源不可得注记（出场账/世界状态/摘要窗未注册等；空 = 全源可得或确无数据）。 */
  degradedReasons: string[];
}

/** 出场间隔弹药条目上限（防长篇全实体倾倒胀弹药段；按间隔降序取前 N——最久未露面者最有建议价值）。 */
export const AMMO_INTERVAL_CAP = 12;

/** 只报「距本章开场 ≥ 此间隔」的实体（近期活跃者无建议价值，滤掉省弹药段篇幅）。 */
export const AMMO_INTERVAL_MIN_GAP = 1;

/**
 * 本章开场 storyTime 锚：本章场集（scene_graph 命中本章 episode 的场）的最小 storyTime。
 * 取 min 而非首场（interval 锚要「本章最早故事时刻」，首场序受数组序影响）。
 * scene_graph 缺 / 本章无场 / 场无 storyTime → undefined（间隔统计降级，弧停滞照常）。
 */
export function resolveAnchorStoryTime(
  sceneGraph: SceneGraph | undefined,
  episodeId: string | undefined,
): number | undefined {
  const scenes = selectScenesForEpisode(sceneGraph, episodeId);
  let min: number | undefined;
  for (const s of scenes) {
    if (typeof s.storyTime === 'number' && Number.isFinite(s.storyTime)) {
      if (min === undefined || s.storyTime < min) min = s.storyTime;
    }
  }
  return min;
}

/**
 * 弹药文本 shaping（纯函数）：把间隔统计 + 弧停滞信号整成核实员可读的紧凑段。
 * 措辞说人话（agent-tools 双规则）——报机械事实（多久没露面 + 口径），不替 LLM 下创作结论。
 */
export function buildAmmoText(ammo: VerifierAmmo): string {
  const lines: string[] = ['（以下为机械统计事实，仅供你组织叙事建议用；不影响四判定许可）'];
  if (ammo.intervals.length > 0) {
    lines.push(
      '出场间隔统计（出场账口径＝登场与被提及都算露面；标「世界状态口径」的条目＝出场账未覆盖到，只按最后一次状态变化计，轻度出场会被高估间隔）：',
    );
    for (const it of ammo.intervals) {
      const ep = it.lastEpisodeId !== undefined ? `，最后露面 ${it.lastEpisodeId}` : '';
      const basis = it.basis === 'patches' ? '（世界状态口径）' : '';
      lines.push(`- ${it.entryId}${ep}：距本章开场 storyTime 差 ${it.storyTimeGap}${basis}`);
    }
  } else {
    lines.push('出场间隔统计：无（近期各实体均有露面，或出场账/世界状态暂无记录）。');
  }
  if (ammo.stagnantArcs.length > 0) {
    lines.push('弧停滞信号（线弧/成长弧连续多章无新节拍，未闭合）：');
    for (const s of ammo.stagnantArcs) {
      lines.push(
        `- 弧 ${s.arcRef}（${s.arcKind === 'line' ? '线弧' : '成长弧'}）：已连续 ${s.chaptersSinceLastBeat} 章无新节拍（末拍 episode #${s.lastBeatEpisodeIndex}）`,
      );
    }
  } else {
    lines.push('弧停滞信号：无。');
  }
  if (ammo.degradedReasons.length > 0) {
    lines.push(`（部分统计不可得：${ammo.degradedReasons.join('；')}——相应建议可略）`);
  }
  return lines.join('\n');
}

/**
 * 默认弹药取数（builtin registry 工具路径，mirror fetchWorldPatchesViaTool / fetchExistingArcBeats 先例）。
 * 间隔统计走 mention-query 组合面（S9 双源单源腿：出场账 + 世界状态 + 章摘要窗 → buildAppearanceGapStats）；
 * 弧停滞照旧两路取数。各路独立 graceful：任一路缺只降该路 + 注记，不阻断核实主体。
 *
 * Story 8.7 S9 export：completeness-verify-node L1 计数信号复用同一组合面（fetchAppearanceGapStatsViaTools）；
 * 本函数导出供弹药双源测试直测（fetch seam 惯例，mirror fetchExistingArcBeats）。
 */
export async function fetchAmmoViaTools(
  projectPath: string,
  input: WriterVerifyInput,
): Promise<VerifierAmmo> {
  const degradedReasons: string[] = [];

  let intervals: AppearanceGapStat[] = [];
  const anchor = resolveAnchorStoryTime(
    input.sceneGraph && typeof input.sceneGraph === 'object'
      ? (input.sceneGraph as SceneGraph)
      : undefined,
    input.episodeId,
  );
  if (anchor === undefined) {
    degradedReasons.push('本章开场 storyTime 无法解析（scene_graph 缺或本章无场）');
  } else {
    const face = await fetchAppearanceGapStatsViaTools(projectPath, anchor, {
      cap: AMMO_INTERVAL_CAP,
      minGap: AMMO_INTERVAL_MIN_GAP,
    });
    intervals = face.stats;
    degradedReasons.push(...face.degradedReasons);
  }

  let stagnantArcs: ArcStagnationInfo[] = [];
  const beats = await fetchExistingArcBeats(projectPath);
  const episodeIndex = resolveEpisodeIndex(input.episodeOutlines, input.episodeId ?? '');
  if (beats === undefined) {
    degradedReasons.push('弧节拍查询不可用');
  } else if (episodeIndex === undefined) {
    degradedReasons.push('本章 episodeIndex 无法解析（episode_outlines 缺或不含本章）');
  } else {
    stagnantArcs = detectArcStagnation(beats, episodeIndex);
  }

  return { intervals, stagnantArcs, degradedReasons };
}

// ── 产出映射（机械判定，纯函数——AC-3 测试锚点）──

/**
 * verdict → 写手节点 outcome 三态映射（纯机械，design §1.5）：
 * - verdict.escalate=true → escalate（LLM 判升级信号——矛盾升级语义，已批准偏离不豁免：approvedDeviations
 *   只过滤机械 belt 的偏离亮牌，矛盾归人决断恒升级）。
 * - verdict.pass → pass；否则 → gaps。pass↔gaps 内容一致性由 schema refine **双向**钉死
 *   （research-brief.ts ②pass=true ⇒ gaps 空 / ③pass=false ⇒ gaps 非空——CR-004 补反向红线：
 *   空 gaps 的 pass=false 不可达，gaps 分支恒有非空清单可喂补查回合）。
 * - 简报矛盾/偏离机械 belt 经 applyEscalateBelt（writer-node 单源）——escalate 与 pass 正交
 *   （核查可全过仍需用户决断偏离）。R2-盲2：approvedDeviations（写手节点递入的已批准清单）透传
 *   belt——同偏离（scene_ref+plan_says 对拍）不升级，新偏离照常。
 * **suggestions 不参与**（AC-3：建议存在与否 outcome 不变）。
 */
export function mapVerdictToOutcome(
  brief: ResearchBrief,
  verdict: VerificationVerdict,
  approvedDeviations?: readonly ResearchBriefDeviation[],
): WriterVerificationOutcome {
  if (verdict.escalate === true) {
    return { kind: 'escalate', verdict };
  }
  return applyEscalateBelt(
    brief,
    verdict.pass ? { kind: 'pass', verdict } : { kind: 'gaps', verdict },
    approvedDeviations,
  );
}

// ── 核实子循环工厂 ──

export interface ResearchVerifierDeps {
  /** LLM 生成 seam（mirror AgentLoopDeps.generate——节点注入 + mock 测试）。 */
  generate: GenerateFn;
  /** 工具解析 seam（缺省 builtin registry.get——测试注入 fake 绕开全局单例）。 */
  resolveTool?: (id: string) => ToolDefinition | undefined;
  modelRef?: { keyId: string; modelId: string };
  /**
   * S4b（task 08-25 design §1.2/§2）：档位思考策略——与 modelRef 成对（writer-selfcheck
   * assignment 整体，chapter-chain 装配处归一）。undefined = auto 零行为变化。
   */
  thinking?: ThinkingControl;
  /**
   * S4c（design §4.1「makeAgentLoop 补闸门」）：核实子循环 pre-gate 窗口——selfcheck
   * assignment 的模型 limits（装配处注入）。缺省 undefined → S4a 接收面回落 1M。
   */
  contextWindowTokens?: number;
  /** S4c：压缩红线百分比（chapter-chain 链装配时 readContextPolicy() 现读注入，全局一份）。 */
  redlinePercent?: number;
  signal?: AbortSignal;
  /**
   * 09-12 agy provider（design §3.1 装配点③）：核实子循环的逻辑会话键（chapter-chain
   * 装配 `chain:<childSessionId>:verify`——CR-21 与写手循环 `:writer` 分键）——进核实
   * 子循环 generate opts；'' 与 undefined 同义 = 缺席（单发冷路径，两态纪律）。
   */
  sessionKey?: string;
  /**
   * 09-12 子2 fallback chains（H2 透传面）：writer-selfcheck 档回退链（核实器随自查档
   * assignment——chapter-chain 装配处归一注入）。空链不占位。
   */
  fallbacks?: GenerateFallbackEntry[];
  /**
   * 09-12 usage-panel：任务档位/流程标签（chapter-chain 装配传 'writer-selfcheck'——
   * 核实子循环与写手自查同档）。undefined = 未标注。
   */
  taskType?: string;
  /**
   * 09-12 子2（design §7）：模型切换回调（chapter-chain 装配方注入，补 nodeId/role 转
   * ChainStreamEvent 'model-fallback' 事件）。缺省不传（网关 logger.warn 兜底）。
   */
  onFallback?: (event: { from: { keyId: string; modelId: string }; to: { keyId: string; modelId: string }; reason: string; attempt: number }) => void;
  /**
   * 09-13 子2 W1（design §1 思考流）：核实子循环流回调——**reasoning-only**（verdict 是
   * JSON 产物，text 滤除不上行——mirror writer-node 通道政策「text 仅阶段二」）。chapter-chain
   * 装配注入（补 nodeId/role + phase='research' → workflow onNodeDelta）。缺省不开（零回归）。
   */
  onDelta?: (d: { messageId: string; channel: 'text' | 'reasoning'; delta: string }) => void;
  /**
   * 09-13 子2 W4（design §3）：链内工具调用观测回调（mirror WriterNodeDeps.onToolCall——
   * 核实子循环的只读十三件工具调用上行，同节点位 draft-writer-agent）。chapter-chain 装配
   * 注入（补 nodeId 转 ChainStreamEvent 'chain-tool'）。缺省不开（零回归）。
   * CR 批 CR-11：payload 可携 `nodeId?`（下方 makeAgentLoop deps 注入归属节点位）。
   */
  onToolCall?: (d: { nodeId?: string; toolName: string; inputSummary: string; resultCount: number; status: 'ok' | 'error' }) => void;
  /** 项目路径（弹药取数工具调用 + 核实循环 ToolContext）。 */
  projectPath: string;
  /** 弹药取数 seam（缺省 builtin registry 工具路径——测试注入 fake 免真实 IPC）。 */
  fetchAmmo?: (input: WriterVerifyInput) => Promise<VerifierAmmo>;
  /** 核实轮数上限（缺省 VERIFIER_MAX_ROUNDS=20——测试收窄验熔断，生产不传）。 */
  maxRounds?: number;
}

/** 核实指令（stablePrefix 已携任务卡/简报/弹药——此为核实任务本身的说人话指令）。 */
const VERIFIER_PROMPT = [
  '请对照上方任务卡核查写手的调查简报，判定他是否可以出发动笔：',
  '- 任务卡点名的实体/场是否都有核查记录；关键事实的出处是否真实可查（可抽查）；简报之外你反向找一找',
  '  还缺什么——从任务卡出发想「写这一章不靠猜还需要知道什么」，而不是只看简报里写了什么。',
  '- 发现缺漏 → 填 gaps（缺什么 + 去哪查的线索，不要替写手查好塞内容）；矛盾（任务卡与资料冲突）→',
  '  checklist.contradictions_zero=false 且 escalate=true；设定卡疑似过时/矛盾 → archive_issues。',
  '- 有叙事建议（依据弹药统计）填 suggestions——建议不影响判定，别因建议没用上而压许可。',
  '按系统说明输出核实结果 JSON，输出完另起一行单独写 ' + VERIFIER_STOP_MARKER + '。',
].join('\n');

function verdictRetryPrompt(errorMessage: string): string {
  return [
    `你上次的核实结果无法解析为合法 verdict（错误：${errorMessage}）。`,
    '请对照系统说明检查字段名与格式（pass 必须与四判定一致：全过才 true；pass=false 时 gaps 不得为空），重新输出完整 JSON，末尾另起一行单独写 ' + VERIFIER_STOP_MARKER + '。',
  ].join('\n');
}

/** verdict parse（verificationVerdictSchema——pass↔checklist / pass↔gaps 一致性 refine 在 schema 边界钉死）。 */
function tryParseVerdict(content: string): VerificationVerdict {
  return verificationVerdictSchema.parse(JSON.parse(extractJson(content)));
}

/**
 * 构造资料（核实）员：WriterVerifier seam 的真实现（writer-node deps.verifier 注入；缺省 no-op 由
 * writer-node 自带）。独立上下文子循环——system = retrieval-agent.yaml（agent id 保留不改，design D4，
 * 语义转岗由 prompt 重写承载）；stablePrefix = 任务卡 + 调查简报 + 机械弹药包（yaml user 段三 var）；
 * 工具 = 写手同款只读十三件（同引用自动跟随）；轮数上限独立保险丝（VERIFIER_MAX_ROUNDS）。
 */
export function createResearchVerifier(deps: ResearchVerifierDeps): WriterVerifier {
  const resolveTool = deps.resolveTool ?? ((id: string) => registry.get(id));
  const fetchAmmo = deps.fetchAmmo ?? ((input: WriterVerifyInput) => fetchAmmoViaTools(deps.projectPath, input));
  const maxRounds = deps.maxRounds ?? VERIFIER_MAX_ROUNDS;

  return async (input) => {
    try {
      const { system, userTemplate } = await loadAgentPrompt('retrieval-agent');

      // 工具环境预检（mirror writer-node 边界②）：部分 miss = 接线缺陷（响亮，不静默残缺开跑）；
      // 全 miss = 工具环境不可用 → graceful pass（核实增强缺失，写作照常；R2-盲3 degraded 标记）。
      const missing = VERIFIER_TOOL_IDS.filter((id) => !resolveTool(id));
      if (missing.length === VERIFIER_TOOL_IDS.length) {
        logger.warn('research-verifier: tools unavailable → graceful pass (verification enhancement skipped)');
        return { kind: 'pass', degraded: true };
      }
      if (missing.length > 0) {
        logger.warn(
          { missing },
          'research-verifier: partial tool wiring → graceful pass (拒绝静默残缺工具集开跑核实)',
        );
        return { kind: 'pass', degraded: true };
      }

      const ammo = await fetchAmmo(input);
      // stablePrefix：任务卡 + 简报 + 弹药包（单条 user 消息 = yaml user 段渲染，ADR-4 单契约源）。
      const stablePrefix: SessionMessage[] = [
        {
          id: randomUUID(),
          role: 'user',
          content: renderTemplate(userTemplate, {
            chapterTask: JSON.stringify(input.chapterBrief ?? {}, null, 2),
            researchBrief: JSON.stringify(input.brief, null, 2),
            ammo: buildAmmoText(ammo),
          }),
          createdAt: Date.now(),
        },
      ];

      const result = await runPhaseWithParse({
        buildLoop: (budget) =>
          makeAgentLoop(
            {
              generate: deps.generate,
              resolveTool,
              modelRef: deps.modelRef,
              thinking: deps.thinking,
              signal: deps.signal,
              // 09-12 agy provider CR-23：链 run 会话键随 deps（chapter-chain 装配注入）；
              // '' 视同缺席（与 writer-node / agent-loop 同款 truthy 展开写法）。
              ...(deps.sessionKey ? { sessionKey: deps.sessionKey } : {}),
              // 09-12 子2（H2）：链 + 切换回调透传（空链不占位）。
              ...(deps.fallbacks?.length ? { fallbacks: deps.fallbacks } : {}),
              ...(deps.onFallback ? { onFallback: deps.onFallback } : {}),
              // 09-13 子2 W4（design §3）：链内工具调用观测透传。CR 批 CR-11：携归属节点位——
              // 核实子循环在 draft-writer 节点内跑（无独立链位），事件消费语义沿用
              // draft-writer-agent（与 verifyDeltaEmit 的 phase='research' 归组锚同款——子3
              // 时间线「调查层」与写手自查工具调用同卡归组）。
              ...(deps.onToolCall ? { onToolCall: deps.onToolCall, nodeId: 'draft-writer-agent' } : {}),
              // 09-12 usage-panel：taskType 透传（chapter-chain 装配 'writer-selfcheck'）。
              ...(deps.taskType ? { taskType: deps.taskType } : {}),
              // 09-13 子2 W1（design §1）：思考流透传——reasoning-only（verdict JSON 不开正文流，
              // text 在此滤除；channel 投影归装配侧 withNodeStreaming 形态补 nodeId/role/phase）。
              ...(deps.onDelta
                ? {
                    onDelta: (d: { messageId: string; channel: 'text' | 'reasoning'; delta: string }) => {
                      if (d.channel !== 'reasoning') return;
                      deps.onDelta!(d);
                    },
                  }
                : {}),
            },
            {
              toolIds: [...VERIFIER_TOOL_IDS],
              systemPrompt: system,
              stablePrefix,
              stopMarkers: [VERIFIER_STOP_MARKER],
              maxRounds: budget,
              projectPath: deps.projectPath,
              // S4c pre-gate（S4a AgentLoopConfig 接收面接线）：窗口随 selfcheck assignment，
              // 红线全局一份；undefined 不带字段 = 缺省 1M / 95%。
              ...(deps.contextWindowTokens !== undefined ? { contextWindowTokens: deps.contextWindowTokens } : {}),
              ...(deps.redlinePercent !== undefined ? { redlinePercent: deps.redlinePercent } : {}),
            },
          ),
        firstPrompt: VERIFIER_PROMPT,
        retryPrompt: verdictRetryPrompt,
        budget: maxRounds,
        parse: tryParseVerdict,
      });
      if (!result.ok) {
        // 核实增强缺失（连续工具错误 / verdict parse 两试失败）→ graceful pass（不假 gaps/escalate；
        // R2-盲3 degraded 标记——降级直通非真许可，写手节点不置 verified）。
        logger.warn(
          { kind: result.kind, lastError: result.lastError },
          'research-verifier: verification loop failed → graceful pass (enhancement unavailable)',
        );
        return { kind: 'pass', degraded: true };
      }
      return mapVerdictToOutcome(input.brief, result.value, input.approvedDeviations);
    } catch (err) {
      if (isAbortError(err)) throw err; // 取消语义：传播（writer-node 重抛给 chainRunner）。
      // ToolLoopFuseError（核实子循环熔断）/ loadAgentPrompt 失败 / 未预期 → graceful pass + warn
      // （增强层，不阻断写作；熔断是 bug 保险丝——warn 可观测非静默；R2-盲3 degraded 标记同上）。
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'research-verifier: unexpected error → graceful pass (enhancement unavailable)',
      );
      return { kind: 'pass', degraded: true };
    }
  };
}
