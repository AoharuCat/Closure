import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateFn } from '../src/nodes/llm-node';
import { registry } from '../src/tool/registry';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 #7 车道接线测试（mirror taskModelRouting.wiring.test.ts 的防线逻辑：
// 「接线漏了」与「字段本来就不带」在回退语义下不可观测区分——唯一防线是逐锚点
// 断言 mock generate 第 5 参 opts.lane）。
//
// - background（240s 首事件窗 + 有界 600s cap 单次非流式回退）：
//   ① runChildAgent（runSubagent .md 子 agent）
//   ② runChildAgentWithExplicitSystem（yaml 契约派发——dispatch/review 族）
//   ③ skill executor 指令节点（executeSkillByName）
//   ④ 写章链 runChapterChain（全部节点经 wrapper 注入）
// - dialogue（缺省 undefined = interactive 60s 红线，不带 lane）：
//   ⑤⑥ leader sendMessage / streamMessage 两对话车道
// - cacheControl（C 批 W_c2，09-12 稳定化 / C3.4）：Anthropic prompt-cache 断点开关仅
//   ⑤⑥ dialogue 两车道置 true；①-④ child/skill/链车道恒 undefined（钉面——flag 缺省
//   = 协议层零行为，装配面零扩散）。
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

/** 取第 i 次 generate 调用实收的 opts.lane。 */
function laneAt(
  generate: ReturnType<typeof vi.fn<GenerateFn>>,
  i: number,
): string | undefined {
  return generate.mock.calls[i]?.[4]?.lane;
}

describe('dogfood R2 #7 车道接线 — child / skill / 链 generate 带 lane:"background"', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-lane-wiring-'));
    // 链 fixture 走「工具环境不可用 → legacy 降级直写」单发路径（mirror wiring 测试 CR-010）。
    registry.__clearForTest();
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  async function makeRuntime(generate: ReturnType<typeof vi.fn<GenerateFn>>, skillRegistry?: unknown) {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    return createWorkflowRuntime({ generate, ...(skillRegistry ? { skillRegistry } : {}) });
  }

  it('runAgentWithExplicitSystem（yaml 契约派发）→ generate 实收 lane:"background"', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: '{"ok":true}', finishReason: 'stop' }));
    const runtime = await makeRuntime(generate);
    const session = runtime.createSession({ agentName: 'creative-director', projectPath });

    await runtime.runAgentWithExplicitSystem(session.id, 'director-agent', {}, {});

    expect(generate).toHaveBeenCalledTimes(1);
    expect(laneAt(generate, 0)).toBe('background');
    // C 批 W_c2：cacheControl 仅 dialogue 两装配点置位——child 车道恒 undefined（钉面）。
    expect(generate.mock.calls[0]?.[4]?.cacheControl).toBeUndefined();
  });

  it('runSubagent（.md 子 agent runChildAgent）→ generate 实收 lane:"background"', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: 'Expanded into 12 scene beats.', finishReason: 'stop' }));
    const runtime = await makeRuntime(generate);
    const session = runtime.createSession({ agentName: 'creative-director', projectPath });

    const result = await runtime.runSubagent(session.id, 'outline-expander', 'Expand this outline.');

    expect(result.content).toBe('Expanded into 12 scene beats.');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(laneAt(generate, 0)).toBe('background');
    expect(generate.mock.calls[0]?.[4]?.cacheControl).toBeUndefined();
  });

  it('executeSkill（skill 指令节点 runLoop）→ generate 实收 lane:"background"', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: 'Skill executed.', finishReason: 'stop' }));
    const { SkillRegistry } = await import('../src/skill/runtime/registry');
    const skillRegistry = new SkillRegistry();
    skillRegistry.register({
      format: 'manifest',
      name: 'story-setup',
      description: 'Prepare the story context',
      location: 'I:/skills/story-setup',
      entryPath: 'I:/skills/story-setup/skill.json',
      prompt: 'Prepare the story context.',
      workflowMode: 'workflow',
      assets: { references: [], scripts: [] },
    });
    const runtime = await makeRuntime(generate, skillRegistry);
    const session = runtime.createSession({ agentName: 'writer', projectPath });

    const result = await runtime.executeSkill('story-setup', {
      sessionId: session.id,
      input: 'Noir opening.',
    });

    expect(result.status).toBe('completed');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(laneAt(generate, 0)).toBe('background');
    expect(generate.mock.calls[0]?.[4]?.cacheControl).toBeUndefined();
  });

  it('runChapterChain（写章链全部节点）→ 每次 generate 实收 lane:"background"', async () => {
    // mirror runChapterChain.test.ts makeChainGenerate：按 system 标记返 fixture，链跑通（route 首判 accept）。
    const generate = vi.fn<GenerateFn>(async (_msgs, sys) => {
      const s = sys ?? '';
      if (s.includes('规划审核')) {
        // W1d：brief-reviewer（A2 规划审核）——pass 直通（须在 generic「审核」前，system 含「审核」子串）。
        return { content: JSON.stringify({ verdict: 'pass', summary: '卡可写', findings: [] }), finishReason: 'stop' };
      }
      if (s.includes('路由判决')) {
        return { content: JSON.stringify({ decision: 'accept_as_truth', reason: '达标' }), finishReason: 'stop' };
      }
      if (s.includes('完整性审核')) {
        return { content: JSON.stringify({ findings: [], summary: '无缺漏', degraded: false }), finishReason: 'stop' };
      }
      if (s.includes('Reader-Audit') || s.includes('多维度') || s.includes('审核')) {
        return { content: JSON.stringify({ verdict: 'pass', summary: '节奏合理', dimensions: [], reasons: [] }), finishReason: 'stop' };
      }
      if (s.includes('状态提取')) {
        return { content: JSON.stringify({ storyTime: 5, title: '状态切面', subjects: [], patches: [] }), finishReason: 'stop' };
      }
      if (s.includes('story-sync-agent')) {
        return { content: JSON.stringify({ runId: 'r', chapterId: 'ep1', patches: [], summary: '无可提取' }), finishReason: 'stop' };
      }
      return {
        content: JSON.stringify({ title: '第二章', text: '黄昏的荒野上。', wordCount: 2800, chapterId: 'ep1' }),
        finishReason: 'stop',
      };
    });
    const runtime = await makeRuntime(generate);
    const parent = runtime.createSession({ agentName: 'creative-director', projectPath });

    const summary = await runtime.runChapterChain(parent.id, {
      scene_graph: { nodes: [{ id: 's1', episodeId: 'ep1' }] },
      chapter_brief_input: { episodeId: 'ep1', brief: { goal: '抵达 B 城', tone: '紧张' } },
      settings_context: 'PREFIX_SETTINGS_TEXT',
      promise_registry: { promises: [], beats: [], version: 0 },
    });

    expect(summary.status).toBe('completed');
    expect(generate.mock.calls.length).toBe(11); // W1d：+brief-reviewer（C1 首圈 no-op 零调用）
    for (let i = 0; i < generate.mock.calls.length; i += 1) {
      expect(laneAt(generate, i), `call#${i}（链车道）`).toBe('background');
      // C 批 W_c2：链车道 cacheControl 恒 undefined（mirror sessionKey 链侧钉面形态）。
      expect(generate.mock.calls[i]?.[4]?.cacheControl, `call#${i}（链车道）`).toBeUndefined();
    }
  });
});

describe('dogfood R2 #7 车道接线 — leader 对话车道不带 lane（interactive 60s 红线）', () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-lane-dialogue-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  it('sendMessage → generate 实收 lane:undefined（缺省 = dialogue 语义）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: 'ok', finishReason: 'stop' }));
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath });

    await runtime.sendMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(laneAt(generate, 0)).toBeUndefined();
    // 09-12 system 稳定化：dialogue 会话键接回（mirror 链侧 `chain:<id>:writer` 命名式）——
    // system 恒定区落地后 agy 长驻会话 mirror 走 append 命中。
    expect(generate.mock.calls[0]?.[4]?.sessionKey).toBe(`dialogue:${session.id}`);
    // C 批 W_c2（09-12 稳定化 / C3.4）：dialogue 装配点置 Anthropic 断点开关——generate 实收。
    expect(generate.mock.calls[0]?.[4]?.cacheControl).toBe(true);
  });

  it('streamMessage（流式对话车道）→ generate 实收 lane:undefined', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({ content: 'ok', finishReason: 'stop' }));
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath });

    await runtime.streamMessage({
      sessionId: session.id,
      content: 'hi',
      abortSignal: new AbortController().signal,
      sendEvent: () => {},
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(laneAt(generate, 0)).toBeUndefined();
    // 稳定化同上：流式对话车道会话键同款接回。
    expect(generate.mock.calls[0]?.[4]?.sessionKey).toBe(`dialogue:${session.id}`);
    // C 批 W_c2 同上：流式对话车道断点开关同款置位。
    expect(generate.mock.calls[0]?.[4]?.cacheControl).toBe(true);
  });
});
