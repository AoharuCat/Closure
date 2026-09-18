import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  CAST_DECLARATION_STOP_MARKER,
  castDeclarationSchema,
  researchBriefDeviationSchema,
  researchBriefSchema,
  researchSuspensionSchema,
  verificationVerdictSchema,
  type CastDeclaration,
  type GenerateFallbackEntry,
  type ResearchBrief,
  type ResearchBriefDeviation,
  type ResearchSuspension,
  type ThinkingControl,
  type VerificationVerdict,
} from '@orison/shared-contracts';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { makeAgentLoop, ToolLoopFuseError, type AgentLoopInput, type AgentLoopResult } from './agent-loop';
import {
  buildDraftWriterVars,
  createDraftWriterNode,
  DRAFT_WRITER_CONTRACT,
  parseDraftOutput,
  readRevisionIntent,
  resolveEpisodeId,
  type ChapterLlmNodeDeps,
} from './chapter-nodes';
import { isAbortError } from './llm-node';
import { extractJson } from './extract-json';
import { loadAgentPrompt } from '../prompt/agentPrompt';
import { renderTemplate } from '../prompt/template';
import { registry } from '../tool/registry';
import { logger } from '../logger';
import type { AgentNode, NodeResult, NodeRunInput, RunSnapshot } from '../contracts/run';
import type { SessionMessage, ToolDefinition } from '../types';

// ── Story 8.4 Step 2/3（A2/A9 + A4-A6，design §1.1 形态 c / §1.2 / §1.3 / §1.5 / §1.6 / §5）：draft-writer 节点 agent 化 + 出发核实回路 ──
//
// 节点内两阶段 agent 循环（形态 c 选定依据：ADR-17 节点柔性明文「draft 节点内部创作行为柔性，允许递归
// 子任务，不锁刚性单 pass」；自查上下文全程同一循环内原文细节零丢失；链段骨架与产物契约零变）：
//
//   阶段一·自查（makeAgentLoop，只读十三件工具）：稳定前缀（任务卡+设定前缀，两阶段逐字节同一份）
//     + 自查指令 → 查询轮（≤ WRITER_MAX_ROUNDS，bug 保险丝非管理）→ stopMarker 收束产出**调查简报**
//     （researchBriefSchema safeParse；parse 失败回错误消息让写手重发，不崩链）。
//   ↓ verifier seam（Step 3 已接：chapter-chain 装配 createResearchVerifier——独立子循环对照任务卡核实
//     简报产 verdict；缺省 no-op 直通供测试/降级路径）。outcome 三态消费：
//     - pass → 存 verdict 进 research_brief artifact + 进阶段二；
//     - gaps → **补查回合**（gaps〔缺什么+出处线索〕附进阶段一续指令，工具继续可用，继续 makeAgentLoop
//       重新收束产新简报 → 再交核实；回合 ≤ WRITER_MAX_VERIFY_ROUNDS，design §1.6）；
//     - escalate / 回合耗尽 → **挂起**（见下「挂起 outcome」）。
//   阶段二·写作（priorMessages = 阶段一 messages〔含补查轮〕，stablePrefix 恒定重携）：产出 draft.initial——
//     {title,text,wordCount,chapterId} 契约**零变**（parseDraftOutput 复用单源，含 7.2 段落级保改前逻辑）。
//   阶段 2.5·出场申报（Story 8.7 design §2.1，同对话续问）：阶段二 parse 成功（正文已到手）后同
//     makeAgentLoop 续一轮——注入申报指令（说人话：交完正文顺手报本章人物表+一句话梗概——谁登场、
//     谁被提及、新称呼归属谁、本章讲了什么），独立收束标记 CAST_DECLARATION_STOP_MARKER；parse 两试
//     mirror PHASE_PARSE_MAX_ATTEMPTS。产物 artifact `cast_declaration`（{declaration, source:'declared'} /
//     降级 {degraded, reason}）。**增强层 graceful（mirror 简报降级哲学）**：申报任何失败形态（parse
//     两试 / 连续工具错误 / LLM 异常 / 熔断）都不碰正文交付——draft 照常返回，cast_declaration 标
//     degraded 可观测，保守账由 S8 mention 汇账的纯代码对拍通道兜底；abort 照常传播（mirror 既有轮
//     处理）。降级直写路径（工具环境不可用）与段落级修订路径不跑申报（无 cast_declaration artifact，
//     S8 处理 undefined）。写手循环对话的最终终止 = 申报标记（PHASE2_STOP_MARKER 从终点降为中间
//     里程碑——阶段二 loop 语义零变，续轮在申报标记处收束）。
//
// **轮数预算 = per-loop 独立保险丝非共享池（BMad CR-010 注释订正）**：阶段一自查（含补查回合，每轮
// runPhaseWithParse 各自持 maxRounds 预算）/ 阶段二写作 / 阶段 2.5 申报**各自独立**以 maxRounds(50)
// 构造 loop——三层是**有意识的分层预算**（design §2.3 三条预算线互不复用：任一层失控不烧掉其他层的
// 剩余额度），worst case 总轮数上限 = 3×50（+补查回合）。注释曾写「预算照旧覆盖（同 budget 保险丝）」
// 与实现不符——50 是单 loop 熔断阈值，正常自查+写作+申报远到不了各自上限。
//
// **阶段推进由节点代码控制**（写手「跳过自查直接写」结构性不可达——非 LLM 自觉）；**修订轮不复走自查**
// （design §1.1 边界：段落级 revision_intent → 降级用单发直写引擎，简报首轮已成立仍有效）；abort 贯穿
// 传播；ToolLoopFuseError 捕获 → error artifact（reason 含 tool_loop_fuse，不静默截断）。
//
// **挂起 outcome（Step 4 落定，A7/A8，design §1.7）**：第 WRITER_MAX_VERIFY_ROUNDS 轮末仍非 pass →
// suspension {kind:'verify_exhausted', gaps}；escalate → suspension {kind:'research_contradiction',
// evidence}。节点行为 = **pause 型节点结果**（非 error artifact——挂起 ≠ 错误，errors 不计）：stateKey
// 'research_brief' 携 suspended 载荷（researchSuspensionSchema，shared 单源）→ chainRunner 记
// completedNodes + fire draft checkpoint → workflow onCheckpoint（decideCheckpointPause 单源）读
// suspended → **全档位 pause（含 auto——结构性矛盾不带病开写，mirror 3.5「BLOCK 永不采信」）**→
// status='paused' + summarize 抽 summary.researchSuspension → write_chapter 文案呈矛盾/缺漏明细 +
// 建议动作（改任务卡/改设定/维持原案→redo 重跑）。恢复 = redo（resumeOptions 不含 continue——挂起时
// draft.initial 不存在，continue 会跳过本节点撞下游 DAG blocked）。挂起原因 + 决断记录落章档案
//（suspension 字段；重入时机械 hash 对比记 decision.cardChanged——语义决断在对话层）。
//
// **briefHash 失效/复用判定（design §1.6 D2）落点说明**：判定=纯代码指纹比对。指纹对象 = 写手**实际收到
// 的编译后任务卡**（run.artifacts['chapter_brief']，brief-compiler-node 产出）——它确定性编译自链段输入
// （leader 任务卡 + scene_graph + 各 creative field），对它取指纹天然覆盖「leader 改了任务卡 / 点名的场·
// 实体集变」两类失效源。编译后 brief 只在链内此汇合点可见（write_chapter 装配点只有 chapter_brief_input），
// 且 leader 工具与 shell IPC 两条写章入口都在本节点汇合——判定落节点即两条入口统一生效。
//
// 章档案（.orison/chapter-archive/<archiveDirName(episodeId)>/research-brief.json——CR-003：目录名 =
// sanitize + 短 hash 后缀防折叠碰撞）：简报 + briefHash + **verified 许可位**
// + **verdict 全量归档**（Step 6 / A3，design §1.9「简报+verdict+最终许可」都留档）存档。episodeId 同 +
// briefHash 同 + verified=true → **复用**已存简报+许可（零重查，D2「复用已存简报+许可」——许可随简报复用，
// 跳过阶段一与核实）；hash 异 / verified 缺或 false（简报产出但核实未过——补查更新 last-wins、挂起后 redo
// 不带旧账复用）→ 作废重查。存档时机 = 阶段一产出即存 verified=false（pause/resume/redo 恢复不重查已完成
// 部分，design §1.7）+ **每次核实产出即存**（verdict last-wins 覆写上一轮，补查回合的最后一轮 verdict 最终
// 保留）+ 核实 pass 后覆写 verified=true（最终许可）；补查产新简报 → 章档案同步覆写（briefHash 不变简报内容
// 变，**last-wins**）。**挂起时**（Step 4）档案加记 suspension 载荷（kind/rounds/证据——挂起原因，末轮 verdict
// 同在档）；**重入时**若上轮档案带 suspension → 机械 hash 对比记 decision {cardChanged, decidedAt}
// （改任务卡→true / 维持原案→false；改设定经编译后 brief 变化同检出）。
//
// **降级（design §5 兼容）**：工具环境不可用（registry 空 / resolveTool 全 miss）→ 节点降级为原单发生成
// 直写路径（复用 createDraftWriterNode 单发引擎，零回归），run.artifacts['research_brief'] 标注 degraded
// （原因 research_tools_unavailable）。阶段一自查失败（连续工具错误 / 简报 parse 两试失败）→ 同降级
// （简报是增强层非硬约束，mirror Director/retrieval graceful 哲学；写手核心交付物是正文）。阶段二失败 →
// error artifact（正文是硬交付物，mirror createLlmNode 兜底，不降级）。
//
// expected_downstream_consumers:
// - Story 8.4 Step 3（A4-A6，已接）：deps.verifier 注入 createResearchVerifier（research-verifier.ts，
//   chapter-chain.ts 装配）；gaps 补查回合 / escalate 挂起 outcome 消费本文件 seam 形态。
// - Story 8.4 Step 4（A7/A8，已接）：suspension 载荷 → decideCheckpointPause（contracts/run.ts 单源）
//   全档位 pause + summarize researchSuspension + write_chapter 决断文案 + batch suspendedSceneIds。
// - Story 8.4 Step 6（A3/A11，已接）：verdict 全量归档进本文件章档案写入链（persistArchive 携
//   latestVerdict + runVerify 核实产出即存）；research_brief artifact 供 Reader-Audit 审核对照
//   （chapter-nodes.ts researchBrief var → findings.attribution 三态归因）。
// - Story 8.7 S8（mention-ledger-node，已接）：cast_declaration artifact 消费——declaration 字段喂
//   resolveCastNames/mergeMentionChannels（shared-contracts 纯函数家族，shell 组装核心调用）+ synopsis
//   回填章摘要；artifact 缺 / degraded 形态（无 declaration 字段）= 保守账（纯代码通道兜底）。重跑
//   入口清 stale 申报（clearStaleCastDeclaration——旧申报不进下游汇账）。

/** 写手自查查询轮上限（A9 bug 保险丝：正常写作远到不了，到了即机械熔断；用户拍板「非管理」）。 */
export const WRITER_MAX_ROUNDS = 50;

/**
 * 出发核实回合上限（design §1.6：交简报→收 verdict→补查→再交，回合 ≤3；第 3 轮末仍非 pass → 挂起
 * 上报）。独立于写手 50 轮与资料员子循环 20 轮（三条预算线互不复用计数，design §2.3）。
 */
export const WRITER_MAX_VERIFY_ROUNDS = 3;

/**
 * 写手只读工具集（design §1.3——全部既有 builtin 工具，仅节点接入，零新注册）。**写工具禁区红线**：
 * 只读十三件（tests 钉死 classifyTool 全 'read'）；世界状态反哺仍走任务卡 #6 编译注入，职责不混。
 * `query_cognition_graph` 含入（写手判「角色此刻知道什么」防信息差笔误）。
 * Story 8.7 S8 追加三件（目录/档案/出场账——「找完整」是自查本职，dispatch 拍板进套）：`catalog_entries`
 * （翻实体目录——有哪些人物/地点/势力条目）、`get_entry`（条目档案下钻）、`query_mentions`（谁在哪些
 * 章出场/被提及——防角色凭空消失的自查材料）。资料员同款（VERIFIER_TOOL_IDS 同引用自动跟随）。
 */
export const WRITER_READONLY_TOOL_IDS = [
  'query_story', // 语义检索（设定/人物/正文段落/章摘要——找剧情不必逐章翻原文，命中带段级出处）
  'query_relations', // 关系网图遍历（结构关联条目）
  'chapter_read', // 读原文章节
  'chapter_list', // 列原文章节
  'query_chapter_summary', // 章状态摘要（到第 N 章发生了什么）
  'query_arc_summary', // 弧审快照（卷摘要 + findings）
  'scene_graph_read', // 场结构（多线叙事图）
  'outline_read', // 大纲
  'query_promise', // 伏笔账（读者债 beats）
  'query_cognition_graph', // 认知图（角色此刻知道什么）
  // Story 8.7 S8：实体目录/档案/出场史三件（记忆完整性索引查询面）。
  'catalog_entries', // 实体目录（有哪些条目 + 出场统计薄行）
  'get_entry', // 条目档案下钻（简述 + 全文 + 出场统计）
  'query_mentions', // 出场账（实体↔章双向 + 间隔统计视图）
] as const;

/** 阶段一收束标记（写手自查完产出简报后在输出末尾单独一行写）。 */
const PHASE1_STOP_MARKER = '<RESEARCH_BRIEF_READY>';
/** 阶段二收束标记（写完正文 JSON 后另起一行写）。 */
const PHASE2_STOP_MARKER = '<DRAFT_READY>';

/** 阶段产物 parse 失败重发上限（初试 + 重发一次，mirror createLlmNode MAX_ATTEMPTS）。 */
const PHASE_PARSE_MAX_ATTEMPTS = 2;

// ── verifier seam（Step 3 已接：chapter-chain 装配 createResearchVerifier；缺省 no-op 直通）──

export interface WriterVerifyInput {
  /** 阶段一产出的调查简报（或复用的存档简报）。 */
  brief: ResearchBrief;
  /** 本章 episodeId（章档案索引；缺省 undefined——无档案索引场景）。 */
  episodeId: string | undefined;
  /** 写手收到的编译后任务卡（chapter_brief artifact，核实判定的对照材料）。 */
  chapterBrief: unknown;
  /** scene_graph artifact（Step 3：资料员机械弹药——本章开场 storyTime 锚 + 弧候选对照）。 */
  sceneGraph?: unknown;
  /** episode_outlines artifact（Step 3：资料员机械弹药——弧停滞信号的 currentEpisodeIndex 解析）。 */
  episodeOutlines?: unknown;
  /**
   * R2-盲2：已批准偏离清单（重跑注入——上轮挂起 + 决断维持原案时从档案 decision.approvedDeviations
   * 递入）。资料员侧 mapVerdictToOutcome 的 belt 调用同过滤（与写手侧 runVerify 单源语义——同偏离
   * 不因 belt 在核实器内部再挂起）。
   */
  approvedDeviations?: readonly ResearchBriefDeviation[];
}

/**
 * 核实结果形态：pass=发许可直通阶段二；gaps=缺漏清单（补查回合——gaps 附进阶段一续指令重查，
 * 回合 ≤ WRITER_MAX_VERIFY_ROUNDS 在本节点循环内维护，design §1.6）；escalate=矛盾/偏离升级
 * （→ 挂起族：Step 4 落定 pause 型结果 + 全档位暂停）。escalate 的 verdict 可选——机械 belt（applyEscalateBelt）
 * 从简报本身判升级时可能无 LLM verdict（证据在简报，design §1.5）。
 *
 * **R2-盲3**：pass 形态可携 `degraded: true` = 核实器 graceful 降级直通（infra 失败——工具环境不可用 /
 * verdict 两试 parse 败 / 熔断；「尝试降级」语义，非真许可）。写手节点对 degraded pass **不置
 * verified**（档案保持 verified=false + verifyDegraded 标记）——降级档案复用时核实重跑（见档案
 * 复用条件注释），杜绝「瞬时故障固化终身许可证」。
 */
export type WriterVerificationOutcome =
  | { kind: 'pass'; verdict?: VerificationVerdict; degraded?: true }
  | { kind: 'gaps'; verdict: VerificationVerdict }
  | { kind: 'escalate'; verdict?: VerificationVerdict };

export type WriterVerifier = (input: WriterVerifyInput) => Promise<WriterVerificationOutcome>;

/** 缺省 no-op：简报存档后直接进阶段二（测试 / 工具环境降级；生产装配注入 createResearchVerifier）。 */
const NOOP_WRITER_VERIFIER: WriterVerifier = async () => ({ kind: 'pass' });

/**
 * 挂起载荷（Step 4 落定）：verify_exhausted = 核实回合耗尽仍有缺漏；research_contradiction = 简报
 * 矛盾/偏离升级（escalate 族）。两族都不带病开写（design §1.7 全档位暂停）。**schema 单源在
 * shared-contracts researchSuspensionSchema**（summarize / write_chapter / chapter_review metadata 共
 * 消费同一形态，B01 纪律）——本别名保 Step 3 起的导入面兼容（research-verifier / 测试 import 本名）。
 */
export type WriterSuspension = ResearchSuspension;

/**
 * 机械 escalate belt（design §1.5，纯代码判定非 LLM）：简报 issues 含 contradiction / deviations 非空 →
 * escalate——写前偏离亮牌与任务卡矛盾必须人决断（1.7 暂停链），不因核查清单全过或宽松核实器（含
 * no-op 缺省）放行，也不消耗三轮回合。verdict.escalate 是核实 LLM 的可选信号，本 belt 对**简报本身**
 * 兜底（写手节点侧机械检查，与核实器实现无关）。research-verifier mapVerdictToOutcome 同判（双保险
 * 单源语义——本函数是权威，纯函数测试双锚）。
 *
 * **R2-盲2（2026-08-19）已批准偏离过滤**：`approvedDeviations`（决断=维持原案时从挂起载荷记档的
 * deviations 清单）中与简报偏离 **scene_ref + plan_says 对拍相同**的项不触发升级（作者已批的是这些
 * 具体偏离）；清单外的新偏离与 contradiction issues **照常升级**——批准的是具体偏离不是通行证。
 * brief_says 不参与对拍（写手复述措辞会漂，锚定「哪场的哪条计划」即偏离身份）。
 */
export function applyEscalateBelt(
  brief: ResearchBrief,
  outcome: WriterVerificationOutcome,
  approvedDeviations?: readonly ResearchBriefDeviation[],
): WriterVerificationOutcome {
  const hasUnapprovedDeviation =
    approvedDeviations === undefined || approvedDeviations.length === 0
      ? brief.deviations.length > 0
      : brief.deviations.some(
          (d) => !approvedDeviations.some((a) => a.scene_ref === d.scene_ref && a.plan_says === d.plan_says),
        );
  const mechanical = brief.issues.some((i) => i.severity === 'contradiction') || hasUnapprovedDeviation;
  if (!mechanical || outcome.kind === 'escalate') return outcome;
  return outcome.verdict !== undefined
    ? { kind: 'escalate', verdict: outcome.verdict }
    : { kind: 'escalate' };
}

// ── 章档案（briefHash 失效/复用判定的存取，design §1.6 D2 / §1.9）──

/** 章档案存档条目（.orison/chapter-archive/<archiveDirName(episodeId)>/research-brief.json）。 */
export interface ArchivedResearchBrief {
  episodeId: string;
  /** 编译后任务卡内容指纹（computeBriefHash）。 */
  briefHash: string;
  brief: ResearchBrief;
  /**
   * 许可位（Step 3）：阶段一产出即存 false（恢复不重查已查部分），核实 pass 后覆写 true（最终许可）。
   * 复用条件之一（episodeId 同 + briefHash 同 + verified=true → 复用简报+许可零重查，D2）——未过核实的
   * 简报（补查更新 last-wins / 挂起后 redo）不得带旧账复用直写。旧档案无此字段 → 视为未核实重查。
   */
  verified: boolean;
  /**
   * R2-盲3（2026-08-19）：**降级核实标记**——本条 verified=false 的来源是核实器 graceful 降级直通
   * （infra 失败「尝试降级」，非真许可也非缺漏挂起）。置位条目走**分裂复用**：briefHash 同 → 简报
   * 复用（跳过自查——没坏只是没核实过）但**核实重跑**；重跑真 pass 后覆写 verified=true（标记随
   * 新条目消失）。杜绝「verdict 两试 parse 失败的 graceful pass 固化终身许可证」（自查+核实+archive_issues
   * 从此永跳）。
   */
  verifyDegraded?: true;
  /**
   * 核实判定全量归档（Step 6 / A3 存档，design §1.9「简报+verdict+最终许可」都留档）：核实的完整
   * checklist/gaps/suggestions/archive_issues（+escalate 可选）。**last-wins 单值非 rounds 历史数组**——
   * 沿 Step 3 既有记录形式（research_brief artifact 记 verifyRounds 计数 + 单条最终 verdict，无逐轮
   * 历史）；每次核实产出即覆写（补查回合的最后一轮 verdict 最终保留），pass 覆写 / gaps 轮 / 挂起轮
   * 的 verdict 都经此落档。机械 belt 拦下的 escalate（无 LLM verdict）与降级 no-op 核实缺省不带。
   * 与 verificationVerdictSchema 单源守形（坏 verdict 的旧档案防御性当损坏处理）。
   */
  verdict?: VerificationVerdict;
  /**
   * 挂起记录（Step 4 / A8）：挂起原因载荷 + 时刻。挂起时随 verified=false 条目写入；重入重查后由
   * 新条目覆盖（last-wins——决断兑现〔新简报核实过〕后 suspension 自然清除）。
   */
  suspension?: ResearchSuspension & { suspendedAt: string };
  /**
   * 决断记录（Step 4 / design §1.7 恢复）：上轮挂起后本次重入的**机械面**决断事实——cardChanged =
   * 上轮 briefHash 与本次是否一致（改任务卡→true；维持原案→false；改设定经编译后 brief 变化同检出）。
   * 语义决断（改了什么/为什么/谁拍板）在对话层（leader chat 是语义记录），此处只记可机械验证的方向。
   * 仅上轮档案带 suspension 时记；随本 run 全部档案写入携带。
   *
   * **R2-盲2（2026-08-19）approvedDeviations**：决断=维持原案（cardChanged=false）→ 挂起载荷
   * `suspension.evidence.deviations` 清单记为**已批准**（用户没改任务卡直接重调 = 对亮牌偏离的放行——
   * 机械绑定语义，见 decisionRecord 计算处注释）；改任务卡/改设定（cardChanged=true）→ 不记
   * （任务卡变了，旧偏离对照物失效，无意义）。重跑时注入写手阶段一指令 + applyEscalateBelt 过滤
   * ——同偏离不再挂起，新偏离照常升级（批准的是具体偏离不是通行证）。
   */
  decision?: {
    cardChanged: boolean;
    decidedAt: string;
    approvedDeviations?: ResearchBriefDeviation[];
  };
  savedAt: string;
}

const archivedResearchBriefSchema = z.object({
  episodeId: z.string().min(1),
  briefHash: z.string().min(1),
  brief: researchBriefSchema,
  verified: z.boolean(),
  verifyDegraded: z.literal(true).optional(),
  verdict: verificationVerdictSchema.optional(),
  suspension: researchSuspensionSchema.extend({ suspendedAt: z.string().min(1) }).optional(),
  decision: z
    .object({
      cardChanged: z.boolean(),
      decidedAt: z.string().min(1),
      approvedDeviations: z.array(researchBriefDeviationSchema).optional(),
    })
    .optional(),
  savedAt: z.string().min(1),
});

/** 章档案读写 seam（缺省 fs 实现；测试注入内存 fake）。 */
export interface WriterArchiveIo {
  read(projectPath: string, episodeId: string): Promise<ArchivedResearchBrief | null>;
  write(projectPath: string, entry: ArchivedResearchBrief): Promise<void>;
}

/**
 * episodeId → 档案目录名安全段（CR-003：sanitize + 短 hash 后缀保唯一）。
 *
 * 旧实现只 sanitize（`[^a-zA-Z0-9_-]`→`_`）防路径穿越不防碰撞：`ep.1` / `ep_1` / `ep 1` / 纯中文 id
 * 同折叠同目录 → persistArchive last-wins 跨章覆写（简报/verdict/suspension/decision 串台 + 复用判定
 * 永久失效，静默难排查）。新名 = `<sanitized>-<sha256(episodeId) 前 8 位>`：同 id 稳定同目录（复用/
 * last-wins 语义不变）；不同 id 必不同目录（hash 随原文）。sanitized 段截 64 字符防超长 id 撑爆路径
 * （截断碰撞由 hash 后缀消解）。**旧档案兼容**：read 先试新名再 fallback 旧名（见 FS_ARCHIVE_IO.read）；
 * write 只写新名——读不到 = 重查（章档案是 DERIVED 可重建，无害）。
 */
export function archiveDirName(episodeId: string): string {
  const sanitized = episodeId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const hash = createHash('sha256').update(episodeId).digest('hex').slice(0, 8);
  return `${sanitized}-${hash}`;
}

/** 旧档案目录名（CR-003 前的 sanitize-only 形态——read fallback 专用，write 不再产）。 */
function legacyArchiveDirName(episodeId: string): string {
  return episodeId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * 稳定序列化（对象 key 字典序递归排布）——同内容不同 key 插入序产出同串，指纹比对不受 key 序漂移影响。
 * undefined 字段剔除（zod parse 后无 undefined，防御 raw 透传形态）。
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = (Object.entries(value as Record<string, unknown>) as Array<[string, unknown]>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 编译后任务卡内容指纹（design §1.6 D2）。sha256 over stableStringify（hash 先例：shell
 * assetCardsIndexer createHash('sha256')；agent 侧 node:crypto 同源）。前缀 `sha256:` 标算法便于未来换。
 */
export function computeBriefHash(chapterBrief: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(chapterBrief)).digest('hex')}`;
}

/** fs 章档案实现（mirror batch-state 的 .orison/ 落盘模式 + 防御式解析：坏文件 → null + warn 不炸）。 */
const FS_ARCHIVE_IO: WriterArchiveIo = {
  async read(projectPath, episodeId) {
    const base = path.join(projectPath, '.orison', 'chapter-archive');
    // CR-003：先试新名（hash 后缀），miss 再 fallback 旧名（sanitize-only）——旧档案零迁移可读；
    // 命中后下次 write 落新名（自然迁移）。两路都 miss → null = 走阶段一重查。R2-盲4：两路命中都
    // 校验 episodeId（旧名折叠目录可能装着**他章**档案——ep.1 fallback 到 ep_1 目录命中 ep_1 的条目，
    // 不校验会拿他章 suspension 触发本章 decisionRecord / briefHash 碰巧相等时用他章简报写本章）。
    const primary = await tryReadArchiveFile(
      path.join(base, archiveDirName(episodeId), 'research-brief.json'),
      episodeId,
    );
    if (primary !== null) return primary;
    return tryReadArchiveFile(
      path.join(base, legacyArchiveDirName(episodeId), 'research-brief.json'),
      episodeId,
    );
  },
  async write(projectPath, entry) {
    const dir = path.join(projectPath, '.orison', 'chapter-archive', archiveDirName(entry.episodeId));
    await mkdir(dir, { recursive: true });
    atomicWriteFileSync(path.join(dir, 'research-brief.json'), JSON.stringify(entry, null, 2), 'utf-8');
  },
};

/**
 * 单档案文件防御式读取：读不到 / 坏 JSON / 坏形态 / **episodeId 不符**（R2-盲4——防旧名折叠目录串台，
 * 当 miss 处理）→ null（坏形态与串台均 warn 可观测，不炸）。
 */
async function tryReadArchiveFile(
  file: string,
  expectedEpisodeId: string,
): Promise<ArchivedResearchBrief | null> {
  try {
    const raw = await readFile(file, 'utf-8');
    const parsed = archivedResearchBriefSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn({ file, issues: parsed.error.issues.length }, 'writer-node: 章档案损坏 → 当无存档重查（删文件可重置）');
      return null;
    }
    if (parsed.data.episodeId !== expectedEpisodeId) {
      logger.warn(
        { file, expectedEpisodeId, actualEpisodeId: parsed.data.episodeId },
        'writer-node: 档案 episodeId 与请求不符（旧名折叠目录串台？）→ 当无存档重查',
      );
      return null;
    }
    return parsed.data;
  } catch {
    return null; // 无存档 / 读失败（首次跑 / 权限）→ null = 走阶段一重查
  }
}

/**
 * dogfood R2 #93（P0-1，2026-08-28）：draft checkpoint 草稿即落章档案——`.orison/chapter-archive/
 * <archiveDirName(episodeId)>/draft-v<N>.md`（与 research-brief.json 同目录，共用 archiveDirName 单源）。
 *
 * 背景：draft checkpoint pause 时正文只在 UI pausedReview（内存）+ in-memory chainSnapshot 里——用户点
 * 「继续写」后审阅卡清除，正文随之蒸发（实录两版 3126 字稿彻底丢失；tool result 只有标题+字数摘要）。
 * 本函数在 draft checkpoint 产出点（workflow.ts onCheckpoint 闭包 stage='draft'）被调，让**每次到达
 * draft checkpoint 的草稿都有一份盘上安全副本**——审阅卡只是视图，正文不依赖 UI 生命周期。
 *
 * 版本号 N = 扫描目录既有 `draft-v<k>.md` 的 max+1：draft checkpoint 只在 draft-writer 真跑后 fire
 * （resume 跳过已完成节点不 refire），故每次 bump 恰对应一轮写作/redo 重跑（design「N = redo 轮次」；
 * from-head 同 briefHash 重跑也会 bump——诚实记录「又写了一版」，无害）。
 *
 * 跳过（返 null）：episodeId 缺（无档案索引，mirror persistArchive `if (!episodeId) return`）/ 正文空
 * （挂起 pause 时 draft.initial 不存在——无稿可存）。写失败 graceful（warn 不破链——档案是安全副本
 * 非硬约束，mirror persistArchive 哲学）。
 *
 * 范式判据（ADR-3）：目录扫描 + 计数 + 写盘 = 纯机械，无语义判断。
 *
 * @returns 写入的文件名（可观测日志用）；跳过/失败返 null。
 */
export async function writeDraftCheckpointArchive(
  projectPath: string,
  episodeId: string | undefined,
  draftText: string,
): Promise<string | null> {
  if (!episodeId || draftText.trim().length === 0) return null;
  const dir = path.join(projectPath, '.orison', 'chapter-archive', archiveDirName(episodeId));
  try {
    await mkdir(dir, { recursive: true });
    let maxVersion = 0;
    try {
      for (const name of await readdir(dir)) {
        const m = /^draft-v(\d+)\.md$/.exec(name);
        if (m) maxVersion = Math.max(maxVersion, Number(m[1]));
      }
    } catch {
      // 目录刚建为空（readdir 竞态）→ maxVersion 保持 0。
    }
    const file = `draft-v${maxVersion + 1}.md`;
    atomicWriteFileSync(path.join(dir, file), draftText, 'utf-8');
    return file;
  } catch (err) {
    logger.warn(
      { episodeId, err: err instanceof Error ? err.message : String(err) },
      'writer-node: draft checkpoint 草稿落章档案失败 → 继续（草稿仍在 chainSnapshot/审阅卡，下次 checkpoint 再试）',
    );
    return null;
  }
}

// ── 阶段指令（说人话双规则：说作用不说实现；工具/prompt 无实现词汇）──

/**
 * 阶段一自查指令。R2-盲2：`approvedDeviations` 非空（上轮挂起 + 决断维持原案的重跑）→ 追加
 * 「已批准偏离」段——告知写手哪些偏离作者已放行、按批准方案写、不再作为偏离申报（消除「唯一出口
 * 是写手不再申报偏离」的制度性激励隐瞒）；清单外新偏离仍须照常亮牌。
 */
function buildPhase1Prompt(approvedDeviations?: readonly ResearchBriefDeviation[]): string {
  const lines = [
    '【第一步·动笔前自查】本章正文还没开始写。先调查，后动笔：',
    '- 你可以使用资料查询工具（见系统说明）核实你需要的材料：人物设定与关系网、旧章正文实际写过什么、章节/弧摘要、场景结构、大纲、伏笔账、角色此刻知道什么、实体目录与条目档案、谁在哪些章出场过（含久未露面者）。',
    '- 查什么、查几轮由你判断——以「写这一章时不靠猜」为准。没有必查清单，也不规定查询顺序。',
    '- 查完后输出「调查简报」：一个 JSON 对象，字段如下——',
    '  - plan：本章写作要点总述（一两句说清你打算怎么写）',
    '  - entries：你查过的条目，每条 { ref: 条目标识, kind: "asset"|"chapter"|"scene"|"promise"|"summary", key_facts: [{ fact: 关键事实, source: 出处 }] }。每条 fact 的 source 必填（第几章 / 哪张卡 / 哪个摘要）——写不出出处的关键事实不要收录。',
    '  - issues：调查中发现的问题 [{ desc: 问题描述, severity: "info"|"warn"|"contradiction" }]。任务卡与资料矛盾之处用 contradiction。',
    '  - execution_plan：写作执行案，本章每场一条 [{ scene_ref: 场 id, beat_coverage: 该场要覆盖的节拍, notes: 节奏与落笔要点 }]。引用场编号即可，不要抄大纲原文。',
    '  - deviations：写前偏离亮牌 [{ scene_ref, plan_says: 计划怎么写, brief_says: 你打算怎么写, reason: 理由 }]。无偏离给空数组。',
    '只输出简报 JSON（可以有 markdown 代码围栏），输出完另起一行单独写 ' + PHASE1_STOP_MARKER + '。这一步不要写正文。',
  ];
  if (approvedDeviations !== undefined && approvedDeviations.length > 0) {
    lines.push('');
    lines.push('【已批准的偏离（作者已决断）】以下偏离此前已亮牌并经作者批准维持你的方案——写作时按 brief_says 的方案处理，**不再作为偏离重复申报**：');
    for (const d of approvedDeviations) {
      lines.push(`- 场 ${d.scene_ref}：计划是「${d.plan_says}」→ 已批准按「${d.brief_says}」写（理由：${d.reason}）`);
    }
    lines.push('此清单之外新发现的偏离，仍须照常在 deviations 里亮牌申报。');
  }
  return lines.join('\n');
}

function briefRetryPrompt(errorMessage: string): string {
  return [
    `你上次的调查简报无法解析为合法简报（错误：${errorMessage}）。`,
    '请对照第一步指令检查字段名与格式（尤其 key_facts 每条 fact 都要有非空 source），重新输出完整简报 JSON，末尾另起一行单独写 ' + PHASE1_STOP_MARKER + '。',
  ].join('\n');
}

function phase2Prompt(brief: ResearchBrief): string {
  return [
    '【第二步·动笔】调查已收束，简报已存档。现在撰写本章完整正文：',
    '- 按任务卡目标与你的调查简报执行案写；简报里亮牌的偏离项按你亮牌的方案处理。',
    '- 正文与输出格式要求见上方任务卡末尾（title/text/wordCount/chapterId 的 JSON 对象）。',
    '- 写完在 JSON 之后另起一行单独写 ' + PHASE2_STOP_MARKER + '。',
    // Story 8.7 申报预告（预期管理，说人话）：写手知道交完正文还会被问人物表——先把正文写完，
    // 不在写作轮抢跑申报（抢跑会让正文轮 content 混两段 JSON 致 parse 失败多烧重试）。
    '- 交完正文后我会再向你问一份本章人物表（谁登场、谁被提到、本章讲了什么），到时顺手报一下即可——现在先把正文写完。',
    '',
    '【你的调查简报（存档回执）】',
    JSON.stringify(brief),
  ].join('\n');
}

/**
 * 阶段 2.5 申报轮指令（Story 8.7 design §2.1）：正文已交后的同对话续问——写手对自己刚写的这一章
 * 顺手交人物表 + 一句话梗概（生成者对自家产物的申报，LLM 语义；漏报由纯代码对拍通道兜底）。
 * 格式说明风格 mirror 阶段一简报指令（字段逐条说人话 + 例子就地解释；特殊名词「登场/被提及」
 * 就地区分——本人露面 vs 只在对话叙述里被提到）。
 */
function castDeclarationPrompt(): string {
  return [
    '【第三步·顺手报本章人物表】正文已收到，本章写作完成。最后交一份「本章人物申报」——你对自己',
    '刚写的这一章的自报登记（谁出场了、谁被提到了、本章讲了什么），供作者翻阅出场记录；不是考核，',
    '照你写的如实报即可：',
    '- 输出一个 JSON 对象，字段如下——',
    '  - synopsis：本章一段话梗概（写给刚读完本章的读者听的那种，一两句讲清本章发生了什么）。',
    '    例：「林昭与江白在城门分手后各自遇袭，双双负伤入城。」',
    '  - present：本章正式登场（本人露面）的人物与重要实体名单，每条 { name: 正文里使用的名字, card: 归属 }。',
    '    name 填正文实际使用的称呼（可用绰号，不必是人物卡上的正式名）；用了新称呼/绰号时 card 必填',
    '    （填这个名字指的那张人物卡的名或 id，例：name「三师叔」card「李玄」）；名字就是人物卡名的可不填 card。',
    '  - mentioned：本章只在对话或叙述里被提到、本人没露面的名单，每条 { name: 被提到的名字, belongsTo: 归属 }。',
    '    新称呼的归属必填（例：name「三师叔」belongsTo「李玄」）；一听就知道指谁的既有名字可不填。',
    '- 本章无人登场或无人被提及时，对应名单给空数组；synopsis 不能是空白。',
    '- 只输出申报 JSON（可以有 markdown 代码围栏），输出完另起一行单独写 ' + CAST_DECLARATION_STOP_MARKER + '。',
  ].join('\n');
}

function castDeclarationRetryPrompt(errorMessage: string): string {
  return [
    `你上次的本章人物申报无法解析为合法申报（错误：${errorMessage}）。`,
    '请对照第三步指令检查字段名与格式（尤其 synopsis 不能为空白），重新输出完整申报 JSON，末尾另起一行单独写 ' + CAST_DECLARATION_STOP_MARKER + '。',
  ].join('\n');
}

/**
 * 补查回合续指令（design §1.6 补查循环）：gaps（缺什么+出处线索）附进阶段一续指令——写手自己补查
 * （一手原则：资料员只给线索不代查塞货），查完重新收束产**新简报**（全量重出，非增量 patch——
 * 简报是阶段收束产物，全量保 schema 完整 + 存档 last-wins 简单）。
 */
function gapFollowUpPrompt(gaps: VerificationVerdict['gaps']): string {
  const lines = gaps.map((g) => `- ${g.desc}（线索：${g.source_hint}）`).join('\n');
  return [
    '【出发核查缺漏——补查】独立核查员对照任务卡复查了你的调查简报，发现以下缺漏：',
    lines,
    '请用查询工具补查以上条目（线索仅供参考，以你自己查到的为准），然后**重新输出完整的调查简报 JSON**',
    '（在原简报基础上补全，含新查到的条目与事实），输出完另起一行单独写 ' + PHASE1_STOP_MARKER + '。这一步仍不要写正文。',
  ].join('\n');
}

/**
 * 挂起节点结果（Step 4 形态：**pause 型**，非 error——挂起 ≠ 错误，RunSnapshot errors 不计）。
 * stateKey = 'research_brief'（producedArtifactKeys may-produce 已声明），artifact = research_brief 槽
 * 全量（含 suspended 载荷）。chainRunner 记 completedNodes + fire draft checkpoint → workflow
 * onCheckpoint（decideCheckpointPause 单源）读 suspended → **全档位 pause**（mirror 7.2
 * revision-guard verdict 驱动动态 pause 先例——非 mode 驱动静态 pauseStages）。恢复 = redo
 * （挂起时 draft.initial 不存在，continue 会跳过本节点撞下游 DAG blocked）。
 */
function suspensionResult(
  nodeId: string,
  suspension: WriterSuspension,
  researchArtifact: Record<string, unknown>,
): NodeResult {
  logger.warn(
    { nodeId, kind: suspension.kind, rounds: suspension.rounds },
    'writer-node: 出发核实挂起 → pause 型节点结果（draft checkpoint 全档位暂停）',
  );
  return { stateKey: 'research_brief', artifact: researchArtifact };
}

function draftRetryPrompt(errorMessage: string): string {
  return [
    `你上次的正文输出无法解析为有效 JSON（错误：${errorMessage}）。`,
    '请只输出符合任务卡输出要求的纯 JSON 对象（不要解释文字、markdown 围栏或多余内容），写完另起一行单独写 ' + PHASE2_STOP_MARKER + '。',
  ].join('\n');
}

// ── 阶段 runner：loop + parse 重发 + 跨重试累计轮数预算 ──
//
// Story 8.4 Step 3 export：research-verifier（资料员核实子循环的 verdict parse 重发）复用同一
// runner——「loop 跑到 stopMarker → parse 失败回错误消息重发 + 跨重试预算累计」是共用模式，单源防漂移。

export interface PhaseRunOk<T> {
  ok: true;
  value: T;
  /** 本阶段新增消息（含重发轮；不含 stablePrefix——续阶段作 priorMessages 传回）。 */
  messages: SessionMessage[];
  rounds: number;
}
export interface PhaseRunFailed {
  ok: false;
  kind: 'consecutive_errors' | 'parse_failed';
  messages: SessionMessage[];
  rounds: number;
  lastError?: string;
}

/**
 * 单阶段执行：makeAgentLoop 跑到 stopMarker / 回合自然结束 → parse；parse 失败回错误 user 消息重发
 * （mirror createLlmNode CR-5 error-feedback 重试，非 blind-retry）；重发轮数计入同一预算
 * （每 attempt 以剩余预算重构造 loop——makeAgentLoop 的 maxRounds 是构造时参数），耗尽抛
 * ToolLoopFuseError。consecutive_errors（mirror runLoop 连续错误中断）原样上交 caller 裁决
 * （阶段一=降级 / 阶段二=error artifact）。
 */
export async function runPhaseWithParse<T>(args: {
  buildLoop: (maxRounds: number) => (input: AgentLoopInput) => Promise<AgentLoopResult>;
  firstPrompt: string;
  retryPrompt: (errorMessage: string) => string;
  priorMessages?: SessionMessage[];
  budget: number;
  parse: (content: string) => T;
}): Promise<PhaseRunOk<T> | PhaseRunFailed> {
  let accumulated: SessionMessage[] | undefined = args.priorMessages;
  let used = 0;
  let lastError = '';
  for (let attempt = 1; attempt <= PHASE_PARSE_MAX_ATTEMPTS; attempt += 1) {
    const remaining = args.budget - used;
    if (remaining < 1) throw new ToolLoopFuseError(args.budget);
    const result = await args.buildLoop(remaining)({
      userPrompt: attempt === 1 ? args.firstPrompt : args.retryPrompt(lastError),
      priorMessages: accumulated,
    });
    used += result.rounds;
    accumulated = [...(accumulated ?? []), ...result.messages];
    if (result.status === 'consecutive_errors') {
      return { ok: false, kind: 'consecutive_errors', messages: accumulated, rounds: used };
    }
    try {
      const value = args.parse(result.content);
      return { ok: true, value, messages: accumulated, rounds: used };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, kind: 'parse_failed', messages: accumulated ?? [], rounds: used, lastError };
}

/** 简报 parse（researchBriefSchema——出处锚定强制等结构红线在 schema 边界钉死，shared-contracts 单源）。 */
function tryParseBrief(content: string): ResearchBrief {
  return researchBriefSchema.parse(JSON.parse(extractJson(content)));
}

/**
 * 申报 parse（castDeclarationSchema——synopsis trim 非空等红线在 schema 边界钉死，shared-contracts
 * 单源，Story 8.7 S1 落地）。失败抛错 → runPhaseWithParse 回错误消息重发一次（两试后 graceful）。
 */
function tryParseCastDeclaration(content: string): CastDeclaration {
  return castDeclarationSchema.parse(JSON.parse(extractJson(content)));
}

// ── 节点 deps ──

/**
 * 09-13 子2 W1（design §1 H2 定案）：写手节点流载荷——phase union（'research' = 阶段一
 * 自查/补查 + 核实子循环、'writing' = 阶段二写作、'declaration' = 阶段 2.5 出场申报）+
 * channel 双通道。子3「写作三层」模板（思考+调查+正文流）靠 phase 区分调查思考与写作
 * 思考。additive union：旧消费形态（只认 'writing'+text）照旧。
 */
export interface WriterNodeDeltaPayload {
  phase: 'research' | 'writing' | 'declaration';
  channel: 'text' | 'reasoning';
  messageId: string;
  delta: string;
}

export interface WriterNodeDeps extends ChapterLlmNodeDeps {
  /**
   * C3.2 任务路由：自查档模型（Phase1 自查/补查回合用；design §2 writer-selfcheck 档）。
   * 缺省 fallback = deps.modelRef（= writer-draft 档）——直构测试 / 未拆档装配两阶段同模型的既有行为。
   */
  selfcheckModelRef?: { keyId: string; modelId: string };
  /**
   * S4b（task 08-25 design §1.2）：自查档思考策略——与 selfcheckModelRef **成对**（同一
   * assignment 归一，chapter-chain 装配处 `selfcheck ?? draft` 回退取整 assignment，不出现
   * selfcheck 模型 + draft 思考策略的杂交）。缺省 fallback = deps.thinking（同 selfcheckModelRef
   * 的回退语义）。
   */
  selfcheckThinking?: ThinkingControl;
  /**
   * S4c（task 08-25 design §4.1「makeAgentLoop 补闸门」）：draft 档模型上下文窗口——Phase2
   * 写作 / 2.5 申报循环 pre-gate 判定用（chapter-chain 装配处按 assignment limits 注入）。
   * 缺省 undefined → S4a 接收面回落 1M。
   */
  contextWindowTokens?: number;
  /**
   * S4c：selfcheck assignment 窗口——Phase1 自查/补查循环 pre-gate 用。与 selfcheckModelRef/
   * selfcheckThinking 同 assignment 成对；直构形态缺省 fallback = deps.contextWindowTokens
   *（mirror selfcheckModelRef 的 `?? deps.modelRef` 回退语义）。
   */
  selfcheckContextWindowTokens?: number;
  /**
   * S4c：压缩红线百分比（50~100，缺省 95）——chapter-chain 链装配时 readContextPolicy() 现读
   * 注入，两阶段 + 核实循环共用（红线是全局策略非 per-slot）。
   */
  redlinePercent?: number;
  /** 工具解析 seam（缺省 builtin registry.get——测试注入 fake 绕开全局单例）。 */
  resolveTool?: (id: string) => ToolDefinition | undefined;
  /**
   * 09-12 agy provider（design §3.1 装配点②）：写手 agent 循环的逻辑会话键（chapter-chain
   * 装配 `chain:<childSessionId>:writer`——CR-21 与核实子循环 `:verify` 分键）。两阶段
   * 循环（自查/写作/申报）同键进 generate opts；'' 与 undefined 同义 = 缺席（单发冷路径，
   * 两态纪律）。声明在 WriterNodeDeps 而非 LlmNodeDeps——单发 llm-node 族结构性忽略。
   */
  sessionKey?: string;
  /**
   * 09-12 子2 fallback chains（H2 透传面）：writer-draft 档回退链——Phase2 写作/2.5 申报
   * 循环 + 降级直写引擎（legacy createLlmNode 面，ChapterLlmNodeDeps.fallbacks 继承）
   * 消费。Phase1 自查走 selfcheckFallbacks（assignment 粒度，不杂交）。
   */
  fallbacks?: GenerateFallbackEntry[];
  /**
   * 09-12 子2：writer-selfcheck 档回退链（与 selfcheckModelRef/selfcheckThinking 同
   * assignment 成对——chapter-chain 装配处 `selfcheck ?? draft` 回退取整）。直构形态
   * 缺省 fallback = deps.fallbacks（mirror selfcheckModelRef 的 `?? deps.modelRef`）。
   */
  selfcheckFallbacks?: GenerateFallbackEntry[];
  /**
   * 09-12 子2（design §7）：模型切换回调——两阶段循环 + 核实子循环的 onFallback 发射面
   *（chapter-chain 装配方注入，补 nodeId/role 转 ChainStreamEvent 'model-fallback' 事件）。
   * 缺省不传（直构测试零事件；网关 logger.warn 兜底）。
   */
  onModelFallback?: (event: { from: { keyId: string; modelId: string }; to: { keyId: string; modelId: string }; reason: string; attempt: number }) => void;
  /** 核实 seam（缺省 no-op 直通；Step 3 注入资料员核实子循环）。 */
  verifier?: WriterVerifier;
  /** 章档案 IO seam（缺省 .orison/chapter-archive fs 实现——测试注入内存 fake）。 */
  archiveIo?: WriterArchiveIo;
  /** ISO 时间源（档案 savedAt；缺省 new Date()——测试注入固定值）。 */
  nowISO?: () => string;
  /** 查询轮上限（缺省 WRITER_MAX_ROUNDS=50——测试收窄验熔断，生产不传）。 */
  maxRounds?: number;
  /**
   * dogfood T1 Stage 6（design §4 / r1 甄别）→ 09-13 子2 W1 全相位开流（design §1 H2
   * 签名定格）：写手节点流回调——reasoning 双通道全相位转发；**text 通道维持「仅阶段二
   * 写作」**（正文流语义与既有 UI 解信封依赖不变，design §1「text 不扩」——阶段一自查
   * 简报 / 补查 / 阶段 2.5 申报是 JSON 产物，裸 text 不上行）。phase 标注按调用相位
   * （research/writing/declaration，WriterNodeDeltaPayload）。降级直写引擎（工具环境不可
   * 用 / 段落级修订走 legacy 单发）不调用——caller 按 phase 字段区分。
   * 缺省不开（测试 / 非流式车道零事件，零回归）。
   */
  onNodeDelta?: (data: WriterNodeDeltaPayload) => void;
  /**
   * 09-13 子2 W4（design §3）：链内工具调用观测回调——写手三循环（自查/补查/写作/申报）经
   * makeAgentLoop deps.onToolCall 发射（工具调用不分相位，循环全阶段同回调）；降级直写引擎
   * （createLlmNode 形态 tools=[]）零调用零事件。chapter-chain 装配注入（补 nodeId 转
   * ChainStreamEvent 'chain-tool'）。缺省不开（测试 / 非流式车道零事件，零回归）。
   * CR 批 CR-11：payload 可携 `nodeId?`（buildLoop 注入节点位常量，agent-loop 发射并入——
   * 装配侧 wrapper 读透传值不硬编码）。
   */
  onToolCall?: (d: { nodeId?: string; toolName: string; inputSummary: string; resultCount: number; status: 'ok' | 'error' }) => void;
}

// ── 节点 ──

/**
 * draft-writer agent 化节点（链装配位 'draft-writer-agent'，chapter-chain.ts）。三路径：
 * 1. 段落级 revision_intent → 单发直写引擎（修订轮不复走自查，design §1.1 边界）。
 * 2. 只读工具集全 miss → 降级单发直写 + research_brief 标 degraded（design §5，零回归）。
 * 3. 两阶段 agent 循环：自查产简报（briefHash 复用/作废判定 + 章档案存档）→ verifier seam → 写作产
 *    draft.initial（契约零变）。
 */
export function createWriterNode(deps: WriterNodeDeps): AgentNode {
  const legacy = createDraftWriterNode(deps); // 降级/段落级直写引擎（零行为变化）
  const resolveTool = deps.resolveTool ?? ((id: string) => registry.get(id));
  const verifier = deps.verifier ?? NOOP_WRITER_VERIFIER;
  const archiveIo = deps.archiveIo ?? FS_ARCHIVE_IO;
  const nowISO = deps.nowISO ?? (() => new Date().toISOString());
  const maxRounds = deps.maxRounds ?? WRITER_MAX_ROUNDS;
  const nodeId = 'draft-writer-agent';

  return {
    contract: DRAFT_WRITER_CONTRACT,
    async run(input: NodeRunInput): Promise<NodeResult> {
      const { run } = input;

      // 边界①：段落级改稿（revision_intent 带 scope.anchor）→ 修订轮不复走自查（design §1.1 边界：
      // 环内改稿基于编译意图修稿（targeted-revision 退役后 = C1 意图 + 写手 directive 重跑），简报首轮
      // 已成立仍有效；新实体靠写完审核+实体归并兜底）。
      // 整章 redo（无 anchor，含 structuralEdit-only / revisionFeedback）不走此分支——走 D2 失效判定。
      // CR-002：legacy 直写前清 stale suspended——段落级修复 = 用户已决断继续写，悬挂态与它互斥；
      // 残留 suspended 会被 decideCheckpointPause presence 判定在 draft checkpoint 再 pause（成环死路）。
      // Story 8.7 S8：同时清 stale cast_declaration——本路径不跑申报（阶段 2.5 仅两阶段路径），旧申报
      // 残留会被下游 mention-ledger 当新鲜申报消费（保守账语义要求「无申报」如实传递）。
      const intent = readRevisionIntent(run.artifacts['revision_intent']);
      if (intent?.scope?.anchor) {
        clearStaleSuspension(run, '段落级修复（legacy 直写）');
        clearStaleCastDeclaration(run, '段落级修复（legacy 直写）');
        return legacy.run(input);
      }

      // 边界②：只读工具集解析。全 miss = 工具环境不可用（测试 registry 空 / 接线缺失）→ 降级直写（§5）；
      // 部分 miss = 接线缺陷（builtin 注册不齐）→ 响亮 error artifact（mirror makeAgentLoop「不静默缺工具
      // 开跑」——自查能力面暗中残缺不可接受）。
      // BMad CR-003（2026-08-19）：降级直写入口同样清 stale cast_declaration——与另两入口（段落级修订 /
      // 两阶段主路径）同构的清理不变式：本路径不跑申报（阶段 2.5 依赖工具环境），resume/redo 场景 snapshot
      // 带上一轮申报时，旧申报会被下游 mention-ledger 当新鲜申报消费（stale synopsis 回填 + full 档账）。
      const missing = WRITER_READONLY_TOOL_IDS.filter((id) => !resolveTool(id));
      if (missing.length === WRITER_READONLY_TOOL_IDS.length) {
        clearStaleCastDeclaration(run, '工具环境不可用降级直写');
        clearStaleSuspension(run, '工具环境不可用降级直写');
        markResearchDegraded(run, 'research_tools_unavailable');
        return legacy.run(input);
      }
      if (missing.length > 0) {
        const message = `draft-writer 只读工具集接线缺失：${missing.join(', ')}（registry 未解析到，检查 builtin 注册）`;
        logger.error({ nodeId, missing }, 'writer-node: partial tool wiring → error artifact');
        return { stateKey: nodeId, artifact: { error: true, nodeId, message } };
      }

      // ── 两阶段主路径 ──
      try {
        // CR-002 belt：入口清 stale suspended（resume 场景 snapshot 可能带上一轮挂起载荷；本 run 的
        // 复用/首查分支都是全新对象赋值不 spread stale，但入口先清使「重跑必不带旧悬挂」成为节点级
        // 不变式——workflow 装配层 belt 之外的第二道）。本 run 若真再挂起，末尾全新 suspended 载荷覆盖。
        // Story 8.7 S8：同点位清 stale cast_declaration（重跑必不带旧申报——新申报由本 run 阶段 2.5
        // 全新写入 / 降级标注覆盖；两条 belt 同点位，mirror clearStaleSuspension）。
        clearStaleSuspension(run, '两阶段重跑入口');
        clearStaleCastDeclaration(run, '两阶段重跑入口');
        const { system, userTemplate } = await loadAgentPrompt(nodeId);
        // 稳定前缀（design §1.2）：任务卡+设定前缀（含改稿反馈/意图 directive）单条 user 消息，两阶段
        // 逐字节同一份——为 C 系列 provider prompt 缓存铺路但不依赖它。vars 抽取与降级路径单源
        // （buildDraftWriterVars）。
        const stablePrefix: SessionMessage[] = [{
          id: randomUUID(),
          role: 'user',
          content: renderTemplate(userTemplate, buildDraftWriterVars(run)),
          createdAt: Date.now(),
        }];
        // C3.2 任务路由：写手双档拆分（design §2）——modelRef 参数按 phase 取值：Phase1 自查/补查传
        // selfcheckModelRef（writer-selfcheck 档，含缺省 fallback deps.modelRef），Phase2 写作/2.5 申报
        // 用缺省 deps.modelRef（writer-draft 档）。8.4 红线不变：只换模型来源，两阶段流程/收束标记/
        // parse 行为零改动。
        const selfcheckModelRef = deps.selfcheckModelRef ?? deps.modelRef;
        // S4b：自查思考策略同对回退（selfcheck ?? draft assignment 整体——模型与策略同源，
        // design §1.2「不杂交」）。chapter-chain 装配处已按 assignment 粒度回退，此处的
        // `?? deps.thinking` 只覆盖「装配处未传 selfcheckThinking」的直构/测试形态。
        const selfcheckThinking = deps.selfcheckThinking ?? deps.thinking;
        // S4c：自查循环窗口同对回退（同上——assignment 粒度回退在装配处，此处兜直构形态）。
        const selfcheckWindowTokens = deps.selfcheckContextWindowTokens ?? deps.contextWindowTokens;
        // 09-12 子2：自查档回退链同对回退（mirror selfcheckModelRef 的 `?? deps.modelRef`
        // 语义——装配处已按 assignment 粒度回退，此处兜直构/测试形态）。
        const selfcheckFallbacks = deps.selfcheckFallbacks ?? deps.fallbacks;
        // 09-13 子2 W1（design §1）：全相位开流——各相位回调工厂。reasoning 双通道全放行；
        // **text 通道维持「仅阶段二」**（allowText——JSON 阶段裸 text 无意义且会污染正文流
        // 车道语义）。phase 标注：阶段一/补查 = 'research' / 阶段二 = 'writing' / 申报 =
        // 'declaration'（WriterNodeDeltaPayload union；核实子循环的 'research' 在装配侧
        // 标注——chapter-chain verifier onDelta 接线）。messageId 是 makeAgentLoop 预分配的
        // 轮 assistantId（UI 轮次分段既有机制，channel 维度免费搭车）。
        const makePhaseOnDelta = deps.onNodeDelta
          ? (phase: 'research' | 'writing' | 'declaration', allowText: boolean) => {
              const emit = deps.onNodeDelta!;
              return (d: { messageId: string; channel: 'text' | 'reasoning'; delta: string }) => {
                if (!allowText && d.channel === 'text') return;
                emit({ phase, channel: d.channel, messageId: d.messageId, delta: d.delta });
              };
            }
          : undefined;
        const writingOnDelta = makePhaseOnDelta?.('writing', true);
        const researchOnDelta = makePhaseOnDelta?.('research', false);
        const declarationOnDelta = makePhaseOnDelta?.('declaration', false);
        const buildLoop = (
          stopMarker: string,
          modelRef: { keyId: string; modelId: string } | undefined = deps.modelRef,
          onDelta?: (d: { messageId: string; channel: 'text' | 'reasoning'; delta: string }) => void,
          thinking: ThinkingControl | undefined = deps.thinking,
          contextWindowTokens: number | undefined = deps.contextWindowTokens,
          // 09-12 子2（H2）：链随 phase 的 assignment（Phase1 = selfcheck 档链，Phase2/2.5 =
          // draft 档链）——缺省 deps.fallbacks 覆盖直构形态，装配处显式传 selfcheck 链。
          fallbacks: GenerateFallbackEntry[] | undefined = deps.fallbacks,
          // 09-12 usage-panel：taskType 随 phase（Phase1 自查/补查 = 'writer-selfcheck'，
          // Phase2 写作/2.5 申报 = 缺省 deps.taskType〔= chapter-chain llmDepsFor('writer-draft')〕
          // ——与 modelRef 的 per-phase 取值同型）。
          taskType: string | undefined = deps.taskType,
        ) => (budget: number) =>
          makeAgentLoop(
            {
              generate: deps.generate,
              resolveTool,
              modelRef,
              thinking,
              taskType,
              signal: deps.signal,
              // 09-12 agy provider CR-23：链 run 会话键随 deps（chapter-chain 装配注入）——
              // 两阶段循环（自查/写作/申报）同键进 generate opts；'' 视同缺席（与
              // research-verifier / agent-loop 同款 truthy 展开写法，'' 与 undefined 一致）。
              ...(deps.sessionKey ? { sessionKey: deps.sessionKey } : {}),
              ...(onDelta ? { onDelta } : {}),
              // 09-12 子2（H2）：链 + 切换回调透传（空链不占位）。
              ...(fallbacks?.length ? { fallbacks } : {}),
              ...(deps.onModelFallback ? { onFallback: deps.onModelFallback } : {}),
              // 09-13 子2 W4（design §3）：链内工具调用观测透传（phase 无关——直接读 deps，
              // 不作 buildLoop 参数）。CR 批 CR-11：携节点位元数据（上方 nodeId 常量——
              // agent-loop 发射并入载荷，装配侧 wrapper 读透传值不硬编码）。
              ...(deps.onToolCall ? { onToolCall: deps.onToolCall, nodeId } : {}),
            },
            {
              toolIds: [...WRITER_READONLY_TOOL_IDS],
              systemPrompt: system,
              stablePrefix,
              stopMarkers: [stopMarker],
              maxRounds: budget,
              projectPath: run.projectPath,
              // S4c pre-gate（S4a AgentLoopConfig 接收面接线）：窗口随本 loop 所用 assignment，
              // 红线全局一份；undefined 不带字段 = 缺省 1M / 95%。
              ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
              ...(deps.redlinePercent !== undefined ? { redlinePercent: deps.redlinePercent } : {}),
            },
          );

        // briefHash 失效/复用判定（D2，纯代码指纹比对）。
        const chapterBrief = run.artifacts['chapter_brief'];
        const episodeId = resolveEpisodeId(run.artifacts['chapter_brief_input']);
        const briefHash = computeBriefHash(chapterBrief);
        // 核实输入公料（Step 3：scene_graph/episode_outlines 供资料员机械弹药，已在 run.artifacts 内零新取数）。
        const verifyInput = {
          episodeId,
          chapterBrief,
          sceneGraph: run.artifacts['scene_graph'],
          episodeOutlines: run.artifacts['episode_outlines'],
        };

        let brief: ResearchBrief | undefined;
        let priorMessages: SessionMessage[] | undefined;
        /** Step 4（design §1.7 恢复）：上轮挂起后本次重入的机械决断方向（hash 对比；语义决断在对话层）。 */
        let decisionRecord: ArchivedResearchBrief['decision'] | undefined;
        /**
         * Step 6（A3 存档，design §1.9）：最近一次核实的 verdict（**last-wins**——核实产出即覆写，补查回合
         * 的最后一轮 verdict 最终保留；补查简报更新落档时携上一轮 verdict 直到下轮核实覆写）。所有档案
         * 写入点共用（persistArchive 闭包捕获）——「简报+verdict+最终许可」同一写入链，不另开文件。
         */
        let latestVerdict: VerificationVerdict | undefined;
        /**
         * R2-盲2（2026-08-19）：已批准偏离清单——上轮挂起 + 决断**维持原案**（cardChanged=false）时从
         * 挂起载荷 `suspension.evidence.deviations` 记档并注入本轮（阶段一指令段 + escalate belt 过滤
         * + 核实器 belt 同过滤）。机械绑定语义：用户重调 write_chapter 而编译后任务卡未变 = 对当时亮牌
         * 偏离的放行（挂起文案已呈偏离明细；改任务卡/改设定会改 briefHash 走 cardChanged=true 分支不记）
         * ——决断「维持原案」不再结构性死循环（写手再亮同偏离被 belt 再挂起、唯一出口成了「不再申报
         * 偏离」的制度性激励隐瞒）。
         */
        let approvedDeviations: readonly ResearchBriefDeviation[] | undefined;
        /** R2-盲3：full-reuse（verified 档案复用）跳过核实——与分裂复用（只跳自查）区分。 */
        let skipVerification = false;
        /** R2-盲3：分裂复用标记（verifyDegraded 档——简报复用 + 核实重跑）。 */
        let reuseUnverified = false;
        /** 自查轮累计（阶段一 + 各补查轮；分裂复用起跑 = 0——无自查轮）。 */
        let researchRounds = 0;

        /** 简报落章档案（verified 许可位随核实时态；失败不破链——复用优化失效，下次重查，warn 可观测）。
         *  extras.suspension = 挂起原因载荷（Step 4：挂起时随条目记档）；extras.verifyDegraded = R2-盲3
         *  降级核实标记（graceful pass 不置许可——档案标「曾降级」，下轮分裂复用核实重跑）；
         *  decisionRecord（上轮挂起重入的机械决断方向）+ latestVerdict（Step 6 verdict 全量归档）随本
         *  run 全部写入携带。 */
        const persistArchive = async (
          theBrief: ResearchBrief,
          verified: boolean,
          extras?: { suspension?: ArchivedResearchBrief['suspension']; verifyDegraded?: true },
        ): Promise<void> => {
          if (!episodeId) return;
          try {
            await archiveIo.write(run.projectPath, {
              episodeId,
              briefHash,
              brief: theBrief,
              verified,
              savedAt: nowISO(),
              ...(extras?.verifyDegraded === true ? { verifyDegraded: true } : {}),
              ...(latestVerdict !== undefined ? { verdict: latestVerdict } : {}),
              ...(extras?.suspension !== undefined ? { suspension: extras.suspension } : {}),
              ...(decisionRecord !== undefined ? { decision: decisionRecord } : {}),
            });
          } catch (err) {
            logger.warn(
              { episodeId, err: err instanceof Error ? err.message : String(err) },
              'writer-node: 简报章档案写入失败 → 继续写作（下次将重查）',
            );
          }
        };

        /** 单轮出发核实 + verdict 归档（Step 6：**核实产出即存**——每次核实的 verdict 即时落档覆写上一轮，
         *  last-wins；pass/挂起终态的后续 persistArchive 覆写 verified/suspension 但 verdict 同源不漂移）。
         *  R2-盲2：approvedDeviations 递入（belt 过滤已批准项 + 核实器输入同携——其 mapVerdictToOutcome
         *  的 belt 调用同过滤，两侧 belt 单源语义不漂移）。 */
        const runVerify = async (theBrief: ResearchBrief): Promise<WriterVerificationOutcome> => {
          const outcome = await verifier({
            brief: theBrief,
            ...verifyInput,
            ...(approvedDeviations !== undefined ? { approvedDeviations } : {}),
          });
          latestVerdict = outcome.verdict;
          await persistArchive(theBrief, false);
          return applyEscalateBelt(theBrief, outcome, approvedDeviations);
        };

        if (episodeId) {
          const archived = await archiveIo.read(run.projectPath, episodeId);
          if (archived) {
            // 上轮挂起重入（Step 4）：记机械决断方向——改任务卡/改设定（编译后 brief 变）→ cardChanged=true；
            // 维持原案 → false。无论方向，verified=false（挂起条目恒未获许可）→ 不复用 → 重查（D2）。
            if (archived.suspension !== undefined) {
              const cardChanged = archived.briefHash !== briefHash;
              // R2-盲2：决断=维持原案（cardChanged=false）→ 挂起载荷 deviations 清单记为**已批准**
              // （用户看过挂起文案呈的偏离明细、未改任务卡直接重调 = 放行；改卡/改设定走 cardChanged=true
              // 不记——任务卡变了旧偏离对照物失效）。批准清单随 decisionRecord 落档 + 注入本轮 belt/指令。
              const approved =
                !cardChanged ? (archived.suspension.evidence?.deviations ?? []) : [];
              decisionRecord = {
                cardChanged,
                decidedAt: nowISO(),
                ...(approved.length > 0 ? { approvedDeviations: approved } : {}),
              };
              if (approved.length > 0) approvedDeviations = approved;
              logger.info(
                { episodeId, cardChanged, approvedCount: approved.length, priorKind: archived.suspension.kind },
                'writer-node: 上轮挂起重入 → 记决断方向 + 作废重查（维持原案时偏离清单记已批准）',
              );
            }
            // 复用条件三项：episodeId 同 + briefHash 同 + verified=true（D2「复用已存简报+许可」——许可随
            // 简报复用，跳过阶段一与核实零重查；verified 缺/false = 简报未获许可〔补查 last-wins 中 /
            // 挂起后 redo〕→ 不复用，作废重查——挂起的章不得带旧账直写）。
            if (archived.briefHash === briefHash && archived.verified) {
              const parsed = researchBriefSchema.safeParse(archived.brief);
              if (parsed.success) {
                brief = parsed.data;
                skipVerification = true;
                priorMessages = [{
                  id: randomUUID(),
                  role: 'user',
                  content: [
                    '【上轮调查简报（复用）】本章任务卡与上轮一致，上轮调查与出发许可仍然有效，直接进入写作：',
                    JSON.stringify(brief),
                  ].join('\n'),
                  createdAt: Date.now(),
                }];
                // CR-005：复用轮回填 archived.verdict——summarize 的 archiveIssues 抽取读
                // research_brief.verdict，不回填则档案议题在复用轮静默蒸发（两轮呈现不一致，
                // 违「机械记账不靠自觉」）。有则带（旧档/机械 belt 档无 verdict 时缺省）。
                run.artifacts['research_brief'] = {
                  brief,
                  briefHash,
                  reused: true,
                  verified: true,
                  ...(archived.verdict !== undefined ? { verdict: archived.verdict } : {}),
                };
                logger.info({ episodeId }, 'writer-node: briefHash 未变且已获许可 → 复用存档简报（跳过自查与核实）');
              }
            } else if (archived.briefHash === briefHash && archived.verifyDegraded === true) {
              // R2-盲3 分裂复用：**降级核实档案**（graceful pass 未置 verified + verifyDegraded 标记）——
              // 简报没坏只是没核实过 → 复用简报**跳过自查**，但**核实重跑**（复用判定三条件不满足，
              // 「曾降级」档案不固化终身许可证；重跑真 pass 后覆写 verified=true）。archive_issues 等
              // 核实产物也随之恢复产出。
              const parsed = researchBriefSchema.safeParse(archived.brief);
              if (parsed.success) {
                brief = parsed.data;
                reuseUnverified = true;
                priorMessages = [{
                  id: randomUUID(),
                  role: 'user',
                  content: [
                    '【上轮调查简报（复用）】本章任务卡与上轮一致，上轮调查简报可直接复用（上轮出发核实未能完成，本次动笔前将重新核实）：',
                    JSON.stringify(brief),
                  ].join('\n'),
                  createdAt: Date.now(),
                }];
                run.artifacts['research_brief'] = {
                  brief,
                  briefHash,
                  reused: true,
                  verifyDegraded: true,
                  ...(archived.verdict !== undefined ? { verdict: archived.verdict } : {}),
                };
                logger.info({ episodeId }, 'writer-node: 降级档案分裂复用 → 简报复用（跳过自查）+ 核实重跑（R2-盲3）');
              }
            }
          }
        }

        if (!brief) {
          // 阶段一·自查（收束产物 = 调查简报）。R2-盲2：approvedDeviations 非空（维持原案重跑）→
          // 指令附「已批准偏离」段（按批准方案写、不再重复申报——消除激励隐瞒）。
          // 09-13 子2 W1：researchOnDelta 注入（reasoning-only——调查思考流，text 滤）。
          const phase1 = await runPhaseWithParse({
            buildLoop: buildLoop(PHASE1_STOP_MARKER, selfcheckModelRef, researchOnDelta, selfcheckThinking, selfcheckWindowTokens, selfcheckFallbacks, 'writer-selfcheck'),
            firstPrompt: buildPhase1Prompt(approvedDeviations),
            retryPrompt: briefRetryPrompt,
            budget: maxRounds,
            parse: tryParseBrief,
          });
          if (!phase1.ok) {
            // 自查降级（增强层 graceful，mirror Director/retrieval 哲学）：连续工具错误 / 简报 parse 两试
            // 失败 → 单发直写 + degraded 标注（非静默——artifact + warn 可观测）。
            markResearchDegraded(
              run,
              phase1.kind === 'consecutive_errors' ? 'research_consecutive_errors' : 'research_brief_parse_failed',
            );
            return legacy.run(input);
          }
          brief = phase1.value;
          priorMessages = phase1.messages;
          researchRounds = phase1.rounds;
          // 简报存档（episodeId 有则落章档案，verified=false）——阶段一产出即存：pause/resume/redo 恢复
          // 不重查已查部分（design §1.7）；最终许可 pass 后覆写 verified=true。
          await persistArchive(brief, false);
          run.artifacts['research_brief'] = { brief, briefHash, rounds: researchRounds };
        }

        if (!skipVerification) {
          // ── 出发核实 + 补查回合（design §1.5/§1.6；回合 ≤ WRITER_MAX_VERIFY_ROUNDS 在本循环维护，
          //    与写手 50 轮 / 资料员子循环 20 轮互不复用计数）。每次核实经 applyEscalateBelt 机械兜底
          //    （简报矛盾/偏离 → escalate，不消耗回合；R2-盲2 已批准偏离过滤）+ verdict 归档（runVerify：
          //    核实产出即存 last-wins）。R2-盲3：full-reuse（skipVerification）零重查；分裂复用
          //    （reuseUnverified）与首查共用本段——priorMessages 已由复用回执填充。──
          let verification = await runVerify(brief);
          let verifyRounds = 1;
          let followUpFailed: PhaseRunFailed | undefined;
          while (verification.kind === 'gaps' && verifyRounds < WRITER_MAX_VERIFY_ROUNDS) {
            // 补查回合：gaps（缺什么+出处线索）附进阶段一续指令，工具继续可用（继续 makeAgentLoop），
            // 重新收束产新简报 → 再交核实。
            const followUp: PhaseRunOk<ResearchBrief> | PhaseRunFailed = await runPhaseWithParse({
              buildLoop: buildLoop(PHASE1_STOP_MARKER, selfcheckModelRef, researchOnDelta, selfcheckThinking, selfcheckWindowTokens, selfcheckFallbacks, 'writer-selfcheck'),
              firstPrompt: gapFollowUpPrompt(verification.verdict.gaps),
              retryPrompt: briefRetryPrompt,
              priorMessages,
              budget: maxRounds,
              parse: tryParseBrief,
            });
            if (!followUp.ok) {
              // 补查失败（连续工具错误 / 简报 parse 两试败）→ 挂起族（verify_exhausted）：核实已介入，
              // 不可静默绕过带病开写（区别于阶段一首跑失败的增强层降级——那时核实尚未介入）。
              followUpFailed = followUp;
              break;
            }
            brief = followUp.value;
            priorMessages = followUp.messages;
            researchRounds += followUp.rounds;
            // 简报更新 → 章档案 last-wins 同步（briefHash 不变简报内容变——存档覆写，verified 仍 false；
            // latestVerdict 为上一轮 verdict，下一轮核实产出即覆写）。artifact spread 保留 reused /
            // verifyDegraded 标记（分裂复用轮的补查不丢身份）。
            await persistArchive(brief, false);
            run.artifacts['research_brief'] = {
              ...(run.artifacts['research_brief'] as Record<string, unknown>),
              brief,
              briefHash,
              rounds: researchRounds,
              verifyRounds,
            };
            verification = await runVerify(brief);
            verifyRounds += 1;
          }

          // verdict / 回合数如实入 artifact（挂起与 pass 两族都记——可观测）。
          run.artifacts['research_brief'] = {
            ...(run.artifacts['research_brief'] as Record<string, unknown>),
            verifyRounds,
            ...(verification.verdict !== undefined ? { verdict: verification.verdict } : {}),
          };

          if (followUpFailed || verification.kind === 'gaps') {
            // 第 3 轮末仍非 pass（或补查失败产不出可核实简报）→ 挂起：verify_exhausted（上报 leader+
            // 用户，挂起该章；批量模式由 write_chapter 标 suspendedSceneIds 继续他章）。
            const suspension: WriterSuspension = {
              kind: 'verify_exhausted',
              rounds: verifyRounds,
              gaps: verification.verdict?.gaps ?? [],
            };
            (run.artifacts['research_brief'] as Record<string, unknown>).suspended = suspension;
            // 挂起原因落章档案（Step 4：suspension 载荷 + 时刻——重入时记 decision 方向）。
            await persistArchive(brief, false, {
              suspension: { ...suspension, suspendedAt: nowISO() },
            });
            return suspensionResult(nodeId, suspension, run.artifacts['research_brief'] as Record<string, unknown>);
          }
          if (verification.kind === 'escalate') {
            // 矛盾/偏离升级 → 挂起：research_contradiction（design §1.7 全档位暂停——结构性问题不带病
            // 开写）。evidence = 简报机械证据 + verdict（资料员 LLM 判定）。
            const suspension: WriterSuspension = {
              kind: 'research_contradiction',
              rounds: verifyRounds,
              evidence: {
                contradictions: brief.issues.filter((i) => i.severity === 'contradiction'),
                deviations: brief.deviations,
                verdict: verification.verdict,
              },
            };
            (run.artifacts['research_brief'] as Record<string, unknown>).suspended = suspension;
            await persistArchive(brief, false, {
              suspension: { ...suspension, suspendedAt: nowISO() },
            });
            return suspensionResult(nodeId, suspension, run.artifacts['research_brief'] as Record<string, unknown>);
          }

          // pass：最终许可——verdict 入 artifact + 章档案覆写 verified=true（最终态 last-wins）。
          // R2-盲3：**graceful pass（degraded=true）不置 verified**——「尝试降级」：核实器 infra 失败的
          // 直通非真许可，档案保持 verified=false + verifyDegraded 标记（下轮分裂复用：简报可复用但
          // 核实重跑）——杜绝瞬时故障固化终身许可证（自查/核实/archive_issues 从此永跳）。
          if (verification.kind === 'pass' && verification.degraded === true) {
            (run.artifacts['research_brief'] as Record<string, unknown>).verifyDegraded = true;
            await persistArchive(brief, false, { verifyDegraded: true });
            logger.warn(
              { episodeId, rounds: verifyRounds, reuseUnverified },
              'writer-node: 核实器降级直通（graceful pass）→ 不置许可位（下轮核实重跑，R2-盲3）',
            );
          } else {
            (run.artifacts['research_brief'] as Record<string, unknown>).verified = true;
            await persistArchive(brief, true);
          }
        }

        // 阶段二·写作（priorMessages = 阶段一 messages〔含补查轮〕/ 复用回填；stablePrefix 恒定重携）。
        // dogfood T1 Stage 6 → 09-13 子2 W1：writingOnDelta 注入——本阶段 generate 轮增量经
        // onNodeDelta 上行（text 正文流 + reasoning 思考流；runChapterChain 包装成 chain-delta
        // 事件——text 正文流语义与 r1 甄别前完全一致）。
        const phase2 = await runPhaseWithParse({
          buildLoop: buildLoop(PHASE2_STOP_MARKER, undefined, writingOnDelta),
          firstPrompt: phase2Prompt(brief),
          retryPrompt: draftRetryPrompt,
          priorMessages,
          budget: maxRounds,
          parse: (content) => parseDraftOutput(content, run),
        });
        if (!phase2.ok) {
          // 正文是硬交付物：不降级，error artifact（mirror createLlmNode 两试失败兜底）。
          const detail = phase2.lastError ? `：${phase2.lastError}` : '';
          const message = `draft-writer 阶段二（写作）失败（${phase2.kind}${detail}）`;
          logger.error({ nodeId, kind: phase2.kind }, 'writer-node: phase 2 failed → error artifact');
          return { stateKey: nodeId, artifact: { error: true, nodeId, message } };
        }

        // ── 阶段 2.5·出场申报（Story 8.7 design §2.1：同对话续问，增强层 graceful）──
        // 正文已到手（phase2.value 在手不受任何影响）；同 makeAgentLoop 续一轮收束在
        // CAST_DECLARATION_STOP_MARKER（写手对话的最终终止点）。申报任何失败形态都不碰正文交付
        // （mirror 简报降级哲学——申报是增强层非硬约束）；abort 照常传播不吞。artifact 经
        // run.artifacts mutate 写（NodeResult 单 stateKey='draft.initial' 先例，mirror research_brief
        // / revision_guard——chainRunner :177 单 key 赋值不覆盖其他 key）。
        try {
          const declarationPhase = await runPhaseWithParse({
            // 09-13 子2 W1：declarationOnDelta 注入（reasoning-only——申报思考流；modelRef
            // 显式 undefined = 缺省 deps.modelRef〔writer-draft 档，Phase2/2.5 同档既有语义〕）。
            buildLoop: buildLoop(CAST_DECLARATION_STOP_MARKER, undefined, declarationOnDelta),
            firstPrompt: castDeclarationPrompt(),
            retryPrompt: castDeclarationRetryPrompt,
            priorMessages: phase2.messages,
            budget: maxRounds,
            parse: tryParseCastDeclaration,
          });
          if (declarationPhase.ok) {
            run.artifacts['cast_declaration'] = { declaration: declarationPhase.value, source: 'declared' };
            logger.info(
              {
                nodeId,
                present: declarationPhase.value.present.length,
                mentioned: declarationPhase.value.mentioned.length,
              },
              'writer-node: 出场申报收束 → cast_declaration artifact',
            );
          } else {
            // parse 两试败 / 连续工具错误 → graceful 缺失（保守账由 S8 纯代码对拍通道兜底）。
            markCastDeclarationDegraded(
              run,
              declarationPhase.kind === 'consecutive_errors'
                ? 'cast_declaration_consecutive_errors'
                : 'cast_declaration_parse_failed',
            );
          }
        } catch (err) {
          if (isAbortError(err)) throw err; // 取消语义照常传播（mirror 既有轮处理）
          // LLM 异常（网络等）/ 熔断 → 同 graceful：正文已在手，申报缺失不崩链不吞稿。
          markCastDeclarationDegraded(
            run,
            err instanceof ToolLoopFuseError ? 'cast_declaration_fuse' : 'cast_declaration_llm_failed',
          );
        }
        return phase2.value;
      } catch (err) {
        if (isAbortError(err)) throw err; // 取消语义：传播，不吞成 error artifact
        if (err instanceof ToolLoopFuseError) {
          // A9 熔断：报错不静默（RunSnapshot errors 呈现 tool_loop_fuse——bug 保险丝定位）。
          const message = `写手查询循环熔断（tool_loop_fuse）：${err.message}`;
          logger.error({ nodeId }, 'writer-node: tool loop fuse → error artifact');
          return { stateKey: nodeId, artifact: { error: true, nodeId, message } };
        }
        // 未预期错误 → error artifact（链段不崩，mirror createLlmNode 兜底姿态）。
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ nodeId, err: message }, 'writer-node: unexpected error → error artifact');
        return { stateKey: nodeId, artifact: { error: true, nodeId, message } };
      }
    },
  };
}

/** 降级标注：research_brief artifact 槽位记 {degraded, reason}（RunSnapshot 可观测，design §5）。 */
function markResearchDegraded(run: RunSnapshot, reason: string): void {
  run.artifacts['research_brief'] = { degraded: true, reason };
  logger.warn({ reason }, 'writer-node: 自查降级 → 单发直写（research_brief 标 degraded）');
}

/**
 * 申报降级标注（Story 8.7 design §2.1，mirror markResearchDegraded）：cast_declaration artifact 槽位记
 * {degraded, reason}——可观测的「本章无申报」（S8 消费端据 declaration 字段缺失落保守账，非静默）。
 */
function markCastDeclarationDegraded(run: RunSnapshot, reason: string): void {
  run.artifacts['cast_declaration'] = { degraded: true, reason };
  logger.warn({ reason }, 'writer-node: 出场申报降级 → 无申报（保守账由纯代码对拍通道兜底）');
}

/**
 * 清 stale 申报载荷（Story 8.7 S8，mirror clearStaleSuspension CR-002 哲学）：重跑本节点但不产新申报的
 * 路径（段落级修订 legacy 直写）会留上一轮的 cast_declaration 在 snapshot artifacts——mention-ledger
 * 在链下游会把它当**本章新鲜申报**消费（stale synopsis 回填 + full 档账）。悬挂态与「本节点重跑」互斥：
 * 重跑 = 旧申报对旧正文失效；本 run 若真再申报（阶段 2.5 / 降级标注）会写入全新载荷（本函数只删旧不清新
 * ——调用点都在重跑入口，先于任何新载荷写入）。
 */
function clearStaleCastDeclaration(run: RunSnapshot, where: string): void {
  if (run.artifacts['cast_declaration'] !== undefined) {
    delete run.artifacts['cast_declaration'];
    logger.info({ where }, 'writer-node: 清 stale cast_declaration（旧申报与本轮重跑互斥）');
  }
}

/**
 * 清 stale 挂起载荷（CR-002）：decideCheckpointPause 对 `research_brief.suspended` 做 presence 判定
 * （字段在即全档位 pause）——resume/redo 重跑本节点时，上一轮的 suspended 若残留，draft checkpoint 会
 * 用**旧**矛盾证据再次 pause（与新正文/新简报同卡呈现），resume-continue belt 又强制重跑 → 成环死路。
 * 悬挂态与「本节点重跑」互斥：重跑 = 用户已决断继续（段落级修复/维持原案重查/改卡重查），本轮若真再
 * 挂起会写入**全新** suspended 载荷（本函数只删旧不清新——调用点都在重跑入口，先于任何新载荷写入）。
 * 只删 suspended 字段不动其余（brief/verdict 等记录仍有效，summarize archiveIssues 等照常消费）。
 */
function clearStaleSuspension(run: RunSnapshot, where: string): void {
  const research = run.artifacts['research_brief'] as { suspended?: unknown } | undefined;
  if (research !== undefined && research.suspended !== undefined) {
    delete research.suspended;
    logger.info({ where }, 'writer-node: 清 stale research_brief.suspended（悬挂态与本轮重跑互斥）');
  }
}
