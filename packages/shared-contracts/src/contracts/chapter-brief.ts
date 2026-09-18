import { z } from 'zod';
import { type SceneGraph, promiseBeatKindSchema, manipulationDirectiveSchema, vadTripleSchema } from './creative-fields';
import { isSceneInEpisode } from './scene-graph-analytics';
import { storyDecisionSchema } from './story-decision';

// ── Story 4.0 写章战术链段：ChapterBrief 10 段 schema（design §3 / conclusions §3.9）──
//
// brief 是主笔真正拿在手里的东西（写作指令，非图边）。段序承 NeuroBook 9 段 + Closure 第 10 段
// 情绪目标（charter #2「情绪 > 情节 / 逻辑」头等公民，不折进节奏）。逐段问「这个判断理不理解意义」
// 定 LLM 段 vs 纯代码段（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）。
//
// 全字段 optional——draft-writer 优雅消费（读 populated、忽略空）。4.0 填有源的 7 段
// （LLM 段 #1-5,10 leader 填 + 纯代码段 #6 from scene_graph via brief-compiler-node）；
// 4.1 Step 3 起 #8 openDecisions 亦产（from project.yaml novel.story_decisions[] via brief-compiler）；
// 6.5 起 #7 promiseTasks 亦产（from promise_registry via brief-compiler）
// ——不造假、不留 tombstone（design §3 决断：简化 schema 致 4.1 返工，完整 schema + 诚实部分填充
// = 不重写 + 不造假 + 总工作量更小）。
//
// 「不进 brief 的东西」原则（§3.9）：设定复述 → 指向 lorebook（2.3 设定汇编 prefix + query_story
// 指针，不抄进 brief）；文风 → 归 profile；brief 只带「本章特有」。双真相源会漂移。
//
// 落点 shared-contracts（design §5）：跨包共享（agent brief-compiler-node 产 + draft-writer 消费）。
// 零 migration（新文件，全 optional，不改既有 creative-fields / db schema）。
//
// expected_downstream_consumers:
// - Story 4.0：brief-compiler-node 产 chapter_brief artifact（#1-5,10 透传 leader ChapterBrief +
//   #6 从 scene_graph 汇编 M:N-aware plotPoints）；draft-writer 消费。
// - Story 4.1：填完整 10 段 + status 就绪阶梯（needs_plot→...→ready 阻断交接）。
// - Story 6.5：产 #7 Promise 任务（plant/advance/setback/payoff 节拍，typed shape）。
// - Story 2.6：产 #8 未决决策警告（StoryDecision ADR open→decided）。
// - Epic 5：产 #10 EmotionArc（VAD numeric schema 深化）。
// - Epic 6.6：产 #6 state-at-T（事件溯源状态引擎 reduce）。

// ── #6 关键剧情点（按场 M:N-aware + state-at-T）──
// 纯代码段（from scene_graph via scene-graph-analytics）：查本章（episodeId）涉及的 scene nodes
// （presentationSpans M:N，Story 1.8）+ 连续性标注（从 N-1 续 / 本章结束 / 续到 N+1）。
// state-at-T 占位（状态引擎 6.6 未建——shape 待 6.6，此处 unknown 不造假）。
export const briefPlotPointSchema = z.object({
  sceneId: z.string(),
  continuity: z.string().optional(),
  stateAtT: z.unknown().optional(),
});
export type BriefPlotPoint = z.infer<typeof briefPlotPointSchema>;

// ── #7 Promise 任务（Story 6.5：typed shape，from promise_registry via brief-compiler compilePromiseTasks）──
//
// 纯代码段（from promise_registry via brief-compiler-node）：filter 本章 episodeId/sceneId 相关的非 archived beats
// → join promise 主体 → 产本章 Promise 任务节拍。archived 场与 abandoned 线不下发（system.md:209）。
//
// 范式判据（ADR-3 / creative-vs-mechanical）：compilePromiseTasks = 纯代码 filter（按 episodeId/sceneRef 结构查询），
// 非语义。不判「这条 Promise 本章该不该推进」（归 promise-emergence-node LLM 登记）。
//
// 字段（design §7，mirror briefPlotPointSchema）：
// - promiseId/title/summary：Promise 主体识别 + 向读者许了什么（主笔知道这条债是什么）。
// - category?：分类（词表先验非封闭 enum，主笔据此调整写法——setup_payoff 公平性最严等）。
// - beatKind：本章该执行的节拍（plant/advance/setback/payoff，NeuroBook PromiseBeat.kind）。
// - note?：单次推进的具体指示（只给该场 writer，NeuroBook 三层之三）。
// - sceneRef：目标场景（→ SceneNode.id，主笔知道在哪落地）。
// - payoffExpectation?：兑现预期戏剧效果（只给兑现场的 writer）。
export const briefPromiseTaskSchema = z.object({
  promiseId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  category: z.string().optional(),
  beatKind: promiseBeatKindSchema,
  note: z.string().optional(),
  sceneRef: z.string().min(1),
  payoffExpectation: z.string().optional(),
});
export type BriefPromiseTask = z.infer<typeof briefPromiseTaskSchema>;

// ── #10 情绪目标（charter #2「情绪 > 情节 / 逻辑」，Closure 独有）──
// Story 5.1 refine（语义为一等 + VAD 可选投影，design D1/D2）：章级目标情绪。
// - emotion：目标情绪（语义情绪词，= 写作思维「情绪点」，LLM 段）。承 emotion_curve point.characters[].emotion（章级 vs 场级=粒度关系）。
// - emotionEnd：章级情绪转变（语义，= 写作思维「情绪动态」）。
// - steer：情绪 steer 指令（给 Writer）。
// - vad / vadEnd：可选数值投影（mirror vadTripleSchema，供 5.3 数学）；语义为主，VAD 非 truth（缺失降级语义趋势）。
// 章级 vs emotion_curve 场级是粒度关系非重叠；brief #10 从 emotion_curve per-scene 编译 or Director 独立产归 5.2。
export const briefEmotionTargetSchema = z.object({
  emotion: z.string().optional(),
  emotionEnd: z.string().optional(),
  steer: z.string().optional(),
  vad: vadTripleSchema.nullish(),
  vadEnd: vadTripleSchema.nullish(),
});
export type BriefEmotionTarget = z.infer<typeof briefEmotionTargetSchema>;

// ── #characterProgressions 本章角色弧走向（Story 8.5 R3 编译通道，design §4.1）──
//
// 非段·structured 字段（mirror manipulationDirectives 先例——十段框架不动）：brief-compiler 纯代码编译
// （episode.character_progressions 主源 + growth_curve 转折点 join + asset_cards 名字解析，
// compileCharacterProgressions 在 brief-compiler-node）。「不进 brief」原则合规：只携**本章特有** from→to
// （+至多本章命中的转折点一句），弧全量（wound/end_state/全部转折点）归可查询 field（growth_curve）。
//
// 命名 characterId/characterName/from/to 跟 episode 源字段（character_progressions）保持 traceable +
// join asset_cards 解析显示名（写手可读）；turningPoint = 本章命中的 growth_curve 转折点原文（设计语境）。
//
// 与 8.2 写时声明衔接（design §4.4）：设计的 progression（应然，本字段）vs arc-emergence 写时声明的
// 节拍（实然）构成 4.4/8.2 角色弧维「设计 vs 正文」对照地基；chapterTask = 整个 brief JSON → 本字段
// 自动直达 draft-writer（schema 字段路线，mirror emotionTarget）+ arc-emergence {{chapterBrief}} 对照位。
export const briefCharacterProgressionSchema = z.object({
  characterId: z.string().min(1),
  characterName: z.string().optional(),   // join asset_cards 解析显示名（写手可读）
  from: z.string(),
  to: z.string(),
  turningPoint: z.string().optional(),    // 本章命中的 growth_curve 转折点原文（设计语境）
});
export type BriefCharacterProgression = z.infer<typeof briefCharacterProgressionSchema>;

// ── #readiness status 就绪阶梯（Story 4.1 §3.2 / conclusions §3.9）──
//
// brief 落定前的就绪阶梯（防 leader 拿半成品 brief 触发链段写空稿）。5 档自下而上，每档=「缺什么」：
// - needs_plot：scene_graph 全空（项目无任何场结构——先建场）。
// - needs_world_anchor：有场但无设定（asset_cards/world_setting/creative_brief 全空——先建设定锚点）。
// - needs_world_context：有场+设定但 brief LLM 段缺（#1 goal 空——leader 填本章意图）。
// - needs_chapter_brief：有场+设定+LLM 意图但本章 episode 无匹配场（本章未在 scene_graph 排出——先排章）。
// - ready：全 populated，可交接链段。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical）：readiness = 纯代码（查段 populated 状态 +
// scene_graph 结构查询），非 LLM 语义判断。不编码「某内容好不好=ready」（那是 LLM 的事），只查「有没有」。
//
// ⚠️ design §3.2 字面 needs_plot 含「scene_graph 空 / 本章 episode 无 scene」OR；needs_chapter_brief 含
// 「plotPoints 空（scene 映射失败）」。两者在 plotPoints 未预编译时同底（都 bottom out 到「episode 无场」）。
// 本实现 disambiguate（落地公理：每档须可独立触发 + 可测）：
// - needs_plot = scene_graph 全空（全局无场结构）。
// - needs_chapter_brief = scene_graph 非空但本章 episode 0 匹配场（本章未排出）。
// 分裂 design §3.2 的 OR clause 到两档，使 5 档均可达 + 可测 + 可向用户给出针对性「缺什么」。
export const briefReadinessSchema = z.enum([
  'needs_plot',
  'needs_world_anchor',
  'needs_world_context',
  'needs_chapter_brief',
  'ready',
]);
export type BriefReadiness = z.infer<typeof briefReadinessSchema>;

/**
 * ChapterBrief — 写章 brief（design §3 / conclusions §3.9，段号=稳定标识非序数）。全 optional。
 *
 * 段序（§3.9）：
 * 1. 目标/落点（goal + ending 结尾定句）—— LLM 段
 * 2. 参数（pov + tone）—— LLM 段
 * 3. 信息控制（readerKnows / protagonistKnows / mustHide / hintOnly）—— LLM 段（charter #1）
 * 4. 节奏/下章牵引（pacing + opening + nextHook 下章钩）—— LLM 段
 * 5. 禁写（doNotWrite）—— LLM 段
 *    + gap-whitelist（故意惊喜白名单，4.2 §8：一致性维命中降级 info 不误报作者故意 gap）
 * 6. 关键剧情点（plotPoints 按场 M:N-aware + state-at-T）—— 纯代码段（from scene_graph）
 * 7. Promise 任务（promiseTasks）—— 纯代码段（6.5 typed shape briefPromiseTaskSchema；compilePromiseTasks from promise_registry）
 * 8. 未决决策警告（openDecisions）—— 纯代码段（4.1 Step 3 收紧 shape = storyDecisionSchema.pick {id,summary,risk}；brief-compiler filter open）
 * 10. 情绪目标（emotionTarget emotion/emotionEnd/steer + vad/vadEnd 可选投影）—— LLM 段（charter #2，Closure 独有）
 *
 * 段号是稳定标识非序数：#9 建议读取已随 8.4 写手自查退役（写手自查工具循环取代——主笔亲自查询一手
 * 材料），号位空置不重排（#10 等既有引用零波及）。
 *
 * cliffhanger 走 brief（#1 ending + #4 nextHook + Promise setback），非图边（§3.9）。
 */
export const chapterBriefSchema = z.object({
  // #1 目标/落点
  goal: z.string().optional(),
  ending: z.string().optional(),
  // #2 参数
  pov: z.string().optional(),
  tone: z.string().optional(),
  // #3 信息控制（charter #1）
  readerKnows: z.string().optional(),
  protagonistKnows: z.string().optional(),
  mustHide: z.string().optional(),
  hintOnly: z.string().optional(),
  // #4 节奏/下章牵引
  pacing: z.string().optional(),
  opening: z.string().optional(),
  nextHook: z.string().optional(),
  // #5 禁写
  doNotWrite: z.string().optional(),
  // #gap-whitelist 故意惊喜白名单（Story 4.2 §8 / .trellis/spec/core/creative-vs-mechanical.md）：
  // 作者标注的「故意非线性叙事 / 信息延迟 / 信息 gap」位置——Reader-Audit 一致性维命中时降级 info
  // 不报（防误报作者故意的惊喜 gap，复用 scene-graph art_overrides「故意惊喜」白名单哲学）。
  //
  // 二态契约（interface-contracts.md「optional 数组二态用 .min(1)」）：缺失 = 无白名单（默认行为），
  // ≥1 = 白名单生效。空 `[]` 无意义（非任一状态）→ `.min(1)` 拒收（免 LLM/手改产 `[]` 第三态 + 下游
  // truthiness 混淆）。L2 Reader-Audit prompt 收 briefIntent（含 gap_whitelist）据创作意图不误报。
  gap_whitelist: z
    .array(
      z.object({
        location: z.string(),
        reason: z.string(),
      }),
    )
    .min(1)
    .optional(),
  // #6 关键剧情点（按场 M:N-aware，纯代码段 from scene_graph）
  plotPoints: z.array(briefPlotPointSchema).optional(),
  // #7 Promise 任务（6.5 typed shape——compilePromiseTasks from promise_registry filter 本章非 archived beats；
  //   brief-compiler 读 promise_registry artifact via assembleChapterChainArtifacts 注入）
  promiseTasks: z.array(briefPromiseTaskSchema).optional(),
  // #8 未决决策警告（2.6 StoryDecision ADR open；4.1 Step 3 收紧 shape——storyDecisionSchema.pick
  //   {id,summary,risk}：brief-compiler filter status:'open' + relatedEpisodeId 命中本章 / 全局 open）
  openDecisions: z.array(storyDecisionSchema.pick({ id: true, summary: true, risk: true })).optional(),
  // #10 情绪目标（charter #2，Closure 独有；E5 深化）
  emotionTarget: briefEmotionTargetSchema.optional(),
  // #manipulationDirectives（Story 6.3：Director 产 via InfoReleaseMap → brief-compiler compileInfoRelease 注入；
  // structured 供 Reader-Audit L2 forbiddenMoves 裁判。与 #3 自然语言字段并行——#3 给 Writer 读，本字段给 L2 精确裁判）。
  // 二态 .min(1)（mirror gap_whitelist：缺失=无指令默认 / ≥1=有指令 / 空 [] 第三态拒收）。
  manipulationDirectives: z.array(manipulationDirectiveSchema).min(1).optional(),
  // #characterProgressions（Story 8.5 R3：本章角色弧走向，非段·structured 字段 mirror manipulationDirectives
  // 先例）。纯代码编译（episode 主源 + growth_curve join，compileCharacterProgressions）；draft-writer prompt
  // 显式行消费（体现非复述）。二态：缺失 = 无弧走向（默认，主笔照写）；≥1 = 有走向；空 `[]` 合法
  // （本章确无角色进展——过场章），**不加 .min(1)**。
  characterProgressions: z.array(briefCharacterProgressionSchema).optional(),
  // #recompileHints（链流程重排 W2 遗留①）：规划环 revise 回环的**重编意图注入**——brief-compiler
  // 重跑时读上一轮 plan_review artifact 的 hard findings 机械注入（纯投影，不判语义），让规划环
  // revise 有实质输入而非「同输入确定性重编 + 空 LLM 复判到 cap」。随 chapterTask JSON 进写手
  // prompt（写手据 hints 自查/规避），A2 复审在卡面上可见（brief JSON 自带）。二态 .min(1)
  //（mirror gap_whitelist：缺失 = 无重编提示默认 / ≥1 = 有提示；空 [] 第三态拒收）。首圈无
  // plan_review → 缺省零回归。
  recompileHints: z
    .array(
      z.object({
        /** 六维 canonical 标识（mirror PlanReviewFinding.dimension，开放 string）。 */
        dimension: z.string().min(1),
        /** 对照输入的哪条字段（grounding 硬要求，mirror PlanReviewFinding.grounding）。 */
        grounding: z.string().min(1),
        /** 问题说明 + 可执行的重编方向（mirror PlanReviewFinding.note）。 */
        note: z.string().min(1),
      }),
    )
    .min(1)
    .optional(),
  // #readiness 就绪阶梯（4.1 §3.2）：brief-compiler 产 chapter_brief 时填；运行时 gate 据此阻断交接。
  // additive optional——4.0 既有 brief（无 readiness）仍合法（gate 入口调 computeReadiness 现算补上）。
  readiness: briefReadinessSchema.optional(),
});

export type ChapterBrief = z.infer<typeof chapterBriefSchema>;

// ── readiness 计算 + gate（Story 4.1 §3.2，纯代码，落 shared-contracts 两入口共用）──
//
// computeReadiness = 按段 populated 状态算就绪阶梯的纯函数。落 shared-contracts（非 agent
// brief-compiler-node）：因 gate 两入口（agent write-chapter tool + shell closureChainIpc）都需在
// assemble 后、跑链段前用它现算 readiness 阻断，shell 直 import agent nodes 不雅（layering），而本函数
// 只依赖 shared types（ChapterBrief/SceneGraph）→ shared-contracts 是最干净的独立可调点（implement 选
// 「更干净的」：computeReadiness 抽成可独立调用纯函数，入口用 initial artifacts 直接算 gate，不跑全链段）。
// brief-compiler-node 产 chapter_brief 时也调它填 readiness（单源真值）。
//
// 范式判据：纯结构查询（有/无 + isSceneInEpisode 图查询），非语义。不判「内容够好」（归 LLM）。
//
// scene episode 匹配复用 scene-graph-analytics 的 `isSceneInEpisode`（单源 DRY，Story 4.1 Step 2 统一）：
// brief-compiler `compilePlotPoints` + 本处 readiness `episodeHasScenes` + `selectScenesForEpisode` 三处共用。

/** 本章 episode 是否在 scene_graph 中有匹配场（episodeId 直挂或 presentationSpans M:N 命中）。 */
function episodeHasScenes(sceneGraph: SceneGraph | undefined, episodeId: string | undefined): boolean {
  if (!sceneGraph || !episodeId) return false;
  return sceneGraph.nodes.some((n) => isSceneInEpisode(n, episodeId));
}

/** brief LLM 段是否已填（#1 goal = 本章目标/落点，brief 意图头——conclusions §3.9 第 1 段）。 */
function hasLlmSegments(brief: ChapterBrief): boolean {
  return typeof brief.goal === 'string' && brief.goal.trim().length > 0;
}

/**
 * 计算 brief 就绪阶梯（design §3.2 / conclusions §3.9）。纯函数：按段 populated 状态返回 5 档之一。
 *
 * 判定序（每档=「缺什么」，阻断交接时返给用户针对性提示）：
 * 1. needs_plot：scene_graph 全空（nodes=[]——项目无任何场结构）。
 * 2. needs_world_anchor：有场但 settingsPresent=false（设定锚点 asset_cards/world_setting/creative_brief 空）。
 * 3. needs_world_context：有场+设定但 brief LLM 段缺（#1 goal 空——leader 未填本章意图）。
 * 4. needs_chapter_brief：有场+设定+LLM 意图但本章 episode 无匹配场（本章未在 scene_graph 排出）。
 * 5. ready：全 populated。
 *
 * @param brief            leader 填的 ChapterBrief（gate 入口=initial leader brief；brief-compiler=含 #6 plotPoints 的完整 brief）。
 * @param sceneGraph       project scene_graph（结构查询源；缺 → needs_plot）。
 * @param episodeId        本章目标 episode id（缺 → needs_plot/needs_chapter_brief 派不出匹配）。
 * @param settingsPresent  设定锚点是否存在（入口调 compileSettingPrefix(project).length>0 算，纯结构信号）。
 * @returns                BriefReadiness 5 档之一。
 */
export function computeReadiness(
  brief: ChapterBrief,
  sceneGraph: SceneGraph | undefined,
  episodeId: string | undefined,
  settingsPresent: boolean,
): BriefReadiness {
  // 1. needs_plot：全局 scene_graph 无任何场（项目无场结构）。
  if (!sceneGraph || sceneGraph.nodes.length === 0) return 'needs_plot';
  // 2. needs_world_anchor：有场但无设定锚点。
  if (!settingsPresent) return 'needs_world_anchor';
  // 3. needs_world_context：有场+设定但 brief LLM 意图缺（#1 goal 空）。
  if (!hasLlmSegments(brief)) return 'needs_world_context';
  // 4. needs_chapter_brief：有场+设定+LLM 意图但本章 episode 无匹配场（本章未在 scene_graph 排出）。
  if (!episodeHasScenes(sceneGraph, episodeId)) return 'needs_chapter_brief';
  // 5. ready：全 populated。
  return 'ready';
}

/** non-ready 阶梯 → 用户可读的「缺什么」描述（assertBriefReady / gate 入口返 leader 用）。 */
export const BRIEF_READINESS_GAP: Readonly<Record<Exclude<BriefReadiness, 'ready'>, string>> = {
  needs_plot: '场景结构为空（scene_graph 无任何场）——先用工作台或工具建场',
  needs_world_anchor: '缺少设定锚点（asset_cards / world_setting / creative_brief 均空）——先建设定',
  needs_world_context: '缺少 brief LLM 段（#1 目标/落点 goal 未填）——leader 需填本章意图',
  needs_chapter_brief: '本章 episode 在 scene_graph 中无匹配场——先为本章排出 scene',
};

/**
 * brief 未就绪结构化错误（gate 阻断时抛）。{readiness, missing} 供入口 catch 后返 leader/用户。
 * readiness 缺省（undefined，4.0 既有 brief 未填 readiness）→ 视作最底档 needs_plot。
 */
export class BriefNotReadyError extends Error {
  readonly readiness: BriefReadiness;
  readonly missing: string;
  constructor(readiness: BriefReadiness | undefined) {
    const stage: BriefReadiness = readiness ?? 'needs_plot';
    const missing = stage === 'ready' ? '' : BRIEF_READINESS_GAP[stage];
    super(`brief not ready: stage=${stage}${missing ? ` — ${missing}` : ''}`);
    this.name = 'BriefNotReadyError';
    this.readiness = stage;
    this.missing = missing;
  }
}

/**
 * gate 断言：chapterBrief.readiness === 'ready' 通过；否则抛 BriefNotReadyError（带 {readiness, missing}）。
 *
 * 调用方须先 computeReadiness 把 readiness 填进 brief（gate 入口典型：assemble 后现算 readiness →
 * {…brief, readiness} → assertBriefReady）。brief-compiler 产的 chapter_brief 已自带 readiness。
 */
export function assertBriefReady(chapterBrief: ChapterBrief): void {
  if (chapterBrief.readiness !== 'ready') {
    throw new BriefNotReadyError(chapterBrief.readiness);
  }
}
