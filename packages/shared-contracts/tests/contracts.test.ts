import { describe, expect, it } from 'vitest';
import {
  projectDocumentSchema,
  projectCreateRequestSchema,
  projectCreateResponseSchema,
  taskRequestSchema,
  taskResultSchema,
  taskListItemSchema,
  taskListQuerySchema,
  taskListResponseSchema,
  projectAssetListItemSchema,
  projectAssetListQuerySchema,
  projectAssetListResponseSchema,
  taskDetailResponseSchema,
  textGenerationRequestSchema,
  textGenerationResponseSchema,
  imageGenerationRequestSchema,
  thinkingControlSchema,
  apiKeyEntrySchema,
  discoveredModelSchema,
  taskModelSlotSchema,
  generationMessageSchema,
  modelConfigSchema,
  modelConfigSaveSchema,
  researchConfigSaveSchema,
  wikiSiteOverrideSchema,
  resolveModelInfo,
} from '../src';
import { desktopIpcSchema } from '../src';
import type { ResolveInboxAttachmentResult, StoreAttachmentDescriptionInput } from '../src';

describe('shared contracts', () => {
  it('accepts a simplified task request and result pair', () => {
    const taskRequest = {
      projectId: '00001',
      targetId: 'act_1',
      assetIds: ['char_001', 'loc_002'],
      type: 'outline.rewrite',
      name: '重写第一幕冲突',
      description: '强化主角和对手第一次正面冲突',
      input: '这里是提交给任务处理的文本内容'
    };

    const taskResult = {
      taskId: '20260427214530123_48321',
      status: 'completed',
      outputType: 'patch',
      outputPayload: {
        operations: [
          {
            op: 'replace',
            path: 'outline.acts[0].summary',
            value: 'A detective arrives in a rain-soaked city full of dread.'
          }
        ]
      },
      summary: 'Darkened the opening beat.',
      rationale: 'Added noir tone and tension.',
      reviewHint: 'Check whether the tone is too bleak for the intended audience.',
      retryable: true
    };

    expect(() => taskRequestSchema.parse(taskRequest)).not.toThrow();
    expect(() => taskResultSchema.parse(taskResult)).not.toThrow();
  });

  it('accepts project create request and response payloads', () => {
    const request = {
      name: 'Cold City',
      type: 'novel',
      localFingerprint: 'local_project_cold_city'
    };

    const response = {
      projectId: '00001',
      name: 'Cold City',
      type: 'novel'
    };

    expect(() => projectCreateRequestSchema.parse(request)).not.toThrow();
    expect(() => projectCreateResponseSchema.parse(response)).not.toThrow();
  });

  it('accepts the minimal local project document shape', () => {
    const now = new Date().toISOString();
    const parsed = projectDocumentSchema.parse({
      meta: {
        id: 'project_1',
        name: 'Orison Demo',
        type: 'novel',
        version: 1,
        created_at: now,
        updated_at: now
      },
      storyboard: {
        shots: []
      }
    });

    expect(parsed.meta.name).toBe('Orison Demo');
  });

  it('parses task list pagination query with defaults and bounds', () => {
    const defaults = taskListQuerySchema.parse({});
    expect(defaults).toEqual({ limit: 50, sort: 'createdDesc' });
    const explicit = taskListQuerySchema.parse({ limit: '25', cursor: 'abc', sort: 'createdAsc' });
    expect(explicit).toEqual({ limit: 25, cursor: 'abc', sort: 'createdAsc' });
    expect(() => taskListQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => taskListQuerySchema.parse({ limit: 201 })).toThrow();
  });

  it('parses task list response with assetIds and nullable nextCursor', () => {
    const parsed = taskListResponseSchema.parse({
      items: [
        {
          taskId: 'task_1',
          projectId: '00001',
          type: 'outline.rewrite',
          name: 'Item',
          description: 'desc',
          status: 'queued',
          createdAt: '2026-05-05T01:00:00.000Z'
        }
      ],
      nextCursor: null
    });
    expect(parsed.items[0].assetIds).toEqual([]);
    expect(parsed.nextCursor).toBeNull();
    expect(taskListItemSchema.shape.targetId.isOptional()).toBe(true);
  });

  it('parses project asset list query and response shapes', () => {
    const defaults = projectAssetListQuerySchema.parse({});
    expect(defaults).toEqual({ limit: 50, sort: 'updatedDesc' });
    const parsed = projectAssetListResponseSchema.parse({
      items: [
        {
          assetId: 'asset_1',
          projectId: '00001',
          assetType: 'unknown',
          assetName: 'Asset',
          assetStatus: 'active',
          version: 1,
          updatedAt: '2026-05-05T01:00:00.000Z'
        }
      ],
      nextCursor: 'next-cursor'
    });
    expect(parsed.nextCursor).toBe('next-cursor');
    expect(projectAssetListItemSchema.shape.summary.isOptional()).toBe(true);
  });

  it('parses task detail response with task metadata and result', () => {
    const parsed = taskDetailResponseSchema.parse({
      task: {
        taskId: 'task_1',
        projectId: '00001',
        type: 'outline.rewrite',
        name: 'Detail',
        description: 'desc',
        status: 'completed',
        createdAt: '2026-05-05T01:00:00.000Z',
        assetIds: ['char_001']
      },
      result: {
        taskId: 'task_1',
        status: 'completed',
        summary: 'done',
        rationale: 'because',
        reviewHint: 'lgtm',
        retryable: true
      }
    });

    expect(parsed.task.assetIds).toEqual(['char_001']);
    expect(parsed.result?.status).toBe('completed');
    expect(taskDetailResponseSchema.parse({
      task: {
        taskId: 'task_2',
        projectId: '00001',
        type: 'outline.rewrite',
        name: 'Detail',
        description: 'desc',
        status: 'queued',
        createdAt: '2026-05-05T01:00:00.000Z',
        assetIds: []
      },
      result: null
    }).result).toBeNull();
  });
});

describe('model config v3 schemas', () => {
  it('parses text generation request', () => {
    const text = textGenerationRequestSchema.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(text.model).toBe('gpt-4o');
  });

  it('parses image generation request', () => {
    const image = imageGenerationRequestSchema.parse({
      model: 'dall-e-3',
      prompt: 'a city at dusk',
    });
    expect(image.model).toBe('dall-e-3');
  });

  it('parses text generation response', () => {
    const parsed = textGenerationResponseSchema.parse({
      model: 'gpt-4o',
      text: 'hello',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
    });
    expect(parsed.usage?.totalTokens).toBe(30);
    expect(parsed.finishReason).toBe('stop');
  });

  it('parses image generation request with image/mask', () => {
    const parsed = imageGenerationRequestSchema.parse({
      model: 'gpt-image-1',
      prompt: 'replace the sofa',
      image: { b64Json: 'YWJj', mimeType: 'image/png' },
      mask: { b64Json: 'ZGVm', mimeType: 'image/png' },
    });
    expect(parsed.image).toBeDefined();
    expect(parsed.mask).toBeDefined();
  });

  it('parses ApiKeyEntry with discovered models', () => {
    const entry = apiKeyEntrySchema.parse({
      id: 'key-1',
      name: 'My OpenAI',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-xxx',
      models: [
        { id: 'gpt-4o', capability: 'text', alias: 'GPT-4o', enabled: true },
        { id: 'dall-e-3', capability: 'image', alias: 'DALL·E', enabled: false },
      ],
    });
    expect(entry.protocol).toBe('openai-compatible');
    expect(entry.models).toHaveLength(2);
    expect(entry.models[0].enabled).toBe(true);
  });

  it('defaults old ApiKeyEntry data to OpenAI-compatible protocol', () => {
    const entry = apiKeyEntrySchema.parse({
      id: 'legacy-key',
      name: 'Legacy Relay',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-legacy',
      models: [
        { id: 'gpt-4o', capability: 'text', alias: 'GPT-4o', enabled: true },
      ],
    });
    expect(entry.protocol).toBe('openai-compatible');
  });

  it('accepts Anthropic-compatible ApiKeyEntry', () => {
    const entry = apiKeyEntrySchema.parse({
      id: 'anthropic-key',
      name: 'Anthropic',
      protocol: 'anthropic-compatible',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant',
      models: [
        { id: 'claude-3-5-sonnet-latest', capability: 'text', alias: 'Claude Sonnet', enabled: true },
      ],
    });
    expect(entry.protocol).toBe('anthropic-compatible');
  });

  it('parses ModelConfig with multiple keys', () => {
    const config = modelConfigSchema.parse({
      keys: [
        {
          id: 'k1',
          name: 'OpenAI',
          baseUrl: 'https://api.openai.com',
          apiKey: 'sk',
          models: [{ id: 'gpt-4o', capability: 'text', alias: 'GPT-4o', enabled: true }],
        },
      ],
    });
    expect(config.keys[0].models[0].id).toBe('gpt-4o');
  });

  it('parses DiscoveredModel', () => {
    const model = discoveredModelSchema.parse({
      id: 'gpt-4o',
      capability: 'text',
      alias: 'GPT-4o',
      enabled: true,
    });
    expect(model.capability).toBe('text');
  });

  it('resolveModelInfo matches known patterns', () => {
    expect(resolveModelInfo('dall-e-3').capability).toBe('image');
    expect(resolveModelInfo('dall-e-3').alias).toBe('DALL·E 3');
    expect(resolveModelInfo('gpt-4o-mini').capability).toBe('text');
    expect(resolveModelInfo('sora-1.0').capability).toBe('video');
    expect(resolveModelInfo('unknown-model-xyz').capability).toBe('text');
    expect(resolveModelInfo('unknown-model-xyz').alias).toBe('unknown-model-xyz');
  });

  it('resolveModelInfo tags embedding-model families as embedding (VS1 KB indexing)', () => {
    expect(resolveModelInfo('text-embedding-3-small').capability).toBe('embedding');
    expect(resolveModelInfo('bge-m3').capability).toBe('embedding');
    expect(resolveModelInfo('m3e-base').capability).toBe('embedding');
    // Broad *embed* catch: nomic-embed / jina-embed / cohere embed-english-v3
    expect(resolveModelInfo('nomic-embed-text-v1.5').capability).toBe('embedding');
    expect(resolveModelInfo('jina-embeddings-v3').capability).toBe('embedding');
    // Multilingual E5 + GTE
    expect(resolveModelInfo('multilingual-e5-large-instruct').capability).toBe('embedding');
    expect(resolveModelInfo('gte-Qwen2-7B-instruct').capability).toBe('embedding');
    // Voyage
    expect(resolveModelInfo('voyage-3-large').capability).toBe('embedding');
    // A text model stays text (sanity: embedding patterns don't over-match LLMs)
    expect(resolveModelInfo('claude-3-5-sonnet-latest').capability).toBe('text');
  });

  // dogfood 2026-08-21（#41）：聚合供应商 id 的 alias 截断 + org 前缀能力误判。
  it('resolveModelInfo: org-qualified ids use the basename alias and correct capability', () => {
    // 旧 buildAlias 对 *embed* 盲剥尾部 5 字符 → alias 实录 "Embedding Qwen/Qwen3-Embedd"。
    expect(resolveModelInfo('Qwen/Qwen3-Embedding-8B')).toEqual({
      capability: 'embedding',
      alias: 'Qwen3-Embedding-8B',
    });
    // 前缀锚定模式对整串不命中（Pro/BAAI/bge-m3 非 bge-* 开头）→ basename 二轮匹配修 capability。
    expect(resolveModelInfo('Pro/BAAI/bge-m3')).toEqual({ capability: 'embedding', alias: 'bge-m3' });
    expect(resolveModelInfo('Pro/BAAI/bge-reranker-v2-m3')).toEqual({
      capability: 'rerank',
      alias: 'bge-reranker-v2-m3',
    });
    // reranker 家族（中间星 *rerank* 对整串即命中）。
    expect(resolveModelInfo('Qwen/Qwen3-Reranker-8B')).toEqual({
      capability: 'rerank',
      alias: 'Qwen3-Reranker-8B',
    });
    // deepseek-ai/… 不再把 org 段漏进 alias（旧实录 "DeepSeek ai/DeepSeek-V4-Pro"）。
    // Thinking adapters task：basename 二轮匹配同样携带 kind/limits。
    expect(resolveModelInfo('deepseek-ai/DeepSeek-V4-Pro')).toEqual({
      capability: 'text',
      alias: 'DeepSeek-V4-Pro',
      thinking: 'deepseek-v4',
      limits: { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
    });
    // 未知家族的 org-qualified id：basename 做 alias，text 兜底。
    expect(resolveModelInfo('nex-agi/Nex-N2-Pro')).toEqual({ capability: 'text', alias: 'Nex-N2-Pro' });
  });

  it('resolveModelInfo: 中缀星模式的尾巴原样保留，不盲剥（双星 *embed* 的 suffix 含星不锚定）', () => {
    // *embed* 前后都是星 → suffix 段是 'embed*'（含星），从不锚定在 id 尾部。
    // 旧逻辑盲剥 |suffix|=6 字符：nomic-embed → "Embedding nomic"（丢 embed）、
    // Qwen/Qwen3-Embedding-8B → "Embedding Qwen/Qwen3-Embedd"（单词中间截断，盘上实录）。
    // 新逻辑：suffix 不匹配尾部 → 尾巴原样保留，不截断。
    expect(resolveModelInfo('nomic-embed').alias).toBe('Embedding nomic-embed');
    expect(resolveModelInfo('nomic-embed-text-v1.5').alias).toBe('Embedding nomic-embed-text-v1.5');
  });
});

// ── Story 3.6 vision seam (R9/D2): user-message parts, additive union ──
describe('generation message vision seam (Story 3.6)', () => {
  it('parses a plain string user message unchanged (zero-migration regression)', () => {
    const parsed = generationMessageSchema.parse({ role: 'user', content: 'hi' });
    expect(parsed).toEqual({ role: 'user', content: 'hi' });
  });

  it('parses a user message with text+image parts', () => {
    const parsed = generationMessageSchema.parse({
      role: 'user',
      content: [
        { type: 'text', text: '这张图里是什么？' },
        { type: 'image', image: { b64Json: 'YWJj', mimeType: 'image/png' } },
      ],
    });
    expect(parsed.role).toBe('user');
    if (!Array.isArray(parsed.content)) throw new Error('expected parts array');
    expect(parsed.content).toHaveLength(2);
    expect(parsed.content[0]).toEqual({ type: 'text', text: '这张图里是什么？' });
    expect(parsed.content[1]).toEqual({
      type: 'image',
      image: { b64Json: 'YWJj', mimeType: 'image/png' },
    });
  });

  it('rejects parts content on non-user roles (only user messages allow parts)', () => {
    const parts = [{ type: 'text', text: 'x' }];
    expect(() => generationMessageSchema.parse({ role: 'system', content: parts })).toThrow();
    expect(() => generationMessageSchema.parse({ role: 'assistant', content: parts })).toThrow();
    expect(() => generationMessageSchema.parse({ role: 'tool', toolCallId: 't1', content: parts })).toThrow();
  });

  it('rejects unknown part types and malformed image parts', () => {
    expect(() => generationMessageSchema.parse({
      role: 'user',
      content: [{ type: 'video', video: { b64Json: 'x', mimeType: 'video/mp4' } }],
    })).toThrow();
    // image part must carry a non-empty b64Json + mimeType (imageInputSchema)
    expect(() => generationMessageSchema.parse({
      role: 'user',
      content: [{ type: 'image', image: { b64Json: '', mimeType: 'image/png' } }],
    })).toThrow();
    expect(() => generationMessageSchema.parse({
      role: 'user',
      content: [{ type: 'text' }],
    })).toThrow();
  });

  it('P15: an EMPTY parts array is rejected (an empty array is not a message)', () => {
    expect(() => generationMessageSchema.parse({ role: 'user', content: [] })).toThrow();
  });

  it('P15: an EMPTY text part is rejected (empty text would survive to the wire)', () => {
    expect(() => generationMessageSchema.parse({
      role: 'user',
      content: [
        { type: 'text', text: '' },
        { type: 'image', image: { b64Json: 'YWJj', mimeType: 'image/png' } },
      ],
    })).toThrow();
    // image-only parts (no text) remain legal — a bare image is a message.
    expect(generationMessageSchema.safeParse({
      role: 'user',
      content: [{ type: 'image', image: { b64Json: 'YWJj', mimeType: 'image/png' } }],
    }).success).toBe(true);
  });

  it('parses ModelConfig with an optional visionModel (additive, R9b)', () => {
    const base = {
      keys: [{
        id: 'k1',
        name: 'Relay',
        baseUrl: 'https://relay.example.com',
        apiKey: 'sk',
        models: [{ id: 'qwen-vl-max', capability: 'text', alias: 'Qwen VL', enabled: true }],
      }],
    };
    // Absent → parses unchanged (existing configs are untouched)
    expect(modelConfigSchema.parse(base).visionModel).toBeUndefined();
    // Present → round-trips the ref
    const withVision = modelConfigSchema.parse({
      ...base,
      visionModel: { keyId: 'k1', modelId: 'qwen-vl-max' },
    });
    expect(withVision.visionModel).toEqual({ keyId: 'k1', modelId: 'qwen-vl-max' });
    // Save-side variant accepts it too (renderer save path)
    expect(modelConfigSaveSchema.parse({
      ...base,
      visionModel: { keyId: 'k1', modelId: 'qwen-vl-max' },
    }).visionModel).toEqual({ keyId: 'k1', modelId: 'qwen-vl-max' });
  });
});

// ── C3.2 task model routing: taskModels record keyed by the slot enum ──

describe('task model routing slots (C3.2)', () => {
  const base = {
    keys: [{
      id: 'k1',
      name: 'Relay',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk',
      models: [{ id: 'qwen-max', capability: 'text', alias: 'Qwen Max', enabled: true }],
    }],
  };
  const slots = {
    'writer-selfcheck': { keyId: 'k1', modelId: 'light-model' },
    'writer-draft': { keyId: 'k1', modelId: 'heavy-model' },
    'review-judge': { keyId: 'k1', modelId: 'judge-model' },
  };

  it('absent taskModels parses unchanged (zero migration)', () => {
    expect(modelConfigSchema.parse(base).taskModels).toBeUndefined();
  });

  it('parses a multi-slot record and round-trips each ref', () => {
    expect(modelConfigSchema.parse({ ...base, taskModels: slots }).taskModels).toEqual(slots);
  });

  it('parses an empty record (user cleared every slot)', () => {
    expect(modelConfigSchema.parse({ ...base, taskModels: {} }).taskModels).toEqual({});
  });

  it('accepts every enum member as a key (six slots total)', () => {
    const all: Record<string, { keyId: string; modelId: string }> = {};
    for (const slot of taskModelSlotSchema.options) all[slot] = { keyId: 'k1', modelId: 'm' };
    expect(taskModelSlotSchema.options).toHaveLength(6);
    expect(modelConfigSchema.parse({ ...base, taskModels: all }).taskModels).toEqual(all);
  });

  it('REJECTS an unknown slot key — loud failure, not a silent strip', () => {
    // zod record+enum rejects unrecognized keys (invalid_enum_value). A strip
    // would let the renderer believe a slot was saved while the write path
    // dropped it — exactly the silent-footgun family this feature removes.
    const result = modelConfigSchema.safeParse({
      ...base,
      taskModels: { 'multi-reader': { keyId: 'k1', modelId: 'm' } },
    });
    expect(result.success).toBe(false);
    const saveSide = modelConfigSaveSchema.safeParse({
      ...base,
      taskModels: { 'reverse-outline': { keyId: 'k1', modelId: 'm' } },
    });
    expect(saveSide.success).toBe(false);
  });

  it('rejects a malformed ref value (missing modelId)', () => {
    const result = modelConfigSchema.safeParse({
      ...base,
      taskModels: { dialogue: { keyId: 'k1' } },
    });
    expect(result.success).toBe(false);
  });

  it('save schema accepts the same record shape (read/write parity)', () => {
    expect(modelConfigSaveSchema.parse({ ...base, taskModels: slots }).taskModels).toEqual(slots);
    expect(modelConfigSaveSchema.parse(base).taskModels).toBeUndefined();
  });

  // ── Thinking adapters task: slot assignments carry a thinking policy ──

  it('slot assignments carry an optional thinking policy (additive, both schemas)', () => {
    const withPolicy = {
      'writer-draft': { keyId: 'k1', modelId: 'glm-5.3', thinking: 'high' },
      'review-judge': { keyId: 'k1', modelId: 'claude-opus-4-5', thinkingCustom: '2048' }, // custom rides its own field
      'dispatch': { keyId: 'k1', modelId: 'kimi-k3' }, // ref-only value still parses (zero migration)
    };
    expect(modelConfigSchema.parse({ ...base, taskModels: withPolicy }).taskModels).toEqual(withPolicy);
    expect(modelConfigSaveSchema.parse({ ...base, taskModels: withPolicy }).taskModels).toEqual(withPolicy);
  });

  it('rejects a thinking level outside the slot vocabulary — custom goes via thinkingCustom', () => {
    // 'xhigh' is a valid VENDOR tier on some models but not a slot-enum member;
    // it must ride the thinkingCustom string (validated at send time), not the enum.
    const result = modelConfigSchema.safeParse({
      ...base,
      taskModels: { dispatch: { keyId: 'k1', modelId: 'glm-5.2', thinking: 'xhigh' } },
    });
    expect(result.success).toBe(false);
    // Empty custom string is rejected (min(1) — an empty string is not a tier).
    const emptyCustom = modelConfigSaveSchema.safeParse({
      ...base,
      taskModels: { dispatch: { keyId: 'k1', modelId: 'glm-5.2', thinkingCustom: '' } },
    });
    expect(emptyCustom.success).toBe(false);
  });
});

// ── Thinking adapters task (2026-08-25): request-side thinking controls ──

describe('thinking control schema (thinking adapters task)', () => {
  it('parses fixed-level controls; custom requires a value (superRefine)', () => {
    expect(thinkingControlSchema.parse({ level: 'high' })).toEqual({ level: 'high' });
    expect(thinkingControlSchema.parse({ level: 'auto' }).level).toBe('auto');
    expect(thinkingControlSchema.safeParse({ level: 'custom' }).success).toBe(false);
    expect(thinkingControlSchema.parse({ level: 'custom', custom: 'xhigh' }).custom).toBe('xhigh');
    // Empty string is not a custom value (min(1)).
    expect(thinkingControlSchema.safeParse({ level: 'custom', custom: '' }).success).toBe(false);
  });

  it('request schema accepts thinking additively; absent stays undefined (zero migration)', () => {
    const withThinking = textGenerationRequestSchema.parse({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { level: 'medium' },
    });
    expect(withThinking.thinking?.level).toBe('medium');
    const without = textGenerationRequestSchema.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(without.thinking).toBeUndefined();
  });

  it('response schema accepts reasoningSignature (Anthropic thinking-block signature)', () => {
    const res = textGenerationResponseSchema.parse({
      model: 'claude-opus-5',
      text: 'ok',
      reasoningSignature: 'sig-abc',
    });
    expect(res.reasoningSignature).toBe('sig-abc');
    // Absent → undefined (non-Anthropic providers never populate it).
    expect(
      textGenerationResponseSchema.parse({ model: 'glm-5.3', text: 'ok' }).reasoningSignature,
    ).toBeUndefined();
  });
});

describe('model registry thinking kinds + limits (thinking adapters task)', () => {
  it('GLM version patterns split into distinct kinds with official limits', () => {
    expect(resolveModelInfo('glm-5.3')).toMatchObject({
      capability: 'text',
      thinking: 'glm-forced-effort',
      limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
    });
    expect(resolveModelInfo('glm-5.3').alias).toBe('GLM 5.3'); // alias unchanged vs the old generic pattern
    expect(resolveModelInfo('glm-5.2').thinking).toBe('glm-dynamic-effort');
    expect(resolveModelInfo('glm-5.2').limits).toEqual({ contextWindow: 1_048_576, maxOutputTokens: 131_072 });
    expect(resolveModelInfo('glm-5.1')).toMatchObject({
      thinking: 'glm-dynamic-basic',
      limits: { contextWindow: 204_800, maxOutputTokens: 131_072 },
    });
    expect(resolveModelInfo('glm-4.7')).toMatchObject({
      thinking: 'glm-forced-basic',
      limits: { contextWindow: 204_800, maxOutputTokens: 131_072 },
    });
    expect(resolveModelInfo('glm-4.6').thinking).toBe('glm-dynamic-basic');
    expect(resolveModelInfo('GLM-4.5V').thinking).toBe('glm-forced-basic'); // glob is case-insensitive
    // 5-Turbo has kind but no limits (window not in the research C table).
    expect(resolveModelInfo('glm-5-turbo').thinking).toBe('glm-dynamic-basic');
    expect(resolveModelInfo('glm-5-turbo').limits).toBeUndefined();
    // Older 4.x falls to the generic glm-* fallback: kind yes, limits no.
    expect(resolveModelInfo('glm-4.5-flash').thinking).toBe('glm-dynamic-basic');
    expect(resolveModelInfo('glm-4.5-flash').limits).toBeUndefined();
  });

  it('kimi kinds + limits (k3 output ceiling = 1,048,576; k2 uses the documented default)', () => {
    expect(resolveModelInfo('kimi-k3')).toMatchObject({
      capability: 'text',
      thinking: 'kimi-k3',
      limits: { contextWindow: 1_048_576, maxOutputTokens: 1_048_576 },
    });
    expect(resolveModelInfo('kimi-k2.6')).toMatchObject({
      thinking: 'kimi-k2',
      limits: { contextWindow: 262_144, maxOutputTokens: 32_768 },
    });
    // CR-009: k2.7 split into its own forced kind (disabled errors at the
    // vendor — the offLegal=true kimi-k2 profile offered an illegal「关」).
    expect(resolveModelInfo('kimi-k2.7').thinking).toBe('kimi-k27-forced');
    expect(resolveModelInfo('kimi-k2.7-code').thinking).toBe('kimi-k27-forced');
    expect(resolveModelInfo('kimi-k2.7-code-highspeed').thinking).toBe('kimi-k27-forced');
    expect(resolveModelInfo('kimi-k2.7-code').limits).toEqual({ contextWindow: 262_144, maxOutputTokens: 32_768 });
  });

  it('deepseek family pattern carries kind + limits', () => {
    expect(resolveModelInfo('deepseek-v4-pro')).toMatchObject({
      capability: 'text',
      thinking: 'deepseek-v4',
      limits: { contextWindow: 1_048_576, maxOutputTokens: 393_216 },
    });
    expect(resolveModelInfo('deepseek-v4-flash').thinking).toBe('deepseek-v4');
  });

  it('claude generation split: forced / 5 / budget / 4x fallback', () => {
    expect(resolveModelInfo('claude-fable-5')).toMatchObject({
      thinking: 'claude-forced',
      limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
    });
    expect(resolveModelInfo('claude-mythos-5').thinking).toBe('claude-forced');
    expect(resolveModelInfo('claude-opus-5').thinking).toBe('claude-5');
    expect(resolveModelInfo('claude-sonnet-5-20xx').thinking).toBe('claude-5');
    expect(resolveModelInfo('claude-opus-4-8')).toMatchObject({
      thinking: 'claude-4x',
      limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
    });
    expect(resolveModelInfo('claude-opus-4-7-20xx').thinking).toBe('claude-4x');
    expect(resolveModelInfo('claude-opus-4-5').thinking).toBe('claude-budget');
    expect(resolveModelInfo('claude-sonnet-4-5').thinking).toBe('claude-budget');
    expect(resolveModelInfo('claude-haiku-4-5').thinking).toBe('claude-budget');
    expect(resolveModelInfo('claude-3-7-sonnet-latest').thinking).toBe('claude-budget');
    // 4.6 (and everything unlisted) falls to the claude-4x fallback without limits.
    expect(resolveModelInfo('claude-sonnet-4-6').thinking).toBe('claude-4x');
    expect(resolveModelInfo('claude-sonnet-4-6').limits).toBeUndefined();
    // Budget generations carry no limits (output ceilings not verified in research C).
    expect(resolveModelInfo('claude-opus-4-5').limits).toBeUndefined();
  });

  it('gemini / openai-o / gpt5 kinds with limits', () => {
    expect(resolveModelInfo('gemini-3-pro')).toMatchObject({
      thinking: 'gemini',
      limits: { contextWindow: 1_048_576, maxOutputTokens: 65_536 },
    });
    expect(resolveModelInfo('gemini-2.5-flash').limits).toEqual({
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
    });
    expect(resolveModelInfo('o3')).toMatchObject({
      thinking: 'openai-o',
      limits: { contextWindow: 200_000, maxOutputTokens: 100_000 },
    });
    expect(resolveModelInfo('o4-mini').thinking).toBe('openai-o');
    expect(resolveModelInfo('o1').thinking).toBe('openai-o');
    expect(resolveModelInfo('o1').limits).toBeUndefined(); // o1 output ceiling not verified
    expect(resolveModelInfo('gpt-5.1')).toMatchObject({
      thinking: 'gpt5',
      limits: { contextWindow: 400_000, maxOutputTokens: 128_000 },
    });
    expect(resolveModelInfo('gpt-5').thinking).toBe('gpt5');
  });

  it('unknown families keep resolving without thinking/limits (guardrail fallback)', () => {
    expect(resolveModelInfo('unknown-model-xyz')).toEqual({
      capability: 'text',
      alias: 'unknown-model-xyz',
    });
    expect(resolveModelInfo('qwen-max').thinking).toBeUndefined();
    expect(resolveModelInfo('qwen-max').limits).toBeUndefined();
  });
});

// ── B1 附件（R2.4，09-01）：registry vision 标记（第三轮 registry 派生 additive）──
// 标记 = 确定性多模态（官方文档全系支持图片输入）；ABSENT ≠ 不支持，只是未验证——
// 未标家族的图片一律走 visionModel 转述安全路径，绝不盲发（design D-G 红线）。
describe('model registry vision marks (B1 agent attachments)', () => {
  it('确定性多模态家族 → vision: true', () => {
    expect(resolveModelInfo('gpt-4o').vision).toBe(true);
    expect(resolveModelInfo('gpt-4o-mini').vision).toBe(true);
    expect(resolveModelInfo('gpt-4.1').vision).toBe(true);
    expect(resolveModelInfo('o4-mini').vision).toBe(true);
    expect(resolveModelInfo('GLM-4.5V').vision).toBe(true); // glob 大小写不敏感
    expect(resolveModelInfo('gemini-2.5-flash').vision).toBe(true);
    expect(resolveModelInfo('gemini-3-pro').vision).toBe(true);
    expect(resolveModelInfo('doubao-1.5-vision-pro-32k').vision).toBe(true);
    expect(resolveModelInfo('doubao-vision-lite').vision).toBe(true);
  });

  it('qwen*vl* 新模式：Qwen 视觉语言线全系命中（置于 qwen-* 之前，specific first）', () => {
    expect(resolveModelInfo('qwen-vl-max').vision).toBe(true);
    expect(resolveModelInfo('qwen2-vl-7b-instruct').vision).toBe(true);
    expect(resolveModelInfo('qwen2.5-vl-72b-instruct').vision).toBe(true);
    expect(resolveModelInfo('qwen3-vl-plus').vision).toBe(true);
    // thinking 刻意不标（该线思考参数形态未验证 → ABSENT，协议层 param-strip 兜底）。
    expect(resolveModelInfo('qwen3-vl-plus').thinking).toBeUndefined();
    // 主线（max/plus/turbo）不受新模式波及：落 qwen-*，无 vision。
    expect(resolveModelInfo('qwen-max').vision).toBeUndefined();
    expect(resolveModelInfo('qwen-plus-latest').vision).toBeUndefined();
  });

  it('Claude 3 系起全系多模态（含 claude-* 兜底；2.x 已全面下线不可配）', () => {
    expect(resolveModelInfo('claude-opus-5').vision).toBe(true);
    expect(resolveModelInfo('claude-sonnet-4-5').vision).toBe(true);
    expect(resolveModelInfo('claude-3-7-sonnet-latest').vision).toBe(true);
    // 4.6 等未单列版本落 claude-* 兜底 → 同样携带 vision。
    expect(resolveModelInfo('claude-sonnet-4-6').vision).toBe(true);
  });

  it('未标家族 → vision 键 ABSENT（≠不支持；走 visionModel 转述安全路径）', () => {
    // 整形断言（toEqual）钉 ABSENT 语义而非 undefined 值。
    expect(resolveModelInfo('qwen-max')).toEqual({ capability: 'text', alias: 'Qwen max' });
    // OpenAI 家族内混纯文本变体（codex / *-preview / *-mini / 老 4 系）→ 保守不标。
    expect(resolveModelInfo('gpt-5.1').vision).toBeUndefined();
    expect(resolveModelInfo('o1').vision).toBeUndefined();
    expect(resolveModelInfo('o3-mini').vision).toBeUndefined();
    expect(resolveModelInfo('gpt-4-turbo').vision).toBeUndefined();
    // GLM/Kimi/DeepSeek 主线识图能力未验证 → 不标。
    expect(resolveModelInfo('glm-5.3').vision).toBeUndefined();
    expect(resolveModelInfo('kimi-k3').vision).toBeUndefined();
    expect(resolveModelInfo('deepseek-v4-pro').vision).toBeUndefined();
    // 未知家族零 vision（与既有 thinking/limits 兜底行为一致）。
    expect(resolveModelInfo('unknown-model-xyz').vision).toBeUndefined();
  });

  it('basename 二轮匹配同样携带 vision（聚合供应商 org 前缀 id）', () => {
    // qwen*vl* 对整串 org 前缀 id 即命中（中缀星模式）→ alias 取 basename。
    expect(resolveModelInfo('Qwen/Qwen3-VL-8B')).toMatchObject({
      capability: 'text',
      vision: true,
    });
    expect(resolveModelInfo('Qwen/Qwen3-VL-8B').alias).toBe('Qwen3-VL-8B');
    // 前缀锚定模式（glm-4.5v*）对整串不命中 → basename 二轮命中 → vision 与 thinking 同时携带。
    expect(resolveModelInfo('Pro/GLM/glm-4.5v')).toMatchObject({
      capability: 'text',
      thinking: 'glm-forced-basic',
      vision: true,
    });
  });
});

// ── A 波 09-01 CR patch：inbox 附件 IPC 契约（CR-010 notes / CR-013 capturedMtime）──
describe('inbox attachment IPC contracts (09-01 A-wave, CR-010/CR-013)', () => {
  it('三通道均在 desktopIpcSchema channel 枚举内（preload/securitySurface 白名单的契约面）', () => {
    expect(desktopIpcSchema.safeParse({ channel: 'project:parse-inbox-doc' }).success).toBe(true);
    expect(desktopIpcSchema.safeParse({ channel: 'project:resolve-inbox-attachment' }).success).toBe(true);
    expect(desktopIpcSchema.safeParse({ channel: 'project:store-attachment-description' }).success).toBe(true);
    expect(desktopIpcSchema.safeParse({ channel: 'project:not-a-channel' }).success).toBe(false);
  });

  it('ResolveInboxAttachmentResult.notes / StoreAttachmentDescriptionInput.capturedMtime 形态锁（编译期）', () => {
    // 纯类型契约运行时无表示——编译期赋值锁 additive 字段就位（typecheck 门生效）：
    // notes 供 preview 被编码抑制时 UI 说明原因（CR-010）；capturedMtime 供 store 侧
    // TOCTOU 守卫比对（CR-013）。
    const resolveOk: ResolveInboxAttachmentResult = {
      ok: true,
      contentHash: 'sha256:fixture',
      mtime: 1_725_000_000_000,
      preview: '',
      derivedPath: 'inbox/大纲.md',
      reused: false,
      notes: ['疑似非 UTF-8 编码——建议先转存为 UTF-8 后重新解析。'],
    };
    const storeInput: StoreAttachmentDescriptionInput = {
      projectPath: 'C:/proj',
      filePath: 'inbox/大纲.md',
      description: '二战背景的群像大纲',
      capturedMtime: 1_725_000_000_000,
    };
    expect(resolveOk.ok).toBe(true);
    expect(resolveOk.notes).toHaveLength(1);
    expect(storeInput.capturedMtime).toBe(1_725_000_000_000);
  });
});

// ── Story 3.6 CR (2026-08-15): research save-schema key sentinel + wiki .url() ──

describe('research config save schema (CR P6/P10)', () => {
  const baseSave = {
    net: { proxyMode: 'system' as const },
    search: {
      searxngLocalhostProbe: true,
    },
    docParser: {},
  };

  it('P6: search keys accept the THREE-state sentinel — string | null | absent', () => {
    expect(researchConfigSaveSchema.safeParse(baseSave).success).toBe(true);
    expect(researchConfigSaveSchema.safeParse({
      ...baseSave,
      search: { ...baseSave.search, tavilyApiKey: 'tvly-x' },
    }).success).toBe(true);
    // null = explicit CLEAR — the whole point of P6.
    expect(researchConfigSaveSchema.safeParse({
      ...baseSave,
      search: { ...baseSave.search, tavilyApiKey: null, bochaApiKey: null },
    }).success).toBe(true);
    // '' = keep-existing (redact sentinel) still accepted.
    expect(researchConfigSaveSchema.safeParse({
      ...baseSave,
      search: { ...baseSave.search, tavilyApiKey: '' },
    }).success).toBe(true);
    // Non-string garbage stays rejected.
    expect(researchConfigSaveSchema.safeParse({
      ...baseSave,
      search: { ...baseSave.search, tavilyApiKey: 42 },
    }).success).toBe(false);
  });

  it('P10: wikiSiteOverrideSchema rejects a malformed apiBaseUrl at the boundary', () => {
    const good = { id: 'prts', name: 'PRTS', apiBaseUrl: 'https://prts.wiki', searchKind: 'fulltext' as const };
    expect(wikiSiteOverrideSchema.parse(good).apiBaseUrl).toBe('https://prts.wiki');
    // `.url()` = parseability only — `ftp://` parses, so scheme enforcement
    // stays with the runtime SSRF guard (assertPublicHttpUrl blocks non-http).
    for (const bad of ['not a url', '', 'https://', '://missing-scheme']) {
      expect(wikiSiteOverrideSchema.safeParse({ ...good, apiBaseUrl: bad }).success).toBe(false);
    }
  });
});
