import { createHash } from 'node:crypto';

// ── 内容锚定镜像（09-12 agy provider，design §3.2 复核 B1）──
//
// ⚠️ 不能用消息 id 锚定：wire 契约 GenerationMessage 无消息级 id（agent 侧组 wire 时
// 丢弃 SessionMessage id，渲染端带 id 也被 zod parse strip）。镜像 = **已发 compose
// 文本段的 hash 序列**（sha256 per segment；内存有界、比对 O(n)）。内容相同的不同消息
// 天然等价（hash 相等即匹配）——重复内容消息不误判。
//
// 四分支：
//   1. 冷启动（无镜像）              → 全量重发（spawn 或空进程）
//   2. 追加（镜像是新序列的真前缀）   → 只发新增尾段（缓存读）
//   3. 分歧（前缀不一致）            → 优雅关停旧进程 + 冷启动全量
//   4. 零尾段（序列与镜像完全相等——重复请求，复核 M5）→ 视作分歧：保守正确——不发空
//      turn（污染会话缓存）也不静默复用旧 result（seam 语义是重新生成）。

export function hashSegment(segment: string): string {
  return createHash('sha256').update(segment, 'utf8').digest('hex');
}

export function hashSegments(segments: string[]): string[] {
  return segments.map(hashSegment);
}

export type MirrorDecision =
  | { kind: 'cold-start' }
  | { kind: 'append'; prefixLength: number }
  | { kind: 'diverge'; reason: 'prefix-mismatch' | 'zero-tail' | 'shrunk' };

/**
 * 镜像 vs 新序列判定（纯函数）。`mirror` 为 undefined / 空数组 → 冷启动；前缀逐位相等
 * 且新序列更长 → 追加（prefixLength = 已在场段数）；完全相等 → 零尾段（分歧处理）；
 * 其余（前缀不一致 / 新序列更短）→ 分歧。
 */
export function diffMirror(mirror: readonly string[] | undefined, incoming: readonly string[]): MirrorDecision {
  if (mirror === undefined || mirror.length === 0) return { kind: 'cold-start' };
  if (incoming.length < mirror.length) return { kind: 'diverge', reason: 'shrunk' };
  for (let i = 0; i < mirror.length; i++) {
    if (mirror[i] !== incoming[i]) return { kind: 'diverge', reason: 'prefix-mismatch' };
  }
  if (incoming.length === mirror.length) return { kind: 'diverge', reason: 'zero-tail' };
  return { kind: 'append', prefixLength: mirror.length };
}
