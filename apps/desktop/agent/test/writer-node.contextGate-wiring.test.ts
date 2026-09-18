import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResearchBrief } from '@orison/shared-contracts';
import { setTaskSlotResolver } from '../src/runtime/taskModelRouting';
import { setContextPolicyProvider } from '../src/runtime/contextPolicy';
import { registry } from '../src/tool/registry';
// CR-24：beforeEach 注入 / afterEach 还原配对（见 describe 内注释）。
import { setExecuteToolFn } from '../src/tool/remote';
import type { GenerateResult } from '../src/provider/ipc-provider';

// ─────────────────────────────────────────────────────────────────────────────
// S4c（task 08-25 design §4.1「makeAgentLoop 补闸门」接线）：chapter-chain 装配处把
// 窗口（各自 loop 所用 assignment 的模型 limits）+ 红线（readContextPolicy() 链装配现读）
// 注入 writer 两阶段循环与资料员核实子循环的 AgentLoopConfig（S4a 接收面）。
// 接线钉法：partial-mock agent-loop（透传真实 makeAgentLoop + spy 捕获 config）——
// 「注入漏了」表现为 config 无窗口字段（回落 1M），只有入参能钉住（mirror
// workflow.leaderContext.test.ts 的 prepareContext 钉法）。
// ─────────────────────────────────────────────────────────────────────────────

const makeAgentLoopSpy = vi.fn();

vi.mock('../src/nodes/agent-loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/nodes/agent-loop')>();
  return {
    ...actual,
    makeAgentLoop: ((deps: unknown, config: unknown) => {
      makeAgentLoopSpy(config);
      return actual.makeAgentLoop(deps as never, config as never);
    }) as typeof actual.makeAgentLoop,
  };
});

import { createChapterChainNodes } from '../src/nodes/chapter-chain';
import type { SessionState } from '../src/types';
import type { AgentNode, RunSnapshot } from '../src/contracts/run';
import type { GenerateFn } from '../src/nodes/llm-node';

// registry limits 锚（shared-contracts model-registry 单源数据）：glm-5.1 窗口 204_800、
// kimi-k2 系窗口 262_144——两档窗口不同，可区分「窗口随各自 loop 的 assignment」。
const SELFCHECK_WINDOW = 204_800;
const DRAFT_WINDOW = 262_144;

const VALID_BRIEF: ResearchBrief = {
  plan: '先城门对峙再入城收束，节奏前紧后松',
  entries: [
    {
      ref: 'char-lin',
      kind: 'asset',
      key_facts: [{ fact: '林昭左臂旧伤未愈', source: '人物卡 char-lin' }],
    },
  ],
  issues: [],
  execution_plan: [{ scene_ref: 's_gate', beat_coverage: '对峙节拍', notes: '短句提速' }],
  deviations: [],
};

const VALID_DRAFT = { title: '第二章 B 城', text: '黄昏的荒野上……', wordCount: 2800, chapterId: 'ch_2' };

const VALID_DECLARATION = {
  synopsis: '林昭与江白在城门分手后各自遇袭，双双负伤入城。',
  present: [{ name: '林昭' }],
  mentioned: [{ name: '江白' }],
};

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

/** 标准两阶段脚本：① Phase1 简报 → ② 核实器 verdict → ③ Phase2 正文 → ④ 2.5 申报。 */
function twoPhaseGenerate(): ReturnType<typeof vi.fn<GenerateFn>> {
  return vi
    .fn<GenerateFn>()
    .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
    .mockResolvedValueOnce(textRound(passVerdictJson()))
    .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
    .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
}

function writerRunInput(projectPath: string) {
  return {
    run: {
      runId: 'run_gate_wire',
      status: 'running',
      currentNodeId: null,
      projectPath,
      completedNodes: [],
      pendingNodes: [],
      artifacts: {
        chapter_brief: { goal: '抵达 B 城' },
        chapter_brief_input: { episodeId: 'ep-gate', brief: { goal: '抵达 B 城' } },
        scene_graph: { nodes: [] },
        settings_context: '设定前缀文本',
      },
      review: null,
      archive: null,
      delivery: null,
      feedback: null,
    } satisfies RunSnapshot,
    requirement: '',
  };
}

async function makeAssembledWriter(
  generate: ReturnType<typeof vi.fn<GenerateFn>>,
  projectPath: string,
): Promise<AgentNode> {
  const session: SessionState = {
    id: 'sess-gate-wire', agentName: 'chapter-chain', projectPath, status: 'idle',
    messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  const chain = createChapterChainNodes(generate, (slot) => {
    // 生产闭包形态：(slot) => resolveTaskModel(slot)——直接用注入的静态 resolver 等价。
    if (slot === 'writer-selfcheck') return { keyId: 'wire', modelId: 'glm-5.1' };
    if (slot === 'writer-draft') return { keyId: 'wire', modelId: 'kimi-k2.6' };
    return undefined;
  }, session);
  return chain.find((c) => c.id === 'draft-writer-agent')!.node;
}

describe('S4c 接线 — writer/核实循环 pre-gate 窗口/红线（makeAgentLoop config 实收）', () => {
  let dir = '';

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'orison-wire-gate-'));
    registry.__clearForTest();
    const { registerBuiltinTools } = await import('../src/tool/builtin');
    registerBuiltinTools();
    setExecuteToolFn(async (toolId) => ({ title: toolId, output: `(${toolId} unset)` }));
    setContextPolicyProvider(() => ({ redlinePercent: 80 }));
    makeAgentLoopSpy.mockClear();
  });

  afterEach(() => {
    rmBestEffort(dir);
    setTaskSlotResolver(undefined);
    setContextPolicyProvider(undefined);
    // CR-24（09-12 agy provider CR 批）：执行 seam 注入/还原配对——stub 不跨 describe 残留。
    setExecuteToolFn(undefined);
  });

  it('窗口随各自 loop 的 assignment（Phase1/核实=selfcheck 档、Phase2/2.5=draft 档）+ 红线注入', async () => {
    const generate = twoPhaseGenerate();
    const node = await makeAssembledWriter(generate, dir);

    const result = await node.run(writerRunInput(dir));
    expect(result.stateKey).toBe('draft.initial');
    expect(generate).toHaveBeenCalledTimes(4);

    // 构造序：Phase1 → 核实器 → Phase2 → 2.5（wiring 测试 modelRef 锚同序）。
    expect(makeAgentLoopSpy).toHaveBeenCalledTimes(4);
    const configs = makeAgentLoopSpy.mock.calls.map((c) => c[0] as {
      contextWindowTokens?: number;
      redlinePercent?: number;
    });
    expect(configs[0]?.contextWindowTokens).toBe(SELFCHECK_WINDOW); // Phase1 自查
    expect(configs[1]?.contextWindowTokens).toBe(SELFCHECK_WINDOW); // 资料员核实子循环
    expect(configs[2]?.contextWindowTokens).toBe(DRAFT_WINDOW); // Phase2 写作
    expect(configs[3]?.contextWindowTokens).toBe(DRAFT_WINDOW); // 2.5 申报
    for (const cfg of configs) {
      expect(cfg.redlinePercent).toBe(80);
    }
  });

  it('未配模型/未注入红线 → config 两字段均缺席（S4a 接收面回落 1M / 95% 缺省）', async () => {
    setContextPolicyProvider(undefined);
    const generate = twoPhaseGenerate();
    const session: SessionState = {
      id: 'sess-gate-unconf', agentName: 'chapter-chain', projectPath: dir, status: 'idle',
      messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
    const chain = createChapterChainNodes(generate, undefined, session);
    const node = chain.find((c) => c.id === 'draft-writer-agent')!.node;

    await node.run(writerRunInput(dir));
    expect(makeAgentLoopSpy).toHaveBeenCalledTimes(4);
    for (const c of makeAgentLoopSpy.mock.calls) {
      const cfg = c[0] as { contextWindowTokens?: number; redlinePercent?: number };
      expect(cfg.contextWindowTokens).toBeUndefined();
      expect(cfg.redlinePercent).toBeUndefined();
    }
  });

  it('未知模型（无 registry 条目）→ 窗口不注入（诚实回落 1M，不猜）', async () => {
    const generate = twoPhaseGenerate();
    const session: SessionState = {
      id: 'sess-gate-mystery', agentName: 'chapter-chain', projectPath: dir, status: 'idle',
      messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
    const chain = createChapterChainNodes(generate, () => ({ keyId: 'wire', modelId: 'mystery-model' }), session);
    const node = chain.find((c) => c.id === 'draft-writer-agent')!.node;

    await node.run(writerRunInput(dir));
    for (const c of makeAgentLoopSpy.mock.calls) {
      const cfg = c[0] as { contextWindowTokens?: number };
      expect(cfg.contextWindowTokens).toBeUndefined();
    }
  });
});
