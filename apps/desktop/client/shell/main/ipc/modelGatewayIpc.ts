import { ipcMain } from 'electron';
import type {
  GenerateEmbeddingPayload,
  GenerateImagePayload,
  GenerateTextPayload,
  EmbeddingResponse,
  ImageGenerationResponse,
  GenerationLane,
  ModelConfig,
  ModelRef,
  ResolvedModel,
  RerankPayload,
  RerankResponse,
  TextGenerationResponse,
} from '@orison/shared-contracts';
import {
  generateTextPayloadSchema,
  generateImagePayloadSchema,
  generateEmbeddingPayloadSchema,
  generationLaneSchema,
  rerankPayloadSchema,
} from '@orison/shared-contracts';
import {
  generateText,
  generateTextStream,
  generateImage,
  generateEmbeddings,
  rerank,
  ProtocolTimeoutError,
} from '@orison/model-protocols';
import type { GenerationDelta } from '@orison/model-protocols';
import { readModelConfigFromDisk } from './configIpc';
import { resolveModelInfo } from '@orison/shared-contracts';
import { resolveImageParts } from './agentImageParts';

/**
 * Resolve a `{keyId, modelId}` ref to a `ResolvedModel` with decrypted apiKey.
 * When keyId is 'default', uses the first available key with an enabled model.
 *
 * Accepts an optional `config` so callers that already hold a ModelConfig
 * snapshot (e.g. resolveEmbeddingModel) can resolve against it without a second
 * disk read; defaults to the on-disk config for the standard generation path.
 */
export function resolveModel(ref: ModelRef, config: ModelConfig = readModelConfigFromDisk()): ResolvedModel {
  let key = config.keys.find((k) => k.id === ref.keyId);
  let modelId = ref.modelId;

  // `default` / empty ref is the only path allowed to auto-pick: use the first
  // key that still has an enabled model. An explicit keyId must resolve as-is.
  const isDefaultRef = ref.keyId === 'default' || !ref.keyId;
  if (!key && isDefaultRef) {
    for (const k of config.keys) {
      const enabled = k.models.find((m) => m.enabled !== false);
      if (enabled) {
        key = k;
        if (modelId === 'default' || !modelId) modelId = enabled.id;
        break;
      }
    }
  }

  if (!key) {
    throw new Error(`Model ref points to unknown key '${ref.keyId}'`);
  }

  // Auto-pick mode (default ref): fall back to any enabled model in the key.
  // Explicit mode: the named model must exist AND be enabled — never silently
  // substitute or call a disabled model. Disabling a model in settings must
  // actually stop calls that reference it.
  let model = key.models.find((m) => m.id === modelId);
  if (!model && isDefaultRef) {
    model = key.models.find((m) => m.enabled !== false);
  }
  if (!model) {
    throw new Error(`Model '${modelId}' not found in key '${key.name}'`);
  }
  if (model.enabled === false) {
    throw new Error(
      `Model '${model.alias || model.id}' is disabled in key '${key.name}'. Select an enabled model.`,
    );
  }
  // 08-25 thinking adapters: attach the registry-derived capability kind and
  // official limits to the resolved model (resolveModelInfo carries both, incl.
  // the basename second-pass for aggregator-prefixed ids). Conditional spreads
  // keep the keys ABSENT for unknown models — the protocol layer's fallback
  // (guardrail cap, no thinking injection) keys off the fields' absence.
  // 09-01 附件 B1（R2.4）：vision 布尔第三轮同型 additive——true = 确定性多模态（图片
  // b64 直传）；ABSENT = 未验证（≠不支持），图片走 visionModel 转述安全路径，绝不盲发。
  const info = resolveModelInfo(model.id);
  return {
    keyId: key.id,
    modelId: model.id,
    protocol: key.protocol,
    baseUrl: key.baseUrl,
    apiKey: key.apiKey,
    capability: model.capability,
    ...(info.thinking ? { thinkingKind: info.thinking } : {}),
    ...(info.limits ? { limits: info.limits } : {}),
    ...(info.vision ? { vision: true } : {}),
  };
}

/**
 * Resolve the embedding model for KB indexing (VS1). Priority:
 *   1. explicit `config.embeddingModel` (user-named override — used even if no
 *      pattern auto-detection would match, e.g. a self-hosted model with an
 *      unusual id);
 *   2. first enabled model whose `capability === 'embedding'` (pattern
 *      auto-detect via the model registry, applied at model-discovery time);
 *   3. `null` → caller (indexer) degrades to FTS-only (pending_embed).
 *
 * NEVER throws — a stale/invalid explicit ref returns the auto candidate (or
 * `null`) so indexing degrades gracefully rather than crashing the asset write
 * path. Accepts an optional `config` param so it is unit-testable without disk
 * I/O; defaults to the on-disk ModelConfig.
 */
export function resolveEmbeddingModel(config?: ModelConfig): ResolvedModel | null {
  const cfg = config ?? readModelConfigFromDisk();

  // Path 1: explicit user-named embedding model (override). A stale/disabled
  // ref falls through to auto-detect rather than throwing.
  if (cfg.embeddingModel) {
    try {
      return resolveModel(cfg.embeddingModel, cfg);
    } catch {
      // fall through to auto-detect
    }
  }

  // Path 2: auto-detect — first enabled model whose capability === 'embedding'.
  for (const key of cfg.keys) {
    for (const m of key.models) {
      if (m.enabled !== false && m.capability === 'embedding') {
        const ref: ModelRef = { keyId: key.id, modelId: m.id };
        try {
          return resolveModel(ref, cfg);
        } catch {
          // shouldn't happen for a known-enabled model; keep scanning
        }
      }
    }
  }

  // Path 3: no embedding model available → caller degrades to FTS-only.
  return null;
}

/**
 * Resolve the summary model for index-time one-line summary generation (Story
 * 8.7 §3.1) + retrieval-time summary fallback. Mirrors `resolveEmbeddingModel`:
 * auto-detects the first enabled model whose `capability === 'text'`
 * (NO specific model is named or preferred — model choice is the user's
 * decision; this only picks whatever text model the user has enabled).
 * `null` -> caller (settingMd/craft indexer) skips summary generation
 * gracefully (columns stay empty, retrieval unaffected).
 *
 * NEVER throws - a config with no enabled text model returns `null` so the
 * indexer degrades gracefully rather than crashing the save path. Accepts an
 * optional `config` param so it is unit-testable without disk I/O.
 */
export function resolveSummaryModel(config?: ModelConfig): ResolvedModel | null {
  const cfg = config ?? readModelConfigFromDisk();

  // Auto-detect: first enabled model whose capability === 'text'.
  for (const key of cfg.keys) {
    for (const m of key.models) {
      if (m.enabled !== false && m.capability === 'text') {
        const ref: ModelRef = { keyId: key.id, modelId: m.id };
        try {
          return resolveModel(ref, cfg);
        } catch {
          // shouldn't happen for a known-enabled model; keep scanning
        }
      }
    }
  }

  // No text model available -> caller skips summary generation (graceful).
  return null;
}

/**
 * Resolve the rerank model for the KB retrieval rerank stage (Story 2.1). Mirrors
 * `resolveEmbeddingModel`. Priority:
 *   1. explicit `config.rerankModel` (user-named override);
 *   2. first enabled model whose `capability === 'rerank'` (pattern auto-detect
 *      via the model registry - `bge-reranker-*` / `jina-reranker*` / `*rerank*`);
 *   3. `null` -> caller (retrieval core) degrades to RRF top-k (no rerank stage).
 *
 * NEVER throws - a stale/invalid explicit ref returns the auto candidate (or
 * `null`) so retrieval degrades gracefully rather than crashing. Accepts an
 * optional `config` param so it is unit-testable without disk I/O.
 */
export function resolveRerankModel(config?: ModelConfig): ResolvedModel | null {
  const cfg = config ?? readModelConfigFromDisk();

  // Path 1: explicit user-named rerank model (override).
  if (cfg.rerankModel) {
    try {
      return resolveModel(cfg.rerankModel, cfg);
    } catch {
      // fall through to auto-detect
    }
  }

  // Path 2: auto-detect - first enabled model whose capability === 'rerank'.
  for (const key of cfg.keys) {
    for (const m of key.models) {
      if (m.enabled !== false && m.capability === 'rerank') {
        const ref: ModelRef = { keyId: key.id, modelId: m.id };
        try {
          return resolveModel(ref, cfg);
        } catch {
          // shouldn't happen for a known-enabled model; keep scanning
        }
      }
    }
  }

  // Path 3: no rerank model available -> caller degrades to RRF top-k.
  return null;
}

export function registerModelGatewayIpc() {
  // Validate renderer-supplied payloads at the IPC boundary. The shared
  // handleGenerate* fns below are also called by the agent with a trusted
  // shape, so validation lives here rather than in the handlers.
  ipcMain.handle('model:generate-text', async (_event, payload: GenerateTextPayload) => {
    return handleGenerateText(generateTextPayloadSchema.parse(payload));
  });
  ipcMain.handle('model:generate-image', async (_event, payload: GenerateImagePayload) => {
    return handleGenerateImage(generateImagePayloadSchema.parse(payload));
  });
  ipcMain.handle('model:generate-embedding', async (_event, payload: GenerateEmbeddingPayload) => {
    return handleGenerateEmbedding(generateEmbeddingPayloadSchema.parse(payload));
  });
  // Story 2.1: cross-encoder rerank endpoint (mirror model:generate-embedding).
  // Used by the renderer (e.g. command-bar rerank) and resolvable via an explicit
  // ModelRef. The retrieval core (searchClosure/searchCraft) calls model-protocols
  // `rerank` directly via closureRerank.defaultRerank - this IPC is the
  // renderer-facing front.
  ipcMain.handle('model:rerank', async (_event, payload: RerankPayload) => {
    return handleRerank(rerankPayloadSchema.parse(payload));
  });
}

/**
 * dogfood R2 CR-34（#50 关严）：非流式 background 车道的硬总时长上限（ms）。流式路径
 * 自己的回落已有界（model-protocols 的 BACKGROUND_FALLBACK_TOTAL_TIMEOUT_MS），但无
 * onDelta 的 background 调用走 generateText——该路径除 maxTokens 护栏外没有任何时长
 * 界，死端点上会无限挂。同额 600s 在 IPC 缝镜像；model-protocols 那侧若动，此处同步。
 */
const BACKGROUND_NONSTREAM_CEILING_MS = 600_000;

/**
 * Compose `outer` with a hard `ms` ceiling（CR-34）——model-protocols 私有
 * signalWithTimeout 的镜像。刻意用手工 controller + setTimeout（而非 AbortSignal.timeout
 * + AbortSignal.any）：测试可用 fake timers 驱动上限；timer unref 保证不挂事件循环。
 * 调用方取消原样穿透（adopt outer.reason）；上限到点以 TimeoutError DOMException 中止。
 */
function signalWithCeiling(outer: AbortSignal | undefined, ms: number): AbortSignal {
  const controller = new AbortController();
  const fire = () => {
    controller.abort(
      new DOMException('background non-streaming generation exceeded its total ceiling', 'TimeoutError'),
    );
  };
  const timer = setTimeout(fire, ms);
  (timer as { unref?: () => void }).unref?.();
  if (outer === undefined) return controller.signal;
  if (outer.aborted) {
    clearTimeout(timer);
    controller.abort(outer.reason);
    return controller.signal;
  }
  outer.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      controller.abort(outer.reason);
    },
    { once: true },
  );
  return controller.signal;
}

/**
 * dogfood R2 CR-35：`request.lane` 穿 IPC 信任边界（agent 缝以 `as any` 直通渲染端/
 * agent 侧 body），运行时会到枚举外值（陈旧/typo）。原实现里枚举外值会静默落 interactive
 * 语义（60s 首事件窗硬杀本应后台跑的任务）——这里 safeParse 归一：合法值直通、缺席保持
 * 缺席（= interactive 默认）、其余回落 undefined 并一次性 warn（可查但不刷屏）。
 */
let invalidLaneWarned = false;

function normalizeRequestLane(raw: unknown): GenerationLane | undefined {
  const parsed = generationLaneSchema.optional().safeParse(raw);
  if (parsed.success) return parsed.data;
  if (!invalidLaneWarned) {
    invalidLaneWarned = true;
    console.warn(
      `[model-gateway] request.lane=${JSON.stringify(raw) ?? String(raw)} is not a valid GenerationLane — treating as interactive (dialogue) lane`,
    );
  }
  return undefined;
}

/** 测试缝：重置 CR-35 的 warn-once 门（用例间独立断言日志次数）。 */
export function _resetLaneWarnForTest(): void {
  invalidLaneWarned = false;
}

export async function handleGenerateText(payload: GenerateTextPayload, signal?: AbortSignal): Promise<TextGenerationResponse> {
  const resolved = resolveModel(payload.ref);
  // 09-01 附件 B3（design §2.3）：指针 image part → b64/转述文本。双 handler 共同下沉层——
  // 无图快径引用不变（request 对象零重打包，既有载荷逐字节一致）；转述路径只在带图时才
  // 产生 visionModel 调用。CR-007：既有 signal 经 deps 贯穿到 resolveImageParts——转述
  // generateText 与主调用同一取消通道（停止钮对转述生效；转述内部独立包 600s ceiling）。
  let request = payload.request;
  if (request && Array.isArray(request.messages)) {
    const messages = await resolveImageParts(request.messages, resolved, { signal });
    if (messages !== request.messages) {
      // 改写后的 part 全部是合法 GenerationPart 形态（text / b64 image）。
      request = { ...request, messages: messages as typeof request.messages };
    }
  }
  // dogfood R2 #7：request.lane → ProtocolCallContext.lane（undefined = interactive 语义）；
  // CR-35：lane 先过 safeParse 归一（枚举外值回落 undefined + 一次性 warn）。
  const lane = normalizeRequestLane(request?.lane);
  if (lane !== 'background') {
    return generateText(resolved, request, { signal, lane });
  }
  // CR-34（#50 关严）：非流式 background 路径套 600s 硬上限——罩住整条 generateText
  // 调用（含协议层内部快速重试）。超时按现有超时错误形态（ProtocolTimeoutError）上抛；
  // interactive/absent 路径原样直通（signal 引用不变，零回归）。
  const ceilingSignal = signalWithCeiling(signal, BACKGROUND_NONSTREAM_CEILING_MS);
  try {
    return await generateText(resolved, request, { signal: ceilingSignal, lane });
  } catch (err) {
    // CR-33 同序保护：调用方主动取消优先于超时映射（先查原始 signal，再判上限是否到点）。
    if (signal?.aborted) throw err;
    if (ceilingSignal.aborted) {
      throw new ProtocolTimeoutError(
        `background non-streaming generation exceeded its ${BACKGROUND_NONSTREAM_CEILING_MS / 1_000}s total ceiling`,
      );
    }
    throw err;
  }
}

/**
 * Streaming variant of `handleGenerateText` (dogfood T1 Stage 1 / design §2):
 * same resolveModel + request shape, but incremental chunks are surfaced via
 * `onDelta` before the terminal `TextGenerationResponse` resolves. Called
 * in-process by the agent seam (agentIpc generateTextImpl) — the renderer-facing
 * `model:generate-text` IPC handler stays non-streaming (no renderer consumer
 * needs streaming).
 *
 * dogfood R2 #7: `payload.request.lane` threads into the protocol context —
 * `background` (child agents / chapter chains) widens the first-event window
 * to 240s and enables the bounded non-streaming timeout fallback; absent
 * keeps the interactive 60s red line byte-identical. CR-35: the lane is
 * normalized through generationLaneSchema at this seam (out-of-enum values
 * fall back to undefined + one-time warn). No ceiling wrap here — the
 * streaming path's fallback is already bounded inside model-protocols (CR-34
 * covers only the non-streaming sibling above).
 */
export async function handleGenerateTextStream(
  payload: GenerateTextPayload,
  signal: AbortSignal | undefined,
  onDelta: (d: GenerationDelta) => void,
): Promise<TextGenerationResponse> {
  const resolved = resolveModel(payload.ref);
  // 09-01 附件 B3（design §2.3）：与 handleGenerateText 同一图片处理下沉层（双路径同罩）。
  // CR-007：既有 signal 同样贯穿（流式路径的转述取消与 ceiling 语义与非流式一致）。
  let request = payload.request;
  if (request && Array.isArray(request.messages)) {
    const messages = await resolveImageParts(request.messages, resolved, { signal });
    if (messages !== request.messages) {
      request = { ...request, messages: messages as typeof request.messages };
    }
  }
  return generateTextStream(
    resolved,
    request,
    { signal, lane: normalizeRequestLane(request?.lane) },
    onDelta,
  );
}

export async function handleGenerateImage(payload: GenerateImagePayload, signal?: AbortSignal): Promise<ImageGenerationResponse> {
  const resolved = resolveModel(payload.ref);
  return generateImage(resolved, payload.request, { signal });
}

export async function handleGenerateEmbedding(payload: GenerateEmbeddingPayload, signal?: AbortSignal): Promise<EmbeddingResponse> {
  const resolved = resolveModel(payload.ref);
  return generateEmbeddings(resolved, payload.request, { signal });
}

export async function handleRerank(payload: RerankPayload, signal?: AbortSignal): Promise<RerankResponse> {
  const resolved = resolveModel(payload.ref);
  return rerank(resolved, payload.request, { signal });
}
