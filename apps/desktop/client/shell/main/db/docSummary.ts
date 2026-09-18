import { createHash } from 'node:crypto';
import type { ResolvedModel } from '@orison/shared-contracts';
import { generateText } from '@orison/model-protocols';
import { getLogger } from '../logger';

/**
 * Index-time one-line summary fallback (Story 8.7 §3.1, shared by
 * `settingMdIndexer` + `closureCraftIndexer` — the two LONG-DOC indexers).
 *
 * Three states, resolved in priority order:
 *   1. **curated** — a frontmatter `summary:` value (user / agent authored via
 *      setting_md_update update_meta) wins outright. DERIVED never writes back
 *      to the user's file, so curation is the explicit channel.
 *   2. **cached generated** — fingerprint cache: a previously GENERATED summary
 *      whose `summary_hash === sha256(body)` is reused verbatim (no LLM call).
 *      Only `summary_source='generated'` rows are reused — a REMOVED curated
 *      summary is a deliberate removal, not a cache hit.
 *   3. **generated** — one `generateText` call (~50-100 字 Chinese one-line
 *      instruction, 30s AbortSignal.timeout mirror defaultEmbed CR-06) under
 *      the resolved summary model. No model / empty body / failure → columns
 *      stay empty (graceful: retrieval unaffected, mirror pending_embed
 *      philosophy).
 *
 * Like the embed call, the summary generate is best-effort OUTSIDE any SQLite
 * transaction (crash-consistency gate G3 contract unchanged: a crash mid-call
 * writes nothing).
 *
 * `summary_hash` is recorded for curated values too (unified change detection —
 * design §1.2), so the cache fingerprint is always the current body hash.
 */

/** The existing row's summary columns (fetched alongside content_hash by the
 *  indexer's existing-row lookup). */
export type ExistingDocSummaryRow = {
  summary_text: string | null;
  summary_source: string | null;
  summary_hash: string | null;
};

export type ResolvedDocSummary = {
  text: string | null;
  source: 'curated' | 'generated' | null;
  hash: string | null;
};

/**
 * Resolve a long doc's summary into the three summary_* columns. Never throws:
 * generate failures are logged + degraded to empty columns (best-effort — the
 * entry still indexes, FTS + body vector unaffected).
 */
export async function resolveDocSummary(input: {
  /** Curated frontmatter `summary` (already trim-normalized by the parser). */
  curated: string | undefined;
  /** The doc body (markdown prose) — the fingerprint + generate input. */
  body: string;
  /** The existing derived row (undefined on first index). */
  existing: ExistingDocSummaryRow | undefined;
  /** Resolve the summary model; null → skip generation (graceful). */
  resolveModel: () => ResolvedModel | null;
  /** Generate a one-line summary for a body (DI seam for tests). */
  generateSummary: (model: ResolvedModel, body: string) => Promise<string>;
  /** Log label prefix (e.g. 'setting_md reindex'). */
  logLabel: string;
}): Promise<ResolvedDocSummary> {
  const bodyHash = createHash('sha256').update(input.body).digest('hex');

  // State 1: curated frontmatter value wins outright.
  if (input.curated !== undefined) {
    return { text: input.curated, source: 'curated', hash: bodyHash };
  }

  // State 2: fingerprint cache — reuse a generated summary for an unchanged
  // body (e.g. a type-only frontmatter edit must NOT re-run the LLM). Curated
  // rows are deliberately excluded: removing the frontmatter summary is a
  // removal, and the stale value must not be resurrected as "generated".
  if (
    input.existing?.summary_source === 'generated' &&
    input.existing.summary_hash === bodyHash &&
    input.existing.summary_text
  ) {
    return { text: input.existing.summary_text, source: 'generated', hash: bodyHash };
  }

  // State 3: LLM fallback — needs a non-empty body + a configured text model.
  if (!input.body.trim()) return { text: null, source: null, hash: null };
  const model = input.resolveModel();
  if (!model) return { text: null, source: null, hash: null };
  try {
    const text = (await input.generateSummary(model, input.body)).trim();
    if (!text) {
      getLogger().warn({ model: model.modelId }, `${input.logLabel}: summary generate returned empty text - summary columns left empty`);
      return { text: null, source: null, hash: null };
    }
    return { text, source: 'generated', hash: bodyHash };
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), model: model.modelId },
      `${input.logLabel}: summary generate failed - summary columns left empty`,
    );
    return { text: null, source: null, hash: null };
  }
}

/**
 * Materialize the identity-vector composition for a long doc (design §1.3:
 * name + type + summary_text; without a summary it degrades to name + type —
 * a weak identity vector is still built, never skipped). Pure + exported for
 * unit testing / the dual-vector composition assertions.
 */
export function buildIdentityText(
  name: string,
  entryType: string,
  summaryText: string | null,
): string {
  return [name, entryType, summaryText]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join('\n');
}

/** One-line summary instruction (Chinese, ~50-100 字 target). Plain-language
 *  phrasing; the model gets NO project context beyond the doc body. */
const DOC_SUMMARY_PROMPT = [
  '请阅读下面这份写作参考资料文档，然后用中文写一句 50-100 字的简述，',
  '概括它是什么、核心内容讲什么，让读者不用读全文就能判断这份文档是否与自己的需求相关。',
  '直接输出简述文字本身：不要标题、不要引号、不要任何前后缀，保持一行。',
].join('');

/**
 * Default summary generator: one generateText call with a 30s
 * `AbortSignal.timeout` (mirror closureIndexer.defaultEmbed CR-06) so a hung
 * endpoint never hangs a save / backfill forever. Internal newlines are
 * collapsed so a chatty model still yields a single-line summary.
 */
export async function defaultGenerateSummary(model: ResolvedModel, body: string): Promise<string> {
  const res = await generateText(
    model,
    {
      model: model.modelId,
      messages: [{ role: 'user', content: `${DOC_SUMMARY_PROMPT}\n\n${body}` }],
      // 09-12 usage-panel：文档一句话简述 = doc-summary 流程标签（design §0 表）。
      taskType: 'doc-summary',
    },
    { signal: AbortSignal.timeout(30_000) },
  );
  return res.text
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}
