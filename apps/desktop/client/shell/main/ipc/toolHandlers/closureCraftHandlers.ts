/**
 * Craft KB query tool handler (ADR-3 / Story 2.1). Mirrors `closureHandlers.ts`
 * (`queryStoryHandler`) for the GLOBAL craft reference library.
 *
 * `query_craft` is the AI-side front of the craft hybrid retrieval pipeline. The
 * agent `query_craft` tool (agent/src/tool/builtin.ts) crosses processes via the
 * UNIFIED `toolExecution` channel (remoteToolProxy -> handleToolExecute -> this
 * handler). There is NO dedicated IPC channel, NO preload method, NO
 * `OrisonDesktopApi` entry - same unified-channel pattern as `query_story`.
 *
 * KEY DIFFERENCE from queryStoryHandler: the craft KB is GLOBAL, so this handler
 * does NOT resolve a projectId from the project dir and does NOT scope the query.
 * It delegates straight to `searchCraft` (the shared craft retrieval core) and
 * formats hits as readable Markdown for the Writer LLM. NEVER throws - a retrieval
 * failure degrades to a friendly message so the agent never sees a rejection.
 *
 * E10.2b W4（task 09-05）query_craft 消费面扩展：
 * - **W4.1 卡命中渲染**（design §2.4，mirror F-02 材料 chunk 渲染形态）：命中 craft_id
 *   `card:` 前缀 → lazy 回查 closure_craft_card → 手艺卡块（title + condensed 四件套 +
 *   讲法列表 rank 过滤 + tags 标签行 + 引文锚点脚注）。doc 级命中渲染零改动并存。
 * - **W4.2 tags 检索**（R10 / F-08）：params.tags 透传 searchCraft（融合后 OR 过滤 +
 *   vec 窗口 ×4 补偿在那边）；query 为空 + tags 在场 = 纯标签浏览（守卫放行）。
 */
import {
  closureCraftQuerySchema,
  type CraftCard,
  type CraftHit,
  type MaterialChunkSpan,
} from '@orison/shared-contracts';
import { searchCraft } from '../../db/closureCraftRetrieval';
import { getLogger } from '../../logger';
import type { ToolHandler } from './types';

/** Max body_text chars rendered per hit (keeps the LLM context bounded). */
const BODY_CAP = 800;

/** Max quote chars rendered per teaching（讲法引文片段截断——W4.1）. */
const TEACHING_QUOTE_CAP = 120;

/** 全局车道材料 chunk 行的 craft_id 前缀（F-02 命中渲染器识别锚，编码侧 materialIndexer.materialChunkCraftId）。 */
const MATERIAL_CRAFT_ID_PREFIX = 'mat:';

/** 手艺卡 entry 行的 craft_id 前缀（W4.1 命中渲染器识别锚，编码侧 closureCraftCardRepository.cardCraftId）。 */
const CARD_CRAFT_ID_PREFIX = 'card:';

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/**
 * F-02 消费缝（Story 10.1 check 补——design §3.2）：全局车道材料命中（craft_id `mat:` 前缀）
 * 经 lookupMaterialChunkSpans 回查 closure_material.chunk_spans 取段落号+字符区间（10.2 锚定
 * / 回原文定位）。**lazy 动态引入**隔离模块图（本 handler 的纯 mock 测试面不拉 db/electron 层）；
 * best-effort——回查失败脚注缺席，绝不阻命中渲染（材料行仍带正文与相关性）。
 */
async function collectMaterialSpanNotes(
  hits: CraftHit[],
): Promise<Map<string, MaterialChunkSpan> | undefined> {
  if (!hits.some((h) => h.craftId.startsWith(MATERIAL_CRAFT_ID_PREFIX))) return undefined;
  try {
    const { lookupMaterialChunkSpans } = await import('../../db/materialIndexer');
    return lookupMaterialChunkSpans(hits.map((h) => h.craftId));
  } catch {
    return undefined; // 回查缝 best-effort（db 不可用/坏行）——脚注缺席非失败
  }
}

// ── E10.2b W4.1：卡命中渲染上下文（lazy 回查产物，纯函数 formatCraftHitsForLlm 消费）──

/** 单张卡命中渲染所需的回查产物（craft_id → note）。 */
export interface CraftCardRenderNote {
  card: CraftCard;
  /** 词目名（closure_craft_term.name；词目行缺失防御性 null——头部省略词目段）。 */
  termName: string | null;
  /** 大类 gloss 短标签（closureCraftCardRepository.craftCategoryGlossLabel——单源截断口径）。 */
  categoryGloss: string;
}

/** 卡命中渲染上下文：notes（craft_id 键）+ materialNames（讲法锚点材料名，缺失 null）。 */
export interface CardRenderContext {
  notes: ReadonlyMap<string, CraftCardRenderNote>;
  materialNames: ReadonlyMap<string, string | null>;
}

/**
 * W4.1 卡回查缝（mirror F-02 collectMaterialSpanNotes 的 lazy 动态引入 + best-effort
 * 形态）：命中含 `card:` 前缀行 → decodeCardCraftId → getCraftCard + 词目名 + 讲法材料名。
 *
 * - **状态漂移 belt**：entry 行只应在 verified 时存在（F-06），但命中在回查时卡可能已被
 *   删/降级——非 verified / 缺行 → 该命中降级跳过（warn 留痕），绝不炸（never-throws）。
 * - **整缝失败**（动态引入/首查抛错）→ 返回 undefined：卡命中走 entry body 兜底渲染
 *   （doc 形态——rank 过滤缺席但内容可见，好于静默丢块）。
 */
async function collectCardRenderContext(hits: CraftHit[]): Promise<CardRenderContext | undefined> {
  if (!hits.some((h) => h.craftId.startsWith(CARD_CRAFT_ID_PREFIX))) return undefined;
  try {
    const [cardRepo, termRepo, materialIndexer] = await Promise.all([
      import('../../db/closureCraftCardRepository'),
      import('../../db/closureCraftTermRepository'),
      import('../../db/materialIndexer'),
    ]);
    const notes = new Map<string, CraftCardRenderNote>();
    const materialNames = new Map<string, string | null>();
    const termNames = new Map<string, string | null>();
    for (const h of hits) {
      if (!h.craftId.startsWith(CARD_CRAFT_ID_PREFIX)) continue;
      const cardId = cardRepo.decodeCardCraftId(h.craftId);
      if (cardId === null) continue;
      const card = cardRepo.getCraftCard(cardId);
      if (card === null || card.status !== 'verified') {
        getLogger().warn(
          { craftId: h.craftId, status: card?.status ?? null },
          'query_craft: card hit skipped (card missing or no longer verified)',
        );
        continue;
      }
      let termName = termNames.get(card.termId);
      if (termName === undefined) {
        termName = termRepo.getCraftTerm(card.termId)?.name ?? null;
        termNames.set(card.termId, termName);
      }
      for (const t of card.teachings) {
        if (!materialNames.has(t.materialId)) {
          materialNames.set(t.materialId, materialIndexer.getMaterialRow(t.materialId)?.name ?? null);
        }
      }
      notes.set(h.craftId, {
        card,
        termName,
        categoryGloss: cardRepo.craftCategoryGlossLabel(card.category),
      });
    }
    return { notes, materialNames };
  } catch {
    return undefined; // 回查缝 best-effort——entry body 兜底渲染（卡行内容仍在 body_text）
  }
}

/** 讲法锚点脚注（mirror 材料 chunk span 脚注格式——AC6 引文回看定位取数面）。 */
function teachingAnchorNote(
  anchor: CraftCard['teachings'][number]['anchor'],
  materialName: string | null,
): string {
  const base =
    materialName !== null ? `材料「${materialName}」派生 .md 基面` : '材料派生 .md 基面';
  return `_原文定位: 段落 ${anchor.paraStart}–${anchor.paraEnd} · 字符 ${anchor.charStart}–${anchor.charEnd}（${base}，可回原文）_`;
}

/**
 * Render ONE craft-card hit block（W4.1，design §2.4）：
 * `## {title}（{大类 gloss}·{词目名}）` + condensed 四件套（精简格式，mirror
 * buildCardEntryBody 段式）+ `标签: #a #b` 行（R10 标签发现机制即此）+ 讲法列表
 * （**rank 过滤**：有 approved 只注 approved；全 normal 并排；rejected 不注——
 * mirror Wikidata preferred/normal/deprecated 注入语义）+ 相关性脚注。每讲法带
 * author + 引文片段截断 + 锚点脚注（讲法 anchor 自带段落/字符区间，材料名经
 * materialNames 补充——材料删除后脚注退基面形态）。
 */
function renderCraftCardBlock(
  h: CraftHit,
  note: CraftCardRenderNote,
  materialNames: ReadonlyMap<string, string | null>,
): string {
  const { card, termName, categoryGloss } = note;
  const header = `## ${card.title}（${categoryGloss}${termName === null ? '' : `·${termName}`}）`;
  const claimLines: string[] = [`主张：${truncate(card.claim.condensed, BODY_CAP)}`];
  const section = (label: string, items: readonly string[]): void => {
    if (items.length > 0) claimLines.push(`${label}：\n${items.map((x) => `- ${x}`).join('\n')}`);
  };
  section('操作要点', card.claim.points);
  section('适用场景', card.claim.scenarios);
  section('反例', card.claim.counterexamples);
  const lines = [header, claimLines.join('\n\n')];
  if (card.tags.length > 0) {
    lines.push(`标签: ${card.tags.map((t) => `#${t}`).join(' ')}`);
  }
  const approved = card.teachings.filter((t) => t.rank === 'approved');
  const shownTeachings = approved.length > 0 ? approved : card.teachings.filter((t) => t.rank === 'normal');
  if (shownTeachings.length > 0) {
    const teachingLines = shownTeachings.map((t, i) => {
      const author = t.author === null ? '' : `（${t.author}）`;
      return `${i + 1}. 「${truncate(t.quote, TEACHING_QUOTE_CAP)}」${author} ${teachingAnchorNote(
        t.anchor,
        materialNames.get(t.materialId) ?? null,
      )}`;
    });
    lines.push(`讲法：\n${teachingLines.join('\n')}`);
  }
  const segments = [`_相关性: ${h.score.toFixed(4)}`];
  if (h.vecDistance != null) segments.push(`vec=${h.vecDistance.toFixed(3)}`);
  if (h.rerankScore != null) segments.push(`rerank=${h.rerankScore.toFixed(3)}`);
  lines.push(segments.join(' ') + '_');
  return lines.join('\n');
}

/**
 * Render craft retrieval hits as Markdown the Writer LLM can read. Each DOC hit is a
 * block with name + craft_type, the (length-capped) body text, and an inline
 * relevance footer (RRF score, plus vec distance when the vector arm ran, plus
 * rerank score when the rerank stage ran). Empty results get a single "no
 * matches" line. Exported for unit testing.
 *
 * `spanNotes`（Story 10.1 F-02）：craft_id → chunk span——材料 chunk 行（`mat:` 前缀）附
 * 原文定位脚注（段落号 + 字符区间，材料派生 .md 全局基面）；缺席/非材料行不出脚注。
 *
 * `cardCtx`（E10.2b W4.1）：`card:` 前缀命中 → 手艺卡块渲染（见 renderCraftCardBlock）。
 * 卡不在 notes（被删/状态漂移）→ 该命中降级跳过；cardCtx 整体缺席（回查缝失败）→ 卡行
 * 走 doc 兜底渲染。`tags`（W4.2）：空命中 + tags 在场的纯标签浏览 miss 文案。
 */
export function formatCraftHitsForLlm(
  query: string,
  hits: CraftHit[],
  spanNotes?: ReadonlyMap<string, MaterialChunkSpan>,
  cardCtx?: CardRenderContext,
  tags?: readonly string[],
): string {
  if (hits.length === 0) {
    if (tags !== undefined && tags.length > 0 && !query.trim()) {
      return `未找到匹配标签 ${tags.map((t) => `#${t}`).join(' ')} 的 craft 条目。`;
    }
    return `未找到与 "${query}" 相关的 craft 文档。`;
  }
  const blocks: string[] = [];
  for (const h of hits) {
    if (!h.craftId.startsWith(CARD_CRAFT_ID_PREFIX)) {
      blocks.push(renderDocBlock(h, spanNotes));
      continue;
    }
    if (cardCtx === undefined) {
      // 回查缝失败 → entry body 兜底（doc 形态渲染卡行——内容在，rank 过滤缺席）。
      blocks.push(renderDocBlock(h, spanNotes));
      continue;
    }
    const note = cardCtx.notes.get(h.craftId);
    if (note === undefined) continue; // 卡被删/状态漂移 → 降级跳过（never-throws）
    blocks.push(renderCraftCardBlock(h, note, cardCtx.materialNames));
  }
  if (blocks.length === 0) {
    return '命中的手艺卡已删除或审阅状态已变化，本次无可注入的手艺内容。';
  }
  return blocks.join('\n\n');
}

function renderDocBlock(
  h: CraftHit,
  spanNotes?: ReadonlyMap<string, MaterialChunkSpan>,
): string {
  const body = truncate(h.bodyText ?? '', BODY_CAP);
  const segments = [`_相关性: ${h.score.toFixed(4)}`];
  if (h.vecDistance != null) segments.push(`vec=${h.vecDistance.toFixed(3)}`);
  if (h.rerankScore != null) segments.push(`rerank=${h.rerankScore.toFixed(3)}`);
  const relevance = segments.join(' ') + '_';
  const span = spanNotes?.get(h.craftId);
  const spanNote =
    span !== undefined
      ? `\n_原文定位: 段落 ${span.paraStart}–${span.paraEnd} · 字符 ${span.charStart}–${span.charEnd}（材料派生 .md 基面，可回原文）_`
      : '';
  return `## ${h.name} (${h.craftType})\n${body}${spanNote}\n${relevance}`;
}

export const queryCraftHandler: ToolHandler = async ({ params }) => {
  // Validate + clamp params (mirror queryStoryHandler CR-08). `k` clamped to
  // [1, 50] so a bad LLM param can never reach SQL. parse is wrapped because
  // handleToolExecute does NOT catch handler throws - a malformed param must
  // degrade to a friendly message (the handler "never throws" contract).
  let parsed: { query: string; craft_type?: string; tags?: string[]; k: number };
  try {
    parsed = closureCraftQuerySchema.parse(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg }, 'query_craft: invalid params');
    return {
      title: 'query_craft',
      output: '检索参数无效，请提供查询文本。',
      metadata: { count: 0, hits: [] },
    };
  }
  const { query, craft_type, tags, k } = parsed;
  const hasTags = Array.isArray(tags) && tags.length > 0;

  // E10.2b W4.2：query 与 tags 至少其一非空（纯标签浏览合法——R10「agent 可自由组合
  // 标签检索」；两者皆空才拦，既有空 query 行为零改动）。
  if (!query.trim() && !hasTags) {
    return {
      title: 'query_craft',
      output: '请提供检索查询。',
      metadata: { count: 0, hits: [] },
    };
  }

  try {
    const hits = await searchCraft(query, { craftType: craft_type, tags, k });
    const spanNotes = await collectMaterialSpanNotes(hits);
    const cardCtx = await collectCardRenderContext(hits);
    const label = query.trim() !== '' ? query : (tags ?? []).map((t) => `#${t}`).join(' ');
    return {
      title: `query_craft: ${label.slice(0, 40)}`,
      output: formatCraftHitsForLlm(query, hits, spanNotes, cardCtx, tags),
      metadata: { count: hits.length, hits },
    };
  } catch (err) {
    // Never reject: the agent must see a friendly miss, not a thrown tool error.
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, query, tags }, 'query_craft: retrieval failed');
    return {
      title: 'query_craft',
      output: `检索失败: ${msg}`,
      metadata: { count: 0, hits: [], error: msg },
    };
  }
};
