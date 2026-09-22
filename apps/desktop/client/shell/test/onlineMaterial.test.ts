/**
 * E10.4 W2：onlineMaterial（在线拉取抽取核心 + 关键词发现合并核心）测试。
 *
 * ZERO network：fetchPage / guard / loadAllowlist / extract / runWeb / runWiki 全 seam 注入。
 * 锁定面：
 * - unpackMoeSkinTemplate 矩阵（无 template 直过 / 证据形态〔W0 spike 萌娘页结构：唯一
 *   open/close 对包裹 #mw-content-text，合成 fixture〕/ 嵌套 / 未配平 / id 属于非 template
 *   元素 / CR-6 三护近形：标签名边界、大写形态、注释内字面量）。
 * - categoryToProvenanceDefaults 四档映射（R3）+ onlineStemForUrl 稳定性/防撞/清洗（P3）+
 *   CR-2 长段截断 + CR-3 URL 归一 + CR-4 宽度阶梯。
 * - fetchOnlinePageAsMarkdown 失败分类（bad-url / fetch-failed〔SSRF 拒 + 非 2xx + 传输错〕/
 *   empty-content / oversize）+ MoeSkin 预解包后正文存活 + 纯文本直用 + 截断如实 + 元数据尽力
 *   （CR-7 title 代理对 / CR-8 meta 500 帽 / CR-9 站名后缀白名单）。
 * - searchOnlineSourcesCore 合并去重（wiki 前 / exact-URL 首现 / categoryHint 二态 / limit 钳制 /
 *   单车道失败降级）。
 * - 真网冒烟一条（E104_ONLINE_SMOKE=1 手动跑，W0 同轮形态；网络不可达 skip 注明）。
 *
 * mock 形态 mirror fetchHandlers.test.ts：electron + configIpc db-imports + logger；
 * turndown 走真件（预解包矩阵吃真转换器）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup as dnsLookup } from 'node:dns/promises';
import { ONLINE_IMPORT_MAX_TEXT_CHARS } from '@orison/shared-contracts';

const { handle, safeStorage, setProxy, reindexAll, reindexAllCraft, reindexAssetCards, reindexAllSettingMd, getProjectById, getProject, getDb, warn, info } = vi.hoisted(() => ({
  handle: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  setProxy: vi.fn().mockResolvedValue(undefined),
  reindexAll: vi.fn(),
  reindexAllCraft: vi.fn(),
  reindexAssetCards: vi.fn(),
  reindexAllSettingMd: vi.fn(),
  getProjectById: vi.fn(),
  getProject: vi.fn(),
  getDb: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage,
  session: { defaultSession: { setProxy } },
  net: { fetch: vi.fn() },
  app: { getPath: vi.fn(() => '/home') },
  dialog: {},
  BrowserWindow: vi.fn(),
}));
vi.mock('../main/db/closureIndexer', () => ({ reindexAll }));
vi.mock('../main/db/closureCraftIndexer', () => ({ reindexAllCraft }));
vi.mock('../main/db/assetCardsIndexer', () => ({ reindexAssetCards }));
vi.mock('../main/db/settingMdIndexer', () => ({ reindexAllSettingMd }));
vi.mock('../main/db/projectRepository', () => ({ getProjectById, getProject }));
vi.mock('../main/db/index', () => ({ getDb }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

import { ResearchNetworkError } from '../main/research/netFetch';
import { SsrfBlockedError } from '../main/research/netGuard';
import type { FetchedPage, PageFetcher } from '../main/ipc/toolHandlers/fetchHandlers';
import { htmlToMarkdown } from '../main/ipc/toolHandlers/fetchHandlers';
import {
  MOE_SKIN_TEMPLATE_BODYCONTENT_ID,
  ONLINE_SEARCH_LIMIT_MAX,
  ONLINE_STEM_HASH_WIDTHS,
  categoryToProvenanceDefaults,
  extractPageMeta,
  extractPageTitle,
  fetchOnlinePageAsMarkdown,
  normalizeUrlForStem,
  onlineFileNameFor,
  onlineStemForUrl,
  onlineTruncationNote,
  searchOnlineSourcesCore,
  unpackMoeSkinTemplate,
  urlTitleSegment,
  type OnlineFetchDeps,
} from '../main/ipc/toolHandlers/onlineMaterial';

// ── Fixtures ──

const URL_A = 'https://zh.moegirl.org.cn/明日方舟';

/** 证据形态 fixture（W0 spike 萌娘官方站页结构合成：唯一 template
 * open/close 对、#mw-content-text 位于 template 内部——W0 spike 根因形态）。 */
function moeSkinPage(bodyHtml: string): string {
  return [
    '<!DOCTYPE html><html><head><title>明日方舟 - 萌娘百科 万物皆可萌的百科全书</title></head><body>',
    '<div class="mw-body" role="main">',
    `<template id="${MOE_SKIN_TEMPLATE_BODYCONTENT_ID}">`,
    `<div id="mw-content-text" class="mw-content-ltr">${bodyHtml}</div>`,
    '</template>',
    '</div><footer>站点页脚</footer></body></html>',
  ].join('');
}

function pageFixture(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    status: 200,
    ok: true,
    finalUrl: URL_A,
    contentType: 'text/html; charset=utf-8',
    // 正文长度 > ONLINE_EMPTY_CONTENT_MIN_CHARS（近空守卫阈）。
    body: moeSkinPage(`<h2>第一章</h2><p>${'罗德岛干员正文段落，足够长以通过近空守卫。'.repeat(4)}</p>`),
    ...overrides,
  };
}

function passGuard(): (url: string, allowlist: readonly string[]) => Promise<void> {
  return async () => {};
}

function fetchDeps(overrides: Partial<OnlineFetchDeps> & { fetchPage?: PageFetcher } = {}): OnlineFetchDeps {
  return {
    fetchPage: overrides.fetchPage ?? (async () => pageFixture()),
    guard: overrides.guard ?? passGuard(),
    loadAllowlist: overrides.loadAllowlist ?? (() => []),
    ...(overrides.extract !== undefined ? { extract: overrides.extract } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── MoeSkin template 预解包 ──

describe('unpackMoeSkinTemplate', () => {
  it('无 template → 原文直过（同一引用，零改写）', () => {
    const raw = '<html><body><div id="mw-content-text"><p>普通页面</p></div></body></html>';
    expect(unpackMoeSkinTemplate(raw)).toBe(raw);
  });

  it('证据形态：template 包裹层剥除，innerHTML 原位还原（正文对 turndown 可见）', () => {
    const raw = moeSkinPage('<h2>第一章</h2><p>罗德岛干员正文段落。</p>');
    const out = unpackMoeSkinTemplate(raw);
    expect(out).not.toContain('<template');
    expect(out).toContain('id="mw-content-text"');
    expect(out).toContain('<h2>第一章</h2><p>罗德岛干员正文段落。</p>');
    // 包裹层前后的文档面（head/footer）原位保留。
    expect(out).toContain('<title>明日方舟 - 萌娘百科 万物皆可萌的百科全书</title>');
    expect(out).toContain('<footer>站点页脚</footer>');
  });

  it('嵌套 template：深度配平扫描（naive indexOf 会被子级 close 提前截断）', () => {
    const raw = [
      '<div>',
      `<template id="${MOE_SKIN_TEMPLATE_BODYCONTENT_ID}">`,
      '<p>外层开头</p>',
      '<template><p>子模板内容</p></template>',
      '<p>外层结尾</p>',
      '</template>',
      '</div>',
    ].join('');
    const out = unpackMoeSkinTemplate(raw);
    expect(out).not.toContain('<template');
    expect(out).toContain('<p>外层开头</p>');
    expect(out).toContain('<p>子模板内容</p>');
    expect(out).toContain('<p>外层结尾</p>');
  });

  it('未配平（open 无 close）→ 原文直过', () => {
    const raw = `<div><template id="${MOE_SKIN_TEMPLATE_BODYCONTENT_ID}"><p>无闭合</p></div>`;
    expect(unpackMoeSkinTemplate(raw)).toBe(raw);
  });

  it('id 属于非 template 元素 → 原文直过（open 与 id 之间先出现 >）', () => {
    const raw = [
      '<div>',
      '<template><p>无关模板</p></template>',
      `<div id="${MOE_SKIN_TEMPLATE_BODYCONTENT_ID}"><p>不是模板</p></div>`,
      '</div>',
    ].join('');
    expect(unpackMoeSkinTemplate(raw)).toBe(raw);
  });

  it('CR-6① 标签名边界：<templates id=…> 近形不算 template open → 原文直过', () => {
    const raw = `<div><templates id="${MOE_SKIN_TEMPLATE_BODYCONTENT_ID}"><p>不是模板</p></templates></div>`;
    expect(unpackMoeSkinTemplate(raw)).toBe(raw);
  });

  it('CR-6② 大小写不敏感：<TEMPLATE> 大写标签形态同样展开（原文切片保留内层原样）', () => {
    const raw = `<div><TEMPLATE id="${MOE_SKIN_TEMPLATE_BODYCONTENT_ID}"><p>大写形态正文</p></TEMPLATE></div>`;
    const out = unpackMoeSkinTemplate(raw);
    expect(out).toContain('<p>大写形态正文</p>');
    expect(out).not.toContain('TEMPLATE');
  });

  it('CR-6③ 注释内字面量跳过：open/close 字面量在注释里不计配平（naive 扫描会提前截断/多计深度）', () => {
    // 注释内 </template 字面量：naive 会让深度提前归零、真 close 残留（正文二/footer 被藏进
    // 未展开的伪包裹）。断言：全量展开（naive-close 之后的内容原位存活）+ close 字面量仅剩
    // 注释内一处。
    const closeInComment = [
      '<div>',
      `<template id="${MOE_SKIN_TEMPLATE_BODYCONTENT_ID}">`,
      '<p>正文一</p><!-- </template> --><p>正文二</p>',
      '</template>',
      '<footer>尾</footer>',
    ].join('');
    const outClose = unpackMoeSkinTemplate(closeInComment);
    expect(outClose).toContain('<p>正文一</p>');
    expect(outClose).toContain('<p>正文二</p>');
    expect(outClose).toContain('<footer>尾</footer>');
    expect(outClose).toContain('<!-- </template> -->'); // 注释原样保留
    expect(outClose.split('</template')).toHaveLength(2); // 唯一 close 字面量在注释内

    // 注释内 <template 字面量：naive 会多计深度、未配平原文直过（正文反被藏住）。
    // 断言：展开成功（close 形态零残留——原形态带一个真 close）。
    const openInComment = [
      '<div>',
      `<template id="${MOE_SKIN_TEMPLATE_BODYCONTENT_ID}">`,
      '<!-- <template> 注释里的 open 字面量 --><p>注释后正文</p>',
      '</template>',
      '</div>',
    ].join('');
    const outOpen = unpackMoeSkinTemplate(openInComment);
    expect(outOpen).toContain('<p>注释后正文</p>');
    expect(outOpen).toContain('<!-- <template> 注释里的 open 字面量 -->');
    expect(outOpen.match(/<\/template/g)).toBeNull();
  });

  it('与真 turndown 对拍：不预解包正文 0 存活，预解包后存活（W0 根因回归钉）', async () => {
    const raw = moeSkinPage('<p>唯一可辨识正文标记</p>');
    // 未解包：TURNDOWN_REMOVED_TAGS 含 'template' → 正文子树整段被移除（W0 spike 实测 266 字符形态）。
    expect(htmlToMarkdown(raw)).not.toContain('唯一可辨识正文标记');
    // 预解包：正文存活。
    expect(htmlToMarkdown(unpackMoeSkinTemplate(raw))).toContain('唯一可辨识正文标记');
  });
});

// ── 类别映射（R3）──

describe('categoryToProvenanceDefaults', () => {
  it('四档类别 → medium/tier 映射矩阵（design §1.1 表）', () => {
    expect(categoryToProvenanceDefaults('community-wiki')).toEqual({ medium: 'wiki', tier: 'community' });
    expect(categoryToProvenanceDefaults('criticism')).toEqual({ medium: 'criticism', tier: 'criticism' });
    expect(categoryToProvenanceDefaults('author-interview')).toEqual({ medium: 'interview', tier: 'original' });
    expect(categoryToProvenanceDefaults('other')).toEqual({ medium: 'other', tier: 'unspecified' });
  });
});

// ── P3 stem 规则 ──

describe('onlineStemForUrl / onlineFileNameFor / urlTitleSegment', () => {
  it('同 URL stem 稳定（幂等路径身份）；异 URL 同末段 stem 不同（防静默覆写）', () => {
    const a = onlineStemForUrl(URL_A);
    expect(onlineStemForUrl(URL_A)).toBe(a);
    const mirror = onlineStemForUrl('https://moegirl.uk/明日方舟');
    expect(mirror).not.toBe(a);
    expect(mirror.startsWith('明日方舟-')).toBe(true);
    expect(a.startsWith('明日方舟-')).toBe(true);
  });

  it('CR-3 URL 归一进 stem 派生：host 大小写/尾斜杠/http→https 同页同 stem', () => {
    const canonical = onlineStemForUrl('https://example.com/明日方舟');
    expect(onlineStemForUrl('https://EXAMPLE.com/明日方舟/')).toBe(canonical);
    expect(onlineStemForUrl('http://example.com/明日方舟')).toBe(canonical);
    expect(onlineStemForUrl('http://Example.com/明日方舟/')).toBe(canonical);
    // query/hash 保留（不同 query 可能是不同内容页，不归一）。
    expect(onlineStemForUrl('https://example.com/明日方舟?x=1')).not.toBe(canonical);
  });

  it('CR-3 归一只进 stem 派生（normalizeUrlForStem 单源；provenance.url 记终址与此无关）', () => {
    expect(normalizeUrlForStem('HTTP://Example.com/A/')).toBe('https://example.com/A');
    expect(normalizeUrlForStem('https://example.com/')).toBe('https://example.com');
    // 解析失败原样返回（sha 仍可派生，路径身份稳定）。
    expect(normalizeUrlForStem('不是 URL')).toBe('不是 URL');
  });

  it('CR-2 stem 正文段 64 截断：percent-decode 超长段不越 Windows MAX_PATH 形态', () => {
    const longUrl = `https://example.com/${encodeURIComponent('超'.repeat(200))}`;
    const stem = onlineStemForUrl(longUrl);
    // stem = base(≤64) + '-' + sha(8)：总长 ≤ 73，sha 后缀形态不变。
    expect(stem.length).toBeLessThanOrEqual(64 + 1 + 8);
    expect(stem).toMatch(/-[0-9a-f]{8}$/);
    // 截断不破幂等：同 URL 再派生同 stem。
    expect(onlineStemForUrl(longUrl)).toBe(stem);
  });

  it('CR-4 宽度阶梯：同 URL 各宽度 stem 稳定；异宽度互异（撞库加宽缝）', () => {
    for (const width of ONLINE_STEM_HASH_WIDTHS) {
      expect(onlineStemForUrl(URL_A, width)).toBe(onlineStemForUrl(URL_A, width));
    }
    const [w8, w12, w16] = ONLINE_STEM_HASH_WIDTHS;
    expect(onlineStemForUrl(URL_A, w12)).toMatch(new RegExp(`-[0-9a-f]{${w12}}$`));
    expect(onlineStemForUrl(URL_A, w16)).toMatch(new RegExp(`-[0-9a-f]{${w16}}$`));
    expect(onlineStemForUrl(URL_A, w12)).not.toBe(onlineStemForUrl(URL_A, w8));
    expect(onlineFileNameFor(URL_A, w12)).toBe(`${onlineStemForUrl(URL_A, w12)}.md`);
  });

  it('文件名恒 .md；末段 percent-decoding + 非法字符清洗 + 空段回落 page', () => {
    expect(onlineFileNameFor(URL_A)).toMatch(/\.md$/);
    const encoded = onlineStemForUrl('https://example.com/%E6%98%8E%E6%97%A5%E6%96%B9%E8%88%9F');
    expect(encoded.startsWith('明日方舟-')).toBe(true);
    const dirty = onlineStemForUrl('https://example.com/a<b>c|d?');
    expect(dirty.startsWith('a-b-c-d-')).toBe(true);
    expect(onlineStemForUrl('https://example.com/').startsWith('page-')).toBe(true);
    expect(urlTitleSegment('https://example.com/a/b?x=1')).toBe('b');
    expect(urlTitleSegment('https://example.com/')).toBeNull();
  });
});

// ── 标题 / 元数据提取 ──

describe('extractPageTitle / extractPageMeta', () => {
  it('title 剥已知站名后缀（CR-9 白名单）；未知后缀保留全名（首破折号不误截）', () => {
    expect(extractPageTitle('<title>明日方舟 - 萌娘百科 万物皆可萌的百科全书</title>', URL_A)).toBe('明日方舟');
    // 未知后缀（非站名）不剥——旧「首个破折号前段」启发会把本例误截成「明日方舟」。
    expect(extractPageTitle('<title>明日方舟 - 剧情分析</title>', URL_A)).toBe('明日方舟 - 剧情分析');
    // 末位分隔语义：多段标题剥到站名段为止。
    expect(extractPageTitle('<title>A - B - 萌娘百科 万物皆可萌的百科全书</title>', URL_A)).toBe('A - B');
    // 白名单其余形态（下划线百度百科 / Wikipedia）。
    expect(extractPageTitle('<title>剧情考据_百度百科</title>', URL_A)).toBe('剧情考据');
    expect(extractPageTitle('<title>Attack on Titan - Wikipedia</title>', URL_A)).toBe('Attack on Titan');
    expect(extractPageTitle('<html><body>无标题</body></html>', URL_A)).toBe('明日方舟');
    expect(extractPageTitle('<html></html>', 'https://example.com/')).toBe('在线材料');
  });

  it('title 200 截断代理对安全（CR-7）：高位截断回退一位；低位收尾整对保留', () => {
    const surrogate = '𝕏'; // U+1D54F（代理对，UTF-16 length 2）
    // 截断位 200 = 代理对高位 → 回退一位整对舍去（不留半对）。
    const highCut = extractPageTitle(`<title>${'字'.repeat(199)}${surrogate}</title>`, URL_A);
    expect(highCut.length).toBe(199);
    expect(highCut.endsWith('字')).toBe(true);
    // 截断位 200 = 代理对低位 → 整对在窗内正常保留。
    const pairKept = extractPageTitle(`<title>${'字'.repeat(198)}${surrogate}</title>`, URL_A);
    expect(pairKept.length).toBe(200);
    expect(pairKept.endsWith(surrogate)).toBe(true);
  });

  it('meta author/originDate 尽力提取；缺席 → null（UI 后补既有）；值 500 帽（CR-8 防胀库）', () => {
    const withMeta = [
      '<head>',
      '<meta name="author" content="评论作者">',
      '<meta property="article:published_time" content="2024-05-01T08:00:00Z">',
      '</head>',
    ].join('');
    expect(extractPageMeta(withMeta)).toEqual({ author: '评论作者', originDate: '2024-05-01T08:00:00Z' });
    expect(extractPageMeta('<html></html>')).toEqual({ author: null, originDate: null });

    const bloated = `<meta name="author" content="${'长'.repeat(900)}">`;
    expect(extractPageMeta(bloated).author?.length).toBe(500);
  });
});

// ── 在线拉取 + 抽取（失败分类矩阵 + 预解包存活）──

describe('fetchOnlinePageAsMarkdown', () => {
  it('MoeSkin 页：预解包后正文经真 turndown 存活（未解包形态会 0 存活——W0 根因）', async () => {
    const out = await fetchOnlinePageAsMarkdown(URL_A, fetchDeps({}));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content).toContain('罗德岛干员正文段落');
    expect(out.content).toContain('第一章');
    expect(out.truncated).toBe(false);
    expect(out.title).toBe('明日方舟');
    expect(out.finalUrl).toBe(URL_A);
    expect(out.author).toBeNull();
  });

  it('非 MoeSkin HTML（无 template）正常抽取；纯文本 content-type 直用 body', async () => {
    const plainHtml = await fetchOnlinePageAsMarkdown('https://example.com/a', fetchDeps({
      fetchPage: async () => pageFixture({ body: `<html><body><p>${'普通文章正文，足够长不判近空。'.repeat(5)}</p></body></html>`, finalUrl: 'https://example.com/a' }),
    }));
    expect(plainHtml.ok).toBe(true);
    if (plainHtml.ok) expect(plainHtml.content).toContain('普通文章正文');

    const plainText = await fetchOnlinePageAsMarkdown('https://example.com/a.txt', fetchDeps({
      fetchPage: async () => pageFixture({ contentType: 'text/plain; charset=utf-8', body: `纯文本来源正文，足够长不判近空。${'补充段落内容。'.repeat(5)}` }),
    }));
    expect(plainText.ok).toBe(true);
    if (plainText.ok) expect(plainText.content).toContain('纯文本来源正文');
  });

  it('bad-url 两档：不可解析 / 非 http(s)——守卫与拉取均不触达', async () => {
    const guard = vi.fn(passGuard());
    const fetchPage = vi.fn(async () => pageFixture());
    for (const bad of ['不是 URL', 'file:///etc/passwd', 'ftp://example.com/x']) {
      const out = await fetchOnlinePageAsMarkdown(bad, fetchDeps({ guard, fetchPage }));
      expect(out).toMatchObject({ ok: false, error: 'bad-url' });
    }
    expect(guard).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('SSRF 入口拒（SsrfBlockedError）→ fetch-failed 可读回报，拉取不触达', async () => {
    const fetchPage = vi.fn(async () => pageFixture());
    const out = await fetchOnlinePageAsMarkdown('http://127.0.0.1:8888/', fetchDeps({
      guard: async (url) => {
        throw new SsrfBlockedError(url, 'private-ip', '私网地址已拦截：127.0.0.1');
      },
      fetchPage,
    }));
    expect(out).toMatchObject({ ok: false, error: 'fetch-failed' });
    if (!out.ok) expect(out.message).toContain('安全策略拦截');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('非 2xx → fetch-failed（HTTP 状态可读）；传输错（超时）→ fetch-failed', async () => {
    const non2xx = await fetchOnlinePageAsMarkdown(URL_A, fetchDeps({
      fetchPage: async () => pageFixture({ ok: false, status: 403 }),
    }));
    expect(non2xx).toMatchObject({ ok: false, error: 'fetch-failed' });
    if (!non2xx.ok) expect(non2xx.message).toContain('403');

    const timeout = await fetchOnlinePageAsMarkdown(URL_A, fetchDeps({
      fetchPage: async () => {
        throw new ResearchNetworkError('timeout', '请求超时（10000ms）');
      },
    }));
    expect(timeout).toMatchObject({ ok: false, error: 'fetch-failed' });
  });

  it('body 超 2MB cap（body-too-large）→ oversize 档（契约：整页不可用，不静默截断）', async () => {
    const out = await fetchOnlinePageAsMarkdown(URL_A, fetchDeps({
      fetchPage: async () => {
        throw new ResearchNetworkError('body-too-large', '响应体过大（Content-Length 3000000 字节）');
      },
    }));
    expect(out).toMatchObject({ ok: false, error: 'oversize' });
  });

  it('重定向终址复验：finalUrl 换址且守卫拒 → fetch-failed（netGuard 逐跳契约）', async () => {
    const guardedUrls: string[] = [];
    const out = await fetchOnlinePageAsMarkdown('https://example.com/redirect', fetchDeps({
      guard: async (url) => {
        guardedUrls.push(url);
        if (url !== 'https://example.com/redirect') {
          throw new SsrfBlockedError(url, 'private-ip', '私网地址已拦截：10.0.0.5');
        }
      },
      fetchPage: async () => pageFixture({ finalUrl: 'http://10.0.0.5/private' }),
    }));
    expect(out).toMatchObject({ ok: false, error: 'fetch-failed' });
    expect(guardedUrls).toEqual(['https://example.com/redirect', 'http://10.0.0.5/private']);
  });

  it('抽取近空 → empty-content 档（模板壳/JS 渲染页）', async () => {
    const out = await fetchOnlinePageAsMarkdown(URL_A, fetchDeps({
      fetchPage: async () => pageFixture({ body: '<html><body><div id="app"></div></body></html>' }),
    }));
    expect(out).toMatchObject({ ok: false, error: 'empty-content' });
  });

  it('PDF/图片等类型 → fetch-failed 可读指引（在线导入仅支持 HTML/文本页）', async () => {
    const out = await fetchOnlinePageAsMarkdown(URL_A, fetchDeps({
      fetchPage: async () => pageFixture({ contentType: 'application/pdf' }),
    }));
    expect(out).toMatchObject({ ok: false, error: 'fetch-failed' });
    if (!out.ok) expect(out.message).toContain('PDF');
  });

  it('长页截断如实：超帽保留前 ONLINE_IMPORT_MAX_TEXT_CHARS 字符 + 尾注（成功行 truncated 标记）', async () => {
    const huge = '长'.repeat(ONLINE_IMPORT_MAX_TEXT_CHARS + 1000);
    const out = await fetchOnlinePageAsMarkdown(URL_A, fetchDeps({
      extract: () => huge,
    }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.truncated).toBe(true);
    expect(out.originalChars).toBe(ONLINE_IMPORT_MAX_TEXT_CHARS + 1000);
    expect(out.content.length).toBeLessThan(huge.length);
    expect(out.content).toContain('已截断');
    expect(onlineTruncationNote(ONLINE_IMPORT_MAX_TEXT_CHARS + 1000)).toContain('超上限已截断');
  });

  it('元数据透传：author/originDate 在场时进抽取结果（provenance 预填供给面）', async () => {
    const out = await fetchOnlinePageAsMarkdown(URL_A, fetchDeps({
      fetchPage: async () => pageFixture({
        body: moeSkinPage(`<p>${'正文内容填充段落。'.repeat(10)}</p>`).replace(
          '</head>',
          '<meta name="author" content="考据作者"></head>',
        ),
      }),
    }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.author).toBe('考据作者');
  });
});

// ── 关键词发现（合并去重）──

describe('searchOnlineSourcesCore', () => {
  const wikiHosts = new Set(['zh.moegirl.org.cn', 'moegirl.uk']);

  it('wiki 车道置顶（source=wiki:<siteId> + categoryHint）；web 命中 wiki host 才给提示（二态键）', async () => {
    const hits = await searchOnlineSourcesCore(
      { query: '明日方舟' },
      {
        wikiHosts,
        runWiki: async () => [
          { title: '明日方舟', url: 'https://zh.moegirl.org.cn/明日方舟', snippet: '词条', site: 'moegirl-cn' },
        ],
        runWeb: async () => [
          { title: '萌娘词条（web 命中）', url: 'https://zh.moegirl.org.cn/初音未来', snippet: 's1' },
          { title: '普通评论', url: 'https://example.com/review', snippet: 's2' },
        ],
      },
    );
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({
      title: '明日方舟',
      url: 'https://zh.moegirl.org.cn/明日方舟',
      snippet: '词条',
      source: 'wiki:moegirl-cn',
      categoryHint: 'community-wiki',
    });
    expect(hits[1]).toMatchObject({ source: 'web', categoryHint: 'community-wiki' });
    expect(hits[2]).toMatchObject({ source: 'web' });
    expect('categoryHint' in hits[2]!).toBe(false);
  });

  it('exact-URL 去重（两车道同 URL 首现胜出——wiki 优先）；limit 钳制', async () => {
    const deduped = await searchOnlineSourcesCore(
      { query: 'q' },
      {
        wikiHosts,
        runWiki: async () => [{ title: 'w', url: 'https://same.example/x', snippet: '', site: 'moegirl-cn' }],
        runWeb: async () => [
          { title: 'dup', url: 'https://same.example/x', snippet: '' },
          { title: 'b', url: 'https://b.example/', snippet: '' },
        ],
      },
    );
    expect(deduped.map((h) => h.url)).toEqual(['https://same.example/x', 'https://b.example/']);

    const limited = await searchOnlineSourcesCore(
      { query: 'q', limit: 1 },
      {
        wikiHosts,
        runWiki: async () => [{ title: 'w', url: 'https://a.example/', snippet: '', site: 'moegirl-cn' }],
        runWeb: async () => [{ title: 'b', url: 'https://b.example/', snippet: '' }],
      },
    );
    expect(limited).toHaveLength(1);

    const clamped = await searchOnlineSourcesCore(
      { query: 'q', limit: 10_000 },
      {
        wikiHosts,
        runWiki: async () => [{ title: 'w', url: 'https://a.example/', snippet: '', site: 'moegirl-cn' }],
        runWeb: async () => [{ title: 'b', url: 'https://b.example/', snippet: '' }],
      },
    );
    expect(clamped).toHaveLength(2); // 上限钳制不丢真结果（结果本就 ≤ ONLINE_SEARCH_LIMIT_MAX）
    expect(ONLINE_SEARCH_LIMIT_MAX).toBeGreaterThanOrEqual(2);
  });

  it('单车道失败降级空集，另一路存活（Promise.all 不被单路 reject 拖垮）', async () => {
    const wikiOnly = await searchOnlineSourcesCore(
      { query: 'q' },
      {
        wikiHosts,
        runWiki: async () => [{ title: 'w', url: 'https://a.example/', snippet: '', site: 'moegirl-cn' }],
        runWeb: async () => {
          throw new Error('engine chain exploded');
        },
      },
    );
    expect(wikiOnly).toHaveLength(1);
    expect(wikiOnly[0]!.source).toBe('wiki:moegirl-cn');

    const webOnly = await searchOnlineSourcesCore(
      { query: 'q' },
      {
        wikiHosts,
        runWiki: async () => {
          throw new Error('wiki exploded');
        },
        runWeb: async () => [{ title: 'b', url: 'https://b.example/', snippet: '' }],
      },
    );
    expect(webOnly).toHaveLength(1);
    expect(webOnly[0]!.source).toBe('web');
  });

  it('空白 query 防御性兜 []（handler 边界已模式 B 收窄）', async () => {
    expect(await searchOnlineSourcesCore({ query: '   ' }, {})).toEqual([]);
  });
});

// ── 真网冒烟（E104_ONLINE_SMOKE=1 手动跑；W0 同轮形态，克隆频率控制）──
// 运行：cd apps/desktop/client/shell && E104_ONLINE_SMOKE=1 npx vitest run test/onlineMaterial.test.ts
// 默认 skip（单元纪律零网络）；启用后网络不可达（离线/防火墙）→ skip 注明非失败。
// ⚠ 传输偏差（spike-fetch2.cjs 同形态）：ELECTRON_RUN_AS_NODE 下无 research session——冒烟
// 注入 node fetch 直连（仅打写死的公开站；SSRF 守卫与研究 session 传输面由既有套件覆盖，
// 本冒烟验证的是**抽取管线在真实页面上的存活**，非传输层）。

const SMOKE_URL = 'https://zh.moegirl.org.cn/明日方舟';
const SMOKE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const smokeFetchPage: PageFetcher = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { 'user-agent': SMOKE_UA },
  });
  return {
    status: res.status,
    ok: res.ok,
    finalUrl: res.url || url,
    contentType: res.headers.get('content-type') ?? '',
    body: await res.text(),
  };
};

describe.skipIf(process.env.E104_ONLINE_SMOKE !== '1')('E10.4 真网冒烟（W0 同轮形态）', () => {
  it('MoeSkin 预解包抽取：萌娘官方站词条正文存活（网络不可达 → skip）', async () => {
    let reachable = true;
    try {
      await dnsLookup('zh.moegirl.org.cn');
    } catch {
      reachable = false;
    }
    if (!reachable) {
      // 网络不可达：skip 注明（非失败——离线环境下本冒烟无从谈起）。
      return expect(true).toBe(true);
    }
    const out = await fetchOnlinePageAsMarkdown(SMOKE_URL, {
      fetchPage: smokeFetchPage,
      guard: async () => {}, // 冒烟 URL 写死公开站，入口守卫放行（传输偏差见上）
      loadAllowlist: () => [],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.content.length).toBeGreaterThan(5000); // W0 实测正文切片 337K；保守下界
    expect(out.truncated).toBe(false);
    expect(out.title.length).toBeGreaterThan(0);
  }, 60_000);
});
