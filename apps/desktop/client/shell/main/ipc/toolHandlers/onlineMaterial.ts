/**
 * E10.4 在线解析生态（W2）：在线拉取通道抽取核心 + 关键词发现合并核心。
 *
 * 本模块持有两块**零网络可测**的核心（materialIpc 两 handler 的实现底座，design §1.1/§1.2）：
 *
 *  1. `fetchOnlinePageAsMarkdown`——research session 拉原始 HTML（netFetchPage：SSRF 逐跳
 *     守卫 + 2MB body cap，零新网络面）→ **MoeSkin template 预解包**（W0 spike 根因：
 *     TURNDOWN_REMOVED_TAGS 含 'template' 连子树移除，萌娘正文 0% 存活；解包后 337K 正文
 *     完整可转）→ 复用 `htmlToMarkdown` 静态抽取 → 40 万字符级截断（如实附尾注）。
 *     ⚠ 勿走 web_fetch 工具入口——其 16-32K 输出 cap 是 LLM 预算；⚠ 勿改全局
 *     TURNDOWN_REMOVED_TAGS——web_fetch 工具语义不动。
 *  2. `searchOnlineSourcesCore`——web_search（runWebSearchCore）与 wiki_search
 *     （runWikiSiteSearches）既有核心并发 → 合并去重（mirror wikiHandlers mergeSearchHits
 *     形态），零 LLM；host 命中 wiki 注册表给 community-wiki 类别预填提示。
 *
 * 纯函数面（unpack / 类别映射 / stem 派生 / 标题与元数据提取）独立导出供矩阵测试钉死。
 *
 * expected_downstream_consumers:
 * - materialIpc（materials:import-online / materials:search-online 两通道——W4 UI「在线导入」
 *   弹窗经它触达）。
 * - 同1.1 社区源摄取执行面（canon 共识整合归同1.1，design §4）。
 */
import { createHash } from 'node:crypto';
import { sanitizeDiskName } from '@orison/shared-contracts/fs/naming';
import { ONLINE_IMPORT_MAX_TEXT_CHARS } from '@orison/shared-contracts';
import type { MaterialOnlineCategory, OnlineSourceHit } from '@orison/shared-contracts';
import { readSearchConfig } from '../../research/searchConfig';
import { loadWikiSites } from '../../research/wikiSites';
import { ResearchNetworkError } from '../../research/netFetch';
import { assertPublicHttpUrl } from '../../research/netGuard';
import {
  WEB_FETCH_MAX_BYTES,
  capFetchedText,
  classifyContentType,
  htmlToMarkdown,
  netFetchPage,
  researchFetchAllowlist,
  type FetchedPage,
  type PageFetcher,
} from './fetchHandlers';
import { runWebSearchCore } from './searchHandlers';
import {
  DEFAULT_SEARCH_LIMIT,
  netFetchJson,
  runWikiSiteSearches,
  wikiOutboundAllowlist,
  type WikiSearchHit,
} from './wikiHandlers';
// ── 常量 ──

/** 在线材料车道目录（materials/ 根内相对段——pathGuard 界内，watcher/backfill 天然覆盖）。 */
export const ONLINE_SOURCE_DIR = 'online';

/** MoeSkin 皮肤正文模板 id（W0 spike 实证：萌娘页全文唯一 open/close 对，包裹全部正文）。 */
export const MOE_SKIN_TEMPLATE_BODYCONTENT_ID = 'MOE_SKIN_TEMPLATE_BODYCONTENT';

/**
 * 在线抽取正文字符帽（40 万）——契约单源 shared-contracts `ONLINE_IMPORT_MAX_TEXT_CHARS`
 * （CR-10：抽取与截断注记同源消费，本模块不再本地定义）。
 */

/** 近空守卫阈：抽取后去空白不足此数 = 模板壳/JS 渲染页无可提取正文（empty-content 档）。 */
export const ONLINE_EMPTY_CONTENT_MIN_CHARS = 50;

/** 合并结果默认上限（limit 省略值——契约「引擎默认，W2 定值」）；单车道各按引擎默认 10。 */
export const DEFAULT_ONLINE_SEARCH_LIMIT = 20;
/** 合并结果上限钳制（防 renderer 传天文数字胀 IPC 载荷）。 */
export const ONLINE_SEARCH_LIMIT_MAX = 50;
/** wiki 车道单次搜索站内 limit（引擎默认 10，wikiHandlers DEFAULT_SEARCH_LIMIT 同源引用）。 */
export const ONLINE_PER_LANE_SEARCH_LIMIT = DEFAULT_SEARCH_LIMIT;

/** 本模块外呼共用的外部 signal（netFetch 自带 10s 超时预算；IPC handler 无 abort 面）。 */
const neverAbort = new AbortController().signal;

// ── 类别 → provenance 预填映射（R3，design §1.1 表）──

export interface OnlineCategoryDefaults {
  medium: string;
  tier: 'original' | 'community' | 'criticism' | 'unspecified';
}

/**
 * 类别 → medium/tier 预填（UI 选择预填可改）：社区 wiki→wiki/community；批评评论→criticism/
 * criticism；作者访谈→interview/original（作者一手来源）；其他→other/unspecified。
 * 非法类别 = 编程错误（IPC 边界已按 MATERIAL_ONLINE_CATEGORIES 收窄）→ throw（模式 B）。
 */
export function categoryToProvenanceDefaults(category: MaterialOnlineCategory): OnlineCategoryDefaults {
  switch (category) {
    case 'community-wiki':
      return { medium: 'wiki', tier: 'community' };
    case 'criticism':
      return { medium: 'criticism', tier: 'criticism' };
    case 'author-interview':
      return { medium: 'interview', tier: 'original' };
    case 'other':
      return { medium: 'other', tier: 'unspecified' };
    default: {
      const exhaustive: never = category;
      throw new Error(`未知在线类别：${String(exhaustive)}`);
    }
  }
}

// ── MoeSkin template 预解包（W0 spike 根因修复）──

const TEMPLATE_OPEN = '<template';
const TEMPLATE_CLOSE = '</template';

/** 标签名边界（CR-6①）：token 后随字母/数字/-/_ → 是更长的标签名（如 `<templates`），不算本标签。 */
const TAG_NAME_TAIL_RE = /[A-Za-z0-9_-]/;

interface CommentRange {
  start: number;
  end: number;
}

/** HTML 注释区间表（`<!-- … -->` 非重叠递增；未闭合注释吞到文末）。 */
function commentRangesOf(html: string): CommentRange[] {
  const ranges: CommentRange[] = [];
  const re = /<!--[\s\S]*?(?:-->|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

/** ASCII-only 小写副本（长度恒等——JS `toLowerCase` 对个别 Unicode 大写有长度变化，会错位索引）。 */
function asciiLower(html: string): string {
  return html.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

/**
 * 找下一个模板标签 token（CR-6 三护合一）：大小写不敏感（lower 副本扫描、原文按下标切片）；
 * 注释区间内的 `<template`/`</template` 字面量跳过不计（CR-6③——深度错算根）；标签名边界
 * 校验（`<templates` 不算 `<template`，CR-6①）。找不到返回 -1。
 * 已知残余：属性值内的字面量（如 `data-x="</template>"`）不做属性级解析，仍计入——真实页
 * 面属性携带模板标签字面量罕见，残余风险接受（与畸形页原文直过的防御面同级）。
 */
function findTemplateToken(
  html: string,
  lowerHtml: string,
  token: string,
  from: number,
  comments: CommentRange[],
): number {
  let cursor = from;
  while (cursor <= html.length) {
    const idx = lowerHtml.indexOf(token, cursor);
    if (idx === -1) return -1;
    const range = comments.find((r) => idx >= r.start && idx < r.end);
    if (range !== undefined) {
      cursor = range.end; // 注释内字面量——整段跳过（防注释连发逐字符重扫）
      continue;
    }
    const tail = lowerHtml.charAt(idx + token.length);
    if (tail !== '' && TAG_NAME_TAIL_RE.test(tail)) {
      cursor = idx + token.length; // 标签名近形（<templates）——越过继续找
      continue;
    }
    return idx;
  }
  return -1;
}

/**
 * 展开 html 中位于 openStart 的单个 `<template…>…</template>`（包裹层剥除、innerHTML 原位
 * 还原）。深度配平扫描找配对 close（子级 template 计入深度——naive indexOf 会被提前截断；
 * 扫描走 findTemplateToken 三护）；未配平/畸形 → null（调用方原文直过）。
 */
function expandTemplateAt(
  html: string,
  lowerHtml: string,
  comments: CommentRange[],
  openStart: number,
): string | null {
  const openEnd = html.indexOf('>', openStart);
  if (openEnd === -1) return null;
  let depth = 1;
  let cursor = openEnd + 1;
  let closeStart = -1;
  while (cursor <= html.length) {
    const nextOpen = findTemplateToken(html, lowerHtml, TEMPLATE_OPEN, cursor, comments);
    const nextClose = findTemplateToken(html, lowerHtml, TEMPLATE_CLOSE, cursor, comments);
    if (nextClose === -1) return null; // 未配平
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + TEMPLATE_OPEN.length;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      closeStart = nextClose;
      break;
    }
    cursor = nextClose + TEMPLATE_CLOSE.length;
  }
  if (closeStart === -1) return null;
  const closeEnd = html.indexOf('>', closeStart);
  if (closeEnd === -1) return null;
  return html.slice(0, openStart) + html.slice(openEnd + 1, closeStart) + html.slice(closeEnd + 1);
}

/**
 * 前置展开 MoeSkin 正文模板：`<template id="MOE_SKIN_TEMPLATE_BODYCONTENT">…</template>`
 * 包裹层剥除、innerHTML 原位还原为文档直挂节点。turndown 的 TURNDOWN_REMOVED_TAGS 含
 * 'template'——不展开则正文子树整段被移除（W0 spike：萌娘官方站抽取恒 266 字符 = 标题 +
 * beacon，正文 0% 存活；#mw-content-text 位于 template 内部）。包裹层**内部**嵌套的
 * template 一并展开（子模板内容同为页面正文——不展开则仍被 turndown 连子树移除）；
 * 包裹层之外的 template 不动（可能是页面自用的隐藏存储，内容非正文）。
 *
 * 防御面：无 template / 未配平 / id 属于非 template 元素 → 原文直过（零改写，不让畸形页炸
 * 抽取）；展开环带迭代上限（防御病态深嵌套）。
 */
export function unpackMoeSkinTemplate(html: string): string {
  const marker = `id="${MOE_SKIN_TEMPLATE_BODYCONTENT_ID}"`;
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return html;
  const lowerHtml = asciiLower(html);
  const comments = commentRangesOf(html);
  // id 前最近的 template open（三护扫描——lastIndexOf 换 findTemplateToken：大小写/边界/注释）。
  let openStart = -1;
  let scan = 0;
  while (scan <= markerIdx) {
    const found = findTemplateToken(html, lowerHtml, TEMPLATE_OPEN, scan, comments);
    if (found === -1 || found > markerIdx) break;
    openStart = found;
    scan = found + TEMPLATE_OPEN.length;
  }
  if (openStart === -1) return html;
  // id 必须仍在本 open 标签内（open 与 id 之间不得先出现 '>'——否则 id 属于后随的其他元素）。
  const openTagGt = html.indexOf('>', openStart);
  if (openTagGt !== -1 && openTagGt < markerIdx) return html;
  const openEnd = html.indexOf('>', markerIdx);
  if (openEnd === -1) return html;
  // 深度配平扫描：找与本 open 配对的 close（子级 template 计入深度）。
  let depth = 1;
  let cursor = openEnd + 1;
  let closeStart = -1;
  while (cursor <= html.length) {
    const nextOpen = findTemplateToken(html, lowerHtml, TEMPLATE_OPEN, cursor, comments);
    const nextClose = findTemplateToken(html, lowerHtml, TEMPLATE_CLOSE, cursor, comments);
    if (nextClose === -1) return html; // 未配平——原文直过
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + TEMPLATE_OPEN.length;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      closeStart = nextClose;
      break;
    }
    cursor = nextClose + TEMPLATE_CLOSE.length;
  }
  if (closeStart === -1) return html;
  const closeEnd = html.indexOf('>', closeStart);
  if (closeEnd === -1) return html;
  // 包裹层内的嵌套 template 逐个展开（带迭代上限；展开不了的原样保留——诚实降级不炸抽取）。
  let inner = html.slice(openEnd + 1, closeStart);
  for (let guard = 0; guard < 32; guard += 1) {
    const nested = findTemplateToken(inner, asciiLower(inner), TEMPLATE_OPEN, 0, commentRangesOf(inner));
    if (nested === -1) break;
    const expanded = expandTemplateAt(inner, asciiLower(inner), commentRangesOf(inner), nested);
    if (expanded === null) break;
    inner = expanded;
  }
  return html.slice(0, openStart) + inner + html.slice(closeEnd + 1);
}

// ── 标题 / 元数据提取（尽力，取不到 null——UI 后补既有）──

/** URL 末路径段解码（容错：非法百分号编码原样返回；无段 → null）。 */
export function urlTitleSegment(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined || last === '') return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * 截断到 max 字符（CR-7 代理对安全）：截断位恰落代理对高位 → 回退一位整对舍去——半对
 * 落盘会被下游按替换符处理。低位收尾（整对在窗内）正常保留。
 */
function truncateCharsSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * 已知站点名后缀白名单（CR-9）：仅剥这些站名后缀（页题「正文标题 <sep> <站名>…」形态），
 * 未知后缀保留全名——旧「首个破折号前段」启发会把「明日方舟 - 剧情分析」误截成「明日方舟」。
 * 站名锚定天然取末位分隔（多段标题剥到站名段为止，如「A - B - 萌娘百科 …」→「A - B」）。
 */
const TITLE_SITE_SUFFIX_RES: readonly RegExp[] = [
  /\s+[-–—]\s*萌娘百科[\s\S]*$/,
  /_百度百科[\s\S]*$/,
  /\s+[-–—]\s*维基百科[\s\S]*$/,
  /\s+[-–—]\s*Wikipedia[\s\S]*$/i,
  /\s+[-–—]\s*Fandom[\s\S]*$/i,
  /\s+[-–—]\s*Bangumi[\s\S]*$/i,
];

function stripKnownSiteSuffix(title: string): string {
  let stripped = title;
  for (const re of TITLE_SITE_SUFFIX_RES) {
    const m = re.exec(stripped);
    if (m !== null && m.index > 0) stripped = stripped.slice(0, m.index).trim();
  }
  return stripped;
}

/**
 * 页面标题提取：<title> 文本（压空白 + 仅剥已知站名后缀——萌娘词条
 * 「明日方舟 - 萌娘百科 万物皆可萌的百科全书」形态；未知后缀保留全名）→ URL 末段回落 →
 * 常量兜底。截断 200 代理对安全（CR-7）。
 */
export function extractPageTitle(html: string, url: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = (match?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const title = stripKnownSiteSuffix(raw);
  if (title) return truncateCharsSafe(title, 200);
  const segment = urlTitleSegment(url);
  if (segment) return truncateCharsSafe(segment, 200);
  return '在线材料';
}

/** meta 值长度帽（CR-8——schema 对 author/originDate 无 max，异常页超长值防胀库）。 */
const META_VALUE_MAX_CHARS = 500;

/** 读单个 meta content（name/property 两键序形态各试一发；值截 500 帽）。 */
function metaContent(html: string, key: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${key}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    const value = m?.[1]?.trim();
    if (value) return value.slice(0, META_VALUE_MAX_CHARS);
  }
  return null;
}

/**
 * 页面元数据尽力提取（design §1.1：author/originDate 取不到 null）：author ← meta
 * author/article:author；originDate ← article:published_time/pubdate/date（原样保留修剪值）。
 */
export function extractPageMeta(html: string): { author: string | null; originDate: string | null } {
  const author = metaContent(html, 'author') ?? metaContent(html, 'article:author');
  const originDate =
    metaContent(html, 'article:published_time') ?? metaContent(html, 'pubdate') ?? metaContent(html, 'date');
  return { author: author ?? null, originDate: originDate ?? null };
}

// ── P3 stem 规则（同 URL 稳定 = 幂等路径身份；异 URL 不同 stem = 防静默覆写）──

/**
 * sha 后缀宽度阶梯（CR-4 撞库加宽）：默认 8；目标已占且登记行 provenance.url 异源 → 12 →
 * 16 逐级加宽（登记半 materialIpc 按「文件在 + url 异源」判定驱动）。
 */
export const ONLINE_STEM_HASH_WIDTHS = [8, 12, 16] as const;

/** stem 正文段上限（CR-2）：percent-decode 长段 + sha 后缀可越 Windows MAX_PATH——sanitize 后截断。 */
const STEM_SEGMENT_MAX_CHARS = 64;

/**
 * stem 派生用 URL 归一（CR-3，最小面）：scheme http→https、host 小写、去 pathname 尾斜杠——
 * 同页异写法（http://EXAMPLE.com/A/ vs https://example.com/A）归同一路径身份。
 * **provenance.url 不受影响**（仍记拉取终址——真实来源面），归一只进 stem 派生。
 * query/hash 保留（不同 query 常是不同内容页，不归一）；解析失败原样返回（sha 仍可派生）。
 */
export function normalizeUrlForStem(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  const tail = `${parsed.pathname.replace(/\/+$/, '')}${parsed.search}${parsed.hash}`;
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port !== '' ? `:${parsed.port}` : ''}${tail}`;
}

/**
 * 在线材料 stem：`<URL 末段 sanitize 截 64>-<sha-n(归一 url)>`。sha 后缀保证异 URL（同标题
 * 词条的官方站/镜像等）不派生同 stem——materialId 是路径身份，同 stem 第二条会以 reingest
 * 语义静默覆写第一条；同 URL（含 CR-3 归一写法族）stem 稳定 = 幂等/reingest 判定成立。
 */
export function onlineStemForUrl(url: string, hashLen: (typeof ONLINE_STEM_HASH_WIDTHS)[number] = 8): string {
  const normalized = normalizeUrlForStem(url);
  const base = sanitizeStemSegment(urlTitleSegment(normalized) ?? '');
  const sha = createHash('sha256').update(normalized, 'utf-8').digest('hex').slice(0, hashLen);
  return `${base}-${sha}`;
}

/** 在线材料文件名（恒 .md——抽取文本即原件，D4 拍板；宽度默认 8，撞库加宽归登记半）。 */
export function onlineFileNameFor(url: string, hashLen: (typeof ONLINE_STEM_HASH_WIDTHS)[number] = 8): string {
  return `${onlineStemForUrl(url, hashLen)}.md`;
}

function sanitizeStemSegment(segment: string): string {
  return (sanitizeDiskName(segment) || 'page').slice(0, STEM_SEGMENT_MAX_CHARS);
}

// ── 在线拉取 + 抽取（research session 单源，零新网络面）──

export type OnlinePageExtraction = {
  ok: true;
  /** 抽取正文（超帽已截断含尾注——capFetchedText 同形态；截断如实由 truncated 标记）。 */
  content: string;
  truncated: boolean;
  /** 截断前原始字符数（截断 note 用）。 */
  originalChars: number;
  /** 页面标题（<title> / URL 末段回落）。 */
  title: string;
  /** 重定向后的最终 URL（provenance.url 用——真实来源面）。 */
  finalUrl: string;
  author: string | null;
  originDate: string | null;
};

export type OnlinePageExtractionFailure = {
  ok: false;
  error: 'bad-url' | 'fetch-failed' | 'empty-content' | 'oversize';
  message: string;
};

export interface OnlineFetchDeps {
  /** 拉取 seam（默认 netFetchPage——SSRF 逐跳守卫 + 2MB body cap；测试注 stub 零网络）。 */
  fetchPage?: PageFetcher;
  /**
   * SSRF 入口守卫 seam（默认 assertPublicHttpUrl + researchFetchAllowlist 装配；测试注
   * pass-through 或抛 SsrfBlockedError）。per-hop 重定向守卫归 netFetchPage 既有防线。
   */
  guard?: (url: string, allowlist: readonly string[]) => Promise<void>;
  /** allowlist 装配 seam（默认 researchFetchAllowlist，读失败空表 fail-closed）。 */
  loadAllowlist?: () => readonly string[];
  /** 抽取 seam（默认 htmlToMarkdown；测试钉预解包矩阵）。 */
  extract?: (html: string) => string;
}

function defaultOnlineAllowlist(): readonly string[] {
  try {
    return researchFetchAllowlist();
  } catch {
    return [];
  }
}

/**
 * 拉取在线页并抽取正文（materials:import-online 的拉取半；登记半归 materialIpc——车道解析/
 * stem 冲突/落盘/registerMaterial 复用）。失败分类四档回报（bad-url/fetch-failed/
 * empty-content/oversize——stem-conflict/ingest-failed 两档属登记半），模式 A never-throws。
 */
export async function fetchOnlinePageAsMarkdown(
  url: string,
  deps: OnlineFetchDeps = {},
): Promise<OnlinePageExtraction | OnlinePageExtractionFailure> {
  const fetchPage = deps.fetchPage ?? netFetchPage;
  const guard = deps.guard ?? assertPublicHttpUrl;
  const extract = deps.extract ?? htmlToMarkdown;
  const loadAllowlist = deps.loadAllowlist ?? defaultOnlineAllowlist;

  // 1) URL 形判（拉取前即可判——bad-url 不触网）。
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'bad-url', message: `URL 无法解析：${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'bad-url', message: `仅支持 http/https 地址（收到 ${parsed.protocol || '未知协议'}）` };
  }

  // 2) SSRF 入口守卫（fail-closed；私网/环回/file: 拒——spec shell/research-network.md 单源）。
  const allowlist = loadAllowlist();
  try {
    await guard(url, allowlist);
  } catch (err) {
    return {
      ok: false,
      error: 'fetch-failed',
      message: `目标地址被安全策略拦截：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3) 拉取（2MB body cap；勿走 web_fetch 工具入口的 16K LLM 输出 cap）。
  let page: FetchedPage;
  try {
    page = await fetchPage(url, neverAbort, { allowlist });
  } catch (err) {
    if (err instanceof ResearchNetworkError && err.reason === 'body-too-large') {
      return {
        ok: false,
        error: 'oversize',
        message: `页面过大（原始响应超过 ${WEB_FETCH_MAX_BYTES} 字节下载上限），已中止。`,
      };
    }
    return { ok: false, error: 'fetch-failed', message: `抓取失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!page.ok) {
    return { ok: false, error: 'fetch-failed', message: `抓取失败：HTTP ${page.status}（${page.finalUrl}）` };
  }
  // 重定向终址复验（netGuard 契约：调用方对 finalUrl 复跑守卫——mirror web_fetch handler）。
  if (page.finalUrl && page.finalUrl !== url) {
    try {
      await guard(page.finalUrl, allowlist);
    } catch (err) {
      return {
        ok: false,
        error: 'fetch-failed',
        message: `重定向目标被安全策略拦截：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 4) content-type 分派（mirror classifyContentType）：HTML 走预解包 + 抽取；纯文本直用；
  //    其余类型不适用在线导入。
  const kind = classifyContentType(page.contentType);
  let markdown: string;
  if (kind === 'html') {
    const unpacked = unpackMoeSkinTemplate(page.body);
    try {
      markdown = extract(unpacked);
    } catch (err) {
      return { ok: false, error: 'fetch-failed', message: `正文抽取失败：${err instanceof Error ? err.message : String(err)}` };
    }
  } else if (kind === 'text') {
    markdown = page.body;
  } else {
    return {
      ok: false,
      error: 'fetch-failed',
      message: `该 URL 返回 ${page.contentType || '未知类型'} 内容，在线导入仅支持 HTML/文本页（PDF/图片请先下载后走本地材料导入）。`,
    };
  }

  // 5) 截断（如实）+ 近空守卫（模板壳/JS 渲染页）。
  const capped = capFetchedText(markdown, ONLINE_IMPORT_MAX_TEXT_CHARS);
  if (capped.text.trim().length < ONLINE_EMPTY_CONTENT_MIN_CHARS) {
    return {
      ok: false,
      error: 'empty-content',
      message: '抽取后正文近空（页面可能是纯 JS 渲染模板壳，无可提取正文）。',
    };
  }

  return {
    ok: true,
    content: capped.text,
    truncated: capped.truncated,
    originalChars: markdown.length,
    title: extractPageTitle(page.body, page.finalUrl || url),
    finalUrl: page.finalUrl || url,
    ...extractPageMeta(page.body),
  };
}

/** 截断 parseNote 单源（quality parseNotes 附加——best-effort 面，文件尾注与 IPC 行是持久面）。 */
export function onlineTruncationNote(originalChars: number): string {
  return `在线页正文超上限已截断：原文 ${originalChars} 字符，保留前 ${ONLINE_IMPORT_MAX_TEXT_CHARS} 字符。`;
}

// ── 关键词发现（web + wiki 既有核心并发合并，零 LLM）──

export interface OnlineSearchDeps {
  /** web 车道 seam（默认 runWebSearchCore 包装；测试注 stub）。 */
  runWeb?: (query: string, signal: AbortSignal) => Promise<Array<{ title: string; url: string; snippet: string }>>;
  /** wiki 车道 seam（默认 runWikiSiteSearches 全注册表；测试注 stub）。 */
  runWiki?: (query: string, signal: AbortSignal) => Promise<WikiSearchHit[]>;
  /** wiki 注册表 host 集（web 命中的 community-wiki 预填提示判据；缺省按当前注册表解析）。 */
  wikiHosts?: ReadonlySet<string>;
}

async function defaultWebSearch(
  query: string,
  signal: AbortSignal,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const { outcome } = await runWebSearchCore(query, signal);
  return outcome.hits.map((hit) => ({ title: hit.title, url: hit.url, snippet: hit.snippet }));
}

async function defaultWikiSearch(query: string, signal: AbortSignal): Promise<WikiSearchHit[]> {
  const sites = loadWikiSites(readSearchConfig().wikiSitesOverrides);
  const perSite = await runWikiSiteSearches({
    sites,
    query,
    limit: ONLINE_PER_LANE_SEARCH_LIMIT,
    allowlist: wikiOutboundAllowlist(sites),
    signal,
    fetchJson: netFetchJson,
  });
  return perSite.flatMap((entry) => entry.hits);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function resolveWikiHosts(): ReadonlySet<string> {
  try {
    const sites = loadWikiSites(readSearchConfig().wikiSitesOverrides);
    const hosts = new Set<string>();
    for (const site of sites) {
      const host = hostOf(site.apiBaseUrl);
      if (host !== null) hosts.add(host);
    }
    return hosts;
  } catch {
    return new Set();
  }
}

/**
 * 关键词发现（materials:search-online 实现）：web_search 与 wiki_search 既有核心并发 →
 * 合并去重（mirror wikiHandlers mergeSearchHits：exact-URL 首现胜出；wiki 车道在前——社区
 * wiki 页是本通道 canonical 目标，置顶带类别预填提示）。单车道失败降级空集不拖垮另一路；
 * 零 LLM。入参归一（空白 query → []）在 handler 边界已收窄，本函数防御性兜 []。
 */
export async function searchOnlineSourcesCore(
  input: { query: string; limit?: number },
  deps: OnlineSearchDeps = {},
): Promise<OnlineSourceHit[]> {
  const query = input.query.trim();
  if (!query) return [];
  const requested = input.limit;
  const limit =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.min(Math.max(Math.round(requested), 1), ONLINE_SEARCH_LIMIT_MAX)
      : DEFAULT_ONLINE_SEARCH_LIMIT;
  const runWeb = deps.runWeb ?? defaultWebSearch;
  const runWiki = deps.runWiki ?? defaultWikiSearch;
  const wikiHosts = deps.wikiHosts ?? resolveWikiHosts();

  const [webHits, wikiHits] = await Promise.all([
    runWeb(query, neverAbort).catch(() => []),
    runWiki(query, neverAbort).catch(() => []),
  ]);

  const seen = new Set<string>();
  const hits: OnlineSourceHit[] = [];
  for (const hit of wikiHits) {
    if (hits.length >= limit) break;
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    hits.push({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet,
      source: `wiki:${hit.site}`,
      categoryHint: 'community-wiki',
    });
  }
  for (const hit of webHits) {
    if (hits.length >= limit) break;
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    const host = hostOf(hit.url);
    hits.push({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet ?? '',
      source: 'web',
      // 二态字段纪律：无提示不出现键（host 未命中 wiki 注册表）。
      ...(host !== null && wikiHosts.has(host) ? { categoryHint: 'community-wiki' as const } : {}),
    });
  }
  return hits;
}
