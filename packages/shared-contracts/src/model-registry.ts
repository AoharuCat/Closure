import type {
  ModelCapability,
  ModelLimits,
  ModelRegistry,
  ModelRegistryEntry,
  ThinkingKind,
} from './contracts/model';

// Inline the registry data at build time — avoids runtime YAML parsing in the renderer.
const REGISTRY_ENTRIES: ModelRegistryEntry[] = [
  // Image models
  { pattern: 'dall-e-*', capability: 'image', alias: 'DALL·E' },
  { pattern: 'gpt-image-*', capability: 'image', alias: 'GPT Image' },
  { pattern: 'stable-diffusion-*', capability: 'image', alias: 'Stable Diffusion' },
  { pattern: 'sd-*', capability: 'image', alias: 'SD' },
  { pattern: 'sdxl-*', capability: 'image', alias: 'SDXL' },
  { pattern: 'flux-*', capability: 'image', alias: 'Flux' },
  { pattern: 'midjourney*', capability: 'image', alias: 'Midjourney' },
  { pattern: 'playground-*', capability: 'image', alias: 'Playground' },
  { pattern: 'imagen-*', capability: 'image', alias: 'Imagen' },
  // Video models
  { pattern: 'sora*', capability: 'video', alias: 'Sora' },
  { pattern: 'veo*', capability: 'video', alias: 'Veo' },
  { pattern: 'cogvideox*', capability: 'video', alias: 'CogVideoX' },
  { pattern: 'kling*', capability: 'video', alias: 'Kling' },
  { pattern: 'runway*', capability: 'video', alias: 'Runway' },
  { pattern: 'pika*', capability: 'video', alias: 'Pika' },
  { pattern: 'luma*', capability: 'video', alias: 'Luma' },
  { pattern: 'minimax-video*', capability: 'video', alias: 'MiniMax Video' },
  { pattern: 'wan-*', capability: 'video', alias: 'Wan' },
  // Rerank models (KB retrieval rerank stage, Story 2.1). Cross-encoder scorers
  // - NOT embedders. Listed BEFORE `bge-*` so `bge-reranker-*` resolves to
  // capability 'rerank' rather than 'embedding' (the `bge-*` glob below would
  // otherwise swallow it - the VS1 imprecision is now resolved).
  { pattern: 'bge-reranker-*', capability: 'rerank', alias: 'BGE Reranker' },
  { pattern: 'jina-reranker*', capability: 'rerank', alias: 'Jina Reranker' },
  { pattern: '*rerank*', capability: 'rerank', alias: 'Reranker' }, // cohere rerank-* / voyage-rerank-* / mxbai-rerank-*
  // Embedding models (KB indexing, VS1). Closure is CJK-heavy so CN families
  // (bge-*, m3e-*, gte-*) are kept.
  { pattern: 'text-embedding-*', capability: 'embedding', alias: 'Text Embedding' },
  { pattern: '*embed*', capability: 'embedding', alias: 'Embedding' }, // nomic-embed / jina-embed / cohere embed-* / gte-Qwen2-embed*
  { pattern: 'multilingual-e5*', capability: 'embedding', alias: 'Multilingual E5' },
  { pattern: 'e5-*', capability: 'embedding', alias: 'E5' },
  { pattern: 'bge-*', capability: 'embedding', alias: 'BGE' }, // bge-m3 / bge-large-zh (CN); bge-reranker-* matched by the rerank pattern above
  { pattern: 'gte-*', capability: 'embedding', alias: 'GTE' },
  { pattern: 'm3e-*', capability: 'embedding', alias: 'M3E' }, // CN
  { pattern: 'voyage-*', capability: 'embedding', alias: 'Voyage' },
  // Text models
  // B1 附件（R2.4）vision 保守标记（design D-G，全表通用纪律）：标记 = 确定性多模态
  //（官方文档全系支持图片输入）；未标 ≠ 不支持，只是未验证——未标家族的图片一律走
  // visionModel 转述安全路径，绝不盲发主模型（中转站静默剥 image part = 幻觉红线）。
  // OpenAI 侧刻意不标：gpt-5*（gpt-5-codex 变体存疑）/ o1*（o1-preview/o1-mini 纯文本）/
  // o3*（o3-mini 纯文本）/ gpt-4*（2024-04 前老 4 系纯文本）——家族内混有非多模态变体。
  { pattern: 'gpt-5*', capability: 'text', alias: 'GPT', thinking: 'gpt5', limits: { contextWindow: 400_000, maxOutputTokens: 128_000 } },
  { pattern: 'gpt-4o*', capability: 'text', alias: 'GPT-4o', vision: true },
  { pattern: 'gpt-4.1*', capability: 'text', alias: 'GPT-4.1', vision: true },
  { pattern: 'gpt-4*', capability: 'text', alias: 'GPT-4' },
  { pattern: 'gpt-3.5*', capability: 'text', alias: 'GPT-3.5' },
  // o-series (thinking adapters task): always-on reasoning, no off switch; Chat
  // Completions returns no reasoning content. o1's output ceiling is not
  // verified (research C theme 2 lists only o3/o4-mini) — limits stay absent.
  // B1 vision：o4 系（o4-mini 全系变体）官方多模态输入 → 标；o1/o3 不标（见上）。
  { pattern: 'o1*', capability: 'text', alias: 'o1', thinking: 'openai-o' },
  { pattern: 'o3*', capability: 'text', alias: 'o3', thinking: 'openai-o', limits: { contextWindow: 200_000, maxOutputTokens: 100_000 } },
  { pattern: 'o4*', capability: 'text', alias: 'o4', thinking: 'openai-o', limits: { contextWindow: 200_000, maxOutputTokens: 100_000 }, vision: true },
  // Claude (thinking adapters task): generation split — specific version
  // patterns FIRST, generic `claude-*` fallback last. Design §1.3:
  // fable/mythos → claude-forced; opus-5/sonnet-5 → claude-5;
  // opus-4-5/sonnet-4-5/haiku-4-5/3-7 → claude-budget; everything else
  // (4.6/4.7/4.8 + older) → claude-4x. Limits (1M/128K) only on the
  // generations research C verified (5 代 + 4.7/4.8); 4.6 output ceiling is
  // unverified → no limits on the fallback.
  // B1 vision：Claude 3 系起（2024-03）全系官方多模态输入（2.x 已全面下线不可配）
  // → 含 claude-* 兜底全标。
  { pattern: 'claude-fable*', capability: 'text', alias: 'Claude Fable', thinking: 'claude-forced', limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 }, vision: true },
  { pattern: 'claude-mythos*', capability: 'text', alias: 'Claude Mythos', thinking: 'claude-forced', limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 }, vision: true },
  { pattern: 'claude-opus-5*', capability: 'text', alias: 'Claude Opus 5', thinking: 'claude-5', limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 }, vision: true },
  { pattern: 'claude-sonnet-5*', capability: 'text', alias: 'Claude Sonnet 5', thinking: 'claude-5', limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 }, vision: true },
  { pattern: 'claude-opus-4-8*', capability: 'text', alias: 'Claude Opus 4.8', thinking: 'claude-4x', limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 }, vision: true },
  { pattern: 'claude-opus-4-7*', capability: 'text', alias: 'Claude Opus 4.7', thinking: 'claude-4x', limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 }, vision: true },
  { pattern: 'claude-opus-4-5*', capability: 'text', alias: 'Claude Opus 4.5', thinking: 'claude-budget', vision: true },
  { pattern: 'claude-sonnet-4-5*', capability: 'text', alias: 'Claude Sonnet 4.5', thinking: 'claude-budget', vision: true },
  { pattern: 'claude-haiku-4-5*', capability: 'text', alias: 'Claude Haiku 4.5', thinking: 'claude-budget', vision: true },
  { pattern: 'claude-3-7*', capability: 'text', alias: 'Claude 3.7', thinking: 'claude-budget', vision: true },
  { pattern: 'claude-*', capability: 'text', alias: 'Claude', thinking: 'claude-4x', vision: true },
  // Gemini (thinking adapters task): compat-endpoint passthrough unverified —
  // the kind exists for expectation management; v1 injects nothing.
  // B1 vision：Gemini 各代（1.5 / 2.x / 3 系）原生多模态输入，无纯文本 Gemini 变体 → 标。
  { pattern: 'gemini-*', capability: 'text', alias: 'Gemini', thinking: 'gemini', limits: { contextWindow: 1_048_576, maxOutputTokens: 65_536 }, vision: true },
  { pattern: 'deepseek-*', capability: 'text', alias: 'DeepSeek', thinking: 'deepseek-v4', limits: { contextWindow: 1_048_576, maxOutputTokens: 393_216 } },
  // Kimi (thinking adapters task): k2.x max_tokens ceiling unverified — using
  // the documented DEFAULT (32,768) per design §1.3.
  { pattern: 'kimi-k3*', capability: 'text', alias: 'Kimi K3', thinking: 'kimi-k3', limits: { contextWindow: 1_048_576, maxOutputTokens: 1_048_576 } },
  // CR-009: k2.7 (incl. -code / -code-highspeed) split from kimi-k2 — its
  // thinking.type rejects 'disabled' (400), so riding the offLegal=true
  // kimi-k2 profile offered an illegal「关」that degraded silently after the
  // 400. Listed BEFORE `kimi-k2*` (specific first, fallback behind).
  { pattern: 'kimi-k2.7*', capability: 'text', alias: 'Kimi K2.7', thinking: 'kimi-k27-forced', limits: { contextWindow: 262_144, maxOutputTokens: 32_768 } },
  { pattern: 'kimi-k2*', capability: 'text', alias: 'Kimi K2', thinking: 'kimi-k2', limits: { contextWindow: 262_144, maxOutputTokens: 32_768 } },
  // B1 vision：qwen*vl* = Qwen 视觉语言线（qwen-vl / qwen2-vl / qwen2.5-vl / qwen3-vl）
  // 官方全系图片输入 → 置于 qwen-* 之前（specific first）；thinking 不标（该线思考参数
  // 形态未验证，走协议层 param-strip 兜底）。qwen-* 主线（max/plus/turbo）纯文本不标。
  { pattern: 'qwen*vl*', capability: 'text', alias: 'Qwen', vision: true },
  { pattern: 'qwen-*', capability: 'text', alias: 'Qwen' },
  // GLM (thinking adapters task): version split per design §1.3 — specific
  // patterns FIRST, generic `glm-*` fallback last (older 4.x ids land on the
  // fallback; their thinking-parameter behavior is unverified, covered by the
  // protocol layer's param-strip retry).
  // B1 vision：glm-4.5v* = GLM 视觉语言系官方多模态 → 标；5.x / 4.x 主线识图能力
  // 未验证不标（走转述安全路径）。
  { pattern: 'glm-5.3*', capability: 'text', alias: 'GLM 5.3', thinking: 'glm-forced-effort', limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 } },
  { pattern: 'glm-5.2*', capability: 'text', alias: 'GLM 5.2', thinking: 'glm-dynamic-effort', limits: { contextWindow: 1_048_576, maxOutputTokens: 131_072 } },
  { pattern: 'glm-5.1*', capability: 'text', alias: 'GLM 5.1', thinking: 'glm-dynamic-basic', limits: { contextWindow: 204_800, maxOutputTokens: 131_072 } },
  { pattern: 'glm-5-turbo*', capability: 'text', alias: 'GLM 5 Turbo', thinking: 'glm-dynamic-basic' },
  { pattern: 'glm-4.7*', capability: 'text', alias: 'GLM 4.7', thinking: 'glm-forced-basic', limits: { contextWindow: 204_800, maxOutputTokens: 131_072 } },
  { pattern: 'glm-4.6*', capability: 'text', alias: 'GLM 4.6', thinking: 'glm-dynamic-basic', limits: { contextWindow: 204_800, maxOutputTokens: 131_072 } },
  { pattern: 'glm-4.5v*', capability: 'text', alias: 'GLM 4.5V', thinking: 'glm-forced-basic', vision: true },
  { pattern: 'glm-*', capability: 'text', alias: 'GLM', thinking: 'glm-dynamic-basic' },
  // B1 vision：豆包 vision 命名线（doubao-1.5-vision-* / doubao-vision-* 等，有无版本
  // 段两种形态）= 官方图像理解模型（vision 命名即确定性多模态）；豆包主线文本模型
  // 不匹配此 pattern、不标。
  { pattern: 'doubao-*vision*', capability: 'text', alias: 'Doubao', vision: true },
  { pattern: 'yi-*', capability: 'text', alias: 'Yi' },
  { pattern: 'mistral-*', capability: 'text', alias: 'Mistral' },
  { pattern: 'llama-*', capability: 'text', alias: 'Llama' },
  { pattern: 'command-*', capability: 'text', alias: 'Command' },
];

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function matchRegistryEntry(modelId: string): ModelRegistryEntry | undefined {
  for (const entry of REGISTRY_ENTRIES) {
    if (globMatch(entry.pattern, modelId)) return entry;
  }
  return undefined;
}

function infoFromEntry(
  entry: ModelRegistryEntry,
  alias: string,
): { capability: ModelCapability; alias: string; thinking?: ThinkingKind; limits?: ModelLimits; vision?: boolean } {
  // Conditional spreads keep the optional keys ABSENT (not `undefined`) so
  // exact-shape consumers (`toEqual`) stay stable for entries without them.
  return {
    capability: entry.capability,
    alias,
    ...(entry.thinking ? { thinking: entry.thinking } : {}),
    ...(entry.limits ? { limits: entry.limits } : {}),
    ...(entry.vision ? { vision: true } : {}),
  };
}

export function resolveModelInfo(modelId: string): {
  capability: ModelCapability;
  alias: string;
  thinking?: ThinkingKind;
  limits?: ModelLimits;
  vision?: boolean;
} {
  const entry = matchRegistryEntry(modelId);
  if (entry) {
    return infoFromEntry(entry, buildAlias(entry, modelId));
  }
  // dogfood 2026-08-21（#41）：聚合供应商（siliconflow 等）的 id 带 org/档位前缀
  // （Pro/BAAI/bge-m3）。前缀锚定的 glob（bge-*）对整串不命中 → 落 text 兜底，
  // embedding/rerank 全被误标。整串不命中时取 basename 再试一轮修 capability；
  // alias 直接用 basename（org 段对用户是噪音，见 buildAlias）。
  // Thinking adapters task：basename 二轮匹配同样携带 kind/limits。
  const slashIdx = modelId.lastIndexOf('/');
  if (slashIdx >= 0) {
    const base = modelId.slice(slashIdx + 1);
    const baseEntry = matchRegistryEntry(base);
    if (baseEntry) return infoFromEntry(baseEntry, base);
    return { capability: 'text', alias: base };
  }
  return { capability: 'text', alias: modelId };
}

/**
 * Build a version-aware alias by appending the portion matched by the glob wildcard.
 * e.g. pattern "gpt-image-*" + modelId "gpt-image-1" → "GPT Image 1"
 */
function buildAlias(entry: ModelRegistryEntry, modelId: string): string {
  // dogfood 2026-08-21（#41）：org/档位限定 id（Qwen/Qwen3-Embedding-8B、
  // Pro/BAAI/bge-reranker-v2-m3）——basename 已自带家族名（Qwen3-Embedding-8B），
  // 家族前缀 + 带前缀尾巴是复读噪音；直接用 basename 做 alias。
  const slashIdx = modelId.lastIndexOf('/');
  if (slashIdx >= 0) return modelId.slice(slashIdx + 1);

  const starIdx = entry.pattern.indexOf('*');
  if (starIdx < 0) return entry.alias;
  const prefix = entry.pattern.slice(0, starIdx);
  const suffix = entry.pattern.slice(starIdx + 1);
  let tail = modelId.slice(prefix.length);
  // dogfood 2026-08-21（#41）修：suffix 只在 id 真以它结尾时才剥。中间星模式
  // （*embed*）的 suffix 不锚定在尾部——旧逻辑盲剥尾部长度，把
  // Qwen/Qwen3-Embedding-8B 硬切成 Qwen/Qwen3-Embedd（盘上 alias 实录的截断）。
  if (suffix && tail.toLowerCase().endsWith(suffix.toLowerCase())) {
    tail = tail.slice(0, tail.length - suffix.length);
  }
  tail = tail.replace(/^[-_]+/, '');
  if (!tail) return entry.alias;
  return `${entry.alias} ${tail}`;
}

export function getModelRegistry(): ModelRegistry {
  return { entries: REGISTRY_ENTRIES };
}
