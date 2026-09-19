import type {
  DeconCanonEntry,
  DeconChapterFacts,
  DeconCost,
  DeconEntity,
  DeconJob,
  DeconProgressEvent,
  DeconSpan,
  DeconTimelineConsistency,
  Material,
} from '@orison/shared-contracts';
import { DECON_CANON_DOMAINS, deconCanonEntrySchema } from '@orison/shared-contracts';
import {
  getDeconPassState,
  listDeconChapterFacts,
  listDeconEntities,
  replaceDeconCanonEntriesWithPassState,
} from '../db/closure-decon';
import { listDeconCanonEntries } from '../db/closure-canon';
import { getMaterialRow } from '../db/materialIndexer';
import { getLogger } from '../logger';
import { splitParagraphBlocks, type MaterialParagraphBlock } from '../ipc/toolHandlers/materialIngest';
import {
  DECON_STALE_NOTE,
  capDeconUnit,
  checkDeconRunBoundary,
  failDeconUnit,
  loadRunningDeconJob,
  readDeconDerivedTextFor,
  runDeconLlmCall,
  sha256DeconContent,
} from './deconRun';
import { getDeconLlmCore, type DeconGenerateSlot, type DeconGenerateText } from './deconLlmCore';
import { decideDeconPassReentry, extractMaterialId, hashDeconCanonOutput, transitionDeconJob } from './deconJob';

// ── E10.3a（task 09-05）W5：P2 canon 六域装配（parent design §2.2 / child A design §P2）──
//
// 六域（2026-09-05 拍板定稿）：world / rule / character / tone / timeline / relationship。
// 做薄纪律：不复述情节，只存同人保真所需事实骨架；**不写自己项目的 asset_cards**（C5 边界）。
//
// 域装配范式（parent design §9 P2 行——两段式）：
// - **character / relationship**：纯代码为主（P1c 实体 + 逐章关系边聚合；别名经 aliasMap 归 canonical），
//   character 域 LLM 补画像短句（payload 含 **C7 immutable/evolvable** 语义标注槽——OOC
//   tolerance_curve 基准；identity/speechPattern/abilities/arc/coreTrauma 对齐 **C3** 画像字段名、
//   pillars/voiceAnchors/antiVoice/neverDo 对齐 **C6 FPS 原料**）。锚点 = 实体出场 span（纯代码携带，
//   LLM 不产锚——7.1「选区锚点构造纯代码」同判据）。
// - **world / rule / tone：候选供给式（F-04）**——纯代码按实体名/关键词从原文召回候选段落（带
//   全局段号 + span），LLM 在**候选段号约束**下归纳条目并定位锚点（集外段号整体拒收），
//   **不裸读 synopsis 归纳**（synopsis 无锚——裸归纳要么空域要么假锚）。归纳条目 evidence=inferred、
//   直接引用条目（quote 通过子串核验）evidence=exact。
// - **timeline**：事件按章序排列 + 故事时间标注（LLM：storyTimeLabel + timeOrder 序数 +
//   倒叙/预叙 device 标记）+ 容错三档（**纯代码规则**：timeOrder 相对前文回退 = 时序异常，
//   按「章内/跨章」分类）+ **intentional_loose 需 LLM 复核标记**（带 device 的回退经 review-judge
//   复核确认为有意装置；无 device 的回退 = 真矛盾 → conflict，不使 job failed）。
//
// 无锚不立行：anchors min(1) 契约钉死——world/rule/tone 候选集外/引文不匹配条目直接丢（计数审计）。
// 断点：pass='p2' unit=域名（per-domain 重入跳过）；产物（per (job,domain) 全量替换）+ pass_state
// 同事务落库。capped 预算门前置（全部 LLM 调用 pass='p2' 茎）。
//
// expected_downstream_consumers:
// - W6 deconIpc（decon:get canon 浏览面——人审取数）。
// - 同人-1 epic（未来——C1-C9 消费面；接口形状见 shared-contracts closure-decon.ts 注释预留）。

// ── 常量（阈值推测值起步——dogfood 首本标定）──

/** 每条目锚点上限（canon 做薄——超限取章序最前，观测面足够）。 */
export const DECON_P2_MAX_ANCHORS_PER_ENTRY = 20;

/** 候选供给式召回段落上限（prompt 体量闸——超限按得分/均匀采样取前 N）。 */
export const DECON_P2_RECALL_MAX_PARAGRAPHS = 40;

/** 候选段 prompt 展示截断（锚点仍指整段——quote 核验对全文做，展示截断只影响 LLM 可见文本）。 */
export const DECON_P2_RECALL_PARAGRAPH_DISPLAY_CHARS = 600;

/** 每域条目上限（幻觉闸门族——超限丢尾部，CR-12c：溢出计数入 stats 不静默）。 */
export const DECON_P2_MAX_ENTRIES_PER_DOMAIN = 30;

/** 画像分批大小（CR-3：单 prompt 装全部锚定角色 ~25+ 位 → length 截断即 job failed；每批 ≤8 位串行）。 */
export const DECON_P2_PORTRAIT_BATCH_SIZE = 8;

/** 画像每批输出 token 预算（8 位 × 每位 ~300 tokens 画像 JSON ≈ 2.4k；4096 含余量）。 */
export const DECON_P2_PORTRAIT_MAX_TOKENS = 4096;

/** 画像每角色供引文段数（出场 span 章序最前 N 段，每段截 200 字）。 */
export const DECON_P2_PORTRAIT_QUOTES_PER_CHARACTER = 6;
export const DECON_P2_PORTRAIT_QUOTE_CHARS = 200;

/** character 域 payload.mentions.chapters 截断（CR-14a 做薄——首 N + 末 N 章 + 总数）。 */
export const DECON_P2_MENTION_CHAPTERS_HEAD = 8;
export const DECON_P2_MENTION_CHAPTERS_TAIL = 8;

/** 候选供给归纳调用输出 token 预算（条目集 JSON）。 */
export const DECON_P2_RECALL_MAX_TOKENS = 8192;

/** 时间线标注事件上限（kernel 优先 + 章序补位——百万字事件全量标注不可行，标定值）。 */
export const DECON_P2_TIMELINE_MAX_EVENTS = 200;
export const DECON_P2_TIMELINE_MAX_TOKENS = 8192;
export const DECON_P2_TIMELINE_REVIEW_MAX_TOKENS = 2048;

/**
 * world 域召回**中性**标记词（CR-6：题材中性红线——仙侠武侠词表退役）。仅通用词面（任何
 * 题材的世界观段落都可能命中）；**主通道 = 实体名**（place/organization/concept 实体名命中
 * ——recallDeconCandidateParagraphs 实体名权重 ×2 > 关键词 ×1，实体驱动为主、标记词为辅）。
 */
export const DECON_P2_WORLD_KEYWORDS: readonly string[] = [
  '世界', '大陆', '王国', '帝国', '王朝', '国家', '边境', '边疆', '地域', '疆域',
  '势力', '组织', '家族', '学院', '城市', '小镇', '村庄', '森林', '山脉', '河流',
  '海洋', '岛屿', '沙漠', '草原', '星球', '宇宙',
];

/** rule 域召回**中性**标记词（CR-6：规则/约定/禁令/等级/制度词面——通用非题材词）。 */
export const DECON_P2_RULE_KEYWORDS: readonly string[] = [
  '规则', '规矩', '规定', '禁令', '禁忌', '禁止', '法律', '律法', '法度', '制度',
  '章程', '约定', '契约', '等级', '阶层', '阶级', '惩罚', '限制', '必须', '不可',
  '不得', '违者',
];

// ── 共用纯代码面 ──

/** 空白归一引文子串判定（p1Extract isQuoteInSpan 同式——LLM 引文空白抖动不误杀）。 */
function isQuoteInText(quote: string, text: string): boolean {
  const q = quote.replace(/\s+/g, '');
  return q.length > 0 && text.replace(/\s+/g, '').includes(q);
}

/** 块 → 章映射（章区间相交判定——与 buildChapterSegments 同口径；无章块 → null）。 */
export function mapDeconBlocksToChapters(
  blocks: readonly MaterialParagraphBlock[],
  chapters: ReadonlyArray<{ index: number; charStart: number; charEnd: number }>,
): Array<number | null> {
  return blocks.map((b) => {
    for (const ch of chapters) {
      if (b.end > ch.charStart && b.start < ch.charEnd) return ch.index;
    }
    return null;
  });
}

/** 召回候选段（带全局段号 + 章 + span 坐标——供给 LLM 归纳定位）。 */
export interface DeconRecalledParagraph {
  paraIndex: number;
  chapterIndex: number;
  charStart: number;
  charEnd: number;
  text: string;
}

export interface DeconRecallInput {
  kind: 'keywords' | 'sample';
  keywords?: readonly string[];
  entityNames?: readonly string[];
  max: number;
}

/**
 * 候选供给式召回（纯代码——F-04 召回半边）：
 * - `keywords` 模式：段落得分 = 命中关键词去重数 ×1 + 命中实体名去重数 **×2**（CR-6：实体名
 *   驱动为主——实体名是题材无关的强信号，关键词只是中性标记辅通道）；得分 >0 者按
 *   （得分降序，段号升序）取前 max（确定性）。
 * - `sample` 模式（tone 域——基调无词面可召回）：属章段落均匀步进采样（确定性）。
 */
export function recallDeconCandidateParagraphs(
  derived: string,
  blocks: readonly MaterialParagraphBlock[],
  chapterOf: ReadonlyArray<number | null>,
  input: DeconRecallInput,
): DeconRecalledParagraph[] {
  const mk = (i: number): DeconRecalledParagraph => ({
    paraIndex: i,
    chapterIndex: chapterOf[i]!,
    charStart: blocks[i]!.start,
    charEnd: blocks[i]!.end,
    text: derived.slice(blocks[i]!.start, blocks[i]!.end),
  });
  if (input.kind === 'sample') {
    const chaptered = blocks.map((_, i) => i).filter((i) => chapterOf[i] !== null);
    const stride = Math.max(1, Math.floor(chaptered.length / input.max));
    const picked: DeconRecalledParagraph[] = [];
    for (let i = 0; i < chaptered.length && picked.length < input.max; i += stride) {
      picked.push(mk(chaptered[i]!));
    }
    return picked;
  }
  const scored: Array<{ i: number; score: number }> = [];
  for (let i = 0; i < blocks.length; i++) {
    if (chapterOf[i] === null) continue;
    const text = derived.slice(blocks[i]!.start, blocks[i]!.end);
    let score = 0;
    for (const kw of input.keywords ?? []) if (text.includes(kw)) score += 1;
    for (const name of input.entityNames ?? []) if (text.includes(name)) score += 2; // 实体名主通道（CR-6）
    if (score > 0) scored.push({ i, score });
  }
  scored.sort((x, y) => (y.score - x.score !== 0 ? y.score - x.score : x.i - y.i));
  return scored.slice(0, input.max).map((s) => mk(s.i));
}

/** aliasMap（名 → canonical——含别名；hallucinationFiltered 簇排除）。 */
export function buildDeconAliasMap(entities: readonly DeconEntity[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entities) {
    if (e.audit.hallucinationFiltered === true) continue;
    map.set(e.canonicalName, e.canonicalName);
    for (const alias of e.aliases) map.set(alias, e.canonicalName);
  }
  return map;
}

/** 锚点截断（章序最前 N——canon 做薄）。 */
function capAnchors(spans: readonly DeconSpan[]): DeconSpan[] {
  return spans.slice(0, DECON_P2_MAX_ANCHORS_PER_ENTRY);
}

// ── world/rule/tone：候选供给式归纳（LLM 约束段号 + 纯代码锚定核验）──

const DECON_P2_RECALL_DESCRIPTORS: Record<'world' | 'rule' | 'tone', { goal: string; example: string }> = {
  world: {
    goal: '世界观条目（地理区域、势力组织、背景格局等世界层面的既有设定）',
    example: '如「青云观——山间道观，弟子修行之地」',
  },
  rule: {
    goal: '规则条目（世界法则、禁令约束、等级制度、修炼体系等规则层面设定）',
    example: '如「观中规矩——入夜后不可下山，犯者逐出师门」',
  },
  tone: {
    goal: '基调条目（叙事基调、语域、氛围特征——从行文风格归纳，锚定到样例段落）',
    example: '如「冷峻悬疑——夜戏为主、短句收束」',
  },
};

export const DECON_P2_RECALL_SYSTEM_PROMPT = [
  '你是小说设定档案整理器。下面给你从原文召回的候选段落（带段落号），从候选段落中归纳设定条目。',
  '仅基于提供的文本作答；不要使用任何工具（联网搜索、命令执行、浏览器等）——本环境不提供工具，调用工具会导致失败。',
  '每条输出 {"name":"条目名","summary":"一两句概括","paraRanges":[{"start":段号,"end":段号}],"quote":"支撑原文摘录"}；',
  '- paraRanges 是半开区间，只能引用候选列表中实际出现的段落号——引用候选外段落号会被整体拒收；',
  '- quote 是 paraRanges 范围内的原文逐字摘录（不得改写、不得拼接不同位置），给出 quote 的条目视为直接引用，没有原文可引就不要给 quote（纯归纳条目合法）；',
  '- 候选段落支撑不了的条目不要输出（宁缺毋滥）；条目名用原文中的实际名称。',
  '输出 {"entries":[...]} 纯 JSON 对象，不要任何解释或前后缀。',
].join('\n');

export function buildDeconRecallUserPrompt(
  domain: 'world' | 'rule' | 'tone',
  paragraphs: readonly DeconRecalledParagraph[],
  corrective = false,
): string {
  const descriptor = DECON_P2_RECALL_DESCRIPTORS[domain];
  const halfChars = Math.floor(DECON_P2_RECALL_PARAGRAPH_DISPLAY_CHARS / 2);
  const lines = paragraphs.map((p) => {
    // CR-14d：截断改头尾采样（旧头部截断偏置段落头部——长段的世界观信息常在中尾部）。
    const shown =
      p.text.length > DECON_P2_RECALL_PARAGRAPH_DISPLAY_CHARS
        ? `${p.text.slice(0, halfChars)}……${p.text.slice(-halfChars)}`
        : p.text;
    return `【P${p.paraIndex}】${shown}`;
  });
  return [
    `【本次归纳目标：${descriptor.goal}，${descriptor.example}】`,
    '【候选段落（【P段落号】标记每段开始；段落号是全文档全局编号）】',
    ...lines,
    '',
    `共 ${paragraphs.length} 个候选段落。归纳条目并输出 JSON 对象。`,
    ...(corrective
      ? ['', '注意：上一次输出引用了候选列表之外的段落号或形状坏劣，已被整体拒收。只能引用候选列表中出现的段落号。']
      : []),
  ].join('\n');
}

/** 归纳条目原始形态（LLM 输出——纯代码核验前）。 */
export interface DeconRecalledEntryRaw {
  name: string;
  summary: string;
  paraRanges: Array<{ start: number; end: number }>;
  quote: string | null;
}

/**
 * 解析归纳响应（顶层坏 → null 整体拒收；条目坏形状 → 丢该条计数——paraRanges 非数组/空、
 * name/summary 非非空字符串）。段号集外与 quote 核验在锚定映射层（buildDeconRecallEntries——
 * 需 blocks/chapterOf 上下文）。
 */
export function parseDeconRecallResponse(
  raw: string,
): { entries: DeconRecalledEntryRaw[]; droppedMalformed: number } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const entriesRaw = (obj as Record<string, unknown>).entries;
  if (!Array.isArray(entriesRaw)) return null;
  const entries: DeconRecalledEntryRaw[] = [];
  let dropped = 0;
  for (const el of entriesRaw) {
    const r = el === null || typeof el !== 'object' ? null : (el as Record<string, unknown>);
    const name = typeof r?.name === 'string' && r.name.trim().length > 0 ? r.name.trim() : null;
    const summary = typeof r?.summary === 'string' && r.summary.trim().length > 0 ? r.summary.trim() : null;
    const quote = typeof r?.quote === 'string' && r.quote.trim().length > 0 ? r.quote.trim() : null;
    const ranges: Array<{ start: number; end: number }> = [];
    if (Array.isArray(r?.paraRanges)) {
      for (const pr of r.paraRanges) {
        const p = pr === null || typeof pr !== 'object' ? null : (pr as Record<string, unknown>);
        if (
          typeof p?.start === 'number' &&
          Number.isInteger(p.start) &&
          typeof p?.end === 'number' &&
          Number.isInteger(p.end)
        ) {
          ranges.push({ start: p.start, end: p.end });
        }
      }
    }
    if (name === null || summary === null || ranges.length === 0) {
      dropped += 1;
      continue;
    }
    entries.push({ name, summary, paraRanges: ranges, quote });
  }
  return { entries, droppedMalformed: dropped };
}

/**
 * 归纳条目 → canon 条目（纯代码锚定核验——无锚即丢）：paraRange 集外 / 跨章 / 退化 → 丢条目；
 * quote 不在锚定文本 → 丢条目（编造引文）；通过 → evidence = quote ? exact : inferred。
 * 超每域上限（CR-12c）→ 丢尾部 + **溢出计数**（stats 诚实回报，不静默）。
 */
export function buildDeconRecallEntries(
  jobId: string,
  domain: 'world' | 'rule' | 'tone',
  raw: readonly DeconRecalledEntryRaw[],
  paragraphs: readonly DeconRecalledParagraph[],
  derived: string,
  provenance: DeconCanonEntry['provenance'],
): { entries: DeconCanonEntry[]; droppedNoAnchor: number; droppedOverflow: number } {
  const byIndex = new Map(paragraphs.map((p) => [p.paraIndex, p]));
  const entries: DeconCanonEntry[] = [];
  let dropped = 0;
  let droppedOverflow = 0;
  for (const e of raw) {
    if (entries.length >= DECON_P2_MAX_ENTRIES_PER_DOMAIN) {
      droppedOverflow += 1; // 上限外条目整条溢出（锚定核验跳过——计数口径与丢尾一致）
      continue;
    }
    const spans: DeconSpan[] = [];
    let valid = true;
    for (const range of e.paraRanges) {
      const s = byIndex.get(range.start);
      const t = byIndex.get(range.end - 1);
      if (s === undefined || t === undefined || range.start >= range.end) {
        valid = false; // 集外段号 = 编造锚
        break;
      }
      if (s.chapterIndex !== t.chapterIndex) {
        continue; // 跨章区间按段拆锚（该段弃用不弃条目——span 单章语义）
      }
      spans.push({
        chapterIndex: s.chapterIndex,
        charStart: s.charStart,
        charEnd: t.charEnd,
        paraStart: range.start,
        paraEnd: range.end,
      });
    }
    if (!valid || spans.length === 0) {
      dropped += 1;
      continue;
    }
    if (e.quote !== null) {
      const anchorText = spans.map((s) => derived.slice(s.charStart, s.charEnd)).join('\n');
      if (!isQuoteInText(e.quote, anchorText)) {
        dropped += 1; // 编造引文
        continue;
      }
    }
    entries.push({
      jobId,
      domain,
      name: e.name,
      payload: {
        evidence: e.quote !== null ? 'exact' : 'inferred',
        ...(domain === 'rule' ? { statement: e.summary } : {}),
        ...(domain === 'tone' ? { baseline: e.summary } : {}),
        ...(domain === 'world' ? { summary: e.summary } : {}),
        summary: e.summary,
      },
      anchors: capAnchors(spans),
      provenance,
    });
  }
  return { entries, droppedNoAnchor: dropped, droppedOverflow };
}

// ── character：纯代码聚合 + LLM 补画像短句（C7 immutable/evolvable 槽）──

export const DECON_P2_PORTRAIT_SYSTEM_PROMPT = [
  '你是小说角色档案整理器。根据给出的角色在原文中的出场摘录，为每个角色归纳画像（供同人写作保真参照）。',
  '仅基于提供的文本作答；不要使用任何工具（联网搜索、命令执行、浏览器等）——本环境不提供工具，调用工具会导致失败。',
  '输出字段（全部依据摘录归纳——摘录支撑不了的写 null，禁止编造）：',
  '- identity：一句话身份概括；',
  '- speechPattern：语言风格/口癖；',
  '- traits：性格特质数组，每条 {"name":"特质","mutability":"immutable 或 evolvable"}——immutable=核心不变特质（同人写作不可走样的基准），evolvable=随剧情可演变的特质；每条可带 "note" 补一句依据；',
  '- abilities：能力；arc：成长弧；coreTrauma：核心创伤；',
  '- pillars：行为支柱（一定做什么/看重什么）；voiceAnchors：语言锚点（典型用词句式）；antiVoice：反锚点（绝不会用的说法）；neverDo：绝不会做的事。',
  '规则：只能对给出的角色名作答，禁止自创角色名。输出 {"characters":[{"name":"角色名", ...上述字段}]} 纯 JSON 对象。',
].join('\n');

export interface DeconPortraitFields {
  identity: string | null;
  speechPattern: string | null;
  traits: Array<{ name: string; mutability: 'immutable' | 'evolvable'; note?: string }>;
  abilities: string | null;
  arc: string | null;
  coreTrauma: string | null;
  pillars: string | null;
  voiceAnchors: string | null;
  antiVoice: string | null;
  neverDo: string | null;
}

/**
 * 解析画像响应（约束校验 + 条目级容错）：顶层坏 / 集外角色名 → null **整体拒收**（重试一次后
 * 诚实挂起）；字段级容错——非字符串/空白字段归 null，坏形状 trait 条目丢弃（不弃整角色）。
 */
export function parseDeconPortraitResponse(
  raw: string,
  allowedNames: ReadonlySet<string>,
): Map<string, DeconPortraitFields> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const arr = (obj as Record<string, unknown>).characters;
  if (!Array.isArray(arr)) return null;
  const out = new Map<string, DeconPortraitFields>();
  for (const el of arr) {
    const r = el === null || typeof el !== 'object' ? null : (el as Record<string, unknown>);
    const name = typeof r?.name === 'string' ? r.name.trim() : null;
    if (name === null || name.length === 0) return null;
    if (!allowedNames.has(name)) return null; // 集外角色名 = 幻觉 → 整体拒收
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
    const traits: DeconPortraitFields['traits'] = [];
    if (Array.isArray(r?.traits)) {
      for (const t of r.traits) {
        const tr = t === null || typeof t !== 'object' ? null : (t as Record<string, unknown>);
        const tName = str(tr?.name);
        const mut = tr?.mutability;
        if (tName === null || (mut !== 'immutable' && mut !== 'evolvable')) continue;
        const note = str(tr?.note);
        traits.push(note === null ? { name: tName, mutability: mut } : { name: tName, mutability: mut, note });
      }
    }
    out.set(name, {
      identity: str(r?.identity),
      speechPattern: str(r?.speechPattern),
      traits,
      abilities: str(r?.abilities),
      arc: str(r?.arc),
      coreTrauma: str(r?.coreTrauma),
      pillars: str(r?.pillars),
      voiceAnchors: str(r?.voiceAnchors),
      antiVoice: str(r?.antiVoice),
      neverDo: str(r?.neverDo),
    });
  }
  return out;
}

export function buildDeconPortraitUserPrompt(
  characters: ReadonlyArray<{ name: string; aliases: readonly string[]; quotes: readonly string[] }>,
  corrective = false,
): string {
  const blocksText = characters.map((c) => {
    const aliasLine = c.aliases.length > 0 ? `（别名：${c.aliases.join('、')}）` : '';
    const quotes = c.quotes.length > 0 ? c.quotes.map((q, i) => `  摘录${i + 1}：${q}`).join('\n') : '  （无摘录）';
    return `【角色】${c.name}${aliasLine}\n${quotes}`;
  });
  return [
    '【角色出场摘录（仅依据这些摘录归纳，不得引入摘录外信息）】',
    ...blocksText,
    '',
    `共 ${characters.length} 个角色。为每个角色输出画像 JSON 对象。`,
    ...(corrective
      ? ['', '注意：上一次输出包含未给出的角色名或顶层形状坏劣，已被整体拒收。只能对给出的角色名作答。']
      : []),
  ].join('\n');
}

// ── timeline：章序排列 + LLM 时间标注 + 纯代码容错规则 + LLM 复核 ──

export const DECON_P2_TIMELINE_SYSTEM_PROMPT = [
  '你是小说时间线标注器。下面按阅读顺序给出全书事件，为每个事件标注故事内时间：',
  '仅基于提供的文本作答；不要使用任何工具（联网搜索、命令执行、浏览器等）——本环境不提供工具，调用工具会导致失败。',
  '- storyTimeLabel：故事时间标签（如「第一日清晨」「十年前」——事件在故事世界中的时刻）；',
  '- timeOrder：故事时间序数（整数，按故事世界内先后编号——阅读序正常时该值应当递增或不降；同一时刻可同号；「十年前」这类回溯事件的序数应小于当前叙事位）；',
  '- device：若该事件是倒叙/插叙/预叙等**刻意打乱时序的叙事装置**，标 "flashback"（倒叙/插叙/回忆）或 "flashforward"（预叙/铺垫未来）；正常顺序事件省略该字段。',
  '规则：只能对给出的编号事件作答，禁止自创编号。输出 {"events":[{"id":"编号","storyTimeLabel":"…","timeOrder":整数,"device":"flashback" 可选}]} 纯 JSON 对象。',
].join('\n');

export const DECON_P2_TIMELINE_REVIEW_SYSTEM_PROMPT = [
  '你是小说时间线矛盾复核裁判。下面的事件按阅读顺序排列，其故事时间序数相对前文出现了回退，且标注了叙事装置（倒叙/插叙/预叙）。',
  '仅基于提供的文本作答；不要使用任何工具（联网搜索、命令执行、浏览器等）——本环境不提供工具，调用工具会导致失败。',
  '判断每一处回退是作者**有意**的时序装置（倒叙回忆、预叙铺垫——章节文本有「回忆/当年/十年前/后来」等回溯语汇支撑）还是**失误**（时间线自相矛盾——正文按当下叙事写但时间对不上）。',
  '每条输出 {"id":"编号","intentional":true 或 false}。只能对给出的编号作答，禁止自创编号。输出纯 JSON 数组，不要解释。',
].join('\n');

export interface DeconTimelineAnnotation {
  storyTimeLabel: string;
  timeOrder: number;
  device?: 'flashback' | 'flashforward';
}

/** 解析时间标注（约束校验——集外 id / 坏 timeOrder 整体拒收；device 集外值按缺省宽容）。 */
export function parseDeconTimelineAnnotationResponse(
  raw: string,
  eventIds: ReadonlySet<string>,
): Map<string, DeconTimelineAnnotation> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const arr = (obj as Record<string, unknown>).events;
  if (!Array.isArray(arr)) return null;
  const out = new Map<string, DeconTimelineAnnotation>();
  for (const el of arr) {
    if (el === null || typeof el !== 'object') return null;
    const r = el as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : null;
    const label = typeof r.storyTimeLabel === 'string' && r.storyTimeLabel.trim().length > 0 ? r.storyTimeLabel.trim() : null;
    if (id === null || label === null) return null;
    if (!eventIds.has(id)) return null; // 集外 id = 幻觉 → 整体拒收
    const order = r.timeOrder;
    if (typeof order !== 'number' || !Number.isFinite(order)) return null;
    const device = r.device === 'flashback' || r.device === 'flashforward' ? r.device : undefined;
    out.set(id, { storyTimeLabel: label, timeOrder: Math.trunc(order), ...(device !== undefined ? { device } : {}) });
  }
  return out;
}

/** 解析复核响应（约束校验——集外 id / 坏 intentional 整体拒收；漏答默认 false=非有意）。 */
export function parseDeconTimelineReviewResponse(
  raw: string,
  ids: ReadonlySet<string>,
): Map<string, boolean> | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out = new Map<string, boolean>();
  for (const el of arr) {
    if (el === null || typeof el !== 'object') return null;
    const r = el as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : null;
    if (id === null || typeof r.intentional !== 'boolean') return null;
    if (!ids.has(id)) return null;
    out.set(id, r.intentional);
  }
  return out;
}

/** 时序异常（纯代码检出——timeOrder 相对前文回退；章内/跨章分类）。 */
export interface DeconTimelineInversion {
  eventId: string;
  chapterIndex: number;
  /** true = 与前一事件同章（章内矛盾）；false = 跨章。 */
  withinChapter: boolean;
  device?: 'flashback' | 'flashforward';
  /** 复核结论（有意装置 true / 真矛盾 false；未复核 = undefined）。 */
  intentional?: boolean;
}

/**
 * 时序异常扫描（纯代码规则——child A design「容错三档：章内/跨章矛盾分类」）：按章序 +
 * 事件序走查 timeOrder，相对运行最大值回退即异常；device 在场的异常候选复核，缺场的直接
 * 真矛盾（conflict 候选）。返回（inversions, 未带 device 的真矛盾集）。
 */
export function scanDeconTimelineInversions(
  events: ReadonlyArray<{ eventId: string; chapterIndex: number; annotation: DeconTimelineAnnotation }>,
): { inversions: DeconTimelineInversion[]; unexplained: DeconTimelineInversion[] } {
  const inversions: DeconTimelineInversion[] = [];
  const unexplained: DeconTimelineInversion[] = [];
  let runningMax = Number.NEGATIVE_INFINITY;
  let prevChapter: number | null = null;
  for (const ev of events) {
    const { timeOrder, device } = ev.annotation;
    if (timeOrder < runningMax) {
      const inversion: DeconTimelineInversion = {
        eventId: ev.eventId,
        chapterIndex: ev.chapterIndex,
        withinChapter: prevChapter === ev.chapterIndex,
        ...(device !== undefined ? { device } : {}),
      };
      if (device !== undefined) inversions.push(inversion);
      else unexplained.push(inversion);
    }
    runningMax = Math.max(runningMax, timeOrder);
    prevChapter = ev.chapterIndex;
  }
  return { inversions, unexplained };
}

// ── P2 编排 ──

interface DeconP2Ctx {
  jobId: string;
  job: DeconJob;
  generate: DeconGenerateText;
  nowIso: () => string;
  cost: DeconCost;
  /** 域级审计计数聚合（CR-3/CR-4/CR-12c/CR-14e/CR-16——runDeconP2 汇入 stats + 日志）。 */
  audit: DeconP2Audit;
  /** 重试相位 note（C3——升帽重试的 UI 可见面；缺省不发）。 */
  notify?: (event: DeconProgressEvent) => void;
}

/** P2 域级审计计数（可选字段——零值面缺省不占 payload）。 */
export interface DeconP2Audit {
  /** 画像批失败降级的角色数（CR-3——域仍落纯代码聚合，画像字段空）。 */
  portraitDegradedCharacters?: number;
  /** canon 写侧 zod 门丢弃的无效条目数（CR-4）。 */
  canonDroppedInvalid?: number;
  /** 同域重名去重丢弃数（CR-4——PK(job,domain,name) 违约防线）。 */
  canonDroppedDuplicateNames?: number;
  /** 每域条目上限溢出丢弃数（CR-12c）。 */
  entriesOverflow?: number;
  /** 关系边端点未解析成实体（ghost pair）丢弃数（CR-14e）。 */
  ghostPairEdgesDropped?: number;
  /** timeline 漏答事件数（CR-16——回退排布带未标注标记）。 */
  timelineUnannotated?: number;
}

type DeconP2DomainOutcome =
  | { ok: true; entries: DeconCanonEntry[] }
  | { ok: false; kind: 'capped' | 'failed'; message: string };

/**
 * 单次预算内 LLM 调用：**CR-4 收口 deconRun.runDeconLlmCall 共享脚手架**（est 预算门每 attempt
 * 过门 + cost 记账〔provider usage 真值优先 CR-13〕+ finishReason=length 升帽 ×2 重试一次 +
 * 每 attempt notify note）。三子调用（画像/召回/时间线）经本单点；本包装只剩 P2 语义映射：
 * 预算超限 → capped；截断（重试仍 length）→ **failed**（canon 语义面——半程产物不可续）；
 * 空回复/调用错 → failed。
 */
async function callDeconP2Llm(
  ctx: DeconP2Ctx,
  unit: string,
  slot: DeconGenerateSlot,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ ok: true; text: string } | { ok: false; kind: 'capped' | 'failed'; message: string }> {
  const call = await runDeconLlmCall({
    jobId: ctx.jobId,
    pass: 'p2',
    unit,
    slot,
    system,
    user,
    maxTokens,
    budget: ctx.job.budget,
    cost: ctx.cost,
    job: ctx.job,
    generate: ctx.generate,
    ...(ctx.notify !== undefined ? { notify: ctx.notify } : {}),
    nowIso: ctx.nowIso,
    label: 'canon 装配',
  });
  ctx.cost = call.cost;
  if (call.ok) return { ok: true, text: call.text };
  if (call.kind === 'budget-capped') return { ok: false, kind: 'capped', message: call.note };
  if (call.kind === 'length') return { ok: false, kind: 'failed', message: `${call.note}——已挂起，不落半程产物` };
  return { ok: false, kind: 'failed', message: call.note }; // error / empty
}

/** 带约束式解析 + 重试一次的调用（parse null → 纠偏重试一次，仍坏诚实挂起——P1a 同款）。 */
async function callDeconP2LlmParsed<T>(
  ctx: DeconP2Ctx,
  unit: string,
  slot: DeconGenerateSlot,
  system: string,
  user: string,
  maxTokens: number,
  parse: (raw: string) => T | null,
  correctiveNote: string,
): Promise<{ ok: true; parsed: T } | { ok: false; kind: 'capped' | 'failed'; message: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const call = await callDeconP2Llm(ctx, unit, slot, system, attempt > 0 ? `${user}\n\n${correctiveNote}` : user, maxTokens);
    if (!call.ok) return call;
    const parsed = parse(call.text);
    if (parsed !== null) return { ok: true, parsed };
    if (attempt > 0) {
      return { ok: false, kind: 'failed', message: 'canon 装配两次整体拒收（约束式校验失败），不硬给条目' };
    }
    getLogger().warn({ jobId: ctx.jobId }, 'decon p2: constrained response rejected - retrying once');
  }
  return { ok: false, kind: 'failed', message: 'canon 装配重试耗尽（不可达路径）' };
}

/** 每域角色行（纯代码聚合面——anchors/关系边 + LLM 画像供给引文）。 */
interface CharacterMaterial {
  canonical: string;
  aliases: readonly string[];
  anchors: DeconSpan[];
  mentionChapters: number[];
  mentionEntries: number;
  relationships: Array<{ with: string; kind: string }>;
  quotes: string[];
}

function collectCharacterMaterials(
  entities: readonly DeconEntity[],
  factsRows: readonly DeconChapterFacts[],
  derived: string,
): CharacterMaterial[] {
  const persons = entities.filter((e) => e.type === 'person' && e.audit.hallucinationFiltered !== true);
  const aliasMap = buildDeconAliasMap(entities);
  const byCanonical = new Map<string, CharacterMaterial>(
    persons.map((p) => [
      p.canonicalName,
      {
        canonical: p.canonicalName,
        aliases: p.aliases,
        anchors: [],
        mentionChapters: p.mentions.map((m) => m.chapterIndex),
        mentionEntries: p.mentions.reduce((s, m) => s + m.count, 0),
        relationships: [],
        quotes: [],
      },
    ]),
  );
  const resolve = (name: string): string => aliasMap.get(name) ?? name;
  for (const row of factsRows) {
    for (const e of row.facts.entities) {
      const mat = byCanonical.get(resolve(e.name));
      if (mat !== undefined) mat.anchors.push(e.span);
    }
    for (const edge of row.facts.relationshipEdges) {
      const fromMat = byCanonical.get(resolve(edge.from));
      const toMat = byCanonical.get(resolve(edge.to));
      if (fromMat !== undefined && toMat !== undefined && fromMat !== toMat) {
        fromMat.relationships.push({ with: toMat.canonical, kind: edge.kind });
        toMat.relationships.push({ with: fromMat.canonical, kind: edge.kind });
      }
    }
  }
  for (const mat of byCanonical.values()) {
    mat.anchors = capAnchors(mat.anchors);
    mat.quotes = mat.anchors
      .slice(0, DECON_P2_PORTRAIT_QUOTES_PER_CHARACTER)
      .map((s) => {
        const text = derived.slice(s.charStart, s.charEnd);
        return text.length > DECON_P2_PORTRAIT_QUOTE_CHARS ? `${text.slice(0, DECON_P2_PORTRAIT_QUOTE_CHARS)}……` : text;
      });
  }
  return [...byCanonical.values()].sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0));
}

/** mentions.chapters 截断（CR-14a 做薄——首 N + 末 N 章 + 总数；未超限原样）。 */
function capMentionChapters(chapters: readonly number[]): { chapters: number[]; total: number } {
  const sorted = [...chapters].sort((x, y) => x - y);
  if (sorted.length <= DECON_P2_MENTION_CHAPTERS_HEAD + DECON_P2_MENTION_CHAPTERS_TAIL) {
    return { chapters: sorted, total: sorted.length };
  }
  return {
    chapters: [...sorted.slice(0, DECON_P2_MENTION_CHAPTERS_HEAD), ...sorted.slice(-DECON_P2_MENTION_CHAPTERS_TAIL)],
    total: sorted.length,
  };
}

/**
 * character 域装配（纯代码为主 + LLM 补画像短句——C7 immutable/evolvable 槽）。
 * **画像分批**（CR-3）：≤DECON_P2_PORTRAIT_BATCH_SIZE 位/批串行——单 prompt 装全部锚定角色
 * （~25+ 位）会 length 截断炸整域。**画像失败降级**：批调用 failed（两次拒收/截断/空回复）→
 * 该批画像字段空 + `portraitDegraded: true` 标记 + 审计计数，域仍落纯代码聚合（anchors/
 * aliases/mentions/relationships——LLM 之外的产物不陪葬）；**capped 仍走挂起**（诚实挂起家族
 * 纪律——不把预算耗尽伪装成降级 done）。
 */
async function assembleCharacterDomain(
  ctx: DeconP2Ctx,
  materials: readonly CharacterMaterial[],
  provenance: DeconCanonEntry['provenance'],
): Promise<DeconP2DomainOutcome> {
  // 无锚角色不立行（纯代码面先过滤——anchors min(1) 契约）。
  const anchored = materials.filter((m) => m.anchors.length > 0);
  if (anchored.length === 0) return { ok: true, entries: [] };

  const portraits = new Map<string, DeconPortraitFields>();
  const degradedNames = new Set<string>();
  for (let i = 0; i < anchored.length; i += DECON_P2_PORTRAIT_BATCH_SIZE) {
    const batch = anchored.slice(i, i + DECON_P2_PORTRAIT_BATCH_SIZE);
    const allowed = new Set(batch.map((m) => m.canonical));
    const portrait = await callDeconP2LlmParsed(
      ctx,
      'character',
      'extraction',
      DECON_P2_PORTRAIT_SYSTEM_PROMPT,
      buildDeconPortraitUserPrompt(batch.map((m) => ({ name: m.canonical, aliases: m.aliases, quotes: m.quotes }))),
      DECON_P2_PORTRAIT_MAX_TOKENS,
      (raw) => parseDeconPortraitResponse(raw, allowed),
      '注意：上一次输出包含未给出的角色名或顶层形状坏劣，已被整体拒收。只能对给出的角色名作答。',
    );
    if (!portrait.ok) {
      if (portrait.kind === 'capped') return portrait;
      // 降级（CR-3）：画像批失败不炸域——纯代码聚合照落，画像字段空 + 标记 + 计数。
      for (const m of batch) degradedNames.add(m.canonical);
      ctx.audit.portraitDegradedCharacters = (ctx.audit.portraitDegradedCharacters ?? 0) + batch.length;
      getLogger().warn(
        { jobId: ctx.jobId, batchSize: batch.length, message: portrait.message },
        'decon p2: portrait batch failed - degrading to code-only character entries (portrait fields empty)',
      );
      continue;
    }
    for (const [name, fields] of portrait.parsed) portraits.set(name, fields);
  }

  const entries: DeconCanonEntry[] = [];
  for (const m of anchored) {
    const fields = portraits.get(m.canonical);
    const degraded = degradedNames.has(m.canonical);
    const mentions = capMentionChapters(m.mentionChapters);
    entries.push({
      jobId: ctx.jobId,
      domain: 'character',
      name: m.canonical,
      payload: {
        evidence: 'inferred',
        aliases: [...m.aliases],
        mentions: { chapters: mentions.chapters, total: mentions.total, entries: m.mentionEntries },
        relationships: m.relationships,
        ...(fields !== undefined ? { portrait: fields } : {}),
        ...(degraded ? { portraitDegraded: true } : {}),
      },
      anchors: m.anchors,
      provenance,
    });
  }
  return { ok: true, entries };
}

/**
 * relationship 域装配（纯代码——per-pair 边聚合，C2 角色对粒度）。
 * - **pair key 分隔符 = '\u0000'**（CR-14f：旧 '\n' 分隔遇名含换行错解析；NUL 不可入名）。
 * - **端点未解析 → 丢边 + 计数**（CR-14e：aliasMap 未命中的裸名端点会产 ghost pair——无
 *   对应 character 主条目的孤儿关系行，下游同人消费侧配不上档）。
 */
function assembleRelationshipDomain(
  ctx: DeconP2Ctx,
  entities: readonly DeconEntity[],
  factsRows: readonly DeconChapterFacts[],
  provenance: DeconCanonEntry['provenance'],
): DeconCanonEntry[] {
  const aliasMap = buildDeconAliasMap(entities);
  const filteredNames = new Set(
    entities.filter((e) => e.audit.hallucinationFiltered === true).flatMap((e) => [e.canonicalName, ...e.aliases]),
  );
  interface PairAgg {
    spans: DeconSpan[];
    chapters: Set<number>;
    kinds: Map<string, number>;
    directed: Map<string, number>;
  }
  const pairs = new Map<string, PairAgg>();
  for (const row of factsRows) {
    for (const edge of row.facts.relationshipEdges) {
      const fromRaw = edge.from;
      const toRaw = edge.to;
      if (filteredNames.has(fromRaw) || filteredNames.has(toRaw)) continue; // 幻觉实体不进 canon
      // 端点须解析成已知实体（CR-14e——ghost pair 防线；计数审计非静默）。
      if (!aliasMap.has(fromRaw) || !aliasMap.has(toRaw)) {
        ctx.audit.ghostPairEdgesDropped = (ctx.audit.ghostPairEdgesDropped ?? 0) + 1;
        continue;
      }
      const from = aliasMap.get(fromRaw)!;
      const to = aliasMap.get(toRaw)!;
      if (from === to) continue;
      const key = [from, to].sort().join('\u0000');
      const agg = pairs.get(key) ?? { spans: [], chapters: new Set<number>(), kinds: new Map<string, number>(), directed: new Map<string, number>() };
      agg.spans.push(edge.span);
      agg.chapters.add(row.chapterIndex);
      agg.kinds.set(edge.kind, (agg.kinds.get(edge.kind) ?? 0) + 1);
      const dirKey = `${from}\u0000${to}`;
      agg.directed.set(dirKey, (agg.directed.get(dirKey) ?? 0) + 1);
      pairs.set(key, agg);
    }
  }
  const entries: DeconCanonEntry[] = [];
  for (const [key, agg] of [...pairs.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
    const [a, b] = key.split('\u0000') as [string, string];
    // 主导 kind / 主导方向：频次降序 → 字典序（确定性）。
    const dominantKind = [...agg.kinds.entries()].sort((x, y) => (y[1] - x[1] !== 0 ? y[1] - x[1] : x[0] < y[0] ? -1 : 1))[0]![0];
    const dominantDir = [...agg.directed.entries()].sort((x, y) => (y[1] - x[1] !== 0 ? y[1] - x[1] : x[0] < y[0] ? -1 : 1))[0]![0];
    const [from, to] = dominantDir.split('\u0000') as [string, string];
    entries.push({
      jobId: ctx.jobId,
      domain: 'relationship',
      name: `${a} × ${b}`,
      payload: {
        evidence: 'exact',
        pair: {
          from,
          to,
          kind: dominantKind,
          evidence: { edgeCount: agg.spans.length, chapters: [...agg.chapters].sort((x, y) => x - y), kinds: [...agg.kinds.keys()].sort() },
        },
      },
      anchors: capAnchors(agg.spans),
      provenance,
    });
  }
  return entries;
}

/** world/rule/tone 域装配（候选供给式——纯代码召回 + LLM 约束归纳 + 锚定核验）。 */
async function assembleRecallDomain(
  ctx: DeconP2Ctx,
  domain: 'world' | 'rule' | 'tone',
  derived: string,
  blocks: readonly MaterialParagraphBlock[],
  chapterOf: ReadonlyArray<number | null>,
  entities: readonly DeconEntity[],
  provenance: DeconCanonEntry['provenance'],
): Promise<DeconP2DomainOutcome> {
  const recallInput: DeconRecallInput =
    domain === 'tone'
      ? { kind: 'sample', max: DECON_P2_RECALL_MAX_PARAGRAPHS }
      : {
          kind: 'keywords',
          keywords: domain === 'world' ? DECON_P2_WORLD_KEYWORDS : DECON_P2_RULE_KEYWORDS,
          entityNames: entities
            .filter((e) => e.audit.hallucinationFiltered !== true && e.type !== 'person' && e.type !== 'item')
            .flatMap((e) => [e.canonicalName, ...e.aliases]),
          max: DECON_P2_RECALL_MAX_PARAGRAPHS,
        };
  const paragraphs = recallDeconCandidateParagraphs(derived, blocks, chapterOf, recallInput);
  if (paragraphs.length === 0) return { ok: true, entries: [] }; // 召回零段 = 诚实空域（done）

  const recall = await callDeconP2LlmParsed(
    ctx,
    domain,
    'extraction',
    DECON_P2_RECALL_SYSTEM_PROMPT,
    buildDeconRecallUserPrompt(domain, paragraphs),
    DECON_P2_RECALL_MAX_TOKENS,
    parseDeconRecallResponse,
    '注意：上一次输出引用了候选列表之外的段落号或形状坏劣，已被整体拒收。只能引用候选列表中出现的段落号。',
  );
  if (!recall.ok) return recall;

  const built = buildDeconRecallEntries(ctx.jobId, domain, recall.parsed.entries, paragraphs, derived, provenance);
  if (built.droppedNoAnchor > 0) {
    getLogger().warn(
      { jobId: ctx.jobId, domain, droppedNoAnchor: built.droppedNoAnchor },
      'decon p2: recall entries dropped for missing anchor (out-of-candidate paraRange or fabricated quote)',
    );
  }
  if (built.droppedOverflow > 0) {
    ctx.audit.entriesOverflow = (ctx.audit.entriesOverflow ?? 0) + built.droppedOverflow;
    getLogger().warn(
      { jobId: ctx.jobId, domain, droppedOverflow: built.droppedOverflow },
      'decon p2: recall entries overflow per-domain cap - dropped with count (not silent)',
    );
  }
  return { ok: true, entries: built.entries };
}

/** timeline 域装配（章序排列 + LLM 标注 + 纯代码容错规则 + LLM 复核）。 */
async function assembleTimelineDomain(
  ctx: DeconP2Ctx,
  factsRows: readonly DeconChapterFacts[],
  provenance: DeconCanonEntry['provenance'],
): Promise<DeconP2DomainOutcome> {
  interface TimelineEvent {
    eventId: string;
    chapterIndex: number;
    what: string;
    span: DeconSpan;
    kernel: boolean;
  }
  const all: TimelineEvent[] = [];
  for (const row of factsRows) {
    for (const ev of row.facts.events) {
      all.push({
        eventId: `e${all.length}`,
        chapterIndex: row.chapterIndex,
        what: ev.what,
        span: ev.span,
        kernel: ev.kernel === true,
      });
    }
  }
  if (all.length === 0) return { ok: true, entries: [] }; // 零事件 = 诚实空域（anchors min(1) → 无行）
  // 标注上限：kernel 优先入选 + 章序补位，**再按原章序排列**（标注契约「按阅读顺序」——
  // 百万字全量标注不可行，标定值；kernel 优先只影响入选不影响排列序）。
  const chosen = new Set<number>();
  for (let i = 0; i < all.length && chosen.size < DECON_P2_TIMELINE_MAX_EVENTS; i++) {
    if (all[i]!.kernel) chosen.add(i);
  }
  for (let i = 0; i < all.length && chosen.size < DECON_P2_TIMELINE_MAX_EVENTS; i++) {
    chosen.add(i);
  }
  const selected = all.filter((_, i) => chosen.has(i));

  const eventIds = new Set(selected.map((e) => e.eventId));
  const annotation = await callDeconP2LlmParsed(
    ctx,
    'timeline',
    'extraction',
    DECON_P2_TIMELINE_SYSTEM_PROMPT,
    buildDeconTimelineUserPrompt(selected),
    DECON_P2_TIMELINE_MAX_TOKENS,
    (raw) => parseDeconTimelineAnnotationResponse(raw, eventIds),
    '注意：上一次输出包含未给出的事件编号或坏形状条目，已被整体拒收。只能对给出的编号作答。',
  );
  if (!annotation.ok) return annotation;

  // CR-16：漏答事件不静默丢弃（不受约束式拒收族保护——parser 只拦集外 id）——计数入审计 +
  // 回退排布（按章序保留原位，storyTimeLabel 缺省 + `unannotated: true` 标记；回退扫描只对
  // 已标注事件做）。
  const annotated = selected
    .filter((e) => annotation.parsed.has(e.eventId))
    .map((e) => ({ ...e, annotation: annotation.parsed.get(e.eventId)! }));
  const unannotatedCount = selected.length - annotated.length;
  if (unannotatedCount > 0) {
    ctx.audit.timelineUnannotated = (ctx.audit.timelineUnannotated ?? 0) + unannotatedCount;
    getLogger().warn(
      { jobId: ctx.jobId, unannotatedCount },
      'decon p2: timeline events not answered by annotator - kept in payload with unannotated marker',
    );
  }

  // 纯代码容错规则：回退检出 + 章内/跨章分类；带 device 的回退 → LLM 复核；无 device → 真矛盾。
  const { inversions, unexplained } = scanDeconTimelineInversions(annotated);
  let confirmed: DeconTimelineInversion[] = [];
  if (inversions.length > 0) {
    const review = await callDeconP2LlmParsed(
      ctx,
      'timeline',
      'review-judge',
      DECON_P2_TIMELINE_REVIEW_SYSTEM_PROMPT,
      buildDeconTimelineReviewUserPrompt(annotated, inversions),
      DECON_P2_TIMELINE_REVIEW_MAX_TOKENS,
      (raw) => parseDeconTimelineReviewResponse(raw, new Set(inversions.map((i) => i.eventId))),
      '注意：上一次输出包含未给出的编号或坏形状条目，已被整体拒收。只能对给出的编号作答。',
    );
    if (!review.ok) return review;
    confirmed = inversions.filter((i) => review.parsed.get(i.eventId) === true);
    for (const i of inversions) i.intentional = review.parsed.get(i.eventId) === true;
  }
  const conflicts = [...unexplained, ...inversions.filter((i) => i.intentional !== true)];
  const consistency: DeconTimelineConsistency =
    conflicts.length > 0 ? 'conflict' : confirmed.length > 0 ? 'intentional_loose' : 'exact';

  const conflictNote =
    conflicts.length > 0 || confirmed.length > 0
      ? [
          `${confirmed.length} 处有意时序装置（${confirmed.map((i) => `${i.eventId}@第${i.chapterIndex}章${i.withinChapter ? '（章内）' : ''}`).join('、') || '无'}）`,
          `${conflicts.length} 处真矛盾（${conflicts.map((i) => `${i.eventId}@第${i.chapterIndex}章${i.withinChapter ? '（章内）' : ''}`).join('、') || '无'}）`,
        ].join('；')
      : undefined;

  const anchors = capAnchors([...selected.filter((e) => e.kernel), ...selected.filter((e) => !e.kernel)].map((e) => e.span));
  const entry: DeconCanonEntry = {
    jobId: ctx.jobId,
    domain: 'timeline',
    name: '主线时间线',
    payload: {
      evidence: 'inferred',
      consistency,
      // CR-16 回退排布：全部 selected 按原章序进 payload（漏答项带标记），非仅已标注子集。
      events: selected.map((e) => {
        const a = annotation.parsed.get(e.eventId);
        return a === undefined
          ? { chapterIndex: e.chapterIndex, unannotated: true }
          : { chapterIndex: e.chapterIndex, storyTimeLabel: a.storyTimeLabel };
      }),
      ...(unannotatedCount > 0 ? { unannotatedCount } : {}),
      ...(conflictNote !== undefined ? { conflictNote } : {}),
      anomalies: [...confirmed, ...conflicts].map((i) => ({
        eventId: i.eventId,
        chapterIndex: i.chapterIndex,
        withinChapter: i.withinChapter,
        ...(i.device !== undefined ? { device: i.device } : {}),
        intentional: i.intentional === true,
      })),
    },
    anchors,
    provenance,
  };
  return { ok: true, entries: [entry] };
}

function buildDeconTimelineUserPrompt(events: ReadonlyArray<{ eventId: string; chapterIndex: number; what: string }>): string {
  return [
    '【事件（按阅读顺序——编号 | 章号 | 事件）】',
    ...events.map((e) => `${e.eventId} | 第${e.chapterIndex}章 | ${e.what}`),
    '',
    `共 ${events.length} 个事件。为每个事件标注故事内时间，输出 JSON 对象。`,
  ].join('\n');
}

function buildDeconTimelineReviewUserPrompt(
  annotated: ReadonlyArray<{ eventId: string; chapterIndex: number; what: string; annotation: DeconTimelineAnnotation }>,
  inversions: readonly DeconTimelineInversion[],
): string {
  const byId = new Map(annotated.map((e) => [e.eventId, e]));
  const lines = inversions.map((i) => {
    const ev = byId.get(i.eventId);
    const device = i.device !== undefined ? `，标注装置 ${i.device}` : '';
    return `${i.eventId} | 第${i.chapterIndex}章 | ${ev?.what ?? ''}${device} | 标注「${ev?.annotation.storyTimeLabel ?? ''}」（序数 ${ev?.annotation.timeOrder ?? '?'}）`;
  });
  return [
    '【待复核的时序回退（编号 | 章 | 事件 | 标注）】',
    ...lines,
    '',
    `共 ${inversions.length} 处。判断每处是否有意，输出 JSON 数组。`,
  ].join('\n');
}

// ── runDeconP2（六域顺序装配 + per-domain 断点重入 + 写侧 zod 门 + 同事务落库）──

export interface DeconP2Stats {
  domains: number;
  skippedDomains: number;
  entries: number;
  /** 域级审计计数（CR-3/CR-4/CR-12c/CR-14e/CR-16——零值面缺省）。 */
  audit?: DeconP2Audit;
}

export type DeconP2Result =
  | { status: 'done'; stats: DeconP2Stats }
  | { status: 'capped'; message: string; stats: DeconP2Stats }
  | { status: 'failed'; message: string; stats: DeconP2Stats }
  | { status: 'cancelled'; stats: DeconP2Stats }
  | { status: 'paused'; stats: DeconP2Stats }
  | { status: 'stale'; message: string };

export interface DeconP2Deps {
  generateText?: DeconGenerateText;
  /** 派生 .md 读取注入（缺省生产 readDeconDerivedTextFor；测试注入绕过 fs）。 */
  readDerivedText?: (material: Material) => string | null;
  /** 重试相位 note 注入（C3——runDeconPassSequence 传 stamped notify；直调测试缺省不发）。 */
  notify?: (event: DeconProgressEvent) => void;
  now?: () => Date;
}

function p2EmptyStats(): DeconP2Stats {
  return { domains: 0, skippedDomains: 0, entries: 0 };
}

/**
 * canon 写侧 zod 门 + 同域重名去重（CR-4；导出供直测）：无效条目（zod 不过——如零锚条目：
 * 读侧静默丢 → hash 永不匹配 → 域永久重烧的根因）丢弃 + 计数；重名条目（PK
 * (job,domain,name) 违约会炸落库事务）保首丢弃 + 计数。
 */
export function sanitizeDeconCanonEntries(
  jobId: string,
  audit: DeconP2Audit,
  domain: DeconCanonDomainOf,
  entries: readonly DeconCanonEntry[],
): DeconCanonEntry[] {
  const seenNames = new Set<string>();
  const out: DeconCanonEntry[] = [];
  for (const e of entries) {
    if (seenNames.has(e.name)) {
      audit.canonDroppedDuplicateNames = (audit.canonDroppedDuplicateNames ?? 0) + 1;
      continue;
    }
    if (!deconCanonEntrySchema.safeParse(e).success) {
      audit.canonDroppedInvalid = (audit.canonDroppedInvalid ?? 0) + 1;
      continue;
    }
    seenNames.add(e.name);
    out.push(e);
  }
  if (out.length < entries.length) {
    getLogger().warn(
      { jobId, domain, dropped: entries.length - out.length },
      'decon p2: canon entries dropped at write gate (invalid shape or duplicate name within domain)',
    );
  }
  return out;
}

type DeconCanonDomainOf = (typeof DECON_CANON_DOMAINS)[number];

/**
 * 跑 P2（pass='p2'，unit=域名）。前置：P1b facts 存在 + P1c 断点行 done（聚合实体已落）。
 * 每域：断点重入（done+hash 一致 skip）→ 装配（域函数——LLM 调用预算门前置）→ **写侧 zod 门
 * + 同域去重**（CR-4）→ canon per (job,domain) 全量替换 + pass_state done **同事务**落库
 * （hash 取 sanitize 后条目——落库面与读侧面同基，零锚域不再永久重烧）。六域全 done 返回 done。
 */
export async function runDeconP2(jobId: string, deps: DeconP2Deps = {}): Promise<DeconP2Result> {
  const nowIso = () => (deps.now ?? (() => new Date()))().toISOString();

  const gate = loadRunningDeconJob(jobId);
  if (!gate.ok) {
    if (gate.stop === 'paused') return { status: 'paused', stats: p2EmptyStats() };
    if (gate.stop === 'cancelled' || gate.stop === 'not-found') return { status: 'cancelled', stats: p2EmptyStats() };
    if (gate.stop === 'stale') return { status: 'stale', message: gate.message };
    return { status: 'failed', message: gate.message, stats: p2EmptyStats() };
  }
  const job: DeconJob = gate.job;

  const material = getMaterialRow(extractMaterialId(job.materialRef));
  if (material === null) {
    const message = `材料 ${job.materialRef} 不存在（或已删除）`;
    transitionDeconJob(jobId, 'fail', message);
    return { status: 'failed', message, stats: p2EmptyStats() };
  }
  const derived = (deps.readDerivedText ?? readDeconDerivedTextFor)(material);
  if (derived === null) {
    const message = '派生 .md 读取失败（缺失或车道不可解析）——无法锚定 canon 基面';
    transitionDeconJob(jobId, 'fail', message);
    return { status: 'failed', message, stats: p2EmptyStats() };
  }
  if (sha256DeconContent(derived) !== job.derivedHash) {
    transitionDeconJob(jobId, 'stale', DECON_STALE_NOTE);
    return { status: 'stale', message: DECON_STALE_NOTE };
  }

  const factsRows = listDeconChapterFacts(job.materialRef, job.derivedHash);
  if (factsRows.length === 0) {
    const message = '逐章 facts 不存在（closure_decon_facts 无同指纹行）——先跑 P1b 再跑 P2';
    transitionDeconJob(jobId, 'fail', message);
    return { status: 'failed', message, stats: p2EmptyStats() };
  }
  if (getDeconPassState(jobId, 'p1c', 'all')?.status !== 'done') {
    const message = 'P1c 聚合未完成（pass_state p1c 非 done）——先跑 P1c 再跑 P2';
    transitionDeconJob(jobId, 'fail', message);
    return { status: 'failed', message, stats: p2EmptyStats() };
  }

  const generate = deps.generateText ?? getDeconLlmCore()?.generateText;
  if (generate === undefined) {
    const message = '拆解 LLM 内核未装配（deconLlmCore 未接线）——已挂起，装配后重试';
    transitionDeconJob(jobId, 'fail', message);
    return { status: 'failed', message, stats: p2EmptyStats() };
  }

  const entities = listDeconEntities(job.materialRef, job.derivedHash);
  const blocks = splitParagraphBlocks(derived);
  const chapterOf = mapDeconBlocksToChapters(blocks, material.chapters);
  const provenance: DeconCanonEntry['provenance'] = {
    source: 'decon',
    materialId: extractMaterialId(job.materialRef),
    bookTitle: material.name,
  };
  const characterMaterials = collectCharacterMaterials(entities, factsRows, derived);
  const stats: DeconP2Stats = p2EmptyStats();
  const ctx: DeconP2Ctx = { jobId, job, generate, nowIso, cost: job.cost, audit: {}, ...(deps.notify !== undefined ? { notify: deps.notify } : {}) };

  for (const domain of DECON_CANON_DOMAINS) {
    // 中断韧性（CR-7：域边界如实判别 paused/cancelled/外部翻态——旧实现一律误报 paused；
    // 当前域照常完成落库，state 行保留，resume 经 per-domain skip 续跑）。
    const stop = checkDeconRunBoundary(jobId);
    if (stop !== null) {
      if (stop.status === 'paused') return { status: 'paused', stats };
      if (stop.status === 'cancelled') return { status: 'cancelled', stats };
      return { status: stop.status, message: stop.message, stats };
    }

    // 断点重入（per-domain——done+hash 一致 skip 不重付 LLM）。
    const existingEntries = listDeconCanonEntries(jobId, domain);
    const state = getDeconPassState(jobId, 'p2', domain);
    const decision = decideDeconPassReentry(state, hashDeconCanonOutput(existingEntries));
    if (decision === 'skip') {
      stats.domains += 1;
      stats.skippedDomains += 1;
      stats.entries += existingEntries.length;
      continue;
    }

    const outcome: DeconP2DomainOutcome =
      domain === 'character'
        ? await assembleCharacterDomain(ctx, characterMaterials, provenance)
        : domain === 'relationship'
          ? { ok: true, entries: assembleRelationshipDomain(ctx, entities, factsRows, provenance) }
          : domain === 'timeline'
            ? await assembleTimelineDomain(ctx, factsRows, provenance)
            : await assembleRecallDomain(ctx, domain, derived, blocks, chapterOf, entities, provenance);

    if (!outcome.ok) {
      if (outcome.kind === 'capped') {
        capDeconUnit(jobId, 'p2', domain, outcome.message, nowIso());
        return { status: 'capped', message: outcome.message, stats };
      }
      failDeconUnit(jobId, 'p2', domain, outcome.message, nowIso());
      return { status: 'failed', message: outcome.message, stats };
    }

    // 写侧 zod 门 + 同域去重（CR-4）——hash 取门后条目（落库面与读侧面同基）。
    const sanitized = sanitizeDeconCanonEntries(jobId, ctx.audit, domain, outcome.entries);
    replaceDeconCanonEntriesWithPassState(jobId, domain, sanitized, {
      jobId,
      pass: 'p2',
      unit: domain,
      status: 'done',
      outputRef: `canon:${domain}`,
      outputHash: hashDeconCanonOutput(sanitized),
      updatedAt: nowIso(),
    });
    stats.domains += 1;
    stats.entries += sanitized.length;
  }

  return { status: 'done', stats: { ...stats, audit: ctx.audit } };
}
