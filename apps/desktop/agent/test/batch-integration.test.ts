import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage, ToolCall } from '../src/types';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 implement.md Step 9：批量编排集成测试（chat-fatigue 防护，真链非 mock）。
//
// **真 runLoop + 真 runChapterChain**（testing-discipline 红线）：leader 走真
// `runtime.sendMessage` → 真 runLoop（turn break = 无 toolCalls 自然 break）→ 真工具执行
// （start_batch / batch_status / end_batch / set_participation_gear / write_chapter / present_result
// 均为 builtin 注册的真工具）→ write_chapter 内部走真 runChapterChain（dispatchSubagent +
// createChapterChainNodes 全链 + 真 chainRunner）。mock 仅两层（注入 seam，testing spec）：
// 1. `generate`（LLM）——scripted 区分 leader / 链节点 / 子 agent：leader 按消息流里
//    kind='session_state_note' 注记识别（system 稳定化 + CR-D1 拆分后注记 = 纯动态状态快照，
//    静态能力段已回 system 恒定区；注记仍只在 leader 会话追加——leader-only 判据不变），
//    链节点 / 子 agent（retrieval / director / adjudicator）按 system 标记。leader 脚本「像真
//    leader」：按注记里的批量协议段行动（判轻重问/直写、escalate 必停、锚点收尾）——同时把
//    收到的注记 content 记录下来断言协议段真的注入（协议到达 + 行为遵守双验证）。
// 2. `setExecuteToolFn` bridge——remoteToolProxy 工具（query_world_slice / write_world_events /
//    feedback_ledger_write / git_* 等）的最小 shell 侧替身（agent 包无 db/IPC）。
//
// 与单测分工（勿重复）：batch-tools / batch-state / batch-planning / batch-signals /
// batch-prompt-segment / batch-message-stamp 已覆盖工具行为 / 状态读写 / prompt 段注入 /
// 盖章单点。本文件验**跨层组合语义**：档位协议驱动的 leader 行为 + 链 escalate 穿透 +
// 崩溃恢复对账续跑 + 消息盖章全生命周期（progress→report）。
//
// 场景 → AC 映射：
// 1. smart 全流程（通报走向单不阻塞→重点场 turn break 问→答后续跑→锚点 end_batch +
//    present_result + L0）——AC1 + AC6（stale 引导 diagnose_impacts）+ AC8（大纲 sparse 降级
//    仍可判）+ AC7 agent 侧（盖章生命周期 + 旧消息无字段不破）。
// 2. hands_off + trustAdjudication=true 灰区续跑不问——AC2/AC5。
// 3. hands_off + trust=true BLOCK 硬违规仍必停——AC5。
// 4. steer 每场写前问（turn break 发生在每场写前）——AC2。
// 5. balanced 走向单等确认（首批写前 turn break）——AC2。
// 6. 崩溃恢复：磁盘 running 残留 + 章正文已落盘 →「继续」→ batch_status 对账续跑——AC4
//    + 盖章 registry 崩溃后从磁盘重导（paused 残留的 batch_status 恢复语义由 batch-tools
//    单测覆盖；真实崩溃不翻状态，故此处 seed running）。
// 7. smart 档链内 escalate_user 灰区穿透（批量停呈现非继续下一场）→ 用户裁决后续跑——AC5。
//
// ⚠️ 全静态 import（无 vi.resetModules）——batch-tools 持 session/batch-state 模块引用，
// resetModules 会造成「工具拿旧模块 map、测试建新模块 session」的实例分裂。模块级共享态
// （stamp map / remote bridge）在 afterEach / beforeEach 显式清。
// ─────────────────────────────────────────────────────────────────────────────

import { createWorkflowRuntime } from '../src/runtime/workflow';
import { RunStateStore } from '../src/runtime/runState';
import { closeDb } from '../src/agent/persistence';
import { getSession } from '../src/agent/session';
import { registerBuiltinTools } from '../src/tool/builtin';
import { setExecuteToolFn } from '../src/tool/remote';
import { clearActiveBatchStamp, loadBatchRuns, saveBatchRuns } from '../src/tool/batch-state';

// ════════════════════════════════════════════════════════════════════════════
// fixture：临时项目（4 场 1 线 → 2 章，sc4 = core-anchor 锚点）
// ════════════════════════════════════════════════════════════════════════════

/**
 * demo scene_graph / episode / chapter 结构：
 * - 线 main：sc1→sc2→sc3→sc4（CAUSAL 链，拓扑序 = 此序），sc4 role=core-anchor（批量边界）。
 * - 场→章：sc1,sc2 → ep0 → ch-0；sc3,sc4 → ep1 → ch-1（一章只写一次，design §3.3）。
 * - episode_outlines 无 summary/beats → 信号 outlineRichness='sparse'（AC8：大纲稀疏降级仍可判）。
 * - creative_brief.commitments → 设定锚点（write_chapter readiness settingsPresent）+ 题材承诺。
 */
function writeBatchProject(projectPath: string, opts: { landedCh0Prose?: boolean } = {}) {
  const doc = {
    name: 'Batch Integration Test',
    scene_graph: {
      nodes: [
        { id: 'sc1', lineTags: ['main'], episodeId: 'ep0', storyTime: 1, presentationOrder: { chapter: 0, pos: 0 } },
        { id: 'sc2', lineTags: ['main'], episodeId: 'ep0', storyTime: 2, presentationOrder: { chapter: 0, pos: 1 }, outcomeType: '冲突爆发' },
        { id: 'sc3', lineTags: ['main'], episodeId: 'ep1', storyTime: 3, presentationOrder: { chapter: 1, pos: 0 } },
        { id: 'sc4', lineTags: ['main'], episodeId: 'ep1', storyTime: 4, presentationOrder: { chapter: 1, pos: 1 }, role: 'core-anchor', storyTimeLabel: '第4日夜·锚点' },
      ],
      edges: [
        { id: 'e1', from: 'sc1', to: 'sc2', type: 'CAUSAL' },
        { id: 'e2', from: 'sc2', to: 'sc3', type: 'CAUSAL' },
        { id: 'e3', from: 'sc3', to: 'sc4', type: 'CAUSAL' },
      ],
      lines: [{ id: 'main', name: '主线' }],
      version: 0,
      updatedBy: 'user',
    },
    episode_outlines: [
      { id: 'ep0', index: 0, title: '第2章' },
      { id: 'ep1', index: 1, title: '第3章' },
    ],
    novel: {
      chapters: [
        opts.landedCh0Prose
          ? { id: 'ch-0', title: 'c0', sort_order: 0, sections: [{ id: 'sec0', title: 's0', sort_order: 0, content_file: 'chapters/ch_000.md' }] }
          : { id: 'ch-0', title: 'c0', sort_order: 0, sections: [] },
        { id: 'ch-1', title: 'c1', sort_order: 1, sections: [] },
      ],
    },
    creative_brief: { rawRequirement: 'r', commitments: [{ type: 'HE', content: '圆满' }] },
  };
  writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf-8');
  if (opts.landedCh0Prose) {
    // 崩溃恢复 fixture：ch-0 正文已落盘（模拟 accept 持久化已发生）→ batch_status 对账源。
    mkdirSync(path.join(projectPath, 'chapters'), { recursive: true });
    writeFileSync(path.join(projectPath, 'chapters', 'ch_000.md'), '# 第2章\n崩溃前已写完的正文。', 'utf-8');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// scripted generate：leader 脚本 + 子系统 fixture（mirror chain-e2e makeE2eGenerate 标记法）
// ════════════════════════════════════════════════════════════════════════════

interface LeaderAction {
  /** 本步要调的工具（空/缺 = 纯文本停下 → runLoop turn break = 咨询点）。 */
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  content: string;
}

interface ScenarioConfig {
  /** leader 按序消费的脚本（跨 turn 连续消费；耗尽仍被调 → throw 让测试炸出来）。 */
  leader: LeaderAction[];
  /** route-agent 决策序列（按链内 route 调用次序；每次 write_chapter 恰一次 route）。 */
  routeDecisions: string[];
  /** multi-review findings severity 序列（undefined = 干净 accept 评审）。 */
  reviewSeverities: Array<'warn' | 'block' | undefined>;
  /** 裁决器（adjudicator-agent）行为：parse-fail = 返非结构化文本（auto-trust 不采信）。 */
  adjudication: 'parse-fail' | 'accept';
}

const INITIAL_DRAFT = {
  title: '批量链初稿',
  text: '黄昏的荒野上，主角深吸一口气，攥紧行囊向远方的城墙走去。BATCH_E2E_DRAFT_MARKER',
  wordCount: 2800,
};

function reviewResponse(severity: 'warn' | 'block' | undefined) {
  if (severity === undefined) {
    return { verdict: 'accept', summary: '达标', dimensions: [], reasons: ['无 block 级问题'] };
  }
  return {
    verdict: 'revise',
    summary: '发现需裁决的灰区问题',
    dimensions: [
      {
        name: 'consistency',
        findings: [
          {
            subClass: 'Characterization.ooc',
            severity,
            quote: '他突然拔剑刺向同伴',
            location: '句12',
            explanation: '与既定性格冲突，难断是 bug 还是目标转折',
          },
        ],
      },
    ],
    reasons: ['灰区难断，上发裁决'],
  };
}

function adjudicatorResponse(kind: ScenarioConfig['adjudication']) {
  if (kind === 'parse-fail') {
    // 无 brace / 非 JSON → parseAdjudication 三路径全失败 → null（auto-trust 不采信，fallback 呈 findings）。
    return '裁决器初审暂无法给出结构化建议（parse 失败模拟）——请作者裁决。';
  }
  // parseAdjudication 硬要求 ≥2 options（label+reason 齐才 parse 成功——Story 4.6 两选项契约）。
  return JSON.stringify({
    analysis: '灰区属人物语气偏离，未违硬约束，可接受为真相',
    recommendation: 'accept',
    recommendationReason: '不违背 GenreContract 承诺',
    options: [
      { label: '接受为真相', reason: '语气偏离在作者声音范围内，非硬违规' },
      { label: '改稿', reason: '若你认为此处必须贴合原设定，可重跑改稿' },
    ],
  });
}

/**
 * leader 判据：消息流含 kind='session_state_note' 注记（system 稳定化〔09-12〕+ CR-D1 拆分
 * 〔09-13 拍板 B〕后注记 = 纯动态状态快照——「Interaction Mode (Closure 工作台)」静态能力段头
 * 已回 system，注记头为「Session State (Closure 工作台)」）。注记只在 leader 会话追加（child/
 * 链节点会话零继承父历史，见 sessionTree createChildSession）→ 在场 = leader-only 判据。
 */
function hasSessionStateNote(messages: unknown): boolean {
  return (
    Array.isArray(messages)
    && messages.some((m) => (m as { kind?: string } | null)?.kind === 'session_state_note')
  );
}

/** 最新一条 session_state_note 注记 content（同快照 hash 门不新增——多轮取最新须 filter 取尾）。 */
function latestSessionStateNoteContent(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const notes = messages.filter((m) => (m as { kind?: string } | null)?.kind === 'session_state_note');
  return notes.length > 0 ? (notes.at(-1) as { content: string }).content : '';
}

/**
 * 场景 scripted generate。区分（leader 判定必须最先——leader system 的工具描述段含「审核」
 * 等词，勿被链节点 matcher 误吞）：
 * - leader：消息流含 session_state_note 注记（见上方 hasSessionStateNote——leader-only）。
 * - 链节点 / 子 agent：yaml system 标记（mirror chain-e2e：路由判决 / Reader-Audit / 状态提取 /
 *   完整性审核 / 修订编辑；子 agent：资料员 retrieval / 你是导演 director / 灰区创作裁决器）。
 */
function makeScenarioGenerate(cfg: ScenarioConfig) {
  let leaderIdx = 0;
  let routeIdx = 0;
  let reviewIdx = 0;
  let callSeq = 0;
  const leaderNotes: string[] = [];
  const generate = async (
    messages: unknown,
    sys: string | undefined,
  ): Promise<{ content: string; toolCalls?: ToolCall[]; finishReason: string }> => {
    const s = sys ?? '';
    callSeq++;
    // ── leader（runLoop 主循环；咨询点 = 返回无 toolCalls → turn break）──
    if (hasSessionStateNote(messages)) {
      leaderNotes.push(latestSessionStateNoteContent(messages));
      const step = cfg.leader[leaderIdx];
      if (!step) {
        throw new Error(`batch-integration: leader script exhausted at generate call #${callSeq} (leader #${leaderIdx + 1})`);
      }
      leaderIdx++;
      if (step.toolCalls && step.toolCalls.length > 0) {
        return {
          content: step.content,
          toolCalls: step.toolCalls.map((tc, i): ToolCall => ({
            id: `call-${leaderIdx}-${i}`,
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          })),
          finishReason: 'stop',
        };
      }
      return { content: step.content, finishReason: 'stop' };
    }
    // ── 链节点 + 子 agent（yaml system 标记，mirror chain-e2e.test.ts makeE2eGenerate）──
    // 🔑 顺序敏感：专属标记在前，generic「Reader-Audit/审核」matcher 必须**最后**——adjudicator /
    // director 的 yaml system 本身含「Reader-Audit」字样（grep prompts/*.yaml 核实），generic 先判
    // 会把它们误吞成 multi-review fixture（灰区采信/裁决行为错乱）。
    if (s.includes('规划审核')) {
      // W1d：brief-reviewer（A2 规划审核）——pass 直通（须在 generic「审核」matcher 前——
      // brief-reviewer system 含「审核」子串，否则吞掉 reviewSeverities 序列错位）。
      return { content: JSON.stringify({ verdict: 'pass', summary: '卡可写', findings: [] }), finishReason: 'stop' };
    }
    if (s.includes('路由判决')) {
      const decision = cfg.routeDecisions[Math.min(routeIdx, cfg.routeDecisions.length - 1)];
      routeIdx++;
      return { content: JSON.stringify({ decision, reason: `mock route (${decision})` }), finishReason: 'stop' };
    }
    if (s.includes('完整性审核')) {
      return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
    }
    if (s.includes('状态提取')) {
      // 带 1 条 patch + 主体登记（CR-E8：空 patches 组被 merge 跳过 → write_world_events 不触发；
      // 非空才落表——验真链 world-merge 副作用真发生）。
      return {
        content: JSON.stringify({
          storyTime: 5,
          title: '状态切面',
          subjects: [{ id: 'hero', type: 'character', name: '主角' }],
          patches: [{ subjectId: 'hero', path: 'location', op: 'replace', value: '城郊荒野' }],
        }),
        finishReason: 'stop',
      };
    }
    if (s.includes('修订编辑')) {
      return { content: JSON.stringify({ ...INITIAL_DRAFT, title: '批量链修订稿' }), finishReason: 'stop' };
    }
    if (s.includes('改稿保义裁判员')) {
      // 整章路径本不 generate（无 revision_intent → pass-through）；防御性兜底。
      return { content: JSON.stringify({ verdict: 'skipped', summary: '整章路径', findings: [] }), finishReason: 'stop' };
    }
    if (s.includes('资料员')) {
      return { content: '（本批无召回——retrieval 跳过模拟）', finishReason: 'stop' };
    }
    if (s.includes('你是导演')) {
      return { content: '（director 本批无 info/emotion/atomic 产出模拟）', finishReason: 'stop' };
    }
    if (s.includes('灰区创作裁决器')) {
      return { content: adjudicatorResponse(cfg.adjudication), finishReason: 'stop' };
    }
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
      const severity = cfg.reviewSeverities[Math.min(reviewIdx, cfg.reviewSeverities.length - 1)];
      reviewIdx++;
      return { content: JSON.stringify(reviewResponse(severity)), finishReason: 'stop' };
    }
    // ── 默认：draft-writer ──
    return { content: JSON.stringify(INITIAL_DRAFT), finishReason: 'stop' };
  };
  return { generate, leaderNotes };
}

// ════════════════════════════════════════════════════════════════════════════
// remote bridge + turn helper
// ════════════════════════════════════════════════════════════════════════════

const remoteCalls: Array<{ toolId: string; params: unknown }> = [];

function writeChapterCall(episodeId: string, chapterId: string, goal: string) {
  return {
    name: 'write_chapter',
    args: { episodeId, chapterId, chapterBrief: { goal } },
  };
}

/** 本 turn 新增的 session 消息切片（含本 turn 的 user 消息）。 */
async function runTurn(
  runtime: ReturnType<typeof createWorkflowRuntime>,
  sessionId: string,
  content: string,
): Promise<SessionMessage[]> {
  const session = getSession(sessionId)!;
  const before = session.messages.length;
  await runtime.sendMessage({ sessionId, content, abortSignal: new AbortController().signal });
  return getSession(sessionId)!.messages.slice(before);
}

function assistantToolCalls(msgs: readonly SessionMessage[]): ToolCall[] {
  return msgs.filter((m) => m.role === 'assistant').flatMap((m) => m.toolCalls ?? []);
}

function toolOutputs(msgs: readonly SessionMessage[], toolName: string): string[] {
  return msgs
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.toolResults ?? [])
    .filter((r) => r.toolName === toolName)
    .map((r) => r.output);
}

// ════════════════════════════════════════════════════════════════════════════
// suite
// ════════════════════════════════════════════════════════════════════════════

describe('Story 3.5 — 批量编排集成（真 runLoop + 真 runChapterChain，scripted LLM）', { timeout: 120_000 }, () => {
  let projectPath = '';

  beforeAll(() => {
    // 真 builtin 工具注册（start_batch / write_chapter / present_result / set_participation_gear 等）。
    registerBuiltinTools();
    // remoteToolProxy 桥：agent 测试环境无 shell IPC——最小 shell 侧替身（无 metadata → 各消费端
    // graceful 降级：query_world_slice → undefined / feedback_ledger_read → undefined / git_status → skip）。
    setExecuteToolFn(async (toolId, params) => {
      remoteCalls.push({ toolId, params });
      return { title: toolId, output: `(${toolId} bridged stub)` };
    });
  });

  afterAll(() => {
    setExecuteToolFn(async (toolId) => ({ title: toolId, output: `(${toolId} unset)` }));
  });

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-batch-integration-'));
    remoteCalls.length = 0;
  });

  afterEach(async () => {
    closeDb(projectPath);
    clearActiveBatchStamp(projectPath);
    rmBestEffort(projectPath);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. smart 档全流程（AC1 + AC6 + AC7 agent 侧 + AC8 sparse）
  // ──────────────────────────────────────────────────────────────────────────
  it('smart：通报走向单不阻塞 → 重点场 turn break 问 → 答后续跑两章 → 锚点 end_batch + present_result + L0 + report 盖章', async () => {
    writeBatchProject(projectPath);
    const { generate, leaderNotes } = makeScenarioGenerate({
      leader: [
        // turn 0（warmup，无批量）：旧消息无 batchId 不破（AC7）。
        { content: '你好，我是写作搭档。' },
        // turn 1：start_batch → 判轻重（sc2 重点 → turn break 问创作选择）。
        { content: '先解析批量边界与信号卡。', toolCalls: [{ name: 'start_batch', args: { lineTag: 'main' } }] },
        { content: '走向单：沿主线写 4 场（sc1→sc4，2 章），到 core-anchor 锚点收束。其中 sc2 是重点场——问：sc2 的冲突以何种方式正面化？' },
        // turn 2：batch_status 对账续跑 → 逐章 write_chapter（非重点直写）→ 锚点收尾。
        { content: '作者已答，先对账续跑。', toolCalls: [{ name: 'batch_status', args: {} }] },
        { content: '写第2章（sc1+sc2，sc2 按正面突破处理）。', toolCalls: [writeChapterCall('ep0', 'ch-0', '主角在城郊正面突破包围，抵达联络点')] },
        { content: '写第3章（sc3+sc4，非重点直写到锚点）。', toolCalls: [writeChapterCall('ep1', 'ch-1', '锚点收束：真相揭露与立场抉择')] },
        { content: '到锚点，收口批量。', toolCalls: [{ name: 'end_batch', args: { outcome: 'done' } }] },
        // R2 #8 契约（2026-08-25 用户拍板）：呈现正文与 present_result 调用**同一条消息**——
        // 调用即收尾（terminal），不再有后续复读轮（旧剧本的「调用 → 下一轮 L0 报告」废止）。
        { content: 'L0 全景：第2章 accept（2800 字）· 第3章 accept（2800 字）。待验收：2 个章节候选（工作台 PatchReview）。批量写作若产生 stale，建议调 diagnose_impacts 做涟漪诊断。', toolCalls: [{ name: 'present_result', args: { awaiting_intent_confirmation: false, summary: '主线批量完成' } }] },
      ],
      routeDecisions: ['accept_as_truth', 'accept_as_truth'],
      reviewSeverities: [undefined, undefined],
      adjudication: 'parse-fail',
    });
    const runtime = createWorkflowRuntime({ generate, runState: new RunStateStore() });
    const session = runtime.createSession({ agentName: 'writer', projectPath, mode: 'auto' });

    // turn 0：warmup（无批量 → 零协议注入回归 + 旧消息不盖章）。
    const warmup = await runTurn(runtime, session.id, '你好');
    const warmupAssistant = warmup.find((m) => m.role === 'assistant')!;
    expect(warmupAssistant.batchId).toBeUndefined();
    expect(warmupAssistant.batchKind).toBeUndefined();
    const warmupNote = leaderNotes[0] ?? '';
    expect(warmupNote).not.toContain('批量写作协议');

    // turn 1：批量指令 → start_batch 被调 + 通报/问询产出 + turn break。
    const turn1 = await runTurn(runtime, session.id, '把主线这四场全权写到锚点，你判断哪些要问我');
    const turn1Calls = assistantToolCalls(turn1);
    expect(turn1Calls.map((c) => c.name)).toEqual(['start_batch']);
    expect(JSON.parse(turn1Calls[0].arguments)).toEqual({ lineTag: 'main' });
    // start_batch 真工具产出：计划 + 信号卡（AC8：大纲 sparse 降级仍产信号）+ 承诺对照。
    const startOutput = toolOutputs(turn1, 'start_batch')[0];
    expect(startOutput).toContain('批量已启动');
    expect(startOutput).toContain('sc1');
    expect(startOutput).toContain('sc4');
    expect(startOutput).toContain('锚点=core-anchor');
    expect(startOutput).toContain('大纲=sparse');
    expect(startOutput).toContain('[HE] 圆满');
    // 落盘 running + 场→章映射。
    const runs = loadBatchRuns(projectPath)!;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('running');
    expect(runs[0].orderedSceneIds).toEqual(['sc1', 'sc2', 'sc3', 'sc4']);
    expect(runs[0].chapterMap).toEqual({ sc1: 'ch-0', sc2: 'ch-0', sc3: 'ch-1', sc4: 'ch-1' });
    expect(runs[0].sessionId).toBe(session.id);
    const batchId = runs[0].batchId;
    // turn break 在问询处（最后一条 assistant 无 toolCalls，含走向单 + sc2 问题）。
    const lastAssistant1 = turn1.filter((m) => m.role === 'assistant').at(-1)!;
    expect(lastAssistant1.toolCalls).toBeUndefined();
    expect(lastAssistant1.content).toContain('走向单');
    expect(lastAssistant1.content).toContain('sc2');
    // turn 1 内未写任何章（重点场先问）。
    expect(toolOutputs(turn1, 'write_chapter')).toHaveLength(0);
    // turn 1 消息盖章（AC7）：携带 start_batch 调用的首条 assistant 在工具执行**前**发射
    // （runLoop 先 onMessage 再执行工具）→ 未盖章——批量此刻尚不存在（stamp 只盖「活跃批量
    // 存在时」的消息，设计语义）；start_batch 工具结果起的后续消息全盖 progress。
    const turn1NonUser = turn1.filter((m) => m.role !== 'user');
    expect(turn1NonUser[0].role).toBe('assistant');
    expect(turn1NonUser[0].batchId).toBeUndefined(); // 批量启动前的 leader 自述
    for (const msg of turn1NonUser.slice(1)) {
      expect(msg.batchId).toBe(batchId);
      expect(msg.batchKind).toBe('progress');
    }
    for (const msg of turn1.filter((m) => m.role === 'user')) {
      expect(msg.batchId).toBeUndefined();
    }

    // turn 2：答后续跑（对账 → 写两章 → 锚点收尾）。
    const turn2 = await runTurn(runtime, session.id, 'sc2 按正面突破写，继续');
    // turn 2 注记（turn 开始追加的 session_state_note）：批量协议段 + smart 档 + 穿透纪律 +
    // stale 引导（AC6）+ 进度/下一场。
    const turn2Note = leaderNotes[leaderNotes.length - 1] ?? '';
    expect(turn2Note).toContain('批量写作协议');
    expect(turn2Note).toContain('参与档位=smart');
    expect(turn2Note).toContain('通报走向单');
    expect(turn2Note).toContain('硬性打断穿透');
    expect(turn2Note).toContain('不豁免 BLOCK');
    expect(turn2Note).toContain('diagnose_impacts');
    expect(turn2Note).toContain('0/4 场已完成');
    expect(turn2Note).toContain('下一场=sc1');
    // batch_status 真对账（0 落盘 → 0/4 + 剩余场信号刷新）。
    const statusOutput = toolOutputs(turn2, 'batch_status')[0];
    expect(statusOutput).toContain(`batchId=${batchId}`);
    expect(statusOutput).toContain('0/4 场已完成');
    expect(statusOutput).toContain('剩余 4 场');
    // 真 runChapterChain 跑完两章：write_chapter ×2（带 chapterId）+ accept route + 章候选。
    const wcCalls = assistantToolCalls(turn2).filter((c) => c.name === 'write_chapter');
    expect(wcCalls.map((c) => (JSON.parse(c.arguments) as { chapterId: string }).chapterId)).toEqual(['ch-0', 'ch-1']);
    const wcOutputs = toolOutputs(turn2, 'write_chapter');
    expect(wcOutputs).toHaveLength(2);
    for (const out of wcOutputs) {
      expect(out).toContain('status: completed');
      expect(out).toContain('route: accept_as_truth');
    }
    expect(wcOutputs[0]).toContain('已生成章节候选（chapter ch-0）');
    expect(wcOutputs[1]).toContain('已生成章节候选（chapter ch-1）');
    // 链副作用经 bridge 真发生（world-merge 落表 + feedback ledger 写）——证真链非 mock。
    expect(remoteCalls.some((c) => c.toolId === 'write_world_events')).toBe(true);
    expect(remoteCalls.some((c) => c.toolId === 'feedback_ledger_write')).toBe(true);
    // 锚点收尾：end_batch(done) + present_result + L0 文本 + report 盖章（AC1 收尾三件套）。
    const endOutput = toolOutputs(turn2, 'end_batch')[0];
    expect(endOutput).toContain('收口（done）');
    expect(endOutput).toContain('diagnose_impacts'); // AC6：stale 回灌引导文案
    expect(toolOutputs(turn2, 'present_result')).toHaveLength(1);
    // R2 #8：最后一条 assistant = 携带 present_result 的消息（L0 正文同消息），调用即收尾。
    const lastAssistant2 = turn2.filter((m) => m.role === 'assistant').at(-1)!;
    expect(lastAssistant2.toolCalls?.map((c) => c.name)).toEqual(['present_result']);
    expect(lastAssistant2.content).toContain('L0 全景');
    // 终态：batches.json done。
    expect(loadBatchRuns(projectPath)![0].status).toBe('done');
    // 盖章生命周期（AC7）：写章过程消息 progress；end_batch 之后（含收尾全景）report。
    const writeToolMsg = turn2.find(
      (m) => m.role === 'tool' && (m.toolResults ?? []).some((r) => r.toolName === 'write_chapter'),
    )!;
    expect(writeToolMsg.batchId).toBe(batchId);
    expect(writeToolMsg.batchKind).toBe('progress');
    expect(lastAssistant2.batchId).toBe(batchId);
    expect(lastAssistant2.batchKind).toBe('report');
    // 全批量消息同 batchId（分组键一致）。
    for (const msg of [...turn1, ...turn2].filter((m) => m.role !== 'user' && m.batchId !== undefined)) {
      expect(msg.batchId).toBe(batchId);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. hands_off + trustAdjudication=true：灰区采信裁决器续跑，零问（AC2/AC5）
  // ──────────────────────────────────────────────────────────────────────────
  it('hands_off+trust：单 turn 零问跑完两章；灰区（warn）经裁决器 accept 自动采信续跑（不 turn break）', async () => {
    writeBatchProject(projectPath);
    const { generate, leaderNotes } = makeScenarioGenerate({
      leader: [
        // chat 入口调档（AC3 三入口之一）：放手 + 信灰区裁决。
        { content: '切档。', toolCalls: [{ name: 'set_participation_gear', args: { gear: 'hands_off', trustAdjudication: true } }] },
        { content: '启动批量。', toolCalls: [{ name: 'start_batch', args: { lineTag: 'main' } }] },
        { content: '写第2章。', toolCalls: [writeChapterCall('ep0', 'ch-0', '城郊突破')] },
        { content: '写第3章（上轮灰区已采信，继续）。', toolCalls: [writeChapterCall('ep1', 'ch-1', '锚点收束')] },
        { content: '收口。', toolCalls: [{ name: 'end_batch', args: { outcome: 'done' } }] },
        { content: 'L0 全景 + 全部章节 diff 验收清单：第2章、第3章候选待验收。' },
      ],
      routeDecisions: ['accept_as_truth', 'escalate_user'],
      reviewSeverities: [undefined, 'warn'],
      adjudication: 'accept',
    });
    const runtime = createWorkflowRuntime({ generate, runState: new RunStateStore() });
    const session = runtime.createSession({ agentName: 'writer', projectPath, mode: 'auto' });

    // 整个批量在单一 turn 内完成（hands_off 零问 = 无中途 turn break）。
    const turn1 = await runTurn(runtime, session.id, '放手把主线写完，灰区你采信初审就行');
    // 零中途咨询：全程只有一个真作者 user 消息（本 turn 的指令；session_state_note 是系统注入
    // 的 user-role 注记，非作者发言，不计入咨询点）。
    expect(turn1.filter((m) => m.role === 'user' && m.kind !== 'session_state_note')).toHaveLength(1);
    // chat 调档工具真生效 + 持久。
    const gearOutput = toolOutputs(turn1, 'set_participation_gear')[0];
    expect(gearOutput).toContain('参与档位已设置为 hands_off');
    expect(gearOutput).toContain('trustAdjudication=true');
    expect(getSession(session.id)?.participationGear).toBe('hands_off');
    expect(getSession(session.id)?.trustAdjudication).toBe(true);
    // start_batch 用会话 live 档位。
    expect(toolOutputs(turn1, 'start_batch')[0]).toContain('档位=hands_off');
    // 第2章 accept；第3章 escalate（灰区 warn）→ 裁决器 accept → 全自动采信（真机制：
    // write_chapter auto-trust 分支）→ 批量继续不问。
    const wcOutputs = toolOutputs(turn1, 'write_chapter');
    expect(wcOutputs).toHaveLength(2);
    expect(wcOutputs[0]).toContain('route: accept_as_truth');
    expect(wcOutputs[1]).toContain('route: escalate_user');
    // auto-trust accept 按设计不重复呈 findings（透明采信文案替之——write-chapter.ts 4.3 Step 6）。
    expect(wcOutputs[1]).toContain('【全自动采信】灰区裁决器初审建议「接受为真相」');
    expect(wcOutputs[1]).not.toContain('请你裁决'); // 未把灰区问题上抛用户（trust=true 采信语义）
    expect(wcOutputs[1]).toContain('已生成章节候选（chapter ch-1）');
    // 收尾 + 终态 + report 盖章。
    expect(toolOutputs(turn1, 'end_batch')[0]).toContain('收口（done）');
    expect(loadBatchRuns(projectPath)![0].status).toBe('done');
    const lastAssistant = turn1.filter((m) => m.role === 'assistant').at(-1)!;
    expect(lastAssistant.content).toContain('验收清单');
    expect(lastAssistant.batchKind).toBe('report');
    // leader 本 turn 注记尚无批量段（turn 开始时无活跃批量）——协议经 start_batch 工具 output
    // 指引（含「批量写作协议」指针）。
    expect(leaderNotes[0] ?? '').not.toContain('批量写作协议');
    expect(toolOutputs(turn1, 'start_batch')[0]).toContain('批量写作协议');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. hands_off + trust=true：BLOCK 硬违规仍必停（AC5 穿透纪律）
  // ──────────────────────────────────────────────────────────────────────────
  it('hands_off+trust BLOCK：write_chapter 返 block findings → 批量停下呈现（不写下一章），batch 保持 running', async () => {
    writeBatchProject(projectPath);
    const { generate, leaderNotes } = makeScenarioGenerate({
      leader: [
        { content: '切档。', toolCalls: [{ name: 'set_participation_gear', args: { gear: 'hands_off', trustAdjudication: true } }] },
        { content: '启动批量。', toolCalls: [{ name: 'start_batch', args: { lineTag: 'main' } }] },
        { content: '写第2章。', toolCalls: [writeChapterCall('ep0', 'ch-0', '城郊突破')] },
        // 穿透纪律（协议段「任何档位（含 hands_off + trustAdjudication=true）都不豁免 BLOCK」）：
        // findings 到达 → 停止逐场循环、呈现，turn break。
        { content: '批量停下：BLOCK 硬违规（trustAdjudication=true 也不豁免）。findings 已呈现，等你处理后再继续。' },
        // turn 2（用户知悉）：无工具——同时给断言「批量活跃时 hands_off 协议段注入」的机会。
        { content: '好的，批量保持当前状态。你处理完后说「继续」，我会先 batch_status 对账再续跑。' },
      ],
      routeDecisions: ['escalate_user'],
      reviewSeverities: ['block'],
      // 裁决器 parse 失败 → auto-trust 不采信 → findings + 「请你裁决」上呈（不假 pass）。
      adjudication: 'parse-fail',
    });
    const runtime = createWorkflowRuntime({ generate, runState: new RunStateStore() });
    const session = runtime.createSession({ agentName: 'writer', projectPath, mode: 'auto' });

    const turn1 = await runTurn(runtime, session.id, '放手把主线写完');
    // 只写了第2章；第3章未被触（批量停在第2章 escalate 处）。
    const wcCalls = assistantToolCalls(turn1).filter((c) => c.name === 'write_chapter');
    expect(wcCalls).toHaveLength(1);
    expect((JSON.parse(wcCalls[0].arguments) as { chapterId: string }).chapterId).toBe('ch-0');
    // BLOCK findings 穿透到 leader 可见（tool output）+ 采信失败上呈。
    const wcOutput = toolOutputs(turn1, 'write_chapter')[0];
    expect(wcOutput).toContain('route: escalate_user');
    expect(wcOutput).toContain('[block]');
    expect(wcOutput).toContain('未自动采信，请你裁决');
    // leader 停下（turn break）呈 findings，非继续。
    const lastAssistant1 = turn1.filter((m) => m.role === 'assistant').at(-1)!;
    expect(lastAssistant1.toolCalls).toBeUndefined();
    expect(lastAssistant1.content).toContain('BLOCK');
    // 批量未收口（等作者解决后续跑）。
    expect(loadBatchRuns(projectPath)![0].status).toBe('running');

    // turn 2：批量活跃 + live 档位 hands_off + trust → 协议段注入（穿透纪律文本到位）。
    const turn2 = await runTurn(runtime, session.id, '收到，我先看看这个 findings');
    expect(assistantToolCalls(turn2)).toHaveLength(0); // 停下等用户，不动批量
    const turn2Note = leaderNotes[leaderNotes.length - 1] ?? '';
    expect(turn2Note).toContain('批量写作协议');
    expect(turn2Note).toContain('参与档位=hands_off');
    expect(turn2Note).toContain('trustAdjudication=true');
    expect(turn2Note).toContain('全程不问');
    expect(turn2Note).toContain('不豁免 BLOCK');
    expect(turn2Note).toContain('0/4 场已完成'); // 章正文未落盘（accept 走工作台）→ 对账前进度 0
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. steer：每场写前问（AC2）
  // ──────────────────────────────────────────────────────────────────────────
  it('steer：每场（章）写前都 turn break 问；确认后才 write_chapter', async () => {
    writeBatchProject(projectPath);
    const { generate, leaderNotes } = makeScenarioGenerate({
      leader: [
        // turn 1：启动 + 逐场预告 → 写前问（turn break，零 write_chapter）。
        { content: '启动批量（掌舵）。', toolCalls: [{ name: 'start_batch', args: { lineTag: 'main' } }] },
        { content: '逐场预告：本场组 sc1+sc2 写入第2章，重点 sc2 细问——冲突正面化的方式选哪种？确认后开写。' },
        // turn 2：确认 → 写第2章 → 下一场写前再问（turn break）。
        { content: '写第2章。', toolCalls: [writeChapterCall('ep0', 'ch-0', '城郊突破')] },
        { content: '第2章完成。下一场组 sc3+sc4 写第3章（到锚点）——确认开写？' },
        // turn 3：确认 → 写第3章 → 收尾。
        { content: '写第3章。', toolCalls: [writeChapterCall('ep1', 'ch-1', '锚点收束')] },
        { content: '收口。', toolCalls: [{ name: 'end_batch', args: { outcome: 'done' } }] },
        { content: 'L0 全景（steer 完成）。' },
      ],
      routeDecisions: ['accept_as_truth', 'accept_as_truth'],
      reviewSeverities: [undefined, undefined],
      adjudication: 'parse-fail',
    });
    const runtime = createWorkflowRuntime({ generate, runState: new RunStateStore() });
    const session = runtime.createSession({ agentName: 'writer', projectPath, mode: 'auto', participationGear: 'steer' });

    // turn 1：写前问——启动后立即 turn break，未写任何章。
    const turn1 = await runTurn(runtime, session.id, '掌舵档把主线写到锚点');
    expect(assistantToolCalls(turn1).map((c) => c.name)).toEqual(['start_batch']);
    expect(toolOutputs(turn1, 'write_chapter')).toHaveLength(0);
    expect(turn1.filter((m) => m.role === 'assistant').at(-1)!.content).toContain('确认后开写');

    // turn 2：写第2章后再次 turn break（下一场写前问）。
    const turn2 = await runTurn(runtime, session.id, 'sc2 用当面对峙，开写');
    const turn2Calls = assistantToolCalls(turn2).filter((c) => c.name === 'write_chapter');
    expect(turn2Calls).toHaveLength(1);
    expect(turn2.filter((m) => m.role === 'assistant').at(-1)!.content).toContain('确认开写');
    // 批量活跃 turn 的注记：steer 协议注入。
    const turn2Note = leaderNotes[leaderNotes.length - 1] ?? '';
    expect(turn2Note).toContain('参与档位=steer');
    expect(turn2Note).toContain('每场写前都问');
    expect(turn2Note).toContain('逐场预告');

    // turn 3：写第3章 + 收尾完成。
    const turn3 = await runTurn(runtime, session.id, '确认，写完收尾');
    expect(assistantToolCalls(turn3).filter((c) => c.name === 'write_chapter')).toHaveLength(1);
    expect(toolOutputs(turn3, 'end_batch')[0]).toContain('收口（done）');
    expect(loadBatchRuns(projectPath)![0].status).toBe('done');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. balanced：走向单等确认（AC2）
  // ──────────────────────────────────────────────────────────────────────────
  it('balanced：走向单等作者确认才开写（确认前零 write_chapter）；圈类别协议注入', async () => {
    writeBatchProject(projectPath);
    const { generate, leaderNotes } = makeScenarioGenerate({
      leader: [
        // turn 1：走向单 → 等确认（turn break，零 write）。
        { content: '启动批量。', toolCalls: [{ name: 'start_batch', args: { lineTag: 'main' } }] },
        { content: '走向单：沿主线 4 场写 2 章，到锚点 sc4 收束。balanced 档——等你确认后开写；过程中只有命中圈定类别（主角安危/信息差/方向转弯）才打扰你。' },
        // turn 2：确认 → 两章直写（未命中圈类别不打扰）→ 收尾。
        { content: '作者已确认，开写第2章。', toolCalls: [writeChapterCall('ep0', 'ch-0', '城郊突破')] },
        { content: '开写第3章（未命中圈类别，自控直写）。', toolCalls: [writeChapterCall('ep1', 'ch-1', '锚点收束')] },
        { content: '收口。', toolCalls: [{ name: 'end_batch', args: { outcome: 'done' } }] },
        { content: 'L0 全景（balanced 完成，全程未命中圈类别）。' },
      ],
      routeDecisions: ['accept_as_truth', 'accept_as_truth'],
      reviewSeverities: [undefined, undefined],
      adjudication: 'parse-fail',
    });
    const runtime = createWorkflowRuntime({ generate, runState: new RunStateStore() });
    const session = runtime.createSession({ agentName: 'writer', projectPath, mode: 'auto', participationGear: 'balanced' });

    // turn 1：等确认——零 write_chapter + turn break。
    const turn1 = await runTurn(runtime, session.id, '平衡档推进主线');
    expect(assistantToolCalls(turn1).map((c) => c.name)).toEqual(['start_batch']);
    expect(toolOutputs(turn1, 'write_chapter')).toHaveLength(0);
    expect(turn1.filter((m) => m.role === 'assistant').at(-1)!.content).toContain('等你确认后开写');

    // turn 2：确认后两章连写（无中途 break）+ 收尾。
    const turn2 = await runTurn(runtime, session.id, '确认走向单，开写');
    expect(assistantToolCalls(turn2).filter((c) => c.name === 'write_chapter')).toHaveLength(2);
    expect(toolOutputs(turn2, 'end_batch')[0]).toContain('收口（done）');
    expect(loadBatchRuns(projectPath)![0].status).toBe('done');
    // 批量活跃 turn 的注记：balanced 协议（等确认 + 默认三项圈类别）。
    const turn2Note = leaderNotes[leaderNotes.length - 1] ?? '';
    expect(turn2Note).toContain('参与档位=balanced');
    expect(turn2Note).toContain('走向单必须等作者确认');
    expect(turn2Note).toContain('主角生死安危');
    expect(turn2Note).toContain('信息差关键抉择');
    expect(turn2Note).toContain('方向转弯');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. 崩溃恢复：磁盘 running 残留 + 章正文已落盘 →「继续」对账续跑（AC4）
  // ──────────────────────────────────────────────────────────────────────────
  it('崩溃恢复：running 残留批量 + ch-0 正文已落盘 → batch_status 对账 2/4 → 只续写剩余章 → 收口 + 盖章从磁盘重导', async () => {
    // fixture：ch-0 正文已落盘（模拟崩溃前 accept 持久化已发生）。
    writeBatchProject(projectPath, { landedCh0Prose: true });
    const { generate, leaderNotes } = makeScenarioGenerate({
      leader: [
        { content: '恢复：先对账批量进度。', toolCalls: [{ name: 'batch_status', args: {} }] },
        { content: '续写剩余的第3章。', toolCalls: [writeChapterCall('ep1', 'ch-1', '锚点收束')] },
        { content: '收口。', toolCalls: [{ name: 'end_batch', args: { outcome: 'done' } }] },
        { content: 'L0：崩溃恢复完成——已对账 2 场（第2章崩溃前已落盘），续写第3章到锚点。' },
      ],
      routeDecisions: ['accept_as_truth'],
      reviewSeverities: [undefined],
      adjudication: 'parse-fail',
    });
    const runtime = createWorkflowRuntime({ generate, runState: new RunStateStore() });
    const session = runtime.createSession({ agentName: 'writer', projectPath, mode: 'auto' });
    // 模拟崩溃残留：磁盘 batches.json running（真实崩溃不翻状态——无代码路径写 paused，那是
    // abort 未来 wiring 的标记态，其 batch_status 恢复语义已由 batch-tools 单测覆盖）+ 第 1 章正文
    // 已落盘 + 内存 stamp 丢失（进程重启 → in-memory map 空，磁盘是 durable 源）。
    saveBatchRuns(projectPath, [
      {
        batchId: 'batch-crash-e2e',
        createdAt: Date.now(),
        lineTag: 'main',
        orderedSceneIds: ['sc1', 'sc2', 'sc3', 'sc4'],
        doneSceneIds: [],
        gear: 'smart',
        status: 'running',
        chapterMap: { sc1: 'ch-0', sc2: 'ch-0', sc3: 'ch-1', sc4: 'ch-1' },
        sessionId: session.id,
      },
    ]);
    clearActiveBatchStamp(projectPath);

    // 「继续」turn：buildMainRunConfig 从磁盘重导 stamp（崩溃恢复 durable 源）。
    const turn1 = await runTurn(runtime, session.id, '继续');
    // batch_status 真对账：ch-0 正文已落盘 → sc1/sc2 done（2/4，对账重导磁盘空 doneSceneIds）。
    const statusResult = turn1
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.toolResults ?? [])
      .find((r) => r.toolName === 'batch_status')!;
    expect(statusResult.output).toContain('2/4 场已完成');
    expect(statusResult.output).toContain('对账新确认 2 场');
    expect(statusResult.output).toContain('sc1');
    expect(statusResult.output).toContain('sc2');
    const statusMeta = statusResult.metadata as { batch: { doneSceneIds: string[]; status: string } };
    expect(statusMeta.batch.doneSceneIds).toEqual(['sc1', 'sc2']);
    expect(statusMeta.batch.status).toBe('running');
    // 只续写剩余章（ch-1），不重写已落盘的 ch-0。
    const wcCalls = assistantToolCalls(turn1).filter((c) => c.name === 'write_chapter');
    expect(wcCalls).toHaveLength(1);
    expect((JSON.parse(wcCalls[0].arguments) as { chapterId: string }).chapterId).toBe('ch-1');
    expect(toolOutputs(turn1, 'write_chapter')[0]).toContain('route: accept_as_truth');
    // 收口 + 终态。
    expect(toolOutputs(turn1, 'end_batch')[0]).toContain('收口（done）');
    const finalRuns = loadBatchRuns(projectPath)!;
    expect(finalRuns[0].status).toBe('done');
    expect(finalRuns[0].batchId).toBe('batch-crash-e2e');
    // 盖章从磁盘重导：本 turn 消息盖回 batch-crash-e2e（progress → 收尾 report）。
    const stampedMsgs = turn1.filter((m) => m.role !== 'user');
    expect(stampedMsgs.length).toBeGreaterThan(0);
    for (const msg of stampedMsgs) {
      expect(msg.batchId).toBe('batch-crash-e2e');
    }
    expect(turn1.filter((m) => m.role === 'assistant').at(-1)!.batchKind).toBe('report');
    // 恢复 turn 的注记：批量协议 + turn 开始时进度 + 下一场。
    const turn1Note = leaderNotes[leaderNotes.length - 1] ?? '';
    expect(turn1Note).toContain('批量写作协议');
    expect(turn1Note).toContain('0/4 场已完成'); // turn 开始时 doneSceneIds 尚空（对账在工具内发生）
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. smart 档链内 escalate_user 灰区穿透 + 裁决后续跑（AC5）
  // ──────────────────────────────────────────────────────────────────────────
  it('smart escalate 穿透：链 escalate_user（warn）→ 批量停呈现非续写下一章 → 用户裁决后 batch_status 续跑收口', async () => {
    writeBatchProject(projectPath);
    const { generate } = makeScenarioGenerate({
      leader: [
        // turn 1：start_batch → 通报走向单（不阻塞，同 turn 直写非重点章）→ 链 escalate → 穿透停下。
        { content: '先解析批量边界。', toolCalls: [{ name: 'start_batch', args: { lineTag: 'main' } }] },
        { content: '走向单：4 场 2 章到锚点；sc1/sc2 判非重点，直写第2章。', toolCalls: [writeChapterCall('ep0', 'ch-0', '城郊突破')] },
        { content: '链内灰区上发（escalate 穿透纪律）——批量停下呈现 findings，不写下一章。请裁决：接受为真相还是改稿？' },
        // turn 2：裁决后 → batch_status 对账续跑 → 剩余章 → 收尾。
        { content: '作者裁决：接受为真相。对账续跑。', toolCalls: [{ name: 'batch_status', args: {} }] },
        { content: '续写第3章。', toolCalls: [writeChapterCall('ep1', 'ch-1', '锚点收束')] },
        { content: '收口。', toolCalls: [{ name: 'end_batch', args: { outcome: 'done' } }] },
        { content: 'L0：裁决后续跑完成（第2章灰区已裁决接受，第3章 accept 到锚点）。' },
      ],
      routeDecisions: ['escalate_user', 'accept_as_truth'],
      reviewSeverities: ['warn', undefined],
      adjudication: 'parse-fail',
    });
    const runtime = createWorkflowRuntime({ generate, runState: new RunStateStore() });
    const session = runtime.createSession({ agentName: 'writer', projectPath, mode: 'auto' });

    // turn 1：写第2章 → 链 escalate（灰区 warn，裁决器 parse 失败不采信）→ leader 停下。
    const turn1 = await runTurn(runtime, session.id, '全权把主线写到锚点');
    const wcCalls1 = assistantToolCalls(turn1).filter((c) => c.name === 'write_chapter');
    expect(wcCalls1).toHaveLength(1);
    const wcOutput1 = toolOutputs(turn1, 'write_chapter')[0];
    expect(wcOutput1).toContain('route: escalate_user');
    expect(wcOutput1).toContain('[warn]');
    expect(wcOutput1).toContain('未自动采信，请你裁决');
    const lastAssistant1 = turn1.filter((m) => m.role === 'assistant').at(-1)!;
    expect(lastAssistant1.toolCalls).toBeUndefined();
    expect(lastAssistant1.content).toContain('灰区');
    // 批量未收口（等裁决）。
    expect(loadBatchRuns(projectPath)![0].status).toBe('running');

    // turn 2：裁决后对账续跑 → 写第3章 → 收口。
    const turn2 = await runTurn(runtime, session.id, '接受为真相，继续');
    expect(toolOutputs(turn2, 'batch_status')[0]).toContain('剩余 4 场');
    const wcCalls2 = assistantToolCalls(turn2).filter((c) => c.name === 'write_chapter');
    expect(wcCalls2).toHaveLength(1);
    expect((JSON.parse(wcCalls2[0].arguments) as { chapterId: string }).chapterId).toBe('ch-1');
    expect(toolOutputs(turn2, 'write_chapter')[0]).toContain('route: accept_as_truth');
    expect(toolOutputs(turn2, 'end_batch')[0]).toContain('收口（done）');
    expect(loadBatchRuns(projectPath)![0].status).toBe('done');
    expect(turn2.filter((m) => m.role === 'assistant').at(-1)!.batchKind).toBe('report');
  });
});
