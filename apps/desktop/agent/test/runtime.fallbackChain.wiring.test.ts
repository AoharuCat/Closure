import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  episodeOutlineSchema,
  type ResearchBrief,
} from '@orison/shared-contracts';
import { runChain } from '../src/runtime/chainRunner';
import { createChapterChainNodes, type ChainSlotResolver } from '../src/nodes/chapter-chain';
import { assignmentFallbackChain, resolveTaskModel, setTaskSlotResolver } from '../src/runtime/taskModelRouting';
import { registry } from '../src/tool/registry';
import { setExecuteToolFn } from '../src/tool/remote';
import { runLoop } from '../src/agent/loop';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { SessionState } from '../src/types';
import type { RunSnapshot } from '../src/contracts/run';
import type { GenerateResult } from '../src/provider/ipc-provider';
import { generate, setGenerateTextFn } from '../src/provider/ipc-provider';

// ─────────────────────────────────────────────────────────────────────────────
// 09-12 子2 fallback chains W4 接线测试（mirror runtime.taskModelRouting.wiring
// 的「断言钉 mock generate 实收 opts」红线形态）：
// - assignmentFallbackChain 投影单源（条目归一 / 无链两态）
// - 链节点路径 fallbacks 实达 generate opts（draft·legacy 直写 ≥1 点 + review/extraction 档）
// - writer 两阶段双档链分离（selfcheck ?? draft 不杂交）+ onModelFallback nodeId/role 包装
// - runLoop 终态 generatedBy 盖章（modelRef + fallbackTrace；无注记零字段回归门）
// - ipc-provider seam 三跳：body.fallbacks 拼装 / onFallback 过 callbacks / 结果注记映射
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ═══ 0. assignmentFallbackChain 投影单源（纯函数） ═══

describe('assignmentFallbackChain 投影（taskModelRouting 第三投影 helper）', () => {
  it('无 assignment / 无 fallbacks / 空数组 → undefined（写侧两态：空链不占位）', () => {
    expect(assignmentFallbackChain(undefined)).toBeUndefined();
    expect(assignmentFallbackChain({ keyId: 'k', modelId: 'm' })).toBeUndefined();
    // 内存形态的 []（schema 拒收，但投影 helper 防御性归一为缺席）
    expect(assignmentFallbackChain({ keyId: 'k', modelId: 'm', fallbacks: [] })).toBeUndefined();
  });

  it('条目 → wire 归一形态：ref 平铺投影 + per-entry thinking 归一（custom 优先 / auto→undefined）', () => {
    const chain = assignmentFallbackChain({
      keyId: 'k0',
      modelId: 'm0',
      thinking: 'high',
      fallbacks: [
        { keyId: 'k1', modelId: 'm1' },
        { keyId: 'k2', modelId: 'm2', thinking: 'low' },
        { keyId: 'k3', modelId: 'm3', thinking: 'auto' },
        { keyId: 'k4', modelId: 'm4', thinkingCustom: '8192' },
      ],
    });
    expect(chain).toEqual([
      { ref: { keyId: 'k1', modelId: 'm1' }, thinking: undefined },
      { ref: { keyId: 'k2', modelId: 'm2' }, thinking: { level: 'low' } },
      { ref: { keyId: 'k3', modelId: 'm3' }, thinking: undefined },
      { ref: { keyId: 'k4', modelId: 'm4' }, thinking: { level: 'custom', custom: '8192' } },
    ]);
  });

  it('主指派自身的 thinking 不渗入条目（条目覆盖语义的投影面）', () => {
    const chain = assignmentFallbackChain({
      keyId: 'k0',
      modelId: 'm0',
      thinking: 'high',
      fallbacks: [{ keyId: 'k1', modelId: 'm1' }],
    });
    // 条目无 thinking → undefined（auto），非主指派的 high。
    expect(chain?.[0]?.thinking).toBeUndefined();
  });
});

// ═══ 1. 链 e2e（legacy 降级直写路径）：fallbacks 实达 generate opts ═══

const TARGET_EPISODE = 'ep2';

const INITIAL_DRAFT = {
  title: '第二章 B 城',
  text: '黄昏的荒野上，主角深吸一口气。',
  wordCount: 2800,
  chapterId: TARGET_EPISODE,
};

const REVIEW_RESULT = {
  verdict: 'accept',
  score: 8,
  dimensions: [{ name: 'consistency', findings: [] }],
  reasons: ['达标'],
};

function makeSession(): SessionState {
  return {
    id: 'sess_fb_wire',
    agentName: 'chapter-chain',
    projectPath: '/test/fallback-wiring',
    status: 'idle',
    messages: [],
    children: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeInitialArtifacts(): Record<string, unknown> {
  return {
    scene_graph: { nodes: [], edges: [], lines: [], art_overrides: [], version: 0, updatedBy: 'agent' },
    episode_outlines: [
      episodeOutlineSchema.parse({ id: 'ep1', index: 0, title: '第一章' }),
      episodeOutlineSchema.parse({ id: TARGET_EPISODE, index: 1, title: '第二章' }),
    ],
    settings_context: '世界观：灵气复苏的现代都市。',
    chapter_brief_input: { episodeId: TARGET_EPISODE, brief: { goal: '抵达 B 城' } },
    chapter_brief: { goal: '抵达 B 城' },
  };
}

function makeE2eGenerate() {
  return vi.fn<GenerateFn>(async (_msgs, sys): Promise<GenerateResult> => {
    const s = sys ?? '';
    if (s.includes('路由判决')) {
      return { content: JSON.stringify({ decision: 'accept_as_truth', reason: '正文达标' }), finishReason: 'stop' };
    }
    if (s.includes('修订编辑')) {
      return { content: JSON.stringify(INITIAL_DRAFT), finishReason: 'stop' };
    }
    if (s.includes('完整性审核')) {
      return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
    }
    if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
      return { content: JSON.stringify(REVIEW_RESULT), finishReason: 'stop' };
    }
    if (s.includes('状态提取')) {
      return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
    }
    if (s.includes('story-sync-agent')) {
      return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
    }
    return { content: JSON.stringify(INITIAL_DRAFT), finishReason: 'stop' };
  });
}

/** slot → assignment（modelId=slot-<slot> + 各自的链）——断言按 modelId 反查档位。 */
const chainResolver: ChainSlotResolver = (slot) => ({
  keyId: 'wire',
  modelId: `slot-${slot}`,
  ...(slot === 'writer-draft' || slot === 'review-judge' || slot === 'extraction'
    ? { fallbacks: [{ keyId: `fb-${slot}`, modelId: `fb-model-${slot}` }] }
    : {}),
});

/** 取第 i 次 generate 调用实收的 opts.fallbacks。 */
function fallbacksAt(
  fn: ReturnType<typeof vi.fn<GenerateFn>>,
  i: number,
): Array<{ ref: { keyId: string; modelId: string } }> | undefined {
  return fn.mock.calls[i]?.[4]?.fallbacks;
}

describe('W4 接线 — 链节点 fallbacks 实达 generate opts（chapter-chain llmDepsFor）', () => {
  beforeEach(() => {
    registry.__clearForTest();
  });

  it('配链档位的全部节点调用实收该档链（writer-draft·legacy 直写 / extraction×6 / review-judge×3）', async () => {
    const gen = makeE2eGenerate();
    const session = makeSession();
    const snapshot = await runChain(
      { chain: createChapterChainNodes(gen, chainResolver, session), initialArtifacts: makeInitialArtifacts(), requirement: '' },
      { generate: gen, sessionContext: session, signal: new AbortController().signal },
    );

    expect(snapshot.status).toBe('completed');
    for (let i = 0; i < gen.mock.calls.length; i += 1) {
      const ref = gen.mock.calls[i]?.[4]?.modelRef;
      const slot = ref?.modelId.replace(/^slot-/, '') ?? 'writer-draft';
      const hasChain = slot === 'writer-draft' || slot === 'review-judge' || slot === 'extraction';
      expect(
        fallbacksAt(gen, i),
        `call#${i}（${slot} 档）`,
      ).toEqual(
        hasChain
          ? [{ ref: { keyId: `fb-${slot}`, modelId: `fb-model-${slot}` } }]
          : undefined,
      );
    }
  });

  it('未配链（无 fallbacks 字段）→ 全部调用 opts.fallbacks=undefined（零默认链回归门）', async () => {
    const noChainResolver: ChainSlotResolver = (slot) => ({ keyId: 'wire', modelId: `slot-${slot}` });
    const gen = makeE2eGenerate();
    const session = makeSession();
    await runChain(
      { chain: createChapterChainNodes(gen, noChainResolver, session), initialArtifacts: makeInitialArtifacts(), requirement: '' },
      { generate: gen, sessionContext: session, signal: new AbortController().signal },
    );
    for (let i = 0; i < gen.mock.calls.length; i += 1) {
      expect(fallbacksAt(gen, i), `call#${i}`).toBeUndefined();
    }
  });
});

// ═══ 2. writer 两阶段双档链 + onModelFallback nodeId/role 包装 ═══

const VALID_BRIEF: ResearchBrief = {
  plan: '先城门对峙再入城收束',
  entries: [{ ref: 'char-lin', kind: 'asset', key_facts: [{ fact: '林昭左臂旧伤未愈', source: '人物卡' }] }],
  issues: [],
  execution_plan: [{ scene_ref: 's_gate', beat_coverage: '对峙节拍', notes: '' }],
  deviations: [],
};
const VALID_DRAFT = { title: '第二章 B 城', text: '黄昏的荒野上……', wordCount: 2800, chapterId: 'ch_2' };
const VALID_DECLARATION = { synopsis: '各自遇袭。', present: [{ name: '林昭' }], mentioned: [] };

function textRound(content: string): GenerateResult {
  return { content, finishReason: 'stop' };
}

function passVerdictJson(): string {
  return `${JSON.stringify({
    checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
    pass: true,
    gaps: [],
    suggestions: [],
    archive_issues: [],
  })}\n<VERIFICATION_VERDICT_READY>`;
}

describe('W4 接线 — writer 双档链分离 + onModelFallback 包装（两阶段生产形态）', () => {
  let dir = '';

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'orison-fb-wire-writer-'));
    registry.__clearForTest();
    const { registerBuiltinTools } = await import('../src/tool/builtin');
    registerBuiltinTools();
    setExecuteToolFn(async (toolId) => ({ title: toolId, output: `(${toolId} unset)` }));
  });

  afterEach(() => {
    rmBestEffort(dir);
    setTaskSlotResolver(undefined);
    setExecuteToolFn(undefined);
  });

  it('selfcheck 链 / draft 链分档实达：Phase1+核实器收 selfcheck 链、Phase2+2.5 收 draft 链（不杂交）', async () => {
    setTaskSlotResolver((slot) => {
      if (slot === 'writer-selfcheck') {
        return {
          keyId: 'wire', modelId: 'slot-writer-selfcheck',
          fallbacks: [{ keyId: 'fb-sc', modelId: 'fb-model-sc' }],
        };
      }
      if (slot === 'writer-draft') {
        return {
          keyId: 'wire', modelId: 'slot-writer-draft',
          fallbacks: [{ keyId: 'fb-dr', modelId: 'fb-model-dr', thinking: 'low' as const }],
        };
      }
      return undefined;
    });
    const gen = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(passVerdictJson()))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const session: SessionState = {
      id: 'sess-fb-wire', agentName: 'chapter-chain', projectPath: dir, status: 'idle',
      messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
    const node = createChapterChainNodes(gen, (s) => setTaskSlotResolverGetCurrent(s), session)
      .find((c) => c.id === 'draft-writer-agent')!.node;

    const result = await node.run({
      run: {
        runId: 'run_fb_wire', status: 'running', currentNodeId: null, projectPath: dir,
        completedNodes: [], pendingNodes: [],
        artifacts: {
          chapter_brief: { goal: '抵达 B 城' },
          chapter_brief_input: { episodeId: 'ep-fb', brief: { goal: '抵达 B 城' } },
          scene_graph: { nodes: [] },
          settings_context: '设定前缀文本',
        },
        review: null, archive: null, delivery: null, feedback: null,
      } satisfies RunSnapshot,
      requirement: '',
    });

    expect(result.stateKey).toBe('draft.initial');
    expect(gen).toHaveBeenCalledTimes(4);
    // Phase1 自查 + 核实器 → selfcheck 档链；Phase2 写作 + 2.5 申报 → draft 档链（含条目 thinking）。
    expect(fallbacksAt(gen, 0)).toEqual([{ ref: { keyId: 'fb-sc', modelId: 'fb-model-sc' }, thinking: undefined }]);
    expect(fallbacksAt(gen, 1)).toEqual([{ ref: { keyId: 'fb-sc', modelId: 'fb-model-sc' }, thinking: undefined }]);
    expect(fallbacksAt(gen, 2)).toEqual([{ ref: { keyId: 'fb-dr', modelId: 'fb-model-dr' }, thinking: { level: 'low' } }]);
    expect(fallbacksAt(gen, 3)).toEqual([{ ref: { keyId: 'fb-dr', modelId: 'fb-model-dr' }, thinking: { level: 'low' } }]);
  });

  it('onModelFallback：generate opts.onFallback 触发 → createChapterChainNodes 包装补 nodeId/role', async () => {
    setTaskSlotResolver((slot) =>
      slot === 'writer-draft'
        ? { keyId: 'wire', modelId: 'slot-writer-draft', fallbacks: [{ keyId: 'fb-dr', modelId: 'fb-model-dr' }] }
        : undefined,
    );
    const emitted: Array<Record<string, unknown>> = [];
    // 标准两阶段脚本（mirror twoPhaseGenerate）+ Phase1 首轮触发一次 onFallback（模拟网关
    // 切换事件穿透）。计数式实现（mockResolvedValueOnce 队列会先于默认实现消费，onFallback
    // 触发点会错位）。
    let scriptCall = 0;
    const gen = vi.fn<GenerateFn>(async (_msgs, _sys, _tls, _abort, opts): Promise<GenerateResult> => {
      scriptCall += 1;
      if (scriptCall === 1) {
        opts?.onFallback?.({ from: { keyId: 'wire', modelId: 'slot-writer-draft' }, to: { keyId: 'fb-dr', modelId: 'fb-model-dr' }, reason: 'quota: HTTP 429', attempt: 1 });
        return textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`);
      }
      if (scriptCall === 2) return textRound(passVerdictJson());
      if (scriptCall === 3) return textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`);
      return textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`);
    });
    const session: SessionState = {
      id: 'sess-fb-emit', agentName: 'chapter-chain', projectPath: dir, status: 'idle',
      messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
    const node = createChapterChainNodes(
      gen,
      (s) => setTaskSlotResolverGetCurrent(s),
      session,
      undefined,
      undefined,
      (event) => emitted.push(event as unknown as Record<string, unknown>),
    ).find((c) => c.id === 'draft-writer-agent')!.node;

    await node.run({
      run: {
        runId: 'run_fb_emit', status: 'running', currentNodeId: null, projectPath: dir,
        completedNodes: [], pendingNodes: [],
        artifacts: {
          chapter_brief: { goal: '抵达 B 城' },
          chapter_brief_input: { episodeId: 'ep-fb2', brief: { goal: '抵达 B 城' } },
          scene_graph: { nodes: [] },
          settings_context: '设定前缀文本',
        },
        review: null, archive: null, delivery: null, feedback: null,
      } satisfies RunSnapshot,
      requirement: '',
    });

    // 事件带 nodeId/role（链节点运行卡 chip 定位）——来自 chapter-chain 的包装层。
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted[0]).toMatchObject({
      from: { keyId: 'wire', modelId: 'slot-writer-draft' },
      to: { keyId: 'fb-dr', modelId: 'fb-model-dr' },
      reason: 'quota: HTTP 429',
      attempt: 1,
      nodeId: 'draft-writer-agent',
      role: 'draft-writer-agent',
    });
  });
});

/** 测试内 helper：经注入 resolver 现读（mirror 生产 `(slot) => resolveTaskModel(slot)`）。 */
function setTaskSlotResolverGetCurrent(slot: Parameters<ChainSlotResolver>[0]) {
  // resolver 已在 beforeEach 经 setTaskSlotResolver 注入——直读单源 resolveTaskModel。
  return resolveTaskModel(slot);
}

// ═══ 3. runLoop 终态 generatedBy 盖章 ═══

describe('W4 接线 — runLoop 终态 generatedBy 盖章（design §7.2）', () => {
  it('generate 回传 modelRef + fallbackTrace → 终帧 assistant 消息盖 generatedBy（含 fallbackFrom）', async () => {
    const collected: import('../src/types').SessionMessage[] = [];
    await runLoop({
      sessionId: 's-fb',
      projectPath: '.',
      messages: [{ id: 'u1', role: 'user', content: 'hi', createdAt: Date.now() }],
      systemPrompt: 'sys',
      tools: [],
      maxSteps: 3,
      generate: async () => ({
        content: '答案',
        finishReason: 'stop',
        modelRef: { keyId: 'key_b', modelId: 'model-b' },
        fallbackTrace: [{ keyId: 'key_a', modelId: 'model-a', reason: 'quota: HTTP 429' }],
      }),
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
    });

    const assistant = collected.find((m) => m.role === 'assistant');
    expect(assistant?.generatedBy).toEqual({
      keyId: 'key_b',
      modelId: 'model-b',
      fallbackFrom: [{ keyId: 'key_a', modelId: 'model-a', reason: 'quota: HTTP 429' }],
    });
  });

  it('generate 无注记（无链路径）→ generatedBy 字段缺席（旧消息零迁移回归门）', async () => {
    const collected: import('../src/types').SessionMessage[] = [];
    await runLoop({
      sessionId: 's-fb2',
      projectPath: '.',
      messages: [{ id: 'u2', role: 'user', content: 'hi', createdAt: Date.now() }],
      systemPrompt: 'sys',
      tools: [],
      maxSteps: 3,
      generate: async () => ({ content: '答案', finishReason: 'stop' }),
      onMessage: (m) => collected.push(m),
      abort: new AbortController().signal,
    });
    const assistant = collected.find((m) => m.role === 'assistant');
    expect(assistant && 'generatedBy' in assistant).toBe(false);
  });
});

// ═══ 4. ipc-provider seam 三跳（body 拼装 / callbacks 过缝 / 结果注记映射） ═══

describe('W4 接线 — ipc-provider seam（fallbacks 载荷拼装 + onFallback callbacks + 注记映射）', () => {
  const seenBodies: unknown[] = [];
  const seenCallbacks: unknown[] = [];
  const switchEvents: unknown[] = [];

  beforeEach(() => {
    seenBodies.length = 0;
    seenCallbacks.length = 0;
    switchEvents.length = 0;
    setGenerateTextFn(async (body, _abort, callbacks) => {
      seenBodies.push(body);
      seenCallbacks.push(callbacks);
      callbacks?.onFallback?.({ from: { keyId: 'k0', modelId: 'm0' }, to: { keyId: 'k1', modelId: 'm1' }, reason: 'quota: x', attempt: 1 });
      return {
        text: 'ok',
        finishReason: 'stop',
        modelRef: { keyId: 'k1', modelId: 'm1' },
        fallbackTrace: [{ keyId: 'k0', modelId: 'm0', reason: 'quota: x' }],
      };
    });
  });

  afterEach(() => {
    setGenerateTextFn(async () => {
      throw new Error('unset');
    });
  });

  it('opts.fallbacks → body.fallbacks；opts.onFallback → callbacks.onFallback（M1 三跳防线）', async () => {
    const result = await generate(
      [{ id: 'u', role: 'user', content: 'hi', createdAt: Date.now() }],
      'sys',
      [],
      new AbortController().signal,
      {
        fallbacks: [{ ref: { keyId: 'k1', modelId: 'm1' } }],
        onFallback: (event) => switchEvents.push(event),
      },
    );

    expect((seenBodies[0] as { fallbacks?: unknown }).fallbacks).toEqual([
      { ref: { keyId: 'k1', modelId: 'm1' } },
    ]);
    // onFallback 与 onDelta 同一 callbacks 对象过缝（onDelta 缺席仍传 callbacks）。
    expect(seenCallbacks[0]).toBeTruthy();
    expect(switchEvents).toEqual([
      { from: { keyId: 'k0', modelId: 'm0' }, to: { keyId: 'k1', modelId: 'm1' }, reason: 'quota: x', attempt: 1 },
    ]);
    // 注记映射：GenerateResult.modelRef / fallbackTrace。
    expect(result.modelRef).toEqual({ keyId: 'k1', modelId: 'm1' });
    expect(result.fallbackTrace).toEqual([{ keyId: 'k0', modelId: 'm0', reason: 'quota: x' }]);
  });

  it('无 fallbacks / 无回调 → body 不带字段 + 两参调用形态（零回归门）', async () => {
    await generate(
      [{ id: 'u2', role: 'user', content: 'hi', createdAt: Date.now() }],
      'sys',
      [],
      new AbortController().signal,
    );
    expect('fallbacks' in (seenBodies[0] as object)).toBe(false);
  });
});
