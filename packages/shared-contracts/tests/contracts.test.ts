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
  modelDefaultsSchema,
  pricingSchema,
  KEY_TIMEOUT_SECONDS_RANGE,
  MODEL_DEFAULT_RANGES,
  MODEL_PRICING_RANGE,
  taskModelSlotSchema,
  slotAssignmentSchema,
  generateTextPayloadSchema,
  generationMessageSchema,
  modelConfigSchema,
  modelConfigSaveSchema,
  researchConfigSaveSchema,
  wikiSiteOverrideSchema,
  resolveModelInfo,
  resolveModelInfoWithDefaults,
  DEFAULT_USER_PREFERENCES,
  USAGE_RETENTION_DAYS_DEFAULT,
  clampUsageRetentionDays,
  estimateUsageCost,
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

  // 09-12 agy provider：sessionKey（zod 单源第一跳——IPC parse 面据此放行）。
  it('text generation request: sessionKey optional; empty string normalizes to absent (CR-13 two-state)', () => {
    const without = textGenerationRequestSchema.safeParse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(without.success).toBe(true);
    expect(without.success === true && without.data.sessionKey).toBeUndefined();

    const withKey = textGenerationRequestSchema.safeParse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      sessionKey: 'chain:abc-123',
    });
    expect(withKey.success === true && withKey.data.sessionKey).toBe('chain:abc-123');

    // CR-13（09-12 agy provider CR 批）：'' 归一为缺席（两态纪律——与 lane/thinking 的
    // absent 语义一致；装配点漏守卫传 '' 不再被 min(1) 硬拒整请求），非空 = 会话键。
    const emptyKey = textGenerationRequestSchema.safeParse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      sessionKey: '',
    });
    expect(emptyKey.success).toBe(true);
    expect(emptyKey.success === true && emptyKey.data.sessionKey).toBeUndefined();
  });

  // 09-12 agy provider：usage additive（thinkingTokens/cacheReadTokens——agy 事件流
  // 首个生产者；防 zod strip 静默丢字段）。
  it('text generation response: usage keeps thinkingTokens/cacheReadTokens', () => {
    const parsed = textGenerationResponseSchema.parse({
      model: 'gemini-3.8-pro-high',
      text: 'hello',
      usage: {
        promptTokens: 3236,
        completionTokens: 812,
        totalTokens: 4048,
        thinkingTokens: 512,
        cacheReadTokens: 49043,
      },
    });
    expect(parsed.usage?.thinkingTokens).toBe(512);
    expect(parsed.usage?.cacheReadTokens).toBe(49043);

    // 无新字段的 usage 原样解析（additive 零回归）。
    const legacy = textGenerationResponseSchema.parse({
      model: 'gpt-4o',
      text: 'hi',
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    expect(legacy.usage?.thinkingTokens).toBeUndefined();
    expect(legacy.usage?.cacheReadTokens).toBeUndefined();
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

  // ── 09-12 agy provider：第三协议形态（antigravity-cli）契约面 ──

  it('parses an antigravity-cli ApiKeyEntry (cliExecutable, no HTTP credentials)', () => {
    const entry = apiKeyEntrySchema.parse({
      id: 'agy-key',
      name: 'Antigravity CLI',
      protocol: 'antigravity-cli',
      cliExecutable: 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe',
      models: [
        { id: 'gemini-3.8-pro-high', capability: 'text', alias: 'Gemini 3.8 Pro (high)', enabled: true },
      ],
    });
    expect(entry.protocol).toBe('antigravity-cli');
    expect(entry.cliExecutable).toContain('agy.exe');
    expect(entry.baseUrl).toBeUndefined();
    expect(entry.apiKey).toBeUndefined();
  });

  it('rejects CLI keys missing cliExecutable (strict face)', () => {
    const result = apiKeyEntrySchema.safeParse({
      id: 'agy-key',
      name: 'Antigravity CLI',
      protocol: 'antigravity-cli',
      models: [{ id: 'gemini-3.8-pro-high', capability: 'text', alias: 'g', enabled: true }],
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues.some((i) => i.path[0] === 'cliExecutable')).toBe(true);
  });

  it('rejects CLI keys carrying baseUrl or apiKey (strict face)', () => {
    const withBaseUrl = apiKeyEntrySchema.safeParse({
      id: 'agy-key',
      name: 'Antigravity CLI',
      protocol: 'antigravity-cli',
      cliExecutable: 'agy',
      baseUrl: 'https://example.com',
      models: [],
    });
    expect(withBaseUrl.success).toBe(false);

    const withApiKey = apiKeyEntrySchema.safeParse({
      id: 'agy-key',
      name: 'Antigravity CLI',
      protocol: 'antigravity-cli',
      cliExecutable: 'agy',
      apiKey: 'sk-should-not-be-here',
      models: [],
    });
    expect(withApiKey.success).toBe(false);
  });

  it('rejects HTTP keys missing apiKey or with an empty apiKey (strict face)', () => {
    const noKey = apiKeyEntrySchema.safeParse({
      id: 'http-key',
      name: 'Relay',
      protocol: 'openai-compatible',
      baseUrl: 'https://relay.example.com',
      models: [],
    });
    expect(noKey.success).toBe(false);

    const emptyKey = apiKeyEntrySchema.safeParse({
      id: 'http-key',
      name: 'Relay',
      protocol: 'openai-compatible',
      baseUrl: 'https://relay.example.com',
      apiKey: '',
      models: [],
    });
    expect(emptyKey.success).toBe(false);
  });

  // CR-14（09-12 agy provider CR 批）：反向互斥——HTTP 键带 cliExecutable 即报错
  //（盘上手编坏配置不被静默接受后丢弃判别载荷；strict/save 两面同判）。
  it('rejects HTTP keys carrying cliExecutable (reverse mutual exclusion, CR-14)', () => {
    const strict = apiKeyEntrySchema.safeParse({
      id: 'http-key',
      name: 'Relay',
      protocol: 'openai-compatible',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-test',
      cliExecutable: 'agy',
      models: [],
    });
    expect(strict.success).toBe(false);
    expect(strict.success === false && strict.error.issues.some((i) => i.path[0] === 'cliExecutable')).toBe(true);

    const saved = modelConfigSaveSchema.safeParse({
      keys: [
        {
          id: 'http-key',
          name: 'Relay',
          protocol: 'anthropic-compatible',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant',
          cliExecutable: 'agy',
          models: [],
        },
      ],
    });
    expect(saved.success).toBe(false);
  });

  it('save face: CLI key tolerates the renderer apiKey sentinel, still enforces the form', () => {
    // CLI key saved by the renderer: apiKey redacted to '' (hidden field) — parses.
    const cliSaved = modelConfigSaveSchema.safeParse({
      keys: [
        {
          id: 'agy-key',
          name: 'Antigravity CLI',
          protocol: 'antigravity-cli',
          cliExecutable: 'agy',
          apiKey: '',
          models: [{ id: 'gemini-3.8-pro-high', capability: 'text', alias: 'g', enabled: true }],
        },
      ],
    });
    expect(cliSaved.success).toBe(true);

    // CLI key still cannot carry a baseUrl on the save face.
    const cliWithBaseUrl = modelConfigSaveSchema.safeParse({
      keys: [
        {
          id: 'agy-key',
          name: 'Antigravity CLI',
          protocol: 'antigravity-cli',
          cliExecutable: 'agy',
          apiKey: '',
          baseUrl: 'https://example.com',
          models: [],
        },
      ],
    });
    expect(cliWithBaseUrl.success).toBe(false);

    // CLI key missing cliExecutable fails on the save face too (both persistence
    // parse faces run the mutual exclusion — never just one).
    const cliNoExe = modelConfigSaveSchema.safeParse({
      keys: [
        { id: 'agy-key', name: 'Antigravity CLI', protocol: 'antigravity-cli', apiKey: '', models: [] },
      ],
    });
    expect(cliNoExe.success).toBe(false);

    // HTTP key keeps requiring baseUrl + apiKey ('' = keep-existing sentinel).
    const httpSaved = modelConfigSaveSchema.safeParse({
      keys: [
        {
          id: 'http-key',
          name: 'Relay',
          protocol: 'openai-compatible',
          baseUrl: 'https://relay.example.com',
          apiKey: '',
          models: [],
        },
      ],
    });
    expect(httpSaved.success).toBe(true);

    const httpNoBaseUrl = modelConfigSaveSchema.safeParse({
      keys: [
        { id: 'http-key', name: 'Relay', protocol: 'openai-compatible', apiKey: 'sk', models: [] },
      ],
    });
    expect(httpNoBaseUrl.success).toBe(false);
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

  it('accepts every enum member as a key (ten slots total — 09-13 R1b fine review slots included)', () => {
    const all: Record<string, { keyId: string; modelId: string }> = {};
    for (const slot of taskModelSlotSchema.options) all[slot] = { keyId: 'k1', modelId: 'm' };
    expect(taskModelSlotSchema.options).toHaveLength(10);
    // R1b 审核族细档（enum-member additive：旧六值 sidecar 解析零变化）。
    expect(taskModelSlotSchema.options).toEqual(
      expect.arrayContaining(['plan-review', 'multi-review', 'route-judge', 'revision-guard']),
    );
    expect(modelConfigSchema.parse({ ...base, taskModels: all }).taskModels).toEqual(all);
  });

  it('parses the R1b fine review slots on both faces (config + save sidecars)', () => {
    const fine = {
      'plan-review': { keyId: 'k1', modelId: 'plan-model' },
      'multi-review': { keyId: 'k1', modelId: 'readthrough-model' },
      'route-judge': { keyId: 'k1', modelId: 'verdict-model' },
      'revision-guard': { keyId: 'k1', modelId: 'guard-model' },
    };
    expect(modelConfigSchema.parse({ ...base, taskModels: fine }).taskModels).toEqual(fine);
    expect(modelConfigSaveSchema.parse({ ...base, taskModels: fine }).taskModels).toEqual(fine);
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

// ── 09-12 子2：任务模型回退链契约（slot fallbacks + wire 载荷/响应注记）──

describe('slot fallback chains (09-12 task-model fallback)', () => {
  const base = {
    keys: [{
      id: 'k1',
      name: 'Relay',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk',
      models: [{ id: 'qwen-max', capability: 'text', alias: 'Qwen Max', enabled: true }],
    }],
  };

  it('旧形态解析不变：ref-only / policy 指派不出现 fallbacks 字段（零迁移硬回归）', () => {
    const legacy = {
      dialogue: { keyId: 'k1', modelId: 'qwen-max', thinking: 'high' as const },
      'writer-draft': { keyId: 'k1', modelId: 'glm-5.3', thinkingCustom: '8192' },
    };
    const parsed = modelConfigSchema.parse({ ...base, taskModels: legacy }).taskModels!;
    expect(parsed).toEqual(legacy);
    expect(parsed.dialogue!.fallbacks).toBeUndefined();
    expect(modelConfigSaveSchema.parse({ ...base, taskModels: legacy }).taskModels).toEqual(legacy);
  });

  it('parses an ordered chain with per-entry policies; both schemas round-trip it', () => {
    const withChain = {
      'writer-draft': {
        keyId: 'k1',
        modelId: 'glm-5.3',
        thinking: 'high' as const,
        fallbacks: [
          { keyId: 'k2', modelId: 'claude-opus-5' }, // ref-only entry (zero migration shape)
          { keyId: 'k1', modelId: 'qwen-max', thinking: 'low' as const, thinkingCustom: '8192' },
        ],
      },
    };
    expect(modelConfigSchema.parse({ ...base, taskModels: withChain }).taskModels).toEqual(withChain);
    expect(modelConfigSaveSchema.parse({ ...base, taskModels: withChain }).taskModels).toEqual(withChain);
  });

  it('REJECTS an empty fallbacks array — two-state contract, [] belongs to neither state', () => {
    const emptyChain = { dialogue: { keyId: 'k1', modelId: 'm', fallbacks: [] } };
    expect(modelConfigSchema.safeParse({ ...base, taskModels: emptyChain }).success).toBe(false);
    expect(modelConfigSaveSchema.safeParse({ ...base, taskModels: emptyChain }).success).toBe(false);
    // The two LEGAL states: absent (no chain) and ≥1 entries.
    expect(modelConfigSchema.safeParse({
      ...base,
      taskModels: { dialogue: { keyId: 'k1', modelId: 'm' } },
    }).success).toBe(true);
    expect(modelConfigSchema.safeParse({
      ...base,
      taskModels: { dialogue: { keyId: 'k1', modelId: 'm', fallbacks: [{ keyId: 'k2', modelId: 'b' }] } },
    }).success).toBe(true);
  });

  it('rejects a malformed fallback entry (missing modelId) loudly', () => {
    expect(modelConfigSchema.safeParse({
      ...base,
      taskModels: { dialogue: { keyId: 'k1', modelId: 'm', fallbacks: [{ keyId: 'k2' }] } },
    }).success).toBe(false);
  });

  it('entries are NON-recursive: a nested fallbacks key on an entry is stripped (zod default)', () => {
    const parsed = slotAssignmentSchema.parse({
      keyId: 'k1',
      modelId: 'm',
      fallbacks: [{ keyId: 'k2', modelId: 'b', fallbacks: [{ keyId: 'k3', modelId: 'c' }] }],
    });
    expect(parsed.fallbacks).toEqual([{ keyId: 'k2', modelId: 'b' }]);
  });

  it('wire payload: fallback entries carry the normalized thinking; [] rejected; absent unchanged', () => {
    const request = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    const parsed = generateTextPayloadSchema.parse({
      ref: { keyId: 'k1', modelId: 'm' },
      request,
      fallbacks: [
        { ref: { keyId: 'k2', modelId: 'b' } },
        { ref: { keyId: 'k3', modelId: 'c' }, thinking: { level: 'low' } },
      ],
    });
    expect(parsed.fallbacks).toEqual([
      { ref: { keyId: 'k2', modelId: 'b' } },
      { ref: { keyId: 'k3', modelId: 'c' }, thinking: { level: 'low' } },
    ]);
    // Absent → undefined: the single-model fast-path payload parses unchanged.
    expect(
      generateTextPayloadSchema.parse({ ref: { keyId: 'k1', modelId: 'm' }, request }).fallbacks,
    ).toBeUndefined();
    // Empty [] rejected (two-state, same as the slot face).
    expect(generateTextPayloadSchema.safeParse({
      ref: { keyId: 'k1', modelId: 'm' },
      request,
      fallbacks: [],
    }).success).toBe(false);
  });

  it('response annotations: modelRef/fallbackTrace additive — absent unchanged, present round-trips, [] trace rejected', () => {
    const plain = { model: 'm', text: 'ok' };
    expect(textGenerationResponseSchema.parse(plain).modelRef).toBeUndefined();
    expect(textGenerationResponseSchema.parse(plain).fallbackTrace).toBeUndefined();
    const annotated = textGenerationResponseSchema.parse({
      ...plain,
      modelRef: { keyId: 'k2', modelId: 'b' },
      fallbackTrace: [{ keyId: 'k1', modelId: 'm', reason: 'quota: HTTP 429: rate limited' }],
    });
    expect(annotated.modelRef).toEqual({ keyId: 'k2', modelId: 'b' });
    expect(annotated.fallbackTrace).toEqual([
      { keyId: 'k1', modelId: 'm', reason: 'quota: HTTP 429: rate limited' },
    ]);
    expect(textGenerationResponseSchema.safeParse({ ...plain, fallbackTrace: [] }).success).toBe(false);
  });
});

// ── 09-12 子3：HTTP provider 调用参数面（per-key 传输面 + per-model 语义面）──

describe('HTTP provider params face (09-12 子3)', () => {
  const legacyEntry = {
    id: 'k1',
    name: 'Relay',
    protocol: 'openai-compatible' as const,
    baseUrl: 'https://relay.example.com',
    apiKey: 'sk',
    models: [
      { id: 'gpt-4o', capability: 'text' as const, alias: 'GPT-4o', enabled: true },
      { id: 'dall-e-3', capability: 'image' as const, alias: 'DALL·E', enabled: false },
    ],
  };
  const httpKeyBase = {
    id: 'k2',
    name: 'Gateway',
    protocol: 'openai-compatible' as const,
    baseUrl: 'https://gw.example.com',
    apiKey: 'sk-gw',
    models: [{ id: 'some-unknown-model', capability: 'text' as const, alias: 'Unknown', enabled: true }],
  };
  const cliKeyBase = {
    id: 'agy',
    name: 'Antigravity CLI',
    protocol: 'antigravity-cli' as const,
    cliExecutable: 'agy',
    models: [{ id: 'gemini-3.8-pro-high', capability: 'text' as const, alias: 'g', enabled: true }],
  };

  // ── 零迁移硬回归：旧配置（无新字段）解析逐字节不变 ──

  it('旧形态解析不变：entry/model 级新字段全部保持 ABSENT（零迁移硬回归）', () => {
    const parsed = apiKeyEntrySchema.parse(legacyEntry);
    // toEqual on the FULL parsed shape: no materialized defaults for any new field.
    expect(parsed).toEqual(legacyEntry);
    expect('customHeaders' in parsed).toBe(false);
    expect('timeoutSeconds' in parsed).toBe(false);
    expect('streamingDisabled' in parsed).toBe(false);
    expect('verifySsl' in parsed).toBe(false);
    expect('defaults' in parsed.models[0]!).toBe(false);
    expect('extraBody' in parsed.models[0]!).toBe(false);
    expect('pricing' in parsed.models[0]!).toBe(false);
    expect(modelConfigSaveSchema.parse({ keys: [legacyEntry] })).toEqual({ keys: [legacyEntry] });
  });

  // ── customHeaders 名域 + blocklist ──

  it('customHeaders: 合法 header 名可解析；带点/带空格拒收（flat-YAML dotted-key 歧义防线）', () => {
    const ok = apiKeyEntrySchema.parse({
      ...httpKeyBase,
      customHeaders: { 'HTTP-Referer': 'https://closure.dev', 'X-Api-Token': 'tok', 'x-route-pool': 'b' },
    });
    expect(ok.customHeaders).toEqual({ 'HTTP-Referer': 'https://closure.dev', 'X-Api-Token': 'tok', 'x-route-pool': 'b' });

    const withDot = apiKeyEntrySchema.safeParse({ ...httpKeyBase, customHeaders: { 'X.Bad': 'v' } });
    expect(withDot.success).toBe(false);
    const withSpace = apiKeyEntrySchema.safeParse({ ...httpKeyBase, customHeaders: { 'X Bad': 'v' } });
    expect(withSpace.success).toBe(false);
  });

  // ── CR-17：name charset 补 RFC 合法 `_` + value 面（控制字符/长度）──

  it('CR-17: header 名含下划线可解析（RFC 7230 token 合法字符），双面', () => {
    for (const name of ['X_Tenant', 'x-custom_route', 'A0-_']) {
      const strict = apiKeyEntrySchema.safeParse({ ...httpKeyBase, customHeaders: { [name]: 'v' } });
      expect(strict.success, `strict face must accept ${name}`).toBe(true);
      const save = modelConfigSaveSchema.safeParse({
        keys: [{ ...httpKeyBase, apiKey: '', customHeaders: { [name]: 'v' } }],
      });
      expect(save.success, `save face must accept ${name}`).toBe(true);
    }
  });

  it('CR-17: header 值含 CR/LF/控制字符拒收（Headers.set 请求时才炸 → save 期拦），双面', () => {
    for (const value of ['a\rb', 'a\nb', 'a\r\nb', 'a\u0000b', 'a\u0007b', 'a\u001Fb', 'a\u007Fb']) {
      const strict = apiKeyEntrySchema.safeParse({ ...httpKeyBase, customHeaders: { 'X-Route': value } });
      expect(strict.success, `strict face must reject ${JSON.stringify(value)}`).toBe(false);
      if (strict.success === false) {
        expect(strict.error.issues.some((i) => i.path.join('.').startsWith('customHeaders.X-Route'))).toBe(true);
      }
      const save = modelConfigSaveSchema.safeParse({
        keys: [{ ...httpKeyBase, apiKey: '', customHeaders: { 'X-Route': value } }],
      });
      expect(save.success, `save face must reject ${JSON.stringify(value)}`).toBe(false);
    }
    // 正常值（含非 ASCII、空格、长 token）放行。
    expect(apiKeyEntrySchema.safeParse({
      ...httpKeyBase,
      customHeaders: { 'X-Note': 'plan 台账 · v2', 'Authorization': 'Bearer sk-gw-1234567890' },
    }).success).toBe(true);
  });

  it('CR-17: header 值长度上限 8192——超长拒收、边界过', () => {
    expect(apiKeyEntrySchema.safeParse({
      ...httpKeyBase,
      customHeaders: { 'X-Big': 'x'.repeat(8192) },
    }).success).toBe(true);
    expect(apiKeyEntrySchema.safeParse({
      ...httpKeyBase,
      customHeaders: { 'X-Big': 'x'.repeat(8193) },
    }).success).toBe(false);
  });

  it('wire 序列化语义头（content-type/content-length/accept/host）blocklist 拒收——大小写不敏感，双面（entry+save）', () => {
    for (const name of ['content-type', 'Content-Length', 'ACCEPT', 'host']) {
      const strict = apiKeyEntrySchema.safeParse({ ...httpKeyBase, customHeaders: { [name]: 'v' } });
      expect(strict.success, `strict face must reject ${name}`).toBe(false);
      if (strict.success === false) {
        expect(strict.error.issues.some((i) => i.path.join('.') === `customHeaders.${name}`)).toBe(true);
      }
      const save = modelConfigSaveSchema.safeParse({
        keys: [{ ...httpKeyBase, apiKey: '', customHeaders: { [name]: 'v' } }],
      });
      expect(save.success, `save face must reject ${name}`).toBe(false);
    }
    // 非 blocklist 头（含同名内建鉴权头 = 网关替代鉴权语义）放行。
    expect(apiKeyEntrySchema.safeParse({
      ...httpKeyBase,
      customHeaders: { authorization: 'Bearer gateway-token' },
    }).success).toBe(true);
  });

  // ── timeoutSeconds / streamingDisabled / verifySsl 形态 ──

  it('传输面字段数值域：timeoutSeconds 正整数；0/负数/小数拒收；两布尔任意态可解析', () => {
    const withAll = apiKeyEntrySchema.parse({
      ...httpKeyBase,
      timeoutSeconds: 120,
      streamingDisabled: true,
      verifySsl: true,
    });
    expect(withAll.timeoutSeconds).toBe(120);
    expect(withAll.streamingDisabled).toBe(true);
    expect(withAll.verifySsl).toBe(true);
    for (const bad of [0, -5, 1.5]) {
      expect(apiKeyEntrySchema.safeParse({ ...httpKeyBase, timeoutSeconds: bad }).success).toBe(false);
    }
  });

  it('CR-7: timeoutSeconds 上界 = KEY_TIMEOUT_SECONDS_RANGE.max（86400）——超界拒收（数日级 abort 窗不是特性）', () => {
    expect(apiKeyEntrySchema.safeParse({
      ...httpKeyBase,
      timeoutSeconds: KEY_TIMEOUT_SECONDS_RANGE.max,
    }).success).toBe(true);
    expect(apiKeyEntrySchema.safeParse({
      ...httpKeyBase,
      timeoutSeconds: KEY_TIMEOUT_SECONDS_RANGE.max + 1,
    }).success).toBe(false);
    expect(apiKeyEntrySchema.safeParse({ ...httpKeyBase, timeoutSeconds: 9_999_999 }).success).toBe(false);
  });

  it('CR-7: 域常量单源与 schema 边界一致（MODEL_DEFAULT_RANGES / MODEL_PRICING_RANGE——防常量与 zod 域漂移）', () => {
    expect(MODEL_DEFAULT_RANGES.temperature).toEqual({ min: 0, max: 2, integer: false });
    expect(MODEL_DEFAULT_RANGES.topP).toEqual({ min: 0, max: 1, integer: false });
    expect(MODEL_DEFAULT_RANGES.frequencyPenalty).toEqual({ min: -2, max: 2, integer: false });
    expect(MODEL_DEFAULT_RANGES.presencePenalty).toEqual({ min: -2, max: 2, integer: false });
    expect(MODEL_DEFAULT_RANGES.contextWindow).toEqual({ min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });
    expect(MODEL_DEFAULT_RANGES.maxOutputTokens).toEqual({ min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });
    expect(MODEL_PRICING_RANGE.min).toBe(0);
    // 越上界一档必须拒（常量与 schema 是同一真相源的两侧）。
    expect(modelDefaultsSchema.safeParse({ temperature: MODEL_DEFAULT_RANGES.temperature.max + 0.1 }).success).toBe(false);
    expect(pricingSchema.safeParse({ inputPerMillion: MODEL_PRICING_RANGE.min - 0.1 }).success).toBe(false);
  });

  // ── defaults 语义面 ──

  it('defaults 空对象拒收（二态契约：ABSENT=无默认 / ≥1 键=有默认）', () => {
    expect(modelDefaultsSchema.safeParse({}).success).toBe(false);
    expect(discoveredModelSchema.safeParse({ ...httpKeyBase.models[0]!, defaults: {} }).success).toBe(false);
    expect(modelDefaultsSchema.safeParse({ temperature: 1 }).success).toBe(true);
  });

  it('采样族数值域：temperature 0-2 / topP 0-1 / 双 penalty -2..2——边界过、越界拒', () => {
    expect(modelDefaultsSchema.parse({ temperature: 0 }).temperature).toBe(0);
    expect(modelDefaultsSchema.parse({ temperature: 2 }).temperature).toBe(2);
    expect(modelDefaultsSchema.safeParse({ temperature: 2.1 }).success).toBe(false);
    expect(modelDefaultsSchema.safeParse({ temperature: -0.1 }).success).toBe(false);
    expect(modelDefaultsSchema.parse({ topP: 0 }).topP).toBe(0);
    expect(modelDefaultsSchema.parse({ topP: 1 }).topP).toBe(1);
    expect(modelDefaultsSchema.safeParse({ topP: 1.1 }).success).toBe(false);
    expect(modelDefaultsSchema.parse({ frequencyPenalty: -2, presencePenalty: 2 }).presencePenalty).toBe(2);
    expect(modelDefaultsSchema.safeParse({ frequencyPenalty: -2.5 }).success).toBe(false);
    expect(modelDefaultsSchema.safeParse({ presencePenalty: 2.5 }).success).toBe(false);
    // 窗口族：正整数。
    expect(modelDefaultsSchema.parse({ contextWindow: 200_000, maxOutputTokens: 8192 }).contextWindow).toBe(200_000);
    expect(modelDefaultsSchema.safeParse({ contextWindow: 0 }).success).toBe(false);
    expect(modelDefaultsSchema.safeParse({ maxOutputTokens: 1.5 }).success).toBe(false);
  });

  it('extraBody 嵌套 JSON 可解析；undefined/函数/NaN 值拒收（jsonValue 递归域）', () => {
    const nested = { safe_prompt: true, min_p: 0.05, nested: { deep: [1, 'two', null, false] } };
    const parsed = discoveredModelSchema.parse({ ...httpKeyBase.models[0]!, extraBody: nested });
    expect(parsed.extraBody).toEqual(nested);

    expect(discoveredModelSchema.safeParse({
      ...httpKeyBase.models[0]!,
      extraBody: { ghost: undefined },
    }).success).toBe(false);
    expect(discoveredModelSchema.safeParse({
      ...httpKeyBase.models[0]!,
      extraBody: { fn: () => 1 },
    }).success).toBe(false);
    expect(discoveredModelSchema.safeParse({
      ...httpKeyBase.models[0]!,
      extraBody: { nan: Number.NaN },
    }).success).toBe(false);
    expect(discoveredModelSchema.safeParse({
      ...httpKeyBase.models[0]!,
      extraBody: { inf: Number.POSITIVE_INFINITY },
    }).success).toBe(false);
  });

  it('pricing 三价非负 finite：合法过、负价/Infinity 拒收', () => {
    const parsed = discoveredModelSchema.parse({
      ...httpKeyBase.models[0]!,
      pricing: { inputPerMillion: 0.5, outputPerMillion: 2, cachedInputPerMillion: 0.05 },
    });
    expect(parsed.pricing).toEqual({ inputPerMillion: 0.5, outputPerMillion: 2, cachedInputPerMillion: 0.05 });
    expect(discoveredModelSchema.safeParse({
      ...httpKeyBase.models[0]!,
      pricing: { inputPerMillion: -1 },
    }).success).toBe(false);
    expect(discoveredModelSchema.safeParse({
      ...httpKeyBase.models[0]!,
      pricing: { outputPerMillion: Number.POSITIVE_INFINITY },
    }).success).toBe(false);
  });

  it('新字段全量形态双面 round-trip（entry + save 镜像）', () => {
    const entry = {
      ...httpKeyBase,
      customHeaders: { 'X-Route': 'a' },
      timeoutSeconds: 90,
      streamingDisabled: true,
      verifySsl: true,
      models: [{
        ...httpKeyBase.models[0]!,
        defaults: { temperature: 0.7, topP: 0.9, frequencyPenalty: 0.1, presencePenalty: 0.2, contextWindow: 131072, maxOutputTokens: 16384 },
        extraBody: { safe_prompt: true },
        pricing: { inputPerMillion: 1, outputPerMillion: 3 },
      }],
    };
    expect(apiKeyEntrySchema.parse(entry)).toEqual(entry);
    expect(modelConfigSaveSchema.parse({ keys: [entry] })).toEqual({ keys: [entry] });
  });

  // ── CLI 键禁矩阵（refine 面）──

  it('CLI 键拒传输面：customHeaders / timeoutSeconds / streamingDisabled 禁填（strict + save 双面）', () => {
    for (const patch of [
      { customHeaders: { 'X-A': 'v' } },
      { timeoutSeconds: 60 },
      { streamingDisabled: true },
    ]) {
      expect(apiKeyEntrySchema.safeParse({ ...cliKeyBase, ...patch }).success).toBe(false);
      expect(modelConfigSaveSchema.safeParse({ keys: [{ ...cliKeyBase, apiKey: '', ...patch }] }).success).toBe(false);
    }
  });

  it('CLI 键模型级禁采样族四字段 + maxOutputTokens + extraBody；contextWindow / pricing 放行', () => {
    for (const banned of ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxOutputTokens']) {
      const result = apiKeyEntrySchema.safeParse({
        ...cliKeyBase,
        models: [{ ...cliKeyBase.models[0]!, defaults: { [banned]: 1 } }],
      });
      expect(result.success, `CLI key must reject defaults.${banned}`).toBe(false);
    }
    expect(apiKeyEntrySchema.safeParse({
      ...cliKeyBase,
      models: [{ ...cliKeyBase.models[0]!, extraBody: { x: 1 } }],
    }).success).toBe(false);

    // 放行面：contextWindow（agent 压缩红线在 CLI 调用前计算）+ pricing（纯元数据）。
    const allowed = apiKeyEntrySchema.parse({
      ...cliKeyBase,
      models: [{ ...cliKeyBase.models[0]!, defaults: { contextWindow: 1_048_576 }, pricing: { inputPerMillion: 0 } }],
    });
    expect(allowed.models[0].defaults?.contextWindow).toBe(1_048_576);
    expect(allowed.models[0].pricing?.inputPerMillion).toBe(0);
  });

  it('CLI 键 verifySsl 不禁（无意义但无害，不消费）', () => {
    expect(apiKeyEntrySchema.safeParse({ ...cliKeyBase, verifySsl: true }).success).toBe(true);
  });

  it('CLI 键同样受 blocklist 头禁改约束（不分协议）', () => {
    // customHeaders 本身在 CLI 键上已禁——blocklist 先于协议分支命中时也要报 issue
    //（两道闸叠加，报错面只增不减）。
    const result = apiKeyEntrySchema.safeParse({
      ...cliKeyBase,
      customHeaders: { 'content-type': 'text/plain' },
    });
    expect(result.success).toBe(false);
  });

  // ── SlotAssignment.contextWindowTokens（runtime-only 派生字段）──

  it('slotAssignment: contextWindowTokens 与 fallbacks 共存可解析；旧形态无此字段照常', () => {
    const enriched = {
      keyId: 'k1',
      modelId: 'm',
      contextWindowTokens: 131072,
      fallbacks: [{ keyId: 'k2', modelId: 'b' }],
    };
    expect(slotAssignmentSchema.parse(enriched)).toEqual(enriched);
    expect(modelConfigSchema.parse({
      keys: [httpKeyBase],
      taskModels: { dialogue: enriched },
    }).taskModels).toEqual({ dialogue: enriched });
    // 旧形态（ref-only）不变。
    expect(slotAssignmentSchema.parse({ keyId: 'k1', modelId: 'm' }).contextWindowTokens).toBeUndefined();
    // 非正整数拒收。
    expect(slotAssignmentSchema.safeParse({ keyId: 'k1', modelId: 'm', contextWindowTokens: 0 }).success).toBe(false);
  });

  // ── resolveModelInfoWithDefaults：limits 逐字段合成 ──

  it('resolveModelInfoWithDefaults：无 defaults = 原样（limits ABSENT 语义保持）', () => {
    const known = resolveModelInfoWithDefaults('gpt-4o');
    expect(known).toEqual(resolveModelInfo('gpt-4o'));
    const unknown = resolveModelInfoWithDefaults('totally-unknown-model');
    expect(unknown.limits).toBeUndefined();
  });

  it('resolveModelInfoWithDefaults：逐字段覆盖——只填 contextWindow 时 registry maxOutputTokens 保留', () => {
    const merged = resolveModelInfoWithDefaults('gpt-5-mini', { contextWindow: 99_999 });
    expect(merged.limits).toEqual({ contextWindow: 99_999, maxOutputTokens: 128_000 }); // registry: 400K/128K
    const both = resolveModelInfoWithDefaults('gpt-5-mini', { contextWindow: 1, maxOutputTokens: 2 });
    expect(both.limits).toEqual({ contextWindow: 1, maxOutputTokens: 2 });
  });

  it('resolveModelInfoWithDefaults：registry 无 limits 的未知模型 + 单字段 = 单键 limits（显式覆盖形态）', () => {
    const single = resolveModelInfoWithDefaults('totally-unknown-model', { contextWindow: 65_536 });
    expect(single.limits).toEqual({ contextWindow: 65_536 });
    const capOnly = resolveModelInfoWithDefaults('totally-unknown-model', { maxOutputTokens: 4_096 });
    expect(capOnly.limits).toEqual({ maxOutputTokens: 4_096 });
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

// ── 09-12 usage-panel W1：taskType additive + retention 偏好 + ¥ 估算纯函数 ──

describe('taskType additive on generation request (09-12 usage-panel)', () => {
  const baseRequest = {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
  };

  it('旧载荷（无 taskType）解析不变，字段 ABSENT', () => {
    const parsed = textGenerationRequestSchema.parse(baseRequest);
    expect('taskType' in parsed ? parsed.taskType : undefined).toBeUndefined();
  });

  it('新字段通过并直通', () => {
    const parsed = textGenerationRequestSchema.parse({ ...baseRequest, taskType: 'writer-draft' });
    expect(parsed.taskType).toBe('writer-draft');
  });

  it("'' 归一为 ABSENT（CR-13 两态纪律——手拼 body 漏空串不被拒）", () => {
    const parsed = textGenerationRequestSchema.parse({ ...baseRequest, taskType: '' });
    expect(parsed.taskType).toBeUndefined();
  });

  it('经 generateTextPayloadSchema 全载荷同样放行（网关 IPC parse 面）', () => {
    const parsed = generateTextPayloadSchema.parse({
      ref: { keyId: 'k1', modelId: 'm1' },
      request: { ...baseRequest, taskType: 'decon', sessionKey: 'chain:1:writer' },
    });
    expect(parsed.request.taskType).toBe('decon');
    expect(parsed.request.sessionKey).toBe('chain:1:writer');
  });
});

// ── 09-12 system stabilization C 批（W_c1）：cacheControl additive（zod 单源第一跳
// ——IPC parse 面据此放行；payload 经 generateTextPayloadSchema 在 shell 侧 zod
// parse，默认 strip 未知键——不进 schema 的字段会被静默剥掉，穿透断言钉死这一点）。──

describe('cacheControl additive on generation request (09-12 system stabilization C batch)', () => {
  const baseRequest = {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
  };

  it('旧载荷（无 cacheControl）解析不变，字段 ABSENT', () => {
    const parsed = textGenerationRequestSchema.parse(baseRequest);
    expect('cacheControl' in parsed).toBe(false);
  });

  it('true / false 均直通（false = 显式关，协议层与缺省同 wire 形态）', () => {
    expect(textGenerationRequestSchema.parse({ ...baseRequest, cacheControl: true }).cacheControl).toBe(true);
    expect(textGenerationRequestSchema.parse({ ...baseRequest, cacheControl: false }).cacheControl).toBe(false);
  });

  it('非 boolean 被拒（IPC 边界守门——字符串/数字不入协议层）', () => {
    expect(textGenerationRequestSchema.safeParse({ ...baseRequest, cacheControl: 'true' }).success).toBe(false);
    expect(textGenerationRequestSchema.safeParse({ ...baseRequest, cacheControl: 1 }).success).toBe(false);
  });

  it('经 generateTextPayloadSchema 全载荷穿透（JSON 往返后存活——agent seam → shell 网关透传链前提）', () => {
    const payload = {
      ref: { keyId: 'k1', modelId: 'm1' },
      request: { ...baseRequest, cacheControl: true, sessionKey: 'dialogue:s1' },
    };
    const parsed = generateTextPayloadSchema.parse(JSON.parse(JSON.stringify(payload)));
    expect(parsed.request.cacheControl).toBe(true);
  });
});

describe('usage retention preference key (09-12 usage-panel)', () => {
  it('默认 90（DEFAULT 单源，缺键旧 preferences.yaml 读侧合并归位）', () => {
    expect(USAGE_RETENTION_DAYS_DEFAULT).toBe(90);
    expect(DEFAULT_USER_PREFERENCES.usageRetentionDays).toBe(90);
  });

  it('clamp：非数/缺失 → 默认；带外钳到最近边界', () => {
    expect(clampUsageRetentionDays(undefined)).toBe(90);
    expect(clampUsageRetentionDays('x' as unknown)).toBe(90);
    expect(clampUsageRetentionDays(Number.NaN)).toBe(90);
    expect(clampUsageRetentionDays(1)).toBe(7);
    expect(clampUsageRetentionDays(99999)).toBe(730);
    expect(clampUsageRetentionDays(30)).toBe(30);
    expect(clampUsageRetentionDays(730)).toBe(730);
  });
});

describe('estimateUsageCost（¥ 估算纯函数，design §3 计价式）', () => {
  const fullPricing = { inputPerMillion: 1, outputPerMillion: 3, cachedInputPerMillion: 0.1 };

  it('基础计价：input×input价 + output×output价，÷1M', () => {
    expect(estimateUsageCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, fullPricing)).toBe(4);
  });

  it('thinking 无专门价按 output 价折算；cache_read 无专门价回退 input 价', () => {
    // thinking 1M × 3 + cache_read 1M × 0.1（有专门价）= 3.1
    expect(estimateUsageCost({ thinkingTokens: 1_000_000, cacheReadTokens: 1_000_000 }, fullPricing)).toBeCloseTo(3.1, 10);
    // 无专门价：cache_read 1M × input价 2 = 2
    expect(estimateUsageCost({ cacheReadTokens: 1_000_000 }, { inputPerMillion: 2 })).toBe(2);
  });

  it('无单价 → undefined（不硬造 0，UI 隐藏金额）', () => {
    expect(estimateUsageCost({ inputTokens: 5, outputTokens: 5 }, {})).toBeUndefined();
    expect(estimateUsageCost({ inputTokens: 5 }, undefined)).toBeUndefined();
  });

  it('缺席/NULL tokens 分量不计（贡献 0 非拒绝）；有价即有值（可为 0）', () => {
    // 只有 output 价、行组只有 input tokens → 0（有价即有值）
    expect(estimateUsageCost({ inputTokens: 100 }, { outputPerMillion: 3 })).toBe(0);
    // tokens 全缺席但有价 → 0
    expect(estimateUsageCost({}, fullPricing)).toBe(0);
  });
});
