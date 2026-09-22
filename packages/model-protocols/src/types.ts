import type { GenerationLane, ModelProtocol } from '@orison/shared-contracts';
// type-only：usageSink 零运行时依赖（只 type-import shared-contracts），types 引它
// 不进任何环（errors.ts↔generate.ts 既有 documented deliberate cycle 勿再挂新边）。
import type { AttemptMeteringRecord } from './usageSink';

export type ProtocolCallContext = {
  signal?: AbortSignal;
  /**
   * Dispatch lane (dogfood R2 #7): selects the streaming first-event window
   * (interactive 60s vs background 240s) and gates the bounded non-streaming
   * timeout fallback (background only). Absent = interactive semantics — every
   * existing caller keeps byte-level identical behavior. Mirrors
   * TextGenerationRequest.lane, threaded by the shell gateway.
   */
  lane?: GenerationLane;
  /**
   * C3.1：逻辑调用关联 id——网关回退环（回退环**外**生成一次）每 attempt 共享同一
   * callId；缺省入口 wrapper 自生成（单 attempt 逻辑调用行自成一组，无害）。
   */
  callId?: string;
  /**
   * C3.1：调用方标签（embed/rerank/image 族——'kb-index-embed' / 'kb-query-embed' /
   * 'kb-rerank' / 'image-gen'，调用方经 ctx 透传，物理点读 ctx 不硬编码）；
   * generateText 族仍走 request.taskType（两通道并存，wrapper 各读各的）。
   */
  taskType?: string;
  /**
   * C3.1：逻辑会话 id（generateText 族经 wire request.sessionId，入口转 ctx 归一后
   * 由 wrapper 统一落列；embed/rerank 族调用方暂不标，ABSENT 组）。
   */
  sessionId?: string;
  /**
   * C3.1（driver→入口）：abandoned attempt 上抛缝——driver 在重试点发射被弃 attempt
   * 的计量事实，入口 wrapper 收集后统一 dispatch（driver 不直接 dispatch，保持发射面
   * 单点）。缺省 undefined = driver 跳过发射（旧调用方零影响）。
   */
  onMeteringAttempt?: (rec: AttemptMeteringRecord) => void;
};

/**
 * Incremental streaming chunk surfaced to the caller's onDelta callback.
 * dogfood R2 #30：新增 `tool` 通道——工具调用参数流式期（正文已毕、tool-call JSON
 * 参数仍在流）的活性信号；`toolName` 在每个调用的首块携带（tool-input-start /
 * content_block_start(tool_use)），后续参数块缺省。UI 用它渲染「正在准备工具调用」
 * 指示——旧态该窗口完全静默（正文不长、无徽标、流式标志又压着全局三点 loading）。
 *
 * 09-12 agy provider：从 generate.ts 迁至 types（driver.ts 亦消费——留在 generate
 * 会成 type-only 环，dep-cruise no-circular 告警；形态零变化，generate.ts 再导出保
 * 既有导入路径）。
 */
export interface GenerationDelta {
  type: 'text' | 'reasoning' | 'tool';
  delta: string;
  /** `tool` 通道：调用首块携带的工具名（后续参数块缺省）。 */
  toolName?: string;
}

export type ListModelsRequest = {
  protocol?: ModelProtocol;
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  /**
   * Custom headers merged into the discovery request (09-12 子3) — gateway
   * auth/routing headers on the ad-hoc path (first-key setup). Same-name
   * overrides the built-in auth header.
   */
  headers?: Record<string, string>;
  /** Skip TLS verification for this discovery request (09-12 子3) — per-request undici dispatcher. */
  insecure?: boolean;
};
