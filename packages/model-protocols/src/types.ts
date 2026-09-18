import type { GenerationLane, ModelProtocol } from '@orison/shared-contracts';

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
