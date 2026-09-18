import { castDeclarationSchema, type CastDeclaration } from './cast-declaration';
import { z } from 'zod';

// ── Story 8.7 mention 共现账契约（章×实体账本，design §1.1/§4.1）──
//
// mention 账 = 「哪个实体在哪一章出场/被提及」的派生账本，行粒度 (章, 实体) 一行，双向可查：
// 实体→章（出场史，走 idx_mention_entry）/ 章→实体（名册，走 PK 前缀）。
//
// 四通道记账（零新增提取调用）：①写手写后申报（declared——LLM 语义，产物契约见 cast-declaration.ts）
// ②在场记录升格（presence_shot——/presence_scene patch 汇总）③粗筛明写名（coarse_hit/coarse_count——
// 卡名+别名全文子串计数）④计划登场对拍（plan_linked——SceneNode.assetRefs）；state_changed 由
// 本章 world patches 对拍物化。汇账/合并/取最高态 = 纯代码（design §2.2，本文件下方纯函数家族——S3）；
// 申报本身 = 写手 LLM 语义产物（范式判据 ADR-3：语义归 LLM，本文件的纯函数只做查询/汇编/计数）。
//
// DERIVED 可 drop 重建（prose 仍是唯一文件真相源，ADR-1/14 不变）：`record_episode_mentions`
// （shell recordEpisodeMentionsCore）无申报重调即纯代码通道保守重扫，随时可重建。
//
// ⚠️ 锚定语义（D1a）：entry_id 锚实体卡 entry_id，非按名字归组（GraphRAG 名字归组弱项——同角色
// 多称呼/绰号会分裂数据；名字→卡解析在汇账层做，本表只存解析后的锚）。无卡主体（group: 龙套等）
// 不入账；建卡前的不回溯（卡 id 桥在建卡时才产生）——已知限制诚实记录（design §1.1）。
//
// 类型层 camelCase；db 列 snake_case，repository 做映射（db-repository 惯例，mirror closure_world_*）。
//
// expected_downstream_consumers:
// - Story 8.7 S3（shell）：closure_mention 表 + mentionLedgerRepository（per-episode 全量替换 / 双向查询 /
//   修订降档 conservative / 实体→章数+最后章聚合）。
// - Story 8.7 S6（agent）：query_mentions 工具（ledger / gap_stats 两视图）。
// - Story 8.7 S8：mention-ledger-node 汇账（resolveCastNames → buildCoarseScan → mergeMentionChannels →
//   computeMentionSignals → 写表）。
// - Story 8.7 S9：buildAppearanceGapStats 纯函数——工具统计视图 / 资料员弹药 / 4.4 completeness L1
//   计数信号三暴露面单源；MentionSignal 持久化（closure_mention_signals 表，随汇账 upsert 同事务写）
//   ——五类信号是纯函数产物但重算输入（写手申报）不持久，leader 侧消费须读落表值非重算。

/**
 * 出场档位（最高态）：`present` = 正式登场出场（在场记录/申报登场/状态变化任一通道命中）；
 * `mentioned` = 只被提及（对话/叙述里出现名字，本人没露面——申报提及或明写名命中）。
 * presence 取最高态：present > mentioned。
 */
export const mentionPresenceSchema = z.enum(['present', 'mentioned']);
export type MentionPresence = z.infer<typeof mentionPresenceSchema>;

/**
 * 账目来源档位：`full` = 含写手申报通道（本章申报可信）；`conservative` = 仅纯代码通道
 * （降级直写/修订后旧账/补账章——申报缺失或已失效，保守但诚实）。
 */
export const mentionSourceSchema = z.enum(['full', 'conservative']);
export type MentionSource = z.infer<typeof mentionSourceSchema>;

/**
 * mention 账单行（closure_mention 表行的 Record 形态，snake_case 列 ↔ camelCase 映射归 repository）。
 * 行粒度 (章, 实体)；PK (projectId, episodeId, entryId)；幂等 = per-episode 全量替换（redo/重申报重收）。
 */
export const closureMentionRowSchema = z.object({
  /** registry 5 位 projectId（mirror closure_entry / closure_world_* 命名空间）。 */
  projectId: z.string().min(1),
  /** 章 id（episode 维度锚，mirror closure_chapter_summary）。 */
  episodeId: z.string().min(1),
  /** 锚定的实体卡 entry_id（D1a 锚卡非名字归组，见文件头）。 */
  entryId: z.string().min(1),
  /** 出场档位（最高态，见 mentionPresenceSchema）。 */
  presence: mentionPresenceSchema,
  /** 写手申报通道命中（0/1）：本章申报登场或提及该实体。 */
  declared: z.number().int().nonnegative(),
  /** 在场记录升格命中（0/1）：本章 /presence_scene patch 的 subject 桥到该卡。 */
  presenceShot: z.number().int().nonnegative(),
  /** 粗筛明写名命中（0/1）：卡名或别名在本章正文出现。 */
  coarseHit: z.number().int().nonnegative(),
  /** 计划登场对拍命中（0/1）：本章场 SceneNode.assetRefs 引用该卡。 */
  planLinked: z.number().int().nonnegative(),
  /** 明写名出现次数（保守计数：不重叠子串匹配，CJK 免分词）。 */
  coarseCount: z.number().int().nonnegative(),
  /** 状态变化对拍命中（0/1）：本章 world patches 触及该实体（目录行「有戏份」信号；恒 present）。 */
  stateChanged: z.number().int().nonnegative(),
  /** 账目来源档位（见 mentionSourceSchema）。 */
  source: mentionSourceSchema,
  /** 最后更新时间（ISO 字符串；db 侧 datetime('now')）。 */
  updatedAt: z.string().min(1),
});
export type ClosureMentionRow = z.infer<typeof closureMentionRowSchema>;

/**
 * `query_mentions` 工具/handler 入参（snake_case 对齐 agent tool params，mirror
 * closureStoryQuerySchema / relationQuerySchema；projectId 由 handler 从 projectDir 解析，非参数）。
 *
 * 双向查询：给 entry_id 返该实体出场史；给 episode_id 返该章名册；两者可同传（交集）。
 * `view` 切换返回形态——ledger（默认）= 逐条账本行；gap_stats = 出场间隔统计视图
 * （per-entity 最后出场章 + 间隔序数，提及也算露面；无 entry_id = 全实体统计）；signals = 近期章的
 * 申报对拍差异信号（五类 MentionSignal，S9 leader 注入段消费——signals 是纯函数产物但重算输入
 * （申报）不持久，故随汇账落表持久化，此处读出）。
 */
export const queryMentionsRequestSchema = z.object({
  entry_id: z
    .string()
    .min(1)
    .optional()
    .describe('实体条目 id——查「这个人物/实体在哪些章出场、被提及」。可从检索结果或实体目录行拿到'),
  episode_id: z.string().min(1).optional().describe('章 id——查「这一章里有谁出场、谁只被提到」'),
  presence: mentionPresenceSchema.optional().describe(
    '只看这一档：present=正式登场出场；mentioned=只在对话或叙述里被提到（本人没露面）。不填则两档都返回',
  ),
  view: z
    .enum(['ledger', 'gap_stats', 'signals'])
    .optional()
    .describe(
      '返回形态：ledger（默认）=逐条明细；gap_stats=出场间隔统计（每个实体最后出现在哪章、隔了几章没露面——用来发现快被读者遗忘的角色）；'
        + 'signals=最近几章的申报对拍差异（写手报的人物表与实际落笔的出入、计划登场没写成、新面孔、别名建议）',
    ),
});
export type QueryMentionsRequest = z.infer<typeof queryMentionsRequestSchema>;

// ── Story 8.7 S8：mention-ledger 写路径工具入参（链内写工具，camelCase mirror materializeChapterSummaryRequestSchema）──

/**
 * `record_episode_mentions` handler/tool 入参（mention-ledger-node → shell 汇账写入）。
 *
 * 链段侧组装（agent 包 mention-ledger-node）：episodeId 解析自 chapter_brief_input / declaration 取自
 * cast_declaration artifact（degraded 形态无 declaration 字段 → 省略 = 保守账）/ draftText 取自
 * draft.initial.text / plannedAssetRefs 取自 scene_graph 本章场 SceneNode.assetRefs 展开（缺省 = 计划
 * 通道全零）。db 侧数据（本章 patches / subject 卡桥 / 卡索引）由 handler 自取——调用方只传链内 artifact
 * 投影（mirror materialize_chapter_summary「调用方只给 episodeId」哲学，此处多传正文与申报因它们只存在
 * 于链内 artifact）。
 */
export const recordEpisodeMentionsRequestSchema = z.object({
  episodeId: z.string().min(1),
  /** 写手申报（本章 cast_declaration artifact 的 declaration 字段）；省略 = 无申报章 → 保守账。 */
  declaration: castDeclarationSchema.optional(),
  /** 本章正文（粗筛明写名扫描源；draft.initial.text；空串 = 粗筛通道全零）。 */
  draftText: z.string(),
  /** 本章计划登场卡 id 集（scene_graph 本章场 assetRefs 展开去重；省略/空 = 计划对拍通道全零）。 */
  plannedAssetRefs: z.array(z.string().min(1)).optional(),
});
export type RecordEpisodeMentionsRequest = z.infer<typeof recordEpisodeMentionsRequestSchema>;

/**
 * `degrade_episode_mentions` handler/tool 入参（mention 账保守化降档）。
 * handler 侧做两件事：mention 行 source 降 conservative（declared 清位）+ 章摘要 synopsis 标 stale
 * （degradedNote 追记）——均幂等。链内 targeted-revision 落盘触发面已随链流程重排退役
 * （09-13 W1d），现消费方 = W4 re-extract-chapter / 手改后保守化通道。
 */
export const degradeEpisodeMentionsRequestSchema = z.object({
  episodeId: z.string().min(1),
});
export type DegradeEpisodeMentionsRequest = z.infer<typeof degradeEpisodeMentionsRequestSchema>;

// ── Story 8.7 S3：mention 汇账纯函数家族（design §2.2/§2.4——零 IO，plain-vitest 可测）──
//
// 范式判据落点：粗筛计数 / 名字解析查表 / 四通道合并取最高态 / 差异信号判定 / 出场间隔统计 = 全部
// 「不理解意义」的查询/汇编/计数（ADR-3 纯代码窄域）；申报的语义内容（谁真登场了、梗概写什么）归写手
// LLM（cast-declaration.ts）。信号只产结构化数据——文案组装归 S9 leader 注入段。

/**
 * 卡索引条目（名字解析 + 粗筛的输入形态）：汇账层从 asset_cards / 索引投影出的「一张卡有哪些称呼」。
 * `aliases` 含卡上登记的全部别称/绰号（character 卡 basics.aliases 等）。
 */
export interface MentionCardIndexEntry {
  entryId: string;
  /** 卡名（主称呼）。 */
  name: string;
  /** 别名/绰号/头衔（粗筛与解析同源——别名积累→粗筛命中率自升，D1b-衍生闭环）。 */
  aliases?: readonly string[];
}

/**
 * 申报名字解析结果（`resolveCastNames` 单源产物——mergeMentionChannels / computeMentionSignals
 * / S8 汇账节点共用，防三处各写一套解析漂移）。
 *
 * 解析序（design §2.2 步骤 1）：精确卡名 → 别名 → 申报归属映射（present[].card / mentioned[].belongsTo
 * 指向卡名或卡 id）。三步全失败 → `unresolved`（新面孔池，走议题链不自动建卡，D1a）。
 * 经归属映射解析且称呼不在目标卡名/别名 → `aliasSuggestions`（建议加 aliases，人审/授权通道）。
 */
export interface ResolvedCastNames {
  /** 申报登场且解析到卡的 entry_id 集。 */
  declaredPresent: ReadonlySet<string>;
  /** 申报提及且解析到卡的 entry_id 集。 */
  declaredMentioned: ReadonlySet<string>;
  /** 三步全未解析的申报名（新面孔池）。`belongsTo` 透传申报归属（若有——归属本身也解析失败时保留线索）。 */
  unresolved: ReadonlyArray<{
    name: string;
    declaredAs: 'present' | 'mentioned';
    belongsTo?: string;
  }>;
  /** 归属映射解析出但称呼不在卡名/别名的称呼（alias 回填建议，AC-3）。 */
  aliasSuggestions: ReadonlyArray<{ name: string; entryId: string }>;
}

/**
 * 解析写手申报的名字 → 卡（纯函数，design §2.2 步骤 1）。
 *
 * 同名/同别名多卡时取 cardIndex 序首个（确定性；名字冲突本身是设定层数据问题，汇账层保守不猜）。
 * `declaration` undefined（降级直写/申报 parse 失败章）→ 全空结果（保守账：无申报通道）。
 */
export function resolveCastNames(
  declaration: CastDeclaration | undefined,
  cardIndex: readonly MentionCardIndexEntry[],
): ResolvedCastNames {
  const byName = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const byCardRef = new Map<string, string>(); // 归属映射可指卡名或卡 id
  const namesAndAliasesByEntry = new Map<string, { name: string; aliases: ReadonlySet<string> }>();
  for (const card of cardIndex) {
    if (!byName.has(card.name)) byName.set(card.name, card.entryId);
    if (!byCardRef.has(card.entryId)) byCardRef.set(card.entryId, card.entryId);
    if (!byCardRef.has(card.name)) byCardRef.set(card.name, card.entryId);
    const aliases = new Set(card.aliases ?? []);
    for (const alias of aliases) {
      if (!byAlias.has(alias)) byAlias.set(alias, card.entryId);
    }
    namesAndAliasesByEntry.set(card.entryId, { name: card.name, aliases });
  }

  const declaredPresent = new Set<string>();
  const declaredMentioned = new Set<string>();
  const unresolved: Array<{ name: string; declaredAs: 'present' | 'mentioned'; belongsTo?: string }> = [];
  const aliasSuggestions: Array<{ name: string; entryId: string }> = [];

  const resolveOne = (
    name: string,
    attribution: string | undefined,
    declaredAs: 'present' | 'mentioned',
  ): void => {
    const entryId = byName.get(name) ?? byAlias.get(name);
    if (entryId !== undefined) {
      (declaredAs === 'present' ? declaredPresent : declaredMentioned).add(entryId);
      return;
    }
    if (attribution !== undefined) {
      const attributed = byCardRef.get(attribution);
      if (attributed !== undefined) {
        (declaredAs === 'present' ? declaredPresent : declaredMentioned).add(attributed);
        // 归属解析成功且称呼不在该卡名/别名 → alias 回填建议（design §2.2 步骤 6 第五类）。
        const known = namesAndAliasesByEntry.get(attributed);
        if (known && name !== known.name && !known.aliases.has(name)) {
          aliasSuggestions.push({ name, entryId: attributed });
        }
        return;
      }
    }
    unresolved.push(
      attribution !== undefined ? { name, declaredAs, belongsTo: attribution } : { name, declaredAs },
    );
  };

  if (declaration !== undefined) {
    for (const entry of declaration.present) resolveOne(entry.name, entry.card, 'present');
    for (const entry of declaration.mentioned) resolveOne(entry.name, entry.belongsTo, 'mentioned');
  }
  return { declaredPresent, declaredMentioned, unresolved, aliasSuggestions };
}

/**
 * 粗筛明写名扫描（纯函数，design §2.2 步骤 2）：全部卡名+别名在正文做**不重叠子串计数**（CJK 免分词
 * ——字符串匹配对中文零指代/转喻结构性漏检，只当「至少这些章有命中」的保守下界，research/method-c-brainstorm）。
 *
 * 不重叠规则（保守计数的界）：全部命中按 **位置升序、同位置长度降序** 贪心占位——
 * - 同位置多名命中取最长匹配（「李三丰」不再重复计「李三」；跨卡同名时长名卡独占，短名卡不计——
 *   防误归因给短名角色）；
 * - 不同位置先到先得（先出现者占住区间，与其重叠的后到命中不计）。
 *
 * @returns Map<entryId, count>——只含有命中的卡（未命中卡不入 Map，coarseCount=0）；按 cardIndex 序确定。
 */
export function buildCoarseScan(
  text: string,
  cardIndex: readonly MentionCardIndexEntry[],
): Map<string, number> {
  const counts = new Map<string, number>();
  if (text.length === 0 || cardIndex.length === 0) return counts;

  // 全局命中收集：{start, end, entryId}。同卡 name==alias 去重（防同位置双计）。
  const matches: Array<{ start: number; end: number; entryId: string }> = [];
  for (const card of cardIndex) {
    const needles = new Set<string>([card.name, ...(card.aliases ?? [])]);
    for (const needle of needles) {
      if (needle.length === 0) continue;
      let idx = text.indexOf(needle);
      while (idx !== -1) {
        matches.push({ start: idx, end: idx + needle.length, entryId: card.entryId });
        idx = text.indexOf(needle, idx + 1);
      }
    }
  }

  // 位置升序、同位置长度降序（end 降序）——同位置最长先占位。
  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  let occupiedUntil = -1;
  for (const m of matches) {
    if (m.start < occupiedUntil) continue; // 与已占区间重叠 → 不计（保守）
    counts.set(m.entryId, (counts.get(m.entryId) ?? 0) + 1);
    occupiedUntil = m.end;
  }

  // 按 cardIndex 序输出（确定性）。
  const ordered = new Map<string, number>();
  for (const card of cardIndex) {
    const count = counts.get(card.entryId);
    if (count !== undefined) ordered.set(card.entryId, count);
  }
  return ordered;
}

/** per-entry 纯代码通道命中事实（汇账步骤 2-4 产物：粗筛 + 在场升格 + 计划对拍 + 状态对拍）。 */
export interface MentionChannelFacts {
  entryId: string;
  /** 粗筛明写名出现次数（buildCoarseScan 产物；0 = 未命中）。 */
  coarseCount: number;
  /** 在场记录升格（本章 /presence_scene patch 的 subject 经 source_card_id 桥到该卡）。 */
  presenceShot: boolean;
  /** 计划登场对拍（本章场 SceneNode.assetRefs 引用该卡）。 */
  planLinked: boolean;
  /** 状态变化对拍（本章 world patches 触及该实体——目录行「有戏份」信号，恒 present）。 */
  stateChanged: boolean;
}

/** `mergeMentionChannels` 输出：账行核心（projectId/episodeId/updatedAt 归 repository/调用方注入）。 */
export interface MergedMentionRow {
  entryId: string;
  /** 出场档位（最高态）。 */
  presence: MentionPresence;
  declared: number;
  presenceShot: number;
  coarseHit: number;
  planLinked: number;
  coarseCount: number;
  stateChanged: number;
  source: MentionSource;
}

/** `mergeMentionChannels` 入参（单章一次调用）。 */
export interface MergeMentionChannelsInput {
  /** 卡索引（申报名字解析用，resolveCastNames 单源）。 */
  cardIndex: readonly MentionCardIndexEntry[];
  /**
   * 写手申报（本章 cast_declaration artifact）；undefined = 无申报章（降级直写 / parse 两试失败 /
   * 补账章）——落保守账：declared 全 0、source 全 conservative。
   */
  declaration?: CastDeclaration;
  /** per-entry 纯代码通道事实（粗筛/在场/计划/状态）。 */
  channelFacts: readonly MentionChannelFacts[];
}

/**
 * 四通道合并取最高态 + source 档（纯函数，design §2.2 步骤 5）。行集 = 通道事实实体 ∪ 申报解析实体
 * （申报了但纯代码通道零命中的实体也有行——申报是主通道；反向零证据不产生行）。
 *
 * presence 最高态规则（closureMentionRowSchema JSDoc 单源）：
 * `present` = 申报登场 ∨ 在场记录 ∨ 状态变化（语义能证在场的通道）；否则 `mentioned`（申报提及或
 * 仅粗筛明写名——名字出现在正文不等于本人露面，粗筛是保守下界不升档）。
 *
 * source 档是**章级**语义（schema JSDoc「full = 本章申报可信」）：本章有申报 → 全行 full；无申报章
 * 全行 conservative。修订降档（degradeEpisodeToConservative）与之自洽——declared 清位后整章翻保守。
 *
 * 输出按 entryId 升序（确定性）。
 */
export function mergeMentionChannels(input: MergeMentionChannelsInput): MergedMentionRow[] {
  const resolved = resolveCastNames(input.declaration, input.cardIndex);
  const factsByEntry = new Map<string, MentionChannelFacts>();
  for (const fact of input.channelFacts) factsByEntry.set(fact.entryId, fact);

  const entryIds = new Set<string>(factsByEntry.keys());
  for (const id of resolved.declaredPresent) entryIds.add(id);
  for (const id of resolved.declaredMentioned) entryIds.add(id);

  const rows: MergedMentionRow[] = [];
  for (const entryId of [...entryIds].sort()) {
    const fact = factsByEntry.get(entryId);
    const coarseCount = fact?.coarseCount ?? 0;
    const presenceShot = fact?.presenceShot ?? false;
    const planLinked = fact?.planLinked ?? false;
    const stateChanged = fact?.stateChanged ?? false;
    const declaredPresent = resolved.declaredPresent.has(entryId);
    const declaredMentioned = resolved.declaredMentioned.has(entryId);
    rows.push({
      entryId,
      presence:
        declaredPresent || presenceShot || stateChanged
          ? ('present' as const)
          : ('mentioned' as const),
      declared: declaredPresent || declaredMentioned ? 1 : 0,
      presenceShot: presenceShot ? 1 : 0,
      coarseHit: coarseCount > 0 ? 1 : 0,
      planLinked: planLinked ? 1 : 0,
      coarseCount,
      stateChanged: stateChanged ? 1 : 0,
      source: input.declaration !== undefined ? ('full' as const) : ('conservative' as const),
    });
  }
  return rows;
}

/** 对拍差异信号（纯函数产物——结构化数据，文案组装归 S9 leader 注入段）。 */
export type MentionSignal =
  | {
      /** 硬漏报：状态变化但未申报登场（写手最该抓的漏——动了戏没报名单）。 */
      kind: 'hard_miss';
      episodeId: string;
      entryId: string;
    }
  | {
      /** 软差异：粗筛明写名命中但未申报（高熵段自查失误特征，ConStory）。 */
      kind: 'soft_miss';
      episodeId: string;
      entryId: string;
      coarseCount: number;
    }
  | {
      /** 计划落差：计划登场但无任何实际通道（计划没写成——事故信号）。 */
      kind: 'plan_deviation';
      episodeId: string;
      entryId: string;
    }
  | {
      /** 新面孔：三步解析全失败的申报名（LLM 判→人审链，不自动建卡，D1a）。 */
      kind: 'new_face';
      episodeId: string;
      name: string;
      declaredAs: 'present' | 'mentioned';
      belongsTo?: string;
    }
  | {
      /** 别名建议：归属映射解析出但称呼不在卡名/别名（建议加 aliases，人审/授权通道，AC-3）。 */
      kind: 'alias_suggestion';
      episodeId: string;
      name: string;
      entryId: string;
    };

/** `computeMentionSignals` 入参（单章一次调用；与 mergeMentionChannels 同形——S8 一次组装两处喂）。 */
export interface MentionSignalInput {
  episodeId: string;
  cardIndex: readonly MentionCardIndexEntry[];
  /** 写手申报；undefined = 无申报章——hard/soft（申报↔检测对拍）与 new_face/alias 不产生，plan 对拍照常。 */
  declaration?: CastDeclaration;
  channelFacts: readonly MentionChannelFacts[];
}

/**
 * 对拍差异信号（纯函数，design §2.2 步骤 6 五类）。
 *
 * - **hard_miss**：stateChanged && 未申报登场（申报提及不算登场——状态变化说明本人动了戏）。
 * - **soft_miss**：粗筛命中 && 未申报（登场/提及任一申报都算已报）。
 * - **plan_deviation**：planLinked && 无任何实际通道（申报/在场/粗筛/状态全零——计划登场没写成）。
 * - **new_face / alias_suggestion**：经 resolveCastNames 单源（申报侧信号，无申报章不产生）。
 *
 * 无申报章（declaration undefined）：1/2/4/5 类以「申报存在」为对照系，无申报即无对照——不产生
 * （保守不刷屏）；plan_deviation 是计划↔正文对拍，与申报无关，照常产生。
 *
 * 输出五类分组固定序（hard → soft → plan → new_face → alias），组内 entryId/name 升序（确定性）。
 */
export function computeMentionSignals(input: MentionSignalInput): MentionSignal[] {
  const resolved = resolveCastNames(input.declaration, input.cardIndex);
  const factsByEntry = new Map<string, MentionChannelFacts>();
  for (const fact of input.channelFacts) factsByEntry.set(fact.entryId, fact);

  const hard: MentionSignal[] = [];
  const soft: MentionSignal[] = [];
  const plan: MentionSignal[] = [];
  const hasDeclaration = input.declaration !== undefined;

  for (const entryId of [...factsByEntry.keys()].sort()) {
    const fact = factsByEntry.get(entryId)!;
    const declared =
      resolved.declaredPresent.has(entryId) || resolved.declaredMentioned.has(entryId);
    if (hasDeclaration) {
      if (fact.stateChanged && !resolved.declaredPresent.has(entryId)) {
        hard.push({ kind: 'hard_miss', episodeId: input.episodeId, entryId });
      }
      if (fact.coarseCount > 0 && !declared) {
        soft.push({
          kind: 'soft_miss',
          episodeId: input.episodeId,
          entryId,
          coarseCount: fact.coarseCount,
        });
      }
    }
    const anyActual =
      declared || fact.presenceShot || fact.coarseCount > 0 || fact.stateChanged;
    if (fact.planLinked && !anyActual) {
      plan.push({ kind: 'plan_deviation', episodeId: input.episodeId, entryId });
    }
  }

  const newFaces: MentionSignal[] = resolved.unresolved
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((u) =>
      u.belongsTo !== undefined
        ? {
            kind: 'new_face',
            episodeId: input.episodeId,
            name: u.name,
            declaredAs: u.declaredAs,
            belongsTo: u.belongsTo,
          }
        : { kind: 'new_face', episodeId: input.episodeId, name: u.name, declaredAs: u.declaredAs },
    );
  const aliasSugs: MentionSignal[] = resolved.aliasSuggestions
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((s) => ({
      kind: 'alias_suggestion',
      episodeId: input.episodeId,
      name: s.name,
      entryId: s.entryId,
    }));

  return [...hard, ...soft, ...plan, ...newFaces, ...aliasSugs];
}

// ── Story 8.7 S3 / design §2.4：出场间隔统计——单源纯函数多暴露面（D8）──
//
// 三个暴露面消费同一实现（mirror 2.6 collectRelevantDecisions 单源多消费先例）：
// ① 工具面 query_mentions view='gap_stats'；② 资料员弹药装配（S9 双源签名——mentions 优先，无
// mention 行/窗缺章的 subject 退 patches 口径，backfill 前兼容）；③ 4.4 completeness L1 计数信号
// （纯计数不判意义——「该不该出场/是否遗忘」归 L2 语义层，假信心门红线）。

/** patches 口径输入的最小结构（WorldPatch 结构满足；测试/编译面可传瘦身形态）。 */
export interface AppearancePatchFact {
  subjectId: string;
  storyTime: number;
  /** 所属 slice.id（`${episodeId}:${storyTime}` 契约）——lastEpisodeId 派生用，可缺。 */
  sliceId?: string;
}

/** episode → storyTime 窗（closure_chapter_summary 投影；start/end 缺 = 该章无已提取 events）。 */
export interface EpisodeStoryTimeWindow {
  episodeId: string;
  storyTimeStart?: number | null;
  storyTimeEnd?: number | null;
}

/**
 * 出场间隔统计条目。⚠️ `entryId` 字段的**双命名空间**（S9 起唯一统计条目形态——8.4 资料员侧旧
 * patches-only 口径的 SubjectAppearanceInterval 已随双源接线移除，弹药/工具/编译三面统一本形态）：
 * - `basis='mention'`：实体卡 entry_id（D1a 锚卡）；
 * - `basis='patches'`：世界主体 subject id（无 mention 行/窗缺章回退的世界状态口径——建卡前或
 *   无桥主体）。
 * 两命名空间在「subject id 沿用卡 id」时重合（常见：从卡登记的主体）；不一致时是两个不同行——
 * 精确桥（closure_world_subject.source_card_id）在调用方可得时可先把 patches 入参映射成卡
 * entry_id 再传入；本纯函数零 IO 不查桥，去重键 = id 字符串相等。
 */
export interface AppearanceGapStat {
  entryId: string;
  /** 统计口径：mention 账（提及也算露面） / 世界状态 patches（回退口径）。 */
  basis: 'mention' | 'patches';
  /** 最后露面所在章（mention 口径 = mention 行 episodeId；patches 口径从 slice.id 前缀派生，可缺）。 */
  lastEpisodeId?: string;
  /** 最后露面 storyTime。 */
  lastStoryTime: number;
  /** 距 anchor 的 storyTime 序数差（正值 = anchor 之前；<=0 的未来/同点数据被 minGap 滤除）。 */
  storyTimeGap: number;
}

/**
 * 出场间隔统计（纯函数，design §2.4）。**mention 行优先——提及也算露面**（正是 8.4 patches 口径的
 * 盲区补全）；无 mention 行的 subject / 窗缺章回退 patches 口径（exact storyTime，兼容 backfill 前）。
 *
 * mention 行 storyTime 换算：episode 锚 → 经 `episodeStoryTimeWindows` 取窗（**storyTimeEnd 优先**，
 * 缺 end 用 start——章窗终点是「该章内最后可能露面时刻」，用 end 算 gap 是保守侧不高估间隔）。
 * 窗缺章（无窗或 start/end 全缺）→ 该实体 mention 口径不完整 → 有 patches 数据则退 patches 口径；
 * 无 patches 则用已解析窗的 mention 行 best-effort（全部行都无窗且无 patches → 无从定位，跳过该实体）。
 *
 * @param cap    条目上限（缺省 12 = mirror 资料员弹药 AMMO_INTERVAL_CAP——常量留在 agent 侧，此处
 *               只收参数；按 gap 降序取前 N，最久未露面者最有建议价值）。
 * @param minGap 只报 gap ≥ 此值的实体（缺省 1 = mirror AMMO_INTERVAL_MIN_GAP——近期活跃者滤掉）。
 * @returns      按 storyTimeGap 降序（同 gap 按 entryId 升序），至多 cap 条。
 */
export function buildAppearanceGapStats(
  mentions: readonly ClosureMentionRow[],
  patches: readonly AppearancePatchFact[],
  episodeStoryTimeWindows: readonly EpisodeStoryTimeWindow[],
  anchorStoryTime: number,
  cap: number = 12,
  minGap: number = 1,
): AppearanceGapStat[] {
  const windowByEpisode = new Map<string, EpisodeStoryTimeWindow>();
  for (const w of episodeStoryTimeWindows) windowByEpisode.set(w.episodeId, w);

  // 窗 → 该章 storyTime（end 优先，缺 end 用 start；全缺 = 窗不可用）。
  const windowStoryTime = (w: EpisodeStoryTimeWindow | undefined): number | undefined => {
    if (w === undefined) return undefined;
    if (w.storyTimeEnd !== null && w.storyTimeEnd !== undefined && Number.isFinite(w.storyTimeEnd)) {
      return w.storyTimeEnd;
    }
    if (
      w.storyTimeStart !== null &&
      w.storyTimeStart !== undefined &&
      Number.isFinite(w.storyTimeStart)
    ) {
      return w.storyTimeStart;
    }
    return undefined;
  };

  // mention 口径分组：per entry 全部行的窗解析（全解析才算完整；有缺窗标记 degraded）。
  const mentionByEntry = new Map<
    string,
    { best?: { storyTime: number; episodeId: string }; allResolved: boolean }
  >();
  for (const row of mentions) {
    const storyTime = windowStoryTime(windowByEpisode.get(row.episodeId));
    const group = mentionByEntry.get(row.entryId) ?? { allResolved: true };
    if (storyTime === undefined) {
      group.allResolved = false;
    } else if (group.best === undefined || storyTime > group.best.storyTime) {
      group.best = { storyTime, episodeId: row.episodeId };
    }
    mentionByEntry.set(row.entryId, group);
  }

  // patches 口径：per subject 最后活跃（分组 + max——8.4 资料员弹药口径的本体，S9 起收编为本函数回退臂）。
  const lastBySubject = new Map<string, { storyTime: number; episodeId?: string }>();
  for (const p of patches) {
    const prev = lastBySubject.get(p.subjectId);
    if (prev !== undefined && prev.storyTime >= p.storyTime) continue;
    lastBySubject.set(p.subjectId, {
      storyTime: p.storyTime,
      episodeId: episodeIdOfSlice(p.sliceId),
    });
  }

  const out: AppearanceGapStat[] = [];
  const emit = (stat: AppearanceGapStat): void => {
    if (stat.storyTimeGap < minGap) return;
    out.push(stat);
  };

  for (const [entryId, group] of mentionByEntry) {
    const patchLast = lastBySubject.get(entryId);
    if (group.best !== undefined && group.allResolved) {
      // 完整 mention 口径（最富：提及也算露面）。
      emit({
        entryId,
        basis: 'mention',
        lastEpisodeId: group.best.episodeId,
        lastStoryTime: group.best.storyTime,
        storyTimeGap: anchorStoryTime - group.best.storyTime,
      });
    } else if (patchLast !== undefined) {
      // 窗缺章 / 全行无窗 → mention 口径不完整：退 patches 口径（storyTime 精确，兼容 backfill 前）。
      emit({
        entryId,
        basis: 'patches',
        ...(patchLast.episodeId !== undefined ? { lastEpisodeId: patchLast.episodeId } : {}),
        lastStoryTime: patchLast.storyTime,
        storyTimeGap: anchorStoryTime - patchLast.storyTime,
      });
    } else if (group.best !== undefined) {
      // 无 patches 可退 → 已解析窗的 mention 行 best-effort（缺窗章可能晚于已解析行——间隔或被高估，
      // 消费端是建议性信号容忍；诚实保留好过丢数据）。
      emit({
        entryId,
        basis: 'mention',
        lastEpisodeId: group.best.episodeId,
        lastStoryTime: group.best.storyTime,
        storyTimeGap: anchorStoryTime - group.best.storyTime,
      });
    }
    // else：全部行无窗且无 patches → 无从定位，跳过（诚实缺位而非编造）。
  }
  for (const [subjectId, last] of lastBySubject) {
    if (mentionByEntry.has(subjectId)) continue; // mention 口径已覆盖（含回退路径）的同 id 不双报
    emit({
      entryId: subjectId,
      basis: 'patches',
      ...(last.episodeId !== undefined ? { lastEpisodeId: last.episodeId } : {}),
      lastStoryTime: last.storyTime,
      storyTimeGap: anchorStoryTime - last.storyTime,
    });
  }

  out.sort((a, b) => b.storyTimeGap - a.storyTimeGap || (a.entryId < b.entryId ? -1 : 1));
  return out.slice(0, Math.max(0, cap));
}

/**
 * episodeId 从 slice.id 前缀派生（world-state.ts Story 8.1 稳定契约 `${episodeId}:${storyTime}`）。
 * 8.4 资料员侧曾有同形私有 helper——S9 双源接线后 patches 分组收编本函数内，此为唯一实现。
 */
function episodeIdOfSlice(sliceId: string | undefined): string | undefined {
  if (sliceId === undefined) return undefined;
  const idx = sliceId.lastIndexOf(':');
  if (idx <= 0) return undefined;
  const episodeId = sliceId.slice(0, idx);
  return episodeId.length > 0 ? episodeId : undefined;
}

// ── Story 8.7 S9：五类对拍信号的人话单行（单源——query_mentions signals 视图与 leader 注入段共用）──
//
// 纯事实 + 类别含义（说人话双规则：说作用不说实现，特殊名词就地解释——「申报」= 写手交稿时顺手报的
// 本章人物表）。判断/处置建议的措辞归各消费端（handler 尾注 / leader 段路由指引），此处只钉「一条信号
// 一行什么」防两处文案漂移。

/**
 * 单条对拍差异信号 → 人话一行（纯机械事实；五类含义见 MentionSignal 各 kind JSDoc）。
 * 消费面：query_mentions view='signals' 输出行 + leader 议题注入段（S9 单源双消费）。
 *
 * **default 分支（BMad CR-004，2026-08-19）**：信号行读取零 schema 校验（db JSON 列直出），版本 skew
 * （新版本写的 kind 旧版本不识）/ 手改库会产生五类之外的 kind——switch 穷尽五类后无 default 会返回
 * 字面 `undefined` 行进 leader system prompt 与工具输出。default 返降级文案（诚实标注「未知类型」
 * 而非编造内容），未知行的处置归消费端（leader 提示作者重收该章账）。
 */
export function describeMentionSignal(signal: MentionSignal): string {
  switch (signal.kind) {
    case 'hard_miss':
      return `[${signal.episodeId}] ${signal.entryId}：世界状态显示他动了戏（状态变了），但写手没把他报进本章人物表`;
    case 'soft_miss':
      return `[${signal.episodeId}] ${signal.entryId}：名字在正文出现了 ${signal.coarseCount} 次，但写手没报（登场或被提及都没报）`;
    case 'plan_deviation':
      return `[${signal.episodeId}] ${signal.entryId}：计划里本章该登场，但正文、人物表、状态记录里都没有——计划没写成`;
    case 'new_face':
      return `[${signal.episodeId}] 新面孔「${signal.name}」：写手申报他${
        signal.declaredAs === 'present' ? '登场' : '被提及'
      }${signal.belongsTo !== undefined ? `（写手标注归属：${signal.belongsTo}）` : ''}，但项目没有对应的卡`;
    case 'alias_suggestion':
      return `[${signal.episodeId}] 称呼「${signal.name}」：写手用它指 ${signal.entryId}，但这张卡的别名清单里没有——补录后记账与检索才都认得这个称呼`;
    default: {
      // 未知 kind（版本 skew / 手改库行）——防御读取（kind/episodeId 可能缺失），不产 "undefined" 字面。
      const s = signal as unknown as { kind?: unknown; episodeId?: unknown };
      const kindText =
        typeof s.kind === 'string' && s.kind.length > 0 ? s.kind : '(缺失)';
      const episodeText =
        typeof s.episodeId === 'string' && s.episodeId.length > 0 ? s.episodeId : '未知章';
      return `[${episodeText}] 未知信号类型（kind=${kindText}）——无法解读，建议重收该章出场账`;
    }
  }
}
