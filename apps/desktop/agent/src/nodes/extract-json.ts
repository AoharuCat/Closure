import { logger } from '../logger';

// ── Story 4.0 写章战术链段：LLM 输出 JSON 抽取（CR-5/CR-1 dogfood-readiness）──
//
// 真实 LLM（尤 Qwen/DashScope）常返非裸 JSON：
//  - ```json ... ``` 围栏（含/不含 `json` 标签）
//  - 前导自然语言（"这是初稿：\n{...}"）+ 尾随文字
//  - DashScope `"{}{...}"` 双对象前缀（runLoop `agent/loop.ts:210-229` tool-args 路径已遇）
// 裸 JSON.parse 在这些形态下抛 → 单发 parseOutput 节点（draft-writer / multi-review / route /
// brief-reviewer / revision-optimizer 等，createLlmNode 家族）两次重试同 prompt 同败 → error artifact
// → 链断在产稿/审读位（dogfood gate 跨不过）。
//
// **复用核实（CR-5 要求）**：runLoop `agent/loop.ts:210-229` 有 `lastIndexOf('{')` brace-slice 逻辑，
// 但它是 inline 的 tool-arguments 修复（耦合 `call.arguments = JSON.stringify(params)` 副作用），
// 且不处理 ```json 围栏 / 前导文字（tool-args 场景无需）。**不可直接抽出复用**——故本 helper 综合
// 「strip fence + 前后文字 + brace-slice（first/last 双策略）」独立实现，但复用 runLoop 的
// `lastIndexOf('{')` 思路（作为 DashScope 双对象 fallback 策略，非主策略——主策略 first-{ to last-}
// 正确处理嵌套对象）。
//
// 候选策略（按序尝试，首个 JSON.parse 成功者返回）：
// 1. strip ```json/``` 围栏 → first `{` 到末个 `}` 子串（处理嵌套对象 + 前后文字）
// 2. 末个 `{` 到末个 `}` 子串（DashScope `"{}{...}"` 双对象——runLoop 思路）
// 3. 围栏剥离后的原文（无 brace 时让 JSON.parse 给清晰错误）
// 全失败 → 返回首个候选（让调用方 JSON.parse 报错，触发 createLlmNode 重试/兜底）。
//
// 落点 `nodes/`（与 4 个消费 parseOutput 同目录）。纯函数（无 fs/db/LLM）→ 可 plain vitest 单测。
//
// expected_downstream_consumers:
// - Story 4.0：4 个 LLM 节点 parseOutput（chapter-nodes.ts）改 `JSON.parse(extractJson(content))`。
// - 未来 LLM 节点（retrieval 4.5 / 灰区裁决器 4.6）复用。

/**
 * 从 LLM 输出中抽取最可能合法的 JSON 子串。
 *
 * 处理顺序（首个能 JSON.parse 通过的候选即返回）：
 * 1. 剥离 ```json/``` 围栏（如有）→ 取首个 `{` 到末个 `}`（嵌套对象 + 前后文字）。
 * 2. 末个 `{` 到末个 `}`（DashScope `"{}{...}"` 双对象前缀）。
 * 3. 围栏剥离后原文（无 brace 时，让调用方 JSON.parse 报清晰错）。
 *
 * 全候选都 parse 失败 → 返回候选 1（first-{ to last-}，或无 brace 时剥围栏原文），
 * 让调用方 JSON.parse 抛出真实错误（触发 createLlmNode 重试/兜底 error artifact）。
 */
export function extractJson(content: string): string {
  const trimmed = content.trim();

  // strip ```json / ``` 围栏（含/不含 json 标签；非贪婪到首个闭合 ```）。
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const base = fenceMatch ? fenceMatch[1].trim() : trimmed;

  const firstBrace = base.indexOf('{');
  const lastBrace = base.lastIndexOf('}');

  // 无 brace → 无法抽（让调用方 JSON.parse 报错）
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return base;
  }

  // 候选 1：first { to last }（嵌套对象 + 前后文字；主策略）
  const candidate1 = base.slice(firstBrace, lastBrace + 1);
  // 候选 2：last { to last }（DashScope "{}{...}" 双对象；仅当 last-{ 不同于 first-{）
  const lastOpen = base.lastIndexOf('{');
  const candidate2 = lastOpen > firstBrace ? base.slice(lastOpen, lastBrace + 1) : candidate1;

  const candidates = [candidate1, candidate2];
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // 该候选不合法，试下一个
    }
  }

  // 全候选 parse 失败 → 返回候选 1（让调用方 JSON.parse 抛真实错，触发重试/兜底）
  logger.warn(
    { hasFence: Boolean(fenceMatch), firstBrace, lastBrace },
    'extractJson: no candidate parsed cleanly → returning first candidate (caller JSON.parse will error)',
  );
  return candidate1;
}
