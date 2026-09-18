import { mkdtempSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';

// Story 3.7 WP2：write_chapter tool result metadata 的 Reader-Audit findings 结构化透传
// （design D5，additive——leader 文字呈现一字不动）。
//
// 验：
// a) escalate-pause（W1a 灰区裁决暂停）→ metadata.findings = { source:'reader-audit',
//    route:'escalate_user', chapterId, items } + 无 chapter_review 卡（裁决路径非 stage 审阅）
// b) escalate 呈现路径（completed+escalate 旧形态兼容）→ findings route='escalate_user' + 文字输出不变
// c) escalate 但 findings 空 → items: []（「已审核」锚点——UI 新鲜度门 D5b 按 chapterId 降级旧卡）
// d) 放手档 auto-trust accept（显式 opt-in 采信）→ findings 不透传（决策已定，跳过噪声——mirror 文字路径）
// e) stage pause → 不加 findings（ChapterReviewPanel 已结构化呈现 chapter_review，双源冗余）
// f) accept_as_truth 终态 → 无 findings（零回归）
// g) cap 超限 escalate-pause（W1a 链内产出）→ findings 透传
// h) escalate-pause 不传 chapterId → findings 无 chapterId 键（optional，mirror paused metadata 形态）
//
// mock skillExecutor.runChapterChain（控制 summary 返值）+ runAgentWithExplicitSystem（role-aware：
// director 空 entries / adjudicator 可控）。

vi.mock('../src/agent/session', () => ({
  getSession: vi.fn(),
  loadSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  addMessage: vi.fn(),
  updateStatus: vi.fn(),
  loadSessionMeta: vi.fn(),
}));

import { getSession } from '../src/agent/session';

const mockedGetSession = vi.mocked(getSession);

/** Story 3.5 之后采信权档位组合在 session 上（participationGear + trustAdjudication）。 */
function setSession(
  mode: 'readonly' | 'suggest' | 'auto' | undefined,
  gear?: 'smart' | 'steer' | 'balanced' | 'hands_off',
  trust?: boolean,
): void {
  if (mode === undefined) {
    mockedGetSession.mockReturnValue(undefined);
    return;
  }
  mockedGetSession.mockReturnValue({
    permissionMode: mode,
    ...(gear !== undefined ? { participationGear: gear } : {}),
    ...(trust !== undefined ? { trustAdjudication: trust } : {}),
  } as SessionState);
}

const FINDINGS = [
  {
    subClass: 'motivation',
    severity: 'warn' as const,
    quote: '主角突然决定进城',
    location: '句3',
    explanation: '前文未铺垫进城动机',
  },
];

/** valid adjudication JSON（parseAdjudication 硬要求：analysis + recommendation + ≥2 options）。 */
const ADJUDICATION_ACCEPT_JSON = JSON.stringify({
  analysis: '灰区整体可控，建议接受',
  recommendation: 'accept',
  recommendationReason: '缺陷不影响主线',
  options: [
    { label: '接受为真相', reason: '缺陷属风格层面' },
    { label: '改稿', reason: '补铺垫动机' },
  ],
});

describe('write_chapter Story 3.7 findings metadata 透传', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let adjudicatorContent: string;
  let ctx: ToolContext;

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-findings-'));
    runChapterChain = vi.fn();
    adjudicatorContent = '{}'; // 默认 parse 失败 → adjudication null（graceful 分支）
    runAgentWithExplicitSystem = vi.fn(async (_sid: string, role: string) => {
      if (role === 'director-agent') {
        return { content: JSON.stringify({ infoRelease: [], emotion: { points: [] }, atomicEdits: null }) };
      }
      if (role === 'revision-optimizer-agent') {
        return {
          content: JSON.stringify({
            change: { summary: '补强主角动机' },
            lockedItems: [],
            rationale: { source: 'audit-finding', note: 'auto_revise route decision' },
            provenance: { rawUserInstruction: '据审核发现修订', compilerNote: 'A-trigger' },
          }),
        };
      }
      if (role === 'adjudicator-agent') {
        return { content: adjudicatorContent };
      }
      return { content: '{}' };
    });
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runChapterChain, runSubagent: vi.fn(), executeSkillByName: vi.fn(), runAgentWithExplicitSystem },
    };
    mockedGetSession.mockReset();
  });

  afterEach(() => {
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  function writeReadyProject(): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify({
      meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-07-31T00:00:00Z', updated_at: '2026-07-31T00:00:00Z' },
      creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
      world_setting: { premise: '灵气复苏都市' },
      asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomline: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } }], edges: [], lines: [] },
      promise_registry: { promises: [], beats: [], version: 0 },
      episode_outlines: [{ id: 'ep1', index: 0, title: '开篇' }],
    }), 'utf8');
  }

  function makeEscalateSummary(withFindings = true): RunSnapshotSummary {
    return {
      status: 'completed',
      routeDecision: { decision: 'escalate_user', reason: '灰区难断' },
      ...(withFindings ? { escalateFindings: FINDINGS } : {}),
      errors: [],
    };
  }

  /** W1a escalate-pause summary（chainRunner 灰区暂停形态——非 stage pause）。 */
  function makeEscalatePauseSummary(): RunSnapshotSummary {
    return {
      status: 'paused',
      escalatePause: true,
      routeDecision: { decision: 'escalate_user', reason: '灰区难断' },
      escalateFindings: FINDINGS,
      errors: [],
    };
  }

  function makeAcceptSummary(): RunSnapshotSummary {
    return {
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '通过' },
      errors: [],
    };
  }

  function makePausedEscalateSummary(): RunSnapshotSummary {
    return {
      status: 'paused',
      pausedStage: 'draft',
      draftContent: '正文草稿',
      routeDecision: { decision: 'escalate_user', reason: '灰区难断' },
      escalateFindings: FINDINGS,
      errors: [],
    };
  }

  /** 既有（3.7 前）escalate 文案（suggest + 裁决器 parse 失败降级分支），逐字复刻。 */
  const PRECHANGE_ESCALATE_OUTPUT = [
    'status: completed',
    'route: escalate_user — 灰区难断',
    '',
    '灰区 findings（Reader-Audit 抓出，带正文原句）：',
    `  · [${FINDINGS[0].severity}] "${FINDINGS[0].quote}"（${FINDINGS[0].location}）—— ${FINDINGS[0].explanation}`,
    '',
    '【灰区上发】裁决器初审暂不可用（parse 失败/超时）——未自动采信，请你裁决。',
    // dogfood R2 #107 / R1.4：describeAcceptSkip no-chapter 文案更新（自动建章未发生的原因说明）。
    '灰区裁决：但无章节候选（章未在 project.yaml 注册或映射歧义，且不满足链侧自动建章条件（多章同 sort_order / 落位守卫未过 / 显式指定了 chapterId）——请先在工作台建章（章节列表空态「新建第一章」或 chapters/ 目录新建 .md 文件））——无法裁决落盘。',
  ].join('\n');

  // ─── a) W1a：escalate-pause（灰区裁决暂停）→ findings 透传（裁决 UI 消费面）───

  it('suggest mode + escalate-pause → metadata.findings 透传 + 无 chapter_review 卡（escalate-pause ≠ stage pause）', async () => {
    writeReadyProject();
    setSession('suggest');
    runChapterChain.mockResolvedValueOnce(makeEscalatePauseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterId: 'ch-7', chapterBrief: { goal: 'g' } },
      ctx,
    );

    const meta = result.metadata as { type?: string; findings?: { source: string; route: string; chapterId?: string; items: unknown[] } };
    // escalate-pause 不产 chapter_review（resume 路径是裁决分派非三动作审阅卡）
    expect(meta.type).toBeUndefined();
    expect(meta.findings).toEqual({
      source: 'reader-audit',
      route: 'escalate_user',
      chapterId: 'ch-7',
      items: FINDINGS,
    });
    // 待裁决指引文案在（R4b）
    expect(result.output).toContain('已暂停待裁决');
  });

  it('escalate-pause 不传 chapterId → findings 无 chapterId 键（optional，mirror paused metadata 形态）', async () => {
    writeReadyProject();
    setSession('suggest');
    runChapterChain.mockResolvedValueOnce(makeEscalatePauseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const meta = result.metadata as { findings?: Record<string, unknown> };
    expect(meta.findings).toBeDefined();
    expect(meta.findings).not.toHaveProperty('chapterId');
  });

  // ─── b) escalate 呈现路径 ───

  it('suggest mode + escalate → metadata.findings route=escalate_user + 文字输出不变', async () => {
    writeReadyProject();
    setSession('suggest');
    runChapterChain.mockResolvedValueOnce(makeEscalateSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute(
      { episodeId: 'ep1', chapterId: 'ch-8', chapterBrief: { goal: 'g' } },
      ctx,
    );

    const meta = result.metadata as { findings?: { source: string; route: string; chapterId?: string; items: unknown[] } };
    expect(meta.findings).toEqual({
      source: 'reader-audit',
      route: 'escalate_user',
      chapterId: 'ch-8',
      items: FINDINGS,
    });
    expect(result.output).toBe(PRECHANGE_ESCALATE_OUTPUT);
  });

  // ─── c) escalate 空 findings ───

  it('escalate 但 escalateFindings 缺省 → items: []（「已审核」锚点，非 undefined）', async () => {
    writeReadyProject();
    setSession('suggest');
    runChapterChain.mockResolvedValueOnce(makeEscalateSummary(false));

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const meta = result.metadata as { findings?: { items: unknown[] } };
    expect(meta.findings).toBeDefined();
    expect(meta.findings!.items).toEqual([]);
  });

  // ─── d) 放手档 auto-trust accept ───

  it('auto + hands_off + trust + 裁决器 accept → findings 不透传（决策已定跳过噪声，mirror 文字路径）', async () => {
    writeReadyProject();
    setSession('auto', 'hands_off', true);
    adjudicatorContent = ADJUDICATION_ACCEPT_JSON;
    runChapterChain.mockResolvedValueOnce(makeEscalateSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const meta = result.metadata as { findings?: unknown };
    expect(meta.findings).toBeUndefined();
    // 文字路径同语义：全自动采信文案在（既有行为零回归）。
    expect(result.output).toContain('【全自动采信】');
  });

  // ─── e) paused 不加 ───

  it('paused（即便携带 escalate routeDecision）→ metadata.type=chapter_review 且无 findings（D5：双源冗余）', async () => {
    writeReadyProject();
    setSession('readonly');
    runChapterChain.mockResolvedValueOnce(makePausedEscalateSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const meta = result.metadata as { type?: string; findings?: unknown };
    expect(meta.type).toBe('chapter_review');
    expect(meta.findings).toBeUndefined();
  });

  // ─── f) accept 终态零回归 ───

  it('accept_as_truth → 无 findings metadata（终态零回归）', async () => {
    writeReadyProject();
    setSession('suggest');
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const meta = result.metadata as { findings?: unknown };
    expect(meta.findings).toBeUndefined();
  });

  // ─── g) W1a：cap 超限 escalate-pause（链内 cap 防御直达入口层，leader 兜底循环退役）───

  it('cap 超限强制 escalate-pause（chainRunner 产）→ findings 透传（escalateFindings 链内已抽）', async () => {
    writeReadyProject();
    setSession('auto'); // gear 缺省 smart → 非 optIn → 不 auto-trust，走 escalate 呈现
    // W1a：cap 耗尽的强制 escalate 由 chainRunner 链内产出（escalate-pause 形态）——入口层直接消费。
    runChapterChain.mockResolvedValue(makeEscalatePauseSummary());

    const { writeChapterTool } = await import('../src/tool/write-chapter');
    const result = await writeChapterTool.execute({ episodeId: 'ep1', chapterBrief: { goal: 'g' } }, ctx);

    const meta = result.metadata as { findings?: { route: string; items: unknown[] }; summary?: RunSnapshotSummary };
    expect(meta.summary?.routeDecision?.decision).toBe('escalate_user');
    expect(meta.findings).toBeDefined();
    expect(meta.findings!.route).toBe('escalate_user');
    expect(meta.findings!.items).toEqual(FINDINGS);
  });
});
