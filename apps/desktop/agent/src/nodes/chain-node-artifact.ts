import type { ChainNodeArtifactFindingRow, ChainNodeArtifactSummary } from '../types';
import type { ChainNodeDef, NodeResult, NodeRunInput, RunSnapshot } from '../contracts/run';
import { recountDraftWordCount } from './chapter-nodes';
import { FEEDBACK_LEDGER_ARTIFACT_KEYS } from '@orison/shared-contracts';
import { logger } from '../logger';

// ── 09-13 子2 W3（design §2）：节点产出快照（chain-node-artifact）投影装配 ──
//
// 发射机制：装配处统一包装（withNodeArtifact——chapter-chain.ts createChapterChainNodes 尾部
// 对全链 23 节点 map 应用；buildExtractionSegment 消费方 reExtractChapter 不传发射回调 = 零包装，
// mirror onNodeDelta 缺省零回归）。包装在**节点 run 终态后**从返回 artifact 机械投影产 summary——
// **不侵入节点实现**（快照是投影非节点职责）；唯一例外 = promise-emergence（登记动作 items 需要
// actions 原始清单，节点 artifact 形态不敷投影 → 节点侧 additive 补字段 `actions?`，注明于该文件）。
//
// 发射时序（AC2 顺序结构性保证）：包装内 run 返回/抛错后先发本事件再 return/rethrow →
// chainRunner 的 onNodeDone('done'/'error') 恒在其后；blocked 终态节点 run 不被调（DAG 前置拦截），
// 由 chainRunner blocked 分支经 onNodeBlocked 发通用行（先于 onNodeDone('blocked')）。
//
// 投影守卫（design §7 风险表）：全部 unknown 安全读取（recordOf 防御）+ project 调用外层
// try/catch 降级 line『（快照缺失）』不造数据 + 发射失败静默（可观测性绝不破节点行为）。
// abort（AbortError）不是失败——不发光栅（run 级哨兵 aborted 帧归 workflow）。
//
// 量控（design §6 + CR 批 CR-1 统一）：items 封顶 50 / findings rows 封顶 50（total 保全量）/
// 全部自由字符串字段截断 200（与 agent-loop.ts 既有 200 字 + '…' 先例同形——免两套常数形态）/
// brief-card 整对象尺寸守卫 8K（超限降级 line——唯一整对象下发的 kind 不再无界）。
//
// expected_downstream_consumers:
// - workflow.ts runChapterChain：onNodeArtifact 包装（补 seq 快照转 ChainStreamEvent）+
//   onNodeBlocked（blocked 通用行，role 经 chainNodeArtifactRoleOf 解析）+
//   onVerdictOverwritten（CR-3 覆写重发，经 emitChainNodeArtifactFor）。
// - 子3（UI 写作页时间线）：产出卡数据源（五 kind 模板）。UI 镜像类型见
//   client/ui/src/shared/store/chainStreamBuffer.ts。

/** 装配层发射回调（workflow 注入——补 seq 快照后转 chain-node-artifact 事件）。 */
export type ChainNodeArtifactEmit = (data: {
  nodeId: string;
  role: string;
  summary: ChainNodeArtifactSummary;
}) => void;

/** 单节点投影函数：run 终态后从 (run.artifacts, NodeResult) 机械投影 summary。 */
export type NodeArtifactProjector = (
  run: RunSnapshot,
  result: { stateKey: string; artifact: unknown },
) => ChainNodeArtifactSummary;

/** items / findings rows 封顶（design §6 量控——total 字段保全量计数）。 */
export const CHAIN_ARTIFACT_ITEMS_CAP = 50;
/** 文本截断上限（agent-loop.ts:609 既有先例同形：`slice(0, 200) + '…'`）。 */
export const CHAIN_ARTIFACT_TEXT_CAP = 200;
/**
 * brief-card 整对象尺寸守卫（CR 批 CR-1）：brief 是唯一整对象下发的 kind（此前 §6 量控唯一豁免）
 * ——JSON.stringify 超本上限降级 line『任务卡过大（N 字符）已省略展示』，事件载荷不再无界。
 */
export const CHAIN_ARTIFACT_BRIEF_CARD_CHAR_CAP = 8192;

// ── 通用 helper（unknown 安全读取）──

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function strOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function truncate(text: string, cap: number = CHAIN_ARTIFACT_TEXT_CAP): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function rowsCapped(rows: ChainNodeArtifactFindingRow[]): { findings: ChainNodeArtifactFindingRow[]; total: number } {
  return { findings: rows.slice(0, CHAIN_ARTIFACT_ITEMS_CAP), total: rows.length };
}

/** 投影缺字段降级行（不造数据——design §7 风险表）。 */
const MISSING_SUMMARY: ChainNodeArtifactSummary = { kind: 'line', line: '（快照缺失）' };

/** error artifact 判定（mirror chainRunner isErrorArtifact——M4 前置守卫同判据）。 */
function isErrorArtifactShape(artifact: unknown): boolean {
  return Boolean(artifact && typeof artifact === 'object' && (artifact as { error?: unknown }).error === true);
}

/**
 * M4 通用终态行：error 终态（error artifact / 节点 throw 合成形态）→ line `节点失败：message 截断`。
 * 时间线 error 节点有产出痕迹而非「快照缺失」。
 */
export function errorChainNodeArtifactLine(artifact: unknown): ChainNodeArtifactSummary {
  const message = strOf(recordOf(artifact)?.message) || 'unknown error';
  return { kind: 'line', line: `节点失败：${truncate(message)}` };
}

/**
 * M4 通用终态行：blocked 终态（DAG requiredArtifactKeys 缺失——节点 run 未被调，无 artifact
 * 可投影）→ line `节点受阻：chainRunner blocked message 截断`。
 */
export function blockedChainNodeArtifactLine(message: string): ChainNodeArtifactSummary {
  return { kind: 'line', line: `节点受阻：${truncate(message)}` };
}

// ── 逐节点投影（design §2 发射形态表 18 行 → 23 节点全覆盖）──

const briefCompilerProjector: NodeArtifactProjector = (_run, result) => {
  const brief = recordOf(result.artifact);
  if (!brief) return MISSING_SUMMARY;
  // CR 批 CR-1：brief-card 尺寸守卫——唯一整对象下发的 kind 此前豁免量控；超限降级 line
  //（N 字符注明），时间线保「任务卡过大」痕迹而非载荷无界。
  const size = JSON.stringify(brief).length;
  if (size > CHAIN_ARTIFACT_BRIEF_CARD_CHAR_CAP) {
    return { kind: 'line', line: `任务卡过大（${size} 字符）已省略展示` };
  }
  return { kind: 'brief-card', brief };
};

const briefReviewerProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  const rows = (Array.isArray(rec.findings) ? rec.findings : []).flatMap((f) => {
    const fr = recordOf(f);
    if (!fr) return [];
    return [
      {
        label: truncate(strOf(fr.dimension)),
        severity: strOf(fr.severity) || 'soft',
        quote: truncate(strOf(fr.grounding)),
        note: truncate(strOf(fr.note)),
      },
    ];
  });
  return {
    kind: 'findings',
    ...(strOf(rec.verdict) ? { verdict: truncate(strOf(rec.verdict)) } : {}),
    summary: truncate(strOf(rec.summary)),
    ...rowsCapped(rows),
  };
};

const revisionOptimizerProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  if (rec.optimizer_failed === true) {
    return { kind: 'line', line: `意图编译失败：${truncate(strOf(rec.message) || 'unknown error')}` };
  }
  if (rec.optimizerNoOp === true) {
    return { kind: 'line', line: `直通（${truncate(strOf(rec.reason) || 'no-op')}）` };
  }
  const changeSummary = strOf(recordOf(rec.change)?.summary);
  if (!changeSummary) return MISSING_SUMMARY;
  // CR-4 后形态：scope.anchor 由机械定位构造——anchored（选区改稿）/ anchorless（引文不可定位
  // 降级整章，guard skip 语义）两档附注。
  const anchored = recordOf(recordOf(rec.scope)?.anchor) !== undefined;
  return {
    kind: 'line',
    line: anchored
      ? `选区改稿意图：${truncate(changeSummary)}`
      : `整章改稿意图：${truncate(changeSummary)}（引文不可定位降级）`,
  };
};

const draftWriterProjector: NodeArtifactProjector = (_run, result) => {
  // 挂起形态（Story 8.4 Step 4）：stateKey='research_brief'（pause 型——出发核查矛盾/耗尽，
  // draft.initial 未产）。两阶段完成/降级直写均返 draft.initial。
  if (result.stateKey === 'research_brief') {
    const suspended = recordOf(recordOf(result.artifact)?.suspended);
    if (!suspended) return MISSING_SUMMARY;
    return {
      kind: 'line',
      line: `出发核查挂起：${truncate(strOf(suspended.kind) || 'unknown')}（${numCount(suspended.rounds)} 回合）`,
    };
  }
  const draft = recordOf(result.artifact);
  if (!draft) return MISSING_SUMMARY;
  const passage = strOf(draft.passageText);
  if (passage.trim().length > 0) {
    return { kind: 'line', line: `段落级修订产出：${recountDraftWordCount(passage)} 字（待保义护栏 splice）` };
  }
  const words =
    typeof draft.wordCount === 'number' && draft.wordCount > 0
      ? draft.wordCount
      : recountDraftWordCount(strOf(draft.text));
  const title = strOf(draft.title);
  // CR 批 CR-1：title 插值截断（LLM 产物无界——超长章名不进事件载荷）。
  return { kind: 'line', line: `整章交付${title ? `《${truncate(title)}》` : ''}：${words} 字` };
};

const revisionGuardProjector: NodeArtifactProjector = (run, result) => {
  // clean 路径 stateKey='draft.initial'（guard 报告 mutate 进 run.artifacts['revision_guard']——
  // mutate 在 return 前完成，投影读得到）；soft-violation 路径 result 本体即 guard 报告
  //（hard-violation 是 error artifact——前置守卫先拦走通用行）。
  const guard = recordOf(run.artifacts['revision_guard']) ?? recordOf(result.artifact);
  const verdict = strOf(guard?.verdict);
  if (!guard || !verdict) return MISSING_SUMMARY;
  const findingsCount = Array.isArray(guard.findings) ? guard.findings.length : 0;
  const marks: string[] = [];
  if (guard.skipped === true) marks.push('整章路径跳过');
  if (guard.forceAccepted === true) marks.push('作者强行放行');
  const summary = strOf(guard.summary);
  return {
    kind: 'line',
    line: `保义护栏：${verdict}${marks.length > 0 ? `（${marks.join('；')}）` : ''} · 发现 ${findingsCount} 条${summary ? `——${truncate(summary)}` : ''}`,
  };
};

const lintProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  const summaryRec = recordOf(rec?.summary);
  if (!rec || !summaryRec) return MISSING_SUMMARY;
  if (rec.degraded === true) {
    return { kind: 'line', line: '去味扫描：引擎缺位降级（本章无静态扫描）' };
  }
  const total = numCount(summaryRec.total);
  if (total === 0) return { kind: 'line', line: '去味扫描：0 命中' };
  const top = (Array.isArray(rec.issues) ? rec.issues : []).map(recordOf).find((i) => i !== undefined);
  const topStr = top ? ` · 首项：[${strOf(top.level) || '?'}] ${strOf(top.title)}` : '';
  return {
    kind: 'line',
    line: `去味扫描：${total} 命中（high ${numCount(summaryRec.high)} / medium ${numCount(summaryRec.medium)} / low ${numCount(summaryRec.low)}）${truncate(topStr)}`,
  };
};

const multiReviewProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  const rows: ChainNodeArtifactFindingRow[] = [];
  for (const dim of Array.isArray(rec.dimensions) ? rec.dimensions : []) {
    const d = recordOf(dim);
    if (!d || !Array.isArray(d.findings)) continue;
    for (const f of d.findings) {
      const fr = recordOf(f);
      if (!fr) continue;
      const name = strOf(d.name);
      const sub = strOf(fr.subClass);
      rows.push({
        label: sub ? `${name}/${sub}` : name,
        severity: strOf(fr.severity) || 'info',
        quote: truncate(strOf(fr.quote)),
        note: truncate(strOf(fr.explanation)),
      });
    }
  }
  return {
    kind: 'findings',
    ...(strOf(rec.verdict) ? { verdict: truncate(strOf(rec.verdict)) } : {}),
    summary: truncate(strOf(rec.summary)),
    ...rowsCapped(rows),
  };
};

const completenessProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  const rows = (Array.isArray(rec.findings) ? rec.findings : []).flatMap((f) => {
    const fr = recordOf(f);
    if (!fr) return [];
    return [
      {
        label: truncate(strOf(fr.entityLabel) || strOf(fr.entityId)),
        severity: strOf(fr.verdict),
        quote: truncate(strOf(fr.quote)),
        note: truncate(strOf(fr.explanation)),
      },
    ];
  });
  return {
    kind: 'findings',
    ...(rec.degraded === true ? { verdict: 'degraded' } : {}),
    summary: truncate(strOf(rec.summary)),
    ...rowsCapped(rows),
  };
};

const routeProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  const decision = strOf(rec?.decision);
  if (!rec || !decision) return MISSING_SUMMARY;
  // CR 批 CR-1：decision/reason 双截断（decision 虽是词表值，链外/mock 形态无界——统一守卫）。
  return { kind: 'route-decision', decision: truncate(decision), reason: truncate(strOf(rec.reason)) };
};

const worldExtractorProjector = (axis: string): NodeArtifactProjector => (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  const patches = Array.isArray(rec.patches) ? rec.patches : [];
  const subjects = Array.isArray(rec.subjects) ? rec.subjects.length : 0;
  const items = patches.flatMap((p) => {
    const pr = recordOf(p);
    if (!pr) return [];
    const base = `${strOf(pr.subjectId)} ${strOf(pr.path)} ${strOf(pr.op)}`.trim();
    const summary = strOf(pr.summary);
    return [summary ? `${truncate(base)}——${truncate(summary)}` : truncate(base)];
  });
  return {
    kind: 'items',
    label: `${axis} 轴提取：${patches.length} 条状态变化 · ${subjects} 主体`,
    items: items.slice(0, CHAIN_ARTIFACT_ITEMS_CAP),
    total: patches.length,
  };
};

const worldMergeProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  const writes = Array.isArray(rec.writes) ? rec.writes.length : 0;
  const errors = Array.isArray(rec.writeErrors) ? rec.writeErrors.length : 0;
  return {
    kind: 'line',
    line: `世界状态落表：${writes} 片 · ${numCount(rec.totalPatches)} 条 patch · ${numCount(rec.totalSubjects)} 主体${errors > 0 ? ` · ${errors} 片写失败` : ''}`,
  };
};

const emotionVerifyProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  if (rec.degraded === true) {
    return { kind: 'line', line: `情绪轨迹校验：降级（${truncate(strOf(rec.degradationNote) || '数据源缺失')}）` };
  }
  const flags = (Array.isArray(rec.flags) ? rec.flags : []).map((f) => String(f));
  // CR 批 CR-1：flags join 封顶（与 items 同常数）——超限计数注明；DTW 有限数守卫
  //（NaN/Infinity 不渲染——Number.isFinite，typeof 'number' 拦不住）。
  const flagsText =
    flags.length > CHAIN_ARTIFACT_ITEMS_CAP
      ? `${flags.slice(0, CHAIN_ARTIFACT_ITEMS_CAP).join('、')}……等 ${flags.length} 项`
      : flags.join('、');
  const dtw =
    typeof rec.chapterDtwDistance === 'number' && Number.isFinite(rec.chapterDtwDistance)
      ? ` · DTW ${rec.chapterDtwDistance}`
      : '';
  return {
    kind: 'line',
    line: `情绪轨迹校验：${flags.length === 0 ? '无违规标记' : flagsText}${dtw}`,
  };
};

const promiseEmergenceProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  const actions = Array.isArray(rec.actions) ? rec.actions : [];
  if (actions.length === 0) {
    const skipped = strOf(rec.skipped);
    return {
      kind: 'line',
      line: `Promise 涌现：gap ${numCount(rec.gapsDetected)} · 无登记动作${skipped ? `（${truncate(skipped)}）` : ''}`,
    };
  }
  const items = actions.flatMap((a) => {
    const ar = recordOf(a);
    if (!ar) return [];
    const promise = recordOf(ar.promise);
    const beat = recordOf(ar.beat);
    const name =
      strOf(promise?.title) ||
      strOf(promise?.id) ||
      strOf(ar.beatId) ||
      strOf(ar.promiseId) ||
      strOf(beat?.id);
    return [`${strOf(ar.type)}${name ? ` · ${truncate(name)}` : ''}`];
  });
  // CR 批 CR-4：artifact 侧 actions 已封顶（节点 slice 同常数）——全量计数读 actionsProduced
  //（节点保全量），截断时 UI 可示「N/total」。
  const total = numCount(rec.actionsProduced) > 0 ? numCount(rec.actionsProduced) : actions.length;
  const stateNote = rec.writeError !== undefined ? '（写盘失败）' : rec.applied === true ? '（已落盘）' : '';
  return {
    kind: 'items',
    label: `Promise 涌现登记：${total} 项${stateNote}`,
    items: items.slice(0, CHAIN_ARTIFACT_ITEMS_CAP),
    total,
  };
};

const arcEmergenceProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  const beats = Array.isArray(rec.beats) ? rec.beats.length : 0;
  if (beats === 0) {
    const skipped = strOf(rec.skipped);
    return { kind: 'line', line: `弧节拍：0 条${skipped ? `（${truncate(skipped)}）` : ''}` };
  }
  return {
    kind: 'line',
    line: `弧节拍声明：${beats} 条（候选 线 ${numCount(rec.lineCandidates)} / 卷 ${numCount(rec.volumeCandidates)} / 成长 ${numCount(rec.growthCandidates)}）${rec.writeError !== undefined ? ' · 写盘失败' : ''}`,
  };
};

const chapterSummaryProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  if (rec.ok === true) {
    // CR 批 CR-10：design §2 表定「摘要首行」——ok 路径补 summary 首行（首个非空行，截断 200），
    // 只发 tokens 行会让时间线产出卡丢掉「本章摘要写了什么」。degraded 形态维持（reason 摘要）。
    const firstLine = truncate(
      strOf(rec.summary)
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? '',
    );
    return {
      kind: 'line',
      line: `章摘要已物化：~${numCount(rec.tokenEstimate)} tokens${rec.truncated === true ? '（截断）' : ''}${firstLine ? `——${firstLine}` : ''}`,
    };
  }
  return { kind: 'line', line: `章摘要降级：${truncate(strOf(rec.reason) || strOf(rec.summary) || 'unknown')}` };
};

const storytimeDriftProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  if (rec.checked !== true) {
    return { kind: 'line', line: `storyTime 漂移守卫：跳过（${truncate(strOf(rec.skipped) || 'unknown')}）` };
  }
  const warnings = Array.isArray(rec.warnings) ? rec.warnings.length : 0;
  return {
    kind: 'line',
    line:
      warnings > 0
        ? `storyTime 漂移：${warnings} 条 slice 落在本章场窗外`
        : 'storyTime 漂移：0 告警（slice 均在场窗内）',
  };
};

const mentionLedgerProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  if (rec.ok !== true) {
    return { kind: 'line', line: `mention 台账：跳过（${truncate(strOf(rec.reason) || 'unknown')}）` };
  }
  const signals = Array.isArray(rec.signals) ? rec.signals.length : 0;
  return { kind: 'line', line: `mention 台账：${numCount(rec.rowCount)} 行 · ${signals} 条共现信号` };
};

const storySyncProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  const patches = Array.isArray(rec.patches) ? rec.patches.length : 0;
  return { kind: 'line', line: `story-sync：${patches} 条设定补丁——${truncate(strOf(rec.summary))}` };
};

const feedbackLedgerProjector: NodeArtifactProjector = (_run, result) => {
  const rec = recordOf(result.artifact);
  if (!rec) return MISSING_SUMMARY;
  const written = (Array.isArray(rec.written) ? rec.written : []).map((w) => String(w));
  if (written.length === 0) {
    return { kind: 'line', line: `反馈台账：未写入（${truncate(strOf(rec.summary) || 'unknown')}）` };
  }
  return {
    kind: 'line',
    line: `反馈台账：${written.length}/${FEEDBACK_LEDGER_ARTIFACT_KEYS.length} 项已写（${written.join('、')}）`,
  };
};

// ── 发射形态表（design §2 权威——CHAPTER_CHAIN_NODE_IDS 23 节点全覆盖，测试守门）──

interface ChainNodeArtifactSpec {
  /** 事件 role（mirror withNodeStreaming 接线的 yaml 角色名；纯代码节点 = nodeId 本身）。 */
  role: string;
  project: NodeArtifactProjector;
}

const CHAIN_NODE_ARTIFACT_SPECS: Record<string, ChainNodeArtifactSpec> = {
  'brief-compiler-node': { role: 'brief-compiler-node', project: briefCompilerProjector },
  'brief-reviewer-node': { role: 'brief-reviewer-agent', project: briefReviewerProjector },
  'revision-optimizer-node': { role: 'revision-optimizer-agent', project: revisionOptimizerProjector },
  'draft-writer-agent': { role: 'draft-writer-agent', project: draftWriterProjector },
  'revision-guard-agent': { role: 'revision-guard-agent', project: revisionGuardProjector },
  'lint-node': { role: 'lint-node', project: lintProjector },
  'multi-review-agent': { role: 'multi-review-agent', project: multiReviewProjector },
  'completeness-verify-node': { role: 'completeness-verify-agent', project: completenessProjector },
  'route-agent': { role: 'route-agent', project: routeProjector },
  'world-extractor-physical': { role: 'event-extractor-physical', project: worldExtractorProjector('physical') },
  'world-extractor-cognitive': { role: 'event-extractor-cognitive', project: worldExtractorProjector('cognitive') },
  'world-extractor-emotional': { role: 'event-extractor-emotional', project: worldExtractorProjector('emotional') },
  'world-extractor-relational': { role: 'event-extractor-relational', project: worldExtractorProjector('relational') },
  'world-extractor-factional': { role: 'event-extractor-factional', project: worldExtractorProjector('factional') },
  'world-merge-node': { role: 'world-merge-node', project: worldMergeProjector },
  'emotion-verify-node': { role: 'emotion-verify-node', project: emotionVerifyProjector },
  'promise-emergence-node': { role: 'promise-emergence-agent', project: promiseEmergenceProjector },
  'arc-emergence-node': { role: 'arc-emergence-agent', project: arcEmergenceProjector },
  'chapter-summary-node': { role: 'chapter-summary-node', project: chapterSummaryProjector },
  'storytime-drift-node': { role: 'storytime-drift-node', project: storytimeDriftProjector },
  'mention-ledger-node': { role: 'mention-ledger-node', project: mentionLedgerProjector },
  'story-sync-agent': { role: 'story-sync-agent', project: storySyncProjector },
  'feedback-ledger-node': { role: 'feedback-ledger-node', project: feedbackLedgerProjector },
};

/**
 * 节点 id → 事件 role（blocked 通用行用——chainRunner onNodeBlocked 只持 nodeId，role 经本表
 * 单源解析；未知节点 id（mock 链 / 未来节点）→ nodeId 本身兜底）。
 */
export function chainNodeArtifactRoleOf(nodeId: string): string {
  return CHAIN_NODE_ARTIFACT_SPECS[nodeId]?.role ?? nodeId;
}

/**
 * CR 批 CR-3：through verdict 强制覆写后的快照重发（chainRunner onVerdictOverwritten 消费）。
 *
 * chainRunner 的覆写分支（环 cap 超限 / optimizer_failed 强制升级 / CR-10 未知 verdict /
 * CR-1 空转断路）改写 through 产物后，装配层包装已发的原始 verdict 帧（如 auto_revise）成为
 * stale——时间线末帧与真实终态不一致。经本函数按发射形态表重投影**覆写后的** artifact 并发射
 *（route 词表 → route-decision 帧；plan 词表 → findings 帧——按 spec 表自动落对 kind）。
 *
 * - emit 缺省 / 表外 id → no-op（mock 链 / 非流式车道零回归）。
 * - 投影 throw → 降级『（快照缺失）』行 + logger.debug（CR-5：投影降级不留死静默）。
 * - 发射 throw → logger.debug 后丢弃（可观测性绝不破链）。
 */
export function emitChainNodeArtifactFor(
  nodeId: string,
  run: RunSnapshot,
  result: { stateKey: string; artifact: unknown },
  emit: ChainNodeArtifactEmit | undefined,
): void {
  if (!emit) return;
  const spec = CHAIN_NODE_ARTIFACT_SPECS[nodeId];
  if (!spec) return;
  let summary: ChainNodeArtifactSummary;
  try {
    summary = spec.project(run, result);
  } catch (err) {
    logger.debug(
      { nodeId, err: err instanceof Error ? err.message : String(err) },
      'chain-node-artifact: overwrite re-emit projector degraded → （快照缺失）行',
    );
    summary = MISSING_SUMMARY;
  }
  try {
    emit({ nodeId, role: spec.role, summary });
  } catch (err) {
    logger.debug(
      { nodeId, err: err instanceof Error ? err.message : String(err) },
      'chain-node-artifact: overwrite re-emit failed (observability dropped)',
    );
  }
}

/**
 * 装配处统一包装（design §2 发射点）：包装节点 run——终态后投影 summary 发射。
 *
 * - emit 缺省（测试 / reExtractChapter 链外车道 / 非流式路径）→ **原 def 引用返回**（零包装零回归）。
 * - spec 缺（表外节点 id——mock 链 / 未来节点）→ 原 def 返回（不发光栅，防误配）。
 * - error artifact 前置守卫（M4）：`{error:true}` 先于产物投影 → 通用 error 行；节点 throw
 *   （非 AbortError）→ 同款 error 行后原样 rethrow（chainRunner 合成 error artifact 路径）。
 * - AbortError 不发光栅（取消非失败；run 级哨兵 aborted 帧归 workflow）。
 * - 发射顺序结构性先于同节点 node-done（包装内先发再 return——chainRunner 的 onNodeDone
 *   在 run 返回后才调）。
 * - 可观测性绝不破节点行为：project/emit 全 try/catch（投影 throw 降级『（快照缺失）』行；
 *   emit throw 静默丢弃）。
 */
export function withNodeArtifact(
  def: ChainNodeDef,
  emit: ChainNodeArtifactEmit | undefined,
): ChainNodeDef {
  if (!emit) return def;
  const spec = CHAIN_NODE_ARTIFACT_SPECS[def.id];
  if (!spec) return def;
  const inner = def.node;
  const safeEmit = (summary: ChainNodeArtifactSummary): void => {
    try {
      emit({ nodeId: def.id, role: spec.role, summary });
    } catch (err) {
      // 可观测性发射失败（IPC 已死等）绝不破节点行为——静默丢弃；CR-5：低噪留痕
      //（系统性死通道与安静系统不可区分——debug 一句，带 nodeId/error）。
      logger.debug(
        { nodeId: def.id, err: err instanceof Error ? err.message : String(err) },
        'chain-node-artifact: emit failed (observability dropped)',
      );
    }
  };
  return {
    ...def,
    node: {
      ...inner,
      run: async (input: NodeRunInput): Promise<NodeResult> => {
        let result: NodeResult;
        try {
          result = await inner.run(input);
        } catch (err) {
          if (!(err instanceof Error && err.name === 'AbortError')) {
            safeEmit(
              errorChainNodeArtifactLine({
                message: err instanceof Error ? err.message : String(err),
              }),
            );
          }
          throw err;
        }
        try {
          if (isErrorArtifactShape(result.artifact)) {
            safeEmit(errorChainNodeArtifactLine(result.artifact));
          } else {
            safeEmit(spec.project(input.run, result));
          }
        } catch (err) {
          // CR-5：投影降级低噪留痕（此前纯静默——死通道与安静系统不可区分）。
          logger.debug(
            { nodeId: def.id, err: err instanceof Error ? err.message : String(err) },
            'chain-node-artifact: projector degraded → （快照缺失）行',
          );
          safeEmit(MISSING_SUMMARY);
        }
        return result;
      },
    },
  };
}
