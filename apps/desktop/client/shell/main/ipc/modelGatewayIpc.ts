import { ipcMain } from 'electron';
import type {
  GenerateEmbeddingPayload,
  GenerateImagePayload,
  GenerateTextPayload,
  GenerateFallbackEntry,
  EmbeddingResponse,
  ImageGenerationResponse,
  GenerationLane,
  GenerationMessage,
  ModelConfig,
  ModelFallbackSwitchEvent,
  ModelRef,
  ResolvedModel,
  RerankPayload,
  RerankResponse,
  SlotAssignment,
  TextGenerationRequest,
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
  classifyGenerationFailure,
  FallbackChainExhaustedError,
} from '@orison/model-protocols';
import type { FallbackAttemptRecord } from '@orison/model-protocols';
import type { GenerationDelta } from '@orison/model-protocols';
import { readModelConfigFromDisk } from './configIpc';
import { resolveModelInfoWithDefaults } from '@orison/shared-contracts';
import { resolveImageParts } from './agentImageParts';
import { getLogger } from '../logger';

const logger = getLogger();

/**
 * CR-19（09-12 子2 CR 批）：resolveModel 的纯配置失败类型（键删/模型缺失/禁用/缺凭据
 * 或 cliExecutable）。调用方（lintIpc classify 的降级日志分岔）按类型甄别「没配模型」
 * 与网络/生成失败，不再靠预检丢弃式的双解析。消息与旧裸 Error 逐字相同——既有
 * `toThrow('...')` 断言零迁移。
 */
export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}

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
    throw new ModelResolutionError(`Model ref points to unknown key '${ref.keyId}'`);
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
    throw new ModelResolutionError(`Model '${modelId}' not found in key '${key.name}'`);
  }
  if (model.enabled === false) {
    throw new ModelResolutionError(
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
  // 09-12 agy provider：CLI 形态（antigravity-cli）——cliExecutable 条件展开（mirror
  // vision/limits 先例）；HTTP 凭据在该形态下必缺（key refine 保证），resolveModel 填 ''
  // 保持 ResolvedModel 字段非可选（HTTP 键 ?? 永不触发，逐字节不变）。CLI 键缺
  // cliExecutable（手改盘文件的病态形态——读盘路径不经 refine）在解析点响亮报错。
  if (key.protocol === 'antigravity-cli' && !key.cliExecutable) {
    throw new ModelResolutionError(
      `CLI-form key '${key.name}' is missing its cliExecutable path — fix the key in settings`,
    );
  }
  // CR-19（09-12 agy provider CR 批）：HTTP 键缺凭据响亮化——盘上手编坏配置（读盘路径
  // 不经 entry refine）此前被下方 `?? ''` 静默化成空凭据 → 神秘网络失败（请求打到空
  // baseUrl / 无鉴权 401）。对齐 CLI 面（缺 cliExecutable 同点位报错）语义：配置错误
  // 就报配置错误，不演成网络故障。
  if (key.protocol !== 'antigravity-cli') {
    if (!key.baseUrl || key.baseUrl.trim().length === 0) {
      throw new ModelResolutionError(`HTTP-form key '${key.name}' is missing its baseUrl — fix the key in settings`);
    }
    if (!key.apiKey || key.apiKey.trim().length === 0) {
      throw new ModelResolutionError(`HTTP-form key '${key.name}' is missing its apiKey — fix the key in settings`);
    }
  }
  const info = resolveModelInfoWithDefaults(model.id, model.defaults);
  return {
    keyId: key.id,
    modelId: model.id,
    protocol: key.protocol,
    baseUrl: key.baseUrl ?? '',
    apiKey: key.apiKey ?? '',
    capability: model.capability,
    ...(info.thinking ? { thinkingKind: info.thinking } : {}),
    ...(info.limits ? { limits: info.limits } : {}),
    // 09-12 子2 W6（跨形态图片红线）：vision 标记**形态感知**——CLI 形态（antigravity-cli）
    // 一律不挂 vision 键（registry gemini-* 按模型 id 标 vision，但 CLI 通道不能收 b64
    // 图片 part——compose 层只作占位省略，直传 = 盲发丢图）。CLI 条目走 visionModel 转述
    // 安全路径（design §5「判据就是 resolvedModel.vision，环零特判」的兑现前提）。
    // HTTP 键行为逐字节不变。
    ...(info.vision && key.protocol !== 'antigravity-cli' ? { vision: true } : {}),
    ...(key.protocol === 'antigravity-cli' && key.cliExecutable
      ? { cliExecutable: key.cliExecutable }
      : {}),
    // 09-12 子3 W3（design §2 #4）：九投影字段条件展开——ABSENT 语义（mirror 上方
    // thinkingKind/limits/vision/cliExecutable 先例；空 record 同 ABSENT——协议层注入点
    // 本就按非空门控）。`defaults.contextWindow`/`maxOutputTokens` 不在此透传——已合成进
    // info.limits（resolveModelInfoWithDefaults）；`pricing` 零协议消费不进（子5 经 ui 侧
    // modelConfig 直读）。CLI 键读不到这些字段（refine 拒 + lenient 读侧形态门）。
    ...(key.customHeaders && Object.keys(key.customHeaders).length > 0
      ? { customHeaders: key.customHeaders }
      : {}),
    ...(model.extraBody && Object.keys(model.extraBody).length > 0
      ? { extraBody: model.extraBody }
      : {}),
    ...(model.defaults?.temperature !== undefined ? { defaultTemperature: model.defaults.temperature } : {}),
    ...(model.defaults?.topP !== undefined ? { defaultTopP: model.defaults.topP } : {}),
    ...(model.defaults?.frequencyPenalty !== undefined
      ? { defaultFrequencyPenalty: model.defaults.frequencyPenalty }
      : {}),
    ...(model.defaults?.presencePenalty !== undefined
      ? { defaultPresencePenalty: model.defaults.presencePenalty }
      : {}),
    ...(key.timeoutSeconds !== undefined ? { timeoutSeconds: key.timeoutSeconds } : {}),
    ...(key.verifySsl !== undefined ? { verifySsl: key.verifySsl } : {}),
    ...(key.streamingDisabled !== undefined ? { streamingDisabled: key.streamingDisabled } : {}),
  };
}

/**
 * 09-12 子3 design §4.4：slot assignment 的 contextWindow enrichment（RUNTIME-ONLY）。
 *
 * 查 `keys[keyId].models[modelId].defaults.contextWindow`——有值则无条件覆盖注入
 * `contextWindowTokens`（sidecar 手加该键非源即忽略——flat 读路径根本不读它，单源在 key
 * 的 defaults）；无值原样返回同一引用（恒等回退，零配置零行为变化）。assignment 缺席 →
 * 原样 undefined（先判再读，零额外读盘——CR-1 09-12 子3 CR 批：缺省参数形态在守卫前
 * 评估 `readModelConfigFromDisk()`，assignment 缺席仍每解析全量读盘；读移进守卫后本句
 * 才是真话）；stale ref（键或模型已删）→ find 落空 → 原样返回（容错不抛）。enrichment
 * 只活在 resolver 闭包内存态——writeTaskModels 投影不含 `contextWindowTokens`（sidecar
 * 永不落盘此字段），UI 的 modelConfig.taskModels 来自 load-model 盘上原样不受污染。
 * fallbacks 原样透传不碰（链上条目不获 enrichment——条目各自回 registry，design §4.4
 * 边界如实记录）。
 *
 * CR-4（09-12 子3 CR 批）belt：override 值本身过正整数闸——读侧已拒 0/负/非整数，但
 * 本函数也接受调用方直传的 config（测试/未来调用点），非正整数 override 按缺席处理
 * （原样返回，不注入——0 值毒化预算/压缩红线数学）。
 *
 * 具名导出单源：agentIpc 的 slot resolver 闭包 + compact-session 窗口解析两消费点同源；
 * lintIpc 经 agent 包 resolveTaskModel（注入闭包）自动同享。
 */
export function enrichSlotAssignment(
  assignment: SlotAssignment | undefined,
  config?: ModelConfig,
): SlotAssignment | undefined {
  if (!assignment) return assignment;
  const cfg = config ?? readModelConfigFromDisk();
  const override = cfg.keys
    .find((k) => k.id === assignment.keyId)
    ?.models.find((m) => m.id === assignment.modelId)
    ?.defaults?.contextWindow;
  if (override === undefined || !Number.isInteger(override) || override <= 0) return assignment;
  return { ...assignment, contextWindowTokens: override };
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

/* ── CR-15（09-12 agy provider CR 批）shell 半：本会话 CLI-usage 旗 ──
 *
 * CLI 池的优雅关停是异步（close stdin → 等进程自退，池内 5s belt 硬杀兜底）。app
 * 退出（will-quit）若同步走完，主进程先死——Windows 下子进程不随父进程消亡，
 * agy.exe 会活过 app（在途 turn 跑完为止）。main/index.ts 的 will-quit 据本旗决定
 * 是否给关停留有界等待窗口（preventDefault + grace + app.exit）。
 */
let antigravityCliUsed = false;

/** 本会话是否发生过 CLI 形态生成（quit 守卫探测面；测试缝可还原）。 */
export function wasAntigravityCliUsed(): boolean {
  return antigravityCliUsed;
}

/** 测试缝：还原 CR-15 的 CLI-usage 旗（用例间独立）。 */
export function _resetAntigravityCliUsedForTest(): void {
  antigravityCliUsed = false;
}

// ── 09-12 子2 fallback chains（design §4）：网关层回退环 ──

/**
 * ONE model switch on a fallback chain, surfaced to the runtime (agent assembly
 * points turn this into the additive 'model-fallback' event / child event) and
 * always mirrored by a gateway logger.warn — shell direct-call faces pass no
 * onFallback and rely on the log line.
 *
 * CR-15（09-12 子2 CR 批）：形态单源 = shared-contracts `ModelFallbackSwitchEvent`
 *（contracts/generation.ts）——agent 侧 `ModelFallbackSwitch` / `ModelFallbackEventData`
 * 与 agentIpc 缝同引该契约类型，结构复制归一；UI 侧 agent.ts 的 inline 副本归后续批统
 * 一（形态结构相同，消费零迁移）。
 */
export type FallbackSwitchEvent = ModelFallbackSwitchEvent;

/**
 * CR-12（09-12 子2 CR 批）：切换公告单点——恒定 logger.warn（shell 直调面无 onFallback，
 * 日志是兜底可见面）+ onFallback 消费者隔离：UI 事件装配的 bug（回调 throw）不得反向炸掉
 * 健康链上的生成——try/catch + warn 吞消费者异常，生成照常推进。
 */
function announceFallbackSwitch(
  onFallback: ((event: ModelFallbackSwitchEvent) => void) | undefined,
  from: { keyId: string; modelId: string },
  to: { keyId: string; modelId: string } | undefined,
  reason: string,
  failedAttemptIndex: number,
): void {
  if (!to) return; // 链尽（最后一家失败）无切换可公告——FallbackChainExhaustedError 是终态面。
  const event: ModelFallbackSwitchEvent = { from, to, reason, attempt: failedAttemptIndex + 1 };
  logger.warn({ ...event }, 'fallback chain: model failed, switching to next entry');
  if (!onFallback) return;
  try {
    onFallback(event);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), attempt: event.attempt },
      'fallback chain: onFallback consumer threw (isolated — generation continues)',
    );
  }
}

/**
 * ONE attempt's resolution front (the extracted pre-fallback handler body):
 * resolveModel → CR-15 CLI flag → image re-resolution. Semantics byte-identical
 * to the pre-fallback handlers; the loop only adds per-entry request overwrite
 * around it.
 */
async function resolveAttemptRequest(
  ref: ModelRef,
  request: TextGenerationRequest,
  originalMessages: GenerationMessage[] | undefined,
  signal: AbortSignal | undefined,
): Promise<{ resolved: ResolvedModel; request: TextGenerationRequest }> {
  const resolved = resolveModel(ref);
  if (resolved.protocol === 'antigravity-cli') antigravityCliUsed = true; // CR-15 quit 守卫旗
  // 09-01 附件 B3（design §2.3）：指针 image part → b64/转述文本。无图快径引用不变
  //（request 对象零重打包）；转述路径只在带图时才产生 visionModel 调用。CR-007：signal
  // 贯穿到 resolveImageParts（转述 generateText 与主调用同一取消通道）。
  let nextRequest = request;
  if (Array.isArray(originalMessages)) {
    const messages = await resolveImageParts(originalMessages, resolved, { signal });
    if (messages !== originalMessages) {
      // 改写后的 part 全部是合法 GenerationPart 形态（text / b64 image）。
      nextRequest = { ...nextRequest, messages: messages as TextGenerationRequest['messages'] };
    }
  }
  return { resolved, request: nextRequest };
}

/**
 * ONE non-streaming attempt's execution (lane normalization + CLI ceiling
 * exemption + CR-34 background ceiling) — the extracted pre-fallback body,
 * byte-identical semantics, re-run per attempt with the attempt's own ceiling.
 */
async function executeNonStreamingAttempt(
  resolved: ResolvedModel,
  request: TextGenerationRequest,
  signal: AbortSignal | undefined,
): Promise<TextGenerationResponse> {
  // dogfood R2 #7：request.lane → ProtocolCallContext.lane（undefined = interactive 语义）；
  // CR-35：lane 先过 safeParse 归一（枚举外值回落 undefined + 一次性 warn）。
  // CR-20（09-12 agy provider CR 批）：CLI 形态豁免下方 CR-34 的 600s 非流式背景顶——
  // CLI 分派在协议层顶部早退、自带 print-timeout（lane 映射 3m/12m/缺省 5m）+ 外层
  // 兜底 belt，是唯一时长闸（design §3.3）。signal 原样直通（不套 ceiling 包装）。
  const lane = normalizeRequestLane(request?.lane);
  if (lane !== 'background' || resolved.protocol === 'antigravity-cli') {
    return generateText(resolved, request, { signal, lane });
  }
  // CR-34（#50 关严）：非流式 background 路径套 600s 硬上限。每 attempt 各自有界
  //（09-12 子2 design §4 权衡——最坏 N×600s，链是用户显式配的兜底）。
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
 * The gateway fallback loop (design §4). Callers already checked that a chain
 * exists (zero-default fast path lives in the handlers). Per attempt:
 *   resolveModel (config failure → record + advance + CR-13 switch event) →
 *   request overwrite from the ORIGINAL payload (model + per-entry thinking) →
 *   image re-resolution against THIS attempt's resolved model (never a previous
 *   attempt's rewrite; CR-11: re-resolution throw → `image:` trace + advance)
 *   → generateText[Stream].
 *
 * Failure advancement gates: classifyGenerationFailure (single source) AND the
 * per-attempt producedDelta flag (streaming double insurance) — overflow /
 * abort / interrupted / schema / already-visible-stream failures rethrow
 * untouched. Success annotates the RESOLVED identity + the trace (only when a
 * fallback actually happened); chain exhaustion raises
 * FallbackChainExhaustedError carrying the per-model failure records.
 */
async function runFallbackLoop(
  payload: GenerateTextPayload,
  signal: AbortSignal | undefined,
  onFallback: ((event: ModelFallbackSwitchEvent) => void) | undefined,
  onDelta: ((d: GenerationDelta) => void) | undefined,
  executeAttempt: (
    resolved: ResolvedModel,
    request: TextGenerationRequest,
    attemptOnDelta: ((d: GenerationDelta) => void) | undefined,
  ) => Promise<TextGenerationResponse>,
): Promise<TextGenerationResponse> {
  // chain[0] = primary with its own (already request-borne) thinking; fallback
  // entries carry their per-entry normalized thinking override.
  const chain: GenerateFallbackEntry[] = [
    {
      ref: payload.ref,
      ...(payload.request?.thinking ? { thinking: payload.request.thinking } : {}),
    },
    ...payload.fallbacks!,
  ];
  const trace: FallbackAttemptRecord[] = [];

  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index]!;
    const next = chain[index + 1];
    // 1. resolveModel — config failures (deleted key / disabled model / missing
    //    cliExecutable) are per-model facts: record + advance. A corrupted entry
    //    does not sink the whole chain (design §3 config row).
    let resolved: ResolvedModel;
    try {
      resolved = resolveModel(entry.ref);
    } catch (err) {
      const reason = `config: ${err instanceof Error ? err.message : String(err)}`;
      trace.push({ keyId: entry.ref.keyId, modelId: entry.ref.modelId, reason });
      logger.warn(
        { keyId: entry.ref.keyId, modelId: entry.ref.modelId, reason, attempt: index + 1 },
        'fallback chain: model resolution failed, advancing to next entry',
      );
      // CR-13（09-12 子2 CR 批）：config 跳家也发 model-fallback 事件（reason 带 `config:`
      // 前缀，与终态 trace 口径一致）——跳家是真实的链推进，仅 logger 不发事件 = 运行期
      // 相位可见性缺口。from 是请求身份（解析失败无 resolved 身份——auto-pick 主指派下
      // 可能是 {default,default} 哨兵，契约注释已注明）。
      announceFallbackSwitch(
        onFallback,
        { keyId: entry.ref.keyId, modelId: entry.ref.modelId },
        next ? { keyId: next.ref.keyId, modelId: next.ref.modelId } : undefined,
        reason,
        index,
      );
      continue;
    }
    if (resolved.protocol === 'antigravity-cli') antigravityCliUsed = true; // CR-15 quit 守卫旗

    // 2. Request overwrite — built from the ORIGINAL payload every attempt
    //    (never the previous attempt's image-rewritten product); the entry's
    //    thinking REPLACES the primary's (undefined = auto, deliberate override
    //    per design §4). `?? {}` is runtime defense only (schema-validated
    //    payloads always carry request).
    const { thinking: _primaryThinking, ...baseRequest } = payload.request ?? {};
    const request: TextGenerationRequest = {
      ...baseRequest,
      model: entry.ref.modelId,
      ...(entry.thinking ? { thinking: entry.thinking } : {}),
    };

    // 3. Image re-resolution from the ORIGINAL messages against this attempt's
    //    model (design §5 invariant): a b64-direct pass from attempt A must never
    //    blind-feed a non-vision attempt B — pointer parts are re-read per target.
    //    preparedImageCache (content-addressed) + transcription cache make repeat
    //    resolution near-free.
    //    CR-11（09-12 子2 CR 批）：重解 throw（转述 visionModel 配额耗尽 / 读盘异常等
    //    未分类错误）不再炸整链——按 `image:` 前缀记 trace + 推进下一条目（vision 档
    //    回退条目因此有机会以直传承接）。调用方主动 abort 例外：不烧链原样上抛。
    let attemptRequest = request;
    const originalMessages = payload.request?.messages;
    if (Array.isArray(originalMessages)) {
      try {
        const messages = await resolveImageParts(originalMessages, resolved, { signal });
        if (messages !== originalMessages) {
          attemptRequest = { ...request, messages: messages as TextGenerationRequest['messages'] };
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        const reason = `image: ${err instanceof Error ? err.message : String(err)}`;
        trace.push({ keyId: resolved.keyId, modelId: resolved.modelId, reason });
        logger.warn(
          { keyId: resolved.keyId, modelId: resolved.modelId, reason, attempt: index + 1 },
          'fallback chain: image re-resolution failed, advancing to next entry',
        );
        announceFallbackSwitch(
          onFallback,
          { keyId: resolved.keyId, modelId: resolved.modelId },
          next ? { keyId: next.ref.keyId, modelId: next.ref.modelId } : undefined,
          reason,
          index,
        );
        continue;
      }
    }

    // 4. producedDelta gate (streaming): content already flowed to the consumer →
    //    any failure rethrows (UI-visible text is never silently regenerated).
    let producedDelta = false;
    const trackedOnDelta = onDelta
      ? (d: GenerationDelta) => {
          producedDelta = true;
          onDelta(d);
        }
      : undefined;

    try {
      const response = await executeAttempt(resolved, attemptRequest, trackedOnDelta);
      // Success — annotate the RESOLVED identity (the request ref is the
      // {default,default} sentinel under auto-pick) + the trace when a
      // fallback actually happened (two-state .min(1)).
      return {
        ...response,
        modelRef: { keyId: resolved.keyId, modelId: resolved.modelId },
        ...(trace.length > 0
          ? { fallbackTrace: trace.map((t) => ({ keyId: t.keyId, modelId: t.modelId, reason: t.reason })) }
          : {}),
      };
    } catch (err) {
      const classification = classifyGenerationFailure(err);
      if (!classification.eligible || producedDelta) throw err;
      // Eligible failure → record the per-model reason + announce the switch.
      trace.push({ keyId: resolved.keyId, modelId: resolved.modelId, reason: classification.reason });
      announceFallbackSwitch(
        onFallback,
        { keyId: resolved.keyId, modelId: resolved.modelId },
        next ? { keyId: next.ref.keyId, modelId: next.ref.modelId } : undefined,
        classification.reason,
        index,
      );
      // No next entry → loop ends → FallbackChainExhaustedError below.
    }
  }

  throw new FallbackChainExhaustedError(trace);
}

export async function handleGenerateText(payload: GenerateTextPayload, signal?: AbortSignal, onFallback?: (event: FallbackSwitchEvent) => void): Promise<TextGenerationResponse> {
  // ── 09-12 子2 fallback chains（design §4）：零默认链快径 ──
  // payload.fallbacks 缺席 → 单模型直通，字节级现行为（无环机械、无响应注记、resolveModel
  // 原样直抛）。链只可能来自用户 sidecar 显式配置（零注入拍板）。
  if (!payload.fallbacks || payload.fallbacks.length === 0) {
    const { resolved, request } = await resolveAttemptRequest(payload.ref, payload.request, payload.request?.messages, signal);
    return executeNonStreamingAttempt(resolved, request, signal);
  }
  return runFallbackLoop(payload, signal, onFallback, undefined, (resolved, request) =>
    executeNonStreamingAttempt(resolved, request, signal));
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
 *
 * 09-12 子2 fallback chains: same zero-default fast path as the non-streaming
 * sibling; with a chain, the loop's producedDelta gate (double insurance with
 * the StreamInterruptedError classification) stops any fallback AFTER content
 * has already flowed to the consumer — UI-visible text is never silently
 * regenerated on another model.
 */
export async function handleGenerateTextStream(
  payload: GenerateTextPayload,
  signal: AbortSignal | undefined,
  onDelta: (d: GenerationDelta) => void,
  onFallback?: (event: FallbackSwitchEvent) => void,
): Promise<TextGenerationResponse> {
  // 09-12 子3 §3 ⑩：SSE 烂网关保险丝——键级 streamingDisabled 短路回既有非流式路径
  //（onDelta 丢弃、终帧直达；复用 executeNonStreamingAttempt = lane 归一 / CLI 豁免 /
  // CR-34 background 600s 顶全部同语义）。本函数是流式唯一 shell 入口（agentIpc
  // generateTextImpl 唯一调用者），快径单点即全覆盖；链路径按 attempt 各自按键判定
  //（回退家在别的键上时保留流式——per-key 语义，非 per-request）。
  if (!payload.fallbacks || payload.fallbacks.length === 0) {
    const { resolved, request } = await resolveAttemptRequest(payload.ref, payload.request, payload.request?.messages, signal);
    if (resolved.streamingDisabled) {
      return executeNonStreamingAttempt(resolved, request, signal);
    }
    return generateTextStream(
      resolved,
      request,
      { signal, lane: normalizeRequestLane(request?.lane) },
      onDelta,
    );
  }
  return runFallbackLoop(payload, signal, onFallback, onDelta, (resolved, request, attemptOnDelta) => {
    if (resolved.streamingDisabled) {
      return executeNonStreamingAttempt(resolved, request, signal);
    }
    return generateTextStream(
      resolved,
      request,
      { signal, lane: normalizeRequestLane(request?.lane) },
      // 非 undefined 断言：streaming handler 的 onDelta 是必填参数 → 环内 tracked
      // 包装器每 attempt 必在（类型上 executeAttempt 形参可 undefined 是非流式共用所致）。
      attemptOnDelta!,
    );
  });
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
