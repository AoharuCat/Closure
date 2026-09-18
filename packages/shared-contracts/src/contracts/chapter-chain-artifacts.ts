import type { z } from 'zod';
import { z as zValue } from 'zod';
import {
  sceneGraphSchema,
  promiseRegistrySchema,
  episodeOutlinesSchema,
  infoReleaseMapSchema,
  manipulationDirectiveSchema,
  emotionPointSchema,
  emotionCurveSchema,
} from './creative-fields';
import type { EmotionPoint, EmotionCurve } from './creative-fields';
import {
  type SettingPrefixInput,
  type PinnedPrefixItem,
} from './setting-prefix';
import { compileSettingContext } from './setting-assembly';
import { estimateSettingsSegments } from './compile-report';
import { chapterBriefSchema } from './chapter-brief';
import type { ChapterBrief } from './chapter-brief';
import { briefEmotionTargetSchema } from './chapter-brief';
import type { BriefEmotionTarget } from './chapter-brief';
import type { RevisionGuardArtifact } from './revision-guard';
import type { ResearchSuspension } from './research-brief';
import { storyDecisionDraftSchema, storyDecisionSchema, type StoryDecisionDraft } from './story-decision';
import type { StoryDecision } from './story-decision';
import { revisionIntentSchema } from './revision-intent';
// 链流程重排 W4（R6 链外重提取）：story-sync 再提取产物 + PatchReview envelope 形态（ReExtractChapterResult）。
import type { NovelStorySyncPayload } from './novel-orchestration';
import type { FieldPatchEntry } from './project-patch';

// ── Story 4.0 写章战术链段：initialArtifacts 组装纯函数（design §4.8 / implement.md 6.1/6.2）──
//
// leader `write_chapter` tool（agent）+ dogfood `closure:run-chapter-chain` IPC（shell）两入口都需要把
// project.yaml 的 scene_graph + 设定（2.3 compileSettingPrefix）+ ChapterBrief（leader 填）+ promise_registry
// 组装成链段 initialArtifacts。本函数抽出共享组装逻辑（DRY），两入口各用各的方式拿 ProjectDocument
// （agent 直读 project.yaml + js-yaml；shell 用 local-bff loadProject 带迁移），然后都调本函数。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical）：组装 = 纯代码机械拼装（查询/汇编），
// 非语义判断——scene_graph 透传 / 设定 prefix 编译已由 2.3 纯函数负责 / ChapterBrief 透传 leader 填的 LLM 段。
// 不判「这张设定卡重不重要」「这段 brief 好不好」（归 LLM）。
//
// settings_context artifact shape：draft-writer 节点 `scalarOf(artifacts['settings_context'])` 直注 yaml
// `{{projectContext}}` —— 故本函数把设定前缀的 PinnedPrefixItem[] 渲染成单个字符串（label + content 拼接）。
// 4.0 用 `compileSettingPrefix`；4.1 升级为 `compileSettingContext`——拿 layout 契约标记（prefix|breakpoint|suffix）
// + stablePrefix；dynamicSuffix 空（按需检索内容走写手自查工具循环〔8.4〕，非 settings_context；dynamicSuffix
// 缓存接线 defer C3）。draft-writer 消费不变（仍注 `{{projectContext}}` 标量），但源升级为 layout 契约 + 为 C3 cache_control
// wiring 准备（breakpoint 实际注入 = Epic C3）。
//
// ⚠️ 4.1 决策点 1（设定消费路线 = A：artifact 深化，保持单次 generate）：设定消费在链段 child session（短命，
// 单次 generate），pinned 接入无跨场景 cache 收益（cache_control wiring 是 C3）→ 保持 artifact 注入路径，
// 不转 session.pinnedContext。stablePrefix → pinnedContextItem 转 + cache_control wiring defer Epic C3
// （context-management.md 4.1 wiring L62-70）。
//
// 落点 shared-contracts（design §5）：跨包共享（agent tool + shell IPC 都用）。纯函数（无 fs/db/LLM）→
// 可 plain vitest 单测。零 migration（新文件）。
//
// expected_downstream_consumers:
// - Story 4.0 Step 6.1：agent `tool/write-chapter.ts` 读 project.yaml 后调本函数 → runChapterChain。
// - Story 4.0 Step 6.2：shell `ipc/closureChainIpc.ts` loadProject 后调本函数 → runtime.runChapterChain。
// - Story 4.1：settings_context 升级为 compileSettingContext（layout 契约 + stablePrefix；pinned 转 + cache wiring defer C3）。

/** scene_graph zod schema 推导类型（creative-fields 已导出 SceneGraph；此处仅取 schema 做 safeParse）。 */
type SceneGraph = z.infer<typeof sceneGraphSchema>;
/** promise_registry zod schema 推导类型（creative-fields 已导出 PromiseRegistry；此处仅取 schema 做 safeParse）。 */
type PromiseRegistry = z.infer<typeof promiseRegistrySchema>;
/** episode_outlines zod schema 推导条目类型（episodeOutlineSchema 已导出，EpisodeOutline type 未显式导出）。 */
type EpisodeOutline = z.infer<(typeof episodeOutlinesSchema)>[number];
/** info_release_map zod schema 推导类型（creative-fields 已导出 InfoReleaseMap；此处仅取 schema 做 safeParse）。 */
type InfoReleaseMap = z.infer<typeof infoReleaseMapSchema>;

/**
 * Story 2.5：genreContract artifact commitments 条目的 element schema（per-element safeParse 防腐，
 * mirror storyDecisionSchema 同哲学 CR-4.1-07）。mirror creativeBriefSchema.commitments 的 element shape
 * （`{type:string.min(1), content:string.min(1)}`，creative-fields.ts:83-86）——独立定义非引用 shape，避免
 * schema 耦合（creativeBriefSchema 的其他必填字段如 rawRequirement 不影响 genreContract 抽取）。
 */
const commitmentEntrySchema = zValue.object({
  type: zValue.string().min(1),
  content: zValue.string().min(1),
});

/**
 * Story 2.5：genreContract artifact shape（Reader-Audit `contract` 维数据源，design §2.2 / §4）。
 *
 * 三字段从 creative_brief / world_setting safeParse 后抽（mirror promise_registry 组装模式）：
 * - `commitments`：用户定的核心承诺（`{type,content}[]`，from `creative_brief.commitments`）。
 * - `genre_tags`：题材标签（`string[]`，from `creative_brief.genre_tags`）。
 * - `world_constitution`：世界 impossible list（`string[]`，from `world_setting.world_constitution`）。
 *
 * 范式判据（ADR-3 / `.trellis/spec/core/creative-vs-mechanical.md`）：本 artifact 是机械组装（查询/汇编），
 * 「正文是否违背用户定的核心承诺 / 世界规则」归 L2 LLM 语义裁判（multi-review-agent `contract` 维，
 * 砍旧硬 BLOCK 纯代码引擎假信心门，design §4.1「Subvert execution, not contract」）。graceful：三字段全空
 * → 注入空子段（review `?? ''` → 空串 → 跳过 contract 维不报，mirror promiseLedger empty 哲学）。
 *
 * expected_downstream_consumers:
 * - Story 2.5：Reader-Audit review 节点 `{{genreContract}}` templateVar → multi-review-agent.yaml
 *   `contract` 维判违背（`Contract.commitment-violation` 核心承诺 BLOCK / `Contract.world-rule-break`
 *   世界规则 WARN）。route 边界：`contract` 维 dim name 不含 narrative|discourse 等 hasNarrativeFeatureBlock
 *   正则词 → block 走 route LLM 判常 auto_revise（守 ADR-17，design §1）。
 * - Story 9.4（类型穷举 + 套路陈旧）：genreContract artifact 已含 genre_tags，9.4 扩类型穷举 + review 调
 *   query_craft 判套路陈旧（narrative-feature 加 `trope-staleness` subClass）。schema 可扩展（加 genre 富信息）。
 */
export interface GenreContractArtifact {
  /** 用户定的核心承诺（from creative_brief.commitments，2.4 additive optional / .default([])）。 */
  commitments: Array<{ type: string; content: string }>;
  /** 题材标签（from creative_brief.genre_tags，自由值 string[]，2.4 additive optional / .default([])）。 */
  genre_tags: string[];
  /** 世界 impossible list（from world_setting.world_constitution，2.4 additive optional）。 */
  world_constitution: string[];
}

/**
 * assembleChapterChainArtifacts 输入：ProjectDocument 中链段组装所需字段子集。
 *
 * 扩展 `SettingPrefixInput`（creative_brief/world_setting/asset_cards，2.3 稳定前缀源）加链段专属字段：
 * scene_graph（brief-compiler #6 汇编 + draft-writer storyPlan）/ promise_registry（brief-compiler #7
 * compilePromiseTasks 消费 + story-sync 读）/ episode_outlines（brief-compiler 连续性标注用 episode index）/
 * story_decisions（brief-compiler #8 openDecisions 消费，from project.yaml novel.story_decisions[]，4.1 Step 3）。
 *
 * 完整 ProjectDocument（loadProject 产出 / project.yaml 解析）结构上满足本类型（超集）。story_decisions
 * 在 project.yaml 中嵌于 novel 下，两入口（write-chapter / closureChainIpc）负责从 novel.story_decisions[]
 * 抽出填入此 flat 字段（assemble 统一从此读）。
 */
export type ChapterChainProjectInput = SettingPrefixInput & {
  scene_graph?: SceneGraph;
  promise_registry?: PromiseRegistry;
  episode_outlines?: EpisodeOutline[];
  /** 创作决策 ADR（from project.yaml novel.story_decisions[]，4.1 Step 3；brief-compiler #8 消费）。 */
  story_decisions?: StoryDecision[];
  /** InfoReleaseMap（from project.yaml info_release_map，6.1 creative field；brief-compiler #3 compileInfoRelease 消费）。 */
  info_release_map?: InfoReleaseMap;
  /** EmotionCurve（from project.yaml emotion_curve，5.1 creative field；brief-compiler #10 compileEmotionTarget 消费，5.2）。 */
  emotion_curve?: EmotionCurve;
  /**
   * GrowthCurve（from project.yaml growth_curve，1.1 creative field）。Story 4.4 completeness-verify-node L1
   * 候选汇编消费（角色弧 under-developed 数据源，design §4）。assemble **不注入此字段**进 artifact（4.4 节点
   * 需直读 raw，caller fetch mirror world_state_snapshot/asset_cards optional 注入模式）。raw 形态多样
   * （单条 / array / Record<id, curve>），readGrowthCurves 守卫统一归一为 GrowthCurve[]（arc-coverage.ts 单源，8.5 上提）。
   */
  growth_curve?: unknown;
  /**
   * 项目级主题字符串（from project.yaml meta.theme）。Story 4.4 completeness-verify-node L1 主题候选汇编消费
   * （design §4 主题挣得 missing 数据源）。assemble **不注入此字段**——caller fetch 注入 project_theme artifact
   * （mirror growth_curve / world_state_snapshot optional 注入模式）。creative_brief.theme 作 sibling 声明主题源。
   */
  project_theme?: string;
};

/**
 * 把 `compileSettingPrefix` 产的 PinnedPrefixItem[] 渲染成单个字符串供 draft-writer `{{projectContext}}` 注入。
 *
 * 渲染：每项 `label：\ncontent`，项间空行分隔。空 items → 空串（draft-writer 优雅消费空 projectContext）。
 * priority 降序已由 compileSettingPrefix 保证（core 设定靠前）。
 */
function renderSettingPrefixToString(items: readonly PinnedPrefixItem[]): string {
  if (items.length === 0) return '';
  return items.map((item) => `${item.label}：\n${item.content}`).join('\n\n');
}

/**
 * 组装写章链段 initialArtifacts（design §4.8 / implement.md 6.1/6.2）。
 *
 * 产出 artifact keys（对齐链段节点 requiredArtifactKeys）：
 * - `scene_graph`：from project.scene_graph（缺 → 空图 {nodes:[],edges:[],lines:[]}，schema 默认）。
 * - `settings_context`：from compileSettingContext(project).stablePrefix 渲染成字符串（稳定前缀 + layout 契约；按需检索内容走写手自查工具循环〔8.4〕，dynamicSuffix 缓存接线 defer C3）。
 * - `chapter_brief_input`：`{episodeId, brief: chapterBrief ?? {}}`（brief-compiler 读此透传 LLM 段 #1-5,10）。
 * - `promise_registry`：from project.promise_registry（缺 → {promises:[],beats:[],version:0}，schema 默认；brief-compiler #7 compilePromiseTasks + story-sync 消费）。
 * - `info_release_map`：from project.info_release_map（缺 → {entries:[],version:0}，schema 默认；brief-compiler #3 compileInfoRelease 消费，6.3）。
 * - `emotion_curve`：from project.emotion_curve（缺 → 空 curve，schema 默认；brief-compiler #10 compileEmotionTarget 消费，5.2）。
 * - `episode_outlines`（optional）：from project.episode_outlines（brief-compiler 连续性标注用；缺则降级）。
 * - `story_decisions`：from project.story_decisions（4.1 Step 3；per-element safeParse 防腐，CR-4.1-07：
 *   坏条目单独丢弃不清空整个数组；brief-compiler #8 openDecisions filter status:'open' 消费）。
 * - `genreContract`：from creative_brief.{commitments,genre_tags} + world_setting.world_constitution（Story 2.5；
 *   safeParse 防御，失败 → 空子段；Reader-Audit `contract` 维数据源，graceful 空承诺 → review 跳过不报）。
 *
 * @param project       loaded ProjectDocument 子集（ChapterChainProjectInput）。
 * @param episodeId     本章目标 episode id（承载树原子，refs episode_outlines[].id）。
 * @param chapterBrief  leader 填的 ChapterBrief LLM 段（#1-5,10）；缺 → 空 brief（brief-compiler 填 #6）。
 * @returns  initialArtifacts record（注入 runChapterChain）。
 */
export function assembleChapterChainArtifacts(
  project: ChapterChainProjectInput,
  episodeId: string,
  chapterBrief?: ChapterBrief,
): Record<string, unknown> {
  // scene_graph：safeParse 防御（project.yaml 可能带未来字段 / 坏 shape）；失败 → 空图降级（不阻塞链段）。
  const sceneResult = sceneGraphSchema.safeParse(project.scene_graph ?? {});
  const sceneGraph: SceneGraph = sceneResult.success ? sceneResult.data : sceneGraphSchema.parse({});

  // promise_registry：safeParse 同理；失败 → 空 registry（story-sync rules 路径容忍空）。
  // .parse({promises:[],beats:[],version:0}) 应用 schema defaults（updatedBy 等）——直写 literal 缺默认字段不满足输出类型。
  const registryResult = promiseRegistrySchema.safeParse(project.promise_registry ?? { promises: [], beats: [], version: 0 });
  const promiseRegistry: PromiseRegistry = registryResult.success ? registryResult.data : promiseRegistrySchema.parse({ promises: [], beats: [], version: 0 });

  // info_release_map：safeParse 同理（mirror promise_registry，6.3）；失败 → 空 map（brief-compiler compileInfoRelease
  // 降级 []，不阻塞链段）。.parse({entries:[],version:0}) 应用 schema defaults（updatedBy 等）。
  const infoReleaseResult = infoReleaseMapSchema.safeParse(project.info_release_map ?? { entries: [], version: 0 });
  const infoReleaseMap: InfoReleaseMap = infoReleaseResult.success ? infoReleaseResult.data : infoReleaseMapSchema.parse({ entries: [], version: 0 });

  // emotion_curve：safeParse 同理（mirror info_release_map，5.2）；失败 → 空 curve（brief-compiler compileEmotionTarget
  // 降级 undefined，不阻塞链段）。⚠ emotionCurveSchema.unit 无 .default()（required enum），fallback 须显式
  // 给 unit:'scene'（D-5.1-1：Director per-scene 产 → unit=scene），否则 .parse({}) 抛违「不抛」契约。points/
  // emotional_promises/catharsis_points 有 .default([])。emotionCurveSchema 无 version/updatedBy 字段（field 级
  // sync version 在 field_metadata，mirror emotion_curve 简洁形态）。
  const emotionCurveResult = emotionCurveSchema.safeParse(project.emotion_curve ?? { unit: 'scene' });
  const emotionCurve: EmotionCurve = emotionCurveResult.success
    ? emotionCurveResult.data
    : emotionCurveSchema.parse({ unit: 'scene' });

  // genreContract（Story 2.5）：creative_brief.commitments + creative_brief.genre_tags +
  // world_setting.world_constitution 三字段组。**直接防御性字段抽取**（mirror compileSettingPrefix
  // field access pattern——setting-prefix.ts buildCreativeBriefItem/buildWorldSettingItem 同样直读字段非 full
  // schema safeParse）。理由：creativeBriefSchema.rawRequirement 是 required 无 default——full schema safeParse
  // 会因无关字段缺失（如测试 fixture / partial yaml）失败，coupling genreContract 抽取到无关 schema 约束。
  // genreContract 只消费 commitments/genre_tags/world_constitution 三字段，只校验这三字段（per-element safeParse
  // mirror story_decisions CR-4.1-07 哲学）。范式判据（ADR-3 / design §4.1）：artifact 组装 = 纯代码机械
  // （查询/汇编），「正文是否违背承诺」归 L2 LLM 语义裁判（砍旧硬 BLOCK 假信心门）。
  const briefRaw = project.creative_brief;
  const worldRaw = project.world_setting;
  const genreContract: GenreContractArtifact = {
    commitments: Array.isArray(briefRaw?.commitments)
      ? briefRaw.commitments.flatMap((c) => {
          const parsed = commitmentEntrySchema.safeParse(c);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
    genre_tags: Array.isArray(briefRaw?.genre_tags)
      ? briefRaw.genre_tags.flatMap((t) => {
          const parsed = zValue.string().min(1).safeParse(t);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
    world_constitution: Array.isArray(worldRaw?.world_constitution)
      ? worldRaw.world_constitution.flatMap((r) => {
          const parsed = zValue.string().safeParse(r);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
  };

  // story_decisions：per-element safeParse + filter（CR-4.1-07：旧 `storyDecisionSchema.array().safeParse`
  // 是 all-or-nothing——一条坏决策（如缺必填 risk）清空整个数组 → brief #8 openDecisions 全丢，主笔收不到
  // open 决策警告。改逐条 safeParse：坏条目单独丢弃 + 好条目保留）。shared-contracts 无 logger → silent
  // filter（坏条目丢弃不记日志；brief-compiler #8 filter open 决策容忍空）。
  const storyDecisions: StoryDecision[] = (project.story_decisions ?? []).flatMap((d) => {
    const parsed = storyDecisionSchema.safeParse(d);
    return parsed.success ? [parsed.data] : [];
  });

  // settings_context：4.1 compileSettingContext.stablePrefix（layout 契约 + 稳定前缀）→ 字符串（draft-writer
  // {{projectContext}} 直注）。按需检索内容走写手自查工具循环（8.4，非 settings_context）；dynamicSuffix 空，
  // 缓存接线 defer C3；layout 契约标记供 C3 wiring。
  const { stablePrefix: prefixItems } = compileSettingContext(project);
  const settingsContext = renderSettingPrefixToString(prefixItems);
  // Story 8.4 B1（design §2.1）：设定侧编译点段报告（逐 PinnedPrefixItem 一段，token 估算单源
  // estimateTextTokens）——随 initialArtifacts 携带到链内，brief-compiler 节点（总额判定汇总点 D3）与
  // brief 侧段报告汇总判档。**本编译点不判总额**（两编译点不各自判总额）；设定侧无 L1/L2 降级动作
  // （铁律目录/指针 + 整体骨架单元，无机械子项通道——膨胀落 L3 人裁，见 estimateSettingsSegments 注释）。
  const settingsContextReport = estimateSettingsSegments(prefixItems);

  const artifacts: Record<string, unknown> = {
    scene_graph: sceneGraph,
    settings_context: settingsContext,
    chapter_brief_input: { episodeId, brief: chapterBrief ?? {} },
    promise_registry: promiseRegistry,
    info_release_map: infoReleaseMap,
    emotion_curve: emotionCurve,
    story_decisions: storyDecisions,
    // Story 2.5：Reader-Audit contract 维数据源（design §2.2 / §4）。review 节点 `{{genreContract}}`
    // templateVar 消费 → multi-review-agent.yaml 判违背。graceful 空子段 → review 跳过 contract 维不报。
    genreContract,
    // Story 8.4 B1：设定侧编译点段报告（brief-compiler 汇总点消费；见上 settingsContextReport 注释）。
    settings_context_report: settingsContextReport,
  };

  // episode_outlines optional 注入（brief-compiler 连续性标注用；缺则连续性降级，场列表仍准确）。
  if (project.episode_outlines) {
    artifacts.episode_outlines = project.episode_outlines;
  }

  return artifacts;
}

// ── CR-7：`closure:run-chapter-chain` IPC 入口 Zod 校验 ──
//
// write_chapter agent tool 有 chapterBriefSchema 校验（write-chapter.ts params），但 dogfood IPC 入口
// 此前裸接收 RunChapterChainInput（无 Zod 守门）——两入口不一致。CR-7 补 IPC 入口校验：复用
// chapterBriefSchema.optional()（单源真值，非重造）+ projectPath/episodeId required + sceneIds/chapterId
// optional。handler（closureChainIpc.ts）入口 safeParse → 失败按 spec 模式 A 返 {status:'error', errors:[...]}。
//
// 零 migration：纯 additive（新导出 schema），不改 RunChapterChainInput type（结构兼容）。

/**
 * `closure:run-chapter-chain` IPC 请求体 Zod schema（CR-7）。
 *
 * 复用 chapterBriefSchema.optional()（leader 填的 LLM 段 #1-5,10，全 optional 容忍）。
 * projectPath/episodeId required（loadProject + brief-compiler 必需）；sceneIds/chapterId optional。
 * chapterId（4.1 Step 4）：用户工作台选章直传，绕过 episode.index→sort_order 映射推断（优先）。
 */
export const runChapterChainInputSchema = zValue.object({
  projectPath: zValue.string().min(1),
  episodeId: zValue.string().min(1),
  chapterBrief: chapterBriefSchema.optional(),
  sceneIds: zValue.array(zValue.string()).optional(),
  chapterId: zValue.string().optional(),
  // Story 4.3：dogfood 跑链段的自治模式（design §3.5 / §4 映射）。默认 'auto'（全自动 = 4.0-4.6 端到端完成，
  // 零回归——dogfood 是 dev/test 路径须跑完整章非交互）。传 'suggest'/'readonly' 可测半自动/微操 pause+resume。
  // （leader write_chapter 路径不从这取——它读 session.permissionMode，KD1。）
  autonomy: zValue.enum(['readonly', 'suggest', 'auto']).default('auto'),
});

// ── Story 4.3 Step 3：`closure:resume-chapter-chain` IPC 入口 Zod 校验（design §3.5 / controller resume 设计）──
//
// resume/redo/abort 走结构化 IPC（**非** leader LLM 解释用户消息）——mirror 4.6 PatchReview accept/reject 模式
// （UI 直接调结构化入口）。理由（controller）：leader 已决策「写这章」（初始 write_chapter），resume/redo/abort
// 是该决策的战术续跑，结构化可靠（ADR-17「leader 编排战略」不冲突——战略已定）。范式判据：mode 推导 + resume
// 分派 = 纯代码机械（非 LLM）。
//
// action 三档（mirror write_chapter paused summary 的 resumeOptions）：
// - continue：resume 续跑（跳已完成节点，design §3.3）。
// - redo：resume + 移除 redo.nodeId 出 resumedCompletedNodes 让其重跑 + feedback 注入 draft-writer prompt（design §3.4）。
// - abort：清 chainSnapshot（弃链段）。
//
// feedback 仅 redo 用（optional——redo 不带 feedback 也合法，等同「重跑无特殊指令」）。chapterId optional（UI
// 透传，持久化映射用；与 run-chapter-chain 同语义）。sessionId required = chainSnapshot 所在 parent 会话
// （leader session / dogfood stub parent）。

/**
 * `closure:resume-chapter-chain` IPC 请求体 Zod schema（Story 4.3 Step 3）。
 *
 * projectPath/sessionId required（路径守卫 + chainSnapshot 读回键）；action 封闭 enum（continue/redo/abort，
 * 机械控制信号）；chapterId/feedback optional。redo 不强制 feedback（空 feedback = 无指令重跑）。
 *
 * Story 7.1 Route 1：加 `revisionIntent` optional（B trigger 选区精修，revision_intent artifact 注入；
 * revisionIntentSchema 守卫 shape）。与 feedback 可共存（feedback 补充说明 / revisionIntent 结构化意图）。
 */
export const resumeChapterChainInputSchema = zValue
  .object({
    projectPath: zValue.string().min(1),
    sessionId: zValue.string().min(1),
    chapterId: zValue.string().optional(),
    // 链流程重排 W2：+ 'accept'（终稿 checkpoint 专属——接受终稿，可携 editedDraft；其余 stage 沿用
    // continue/redo/abort）。机械控制信号封闭 enum。
    action: zValue.enum(['continue', 'accept', 'redo', 'abort']),
    feedback: zValue.string().optional(),
    revisionIntent: revisionIntentSchema.optional(),
    // Story 7.2：art-mode force-accept（soft-violation pause 后作者强行放行）。**仅 action=redo 时透传**
    // （IPC redoOpts 据 guardOverride 切 redo.nodeId=revision-guard-agent；soft-violation pause 时 guard 已在
    // completedNodes，continue 会跳过 → splice 不发生，故 force-accept 必须 redo）。
    guardOverride: zValue.enum(['force-accept']).optional(),
    // 链流程重排 W2（R3 终稿手改通道）：人手改正文**全文**（终稿卡编辑面产出）。resume 入口
    // （shell）先 F1a 立即落正文（editedDraft 覆写 draft.initial.text + wordCount 机械重算）再续跑
    // E 段——E 段对改后正文提取。**仅 action=accept 合法**（accept 是终稿 checkpoint 专属动作）。
    // 与 revisionIntent/feedback 不同：editedDraft 是整稿直给非意图编译——人改不走 optimizer（人改
    // 是最高权威，三层权威「用户原话硬」）。
    editedDraft: zValue.string().min(1).optional(),
  })
  // BMad CR CR-001：guardOverride 仅 redo 合法。continue+guardOverride 会 silent drop（guard 在 completedNodes
  // 被跳过，force-accept 不发生）—— schema refinement 拒，防 caller 误用（IPC handler 只 redo 透传）。
  .refine((v) => v.guardOverride === undefined || v.action === 'redo', {
    message: 'guardOverride 仅 action=redo 合法（soft-violation pause 时 guard 已 completedNodes，continue 会跳过）',
    path: ['guardOverride'],
  })
  // 链流程重排 W2：editedDraft 仅 accept 合法（终稿手改是 accept 的可选载荷；redo 回环的改稿意图走
  // feedback/revisionIntent 通道，混入整稿覆写会绕过环内保义链）。mirror guardOverride refine 姿态。
  .refine((v) => v.editedDraft === undefined || v.action === 'accept', {
    message: 'editedDraft 仅 action=accept 合法（终稿手改全文是接受动作的可选载荷；redo 改稿走 feedback/revisionIntent）',
    path: ['editedDraft'],
  })
  // CR-13（09-13 CR 修复批）：空白串拒收——min(1) 放行 whitespace-only（F1a truthy 判会以空白覆写
  // 正文 / workflow trim 判又静默丢编辑，两侧口径漂移）。schema 侧 trim 非空硬拒，两侧守卫同源。
  .refine((v) => v.editedDraft === undefined || v.editedDraft.trim().length > 0, {
    message: 'editedDraft 不能为空白串（终稿手改需有实质内容；清空正文请用 abort）',
    path: ['editedDraft'],
  });

/**
 * `closure:compile-revision-intent` IPC 请求体 Zod schema（Story 7.1 Route 1）。
 *
 * B trigger 选区精修——UI 用户选段 + 粗指令 → 派 revision-optimizer 编译。projectPath/sessionId required
 * （路径守卫 + 派发 key）；selectedPassage/userInstruction required（核心入参）；chapterContext/auditFindings
 * optional（辅助）。
 */
export const compileRevisionIntentInputSchema = zValue.object({
  projectPath: zValue.string().min(1),
  sessionId: zValue.string().min(1),
  selectedPassage: zValue.string().min(1),
  userInstruction: zValue.string().min(1),
  chapterContext: zValue.string().optional(),
  auditFindings: zValue.string().optional(),
  // 🔑 F2（BMad CR 范式订正）：selectionFrom/selectionTo + draftText required——IPC 层纯代码构造
  // scope.anchor（非 LLM 产）。anchorContextChars optional（default 50）。
  selectionFrom: zValue.number().int().min(0),
  selectionTo: zValue.number().int().min(0),
  draftText: zValue.string(),
  anchorContextChars: zValue.number().int().min(1).optional(),
});

// ── 链流程重排 W4（R6 链外重提取）：`closure:re-extract-chapter` + `closure:chapter-derivation-status` ──
//
// 落盘后手改正文（accept 落盘 → 编辑器改 md）此前零重提取机制（chapterChunkWatcher 只重建检索 chunk，
// world/promise/arc/summary/mention/story-sync 衍生状态无「章改完」入口）；E 段失败章标（derivationStale）
// 也只有 summary 瞬态信号。R6 = 重提取能力（盘上正文 → standalone E 段 → 幂等写）+ 查询面（章卡
// 「重提取」按钮态数据源，UI 归子3）。

/**
 * `closure:re-extract-chapter` IPC 请求体 Zod schema（链流程重排 W4 / R6）。
 *
 * projectPath/chapterId required（路径守卫 + 反向映射键）。autonomy = story-sync 反哺 patches 的档位
 * 分流（auto 直落 / suggest+readonly envelope PatchReview 人审，mirror applyStorySyncOnResume 判定）；
 * 重提取无自然 leader 会话可读 permissionMode，缺省 'suggest'（保守——补丁默认进人审）。
 */
export const reExtractChapterInputSchema = zValue.object({
  projectPath: zValue.string().min(1),
  chapterId: zValue.string().min(1),
  autonomy: zValue.enum(['readonly', 'suggest', 'auto']).default('suggest'),
});

/** 重提取统计（各段计数——context isolation：不灌全 artifacts，只汇总计数供 UI）。 */
export interface ReExtractChapterStats {
  /** E1-E2 world 落表 slice 数。 */
  worldWrites: number;
  /** E1-E2 总 patches 数。 */
  worldPatches: number;
  /** E2 写表失败数（>0 → ok:false 反映）。 */
  worldWriteErrors: number;
  /** E4 检出的 perspective gaps 数。 */
  promiseGaps: number;
  /** E4 涌现产出的 Promise actions 数。 */
  promiseActions: number;
  /** E5 弧节拍数（对终稿声明）。 */
  arcBeats: number;
  /** E7 storyTime 漂移 warning 数。 */
  driftWarnings: number;
  /** E3 情绪校验降级标注（数据源缺陷，如实带出）。 */
  emotionDegraded?: boolean;
}

/**
 * `closure:re-extract-chapter` 返回（agent runtime 产出 + IPC 层 story-sync 档位分流 additive 挂载）。
 *
 * ok:false 时 reason 是面向用户的明确原因（章不存在 / 正文为空 / 映射失败 / E 段失败摘要）；E 段失败
 * 额外带 errors（runChain blocked/error 明细）。storySyncLanded/storySyncReview 由 IPC 层挂
 * （mirror RunChapterChainSummary 两侧 additive 字段形态）。
 */
export interface ReExtractChapterResult {
  ok: boolean;
  reason?: string;
  chapterId?: string;
  episodeId?: string;
  /** 盘上正文字数（剥 frontmatter 后）。 */
  wordCount?: number;
  stats?: ReExtractChapterStats;
  /** E9 story-sync 再提取产物（patches 供 IPC 层档位分流——plan-review L5：重提取再产 patches 走档位）。 */
  storySync?: NovelStorySyncPayload;
  /** runChain errors（E 段节点 blocked/error 时带）。 */
  errors?: string[];
  /** story-sync 档位分流落点（IPC 层挂）：auto 档直落成功的 fields。 */
  storySyncLanded?: { note: string; fields: string[] };
  /** story-sync 档位分流落点（IPC 层挂）：suggest/readonly 档 envelope（PatchReview 人审）。 */
  storySyncReview?: { note: string; patches: FieldPatchEntry[] };
}

/**
 * `closure:chapter-derivation-status` IPC 请求体 Zod schema（链流程重排 W4）。
 *
 * 轻量查询：全部注册章的衍生状态新鲜度（供子3 章卡「重提取」按钮态）。optional chapterId 收窄单章。
 */
export const chapterDerivationStatusInputSchema = zValue.object({
  projectPath: zValue.string().min(1),
  chapterId: zValue.string().optional(),
});

/** 单章衍生状态行。 */
export interface ChapterDerivationStatusEntry {
  chapterId: string;
  /** 反向映射出的 episode id（映射失败 → 缺省——该章无重提取通道）。 */
  episodeId?: string;
  /** E6 章摘要是否已物化（false = 从未跑过提取段——链前旧章 / E 段失败中断）。 */
  summaryPresent: boolean;
  /**
   * 持久 stale 信号：章摘要 degradedNote 含「正文已修订」标注（degradeMentionLedgerForChapterFile 在
   * 每次章正文写盘点 fire——手改/落盘后均标）。true = 正文在最近一次提取后被改过。
   */
  synopsisStale: boolean;
  /** 派生态：synopsisStale || !summaryPresent（重提取按钮态单字段消费）。 */
  stale: boolean;
}

/** `closure:chapter-derivation-status` 返回。 */
export interface ChapterDerivationStatusResult {
  chapters: ChapterDerivationStatusEntry[];
}

/**
 * Story 4.3 Step 3：write_chapter tool paused summary → `chapter_review` metadata shape（design §3.5 / §3.6）。
 *
 * leader write_chapter 收 paused summary 时产此 metadata 挂 tool result（mirror 4.6 chapter_accept→field_patch
 * metadata 模式）。UI（Step 4 chapterReviewSlice）据此渲染 review 面板 + 派发 resume/redo/abort 动作。
 *
 * - type='chapter_review' 判别符（UI 据此分支 chapter_review 渲染路径，区别于 field_patch / escalate）。
 * - stage：paused checkpoint（brief/draft/verdict），UI 决定 review 形态（draft→prose-review / brief→对话软门 /
 *   verdict→PatchReview，design §5）。
 * - chapterId：UI 跟踪用（来源 write_chapter params.chapterId；缺省→UI 从 active chapter 推）。
 * - draftContent/briefContent：review payload（豁免 context isolation 同 CR-15a prose 是 deliverable）。
 * - resumeOptions：UI 渲染三动作（continue/redo/abort）。封闭 readonly tuple（机械控制信号，非 LLM 判）。
 *
 * additive（新 metadata type，零 migration；不破既有 field_patch metadata）。
 */
export type ChapterReviewMetadata = {
  type: 'chapter_review';
  /**
   * checkpoint 阶段。Story 7.2 加 'revision-guard'（段落级改稿保义门 soft-violation pause → art-mode 卡）。
   * 链流程重排 W2 加 'final'（终稿人审——route accept 后、E 段提取前；正文可编辑，accept 可携
   * editedDraft 手改全文）。旧 'draft'/'verdict' 停点已随档位重映射退役（deriveCheckpointPolicy 输出
   * 只含 brief/final；旧 stage paused 快照在 write_chapter 拦截门废弃）——枚举值保留兼容旧持久载荷。
   */
  stage: 'brief' | 'draft' | 'final' | 'verdict' | 'revision-guard';
  chapterId?: string;
  /** draft checkpoint pause 时的正文（review 载荷；brief/verdict pause 缺省）。 */
  draftContent?: string;
  /** brief checkpoint pause 时的 chapter_brief artifact（review 载荷；draft/verdict pause 缺省）。 */
  briefContent?: unknown;
  /**
   * 链流程重排 W2（plan-review M5 字段级 additive 清单）：终稿 checkpoint（stage='final'）的审读摘要
   * ——verdict（review.latest 审读结论）+ reasons（route 理由 + 审读 summary）+ loopCount（自审环迭代数）
   * + capExhausted（环 cap 是否耗尽）。终稿卡据此呈现「AI 自审收敛了几轮、结论如何」。其他 stage 缺省。
   */
  reviewSummary?: { verdict: string; reasons: string[]; loopCount: number; capExhausted: boolean };
  /**
   * 链流程重排 W2（R2 去味门禁）：终稿 checkpoint 的 lint 终态报告（去 AI 味静态扫描 digest——命中
   * 计数 + 高优命中摘录）。终稿卡消费（UI 渲染归子3）。degraded（引擎缺位）时为占位说明串。其他
   * stage 缺省。
   */
  lintReport?: string;
  /**
   * Story 7.2：revision-guard pause（soft-violation）时的保义门载荷（findings + 改前/改后 + L1 幅度）。
   * UI art-mode 卡据此展示，作者决定强行放行/改/取消。其他 stage 缺省。
   */
  revisionGuard?: RevisionGuardArtifact;
  /**
   * Story 8.4 Step 4（A8）：draft pause 因出发核查挂起（矛盾/超限，非正文 review）时的挂起载荷
   * （矛盾/偏离明细或缺漏清单）。UI 据此渲染决断卡（改任务卡/改设定/维持原案→redo，或放弃）；
   * resumeOptions 不含 continue（挂起无正文可续——continue 会跳过 draft-writer 撞 DAG blocked）。
   * 非挂起 pause 缺省。镜像 agent RunSnapshotSummary.researchSuspension（research-brief.ts 单源）。
   */
  researchSuspension?: ResearchSuspension;
  /**
   * resumeOptions：UI 渲染动作按钮（机械控制信号，非 LLM 判）。'accept'（链流程重排 W2）= 终稿
   * checkpoint 专属——接受终稿（可携 editedDraft 手改全文，经 resumeChapterChain action='accept'）；
   * 其余 stage 沿用 continue/redo/abort。
   */
  resumeOptions: readonly ('continue' | 'accept' | 'redo' | 'abort')[];
};

// ── Story 4.6：裁决器建议 parse（三路径鲁棒 robust extraction，对象形态）──

/** 裁决器初审选项（呈用户裁决的选项 + 理由）。 */
export interface AdjudicationOption {
  label: string;
  reason: string;
}

/**
 * 裁决器初审建议（Story 4.6）：多角度初审 + recommendation（revise/accept，可被用户推翻）+ 两选项理由。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：analysis/recommendation/reasons = LLM 语义创作判断
 * （裁决器子 agent 产）；parseAdjudication 只机械提取 + shape 校验（纯代码，非语义）。
 */
export interface AdjudicationSuggestion {
  analysis: string;
  recommendation: 'revise' | 'accept';
  recommendationReason: string;
  options: AdjudicationOption[];
}

/**
 * parse 裁决器建议（adjudicator-agent 子 agent 返纯 JSON 对象）。
 *
 * 三路径鲁棒（multi-fence + brace-match + bare，对象形态）：① fenced 块（multi-fence tolerant）
 * ② first{..last} brace-match ③ 整体 parse。任一路径提取到合法 AdjudicationSuggestion 即返；
 * 失败返 null（caller graceful 降级，D5）。
 *
 * 合法性硬要求：analysis 非空 + recommendation∈{revise,accept} + ≥2 options（label/reason 非空）。
 * options 上限 2（呈用户的两选项：改稿 / 接受为真相）。
 */
export function parseAdjudication(content: string): AdjudicationSuggestion | null {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return null;

  // 路径 1：fenced 块（multi-fence tolerant）。
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = match[1];
    if (!inner) continue;
    const parsed = tryParseAdjudication(inner);
    if (parsed) return parsed;
  }

  // 路径 2：brace-match（first { to last }）。
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = tryParseAdjudication(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed) return parsed;
  }

  // 路径 3：整体试 parse（无 fence 单对象）。
  const whole = tryParseAdjudication(trimmed);
  if (whole) return whole;

  return null;
}

/** 单候选字符串试 parse + shape 校验为 AdjudicationSuggestion（失败返 null）。 */
function tryParseAdjudication(candidate: string): AdjudicationSuggestion | null {
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const analysis = typeof o.analysis === 'string' ? o.analysis.trim() : '';
  // CR-Edge-5：recommendation trim+toLowerCase 归一（LLM 可能返 "Accept"/"accept "），mirror analysis 的 trim 容错。
  const recRaw = typeof o.recommendation === 'string' ? o.recommendation.trim().toLowerCase() : '';
  const recommendation = recRaw === 'accept' || recRaw === 'revise' ? recRaw : null;
  const recommendationReason = typeof o.recommendationReason === 'string' ? o.recommendationReason.trim() : '';
  if (!analysis || !recommendation) return null; // 硬要求：analysis + recommendation
  const optionsRaw = Array.isArray(o.options) ? o.options : [];
  const options: AdjudicationOption[] = [];
  for (const opt of optionsRaw) {
    if (!opt || typeof opt !== 'object') continue;
    const oe = opt as Record<string, unknown>;
    if (typeof oe.label === 'string' && typeof oe.reason === 'string' && oe.label.trim() && oe.reason.trim()) {
      options.push({ label: oe.label.trim(), reason: oe.reason.trim() });
    }
  }
  if (options.length < 2) return null; // 硬要求：≥2 选项（呈用户两选项）
  return { analysis, recommendation, recommendationReason, options: options.slice(0, 2) };
}

// ── Story 6.3：Director agent 输出解析（design §3 段① / D1，三路径鲁棒 robust extraction）──
//
// Director 子 agent（leader 侧 write_chapter gate 后派发）runLoop 后返 assistant content —— 期望是
// {"entries":[{sceneRef,directive:{mode,actions,forbiddenMoves?,target?}}]} 形态的 JSON
// （prompts/director-agent.yaml 输出契约）。但真实 LLM 常带 ```json 围栏 / 前导自然语言 / 多块围栏
// （推理 fenced + 结果 fenced）/ narration 中散落 { } → 裸 JSON.parse 抛。本 helper 做 robust 抽取
// （multi-fence + brace-match + bare 三路径，避单 fence regex 漏多块 / first-{ to last-} 切到
// narration 半段）。
//
// 逐条 safeParse directorInfoReleaseEntrySchema（CR-4.1-07 同哲学：坏条目单独丢不全丢——Director 产出的
// 部分合法 entry 仍合入 initialArtifacts.info_release_map）。全失败 / content 无法 parse → 返空数组
// （graceful 降级：Director 是增强非硬约束，失败降级 InfoReleaseMap 保持 assembled 原样，链段照跑）。
//
// **R2 in-memory steer**：write_chapter parse 后经 mergeDirectorEntries 合入 initialArtifacts['info_release_map']
// （非持久化——持久化落盘归 R3 info_release_map_update autoApply handler）。brief-compiler compileInfoRelease
// （R1 已接通）消费 initialArtifacts['info_release_map'] → 编译 brief #3 + manipulationDirectives[]。
//
// 落 shared-contracts（mirror parseAdjudication）：write_chapter agent tool 消费。

/** Director 子 agent 的 per-scene 输出 entry（sceneRef + ManipulationDirective）。不含 id（write_chapter merge 时赋）。 */
const directorInfoReleaseEntrySchema = zValue.object({
  sceneRef: zValue.string().min(1),
  directive: manipulationDirectiveSchema,
});

/** Director per-scene 输出 entry（Story 6.3；sceneRef 命中场 + ManipulationDirective shape）。 */
export type DirectorInfoReleaseEntry = z.infer<typeof directorInfoReleaseEntrySchema>;

/**
 * 从候选字符串抽取并校验 entries（fenced / brace-sliced / bare 三路径共用）。
 *
 * 归一：{entries:[...]} → [...] / 裸数组 / 其他 → null。
 * 逐条 safeParse directorInfoReleaseEntrySchema——坏条目丢弃，好条目保留（CR-4.1-07 同哲学）。
 * 返 null 表示该候选无可抽取内容（调用方试下一候选）；返空数组表示 parse 成功但无好条目。
 */
function tryExtractDirectorEntries(candidate: string): DirectorInfoReleaseEntry[] | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');

  // 判定根容器形态：[ 在前 = 裸数组（避裸数组内部首对象 { 误导 brace-slice）。
  const isBareArray =
    firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);

  let parsed: unknown;
  try {
    if (isBareArray) {
      if (lastBracket > firstBracket) {
        parsed = JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
      } else {
        return null;
      }
    } else if (firstBrace !== -1 && lastBrace > firstBrace) {
      parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } else {
      // 无 brace / bracket → 试整体 parse（bare 数字 / 布尔等非 entries 形态 → JSON.parse 成功但归一为 null）。
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }

  // 归一为 entries 数组。
  let entries: unknown[];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    entries = (parsed as { entries: unknown[] }).entries;
  } else {
    return null;
  }

  return entries.flatMap((entry) => {
    const result = directorInfoReleaseEntrySchema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

/**
 * 扫描 content 中**最后一个**含 `"entries"` key 的最外层 `{...}`（brace-match）。
 *
 * 用于 fence 全失败 / 无 fence 时的 narration-tolerant fallback（P2 路径 2）：LLM 可能先输出推理文字
 * （含散落 `{` / `}`），再输出 final JSON。从 `"entries"` key 向左找包围 `{`，向右 brace-match 找匹配
 * `}`——避首 `{` 到末 `}` 切到 narration 半段 + 散落 brace。
 *
 * 找不到 / 非法 → null。
 */
function extractLastEntriesObject(content: string): string | null {
  const keyIdx = content.lastIndexOf('"entries"');
  if (keyIdx === -1) return null;

  // 向左找包围 `{`（从 key 向左扫，最近一个 `{` 即包围起始）。
  let openIdx = -1;
  for (let i = keyIdx; i >= 0; i--) {
    if (content[i] === '{') {
      openIdx = i;
      break;
    }
  }
  if (openIdx === -1) return null;

  // 从 openIdx 向右 brace-match（depth 计数）。不解析字符串转义——Director JSON value 含裸 {/} 概率极低，
  // 且 fence 路径优先（本路径是兜底）；截断 JSON（无匹配 }）→ depth 不归零 → null。
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return content.slice(openIdx, i + 1);
      }
    }
  }
  return null;
}

/**
 * 解析 Director 子 agent 返回的 per-scene ManipulationDirective JSON（Story 6.3）。
 *
 * 三路径鲁棒（multi-fence + brace-match + bare）：
 * 1. **扫所有 ```json/``` fenced 块**（global regex，multi-fence tolerant）——Director 可能先输出推理
 *    fenced 块再输出 entries fenced 块。逐块试 tryExtractDirectorEntries，首个产 non-empty entries 的即返。
 * 2. **brace-match 最后一个含 `"entries"` 的最外层 `{...}`**（无 fence / fence 全失败时的 narration-
 *    tolerant fallback）——容忍散落 brace 在 narration 中。
 * 3. **整体试 parse**（最后兜底——bare array / 无 fence 单对象）。
 *
 * 全失败 → 返回空数组（graceful，不抛）。调用方据返回长度决定是否 merge（空 → 不改 initialArtifacts，
 * InfoReleaseMap 保持 assembled 原样）。无 cap（Director per-scene 产，自然受本章场数约束）。
 */
export function parseDirectorInfoRelease(content: string): DirectorInfoReleaseEntry[] {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return [];

  // 路径 1：扫所有 fenced 块（multi-fence tolerant）。
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = match[1];
    if (!inner) continue;
    const entries = tryExtractDirectorEntries(inner);
    if (entries && entries.length > 0) {
      return entries;
    }
  }

  // 路径 2：brace-match 最后一个含 "entries" 的 {...}（narration-tolerant）。
  const lastObj = extractLastEntriesObject(trimmed);
  if (lastObj) {
    const entries = tryExtractDirectorEntries(lastObj);
    if (entries && entries.length > 0) {
      return entries;
    }
  }

  // 路径 3：整体试 parse（bare array / 无 fence 单对象）。
  const wholeEntries = tryExtractDirectorEntries(trimmed);
  if (wholeEntries && wholeEntries.length > 0) {
    return wholeEntries;
  }

  return [];
}

// ── Story 5.2：Director emotion 输出解析（mirror parseDirectorInfoRelease 三路径，同 content 抽 emotion 段）──
//
// Director 子 agent（5.2 扩情绪目标段）runLoop 后返 assistant content —— 期望含 emotionPoints + emotionTarget
// 段的 JSON（与 InfoRelease entries 同一对象，prompts/director-agent.yaml 输出契约）。但真实 LLM 常带 ```json
// 围栏 / 前导自然语言 / 多块围栏 → 裸 JSON.parse 抛。本 helper 做 robust 抽取（mirror parseDirectorInfoRelease P2：
// multi-fence + brace-match + bare 三路径）。
//
// emotionPoints 逐条 safeParse emotionPointSchema（CR-4.1-07 同哲学：坏条目单独丢不全丢——Director 产出的
// 部分合法 point 仍合入）。emotionTarget safeParse briefEmotionTargetSchema（optional，章级目标）。全失败 /
// content 无 emotion 段 → {emotionPoints:[], emotionTarget:undefined}（graceful 降级：emotion 是增强非硬约束，
// 失败降级 emotion_curve 保持 assembled 原样，链段照跑，mirror Director InfoRelease D4 graceful）。
//
// **R2 in-memory steer**：write_chapter parse 后经 mergeDirectorEmotionPoints 合入 initialArtifacts['emotion_curve']
// （非持久化——持久化落盘归 emotion_curve_update autoApply handler）。brief-compiler compileEmotionTarget
// 消费 initialArtifacts['emotion_curve'] + Director emotionTarget → 编译 brief #10。
//
// 落 shared-contracts（mirror parseDirectorInfoRelease）：write_chapter agent tool 消费。

/** Director emotion 输出（per-scene points + 章级 emotionTarget，Story 5.2）。points 为合法 emotionPoint[]。 */
export interface DirectorEmotionOutput {
  /** per-scene 目标情绪点（refId=sceneId，safeParse 过的合法条目）。 */
  emotionPoints: EmotionPoint[];
  /** 章级情绪目标（Director 独立产非 rollup，safeParse 过；无则 undefined）。 */
  emotionTarget?: BriefEmotionTarget;
}

/**
 * 从候选字符串抽取 emotionPoints + emotionTarget（fenced / brace-sliced / bare 三路径共用）。
 *
 * 归一：{emotionPoints:[...], emotionTarget:{...}} → 抽 / 裸数组（视为 emotionPoints）/ 其他 → null。
 * emotionPoints 逐条 safeParse emotionPointSchema——坏条目丢弃，好条目保留（CR-4.1-07 同哲学）。
 * emotionTarget safeParse briefEmotionTargetSchema（optional，缺失/坏 → undefined）。
 * 返 null 表示该候选无可抽取 emotion 段（调用方试下一候选）。
 *
 * mirror tryExtractDirectorEntries（InfoRelease），差异：key=`emotionPoints`/`emotionTarget` + point schema +
 * 额外抽章级 emotionTarget（InfoRelease 无对应章级字段）。
 */
function tryExtractDirectorEmotion(candidate: string): DirectorEmotionOutput | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');

  // 判定根容器形态：[ 在前 = 裸数组（视为 emotionPoints 数组）。
  const isBareArray =
    firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);

  let parsed: unknown;
  try {
    if (isBareArray) {
      if (lastBracket > firstBracket) {
        parsed = JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
      } else {
        return null;
      }
    } else if (firstBrace !== -1 && lastBrace > firstBrace) {
      parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } else {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }

  // 归一 emotionPoints 数组：对象 {emotionPoints:[...]} → 抽 / 裸数组 → 本身。
  // emotionTarget 独立抽（BLIND-1 fix：emotionTarget 提取不依赖 emotionPoints key 存在——Director 可能只返
  // 章级 emotionTarget 无 per-scene points，此时 emotionPoints 缺/非数组不应丢 emotionTarget）。
  let pointsRaw: unknown[] | null = null;
  let emotionTargetRaw: unknown = undefined;
  if (Array.isArray(parsed)) {
    pointsRaw = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as { emotionPoints?: unknown; emotionTarget?: unknown };
    if (Array.isArray(obj.emotionPoints)) {
      pointsRaw = obj.emotionPoints;
    }
    emotionTargetRaw = obj.emotionTarget;
    // 两段皆无（无 emotionPoints 数组 + 无 emotionTarget）→ 该候选无可抽 emotion。
    if (pointsRaw === null && emotionTargetRaw === undefined) return null;
  } else {
    return null;
  }

  const emotionPoints: EmotionPoint[] = [];
  // pointsRaw 可 null（emotionTarget 在但无 emotionPoints 数组时，BLIND-1 fix）→ 空迭代。
  for (const raw of pointsRaw ?? []) {
    const result = emotionPointSchema.safeParse(raw);
    if (result.success) emotionPoints.push(result.data);
  }

  // emotionTarget optional safeParse（章级目标；坏/缺 → undefined，不阻断 points）。
  let emotionTarget: BriefEmotionTarget | undefined;
  if (emotionTargetRaw !== undefined) {
    const targetResult = briefEmotionTargetSchema.safeParse(emotionTargetRaw);
    if (targetResult.success) emotionTarget = targetResult.data;
  }

  if (emotionPoints.length === 0 && emotionTarget === undefined) return null;
  const output: DirectorEmotionOutput = { emotionPoints };
  if (emotionTarget !== undefined) output.emotionTarget = emotionTarget;
  return output;
}

/**
 * 扫描 content 中**最后一个**含 `"emotionPoints"` key 的最外层 `{...}`（brace-match）。
 *
 * 用于 fence 全失败 / 无 fence 时的 narration-tolerant fallback（P2 路径 2）：LLM 可能先输出推理文字再输出
 * final JSON。从 `"emotionPoints"` key 向左找包围 `{`，向右 brace-match 找匹配 `}`。
 *
 * mirror extractLastEntriesObject（InfoRelease），差异：key=`"emotionPoints"`。找不到 / 非法 → null。
 */
function extractLastEmotionObject(content: string): string | null {
  const keyIdx = content.lastIndexOf('"emotionPoints"');
  if (keyIdx === -1) return null;

  // 向左找包围 `{`（从 key 向左扫，最近一个 `{` 即包围起始）。
  let openIdx = -1;
  for (let i = keyIdx; i >= 0; i--) {
    if (content[i] === '{') {
      openIdx = i;
      break;
    }
  }
  if (openIdx === -1) return null;

  // 从 openIdx 向右 brace-match（depth 计数）。
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return content.slice(openIdx, i + 1);
      }
    }
  }
  return null;
}

/**
 * 解析 Director 子 agent 返回的 emotion 段（per-scene emotionPoints + 章级 emotionTarget，Story 5.2）。
 *
 * 三路径鲁棒（mirror parseDirectorInfoRelease P2，与 InfoRelease entries 同 content 双 parse 各抽各段）：
 * 1. **扫所有 ```json/``` fenced 块**（global regex，multi-fence tolerant）。逐块试 tryExtractDirectorEmotion，
 *    首个产 non-empty emotion（points 或 target）的即返。
 * 2. **brace-match 最后一个含 `"emotionPoints"` 的最外层 `{...}`**（narration-tolerant fallback）。
 * 3. **整体试 parse**（最后兜底——bare array / 无 fence 单对象）。
 *
 * 全失败 / 无 emotion 段 → {emotionPoints:[]}（graceful，不抛）。调用方据 emotionPoints.length + emotionTarget
 * 决定是否 merge（空 → 不改 initialArtifacts，emotion_curve 保持 assembled 原样）。无 cap（Director per-scene 产，
 * 自然受本章场数约束）。
 */
export function parseDirectorEmotion(content: string): DirectorEmotionOutput {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return { emotionPoints: [] };

  // 路径 1：扫所有 fenced 块（multi-fence tolerant）。
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = match[1];
    if (!inner) continue;
    const emotion = tryExtractDirectorEmotion(inner);
    if (emotion && (emotion.emotionPoints.length > 0 || emotion.emotionTarget !== undefined)) {
      return emotion;
    }
  }

  // 路径 2：brace-match 最后一个含 "emotionPoints" 的 {...}（narration-tolerant）。
  const lastObj = extractLastEmotionObject(trimmed);
  if (lastObj) {
    const emotion = tryExtractDirectorEmotion(lastObj);
    if (emotion && (emotion.emotionPoints.length > 0 || emotion.emotionTarget !== undefined)) {
      return emotion;
    }
  }

  // 路径 3：整体试 parse（bare array / 无 fence 单对象）。
  const wholeEmotion = tryExtractDirectorEmotion(trimmed);
  if (wholeEmotion && (wholeEmotion.emotionPoints.length > 0 || wholeEmotion.emotionTarget !== undefined)) {
    return wholeEmotion;
  }

  return { emotionPoints: [] };
}

// ── Story 2.6：Director 决策登记段输出解析（mirror parseDirectorEmotion，同 content 抽 storyDecisions 段）──
//
// Director 子 agent（2.6 决策登记段）runLoop 后返 assistant content——期望含 storyDecisions[] 段的 JSON
// （与 entries/emotionPoints 同一对象，prompts/director-agent.yaml 输出契约第 5 段）。robust 抽取 mirror
// parseDirectorEmotion 三路径（multi-fence + brace-slice + bare）。
//
// 逐条 safeParse storyDecisionDraftSchema（CR-4.1-07 同哲学：坏条目单独丢不全丢）。**source 强制
// 'director'**（信任边界：Director 自报 source 不采信——防 Director 冒 'user' 骋保护）。**既有 id 过滤**
// （idempotent，mirror CR-inforelease-steer-4 幻觉 filter 哲学）：id 已在既有决策（existingIds）或同批次
// 重复 → 丢弃（Director yaml 约定已有同 id 不重复登记；过滤防 register 既有 id 触发 assertTransition
// 拒杀整批）。Director 决策**无 relatedEpisodeId**（跨章方向非单章事件，yaml 约定不填）——draft 带了
// 也丢弃该字段（信任边界同 source）。
//
// 全失败 / 无 storyDecisions 段 → []（graceful，不抛；调用方 length>0 才落盘）。落 shared-contracts
// （mirror parseDirectorEmotion）：write_chapter agent tool 消费。

/** 从候选字符串抽取 storyDecisions 草稿数组（fenced / brace-sliced / bare 三路径共用）。 */
function tryExtractDirectorStoryDecisions(
  candidate: string,
  existingIds: ReadonlySet<string>,
): StoryDecisionDraft[] | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');

  // 判定根容器形态：[ 在前 = 裸数组（视为 storyDecisions 数组）。
  const isBareArray =
    firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);

  let parsed: unknown;
  try {
    if (isBareArray) {
      if (lastBracket > firstBracket) {
        parsed = JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
      } else {
        return null;
      }
    } else if (firstBrace !== -1 && lastBrace > firstBrace) {
      parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } else {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }

  const arrRaw: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as { storyDecisions?: unknown } | null)?.storyDecisions;
  if (!Array.isArray(arrRaw)) return null;

  const seenInBatch = new Set<string>();
  const out: StoryDecisionDraft[] = [];
  for (const item of arrRaw) {
    const r = storyDecisionDraftSchema.safeParse(item);
    if (!r.success) continue; // 坏条目单独丢（CR-4.1-07）
    const draft = r.data;
    if (existingIds.has(draft.id) || seenInBatch.has(draft.id)) continue; // 既有/批内重复 → idempotent 丢
    seenInBatch.add(draft.id);
    // 信任边界：source 强制 'director' + 剥 relatedEpisodeId（跨章方向非单章事件）。
    const { relatedEpisodeId: _strip, ...rest } = draft;
    void _strip;
    out.push({ ...rest, source: 'director' });
  }
  return out.length > 0 ? out : null;
}

/**
 * 解析 Director 子 agent 返回的 storyDecisions 段（2.6 决策登记，register 语义——Director 只产新登记，
 * supersede/drop 走工作台 leader 工具）。
 *
 * 三路径鲁棒（mirror parseDirectorEmotion）：fenced 块扫描 / brace-slice / 整体 parse。
 * existingIds = 既有决策 id 集（idempotent 过滤）。全失败 → []（graceful）。
 */
export function parseDirectorStoryDecisions(
  content: string,
  existingIds: ReadonlySet<string>,
): StoryDecisionDraft[] {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return [];

  // 路径 1：扫所有 fenced 块。
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = match[1];
    if (!inner) continue;
    const decisions = tryExtractDirectorStoryDecisions(inner, existingIds);
    if (decisions) return decisions;
  }

  // 路径 2：brace-match 最后一个含 "storyDecisions" 的 {...}。
  const lastBrace = trimmed.lastIndexOf('}');
  if (lastBrace !== -1) {
    let start = -1;
    let depth = 0;
    for (let i = lastBrace; i >= 0; i -= 1) {
      const ch = trimmed[i];
      if (ch === '}') depth += 1;
      else if (ch === '{') {
        depth -= 1;
        if (depth === 0) {
          const slice = trimmed.slice(i, lastBrace + 1);
          if (slice.includes('storyDecisions')) {
            start = i;
            break;
          }
          depth = 0; // 继续外层找
        }
      }
    }
    if (start !== -1) {
      const decisions = tryExtractDirectorStoryDecisions(trimmed.slice(start, lastBrace + 1), existingIds);
      if (decisions) return decisions;
    }
  }

  // 路径 3：整体试 parse。
  const whole = tryExtractDirectorStoryDecisions(trimmed, existingIds);
  return whole ?? [];
}
