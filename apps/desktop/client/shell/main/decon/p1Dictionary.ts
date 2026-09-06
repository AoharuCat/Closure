import type { DeconDictionary, DeconDictionaryEntry, DeconJob, Material } from '@orison/shared-contracts';
import { DECON_PASS_UNIT_ALL, deconDictionaryEntrySchema } from '@orison/shared-contracts';
import { getDb } from '../db/index';
import {
  getDeconDictionary,
  getDeconPassState,
  upsertDeconDictionary,
  upsertDeconPassState,
} from '../db/closure-decon';
import { getMaterialRow } from '../db/materialIndexer';
import { getLogger } from '../logger';
import {
  DECON_STALE_NOTE,
  capDeconUnit,
  deconErrMsg,
  estimateDeconCallTokens,
  failDeconUnit,
  loadRunningDeconJob,
  readDeconDerivedTextFor,
  resolveDeconActualTokens,
  sha256DeconContent,
  writeDeconCost,
  writeDeconPassState,
} from './deconRun';
import { getDeconLlmCore, type DeconGenerateText } from './deconLlmCore';
import { accumulateDeconCost, wouldExceedDeconBudget } from './deconBudget';
import { decideDeconPassReentry, extractMaterialId, hashDeconDictionaryOutput, transitionDeconJob } from './deconJob';

// ── E10.3a（task 09-05）W3：P1a 实体词典预扫描（parent design §3——8.7 mention 同族不同源）──
//
// 拆外部书无自家 asset_cards 词表——**词典从材料自身长出**（parent design §3）：
//   1. 纯代码候选（三通道）：字级 2-4 gram 频次（内联停用词表）/ 命名模式正则族（「名叫/叫做/
//      绰号/道号/人称/自称」+ 排行形人名）/ 对话归属（中文引号前后言语动词邻接主语）。
//   2. 候选行约束式 LLM 分类（spec core/creative-vs-mechanical.md Pattern 直接 mirror）：
//      **只许从候选行选/标类，禁自创新名**——集外名 = 幻觉 → 整体拒收（重试一次，仍坏诚实挂起）。
//      五类（person/place/item/organization/concept）+ 置信（排序信号非门禁，E10.2b 拍板）。
//   3. 词典落 closure_decon_dictionary（材料级键控 F-07）+ pass_state 同事务写 done+output_hash。
//
// 范式判据（parent design §9 P1a 行）：候选生成纯代码；LLM 只做候选分类（extraction 温 0）。
// 幻觉过滤（本名与别名均不见于原文剔除）在 P1c 聚合后做（W5）——P1a 的约束式缝在构造上
// 先防一层（候选外名字进不了词典）。
//
// expected_downstream_consumers:
// - W4 p1Extract（词典注入逐章 prompt 压幻觉——getDeconDictionary 读侧）。
// - W2 createDeconJob 的 P1 继承面（同指纹词典行 → p1a 预标 done）。

// ── 常量（阈值推测值起步——dogfood 首本标定，mirror 10.2 常量纪律）──

/**
 * 候选行预算（LLM 分类输入上限）。超限按频次截断 top-N（实体候选是概率性召回通道——低频候选
 * 本就低价值，截断数入 result 统计诚实回报；与 10.1 分章候选「超限挂起」的差异：彼处候选 =
 * 章界全集截断必丢章，此处截断只降召回且可重扫）。
 */
export const DECON_P1A_CANDIDATE_BUDGET = 300;

/** n-gram 通道频次阈（设计「宁多候选多过滤」故低位；推测值 dogfood 标定）。 */
export const DECON_P1A_NGRAM_MIN_COUNT = 5;

/** 命名模式通道阈（显式命名句是强信号——1 次即候选）。 */
export const DECON_P1A_NAMING_MIN_COUNT = 1;

/** 对话归属通道阈（2 次 = 非偶发归属）。 */
export const DECON_P1A_DIALOGUE_MIN_COUNT = 2;

/**
 * 分类输出 token 预算（**每批独立核算**——E10.2a CR-2 配套纪律 + CR-12 分批）：每批 ≤100 候选
 * × 每条 {"name","type","confidence"} ≈ 20-25 tokens ≈ 2.5k，4096 含余量。截断由
 * finishReason='length' 权威挂起（不静默截断主张）。
 */
export const DECON_P1A_CLASSIFY_MAX_TOKENS = 4096;

/**
 * 分类分批大小（CR-12：300 候选单调用输出 ≈7.5k 逼近 8192 帽——length 截断即整单挂起）。
 * 每批 100 行串行，批间独立预算门/重试/记账。
 */
export const DECON_P1A_CLASSIFY_BATCH_SIZE = 100;

// ── 停用词表（内联单源——无分词依赖的噪声下压面；调表即调召回，dogfood 标定）──
//
// 字级停用字 = 虚词/代词/高频动词（几乎不出现在专名里）；词级停用词 = 由内容字构成的
// 高频非实体词。**刻意不含** 上下中门儿里等可入名字的常用字（宁多候选多过滤——recall 优先）。

const DECON_P1A_STOP_CHARS = new Set(
  '的了吗呢吧啊呀嘛啦哟呗哦嗯是在我你他她它您们这那也都很就还和与或及被把不给让到说要想着对个来去有无没已经然后于是可能应该正在开始进行起来出来回去看见听到觉得知道发现怎么如此但如果因为所以虽然并且而且仍然只能能够可以将会即将刚刚刚才立刻突然原来其实真的确实继续一直自己如今当时后来最后另外其他许多很多非常特别十分更加越来越顿时瞬间急忙缓缓轻轻紧紧'.split(
    '',
  ),
);

const DECON_P1A_STOP_WORDS = new Set([
  '什么', '没有', '自己', '现在', '知道', '时候', '时间', '出来', '东西', '一样', '声音', '身体',
  '感觉', '地方', '事情', '问题', '消息', '目光', '眼神', '脸色', '表情', '动作', '心中', '心里',
  '想到', '看着', '世界', '天下', '众人', '兄弟', '朋友', '师父', '公子', '小姐', '姑娘', '少年',
  '少女', '老者', '大汉', '汉子', '青年', '老人', '第一', '第二', '第三', '一起', '一边', '一面',
  '一声', '一句', '一时', '两人', '三人', '旁边', '身后', '面前', '眼前', '前面', '后面', '上面',
  '下面', '里面', '外面', '顿时', '随即', '接着', '跟着', '然后', '最后', '开始', '继续', '结束',
  '回来', '过去', '将来', '从前', '当下', '此时', '此刻', '同时', '马上', '立即', '忽然', '突然',
  '竟然', '居然', '原来', '似乎', '好像', '仿佛', '显得', '而且', '但是', '可是', '不过', '因此',
  '所以', '如果', '虽然', '只是', '还是', '就是', '便是', '也是', '都是', '要是', '除非', '无论',
  '不管', '只要', '只有', '还有', '全都', '全部', '不少', '一些', '有些', '一点', '一丝', '一阵',
  '一片', '一股', '一道', '说道', '问道', '笑道', '喊道', '叫道', '答道', '骂道', '叹道', '一个',
  '两个', '三个', '四个', '五个', '上方', '下方', '心情', '模样', '样子', '神色', '气息', '身份',
]);

/** CJK 字符域（基本区 + 扩展 A——候选/命名/对话三通道共用的「中文字」判定单源）。 */
const CJK_RUN_RE = /[㐀-䶿一-鿿]+/g;

/** 停用过滤（字级 OR 词级——n-gram 与命名捕获共用）。 */
function passesStopFilter(text: string): boolean {
  if (DECON_P1A_STOP_WORDS.has(text)) return false;
  for (const ch of text) {
    if (DECON_P1A_STOP_CHARS.has(ch)) return false;
  }
  return true;
}

/**
 * **词级 + 首字停用过滤**（CR-11：排行/前缀形人名通道专用）。停用字表含「十/一」（来自
 * 「十分/一直」等词的字级拆分）——字级过滤会 Cancels 掉排行形人名（王十/李一——序数通道的
 * **目标形态**）。序数/前缀捕获只做：整词停用拦截（'第一'/'一起'）+ **首字**停用拦截
 * （'的张三'式邻接噪声——真排行名不以虚词开头）；其余噪声交由频次阈 + LLM 分类下压。
 */
function passesOrdinalStopFilter(text: string): boolean {
  if (DECON_P1A_STOP_WORDS.has(text)) return false;
  const first = text[0];
  return first !== undefined && !DECON_P1A_STOP_CHARS.has(first);
}

// ── 通道①：字级 2-4 gram 频次（CJK run 内滑窗——无分词依赖的召回主通道）──

/**
 * n-gram 候选计数：对每个 CJK 连续段生成 2-4 gram，停用过滤后计数，≥ minCount 者留存。
 * 内存注记：长篇唯一 gram 峰值 ~数十万 Map 键（停用字过滤后远小），主进程可承受；
 * 低频噪声被阈值为主导杀——峰值出现在计数中段，落阈后空间即释放。
 */
function countNgramCandidates(text: string, minCount: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of text.matchAll(CJK_RUN_RE)) {
    const s = run[0];
    if (s.length < 2) continue;
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= s.length; i++) {
        const gram = s.slice(i, i + n);
        if (!passesStopFilter(gram)) continue;
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
      }
    }
  }
  const out = new Map<string, number>();
  for (const [gram, count] of counts) {
    if (count >= minCount) out.set(gram, count);
  }
  return out;
}

// ── 通道②：命名模式正则族（parent design §3——「名叫/叫做/绰号/道号/人称/自称」+ 排行形）──

/** 命名动词族（后随 2-4 CJK 即捕获；可选引号适配「绰号『酒剑仙』」形态）。 */
const NAMING_VERB_RE = /(?:名叫|叫做|唤作|唤做|名为|称之为|称为|绰号|诨号|道号|法号|外号|人称|自称)(?:[「『“"])?([㐀-䶿一-鿿]{2,4})/g;

/**
 * 排行/前缀形人名子串扫描（张三/欧阳三/老王族——AI-Reader-V2 数字前缀恢复同族）：CJK 连续段是
 * 整句（逗号/句号才是边界），排行形人名以子串形态出现——按形扫描全量候选（噪声由频次阈 +
 * 停用表 + LLM 分类三层下压，宁多候选多过滤）。**刻意不含「一」**（「X一」对高频爆炸——
 * '统一/万一' 族；排行用一极少见，dogfood 有实据再放开）。
 */
const ORDINAL_SUFFIX_2_RE = /[㐀-䶿一-鿿][二三四五六七八九十]/g;
const ORDINAL_SUFFIX_3_RE = /[㐀-䶿一-鿿]{2}[二三四五六七八九十]/g;
const PREFIX_NAME_RE = /[老小阿][㐀-䶿一-鿿]/g;

function countNamingCandidates(text: string, minCount: number): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const m of text.matchAll(NAMING_VERB_RE)) {
    const captured = m[1];
    if (captured !== undefined && passesStopFilter(captured)) bump(captured);
  }
  for (const re of [ORDINAL_SUFFIX_2_RE, ORDINAL_SUFFIX_3_RE, PREFIX_NAME_RE]) {
    for (const m of text.matchAll(re)) {
      // 排行/前缀通道走词级 + 首字停用过滤（CR-11——字级停用字「十/一」会误杀序数形目标形态）。
      const captured = m[0];
      if (passesOrdinalStopFilter(captured)) bump(captured);
    }
  }
  const out = new Map<string, number>();
  for (const [name, count] of counts) {
    if (count >= minCount) out.set(name, count);
  }
  return out;
}

// ── 通道③：对话归属（中文引号前后言语动词邻接主语——「……」李三说道 / 李三说：「……」）──

/** 言语动词族（长词在前防短词截断匹配）。 */
const POST_QUOTE_RE =
  /[」”』][，,。！!？?\s]{0,2}([㐀-䶿一-鿿]{1,4})(?:冷笑道|沉声道|低声道|开口道|回应道|说道|问道|喊道|叫道|答道|骂道|叹道|说|道|问|喊|叫|答|骂|笑)/g;
const PRE_QUOTE_RE =
  /([㐀-䶿一-鿿]{1,4})(?:冷笑道|沉声道|低声道|开口道|说道|问道|喊道|叫道|答道|骂道|笑道|说|道|问|喊|叫|答|骂)[：:，,]?\s*[「‘“『]/g;

function countDialogueCandidates(text: string, minCount: number): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const m of text.matchAll(POST_QUOTE_RE)) {
    const captured = m[1];
    if (captured !== undefined && passesStopFilter(captured)) bump(captured);
  }
  for (const m of text.matchAll(PRE_QUOTE_RE)) {
    const captured = m[1];
    if (captured !== undefined && passesStopFilter(captured)) bump(captured);
  }
  const out = new Map<string, number>();
  for (const [name, count] of counts) {
    if (count >= minCount) out.set(name, count);
  }
  return out;
}

// ── 三通道合并 + 截断 ──

/** 候选行（合并后——通道计数审计面）。 */
export interface DeconNameCandidate {
  name: string;
  ngramCount: number;
  namingCount: number;
  dialogueCount: number;
}

export interface DeconCandidateBuild {
  candidates: DeconNameCandidate[];
  /** 频次截断掉的候选数（top-N 之外——诚实回报，不静默丢）。 */
  truncated: number;
}

/**
 * 纯代码候选生成（范式判据「P1a 候选生成纯代码」）：三通道各自过阈后按名合并，频次降序 +
 * 名字升序（确定性）截断 top-N。无分词依赖；阈值/停用词表均为推测值起步（dogfood 标定）。
 */
export function buildDeconNameCandidates(
  text: string,
  maxCandidates: number = DECON_P1A_CANDIDATE_BUDGET,
): DeconCandidateBuild {
  const ngram = countNgramCandidates(text, DECON_P1A_NGRAM_MIN_COUNT);
  const naming = countNamingCandidates(text, DECON_P1A_NAMING_MIN_COUNT);
  const dialogue = countDialogueCandidates(text, DECON_P1A_DIALOGUE_MIN_COUNT);

  const merged = new Map<string, DeconNameCandidate>();
  const absorb = (source: 'ngramCount' | 'namingCount' | 'dialogueCount', counts: Map<string, number>): void => {
    for (const [name, count] of counts) {
      const existing = merged.get(name) ?? { name, ngramCount: 0, namingCount: 0, dialogueCount: 0 };
      existing[source] += count;
      merged.set(name, existing);
    }
  };
  absorb('ngramCount', ngram);
  absorb('namingCount', naming);
  absorb('dialogueCount', dialogue);

  const all = [...merged.values()].sort((a, b) => {
    const totalA = a.ngramCount + a.namingCount + a.dialogueCount;
    const totalB = b.ngramCount + b.namingCount + b.dialogueCount;
    if (totalA !== totalB) return totalB - totalA;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return {
    candidates: all.slice(0, Math.max(0, maxCandidates)),
    truncated: Math.max(0, all.length - Math.max(0, maxCandidates)),
  };
}

// ── 候选行约束式 LLM 分类（spec core/creative-vs-mechanical.md Pattern 直接 mirror）──

export const DECON_P1A_SYSTEM_PROMPT = [
  '你是小说的实体词典分类器。下面给你一份从书中提取的候选名词表（纯代码按频次和命名模式生成，含大量非实体噪声）。',
  '任务：从候选表中挑出真正的实体并分类。实体五类：person（人物）/ place（地点）/ item（物品）/ organization（组织）/ concept（概念）。',
  '规则：',
  '- 只能从候选表中选择，禁止自创新名字——输出候选表之外的名字会被整体拒收；',
  '- 不是实体的候选（普通词语、动作、时间、称呼泛称等）直接跳过不输出；',
  '- 每条输出 {"name":"候选名","type":"五类之一","confidence":0到1的小数}；confidence 是你的置信度，只用于人审队列排序，不会被自动采纳。',
  '输出：纯 JSON 数组（每元素含上述字段），不要任何解释或前后缀。',
].join('\n');

/** 分类 user prompt（纯函数，导出供直测/断言）。 */
export function buildDeconDictionaryUserPrompt(
  candidates: readonly DeconNameCandidate[],
  corrective = false,
): string {
  const rows = candidates.map((c, i) => `${i} | ${c.name} | ${c.ngramCount + c.namingCount + c.dialogueCount}`);
  return [
    '【候选表（序号 | 名字 | 出现频次）】',
    ...rows,
    '',
    `共 ${candidates.length} 行候选。挑出其中的实体并分类，输出 JSON 数组。`,
    ...(corrective
      ? ['', '注意：上一次输出包含候选表之外的名字或坏形状条目，已被整体拒收。只能输出候选表内的名字。']
      : []),
  ].join('\n');
}

/**
 * 解析分类响应（约束校验——spec Pattern「集外 = 整体拒收，不部分采纳」）：
 * - 任一条目坏形状（zod 不过）/ 名字不在候选集（自创新名 = 幻觉）→ 返 null 整体拒收；
 * - 重复名去重保首（确定性）；空数组 = LLM 诚实判零实体（合法负判）。
 */
export function parseDeconDictionaryClassifyResponse(
  raw: string,
  candidateNames: ReadonlySet<string>,
): DeconDictionaryEntry[] | null {
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
  const seen = new Set<string>();
  const entries: DeconDictionaryEntry[] = [];
  for (const el of arr) {
    const parsed = deconDictionaryEntrySchema.safeParse(el);
    if (!parsed.success) return null;
    if (!candidateNames.has(parsed.data.name)) return null; // 集外名 = 幻觉 → 整体拒收
    if (seen.has(parsed.data.name)) continue;
    seen.add(parsed.data.name);
    entries.push(parsed.data);
  }
  return entries;
}

// ── P1a 编排（job 门 → 指纹校验 → 断点重入 → 候选 → 约束式分类 → 落库）──

export interface DeconP1aStats {
  candidateCount: number;
  truncatedCandidates: number;
  classifyAttempts: number;
}

export type DeconP1aResult =
  | { status: 'done'; skipped: boolean; dictionary: DeconDictionary; stats: DeconP1aStats }
  | { status: 'capped'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'stale'; message: string }
  | { status: 'paused' }
  | { status: 'cancelled' };

export interface DeconP1aDeps {
  generateText?: DeconGenerateText;
  /** 派生 .md 读取注入（缺省生产 readDeconDerivedTextFor；测试注入绕过 fs）。 */
  readDerivedText?: (material: Material) => string | null;
  now?: () => Date;
  maxCandidates?: number;
}

/** 运行门停因 → runner 结果映射（CR-7 三态——p1a/p1c 同款；cancelled/not-found 静默停）。 */
function gateStopToP1Result(gate: { stop: string; message: string }): DeconP1aResult {
  switch (gate.stop) {
    case 'paused':
      return { status: 'paused' };
    case 'cancelled':
    case 'not-found':
      return { status: 'cancelled' };
    case 'stale':
      return { status: 'stale', message: gate.message };
    default:
      return { status: 'failed', message: gate.message };
  }
}

/**
 * 跑 P1a（pass='p1a'，unit='all' 单行）。断点语义（W2 decideDeconPassReentry）：
 * - done + 词典 hash 一致 → skip（不重付 LLM——跨 job 继承/重入零重算的判定面）；
 * - capped-hold → 本次尝试（预算门决定放行或再 cap——调大预算后续跑即此路径）；
 * - 派生 .md 现值 hash ≠ job 快照 → job=stale（F-02——锚点漂移不可静默沿用）。
 * capped 诚实挂起：预算判定在 LLM 调用**前**，超限不烧 token。分类**分批串行**（CR-12：
 * 每批 ≤DECON_P1A_CLASSIFY_BATCH_SIZE 候选，批间独立预算门/纠偏重试/记账）。
 */
export async function runDeconP1a(jobId: string, deps: DeconP1aDeps = {}): Promise<DeconP1aResult> {
  const now = deps.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();

  const gate = loadRunningDeconJob(jobId);
  if (!gate.ok) return gateStopToP1Result(gate);
  const job: DeconJob = gate.job;

  const material = getMaterialRow(extractMaterialId(job.materialRef));
  if (material === null) {
    failDeconUnit(jobId, 'p1a', DECON_PASS_UNIT_ALL, `材料 ${job.materialRef} 不存在（或已删除）`, nowIso());
    return { status: 'failed', message: `材料 ${job.materialRef} 不存在（或已删除）` };
  }
  const derived = (deps.readDerivedText ?? readDeconDerivedTextFor)(material);
  if (derived === null) {
    const message = '派生 .md 读取失败（缺失或车道不可解析）——无法锚定词典基面';
    failDeconUnit(jobId, 'p1a', DECON_PASS_UNIT_ALL, message, nowIso());
    return { status: 'failed', message };
  }
  if (sha256DeconContent(derived) !== job.derivedHash) {
    transitionDeconJob(jobId, 'stale', DECON_STALE_NOTE);
    return { status: 'stale', message: DECON_STALE_NOTE };
  }

  // 断点重入（done+hash 一致 skip；capped-hold 落到下方预算门再试）。
  const existingDict = getDeconDictionary(job.materialRef, job.derivedHash);
  const state = getDeconPassState(jobId, 'p1a', DECON_PASS_UNIT_ALL);
  const decision = decideDeconPassReentry(
    state,
    existingDict === null ? null : hashDeconDictionaryOutput(existingDict),
  );
  if (decision === 'skip' && existingDict !== null) {
    return {
      status: 'done',
      skipped: true,
      dictionary: existingDict,
      stats: { candidateCount: existingDict.entries.length, truncatedCandidates: 0, classifyAttempts: 0 },
    };
  }

  const generate = deps.generateText ?? getDeconLlmCore()?.generateText;
  if (generate === undefined) {
    const message = '拆解 LLM 内核未装配（deconLlmCore 未接线）——已挂起，装配后重试';
    failDeconUnit(jobId, 'p1a', DECON_PASS_UNIT_ALL, message, nowIso());
    return { status: 'failed', message };
  }

  const build = buildDeconNameCandidates(derived, deps.maxCandidates ?? DECON_P1A_CANDIDATE_BUDGET);
  const candidates = build.candidates;

  // 零候选：合法诚实负判——落空词典 + done（P1b 照跑，实体按章新面提取，P1c 聚合兜底）。
  if (candidates.length === 0) {
    const dictionary: DeconDictionary = { materialRef: job.materialRef, derivedHash: job.derivedHash, entries: [] };
    return landDictionary(jobId, job, dictionary, {
      candidateCount: 0,
      truncatedCandidates: build.truncated,
      classifyAttempts: 0,
    }, nowIso());
  }

  writeDeconPassState(jobId, 'p1a', DECON_PASS_UNIT_ALL, 'running', null, nowIso());

  // 约束式分类（CR-12 分批串行——每批 ≤DECON_P1A_CLASSIFY_BATCH_SIZE；批内重试一次：集外名/
  // 坏形状整体拒收后带纠偏提示再试，仍坏诚实挂起）。
  const candidateNames = new Set(candidates.map((c) => c.name));
  const entries: DeconDictionaryEntry[] = [];
  let attempts = 0;
  let cost = job.cost;
  for (let batchStart = 0; batchStart < candidates.length; batchStart += DECON_P1A_CLASSIFY_BATCH_SIZE) {
    const batch = candidates.slice(batchStart, batchStart + DECON_P1A_CLASSIFY_BATCH_SIZE);
    let batchEntries: DeconDictionaryEntry[] | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const user = buildDeconDictionaryUserPrompt(batch, attempt > 0);
      const est = estimateDeconCallTokens(DECON_P1A_SYSTEM_PROMPT, user, DECON_P1A_CLASSIFY_MAX_TOKENS);
      if (wouldExceedDeconBudget(job.budget, cost, 'p1a', est)) {
        const note = `p1a 词典分类预算超限（本次预估 ${est} tokens，已累计 ${cost.totalTokens}）——已诚实挂起（不烧 token），调整预算后续跑`;
        capDeconUnit(jobId, 'p1a', DECON_PASS_UNIT_ALL, note, nowIso());
        return { status: 'capped', message: note };
      }
      attempts += 1;
      let text = '';
      let finishReason: string | undefined;
      let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
      try {
        const response = await generate({
          slot: 'extraction',
          system: DECON_P1A_SYSTEM_PROMPT,
          user,
          maxTokens: DECON_P1A_CLASSIFY_MAX_TOKENS,
        });
        text = (response?.text ?? '').trim();
        finishReason = response?.finishReason;
        usage = response?.usage;
      } catch (err) {
        if (attempt > 0) {
          const message = `词典分类调用失败：${deconErrMsg(err)}`;
          failDeconUnit(jobId, 'p1a', DECON_PASS_UNIT_ALL, message, nowIso());
          return { status: 'failed', message };
        }
        continue;
      }
      // 实际记账（调用已发生——provider usage 真值优先 CR-13）并落 job 行（writeDeconCost 单源：
      // 行已删抛 DeconJobGoneError 静默中止，不 `?? job` 复活）。
      const actual = resolveDeconActualTokens(DECON_P1A_SYSTEM_PROMPT, user, text, usage);
      cost = accumulateDeconCost(cost, 'p1a', actual.tokens, 1, actual.estimated);
      writeDeconCost(jobId, job, cost, nowIso());
      if (finishReason === 'length') {
        if (attempt > 0) {
          const message = '词典分类输出因 token 上限截断（finishReason=length）——已挂起，不落半程词典';
          failDeconUnit(jobId, 'p1a', DECON_PASS_UNIT_ALL, message, nowIso());
          return { status: 'failed', message };
        }
        continue;
      }
      if (!text) {
        if (attempt > 0) {
          const message = '词典分类返回空回复——已挂起';
          failDeconUnit(jobId, 'p1a', DECON_PASS_UNIT_ALL, message, nowIso());
          return { status: 'failed', message };
        }
        continue;
      }
      const parsed = parseDeconDictionaryClassifyResponse(text, candidateNames);
      if (parsed === null) {
        if (attempt > 0) {
          const message = '词典分类两次整体拒收（候选外名字或坏形状——约束式校验失败），不硬给词典';
          failDeconUnit(jobId, 'p1a', DECON_PASS_UNIT_ALL, message, nowIso());
          return { status: 'failed', message };
        }
        getLogger().warn({ jobId }, 'decon p1a: classify response rejected (out-of-candidate or malformed) - retrying once');
        continue;
      }
      batchEntries = parsed;
      break;
    }
    if (batchEntries === null) {
      // belt（循环内失败路径已全部 return——不可达防御）。
      const message = '词典分类重试耗尽（不可达路径）';
      failDeconUnit(jobId, 'p1a', DECON_PASS_UNIT_ALL, message, nowIso());
      return { status: 'failed', message };
    }
    entries.push(...batchEntries);
  }

  const dictionary: DeconDictionary = { materialRef: job.materialRef, derivedHash: job.derivedHash, entries };
  return landDictionary(jobId, job, dictionary, {
    candidateCount: candidates.length,
    truncatedCandidates: build.truncated,
    classifyAttempts: attempts,
  }, nowIso());
}

/** 词典落库（产物 + pass_state done 同事务——W2「产物写入与状态写入同事务」纪律）。 */
function landDictionary(
  jobId: string,
  job: DeconJob,
  dictionary: DeconDictionary,
  stats: DeconP1aStats,
  nowIso: string,
): DeconP1aResult {
  const outputHash = hashDeconDictionaryOutput(dictionary);
  getDb().transaction(() => {
    upsertDeconDictionary(dictionary);
    upsertDeconPassState({
      jobId,
      pass: 'p1a',
      unit: DECON_PASS_UNIT_ALL,
      status: 'done',
      outputRef: 'dictionary:all',
      outputHash,
      updatedAt: nowIso,
    });
  })();
  if (stats.truncatedCandidates > 0) {
    getLogger().warn(
      { jobId, truncated: stats.truncatedCandidates },
      'decon p1a: candidates truncated to budget (top-N by frequency) - lower-value recall loss reported honestly',
    );
  }
  return { status: 'done', skipped: false, dictionary, stats };
}
