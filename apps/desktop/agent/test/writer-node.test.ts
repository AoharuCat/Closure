import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { researchBriefSchema, castDeclarationSchema, type ResearchBrief, type VerificationVerdict } from '@orison/shared-contracts';
import {
  archiveDirName,
  computeBriefHash,
  createWriterNode,
  stableStringify,
  writeDraftCheckpointArchive,
  WRITER_MAX_ROUNDS,
  WRITER_READONLY_TOOL_IDS,
  type WriterArchiveIo,
  type WriterNodeDeps,
  type WriterVerificationOutcome,
} from '../src/nodes/writer-node';
import { classifyTool } from '../src/runtime/toolPolicy';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { NodeRunInput, RunSnapshot } from '../src/contracts/run';
import type { GenerateResult } from '../src/provider/ipc-provider';
import type { ToolDefinition } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.4 Step 2（A2/A9，design §1.1 形态 c）：draft-writer agent 化节点测试。
// generate / resolveTool / archiveIo / verifier 全注入 fake（mirror agent-loop.test.ts +
// chapter-nodes.test.ts 注入模式——不依赖全局 registry 状态）。覆盖：
// 两阶段编排 / 简报 parse 失败重发 / 熔断 error artifact / abort / 降级路径（全 miss / 部分 miss）/
// briefHash 复用·作废·首跑存档 / 段落级修订跳过自查 / 工具集无写工具红线（classifyTool）。
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_writer',
    status: 'running',
    currentNodeId: null,
    projectPath: '/test',
    completedNodes: [],
    pendingNodes: [],
    artifacts,
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  };
}

/** 合法调查简报 fixture（researchBriefSchema 全字段——出处锚定齐）。 */
const VALID_BRIEF: ResearchBrief = {
  plan: '先城门对峙再入城收束，节奏前紧后松',
  entries: [
    {
      ref: 'char-lin',
      kind: 'asset',
      key_facts: [{ fact: '林昭左臂旧伤未愈', source: '人物卡 char-lin' }],
    },
    {
      ref: 'ch_0003',
      kind: 'chapter',
      key_facts: [{ fact: '第 3 章两人已在城门分手', source: '第 3 章正文' }],
    },
  ],
  issues: [],
  execution_plan: [{ scene_ref: 's_gate', beat_coverage: '对峙节拍', notes: '短句提速' }],
  deviations: [],
};

const VALID_DRAFT = { title: '第二章 B 城', text: '黄昏的荒野上……', wordCount: 2800, chapterId: 'ch_2' };

/** 合法出场申报 fixture（castDeclarationSchema——synopsis 非空 + present/mentioned 名单，Story 8.7）。 */
const VALID_DECLARATION = {
  synopsis: '林昭与江白在城门分手后各自遇袭，双双负伤入城。',
  present: [{ name: '林昭' }, { name: '三师叔', card: '李玄' }],
  mentioned: [{ name: '江白' }],
};

/** 造 fake 只读工具（execute spy）。 */
function makeFakeTool(id: string): ToolDefinition {
  return {
    id,
    description: `fake tool ${id}`,
    parameters: z.object({ q: z.string().optional() }),
    execute: vi.fn(async () => ({ title: id, output: `${id} 查询结果` })),
  };
}

/** 全套只读工具 fake（id 精确对齐 WRITER_READONLY_TOOL_IDS）。 */
function makeAllTools(): Map<string, ToolDefinition> {
  return new Map(WRITER_READONLY_TOOL_IDS.map((id) => [id, makeFakeTool(id)]));
}

/** 内存章档案 fake（记录 write 调用）。 */
function makeMemoryArchive(): WriterArchiveIo & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async read(_p, episodeId) {
      return (store.get(episodeId) as Awaited<ReturnType<WriterArchiveIo['read']>>) ?? null;
    },
    async write(_p, entry) {
      store.set(entry.episodeId, entry);
    },
  };
}

function textRound(content: string): GenerateResult {
  return { content, finishReason: 'stop' };
}

function toolCallRound(name: string): GenerateResult {
  return {
    content: '',
    toolCalls: [{ id: `call-${name}`, name, arguments: '{"q":"x"}' }],
    finishReason: 'tool_calls',
  };
}

/** 标准两阶段生成脚本：① 查询轮 → ② 简报+marker → ③ 正文+marker → ④ 申报+marker（8.7 阶段 2.5）。 */
function twoPhaseGenerate(): ReturnType<typeof vi.fn<GenerateFn>> {
  return vi
    .fn<GenerateFn>()
    .mockResolvedValueOnce(toolCallRound('query_story'))
    .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
    .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
    .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
}

/** 写手节点标准 run 输入（含 chapter_brief + chapter_brief_input episodeId）。返回 input 以便断言 mutate。 */
function writerInput(artifacts: Record<string, unknown> = {}): NodeRunInput {
  return {
    run: makeRun({
      chapter_brief: { goal: '抵达 B 城' },
      chapter_brief_input: { episodeId: 'ep-12', brief: { goal: '抵达 B 城' } },
      scene_graph: { nodes: [] },
      settings_context: '设定前缀文本',
      ...artifacts,
    }),
    requirement: '',
  };
}

type MockGenerate = ReturnType<typeof vi.fn<GenerateFn>>;

/** 标准节点 deps（全工具 + 内存档案 + 固定时间）；generate 可覆写（mock 调用断言用）。 */
function writerDeps(
  overrides: Partial<Omit<WriterNodeDeps, 'generate'>> & { generate?: MockGenerate } = {},
): WriterNodeDeps & { generate: MockGenerate } {
  const generate = overrides.generate ?? twoPhaseGenerate();
  return {
    resolveTool: (id: string) => makeAllTools().get(id),
    archiveIo: makeMemoryArchive(),
    nowISO: () => '2026-08-18T00:00:00Z',
    ...overrides,
    generate,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 工具集红线（design §1.3：只读十三件，无写工具）
// ════════════════════════════════════════════════════════════════════════════

describe('WRITER_READONLY_TOOL_IDS — 写工具禁区红线', () => {
  it('十三件全部 classifyTool=read（无 write/diff/dangerous 混入）', () => {
    for (const id of WRITER_READONLY_TOOL_IDS) {
      expect(classifyTool(id), `${id} 应为 read`).toBe('read');
    }
  });

  it('id 集与 design §1.3 清单精确一致（含 query_cognition_graph + Story 8.7 S8 三件；防静默漂移）', () => {
    expect([...WRITER_READONLY_TOOL_IDS]).toEqual([
      'query_story',
      'query_relations',
      'chapter_read',
      'chapter_list',
      'query_chapter_summary',
      'query_arc_summary',
      'scene_graph_read',
      'outline_read',
      'query_promise',
      'query_cognition_graph',
      // Story 8.7 S8：实体目录/档案/出场史三件（十件→十三件，dispatch 拍板「找完整是自查本职」）。
      'catalog_entries',
      'get_entry',
      'query_mentions',
    ]);
  });

  it('十三件均在 builtin.ts 注册（id 集与生产注册面一致——防「描述有工具注册缺失」漂移）', async () => {
    const { registerBuiltinTools } = await import('../src/tool/builtin');
    registerBuiltinTools();
    const { registry } = await import('../src/tool/registry');
    for (const id of WRITER_READONLY_TOOL_IDS) {
      expect(registry.get(id), `${id} 应已注册`).toBeDefined();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 两阶段编排（design §1.1 形态 c）
// ════════════════════════════════════════════════════════════════════════════

describe('createWriterNode — 两阶段编排', () => {
  it('阶段一自查（工具轮+简报收束）→ seam no-op → 阶段二产 draft.initial（契约零变）', async () => {
    const tools = makeAllTools();
    const deps = writerDeps({ resolveTool: (id) => tools.get(id) });
    const node = createWriterNode(deps);
    const input = writerInput();

    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toEqual(VALID_DRAFT);

    // generate 四轮：查询轮 / 简报收束 / 正文收束 / 申报收束（8.7 阶段 2.5）。
    expect(deps.generate).toHaveBeenCalledTimes(4);

    // 阶段一工具真执行（经 resolveTool seam，只读）。
    expect(tools.get('query_story')!.execute).toHaveBeenCalledTimes(1);

    // generate 收到只读工具集（LLM 可见面）。
    const toolIds = deps.generate.mock.calls[0][2].map((t) => t.id).sort();
    expect(toolIds).toEqual([...WRITER_READONLY_TOOL_IDS].sort());

    // research_brief artifact：简报落节点产物槽（mutate 写，NodeResult 单 stateKey 先例）。
    const researchBrief = input.run.artifacts['research_brief'] as { brief: ResearchBrief; briefHash: string };
    expect(researchBriefSchema.parse(researchBrief.brief)).toEqual(VALID_BRIEF);
    expect(researchBrief.briefHash).toBe(computeBriefHash({ goal: '抵达 B 城' }));
    // cast_declaration artifact（8.7 阶段 2.5）：{declaration（schema parse 通过形态）, source: 'declared'}。
    expect(input.run.artifacts['cast_declaration']).toEqual({
      declaration: castDeclarationSchema.parse(VALID_DECLARATION),
      source: 'declared',
    });
  });

  it('稳定前缀：两阶段 generate 收到的首条消息同为任务卡（逐字节同一份）+ 阶段二携简报回执', async () => {
    const deps = writerDeps();
    const node = createWriterNode(deps);
    await node.run(writerInput());

    // ⚠️ makeAgentLoop 把 messages 数组按引用传 generate，调用返回后仍会 push（assistant/tool）——
    // mock.calls[i][0] 是活引用，断言用成员查找（some）非末位取值。
    const phase1Msgs = deps.generate.mock.calls[0][0];
    const phase2Msgs = deps.generate.mock.calls[2][0];
    // 阶段一首条 = 稳定前缀（任务卡渲染——含 chapterTask JSON + 设定前缀 + storyPlan）。
    expect(phase1Msgs[0].role).toBe('user');
    expect(phase1Msgs[0].content).toContain('抵达 B 城');
    expect(phase1Msgs[0].content).toContain('设定前缀文本');
    // 阶段二首条与阶段一首条逐字节同一份（design §1.2 缓存友好约定——节点单源构造同一 stablePrefix）。
    expect(phase2Msgs[0]).toEqual(phase1Msgs[0]);
    // 阶段二消息序：前缀 → 阶段一消息（指令+查询轮+简报） → 阶段二指令（携简报回执）。
    expect(phase2Msgs[1].content).toContain('第一步·动笔前自查'); // 阶段一 user 指令（priorMessages 回填）
    const phase2Prompt = phase2Msgs.find((m) => m.role === 'user' && m.content.includes('第二步·动笔'));
    expect(phase2Prompt).toBeDefined();
    // 简报回执内容级断言（zod parse 后 key 序与 fixture 声明序不同，不做整串 JSON.stringify 比对）。
    expect(phase2Prompt!.content).toContain('林昭左臂旧伤未愈');
    expect(phase2Prompt!.content).toContain('第 3 章两人已在城门分手');
    expect(phase2Prompt!.content).toContain('<DRAFT_READY>');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 阶段 2.5 出场申报（Story 8.7 design §2.1）：正文后同对话续问 + 独立收束标记 + 增强层 graceful
// ════════════════════════════════════════════════════════════════════════════

describe('createWriterNode — 阶段 2.5 出场申报（Story 8.7）', () => {
  it('申报成功：正文后同对话续问 → CAST 标记收束 → cast_declaration artifact + 正文不变', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const deps = writerDeps({ generate });
    const node = createWriterNode(deps);
    const input = writerInput();
    const result = await node.run(input);

    // 正文交付不受申报影响（draft.initial 契约零变）。
    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toEqual(VALID_DRAFT);
    // 循环终止语义：申报轮在 CAST 标记处收束（标记命中即止，无多余轮）。
    expect(generate).toHaveBeenCalledTimes(3);
    // 申报轮 = 同对话续问：消息序 = 稳定前缀（逐字节同一份）→ 阶段一/二消息（含 DRAFT_READY 回合）→ 申报指令。
    const declMsgs = generate.mock.calls[2][0];
    expect(declMsgs[0]).toEqual(generate.mock.calls[0][0][0]);
    expect(declMsgs.some((m) => m.role === 'assistant' && m.content.includes('<DRAFT_READY>'))).toBe(true);
    const declPrompt = declMsgs.find((m) => m.role === 'user' && m.content.includes('第三步·顺手报本章人物表'));
    expect(declPrompt).toBeDefined();
    // 指令格式说明（mirror 阶段一简报指令风格：字段逐条说人话 + 例子就地解释）。
    expect(declPrompt!.content).toContain('synopsis');
    expect(declPrompt!.content).toContain('present');
    expect(declPrompt!.content).toContain('mentioned');
    expect(declPrompt!.content).toContain('三师叔');
    expect(declPrompt!.content).toContain('<CAST_DECLARATION_READY>');
    // 阶段二指令尾部带申报预告（预期管理——写手知道交完正文还会被问人物表）。
    const phase2PromptMsg = generate.mock.calls[1][0].find(
      (m) => m.role === 'user' && m.content.includes('第二步·动笔'),
    );
    expect(phase2PromptMsg).toBeDefined();
    expect(phase2PromptMsg!.content).toContain('人物表');
    // 申报轮 generate 携带同一只读工具集（同 makeAgentLoop 续问）。
    expect(generate.mock.calls[2][2].map((t) => t.id).sort()).toEqual([...WRITER_READONLY_TOOL_IDS].sort());
    // artifact：{declaration（schema parse 通过形态）, source: 'declared'}。
    expect(input.run.artifacts['cast_declaration']).toEqual({
      declaration: castDeclarationSchema.parse(VALID_DECLARATION),
      source: 'declared',
    });
  });

  it('parse 两试失败 → graceful：cast_declaration 标 degraded（无 declaration 字段）+ 正文照常交付', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound('这不是申报')) // 初试 parse 失败
      .mockResolvedValueOnce(textRound('还是不是申报')); // 重发仍失败 → 两试尽
    const node = createWriterNode(writerDeps({ generate }));
    const input = writerInput();
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial'); // 正文交付不受任何影响
    expect(result.artifact).toEqual(VALID_DRAFT);
    expect(generate).toHaveBeenCalledTimes(4); // 简报 + 正文 + 申报两试
    // 重发指令带回执（mirror 简报/正文 parse 重试）。
    const retryMsgs = generate.mock.calls[3][0];
    expect(retryMsgs.some((m) => m.role === 'user' && m.content.includes('无法解析'))).toBe(true);
    // degraded 标注可观测（RunSnapshot 里能看到「本章无申报」的原因；S8 据 declaration 字段缺失落保守账）。
    expect(input.run.artifacts['cast_declaration']).toEqual({
      degraded: true,
      reason: 'cast_declaration_parse_failed',
    });
  });

  it('申报轮 LLM 异常（网络等）→ graceful 缺失不崩链不吞稿（正文已在手）', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockImplementationOnce(async () => {
        throw new Error('network down');
      });
    const node = createWriterNode(writerDeps({ generate }));
    const input = writerInput();
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toEqual(VALID_DRAFT);
    expect(input.run.artifacts['cast_declaration']).toEqual({
      degraded: true,
      reason: 'cast_declaration_llm_failed',
    });
  });

  it('申报轮 abort → 照常传播（不吞成 graceful 缺失）', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockImplementationOnce(async () => {
        throw new DOMException('Aborted', 'AbortError');
      });
    const node = createWriterNode(writerDeps({ generate }));
    await expect(node.run(writerInput())).rejects.toThrow(/Aborted/);
  });

  it('申报轮熔断（maxRounds 保险丝照旧覆盖新增轮）→ graceful 缺失 + 正文照常', async () => {
    // 复用档案跳过自查（阶段二 1 轮）+ 申报轮无限工具调用打转（不出标记）→ 申报预算耗尽熔断 → graceful。
    const archive = makeMemoryArchive();
    archive.store.set('ep-12', {
      episodeId: 'ep-12',
      briefHash: computeBriefHash({ goal: '抵达 B 城' }),
      brief: VALID_BRIEF,
      verified: true,
      savedAt: '2026-08-17T00:00:00Z',
    });
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockImplementation(async () => toolCallRound('query_story'));
    const node = createWriterNode(writerDeps({ generate, archiveIo: archive, maxRounds: 2 }));
    const input = writerInput();
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial'); // 熔断不吞稿（申报是增强层）
    expect(result.artifact).toEqual(VALID_DRAFT);
    expect(input.run.artifacts['cast_declaration']).toEqual({
      degraded: true,
      reason: 'cast_declaration_fuse',
    });
    // 阶段二 1 轮 + 申报轮恰跑满自身预算 2 轮后熔断。
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('降级直写路径（工具环境不可用）→ 无 cast_declaration artifact（undefined = 保守账，S8 处理）', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue(textRound(JSON.stringify(VALID_DRAFT)));
    const node = createWriterNode(writerDeps({ generate, resolveTool: () => undefined })); // registry 空
    const input = writerInput();
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(generate).toHaveBeenCalledTimes(1); // 单发直写零回归（8.4 既有语义一字不变）
    expect(input.run.artifacts['cast_declaration']).toBeUndefined(); // 无申报 = 保守账
  });

  it('BMad CR-003：降级直写入口清 stale cast_declaration（旧申报不进下游汇账——与另两入口同构）', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue(textRound(JSON.stringify(VALID_DRAFT)));
    const node = createWriterNode(writerDeps({ generate, resolveTool: () => undefined }));
    // resume/redo 场景：snapshot 带上一轮申报（旧正文的新鲜申报）——降级直写不产新申报，
    // 旧申报若残留会被下游 mention-ledger 当本章新鲜申报消费（stale synopsis 回填 + full 档账）。
    const input = writerInput({
      cast_declaration: { declaration: VALID_DECLARATION, source: 'declared' },
    });
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(generate).toHaveBeenCalledTimes(1); // 降级直写零回归
    expect(input.run.artifacts['cast_declaration']).toBeUndefined(); // stale 申报已清
  });

  it('段落级修订路径（legacy 直写）→ 同无 cast_declaration artifact（修订章保守账，design §2.3）', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue(
      textRound(JSON.stringify({ title: '第二章', text: '', passageText: '改后段落' })),
    );
    const node = createWriterNode(writerDeps({ generate }));
    const input = writerInput({
      revision_intent: {
        change: { summary: '改紧张点' },
        lockedItems: [],
        rationale: { source: 'user-directive', note: '用户选段指挥' },
        provenance: { rawUserInstruction: '改这段', compilerNote: '说明' },
        scope: { anchor: { quote: '原句', prefix: '前', suffix: '后', rangeHint: { from: 0, to: 2 } } },
      },
      'draft.initial': { title: '第二章', text: '前文。原句。后文。' },
    });
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(generate).toHaveBeenCalledTimes(1); // 单发直写（修订轮不复走自查/申报）
    expect(input.run.artifacts['cast_declaration']).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 简报 parse 失败重发（不崩链）
// ════════════════════════════════════════════════════════════════════════════

describe('createWriterNode — 简报 parse 失败重发', () => {
  it('首输出非简报 JSON → 回错误消息重发 → 重发合法简报 → 进阶段二', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound('这不是简报格式')) // 首试 parse 失败（无 JSON）
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const deps = writerDeps({ generate });
    const node = createWriterNode(deps);

    const result = await node.run(writerInput());

    expect(result.stateKey).toBe('draft.initial');
    expect(generate).toHaveBeenCalledTimes(4); // 简报两试 + 正文 + 申报
    // 重发指令带回执（mirror createLlmNode CR-5 error-feedback）。⚠️ mock.calls[i][0] 是活引用
    // （调用后仍被 push），断言用成员查找。
    const retryMsgs = generate.mock.calls[1][0];
    expect(retryMsgs.some((m) => m.role === 'user' && m.content.includes('无法解析'))).toBe(true);
  });

  it('出处缺失的简报被 schema 拒（key_facts.source 强制）→ 重发补出处后通过', async () => {
    const badBrief = {
      ...VALID_BRIEF,
      entries: [{ ref: 'x', kind: 'asset', key_facts: [{ fact: '无出处事实', source: '' }] }],
    };
    expect(researchBriefSchema.safeParse(badBrief).success).toBe(false); // schema 红线前提
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(JSON.stringify(badBrief))) // schema 拒（source 空串）
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const node = createWriterNode(writerDeps({ generate }));
    const result = await node.run(writerInput());
    expect(result.stateKey).toBe('draft.initial'); // 重发后过
  });

  it('两试均败 → 自查降级单发直写（research_brief 标 degraded，零回归）', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound('废输出一'))
      .mockResolvedValueOnce(textRound('废输出二'))
      .mockResolvedValueOnce(textRound(JSON.stringify(VALID_DRAFT))); // 降级路径单发
    const node = createWriterNode(writerDeps({ generate }));
    const input = writerInput();
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toEqual(VALID_DRAFT);
    expect(generate).toHaveBeenCalledTimes(3); // 2 次简报尝试 + 1 次降级直写
    expect(input.run.artifacts['research_brief']).toEqual({
      degraded: true,
      reason: 'research_brief_parse_failed',
    });
  });

  it('连续工具错误轮 → 自查降级（reason research_consecutive_errors）', async () => {
    const tools = new Map(
      WRITER_READONLY_TOOL_IDS.map((id) => [
        id,
        {
          id,
          description: id,
          parameters: z.object({ q: z.string().optional() }),
          execute: vi.fn(async () => {
            throw new Error('ipc down');
          }),
        } as ToolDefinition,
      ]),
    );
    const errRound = () => toolCallRound('query_story');
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(errRound())
      .mockResolvedValueOnce(errRound())
      .mockResolvedValueOnce(errRound()) // 连续 3 轮全错 → consecutive_errors
      .mockResolvedValueOnce(textRound(JSON.stringify(VALID_DRAFT))); // 降级直写
    const node = createWriterNode(writerDeps({ generate, resolveTool: (id) => tools.get(id) }));
    const input = writerInput();
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(input.run.artifacts['research_brief']).toEqual({
      degraded: true,
      reason: 'research_consecutive_errors',
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 熔断（A9）+ abort
// ════════════════════════════════════════════════════════════════════════════

describe('createWriterNode — 熔断与 abort', () => {
  it('查询轮超限 → error artifact（reason 含 tool_loop_fuse，不静默）', async () => {
    const generate = vi.fn<GenerateFn>().mockImplementation(async () => toolCallRound('query_story'));
    const node = createWriterNode(writerDeps({ generate, maxRounds: 4 })); // 收窄验熔断
    const result = await node.run(writerInput());

    expect((result.artifact as { error: boolean }).error).toBe(true);
    expect((result.artifact as { message: string }).message).toContain('tool_loop_fuse');
    expect(generate).toHaveBeenCalledTimes(4); // 恰跑满预算轮
  });

  it('WRITER_MAX_ROUNDS 缺省 = 50（A9 用户拍板值）', () => {
    expect(WRITER_MAX_ROUNDS).toBe(50);
  });

  it('abort 传播（不吞成 error artifact）', async () => {
    const generate = vi.fn<GenerateFn>().mockImplementation(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });
    const node = createWriterNode(writerDeps({ generate }));
    await expect(node.run(writerInput())).rejects.toThrow(/Aborted/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 降级路径（design §5）
// ════════════════════════════════════════════════════════════════════════════

describe('createWriterNode — 工具环境降级', () => {
  it('resolveTool 全 miss → 单发直写（generate 一次）+ research_brief 标 research_tools_unavailable', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue(textRound(JSON.stringify(VALID_DRAFT)));
    const node = createWriterNode(writerDeps({ generate, resolveTool: () => undefined })); // registry 空
    const input = writerInput();
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toEqual(VALID_DRAFT);
    expect(generate).toHaveBeenCalledTimes(1); // 单发直写零回归
    expect(generate.mock.calls[0][2]).toEqual([]); // 无工具
    expect(input.run.artifacts['research_brief']).toEqual({
      degraded: true,
      reason: 'research_tools_unavailable',
    });
  });

  it('部分 miss → 响亮 error artifact（不静默缺工具开跑）', async () => {
    const tools = makeAllTools();
    tools.delete('query_promise'); // 模拟接线缺失
    const generate = vi.fn<GenerateFn>().mockResolvedValue(textRound(JSON.stringify(VALID_DRAFT)));
    const node = createWriterNode(writerDeps({ generate, resolveTool: (id) => tools.get(id) }));
    const result = await node.run(writerInput());

    expect((result.artifact as { error: boolean }).error).toBe(true);
    expect((result.artifact as { message: string }).message).toContain('query_promise');
    expect(generate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// briefHash 失效/复用判定（design §1.6 D2）
// ════════════════════════════════════════════════════════════════════════════

describe('createWriterNode — briefHash 失效/复用', () => {
  it('无存档首跑 → 跑阶段一 → 简报+briefHash 落章档案', async () => {
    const archive = makeMemoryArchive();
    const deps = writerDeps({ archiveIo: archive });
    await createWriterNode(deps).run(writerInput());

    const stored = archive.store.get('ep-12') as {
      episodeId: string;
      briefHash: string;
      brief: ResearchBrief;
      savedAt: string;
    };
    expect(stored).toBeDefined();
    expect(stored.episodeId).toBe('ep-12');
    expect(stored.briefHash).toBe(computeBriefHash({ goal: '抵达 B 城' }));
    expect(stored.brief).toEqual(VALID_BRIEF);
    expect(stored.savedAt).toBe('2026-08-18T00:00:00Z');
  });

  it('episodeId 同 + briefHash 同 + verified=true → 复用存档简报与许可（跳过阶段一与核实，零重查）', async () => {
    const archive = makeMemoryArchive();
    archive.store.set('ep-12', {
      episodeId: 'ep-12',
      briefHash: computeBriefHash({ goal: '抵达 B 城' }),
      brief: VALID_BRIEF,
      verified: true,
      savedAt: '2026-08-17T00:00:00Z',
    });
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({ kind: 'pass' }));
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const node = createWriterNode(writerDeps({ generate, archiveIo: archive, verifier }));
    const input = writerInput();
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(generate).toHaveBeenCalledTimes(2); // 阶段一零 generate（复用跳过）+ 阶段 2.5 申报一轮
    expect(verifier).not.toHaveBeenCalled(); // 许可随简报复用（D2 零重查——核实不重跑）
    // 阶段二消息含复用回执（priorMessages 用存档简报渲染回填）。内容级断言（zod key 序不比对整串）。
    const msgs = generate.mock.calls[0][0];
    expect(msgs[1].content).toContain('上轮调查简报（复用）');
    expect(msgs[1].content).toContain('林昭左臂旧伤未愈');
    // research_brief artifact 标 reused + verified。
    expect(input.run.artifacts['research_brief']).toMatchObject({ reused: true, verified: true, brief: VALID_BRIEF });
  });

  // ── CR-005（2026-08-19）：复用轮不回填 verdict → archiveIssues 静默蒸发 ──

  it('CR-005：档案含 verdict（archive_issues 非空）→ 复用轮回填 verdict → summary.archiveIssues 照常抽取', async () => {
    const archivedVerdict: VerificationVerdict = {
      checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
      pass: true,
      gaps: [],
      suggestions: [],
      archive_issues: [{ card_ref: 'card-empire', problem: '设定卡写的国号与第 5 章正文冲突' }],
    };
    const archive = makeMemoryArchive();
    archive.store.set('ep-12', {
      episodeId: 'ep-12',
      briefHash: computeBriefHash({ goal: '抵达 B 城' }),
      brief: VALID_BRIEF,
      verified: true,
      verdict: archivedVerdict,
      savedAt: '2026-08-17T00:00:00Z',
    });
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const node = createWriterNode(writerDeps({ generate, archiveIo: archive }));
    const input = writerInput();
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    // verdict 投影进 research_brief artifact（summarize 的抽取源）。
    expect(input.run.artifacts['research_brief']).toMatchObject({
      reused: true,
      verified: true,
      verdict: archivedVerdict,
    });
    // summary.archiveIssues 照常抽取（复用轮与首查轮呈现一致——机械记账不靠自觉）。
    const { summarizeRunSnapshot } = await import('../src/runtime/chainRunner');
    const summary = summarizeRunSnapshot(input.run);
    expect(summary.archiveIssues).toEqual(archivedVerdict.archive_issues);
  });

  it('verified 缺（旧档案/未获许可）→ 不复用，作废重查（挂起的章不得带旧账直写）', async () => {
    const archive = makeMemoryArchive();
    archive.store.set('ep-12', {
      episodeId: 'ep-12',
      briefHash: computeBriefHash({ goal: '抵达 B 城' }),
      brief: VALID_BRIEF,
      verified: false, // 简报存了但核实未过（补查中 / 挂起后 redo）
      savedAt: '2026-08-17T00:00:00Z',
    });
    const deps = writerDeps({ archiveIo: archive });
    const input = writerInput();
    const result = await createWriterNode(deps).run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(deps.generate).toHaveBeenCalledTimes(4); // 阶段一真跑（未获许可不复用）+ 申报
  });

  it('briefHash 变（leader 改任务卡）→ 作废重查（阶段一重跑 + 档案覆盖新 hash）', async () => {
    const archive = makeMemoryArchive();
    archive.store.set('ep-12', {
      episodeId: 'ep-12',
      briefHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      brief: VALID_BRIEF,
      verified: true,
      savedAt: '2026-08-17T00:00:00Z',
    });
    const deps = writerDeps({ archiveIo: archive });
    await createWriterNode(deps).run(writerInput());

    expect(deps.generate).toHaveBeenCalledTimes(4); // 阶段一真跑（查询轮+简报）+ 申报
    const stored = archive.store.get('ep-12') as { briefHash: string; verified: boolean };
    expect(stored.briefHash).toBe(computeBriefHash({ goal: '抵达 B 城' })); // 新 hash 覆盖
    expect(stored.verified).toBe(true); // 核实 pass 后最终许可覆写
  });

  it('无 episodeId（chapter_brief_input 缺）→ 不读不写档案，自查照常跑', async () => {
    const archive = makeMemoryArchive();
    const deps = writerDeps({ archiveIo: archive });
    const input = writerInput({ chapter_brief_input: undefined });
    const result = await createWriterNode(deps).run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(deps.generate).toHaveBeenCalledTimes(4);
    expect(archive.store.size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 段落级修订边界 + verifier seam
// ════════════════════════════════════════════════════════════════════════════

describe('createWriterNode — 修订轮边界 + verifier seam', () => {
  it('段落级 revision_intent（scope.anchor）→ 跳过自查走单发直写（design §1.1 边界）', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue(
      textRound(JSON.stringify({ title: '第二章', text: '', passageText: '改后段落' })),
    );
    const node = createWriterNode(writerDeps({ generate }));
    const input = writerInput({
      revision_intent: {
        change: { summary: '改紧张点' },
        lockedItems: [],
        rationale: { source: 'user-directive', note: '用户选段指挥' },
        provenance: { rawUserInstruction: '改这段', compilerNote: '说明' },
        scope: { anchor: { quote: '原句', prefix: '前', suffix: '后', rangeHint: { from: 0, to: 2 } } },
      },
      'draft.initial': { title: '第二章', text: '前文。原句。后文。' },
    });
    const result = await node.run(input);

    expect(generate).toHaveBeenCalledTimes(1); // 单发直写（无自查轮）
    expect(result.stateKey).toBe('draft.initial');
    const artifact = result.artifact as { text: string; passageText: string };
    expect(artifact.text).toBe('前文。原句。后文。'); // 保改前整章（7.2 逻辑单源复用）
    expect(artifact.passageText).toBe('改后段落');
    expect(input.run.artifacts['research_brief']).toBeUndefined(); // 不标 degraded（修订轮非降级）
  });

  // ── CR-002（2026-08-19）：段落级 redo 不清 stale suspended → pause 成环死路 ──

  it('CR-002：legacy 直写清 stale suspended（悬挂态与段落级修复互斥——presence 判定不得再 pause）', async () => {
    const generate = vi.fn<GenerateFn>().mockResolvedValue(
      textRound(JSON.stringify({ title: '第二章', text: '', passageText: '改后段落' })),
    );
    const node = createWriterNode(writerDeps({ generate }));
    const staleSuspension = { kind: 'research_contradiction', rounds: 1, evidence: { contradictions: [], deviations: [] } };
    const input = writerInput({
      revision_intent: {
        change: { summary: '改紧张点' },
        lockedItems: [],
        rationale: { source: 'user-directive', note: '用户选段指挥' },
        provenance: { rawUserInstruction: '改这段', compilerNote: '说明' },
        scope: { anchor: { quote: '原句', prefix: '前', suffix: '后', rangeHint: { from: 0, to: 2 } } },
      },
      'draft.initial': { title: '第二章', text: '前文。原句。后文。' },
      // resume 场景：snapshot 残留上一轮挂起载荷（decideCheckpointPause presence 判定的触发源）。
      research_brief: { brief: VALID_BRIEF, briefHash: 'sha256:stale', suspended: staleSuspension },
    });
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    // suspended 字段已清（其余 brief/hash 记录保留——archiveIssues 等消费不受影响）。
    const research = input.run.artifacts['research_brief'] as { suspended?: unknown; brief?: unknown };
    expect(research.suspended).toBeUndefined();
    expect(research.brief).toEqual(VALID_BRIEF);
  });

  it('CR-002 belt：两阶段重跑入口同清 stale suspended（重跑产新 research_brief 前不携带旧悬挂）', async () => {
    const deps = writerDeps(); // 两阶段路径（no-op 核实）
    const input = writerInput({
      research_brief: {
        brief: VALID_BRIEF,
        briefHash: 'sha256:stale',
        suspended: { kind: 'verify_exhausted', rounds: 3, gaps: [] },
      },
    });
    const result = await createWriterNode(deps).run(input);

    expect(result.stateKey).toBe('draft.initial');
    const research = input.run.artifacts['research_brief'] as { suspended?: unknown; verified?: boolean };
    expect(research.suspended).toBeUndefined(); // 入口已清 + 全新赋值不 spread stale
    expect(research.verified).toBe(true); // 本轮核实 pass（no-op）照常
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 出发核实回路（Story 8.4 Step 3，design §1.5/§1.6）：escalate/gaps 挂起与补查回合
// ════════════════════════════════════════════════════════════════════════════

describe('createWriterNode — 出发核实回路（Step 3）', () => {
  function gapsVerdict(): VerificationVerdict {
    return {
      checklist: { entities_checked: false, sources_grounded: true, gaps_cleared: false, contradictions_zero: true },
      pass: false,
      gaps: [{ desc: '未核查配角王五的行踪', source_hint: 'query_story 搜「王五」' }],
      suggestions: [],
      archive_issues: [],
    };
  }
  function passVerdict(): VerificationVerdict {
    return {
      checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
      pass: true,
      gaps: [],
      suggestions: [],
      archive_issues: [],
    };
  }

  it('escalate → 挂起：pause 型节点结果（stateKey=research_brief，非 error）+ 简报证据入 research_brief + 挂起落章档案，不开写', async () => {
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({
      kind: 'escalate',
      verdict: {
        checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: false },
        pass: false,
        gaps: [],
        suggestions: [],
        archive_issues: [],
        escalate: true,
      },
    }));
    const archive = makeMemoryArchive();
    const deps = writerDeps({ verifier, archiveIo: archive });
    const node = createWriterNode(deps);
    const input = writerInput();
    const result = await node.run(input);

    expect(verifier).toHaveBeenCalledTimes(1);
    // Step 4 形态：pause 型节点结果——非 error artifact（挂起 ≠ 错误，errors 不计）；stateKey=research_brief
    // 携 suspended 载荷（chainRunner fire draft checkpoint → decideCheckpointPause 全档位 pause）。
    expect(result.stateKey).toBe('research_brief');
    expect((result.artifact as { error?: boolean }).error).toBeUndefined();
    const suspension = (result.artifact as { suspended: { kind: string } }).suspended;
    expect(suspension.kind).toBe('research_contradiction');
    // 阶段二未开写：generate 只到简报收束（查询轮 + 简报 = 2）。
    expect(deps.generate).toHaveBeenCalledTimes(2);
    const rb = input.run.artifacts['research_brief'] as {
      suspended: { kind: string };
      verdict: { escalate: boolean };
    };
    expect(rb.suspended.kind).toBe('research_contradiction');
    expect(rb.verdict.escalate).toBe(true);
    // 挂起原因落章档案（suspension 载荷 + suspendedAt；verified 仍 false）。
    const stored = archive.store.get('ep-12') as {
      verified: boolean;
      suspension: { kind: string; rounds: number; suspendedAt: string };
    };
    expect(stored.verified).toBe(false);
    expect(stored.suspension.kind).toBe('research_contradiction');
    expect(stored.suspension.rounds).toBe(1);
    expect(stored.suspension.suspendedAt).toBe('2026-08-18T00:00:00Z');
  });

  it('机械 belt：简报含 contradiction issue 但核实器 pass → 仍挂起（偏离/矛盾不因宽松核实放行）', async () => {
    const contradictory: ResearchBrief = {
      ...VALID_BRIEF,
      issues: [{ desc: '任务卡说林昭右臂伤，第 3 章正文是左臂', severity: 'contradiction' }],
    };
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(contradictory)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(JSON.stringify(VALID_DRAFT))); // 不应到达（belt 拦下）
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({ kind: 'pass' })); // no-op 形态
    const node = createWriterNode(writerDeps({ generate, verifier }));
    const input = writerInput();
    const result = await node.run(input);

    // Step 4 形态：pause 型（非 error）。
    expect(result.stateKey).toBe('research_brief');
    expect((result.artifact as { error?: boolean }).error).toBeUndefined();
    expect((result.artifact as { suspended: { kind: string } }).suspended.kind).toBe('research_contradiction');
    const rb = input.run.artifacts['research_brief'] as { suspended: { evidence: { contradictions: unknown[] } } };
    expect(rb.suspended.evidence.contradictions).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1); // 阶段二未开写
  });

  it('gaps → 补查回合：缺漏附进阶段一续指令 → 新简报 → 再核实 pass → 开写（两轮过）', async () => {
    const verifier = vi
      .fn<() => Promise<WriterVerificationOutcome>>()
      .mockResolvedValueOnce({ kind: 'gaps', verdict: gapsVerdict() })
      .mockResolvedValueOnce({ kind: 'pass', verdict: passVerdict() });
    const brief2: ResearchBrief = {
      ...VALID_BRIEF,
      entries: [
        ...VALID_BRIEF.entries,
        { ref: 'char-wang', kind: 'asset', key_facts: [{ fact: '王五在第 5 章已南下', source: '人物卡 char-wang' }] },
      ],
    };
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(brief2)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const archive = makeMemoryArchive();
    const node = createWriterNode(writerDeps({ generate, verifier, archiveIo: archive }));
    const input = writerInput();
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toEqual(VALID_DRAFT);
    expect(verifier).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(4); // 简报1 / 补查简报2 / 正文 / 申报
    // gaps 正确附进续指令（缺什么+线索，一手原则零直塞内容）。
    const followUpMsgs = generate.mock.calls[1][0];
    const followUpPrompt = followUpMsgs.find((m) => m.role === 'user' && m.content.includes('补查'));
    expect(followUpPrompt).toBeDefined();
    expect(followUpPrompt!.content).toContain('王五的行踪');
    expect(followUpPrompt!.content).toContain('query_story 搜「王五」');
    expect(followUpPrompt!.content).toContain('<RESEARCH_BRIEF_READY>');
    // 补查产新简报沿用阶段一工具（generate 携带同一只读工具集）。
    expect(generate.mock.calls[1][2].map((t) => t.id).sort()).toEqual([...WRITER_READONLY_TOOL_IDS].sort());
    // 存档 last-wins：最终态 = 新简报 + verified=true；research_brief 记 verifyRounds=2 + verdict。
    const stored = archive.store.get('ep-12') as { brief: ResearchBrief; verified: boolean };
    expect(stored.brief).toEqual(brief2);
    expect(stored.verified).toBe(true);
    expect(input.run.artifacts['research_brief']).toMatchObject({
      brief: brief2,
      verifyRounds: 2,
      verified: true,
      verdict: passVerdict(),
    });
  });

  it('三轮尽挂起：gaps×3 → verify_exhausted pause 型结果（gaps 入载荷 + 落章档案），verifier 恰调 3 次', async () => {
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({
      kind: 'gaps',
      verdict: gapsVerdict(),
    }));
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(JSON.stringify(VALID_DRAFT))); // 不应到达
    const archive = makeMemoryArchive();
    const node = createWriterNode(writerDeps({ generate, verifier, archiveIo: archive }));
    const input = writerInput();
    const result = await node.run(input);

    // Step 4 形态：pause 型（非 error，errors 不计）。
    expect(result.stateKey).toBe('research_brief');
    expect((result.artifact as { error?: boolean }).error).toBeUndefined();
    const suspension = (result.artifact as { suspended: { kind: string; rounds: number; gaps: { desc: string }[] } })
      .suspended;
    expect(suspension.kind).toBe('verify_exhausted');
    expect(suspension.rounds).toBe(3);
    expect(suspension.gaps[0].desc).toContain('王五');
    expect(verifier).toHaveBeenCalledTimes(3); // 回合上限 = 核实轮数 3（补查 2）
    expect(generate).toHaveBeenCalledTimes(3); // 简报×3；阶段二未开写
    // 存档 last-wins：末轮简报 verified=false（未获许可，redo 不带旧账复用）+ 挂起载荷（含 gaps）。
    const stored = archive.store.get('ep-12') as {
      verified: boolean;
      suspension: { kind: string; rounds: number; gaps: { desc: string }[] };
    };
    expect(stored.verified).toBe(false);
    expect(stored.suspension.kind).toBe('verify_exhausted');
    expect(stored.suspension.gaps[0].desc).toContain('王五');
    const rb = input.run.artifacts['research_brief'] as { suspended: { kind: string }; verifyRounds: number };
    expect(rb.suspended.kind).toBe('verify_exhausted');
    expect(rb.verifyRounds).toBe(3);
  });

  it('补查失败（简报 parse 两试败）→ 同挂起族 verify_exhausted（核实已介入不静默绕过）', async () => {
    const verifier = vi
      .fn<() => Promise<WriterVerificationOutcome>>()
      .mockResolvedValueOnce({ kind: 'gaps', verdict: gapsVerdict() });
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound('废输出一'))
      .mockResolvedValueOnce(textRound('废输出二'));
    const node = createWriterNode(writerDeps({ generate, verifier }));
    const result = await node.run(writerInput());

    // Step 4 形态：pause 型（非 error）。
    expect(result.stateKey).toBe('research_brief');
    expect((result.artifact as { error?: boolean }).error).toBeUndefined();
    expect((result.artifact as { suspended: { kind: string; rounds: number } }).suspended).toMatchObject({
      kind: 'verify_exhausted',
      rounds: 1,
    });
  });

  // ── Story 8.4 Step 4（design §1.7 恢复 / 交付 3）：挂起重入的决断记录 + 重查链语义 ──

  it('上轮挂起 + 任务卡未变（维持原案）→ 重查（不复用）+ 决断记录 cardChanged=false 落章档案', async () => {
    const archive = makeMemoryArchive();
    archive.store.set('ep-12', {
      episodeId: 'ep-12',
      briefHash: computeBriefHash({ goal: '抵达 B 城' }), // 同 hash（维持原案）
      brief: VALID_BRIEF,
      verified: false, // 挂起条目恒未获许可
      suspension: { kind: 'research_contradiction', rounds: 1, suspendedAt: '2026-08-17T00:00:00Z' },
      savedAt: '2026-08-17T00:00:00Z',
    });
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({ kind: 'pass' }));
    const deps = writerDeps({ generate: twoPhaseGenerate(), archiveIo: archive, verifier });
    const input = writerInput();
    const result = await createWriterNode(deps).run(input);

    // 决断后继续语义（交付 3）：维持原案 → 任务卡没变但简报带矛盾 verified=false → 也重查（对——
    // 处理过矛盾的新简报才配 verified=true；挂起的章不得带旧账直写）。
    expect(deps.generate).toHaveBeenCalledTimes(4); // 阶段一真跑（非复用跳过）+ 申报
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(result.stateKey).toBe('draft.initial');
    // 决断记录落档：机械面 hash 对比（cardChanged=false）+ 时刻；新简报核实过后新条目覆盖
    // （suspension 清除、decision 保留）。
    const stored = archive.store.get('ep-12') as {
      verified: boolean;
      suspension?: unknown;
      decision?: { cardChanged: boolean; decidedAt: string };
    };
    expect(stored.verified).toBe(true);
    expect(stored.suspension).toBeUndefined(); // 决断兑现（新简报过核实）→ 挂起记录清除
    expect(stored.decision).toEqual({ cardChanged: false, decidedAt: '2026-08-18T00:00:00Z' });
  });

  it('上轮挂起 + 任务卡已改（改任务卡）→ briefHash 变 → 重查 + 决断记录 cardChanged=true', async () => {
    const archive = makeMemoryArchive();
    archive.store.set('ep-12', {
      episodeId: 'ep-12',
      briefHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000', // 旧 hash（已改卡）
      brief: VALID_BRIEF,
      verified: false,
      suspension: { kind: 'verify_exhausted', rounds: 3, suspendedAt: '2026-08-17T00:00:00Z' },
      savedAt: '2026-08-17T00:00:00Z',
    });
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({ kind: 'pass' }));
    const deps = writerDeps({ generate: twoPhaseGenerate(), archiveIo: archive, verifier });
    await createWriterNode(deps).run(writerInput());

    expect(deps.generate).toHaveBeenCalledTimes(4); // hash 变 → 作废重查（+ 申报）
    const stored = archive.store.get('ep-12') as {
      briefHash: string;
      decision?: { cardChanged: boolean };
    };
    expect(stored.briefHash).toBe(computeBriefHash({ goal: '抵达 B 城' })); // 新 hash 覆盖
    expect(stored.decision).toEqual({ cardChanged: true, decidedAt: '2026-08-18T00:00:00Z' });
  });

  it('上轮挂起重入后再挂起 → 档案仍带（新）suspension + decision（挂起族可连续决断）', async () => {
    const archive = makeMemoryArchive();
    archive.store.set('ep-12', {
      episodeId: 'ep-12',
      briefHash: computeBriefHash({ goal: '抵达 B 城' }),
      brief: VALID_BRIEF,
      verified: false,
      suspension: { kind: 'research_contradiction', rounds: 1, suspendedAt: '2026-08-17T00:00:00Z' },
      savedAt: '2026-08-17T00:00:00Z',
    });
    const contradictory: ResearchBrief = {
      ...VALID_BRIEF,
      issues: [{ desc: '任务卡与第 5 章正文冲突', severity: 'contradiction' }],
    };
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(contradictory)}\n<RESEARCH_BRIEF_READY>`));
    const node = createWriterNode(writerDeps({ generate, archiveIo: archive }));
    const result = await node.run(writerInput());

    expect(result.stateKey).toBe('research_brief'); // 再挂起
    const stored = archive.store.get('ep-12') as {
      suspension: { kind: string };
      decision?: { cardChanged: boolean };
    };
    expect(stored.suspension.kind).toBe('research_contradiction'); // 新挂起记录（last-wins）
    expect(stored.decision).toEqual({ cardChanged: false, decidedAt: '2026-08-18T00:00:00Z' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R2-盲2（2026-08-19）：决断「维持原案」总循环——approvedDeviations 决断绑定
//
// 修复前：decisionRecord 只写档案，无通道进入重跑——写手再亮牌同偏离 → escalate belt 再挂起 → 循环；
// 唯一出口是改任务卡（违决断语义）或写手不再申报偏离（制度性激励隐瞒）。修复：决断=维持原案
// （cardChanged=false）→ 挂起载荷 deviations 清单记 approvedDeviations → 重跑注入写手阶段一指令
// + belt（写手侧 runVerify / 核实器侧 mapVerdictToOutcome 双消费单源）与已批准项相同的 deviation
// （scene_ref+plan_says 对拍）不升级——同偏离不再挂起、新偏离照常挂（批准的是具体偏离不是通行证）。
// ═══════════════════════════════════════════════════════════════════════════

describe('createWriterNode — R2-盲2 决断「维持原案」偏离批准绑定', () => {
  /** 挂起载荷中的偏离 D1（上轮亮牌——本轮已批准的对照物）。 */
  const D1 = { scene_ref: 's_gate', plan_says: '正面强攻', brief_says: '智取小道', reason: '人物动机' };
  /** 同偏离身份（scene_ref+plan_says 同）但写手复述措辞漂移（brief_says 不同）。 */
  const D1_REPHRASED = { scene_ref: 's_gate', plan_says: '正面强攻', brief_says: '改走小道突袭', reason: '人物动机' };
  /** 清单外新偏离。 */
  const D2 = { scene_ref: 's_alley', plan_says: '绕开巷战', brief_says: '正面入巷', reason: '节奏需要' };

  function deviatingBrief(deviations: typeof D1[]): ResearchBrief {
    return { ...VALID_BRIEF, deviations };
  }

  /** 上轮挂起档案（suspension 携 deviations + briefHash 由参数控制=维持原案/改卡）。 */
  function suspendedArchive(briefHash: string) {
    const archive = makeMemoryArchive();
    archive.store.set('ep-12', {
      episodeId: 'ep-12',
      briefHash,
      brief: deviatingBrief([D1]),
      verified: false,
      suspension: {
        kind: 'research_contradiction',
        rounds: 1,
        evidence: { contradictions: [], deviations: [D1] },
        suspendedAt: '2026-08-17T00:00:00Z',
      },
      savedAt: '2026-08-17T00:00:00Z',
    });
    return archive;
  }

  it('决断维持原案（cardChanged=false）→ approvedDeviations 落档 + 同偏离（含措辞漂移）重跑不再挂起 + 指令注入已批准段', async () => {
    const archive = suspendedArchive(computeBriefHash({ goal: '抵达 B 城' })); // 同 hash = 维持原案
    // 写手重查后仍亮同偏离（brief_says 措辞漂移——对拍锚 scene_ref+plan_says）。
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(deviatingBrief([D1_REPHRASED]))}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({ kind: 'pass' }));
    const deps = writerDeps({ generate, archiveIo: archive, verifier });
    const input = writerInput();
    const result = await createWriterNode(deps).run(input);

    // 同偏离不再挂起——直接写到 draft.initial（修复前 belt 再挂起成环）。
    expect(result.stateKey).toBe('draft.initial');
    // 阶段一指令注入「已批准偏离」段（告知按批准方案写、不再申报——消除激励隐瞒）。
    // ⚠️ mock.calls[0][0] 是活引用（调用后仍被 push assistant/tool 消息）——断言用成员查找。
    const phase1Msgs = generate.mock.calls[0][0];
    const phase1Prompt = phase1Msgs.find((m) => m.role === 'user' && m.content.includes('第一步·动笔前自查'));
    expect(phase1Prompt).toBeDefined();
    expect(phase1Prompt!.content).toContain('已批准的偏离');
    expect(phase1Prompt!.content).toContain('s_gate');
    expect(phase1Prompt!.content).toContain('正面强攻');
    expect(phase1Prompt!.content).toContain('不再作为偏离重复申报');
    // 决断记录落档：cardChanged=false + approvedDeviations 清单（机械绑定语义——用户没改卡重调 = 放行）。
    const stored = archive.store.get('ep-12') as {
      verified: boolean;
      decision?: { cardChanged: boolean; approvedDeviations?: typeof D1[] };
    };
    expect(stored.decision?.cardChanged).toBe(false);
    expect(stored.decision?.approvedDeviations).toEqual([D1]);
    // 重查真过后最终态 verified=true（批准的是偏离，许可仍须核实过）。
    expect(stored.verified).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it('已批准偏离 + 清单外新偏离 → 新偏离照常挂起（批准的是具体偏离不是通行证）', async () => {
    const archive = suspendedArchive(computeBriefHash({ goal: '抵达 B 城' }));
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(deviatingBrief([D1, D2]))}\n<RESEARCH_BRIEF_READY>`));
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({ kind: 'pass' }));
    const node = createWriterNode(writerDeps({ generate, archiveIo: archive, verifier }));
    const result = await node.run(writerInput());

    // D2 新偏离 → belt 照挂（同偏离 D1 已过滤）。
    expect(result.stateKey).toBe('research_brief');
    const suspended = (result.artifact as { suspended: { evidence: { deviations: { scene_ref: string }[] } } })
      .suspended;
    expect(suspended.kind).toBe('research_contradiction');
    expect(suspended.evidence.deviations.map((d) => d.scene_ref)).toEqual(['s_gate', 's_alley']);
    expect(generate).toHaveBeenCalledTimes(1); // 阶段二未开写
  });

  it('决断改任务卡（cardChanged=true）→ approvedDeviations 不记 → 同偏离照常再挂起（旧偏离对照物已失效）', async () => {
    // 旧 hash ≠ 当前 → cardChanged=true（改卡/改设定检出）——挂起载荷偏离不作数。
    const archive = suspendedArchive('sha256:0000000000000000000000000000000000000000000000000000000000000000');
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(deviatingBrief([D1]))}\n<RESEARCH_BRIEF_READY>`));
    const node = createWriterNode(writerDeps({ generate, archiveIo: archive }));
    const input = writerInput();
    const result = await node.run(input);

    // 无批准过滤 → 同偏离再挂起（挂起是正确行为——新任务卡下偏离须重新决断）。
    expect(result.stateKey).toBe('research_brief');
    // 指令不注入已批准段（approvedDeviations 空）。⚠️ 活引用——成员查找。
    const phase1Msgs = generate.mock.calls[0][0];
    const phase1Prompt = phase1Msgs.find((m) => m.role === 'user' && m.content.includes('第一步·动笔前自查'));
    expect(phase1Prompt).toBeDefined();
    expect(phase1Prompt!.content).not.toContain('已批准的偏离');
    const stored = archive.store.get('ep-12') as {
      decision?: { cardChanged: boolean; approvedDeviations?: unknown };
    };
    expect(stored.decision?.cardChanged).toBe(true);
    expect(stored.decision?.approvedDeviations).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// verdict 全量归档（Story 8.4 Step 6 / A3，design §1.9「简报+verdict+最终许可」都留档）
// ════════════════════════════════════════════════════════════════════════════

describe('createWriterNode — verdict 全量归档（Step 6）', () => {
  /** 记录全量写入历史的内存档案 fake（verdict last-wins 时序断言——store 只存末态不够看中间态）。 */
  function makeRecordingArchive(): WriterArchiveIo & {
    store: Map<string, unknown>;
    writes: Array<Record<string, unknown>>;
  } {
    const store = new Map<string, unknown>();
    const writes: Array<Record<string, unknown>> = [];
    return {
      store,
      writes,
      async read(_p, episodeId) {
        return (store.get(episodeId) as Awaited<ReturnType<WriterArchiveIo['read']>>) ?? null;
      },
      async write(_p, entry) {
        writes.push(entry as Record<string, unknown>);
        store.set(entry.episodeId, entry);
      },
    };
  }

  function passVerdict(): VerificationVerdict {
    return {
      checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
      pass: true,
      gaps: [],
      suggestions: [{ text: '可让 15 章未出场的少女 C 背景露一面', basis: '出场间隔统计：王五 5 章未出场' }],
      archive_issues: [],
    };
  }

  function gapsVerdict(): VerificationVerdict {
    return {
      checklist: { entities_checked: false, sources_grounded: true, gaps_cleared: false, contradictions_zero: true },
      pass: false,
      gaps: [{ desc: '未核查配角王五的行踪', source_hint: 'query_story 搜「王五」' }],
      suggestions: [],
      archive_issues: [],
    };
  }

  it('pass → 最终档案 = 简报+verdict+verified=true（design §1.9 三件齐；核实产出即存先落 verified=false 再终态覆写）', async () => {
    const archive = makeRecordingArchive();
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({ kind: 'pass', verdict: passVerdict() }));
    const node = createWriterNode(writerDeps({ verifier, archiveIo: archive }));
    const result = await node.run(writerInput());

    expect(result.stateKey).toBe('draft.initial');
    // 末态：简报 + verdict（含 suggestions/archive_issues 全字段）+ 最终许可。
    const stored = archive.store.get('ep-12') as {
      brief: ResearchBrief;
      verified: boolean;
      verdict?: VerificationVerdict;
    };
    expect(stored.verified).toBe(true);
    expect(stored.verdict).toEqual(passVerdict());
    expect(stored.brief).toEqual(VALID_BRIEF);
    // 核实产出即存（last-wins 时序）：①阶段一产档（verified=false 无 verdict）→ ②核实产出即档
    // （verified=false + verdict）→ ③pass 终态档（verified=true + verdict）——同一写入链三次覆写。
    expect(archive.writes).toHaveLength(3);
    expect(archive.writes[0].verdict).toBeUndefined();
    expect(archive.writes[1].verified).toBe(false);
    expect(archive.writes[1].verdict).toEqual(passVerdict());
    expect(archive.writes[2].verified).toBe(true);
  });

  it('补查两轮 → 档案 verdict = 最后一轮（last-wins，第一轮 gaps verdict 被最终覆盖）', async () => {
    const brief2: ResearchBrief = {
      ...VALID_BRIEF,
      entries: [
        ...VALID_BRIEF.entries,
        { ref: 'char-wang', kind: 'asset', key_facts: [{ fact: '王五在第 5 章已南下', source: '人物卡 char-wang' }] },
      ],
    };
    const verifier = vi
      .fn<() => Promise<WriterVerificationOutcome>>()
      .mockResolvedValueOnce({ kind: 'gaps', verdict: gapsVerdict() })
      .mockResolvedValueOnce({ kind: 'pass', verdict: passVerdict() });
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(brief2)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const archive = makeRecordingArchive();
    await createWriterNode(writerDeps({ generate, verifier, archiveIo: archive })).run(writerInput());

    // 末轮 verdict 最终保留（round-1 gaps verdict 不在末态；archive 非逐轮历史数组——Step 3 既有记录形式）。
    const stored = archive.store.get('ep-12') as { verdict?: VerificationVerdict };
    expect(stored.verdict).toEqual(passVerdict());
    // 中间态核实产出即存可观测：round-1 gaps verdict 曾落档（写入序：产档→verify1→简报2 更新〔携 round-1
    // verdict last-wins〕→verify2→pass 终态）。
    expect(archive.writes).toHaveLength(5);
    expect(archive.writes[1].verdict).toEqual(gapsVerdict());
    expect(archive.writes[3].verdict).toEqual(passVerdict());
  });

  it('escalate 挂起 → 档案 = 简报 + suspension 载荷 + verdict（挂起轮 verdict 也在档）', async () => {
    const escalateVerdict: VerificationVerdict = {
      checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: false },
      pass: false,
      gaps: [],
      suggestions: [],
      archive_issues: [{ card_ref: 'card-empire', problem: '设定卡写的国号与第 5 章正文冲突' }],
      escalate: true,
    };
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({ kind: 'escalate', verdict: escalateVerdict }));
    const archive = makeRecordingArchive();
    const result = await createWriterNode(writerDeps({ verifier, archiveIo: archive })).run(writerInput());

    expect(result.stateKey).toBe('research_brief'); // pause 型挂起
    const stored = archive.store.get('ep-12') as {
      verified: boolean;
      verdict?: VerificationVerdict;
      suspension: { kind: string };
    };
    expect(stored.verified).toBe(false);
    expect(stored.suspension.kind).toBe('research_contradiction');
    expect(stored.verdict).toEqual(escalateVerdict); // 挂起轮 verdict 全量在档（含 archive_issues）
  });

  it('no-op 核实（verdict 缺省）→ 档案不带 verdict 字段（optional additive，旧档/缺省兼容）', async () => {
    const archive = makeRecordingArchive();
    await createWriterNode(writerDeps({ archiveIo: archive })).run(writerInput()); // 缺省 NOOP verifier

    const stored = archive.store.get('ep-12') as { verified: boolean; verdict?: VerificationVerdict };
    expect(stored.verified).toBe(true);
    expect(stored.verdict).toBeUndefined();
    expect('verdict' in stored).toBe(false); // 字段不落（非 undefined 占位）
  });

  // ── R2-盲3（2026-08-19）：graceful pass（infra 失败降级直通）不置 verified——不固化终身许可证 ──

  it('R2-盲3：verifier graceful 降级 pass（degraded=true 无 verdict）→ 档案 verified 不置 + verifyDegraded 标记 + 照常开写（尝试降级）', async () => {
    const archive = makeRecordingArchive();
    // 模拟核实器 infra 失败（parse 两试败/工具不可用/熔断）的 graceful 直通——非真许可。
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({ kind: 'pass', degraded: true }));
    const node = createWriterNode(writerDeps({ verifier, archiveIo: archive }));
    const input = writerInput();
    const result = await node.run(input);

    // 降级直通不阻断写作（增强层哲学不变）。
    expect(result.stateKey).toBe('draft.initial');
    // 核心：verified 不置（修复前 = true → 此后同任务卡永跳自查+核实）+ verifyDegraded 落档。
    const stored = archive.store.get('ep-12') as {
      verified: boolean;
      verifyDegraded?: true;
      verdict?: VerificationVerdict;
    };
    expect(stored.verified).toBe(false);
    expect(stored.verifyDegraded).toBe(true);
    expect(stored.verdict).toBeUndefined();
    // artifact 同步标注（RunSnapshot 可观测）。
    const research = input.run.artifacts['research_brief'] as { verified?: boolean; verifyDegraded?: boolean };
    expect(research.verified).toBeUndefined();
    expect(research.verifyDegraded).toBe(true);
  });

  it('R2-盲3：降级档案分裂复用——同任务卡重跑自查跳过（简报可复用）但**核实重跑**，真 pass 后 verified=true', async () => {
    // 上轮 graceful 降级直通留下的档案：hash 同 + verified=false + verifyDegraded=true（简报没坏只是没核实过）。
    const archive = makeRecordingArchive();
    archive.store.set('ep-12', {
      episodeId: 'ep-12',
      briefHash: computeBriefHash({ goal: '抵达 B 城' }),
      brief: VALID_BRIEF,
      verified: false,
      verifyDegraded: true,
      savedAt: '2026-08-17T00:00:00Z',
    });
    // 本轮核实 infra 恢复：真 pass 携 verdict。
    const passVerdict: VerificationVerdict = {
      checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
      pass: true,
      gaps: [],
      suggestions: [],
      archive_issues: [],
    };
    const verifier = vi.fn(async (): Promise<WriterVerificationOutcome> => ({ kind: 'pass', verdict: passVerdict }));
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const node = createWriterNode(writerDeps({ generate, archiveIo: archive, verifier }));
    const input = writerInput();
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    // 核心双向：自查跳过（generate 2 次——简报复用非重查 + 申报一轮）+ 核实重跑（verifier 1 次——降级档案不跳核实）。
    expect(generate).toHaveBeenCalledTimes(2);
    expect(verifier).toHaveBeenCalledTimes(1);
    // 真 pass 后终态：verified=true + verifyDegraded 标记清除（下轮全量复用）。
    const stored = archive.store.get('ep-12') as {
      verified: boolean;
      verifyDegraded?: true;
      verdict?: VerificationVerdict;
    };
    expect(stored.verified).toBe(true);
    expect(stored.verifyDegraded).toBeUndefined();
    expect(stored.verdict).toEqual(passVerdict);
    expect(input.run.artifacts['research_brief']).toMatchObject({ reused: true, verified: true, brief: VALID_BRIEF });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 纯函数：stableStringify / computeBriefHash
// ════════════════════════════════════════════════════════════════════════════

describe('stableStringify / computeBriefHash', () => {
  it('key 插入序不同 → 同串同 hash（指纹对 key 序不敏感）', () => {
    const a = { goal: 'g', tone: 't' };
    const b = { tone: 't', goal: 'g' };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(computeBriefHash(a)).toBe(computeBriefHash(b));
  });

  it('内容变 → hash 变（leader 改任务卡可检出）', () => {
    expect(computeBriefHash({ goal: 'a' })).not.toBe(computeBriefHash({ goal: 'b' }));
  });

  it('嵌套对象/数组递归稳定 + undefined 字段剔除', () => {
    const a = { x: [{ b: 1, a: 2 }], u: undefined };
    const b = { x: [{ a: 2, b: 1 }] };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 纯函数：archiveDirName（CR-003——sanitize 折叠碰撞 → hash 后缀保唯一）
// ═══════════════════════════════════════════════════════════════════════════

describe('archiveDirName（CR-003 目录名唯一性）', () => {
  it('sanitize 同折叠的不同 id → 不同目录（ep.1 / ep_1 / "ep 1" 互不串扰）', () => {
    const a = archiveDirName('ep.1');
    const b = archiveDirName('ep_1');
    const c = archiveDirName('ep 1');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('同 id 稳定同目录（复用 / last-wins 语义不变）', () => {
    expect(archiveDirName('ep-12')).toBe(archiveDirName('ep-12'));
    expect(archiveDirName('章.第一集')).toBe(archiveDirName('章.第一集'));
  });

  it('路径穿越字符仍被剥（hash 段为 hex 无危险字符）+ 纯中文 id 不再互撞', () => {
    const dangerous = archiveDirName('ep/../12');
    expect(dangerous).not.toContain('/');
    expect(dangerous).not.toContain('..');
    // 纯中文 id（sanitized 全折叠为 _）靠 hash 后缀区分。
    expect(archiveDirName('第一章')).not.toBe(archiveDirName('第二章'));
    expect(archiveDirName('第一章')).toMatch(/^_+-[0-9a-f]{8}$/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// fs 章档案（默认 FS_ARCHIVE_IO——真临时目录读写 + 坏档案防御）
// ════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// dogfood R2 #93 P0-1（2026-08-28）：draft checkpoint 草稿落章档案 helper
//（.orison/chapter-archive/<dir>/draft-v<N>.md——与 research-brief.json 同目录；真链集成测在
// runChapterChain.test.ts，此处钉 helper 单元语义：版本递增 + 跳过条件）。
// ═══════════════════════════════════════════════════════════════════════════

describe('writeDraftCheckpointArchive（#93 P0-1 草稿安全副本）', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'orison-writer-draft-archive-'));
  });
  afterEach(() => {
    rmBestEffort(dir);
  });

  it('首写 → draft-v1.md；再写 → draft-v2.md（版本 = 到达 checkpoint 的写作轮次）', async () => {
    const first = await writeDraftCheckpointArchive(dir, 'ep1', '第一版正文。');
    expect(first).toBe('draft-v1.md');
    const second = await writeDraftCheckpointArchive(dir, 'ep1', '第二版正文（redo）。');
    expect(second).toBe('draft-v2.md');
    expect(readFileSync(path.join(dir, '.orison', 'chapter-archive', archiveDirName('ep1'), 'draft-v1.md'), 'utf-8')).toBe('第一版正文。');
    expect(readFileSync(path.join(dir, '.orison', 'chapter-archive', archiveDirName('ep1'), 'draft-v2.md'), 'utf-8')).toBe('第二版正文（redo）。');
  });

  it('episodeId 缺 / 正文空（挂起 pause 无草稿）→ 跳过返 null（零文件写入）', async () => {
    expect(await writeDraftCheckpointArchive(dir, undefined, '正文')).toBeNull();
    expect(await writeDraftCheckpointArchive(dir, 'ep1', '')).toBeNull();
    expect(await writeDraftCheckpointArchive(dir, 'ep1', '   ')).toBeNull();
    // 目录未建（跳过不产生任何副作用）。
    expect(existsSync(path.join(dir, '.orison'))).toBe(false);
  });
});

describe('fs 章档案（.orison/chapter-archive/<episodeId>/research-brief.json）', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'orison-writer-archive-'));
  });
  afterEach(() => {
    rmBestEffort(dir);
  });

  /** fs 默认档案路径的节点输入（projectPath 覆盖为临时目录）。 */
  function fsInput(episodeId: string, brief: Record<string, unknown>): NodeRunInput {
    const input: NodeRunInput = {
      run: makeRun({
        chapter_brief: brief,
        chapter_brief_input: { episodeId, brief },
        scene_graph: { nodes: [] },
        settings_context: 's',
      }),
      requirement: '',
    };
    input.run.projectPath = dir;
    return input;
  }

  it('缺省 fs IO：首跑存档 → 同 brief 二跑复用（episodeId 含路径字符被安全段化不穿越）', async () => {
    const weirdEpisode = 'ep/12 ..穿越';
    const tools = makeAllTools();

    const gen1 = twoPhaseGenerate();
    const r1 = await createWriterNode({
      generate: gen1,
      resolveTool: (id) => tools.get(id),
      nowISO: () => '2026-08-18T00:00:00Z',
    }).run(fsInput(weirdEpisode, { goal: 'g' }));
    expect(r1.stateKey).toBe('draft.initial');
    expect(gen1).toHaveBeenCalledTimes(4); // 阶段一真跑（无存档）+ 申报

    // 二跑：同 brief → 同 hash → 复用（generate 只阶段二+申报 2 次）。
    const gen2 = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const r2 = await createWriterNode({
      generate: gen2,
      resolveTool: (id) => tools.get(id),
      nowISO: () => '2026-08-18T00:00:00Z',
    }).run(fsInput(weirdEpisode, { goal: 'g' }));
    expect(r2.stateKey).toBe('draft.initial');
    expect(gen2).toHaveBeenCalledTimes(2); // 复用：跳过阶段一（申报轮照跑）
  });

  it('坏档案（损坏 JSON）→ read 当 null 重查不炸', async () => {
    const episodeId = 'ep-bad';
    // CR-003：目录名 = sanitize + hash 后缀（archiveDirName 单源）。
    const archiveDir = path.join(dir, '.orison', 'chapter-archive', archiveDirName(episodeId));
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(path.join(archiveDir, 'research-brief.json'), '{corrupted', 'utf-8');

    const tools = makeAllTools();
    const gen = twoPhaseGenerate();
    const r = await createWriterNode({
      generate: gen,
      resolveTool: (id) => tools.get(id),
      nowISO: () => '2026-08-18T00:00:00Z',
    }).run(fsInput(episodeId, { goal: 'g2' }));
    expect(r.stateKey).toBe('draft.initial');
    expect(gen).toHaveBeenCalledTimes(4); // 坏档案当无存档 → 阶段一重查（+ 申报）
  });

  it('Step 6：档案带 verdict 字段（新档）→ fs read safeParse 过 → 复用照常（schema 前向兼容，已核实在档）', async () => {
    const episodeId = 'ep-verdict';
    // CR-003：目录名 = sanitize + hash 后缀（archiveDirName 单源）。
    const archiveDir = path.join(dir, '.orison', 'chapter-archive', archiveDirName(episodeId));
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      path.join(archiveDir, 'research-brief.json'),
      JSON.stringify({
        episodeId,
        briefHash: computeBriefHash({ goal: 'g' }),
        brief: VALID_BRIEF,
        verified: true,
        verdict: {
          checklist: { entities_checked: true, sources_grounded: true, gaps_cleared: true, contradictions_zero: true },
          pass: true,
          gaps: [],
          suggestions: [],
          archive_issues: [],
        },
        savedAt: '2026-08-17T00:00:00Z',
      }),
      'utf-8',
    );

    const tools = makeAllTools();
    const gen = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const r = await createWriterNode({
      generate: gen,
      resolveTool: (id) => tools.get(id),
      nowISO: () => '2026-08-18T00:00:00Z',
    }).run(fsInput(episodeId, { goal: 'g' }));
    expect(r.stateKey).toBe('draft.initial');
    expect(gen).toHaveBeenCalledTimes(2); // 带 verdict 新档 safeParse 过 → 复用（跳过阶段一与核实）+ 申报
  });

  // ── CR-003（2026-08-19）：目录名 sanitize 折叠碰撞 → hash 后缀保唯一 ──

  it('CR-003：ep.1 与 ep_1（sanitize 同折叠）→ 各自独立目录互不串扰（复用判定不跨章误中）', async () => {
    const tools = makeAllTools();
    const mkNode = (generate: MockGenerate) =>
      createWriterNode({
        generate,
        resolveTool: (id) => tools.get(id),
        nowISO: () => '2026-08-18T00:00:00Z',
      });

    // ep.1 首跑（阶段一真跑 + 存档）。
    const gen1 = twoPhaseGenerate();
    await mkNode(gen1).run(fsInput('ep.1', { goal: 'g' }));
    // ep_1 首跑——修复前会命中 ep.1 的目录（同折叠 last-wins 覆写 + 复用误中）；修复后独立目录真查。
    const gen2 = twoPhaseGenerate();
    await mkNode(gen2).run(fsInput('ep_1', { goal: 'g' }));
    expect(gen2).toHaveBeenCalledTimes(4); // 无存档可复用 → 阶段一真跑（跨章零串扰）+ 申报

    // 两目录各自存在（hash 后缀区分）且互不相同。
    const dirA = path.join(dir, '.orison', 'chapter-archive', archiveDirName('ep.1'));
    const dirB = path.join(dir, '.orison', 'chapter-archive', archiveDirName('ep_1'));
    expect(dirA).not.toBe(dirB);
    const fs = await import('node:fs');
    expect(fs.existsSync(path.join(dirA, 'research-brief.json'))).toBe(true);
    expect(fs.existsSync(path.join(dirB, 'research-brief.json'))).toBe(true);

    // 同 id（ep.1）二跑：同目录命中 → 复用（同 id 稳定同目录语义不变）。
    const gen3 = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    await mkNode(gen3).run(fsInput('ep.1', { goal: 'g' }));
    expect(gen3).toHaveBeenCalledTimes(2); // 复用：跳过阶段一（申报轮照跑）
  });

  it('CR-003：旧档案兼容——read 先试新名 miss → fallback 旧名（sanitize-only）命中复用，不重建', async () => {
    const episodeId = 'ep-legacy';
    // 手写旧命名档案（CR-003 前形态：sanitize-only 目录名，无 hash 后缀）。
    const legacyDir = path.join(dir, '.orison', 'chapter-archive', episodeId);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      path.join(legacyDir, 'research-brief.json'),
      JSON.stringify({
        episodeId,
        briefHash: computeBriefHash({ goal: 'g' }),
        brief: VALID_BRIEF,
        verified: true,
        savedAt: '2026-08-17T00:00:00Z',
      }),
      'utf-8',
    );

    const tools = makeAllTools();
    const gen = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const r = await createWriterNode({
      generate: gen,
      resolveTool: (id) => tools.get(id),
      nowISO: () => '2026-08-18T00:00:00Z',
    }).run(fsInput(episodeId, { goal: 'g' }));

    expect(r.stateKey).toBe('draft.initial');
    expect(gen).toHaveBeenCalledTimes(2); // 旧名 fallback 命中 → 复用（零重查）+ 申报
    // 复用是只读路径（同 hash 已核实，无新事实可写）——旧档案原位不动；新名目录在下次非复用写入时
    // 自然迁移（write 恒走新名）。此处断言旧档案仍在（未误删/未动）。
    const fs = await import('node:fs');
    expect(fs.existsSync(path.join(legacyDir, 'research-brief.json'))).toBe(true);
  });

  // ── R2-盲4（2026-08-19）：legacy 回退不校验 episodeId → 折叠目录串台他章档案 ──

  it('R2-盲4：混存磁盘（ep_1 旧名档案存在）→ 读 ep.1 fallback 命中但 episodeId 不符 → 当 miss 重查不污染', async () => {
    const tools = makeAllTools();
    const mkNode = (generate: MockGenerate) =>
      createWriterNode({
        generate,
        resolveTool: (id) => tools.get(id),
        nowISO: () => '2026-08-18T00:00:00Z',
      });

    // 磁盘混存：旧命名时代 ep_1（另一章）的档案落在 'ep_1' 目录——而 legacyArchiveDirName('ep.1')
    // 同折叠为 'ep_1'（CR-003 前碰撞根源）。briefHash 刻意与本章一致（'goal:g' 同源）——修复前会
    // fallback 命中他章档案：复用判定三条件全过 → 用他章简报写本章 + 他章 suspension 串台。
    const chapterIdA = 'ep_1';
    const legacyDir = path.join(dir, '.orison', 'chapter-archive', 'ep_1');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      path.join(legacyDir, 'research-brief.json'),
      JSON.stringify({
        episodeId: chapterIdA, // 他章条目（episodeId ≠ 'ep.1'）
        briefHash: computeBriefHash({ goal: 'g' }),
        brief: VALID_BRIEF,
        verified: true,
        savedAt: '2026-08-17T00:00:00Z',
      }),
      'utf-8',
    );

    // 读 ep.1（新名 miss → fallback 旧名 'ep_1' 命中文件，但 episodeId 不符 → 校验拒 → null）。
    const gen = twoPhaseGenerate();
    const r = await mkNode(gen).run(fsInput('ep.1', { goal: 'g' }));
    expect(r.stateKey).toBe('draft.initial');
    expect(gen).toHaveBeenCalledTimes(4); // 首跑重查（修复前 = 1 次复用他章简报）+ 申报
    // 他章档案原位不动（未被本章覆写污染）。
    const fs = await import('node:fs');
    expect(fs.existsSync(path.join(legacyDir, 'research-brief.json'))).toBe(true);
    const rawA = JSON.parse(fs.readFileSync(path.join(legacyDir, 'research-brief.json'), 'utf-8')) as {
      episodeId: string;
    };
    expect(rawA.episodeId).toBe(chapterIdA);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CR-001（2026-08-19）：abort signal 生产装配接线（createChapterChainNodes 第 4 参）
//
// 修复前：chapter-chain llmDeps 无 signal + verifier 装配未传 → makeAgentLoop 兜底自建永不 abort 的
// signal → 循环化把取消窗口从 1 次调用放大至 ~200+ 轮照烧。修复后：runChapterChain 的 options.abort
// 同源透传装配（workflow.ts:950）→ 写手循环（阶段一自查/补查/阶段二）与核实器子循环共享真 signal。
// 本 describe 用**生产装配形态**（createChapterChainNodes，非手搓 createWriterNode deps）验证接线。
// ═══════════════════════════════════════════════════════════════════════════

describe('CR-001 — 生产装配 signal 接线（chapter-chain 装配形态）', () => {
  let dir = '';
  /** CR-24：执行 seam 还原句柄（动态导入的模块函数类型，afterEach 配对还原）。 */
  let signalSeamRestore: typeof import('../src/tool/remote')['setExecuteToolFn'] | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'orison-writer-signal-'));
    // 生产装配的写手/核实器用默认 resolveTool（builtin registry）——须注册 + stub 执行 seam
    // （mirror runChapterChain.test.ts Story 8.4 beforeEach；取数侧 graceful 降级）。
    const { registerBuiltinTools } = await import('../src/tool/builtin');
    registerBuiltinTools();
    const { setExecuteToolFn } = await import('../src/tool/remote');
    setExecuteToolFn(async (toolId) => ({ title: toolId, output: `(${toolId} unset)` }));
    signalSeamRestore = setExecuteToolFn;
  });

  afterEach(() => {
    rmBestEffort(dir);
    // CR-24（09-12 agy provider CR 批）：执行 seam 注入/还原配对——stub 不跨 describe 残留。
    signalSeamRestore?.(undefined);
    signalSeamRestore = undefined;
  });

  /** 生产装配链的 draft-writer 节点（真 createResearchVerifier 注入形态）。 */
  async function makeAssembledWriter(
    generate: MockGenerate,
    signal?: AbortSignal,
  ): Promise<import('../src/contracts/run').AgentNode> {
    const { createChapterChainNodes } = await import('../src/nodes/chapter-chain');
    const session = {
      id: 'sess-cr001', agentName: 'chapter-chain', projectPath: dir, status: 'idle' as const,
      messages: [], children: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
    const chain = createChapterChainNodes(generate, undefined, session, signal);
    return chain.find((c) => c.id === 'draft-writer-agent')!.node;
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

  it('真 signal 流进写手两阶段与核实器（generate 第 4 参恒为装配传入的同一 signal 对象）', async () => {
    const controller = new AbortController();
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`)) // 写手阶段一
      .mockResolvedValueOnce(textRound(passVerdictJson())) // 核实器子循环
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`)) // 写手阶段二
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`)); // 写手申报轮（8.7）
    const node = await makeAssembledWriter(generate, controller.signal);

    const input = writerInput();
    input.run.projectPath = dir; // FS 章档案落临时目录
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(generate).toHaveBeenCalledTimes(4);
    // 四次 generate（写手阶段一 / 核实器 / 写手阶段二 / 写手申报轮）的 abort 信号 = 装配传入的同一对象
    // （非 makeAgentLoop 兜底自建——身份断言是最强接线证明；申报轮同享 signal）。
    expect(generate.mock.calls[0][3]).toBe(controller.signal); // 写手自查循环
    expect(generate.mock.calls[1][3]).toBe(controller.signal); // 资料员核实子循环
    expect(generate.mock.calls[2][3]).toBe(controller.signal); // 写手写作循环
    expect(generate.mock.calls[3][3]).toBe(controller.signal); // 写手申报轮（8.7 阶段 2.5）
  });

  it('signal 中途 abort → 循环真中断（AbortError 传播不吞，非 error artifact）', async () => {
    const controller = new AbortController();
    const generate = vi.fn<GenerateFn>(async (_msgs, sys) => {
      const s = sys ?? '';
      if (s.includes('出发核查员')) {
        // 核实器首轮 generate 返回时取消——signal 经装配透传进两个 loop deps，阶段二循环轮首
        // throwIfAborted 抛（修复前是永不 abort 的自建 signal，阶段二照烧）。
        controller.abort();
        return textRound(passVerdictJson());
      }
      // 写手阶段一：简报收束。
      return textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`);
    });
    const node = await makeAssembledWriter(generate, controller.signal);

    const input = writerInput();
    input.run.projectPath = dir;
    // Node 原生 abort 的 DOMException message 是 'This operation was aborted'（name=AbortError）。
    await expect(node.run(input)).rejects.toThrow(/abort/i);
    expect(generate).toHaveBeenCalledTimes(2); // 写手阶段一 + 核实器首轮后即停（阶段二未烧）
  });

  it('signal 缺省（旧装配形态 / 测试）→ 零回归（节点自建永不 abort 的 signal 照常跑完）', async () => {
    const generate = vi
      .fn<GenerateFn>()
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_BRIEF)}\n<RESEARCH_BRIEF_READY>`))
      .mockResolvedValueOnce(textRound(passVerdictJson()))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DRAFT)}\n<DRAFT_READY>`))
      .mockResolvedValueOnce(textRound(`${JSON.stringify(VALID_DECLARATION)}\n<CAST_DECLARATION_READY>`));
    const node = await makeAssembledWriter(generate, undefined);

    const input = writerInput();
    input.run.projectPath = dir;
    const result = await node.run(input);

    expect(result.stateKey).toBe('draft.initial');
    expect(generate).toHaveBeenCalledTimes(4); // 4.0 既有行为（缺省自建 signal）不变 + 申报轮（8.7）
  });
});
