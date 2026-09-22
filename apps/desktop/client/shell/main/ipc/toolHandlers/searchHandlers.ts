/**
 * Web search tool handler (Story 3.6 WP4, R2 / design D9).
 *
 * `web_search {query, limit?}` — runs the engine chain (research/searchChain)
 * over the adapters resolved from the search config (research/searchConfig):
 * zero-key default chain (probed localhost SearXNG → bing → baidu → ddg) with
 * the configured upgrade layer (SearXNG URLs / Tavily / 博查 / AnySearch)
 * ahead of or replacing it per `engineOrder`. Output is a markdown hit list,
 * every hit tagged with its source engine; an all-engine failure renders the
 * friendly per-engine reason summary.
 *
 * NEVER throws (mirror query_craft / wikiHandlers, R8): invalid params, config
 * read failures, probe failures, and chain errors all degrade to friendly
 * outputs — the agent never sees a tool rejection for a search problem.
 *
 * Reached via the unified toolExecution channel (agent-side remoteToolProxy
 * registration in agent/src/tool/builtin.ts — id `web_search`). classifyTool
 * defaults it to 'read' (readonly/suggest/auto). All network lives here in the
 * shell (agent 纯编排零网络, spec/agent/agent-tools.md injection boundary).
 *
 * Testability: `createWebSearchHandler` accepts injectable config loader /
 * probe / fetcher / gate / cache — unit tests run with ZERO network.
 */
import type { SearchConfig } from '@orison/shared-contracts';
import { DEFAULT_SEARCH_CONFIG } from '@orison/shared-contracts';
import { getLogger } from '../../logger';
import { EngineGate, LruTtlCache, createSearchResultCache } from '../../research/netGuard';
import type {
  EngineAdapter,
  EngineFailureReason,
  EngineFetcher,
  SearchHit,
} from '../../research/searchEngines';
import { buildEngineAdapters, probeSearxngLocalhost, readSearchConfig } from '../../research/searchConfig';
import { runSearchChain, type SearchChainOutcome } from '../../research/searchChain';
import type { ToolHandler } from './types';

// ── Constants ──

const LIMIT_MIN = 1;
const LIMIT_MAX = 10;
const DEFAULT_LIMIT = 10;

/** Module-level throttle + cache shared by default handler runs (D9). */
const defaultSearchGate = new EngineGate();
const defaultSearchCache = createSearchResultCache<SearchChainOutcome>();

/** Friendly labels for the all-fail summary + notes. */
export const ENGINE_FAILURE_LABELS: Record<EngineFailureReason, string> = {
  timeout: '请求超时',
  'anti-bot': '触发反爬/验证码拦截',
  empty: '无结果',
  http: 'HTTP 状态异常',
  network: '网络不可达/请求失败',
};

// ── Formatting (exported for tests) ──

/** Markdown hit list: numbered title+engine, URL, snippet + 检索日期 provenance (P24, R6). */
export function formatSearchOutput(query: string, hits: readonly SearchHit[]): string {
  const head = `「${query}」的 web 搜索结果（${hits.length} 条）：`;
  const blocks = hits.map((hit, i) => {
    const lines = [`${i + 1}. **${hit.title}**（${hit.engine}）`, `   ${hit.url}`];
    if (hit.snippet) lines.push(`   ${hit.snippet}`);
    return lines.join('\n');
  });
  // P24 (CR 2026-08-15): search results are a snapshot in time — the retrieval
  // date rides the header so the LLM can cite it alongside every hit.
  return [head, `检索日期: ${new Date().toISOString().slice(0, 10)}`, ...blocks].join('\n\n');
}

/** All-engine-failure summary: per-engine reason + actionable advice. */
export function formatAllFailOutput(query: string, failures: readonly { engine: string; reason: EngineFailureReason; detail: string }[]): string {
  const lines = failures.map((f) => `- ${f.engine}（${ENGINE_FAILURE_LABELS[f.reason]}）：${f.detail}`);
  return [
    `「${query}」搜索失败——所有搜索引擎均不可用：`,
    ...lines,
    '建议：检查网络/代理设置后重试；或在设置「研究与视觉」中配置升级层搜索引擎（SearXNG / Tavily / 博查 / AnySearch）。',
  ].join('\n');
}

/** Hand-coerced params (no zod in this package — mirror wikiHandlers). */
export function coerceSearchParams(params: Record<string, unknown>): { query?: string; limit?: number } {
  const query = typeof params.query === 'string' ? params.query : undefined;
  let limit: number | undefined;
  if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
    limit = Math.min(Math.max(Math.round(params.limit), LIMIT_MIN), LIMIT_MAX);
  }
  return { query, limit };
}

// ── Search core（E10.4 W2 自 handler 提取的复用缝——web_search 与 materials:search-online
//    两消费站；gate/cache 共用模块级单例，同 query 跨通道命中同一缓存）──

export interface WebSearchCoreDeps {
  /** Config loader (default: sidecar readSearchConfig, never throws). */
  loadConfig?: () => SearchConfig;
  /** localhost SearXNG probe (default: probeSearxngLocalhost). */
  probe?: (signal: AbortSignal) => Promise<boolean>;
  /** Fetcher seam for the built adapters (tests inject fixtures). */
  fetcher?: EngineFetcher;
  /** Per-host throttle gate (tests pass a zero-interval gate). */
  gate?: EngineGate;
  /** Same-query cache (tests inject a deterministic-now cache). */
  cache?: LruTtlCache<SearchChainOutcome>;
}

export interface WebSearchCoreResult {
  outcome: SearchChainOutcome;
  /** Built adapter chain（handler 的 empty-chain 分支消费；search-online 不消费）。 */
  adapters: EngineAdapter[];
}

/**
 * web_search 核心：配置读取（读失败回落默认配置）→ localhost SearXNG 探针（探针失败 =
 * miss，从不报错）→ 引擎链执行（first-hit-wins + 全败 friendly failures）。never-throws
 * （链自身吞错——R8）。
 */
export async function runWebSearchCore(
  query: string,
  signal: AbortSignal,
  deps: WebSearchCoreDeps = {},
): Promise<WebSearchCoreResult> {
  const loadConfig = deps.loadConfig ?? readSearchConfig;
  const probe = deps.probe ?? ((probeSignal: AbortSignal) => probeSearxngLocalhost({ signal: probeSignal }));
  const gate = deps.gate ?? defaultSearchGate;
  const cache = deps.cache ?? defaultSearchCache;

  let config: SearchConfig;
  try {
    config = loadConfig();
  } catch {
    config = { ...DEFAULT_SEARCH_CONFIG };
  }

  // Probe the local SearXNG before building the chain — 'searxng-local'
  // only materializes on a hit (probe failure = miss, never an error).
  let probeHit = false;
  if (config.searxngLocalhostProbe !== false) {
    try {
      probeHit = await probe(signal);
    } catch {
      probeHit = false;
    }
  }

  const adapters = buildEngineAdapters(config, { probeHit, fetcher: deps.fetcher });
  const outcome = await runSearchChain(query, config, { adapters, gate, cache, signal });
  return { outcome, adapters };
}

// ── Handler ──

export type WebSearchHandlerDeps = WebSearchCoreDeps;

export function createWebSearchHandler(deps: WebSearchHandlerDeps = {}): ToolHandler {
  const gate = deps.gate ?? defaultSearchGate;
  const cache = deps.cache ?? defaultSearchCache;

  return async ({ params, abort }) => {
    const coerced = coerceSearchParams(params);
    const query = coerced.query?.trim();
    if (!query) {
      return {
        title: 'web_search',
        output: '搜索参数无效，请提供搜索词（query 字符串）。',
        metadata: { count: 0, hits: [], failures: [] },
      };
    }
    const limit = coerced.limit ?? DEFAULT_LIMIT;

    try {
      const { outcome, adapters } = await runWebSearchCore(query, abort, { ...deps, gate, cache });
      if (adapters.length === 0) {
        return {
          title: `web_search: ${query.slice(0, 40)}`,
          output:
            '当前搜索引擎链为空（配置的引擎均未启用）。请在设置「研究与视觉」中启用引擎或配置升级层（SearXNG / Tavily / 博查 / AnySearch）。',
          metadata: { count: 0, hits: [], failures: [], engines: [] },
        };
      }
      const hits = outcome.hits.slice(0, limit);

      let output: string;
      if (hits.length > 0) {
        output = formatSearchOutput(query, hits);
        if (outcome.failures.length > 0) {
          // First engines failed before the winning one — surface the degrade path.
          const degraded = outcome.failures.map((f) => `${f.engine}（${ENGINE_FAILURE_LABELS[f.reason]}）`).join('、');
          output += `\n\n注：以下引擎已自动跳过——${degraded}。`;
        }
      } else {
        output = formatAllFailOutput(query, outcome.failures);
      }

      return {
        title: `web_search: ${query.slice(0, 40)}`,
        output,
        metadata: {
          count: hits.length,
          hits,
          failures: outcome.failures,
          engine: outcome.engine,
          fromCache: outcome.fromCache ?? false,
          engines: adapters.map((a) => a.id),
        },
      };
    } catch (err) {
      // Belt-and-suspenders (R8): the chain itself never throws, but an
      // unforeseen failure must still degrade to a friendly output.
      getLogger().warn({ err: err instanceof Error ? err.message : String(err), query }, 'web_search: unexpected failure');
      return {
        title: `web_search: ${query.slice(0, 40)}`,
        output: `「${query}」搜索失败：${err instanceof Error ? err.message : String(err)}。请稍后重试，或检查网络/代理设置。`,
        metadata: { count: 0, hits: [], failures: [] },
      };
    }
  };
}

// Default handler wired into toolExecution (id aligns with the agent-side
// remoteToolProxy registration in agent/src/tool/builtin.ts).
export const webSearchHandler: ToolHandler = createWebSearchHandler();
