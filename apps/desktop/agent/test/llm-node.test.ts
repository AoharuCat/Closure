import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLlmNode, type GenerateFn } from '../src/nodes/llm-node';
import type { RunSnapshot } from '../src/contracts/run';
import type { GenerateResult } from '../src/provider/ipc-provider';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §4.2 / implement.md 2.3：createLlmNode 工厂。
// mock generate（返 fixture JSON）→ loadAgentPrompt 读真实 yaml（role=draft-writer-agent）→
// renderTemplate 渲染 user 段 → parseOutput（JSON.parse + Zod）→ NodeResult。
// 核心：generate 收到的是 yaml system 段（非运行时默认 systemPrompt "You are Closure"）。
// ─────────────────────────────────────────────────────────────────────────────

function makeRun(artifacts: Record<string, unknown> = {}): RunSnapshot {
  return {
    runId: 'run_test',
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

/** draft-writer 节点配置（mirror Step 3 实例化形态：buildPrompt 抽 chapterTask/storyPlan/projectContext）。 */
const draftWriterConfig = {
  nodeId: 'draft-writer-agent',
  role: 'draft-writer-agent', // 真实 prompts/draft-writer-agent.yaml
  contract: null,
  buildPrompt: (run: RunSnapshot) => ({
    chapterTask: String(run.artifacts['chapter_brief'] ?? '(no brief)'),
    storyPlan: String(run.artifacts['scene_graph'] ?? '(no scene_graph)'),
    projectContext: String(run.artifacts['settings_context'] ?? '(no settings)'),
  }),
  parseOutput: (content: string) => {
    const schema = z.object({
      title: z.string(),
      text: z.string(),
      wordCount: z.number(),
      chapterId: z.string().optional(),
    });
    const parsed = schema.parse(JSON.parse(content));
    return { stateKey: 'draft.initial', artifact: parsed };
  },
};

function makeOkResult(json: object): GenerateResult {
  return { content: JSON.stringify(json), finishReason: 'stop' };
}

const VALID_DRAFT = { title: '第一章 启程', text: '清晨的阳光洒在……', wordCount: 2500, chapterId: 'ch_1' };

describe('createLlmNode — happy path', () => {
  it('单次 generate → parseOutput → NodeResult（stateKey=draft.initial）', async () => {
    const generateMock = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const node = createLlmNode(draftWriterConfig, {
      generate: generateMock,
      modelRef: { keyId: 'k', modelId: 'm' },
    });

    const result = await node.run({ run: makeRun({ chapter_brief: 'brief data' }), requirement: 'test' });

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toEqual(VALID_DRAFT);
  });

  it('buildPrompt 从 run.artifacts 抽 vars', async () => {
    const generateMock = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const buildPromptSpy = vi.fn(draftWriterConfig.buildPrompt);
    const node = createLlmNode({ ...draftWriterConfig, buildPrompt: buildPromptSpy }, {
      generate: generateMock,
      modelRef: { keyId: 'k', modelId: 'm' },
    });

    await node.run({ run: makeRun({ chapter_brief: 'BRIEF', scene_graph: 'SCENE', settings_context: 'SETTINGS' }), requirement: 'test' });

    expect(buildPromptSpy).toHaveBeenCalledTimes(1);
    const vars = buildPromptSpy.mock.results[0].value as Record<string, string>;
    expect(vars.chapterTask).toBe('BRIEF');
    expect(vars.storyPlan).toBe('SCENE');
    expect(vars.projectContext).toBe('SETTINGS');
  });
});

describe('createLlmNode — yaml 契约（核心：generate 收 yaml system 非运行时默认）', () => {
  it('generate 收到的 system = yaml system 段（含 "专业的故事写作者"，不含 "You are Closure"）', async () => {
    const generateMock = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const node = createLlmNode(draftWriterConfig, { generate: generateMock });

    await node.run({ run: makeRun(), requirement: 'test' });

    expect(generateMock).toHaveBeenCalledTimes(1);
    const systemArg = generateMock.mock.calls[0][1];
    expect(systemArg).toContain('专业的故事写作者');
    expect(systemArg).not.toContain('You are Closure');
  });

  it('generate 收到的 user prompt 已渲染（含 chapterTask 值，不含字面 {{chapterTask}}）', async () => {
    const generateMock = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const node = createLlmNode(draftWriterConfig, { generate: generateMock });

    await node.run({ run: makeRun({ chapter_brief: 'TARGET_BRIEF_VALUE' }), requirement: 'test' });

    const messagesArg = generateMock.mock.calls[0][0];
    const userContent = messagesArg[0]?.content ?? '';
    expect(userContent).toContain('TARGET_BRIEF_VALUE');
    expect(userContent).not.toContain('{{chapterTask}}');
    expect(userContent).not.toContain('{{storyPlan}}');
  });

  it('generate 收到空 tools（节点不需工具，design §6 单次 generate 决断）', async () => {
    const generateMock = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const node = createLlmNode(draftWriterConfig, { generate: generateMock });

    await node.run({ run: makeRun(), requirement: 'test' });

    const toolsArg = generateMock.mock.calls[0][2];
    expect(toolsArg).toEqual([]);
  });

  it('generate 收到 modelRef（deps 透传）', async () => {
    const generateMock = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const node = createLlmNode(draftWriterConfig, {
      generate: generateMock,
      modelRef: { keyId: 'key_x', modelId: 'model_y' },
    });

    await node.run({ run: makeRun(), requirement: 'test' });

    const optsArg = generateMock.mock.calls[0][4];
    expect(optsArg?.modelRef).toEqual({ keyId: 'key_x', modelId: 'model_y' });
  });
});

describe('createLlmNode — parse 失败重试 + 兜底 error artifact', () => {
  it('首次 JSON parse 失败 → 重试一次（再 generate）→ 第二次成功 → 返回 artifact', async () => {
    const generateMock = vi.fn<GenerateFn>();
    generateMock
      .mockResolvedValueOnce({ content: 'NOT VALID JSON {{{', finishReason: 'stop' })
      .mockResolvedValueOnce(makeOkResult(VALID_DRAFT));
    const node = createLlmNode(draftWriterConfig, { generate: generateMock });

    const result = await node.run({ run: makeRun(), requirement: 'test' });

    expect(generateMock).toHaveBeenCalledTimes(2); // 初试 + 重试一次
    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toEqual(VALID_DRAFT);
  });

  it('Zod 校验失败也触发重试', async () => {
    // 缺 text 字段 → Zod parse 抛 → 重试
    const generateMock = vi.fn<GenerateFn>();
    generateMock
      .mockResolvedValueOnce({ content: JSON.stringify({ title: 't', wordCount: 1 }), finishReason: 'stop' })
      .mockResolvedValueOnce(makeOkResult(VALID_DRAFT));
    const node = createLlmNode(draftWriterConfig, { generate: generateMock });

    const result = await node.run({ run: makeRun(), requirement: 'test' });

    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(result.artifact).toEqual(VALID_DRAFT);
  });

  it('两次都失败 → 兜底 error artifact（{stateKey, artifact:{error}} 不抛）', async () => {
    const generateMock = vi.fn<GenerateFn>();
    generateMock
      .mockResolvedValueOnce({ content: 'bad json 1', finishReason: 'stop' })
      .mockResolvedValueOnce({ content: 'bad json 2', finishReason: 'stop' });
    const node = createLlmNode(draftWriterConfig, { generate: generateMock });

    const result = await node.run({ run: makeRun(), requirement: 'test' });

    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(result.stateKey).toBe('draft-writer-agent'); // 兜底用 nodeId
    const artifact = result.artifact as { error: boolean; nodeId: string; message: string };
    expect(artifact.error).toBe(true);
    expect(artifact.nodeId).toBe('draft-writer-agent');
    expect(artifact.message).toContain('failed after 2 attempts');
  });

  it('generate 自身抛非 abort 错（如网络）→ 重试一次 → 兜底 error artifact', async () => {
    const generateMock = vi.fn<GenerateFn>();
    generateMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'));
    const node = createLlmNode(draftWriterConfig, { generate: generateMock });

    const result = await node.run({ run: makeRun(), requirement: 'test' });

    expect(generateMock).toHaveBeenCalledTimes(2);
    const artifact = result.artifact as { error: boolean; message: string };
    expect(artifact.error).toBe(true);
    expect(artifact.message).toContain('network down');
  });
});

describe('createLlmNode — abort 传播', () => {
  it('AbortError 重抛（不重试、不吞成 error artifact）', async () => {
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    const generateMock = vi.fn<GenerateFn>(async () => { throw abortErr; });
    const node = createLlmNode(draftWriterConfig, { generate: generateMock });

    await expect(node.run({ run: makeRun(), requirement: 'test' })).rejects.toThrow('Aborted');
    expect(generateMock).toHaveBeenCalledTimes(1); // 不重试
  });
});

describe('createLlmNode — contract 透传', () => {
  it('返回的 AgentNode.contract = config.contract（含 null）', () => {
    const generateMock = vi.fn<GenerateFn>(async () => makeOkResult(VALID_DRAFT));
    const node = createLlmNode(draftWriterConfig, { generate: generateMock });
    expect(node.contract).toBeNull();
  });
});
