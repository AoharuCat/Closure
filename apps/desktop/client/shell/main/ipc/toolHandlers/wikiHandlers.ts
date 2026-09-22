/**
 * Wiki research tool handlers (Story 3.6 WP3, R1 / design D8).
 *
 * Two READ tools over the MediaWiki protocol, reached via the unified
 * toolExecution channel (agent-side `remoteToolProxy` registrations in
 * agent/src/tool/builtin.ts — ids `wiki_search` / `wiki_read`):
 *
 *   - `wiki_search {query, site?, limit?}` — per-site search strategy from the
 *     site registry: opensearch sites return titles+urls (title-prefix only,
 *     official api.php blocks fulltext), fulltext sites return titles+snippets
 *     (list=search). site='auto' (default) queries both sites sequentially and
 *     merges with exact-title dedup; registry order = priority (official first).
 *   - `wiki_read {title, site?}` — primary = chosen site's rest.php/v1/page
 *     (wikitext + license passthrough, redirects auto-followed by title); on
 *     404/5xx/malformed/network failure degrades to the OTHER site — a
 *     mirror-capable site (fulltextOnMirror) via `api.php?action=parse` (the
 *     scope-mandated mirror path: official api.php parse is blocked, the
 *     mirror's is open), a non-mirror site via its rest.php.
 *
 * NEVER throws (mirror query_craft contract, R8): every network/parse failure
 * degrades to a friendly output so the agent never sees a tool rejection. All
 * outbound goes through `netFetch` (Electron net.fetch — system proxy honored,
 * design D6) behind the per-host `EngineGate` throttle (D9: min interval per
 * wiki host). classifyTool defaults both to 'read' (readonly/suggest/auto).
 *
 * Params are hand-coerced — this package has no direct zod dependency (mirror
 * genreContractHandlers coerce helpers); the agent-side tool definitions carry
 * the zod surface the LLM sees.
 *
 * Testability: `createWikiSearchHandler` / `createWikiReadHandler` accept
 * injectable `fetchJson` (fixture-backed stubs) + a zero-interval `EngineGate`
 * so unit tests run with ZERO network (the Wiki API will drift; tests lock OUR
 * parsing / merge / cleaning / capping / degradation logic only).
 */
import { getLogger } from '../../logger';
import { netFetch } from '../../research/netFetch';
import { assertPublicHttpUrl, EngineGate, urlOrigin } from '../../research/netGuard';
import { loadWikiSites, type WikiSite } from '../../research/wikiSites';
import { readSearchConfig } from '../../research/searchConfig';
import type { ToolHandler, ToolExecuteResponse } from './types';

// ── Constants ──

export const WIKITEXT_CAP = 16_000;
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 10;
/** 站内搜索默认 limit（E10.4 materials:search-online wiki 车道同源引用）。 */
export const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_READ_SITE_ID = 'moegirl-cn';
/**
 * wiki_read degradation budget (P17, CR 2026-08-15): primary + fallback sites
 * share ONE 30s clock — a row of slow sites must not turn a read into a
 * minute-long stall (each individual fetch keeps its own 10s netFetch budget).
 */
export const WIKI_READ_TOTAL_BUDGET_MS = 30_000;

/**
 * Moegirl-family site-wide license (P24, CR 2026-08-15): the mirror
 * `api.php?action=parse` response carries NO license field (unlike rest.php),
 * and the mirror serves moegirl content whose site-wide license is
 * CC BY-NC-SA 3.0 — hard-coded here for the mirror-parse path so provenance
 * stays complete. A non-moegirl custom site with `fulltextOnMirror` would be
 * mislabeled by this constant; such sites should expose rest.php (license
 * passthrough) instead.
 */
export const MOEGIRL_MIRROR_LICENSE: WikiLicense = {
  title: 'CC BY-NC-SA 3.0',
  url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/',
};

/** Module-level per-host throttle shared by both default handlers (D9). */
const defaultWikiGate = new EngineGate();

// ── Types ──

export interface WikiSearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Site registry id the hit came from (provenance for the LLM). */
  site: string;
}

export interface WikiLicense {
  title: string;
  url: string;
}

/** One fetch outcome — failures carry a friendly reason, never a throw. */
export interface WikiJsonResult {
  ok: boolean;
  status: number;
  /** Parsed JSON body when the response was 2xx JSON. */
  json?: unknown;
  /** Friendly failure reason when `ok` is false (or an api.php error object). */
  error?: string;
}

export type WikiJsonFetcher = (url: string, signal: AbortSignal) => Promise<WikiJsonResult>;

export interface WikiHandlerDeps {
  /**
   * Site registry seam (tests inject a fixed list). Default resolves PER CALL:
   * presets + the user's custom-site overrides from the search-config sidecar
   * (WP10 settings page), so a settings edit takes effect on the next tool
   * invocation without an app restart.
   */
  sites?: readonly WikiSite[];
  /** Per-host throttle gate (tests pass a zero-interval gate). */
  gate?: EngineGate;
  /** JSON fetcher seam (tests inject fixture-backed stubs; default netFetch-backed). */
  fetchJson?: WikiJsonFetcher;
  /**
   * SSRF guard seam (P10, CR 2026-08-15): every wiki outbound URL is guarded
   * before fetch — user-configured site origins ride the allowlist (trust =
   * JOIN the allowlist, never bypass the guard). Tests inject a pass-through.
   */
  guard?: (url: string, allowlist: readonly string[]) => Promise<void>;
  /** Injectable clock for the wiki_read total-budget matrix (P17). */
  now?: () => number;
}

/** Default site resolution: presets + user overrides (per call, see WikiHandlerDeps.sites). */
function resolveActiveSites(): readonly WikiSite[] {
  return loadWikiSites(readSearchConfig().wikiSitesOverrides);
}

/**
 * Origin-level allowlist for wiki outbound (P10): each ACTIVE site's
 * apiBaseUrl origin. Preset hosts are public domains and pass the guard on
 * their own; a custom site pointed at an internal MediaWiki (private host)
 * is trusted exactly at its configured origin — never a guard bypass.
 */
export function wikiOutboundAllowlist(sites: readonly WikiSite[]): string[] {
  const origins: string[] = [];
  for (const site of sites) {
    try {
      origins.push(urlOrigin(new URL(site.apiBaseUrl)));
    } catch {
      // Malformed base URL — the schema (.url(), P10) rejects it at the
      // boundary; a stale hand-edited sidecar entry just gets no entry.
    }
  }
  return origins;
}

// ── URL builders (exported for tests) ──

export function opensearchUrl(site: WikiSite, query: string, limit: number): string {
  return `${site.apiBaseUrl}/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${limit}&format=json`;
}

export function fulltextSearchUrl(site: WikiSite, query: string, limit: number): string {
  return `${site.apiBaseUrl}/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json`;
}

export function parsePageUrl(site: WikiSite, title: string): string {
  return `${site.apiBaseUrl}/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`;
}

export function restPageUrl(site: WikiSite, title: string): string {
  return `${site.apiBaseUrl}/rest.php/v1/page/${encodeURIComponent(title)}`;
}

/**
 * Human-facing article URL for hits that arrive WITHOUT one (list=search gives
 * no urls). Moegirl-family sites serve articles at the root path
 * (`https://zh.moegirl.org.cn/阿米娅`); opensearch hits always carry the
 * API-provided url and never use this construction.
 */
export function articleUrl(site: WikiSite, title: string): string {
  return `${site.apiBaseUrl}/${encodeURIComponent(title)}`;
}

// ── Response parsing (exported for tests; shapes = 2026-08-15 本机实探 fixtures) ──

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * opensearch response: `[term, titles[], descs[], urls[]]`. descs/urls may be
 * absent on some MediaWiki (older servers return `[term, titles]` only) —
 * tolerated: missing urls fall back to constructed article URLs, missing
 * descs to an empty snippet.
 */
export function parseOpenSearchResponse(json: unknown, site: WikiSite): WikiSearchHit[] {
  if (!Array.isArray(json) || json.length < 2) return [];
  const titles = asStringArray(json[1]);
  const descs = json.length > 2 ? asStringArray(json[2]) : [];
  const urls = json.length > 3 ? asStringArray(json[3]) : [];
  return titles.map((title, i) => ({
    title,
    url: urls[i] || articleUrl(site, title),
    snippet: cleanSnippet(descs[i] ?? ''),
    site: site.id,
  }));
}

/**
 * list=search response: `{ query: { search: [{ title, snippet, ... }] } }`.
 * snippet carries `<span class="searchmatch">` HTML — stripped for the LLM.
 */
export function parseFulltextSearchResponse(json: unknown, site: WikiSite): WikiSearchHit[] {
  if (typeof json !== 'object' || json === null) return [];
  const query = (json as Record<string, unknown>).query;
  if (typeof query !== 'object' || query === null) return [];
  const search = (query as Record<string, unknown>).search;
  if (!Array.isArray(search)) return [];
  const hits: WikiSearchHit[] = [];
  for (const entry of search) {
    if (typeof entry !== 'object' || entry === null) continue;
    const title = (entry as Record<string, unknown>).title;
    if (typeof title !== 'string' || !title) continue;
    const snippet = (entry as Record<string, unknown>).snippet;
    hits.push({
      title,
      url: articleUrl(site, title),
      snippet: cleanSnippet(typeof snippet === 'string' ? snippet : ''),
      site: site.id,
    });
  }
  return hits;
}

/** rest.php/v1/page response: `{ title, source (wikitext), license: {url,title}, ... }`. */
export function parseRestPage(json: unknown): { title: string; wikitext: string; license?: WikiLicense } | null {
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  const source = typeof obj.source === 'string' ? obj.source : '';
  if (!source) return null;
  let license: WikiLicense | undefined;
  if (typeof obj.license === 'object' && obj.license !== null) {
    const raw = obj.license as Record<string, unknown>;
    const title = typeof raw.title === 'string' ? raw.title : '';
    const url = typeof raw.url === 'string' ? raw.url : '';
    if (title || url) license = { title, url };
  }
  return { title: typeof obj.title === 'string' ? obj.title : '', wikitext: source, license };
}

/** api.php parse response: `{ parse: { title, wikitext: { '*': wikitext }, ... } }`. */
export function extractParseWikitext(json: unknown): { title: string; wikitext: string } | null {
  if (typeof json !== 'object' || json === null) return null;
  const parse = (json as Record<string, unknown>).parse;
  if (typeof parse !== 'object' || parse === null) return null;
  const rec = parse as Record<string, unknown>;
  const wikitext = typeof rec.wikitext === 'object' && rec.wikitext !== null
    ? (rec.wikitext as Record<string, unknown>)['*']
    : undefined;
  if (typeof wikitext !== 'string' || !wikitext) return null;
  return { title: typeof rec.title === 'string' ? rec.title : '', wikitext };
}

/** api.php error object (`{ error: { code, info } }`) → friendly reason, if present. */
export function extractApiError(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const err = (json as Record<string, unknown>).error;
  if (typeof err !== 'object' || err === null) return undefined;
  const rec = err as Record<string, unknown>;
  const code = typeof rec.code === 'string' ? rec.code : undefined;
  const info = typeof rec.info === 'string' ? rec.info : undefined;
  if (!code && !info) return undefined;
  return info ? `${code ?? 'api-error'}：${info}` : (code ?? 'api-error');
}

// ── Cleaning / capping (exported for tests) ──

/** Strip searchmatch HTML tags + basic entities (incl. MediaWiki's &nbsp;) + collapse whitespace. */
export function cleanSnippet(raw: string): string {
  // &amp; decodes LAST so double-encoded entities don't over-decode.
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Light wikitext cleaning (D8): remove `<ref>…</ref>` (incl. self-closing) +
 * HTML comments + hidden `display:none` div blocks; collapse consecutive
 * whitespace; trim both sides. TEMPLATES (`{{…}}`) are deliberately KEPT —
 * they are LLM-readable and parsing them is out of scope (template tolerance).
 *
 * Known limit (accepted): the hidden-div regex is non-greedy, so a display:none
 * div NESTING another div stops at the inner `</div>` — nested hidden divs are
 * rare in article wikitext; residual markup is harmless noise for the LLM.
 */
export function cleanWikitext(wikitext: string): string {
  let text = wikitext;
  text = text.replace(/<!--[\s\S]*?-->/g, ''); // HTML comments (multiline)
  text = text.replace(/<ref[\s\S]*?<\/ref>/gi, ''); // <ref>…</ref> (multiline)
  text = text.replace(/<ref\b[^>]*\/>/gi, ''); // self-closing <ref name=x />
  text = text.replace(/<div\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/div>/gi, ''); // hidden divs
  text = text.replace(/[^\S\n]+/g, ' '); // collapse horizontal whitespace runs (keep newlines)
  text = text.replace(/ ?\n/g, '\n'); // strip trailing spaces before newlines
  text = text.replace(/\n /g, '\n'); // strip line-leading indentation (single space post-collapse)
  text = text.replace(/\n{3,}/g, '\n\n'); // collapse blank-line runs to one blank line
  return text.trim();
}

/** Cap cleaned wikitext, appending the scope-mandated truncation tail note. */
export function capWikitext(text: string, fullUrl: string, cap: number = WIKITEXT_CAP): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return { text: `${text.slice(0, cap)}…\n\n[已截断，全文：${fullUrl}]`, truncated: true };
}

// ── Merge / format (exported for tests) ──

/**
 * Merge per-site hit lists with EXACT-title dedup. Groups must arrive in
 * priority order (registry order — official first); the first occurrence of a
 * title wins (official priority, D8).
 */
export function mergeSearchHits(
  groups: ReadonlyArray<{ site: WikiSite; hits: readonly WikiSearchHit[] }>,
): WikiSearchHit[] {
  const seen = new Set<string>();
  const out: WikiSearchHit[] = [];
  for (const group of groups) {
    for (const hit of group.hits) {
      if (seen.has(hit.title)) continue;
      seen.add(hit.title);
      out.push({ ...hit });
    }
  }
  return out;
}

/** Markdown hit list: numbered title+site, URL, optional snippet; notes last. */
export function formatSearchOutput(query: string, hits: readonly WikiSearchHit[], notes: readonly string[] = []): string {
  const head = `「${query}」的 wiki 搜索结果（${hits.length} 条）：`;
  const blocks = hits.map((hit, i) => {
    const lines = [`${i + 1}. **${hit.title}**（${hit.site}）`, `   ${hit.url}`];
    if (hit.snippet) lines.push(`   ${hit.snippet}`);
    return lines.join('\n');
  });
  const parts = [head, ...blocks];
  if (notes.length > 0) parts.push('', notes.join('\n'));
  return parts.join('\n\n');
}

// ── Fetch seam ──

/**
 * Default fetcher: netFetch → text → JSON.parse. Never throws — transport
 * failures (ResearchNetworkError incl. timeout/abort), non-2xx, and non-JSON
 * 2xx bodies all come back as `{ ok:false, error }` / json-less results the
 * callers degrade on. A 2xx body that parses but carries an api.php `error`
 * object is surfaced via `extractApiError` at the call site.
 */
export async function netFetchJson(url: string, signal: AbortSignal): Promise<WikiJsonResult> {
  try {
    const res = await netFetch(url, { signal });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    try {
      return { ok: true, status: res.status, json: JSON.parse(text) as unknown };
    } catch {
      // 2xx non-JSON body — callers shape-check json and degrade.
      return { ok: true, status: res.status };
    }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Shared helpers ──

function siteHost(site: WikiSite): string {
  try {
    return new URL(site.apiBaseUrl).hostname;
  } catch {
    return site.id;
  }
}

function resolveTargetSites(sites: readonly WikiSite[], siteId: string | undefined): WikiSite[] {
  if (!siteId || siteId === 'auto') return [...sites];
  const found = sites.find((s) => s.id === siteId);
  return found ? [found] : [];
}

function knownSiteList(sites: readonly WikiSite[]): string {
  return sites.map((s) => s.id).join('、');
}

function describeFetchFailure(res: WikiJsonResult): string {
  if (!res.ok) return res.error ?? `HTTP ${res.status}`;
  if (res.json === undefined) return '响应不是合法 JSON';
  const apiError = extractApiError(res.json);
  if (apiError) return apiError;
  return '响应格式异常';
}

// ── wiki_search handler ──

/**
 * Hand-coerced search params (no zod in this package — mirror
 * genreContractHandlers coerce helpers). Invalid shapes → undefined fields the
 * handler degrades on; limit is clamped into [1, 10] (LLM params never reach
 * a URL raw).
 */
export function coerceSearchParams(
  params: Record<string, unknown>,
): { query?: string; site?: string; limit?: number } {
  const query = typeof params.query === 'string' ? params.query : undefined;
  const site = typeof params.site === 'string' && params.site.length > 0 ? params.site : undefined;
  let limit: number | undefined;
  if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
    limit = Math.min(Math.max(Math.round(params.limit), SEARCH_LIMIT_MIN), SEARCH_LIMIT_MAX);
  }
  return { query, site, limit };
}

/** One per-site search outcome（E10.4 materials:search-online 合并消费面）。 */
export interface WikiSiteSearchEntry {
  site: WikiSite;
  hits: WikiSearchHit[];
  error?: string;
}

export interface WikiSiteSearchInput {
  /** 本轮目标站（handler = resolveTargetSites 结果；search-online = 全注册表）。 */
  sites: readonly WikiSite[];
  query: string;
  limit: number;
  /** SSRF allowlist（调用方按 wikiOutboundAllowlist(sites) 装配——信任=加入 allowlist）。 */
  allowlist: readonly string[];
  signal: AbortSignal;
  /** Per-host throttle gate（缺省模块级 defaultWikiGate）。 */
  gate?: EngineGate;
  /** JSON fetcher seam（缺省 netFetchJson）。 */
  fetchJson?: WikiJsonFetcher;
  /** SSRF guard seam（缺省 assertPublicHttpUrl）。 */
  guard?: (url: string, allowlist: readonly string[]) => Promise<void>;
}

/**
 * Per-site wiki 搜索核心（E10.4 W2 自 createWikiSearchHandler 提取的复用面——wiki_search
 * handler 与 materials:search-online 两消费站）：逐站顺序（registry 序 = 优先级；per-host
 * gate 节流），单站失败落 error 不抛（never-throws，调用方汇总 notes）。
 */
export async function runWikiSiteSearches(input: WikiSiteSearchInput): Promise<WikiSiteSearchEntry[]> {
  const gate = input.gate ?? defaultWikiGate;
  const fetchJson = input.fetchJson ?? netFetchJson;
  const guard = input.guard ?? assertPublicHttpUrl;
  const perSite: WikiSiteSearchEntry[] = [];
  for (const site of input.sites) {
    if (input.signal.aborted) break; // P17 symmetry: stop between sites on abort
    const url = site.searchKind === 'fulltext'
      ? fulltextSearchUrl(site, input.query, input.limit)
      : opensearchUrl(site, input.query, input.limit);
    await gate.acquire(siteHost(site));
    let guarded: WikiJsonResult | null = null;
    try {
      await guard(url, input.allowlist);
    } catch (err) {
      guarded = { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
    const res = guarded ?? await fetchJson(url, input.signal);
    if (!res.ok || res.json === undefined || extractApiError(res.json) !== undefined) {
      perSite.push({ site, hits: [], error: describeFetchFailure(res) });
    } else {
      const hits = site.searchKind === 'fulltext'
        ? parseFulltextSearchResponse(res.json, site)
        : parseOpenSearchResponse(res.json, site);
      perSite.push({ site, hits });
    }
  }
  return perSite;
}

export function createWikiSearchHandler(deps: WikiHandlerDeps = {}): ToolHandler {
  const resolveSites = (): readonly WikiSite[] => deps.sites ?? resolveActiveSites();
  const gate = deps.gate ?? defaultWikiGate;
  const fetchJson = deps.fetchJson ?? netFetchJson;
  const guard = deps.guard ?? assertPublicHttpUrl;

  return async ({ params, abort }) => {
    const sites = resolveSites();
    const coerced = coerceSearchParams(params);
    const query = coerced.query?.trim();
    if (!query) {
      return { title: 'wiki_search', output: '搜索参数无效，请提供搜索词（query 字符串）。', metadata: { count: 0, hits: [] } };
    }
    const limit = coerced.limit ?? DEFAULT_SEARCH_LIMIT;

    const targets = resolveTargetSites(sites, coerced.site);
    if (targets.length === 0) {
      return {
        title: 'wiki_search',
        output: `未知站点「${coerced.site}」。可用站点：${knownSiteList(sites)}，或 site='auto'（默认，双站合并去重）。`,
        metadata: { count: 0, hits: [] },
      };
    }

    const allowlist = wikiOutboundAllowlist(sites);
    // Sequential per-site queries (registry order = priority; the per-host gate
    // spaces repeat calls to the same host, different hosts don't wait).
    const perSite = await runWikiSiteSearches({ sites: targets, query, limit, allowlist, signal: abort, gate, fetchJson, guard });

    const merged = mergeSearchHits(perSite.map((p) => ({ site: p.site, hits: p.hits }))).slice(0, limit);
    const notes: string[] = [];
    const errors: { site: string; error: string }[] = [];
    for (const p of perSite) {
      if (p.error) {
        notes.push(`${p.site.name}（${p.site.id}）查询失败：${p.error}`);
        errors.push({ site: p.site.id, error: p.error });
      }
    }
    const opensearchMissed = perSite.some((p) => p.site.searchKind === 'opensearch' && !p.error && p.hits.length === 0);
    const prefixHint = "提示：官方站仅支持标题前缀搜索——可尝试更短的前缀，或指定 site='moegirl-uk' 用镜像站全文搜索。";

    let output: string;
    if (merged.length === 0) {
      output = `未找到与「${query}」相关的词条。`;
      if (opensearchMissed) output += `\n${prefixHint}`;
      if (notes.length > 0) output += `\n${notes.join('\n')}`;
    } else {
      if (opensearchMissed) notes.push('注：官方站（前缀搜索）无命中，以上结果来自镜像站全文搜索。');
      output = formatSearchOutput(query, merged, notes);
    }

    return {
      title: `wiki_search: ${query.slice(0, 40)}`,
      output,
      metadata: { count: merged.length, hits: merged, errors },
    };
  };
}

// ── wiki_read handler ──

interface ReadSuccessArgs {
  site: WikiSite;
  url: string;
  pageTitle: string;
  wikitext: string;
  license?: WikiLicense;
  via: 'rest' | 'rest-fallback' | 'mirror-parse';
}

function buildReadSuccess(args: ReadSuccessArgs): ToolExecuteResponse {
  const cleaned = cleanWikitext(args.wikitext);
  const { text, truncated } = capWikitext(cleaned, args.url);
  const lines = [
    `# ${args.pageTitle}`,
    '',
    text,
    '',
    '---',
    `来源: ${args.url}`,
  ];
  if (args.license && (args.license.title || args.license.url)) {
    lines.push(`许可: ${args.license.title}${args.license.url ? `（${args.license.url}）` : ''}`);
  }
  lines.push(`检索日期: ${new Date().toISOString().slice(0, 10)}`);
  if (args.via === 'mirror-parse') {
    lines.push(`备注: 主站读取失败，已降级镜像站（${args.site.name}）api.php 解析。`);
  } else if (args.via === 'rest-fallback') {
    lines.push(`备注: 主站读取失败，已降级备用站（${args.site.name}）。`);
  }
  return {
    title: `wiki_read: ${args.pageTitle.slice(0, 40)}`,
    output: lines.join('\n'),
    metadata: {
      title: args.pageTitle,
      site: args.site.id,
      url: args.url,
      license: args.license,
      chars: text.length,
      truncated,
      via: args.via,
    },
  };
}

export function createWikiReadHandler(deps: WikiHandlerDeps = {}): ToolHandler {
  const resolveSites = (): readonly WikiSite[] => deps.sites ?? resolveActiveSites();
  const gate = deps.gate ?? defaultWikiGate;
  const fetchJson = deps.fetchJson ?? netFetchJson;
  const guard = deps.guard ?? assertPublicHttpUrl;
  const now = deps.now ?? Date.now;

  /** Guarded fetch: an SSRF block degrades into a failed WikiJsonResult. */
  const guardedFetch = async (
    url: string,
    allowlist: readonly string[],
    signal: AbortSignal,
  ): Promise<WikiJsonResult> => {
    try {
      await guard(url, allowlist);
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
    return fetchJson(url, signal);
  };

  return async ({ params, abort }) => {
    const sites = resolveSites();
    const title = typeof params.title === 'string' ? params.title.trim() : '';
    if (!title) {
      return {
        title: 'wiki_read',
        output: '参数无效，请提供词条标题（title 字符串）。建议先用 wiki_search 拿准确标题——词条名常用全角括号，如「阿米娅（明日方舟）」。',
        metadata: { title: '', error: 'invalid-params' },
      };
    }
    const siteId = typeof params.site === 'string' && params.site.length > 0 ? params.site : DEFAULT_READ_SITE_ID;
    const primary = sites.find((s) => s.id === siteId);
    if (!primary) {
      return {
        title: `wiki_read: ${title}`,
        output: `未知站点「${siteId}」。可用站点：${knownSiteList(sites)}。`,
        metadata: { title, site: siteId, error: 'unknown-site' },
      };
    }

    const allowlist = wikiOutboundAllowlist(sites);
    const startedAt = now();
    const budgetLeft = (): boolean => now() - startedAt <= WIKI_READ_TOTAL_BUDGET_MS;

    // 1) Primary: rest.php/v1/page — wikitext + license, redirects auto-followed.
    const restUrl = restPageUrl(primary, title);
    await gate.acquire(siteHost(primary));
    const primaryRes = await guardedFetch(restUrl, allowlist, abort);
    const primaryPage = primaryRes.ok && primaryRes.json !== undefined ? parseRestPage(primaryRes.json) : null;
    if (primaryPage) {
      return buildReadSuccess({
        site: primary,
        url: restUrl,
        pageTitle: primaryPage.title || title,
        wikitext: primaryPage.wikitext,
        license: primaryPage.license,
        via: 'rest',
      });
    }
    const primaryError = describeFetchFailure(primaryRes);
    getLogger().warn({ site: primary.id, title, error: primaryError }, 'wiki_read: primary source failed');

    // 2) Degradation: try every OTHER site — mirror-capable sites via
    //    api.php?action=parse (D8 mirror path), others via their rest.php.
    //    P17: the loop honors the tool abort (each site reports「已取消」) and
    //    ONE 30s total budget across primary + all fallbacks.
    const failures: string[] = [`${primary.name}：${primaryError}`];
    let aborted = false;
    for (const fallback of sites) {
      if (fallback.id === primary.id) continue;
      if (abort.aborted) {
        aborted = true;
        break;
      }
      if (!budgetLeft()) {
        failures.push(`降级总预算耗尽（${WIKI_READ_TOTAL_BUDGET_MS}ms），剩余站点未尝试。`);
        break;
      }
      const useParse = fallback.fulltextOnMirror === true;
      const fallbackUrl = useParse ? parsePageUrl(fallback, title) : restPageUrl(fallback, title);
      await gate.acquire(siteHost(fallback));
      const res = await guardedFetch(fallbackUrl, allowlist, abort);
      if (!res.ok || res.json === undefined || extractApiError(res.json) !== undefined) {
        failures.push(`${fallback.name}：${describeFetchFailure(res)}`);
        continue;
      }
      if (useParse) {
        const parsed = extractParseWikitext(res.json);
        if (!parsed) {
          failures.push(`${fallback.name}：响应格式异常`);
          continue;
        }
        return buildReadSuccess({
          site: fallback,
          url: fallbackUrl,
          pageTitle: parsed.title || title,
          wikitext: parsed.wikitext,
          // P24: api.php parse carries no license field — the mirror serves
          // moegirl content whose site-wide license is CC BY-NC-SA 3.0.
          license: MOEGIRL_MIRROR_LICENSE,
          via: 'mirror-parse',
        });
      }
      const page = parseRestPage(res.json);
      if (!page) {
        failures.push(`${fallback.name}：响应格式异常`);
        continue;
      }
      return buildReadSuccess({
        site: fallback,
        url: fallbackUrl,
        pageTitle: page.title || title,
        wikitext: page.wikitext,
        license: page.license,
        via: 'rest-fallback',
      });
    }

    // 3) Every source failed — friendly summary, never a throw (R8). P17: an
    //    aborted run is「已取消」, not「全站失败」.
    if (aborted || abort.aborted) {
      return {
        title: `wiki_read: ${title}`,
        output: `词条「${title}」读取已取消。`,
        metadata: { title, site: primary.id, error: 'aborted' },
      };
    }
    getLogger().warn({ title, failures }, 'wiki_read: all sources failed');
    return {
      title: `wiki_read: ${title}`,
      output: `词条「${title}」读取失败：\n${failures.map((f) => `- ${f}`).join('\n')}\n可先用 wiki_search 确认准确标题（词条名常用全角括号），或稍后重试。`,
      metadata: { title, site: primary.id, error: failures.join('；') },
    };
  };
}

// Default handlers wired into toolExecution (ids align with the agent-side
// remoteToolProxy registrations in agent/src/tool/builtin.ts).
export const wikiSearchHandler: ToolHandler = createWikiSearchHandler();
export const wikiReadHandler: ToolHandler = createWikiReadHandler();
