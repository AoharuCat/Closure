import type { StoryDecision } from './story-decision';
import { wouldChapterLandAtOrder, type ChapterOrderingEntry } from './chapter-ordering';
import { sanitizeDiskName } from '../fs/naming';

// ── Story 4.1 Step 4：chapter-integration 持久化（CR-15b）共享纯函数 ──
//
// design §3.3 layering 合规路径：**agent 不能 fs 直写 project.yaml**（data-model.md L31 所有权：project.yaml
// 受管配置，只结构化 IPC 在项目锁内写）。链段 child session **不写盘**——产 `chapter_accept` artifact
// 经 RunSnapshotSummary 回传，入口层（IPC 同层调 acceptChapterCandidate / leader 返 field_patch metadata
// 走既有 patch review 流）持久化。本文件 = 入口层 + 链段共用的**纯函数**（无 fs / 无 Date / 无 db）：
//
// - `acceptChapterCandidateCore`：acceptChapterCandidate（local-bff standalone API）+ applyFieldPatches
//   chapter_candidate 分支共同的项目 mutation 纯逻辑（DRY）。两 local-bff 调用方包 disk 写盘（mkdir +
//   atomicWrite + saveProject），core 只算 `updatedProject + mdPath + mdContent + chapterMeta`。
// - `resolveChapterIdForEpisode`：episodeId → episode_outlines[].index → novel.chapters[sort_order===index]
//   映射（章号从 episode.index 派生，creative-fields.ts:952 / weavingLayout.ts「章 = episode.index, derived
//   not stored」）。映射失败 → undefined（accept 阻断 + 明确报错，非静默写错位置）。
// - `buildChapterAccept`：链段 accept 分支（onAccept 回调）从 RunSnapshot + project 上下文产 chapter_accept
//   artifact（不写盘）。入口层（write-chapter tool / closureChainIpc）提供 onAccept 闭包调本函数。
//
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：本文件全确定性（结构 mutation / ref 查询 /
// 字段投影），「不理解意义」。deviation 判定（正文是否偏离计划）归 LLM route 节点（route_decision.deviation
// 字段，yaml 输出）；本处只机械读 boolean 决定是否登记 StoryDecision。chapterId 映射 = 纯结构查询。
//
// 落点 shared-contracts（design §5）：跨包共享（agent 链段 onAccept + local-bff 两调用方 + shell IPC 入口）。
// 纯函数（无 fs/db/LLM/Date）→ 可 plain vitest 单测。零 migration（新文件；调用方 additive optional 字段）。
//
// expected_downstream_consumers:
// - Story 4.1 Step 4（本 step）：local-bff acceptChapterCandidate + applyFieldPatches 重构调 core；
//   agent chainRunner onAccept 调 buildChapterAccept；write_chapter / closureChainIpc 入口层持久化。
// - Story 4.1 Step 5：工作台 leader 触发入口（UI 接线）消费 chapter_accept field_patch metadata。
// - Story 2.6：工作台 UI 决策登记 / Director agent 登记（交互层 defer E3 / Director）。

// ── ChapterCandidate：draft 产出 → 持久化候选 shape ──
//
// mirror local-bff novelProjectRepository.ChapterCandidate + novel-orchestration chapterCandidatePatchSchema.candidate
// （两处同形 {title?, content, summary?, wordCount?}）。draft-writer 产出 {title, text, wordCount} → candidate
// 映射 title→title / text→content / wordCount→wordCount（content 字段名对齐 chapter_candidate patch 既有契约）。

/** 章节候选内容（draft 产出 → chapter markdown + 元数据更新）。 */
export interface ChapterCandidate {
  title?: string;
  content: string;
  summary?: string;
  wordCount?: number;
}

// ── chapterId 映射所需的最小 chapter / episode 结构（结构性，避免拉全 ProjectDocument 类型）──

/** resolveChapterIdForEpisode 接受的章节结构子集（novel.chapters[] 元素满足）。 */
export interface ResolvableChapter {
  id: string;
  /** 章节排序序号（0-based；章号从 episode.index 派生，故 sort_order===episode.index 为本章）。 */
  sort_order?: number;
}

/** resolveChapterIdForEpisode 接受的 episode 结构子集（episode_outlines[] 元素满足）。 */
export interface ResolvableEpisode {
  id: string;
  /** episode 索引（0-based，章号源——creative-fields.ts:952 / weavingLayout.ts）。 */
  index: number;
}

// ── acceptChapterCandidateCore：项目 mutation 纯逻辑（不写盘）──

/**
 * acceptChapterCandidateCore 接受的项目结构子集（ProjectDocument 满足；结构 typing 避免拉全类型 + migration）。
 *
 * `novel.chapters[]` + `novel.story_decisions[]`（4.1 Step 3 落库点）+ `meta.{version, updated_at}`。
 * core 不做 schema re-parse（纯 mutation；调用方包 projectDocumentSchema.parse + saveProject）。
 */
export interface ChapterIntegrationProject {
  novel?: {
    chapters?: Array<{
      id: string;
      title?: string;
      sort_order?: number;
      summary?: string;
      // CR-4.1-11：对齐 chapterSchema 实际（z.enum(['ai','user']).optional()）；旧 `string` type-lie 放宽。
      summary_source?: 'ai' | 'user';
      status?: string;
      word_count?: number;
      last_run_id?: string;
      generated_at?: string;
      sections?: Array<{ id: string; content_file: string; word_count?: number; sort_order?: number }>;
    }>;
    story_decisions?: StoryDecision[];
  };
  meta: { version: number; updated_at: string };
}

/** core 产出的本章元数据快照（持久化后状态，供调用方 / 测试断言）。 */
export interface ChapterMetaSnapshot {
  title?: string;
  summary?: string;
  // CR-4.1-11：对齐 chapterSchema（z.enum(['ai','user']).optional()）；旧 `'ai'` type-lie（pre-existing
  // 'user' 会被窄化丢）。candidate 无 summary 时保留原 chapter.summary_source（可能 'user'）。
  summary_source?: 'ai' | 'user';
  word_count?: number;
  status: string;
  last_run_id: string;
  generated_at: string;
}

export interface AcceptChapterCandidateInput {
  project: ChapterIntegrationProject;
  chapterId: string;
  runId: string;
  candidate: ChapterCandidate;
  /** ISO 时间戳——caller 注入（core 纯函数无 Date；local-bff 调用方 `new Date().toISOString()`）。 */
  nowISO: string;
  /** accept 登记 StoryDecision（route=accept_as_truth 且正文偏离计划时，onAccept 建 decided decision）。 */
  storyDecisions?: StoryDecision[];
}

export interface AcceptChapterCandidateResult {
  /** mutation 后的项目（章节元数据更新 + story_decisions 追加 + meta.version/updated_at 递增）。 */
  updatedProject: ChapterIntegrationProject;
  /** section.content_file（相对路径，调用方 join projectPath + mkdir + atomicWrite）。 */
  mdPath: string;
  /** candidate.content（调用方 atomicWrite 写入 mdPath）。 */
  mdContent: string;
  /** 本章更新后元数据快照。 */
  chapterMeta: ChapterMetaSnapshot;
}

/**
 * accept 章节 candidate 的项目 mutation 纯逻辑（design §3.3 / CR-15b）。**不写盘**——disk 写盘（mkdir +
 * atomicWrite + saveProject）在 local-bff 调用方。
 *
 * 逻辑（mirror acceptChapterCandidate + applyFieldPatches chapter_candidate 共同部分）：
 * 1. structuredClone project（不改入参引用）。
 * 2. 查 novel.chapters + chapter(by id) + section[0]——任一缺失 → 返 null（调用方决定 throw 或静默 skip）。
 * 3. 更新章节元数据：title（candidate 有）/ summary + summary_source='ai'（candidate 有）/ word_count +
 *    section.word_count（candidate 有）/ status='draft' / last_run_id=runId / generated_at=nowISO。
 * 4. story_decisions 追加（若提供）到 novel.story_decisions（create array if absent）。
 *
 * ⚠️ **不动 meta.version / meta.updated_at**：版本递增是调用方的 batch 级关注点（acceptChapterCandidate
 * 单 candidate 调用 bump 一次；applyFieldPatches 整批 patch loop-end bump 一次）。core 若 bump 会让
 * applyFieldPatches 的 loop-end 再 bump 一次 → double-count。调用方各自 bump meta。
 *
 * 调用方行为差异（由调用方处理，core 统一返 null on missing）：
 * - `acceptChapterCandidate`（standalone API）：null → throw「chapter not found」（显式失败）。
 * - `applyFieldPatches` chapter_candidate 分支：null → continue（静默 skip，mirror 4.0 前姿态）。
 *
 * @returns mutation 结果，或 null（章节 / section 缺失）。调用方决定如何处理 null。
 */
export function acceptChapterCandidateCore(
  input: AcceptChapterCandidateInput,
): AcceptChapterCandidateResult | null {
  const { project, chapterId, runId, candidate, nowISO, storyDecisions } = input;

  const next = structuredClone(project) as ChapterIntegrationProject;

  // CR-4.1-10：删旧 `if (!next.novel) next.novel = { chapters }` 无效分支——`chapters` 派生自 `next.novel?.chapters`，
  // 缺已下方 null return，故 next.novel 必存在（旧分支 unreachable）。且若 reach，`next.novel = { chapters }`
  // 会丢 story_decisions + 同级键（重建 novel 只含 chapters）。改用 local `novel` 引用：经此命名引用 TS 能
  // narrow（旧经中间变量 `chapters` 的 optional chain 不能传播 narrowing 回 `next.novel`，故旧代码靠被删的
  // 无效分支作 type-guard）。`novel` 与 `next.novel` 同一引用，mutate 经 `next` 返回。
  const novel = next.novel;
  if (!novel || !novel.chapters) return null;
  const chapters = novel.chapters;
  const chapter = chapters.find((ch) => ch.id === chapterId);
  if (!chapter) return null;
  const section = chapter.sections?.[0];
  if (!section) return null;

  // 更新章节元数据（与 acceptChapterCandidate / applyFieldPatches 共同逻辑一致）。
  if (candidate.title !== undefined) {
    chapter.title = candidate.title;
  }
  if (candidate.summary !== undefined) {
    chapter.summary = candidate.summary;
    chapter.summary_source = 'ai';
  }
  if (candidate.wordCount !== undefined) {
    chapter.word_count = candidate.wordCount;
    section.word_count = candidate.wordCount;
  }
  chapter.status = 'draft';
  chapter.last_run_id = runId;
  chapter.generated_at = nowISO;

  // story_decisions 追加（accept 登记；create novel.story_decisions 若 absent）。novel 经 local 引用 TS
  // 已 narrow 为 defined（无需旧无效 type-guard 分支）。
  if (storyDecisions && storyDecisions.length > 0) {
    if (!novel.story_decisions) novel.story_decisions = [];
    novel.story_decisions.push(...storyDecisions);
  }

  return {
    updatedProject: next,
    mdPath: section.content_file,
    mdContent: candidate.content,
    chapterMeta: {
      title: chapter.title,
      summary: chapter.summary,
      // CR-4.1-11：cast 删——ChapterIntegrationProject.novel.chapters[].summary_source 已收紧为
      // `'ai' | 'user' | undefined`（对齐 schema），直接读类型正确（旧 `as 'ai' | undefined` 是 type-lie）。
      summary_source: chapter.summary_source,
      word_count: chapter.word_count,
      status: chapter.status,
      last_run_id: chapter.last_run_id,
      generated_at: chapter.generated_at,
    },
  };
}

// ── resolveChapterIdForEpisode：episodeId → chapterId 映射 ──

/**
 * 解析 episodeId 对应的 novel.chapters[].id（design §3.3 / CR-15b 硬约束）。
 *
 * 映射链（章号源 = episode.index，creative-fields.ts:952 注释 + weavingLayout.ts:17「章 = episode.index,
 * derived not stored」）：
 * 1. directChapterId 提供（用户工作台选章直传）→ 直接返回（绕过映射推断，优先）。
 * 2. episode_outlines.find(id===episodeId).index → novel.chapters.filter(sort_order===index) 唯一命中 → id。
 * 3. 任一步缺失 / 歧义（episode 不存在 / 0 命中=章未注册 / >1 命中=sort_order 重复歧义）→ undefined
 *    （accept 阻断 + 明确报错，CR-4.1-06：旧 `find` 取首个静默写错章）。
 *
 * sort_order 与 episode.index 均为 0-based nonnegative int（chapterSchema.sort_order / episodeOutlineSchema.index）
 * ——第 1 章 = sort_order 0 = episode.index 0。两者直等映射（与 brief-compiler episodeIndexById 同源）。
 *
 * 范式判据（ADR-3）：纯结构查询（ref 相等 + 数值相等），非语义。不判「这章属不属于这 episode」（章号派生
 * 是数据约定，非判断）。
 *
 * @param episodeOutlines  project.episode_outlines（章号源；缺 → 仅靠 directChapterId）
 * @param novelChapters    project.novel.chapters（注册章节；缺 → 仅靠 directChapterId）
 * @param episodeId        本章目标 episode id（refs episode_outlines[].id）
 * @param directChapterId  用户工作台选章直传（优先；绕过映射推断）
 * @returns                chapter id，或 undefined（映射失败）
 */
export function resolveChapterIdForEpisode(
  episodeOutlines: ReadonlyArray<ResolvableEpisode> | undefined,
  novelChapters: ReadonlyArray<ResolvableChapter> | undefined,
  episodeId: string,
  directChapterId?: string,
): string | undefined {
  // 用户直传优先（绕过映射推断）。
  if (directChapterId) return directChapterId;

  // episode → index
  if (!episodeOutlines) return undefined;
  const episode = episodeOutlines.find((ep) => ep.id === episodeId);
  if (!episode) return undefined;
  const targetIndex = episode.index;

  // index → chapter（sort_order===index）
  if (!novelChapters) return undefined;
  // CR-4.1-06：多命中检测——chapterSchema.sort_order 无唯一约束，两章共 sort_order 时旧 `find`
  // 取首个命中会静默写错章（accept 持久化到错位置）。改 filter + length!==1 防御：0（章未注册）或
  // >1（映射歧义）均 → undefined（accept 阻断 + 入口层据 skipReason:'no-chapter' 出明确报错）。
  const matches = novelChapters.filter((ch) => ch.sort_order === targetIndex);
  if (matches.length !== 1) return undefined;
  return matches[0].id;
}

// ── countChaptersAtSortOrder：0 命中 vs 多命中区分（dogfood R2 #107 / R1.1 入口层判定辅助）──

/**
 * 数 novel.chapters 中 `sort_order === index` 的章数。
 *
 * `resolveChapterIdForEpisode` 把 0 命中（章未注册）与 >1 命中（sort_order 重复歧义）折叠成同一
 * undefined；#107 自动建章只对 **0 命中** 合法（空位可补；>1 歧义是数据问题，自动建章救不了映射
 * 歧义，维持现行报错）。入口层（write_chapter / closureChainIpc run+resume 两车道）用本函数区分
 * 两态，不在各自入口重写 filter 防漂移（一处逻辑三处消费，必须单源——design §1.1 拍板）。
 *
 * 配对不变式（chapter-integration.test.ts 锚定）：`countChaptersAtSortOrder(chs, i) === 1` ⟺
 * `resolveChapterIdForEpisode`（episode.index===i 侧）返回 defined——两者共享同一比较式，测试防漂移。
 *
 * 范式判据（ADR-3）：纯计数（数值相等 filter），非语义。
 */
export function countChaptersAtSortOrder(
  novelChapters: ReadonlyArray<ResolvableChapter> | undefined,
  index: number,
): number {
  if (!novelChapters) return 0;
  return novelChapters.filter((ch) => ch.sort_order === index).length;
}

// ── #107 R1.1：no-chapter 链侧自动建章（判定 + stem + 文件内容，纯函数单源）──
//
// dogfood R2 #107 首章冷启动：novel.chapters 的出生源是 chapters/*.md 磁盘派生（renderer 驱动
// 闭环），链/UI/agent 三不通——首章未建时链 accept 的 chapterId 映射恒 no-chapter，正文悬空于
// 章档案。修法 = 链侧 accept 遇 no-chapter 且空位时自动建章文件（把「用户手动建文件」手势
// 自动化的语义，不走 story_sync_apply——白名单零冲突，PRD R1.3 自动满足）。
//
// 判定/stem/内容构造在本文件单源（agent write-chapter no-chapter 消费点 + shell
// persistChapterAcceptIfNeeded 前置三处消费，防漂移）；建文件动作在各车道自己的通道
// （agent 经 registry chapter_write builtin → 注入 seam → shell handler；shell 直调
// chapterWriteHandler——agent 不直写盘的分层纪律不破）。

/** 章标题 → 文件名安全段（Windows 非法字符清洗；中文标题友好——ASCII 白名单折叠会毁掉整题）。 */
export function sanitizeChapterStemSegment(title: string): string {
  return sanitizeDiskName(
    title
      // Windows 文件名非法字符（<>:"/\|?*）+ 控制字符 + 换行 → 剔除（不替换占位符：中文标题可读性优先；
      // 对照 writer-node archiveDirName 的 `[^a-zA-Z0-9_-]` 折叠——那里的输入是 ASCII episodeId，此处是章节标题）。
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      // 连续空白折叠 + 去首尾（标题内换行/多空格不应变成文件名里的怪形态）。
      .replace(/\s+/g, ' ')
      .trim()
      // Windows 不允许文件名以点/空格结尾。
      .replace(/[. ]+$/, ''),
    // 命名单源收尾（W2 R1 / FS#6）：保留名 '-doc' 后缀（插首点前，CON → CON-doc、CON.x →
    // CON-doc.x——与 sanitizeDiskName 同语义）+ 40 长度帽（MAX_PATH 理由不变，**帽保持 40 不换
    // 默认 80**）+ 截断后尾点/空格复修。入串经上方清洗已无非法/控制字符，单源的替换面对它
    // 是 no-op——只叠加保留名与帽语义，既有删除式清洗语义与全部既有用例不变。
    { maxLength: 40 },
  );
}

/** planAutoCreateChapter 判定输入（入口层各自从已加载 project 数据 + summary 组装）。 */
export interface AutoCreateChapterInput {
  episodeOutlines?: ReadonlyArray<ResolvableEpisode>;
  novelChapters?: ReadonlyArray<ResolvableChapter>;
  episodeId: string;
  /** 用户直传 chapterId（显式指定 = 用户意图，注册缺失属另一问题，不自动建）。 */
  directChapterId?: string;
  /** 拟用标题（summary.draftTitle；空/缺省时 stem 与标题都退化为纯「第N章」）。 */
  title?: string;
}

/** 自动建章计划（判定全过才返；两车道据此建文件 + 组装补产候选）。 */
export interface AutoCreateChapterPlan {
  /**
   * 章文件名去 .md（= 新章 id = chapter_write 幂等键）。**确定性锚 episode.index**：同章重跑
   * title 漂移不产第二文件（同 stem 覆盖，chapter_write 同内容早退）。
   */
  stem: string;
  /** episode.index（写入 frontmatter `order:`——登记载体，磁盘派生排序键）。 */
  episodeIndex: number;
  /** 章标题（清洗后；输入标题空时退化 `第N章`——文件 `# 标题` 行 + 派生 title 源）。 */
  title: string;
}

/**
 * #107 R1.1 自动建章判定（design §1.1；纯函数）：
 *
 * ```
 * 可自动建 :=
 *   未显式传 directChapterId                                  // 用户意图，不自动造
 *   && episode 存在（episodeOutlines.find(id)）
 *   && countChaptersAtSortOrder(novelChapters, episode.index) === 0   // 0 命中空位；>1 歧义维持现报错
 *   && wouldChapterLandAtOrder(diskSim, newEntry, episode.index)      // R1.1d 落位守卫
 * ```
 *
 * ⚠️ **diskSim 近似边界（此处即守卫的真实能力边界，如实声明）**：守卫需要「盘派生态」（各章文件的
 * frontmatter order），但入口层（agent/shell）实际可得的是 novel.chapters 的 yaml 注册态——其
 * `sort_order` 是**上次派生的落位结果**（排序后位置，chapter-ordering 契约 1）。以 sort_order 作
 * explicitOrder 近似模拟盘态，**等价条件 = 既有章文件 order 连续密集**（此时文件 order === yaml
 * 位置）。盘上 order 有洞 / 混排（部分文件无 frontmatter）时，本近似可能放行实际会错位的场景
 * ——守卫降级为「yaml 态守卫」（位置 0..N-1 全满 + N 空才建），首章（novelChapters 空）零近似
 * 误差必然正确。入口层无盘读通道（renderer 派生是唯一注册闭环），此残余风险接受并在此记档。
 *
 * 范式判据（ADR-3）：全确定性（filter 计数 + 排序模拟 + 字符清洗），非语义。
 */
export function planAutoCreateChapter(input: AutoCreateChapterInput): AutoCreateChapterPlan | undefined {
  // 1. 显式 chapterId 直传 → 不自动建（用户指定目标章，注册缺失属另一问题）。
  if (input.directChapterId) return undefined;
  // 2. episode 不存在 → 映射链断，无从判定位。
  const episode = input.episodeOutlines?.find((ep) => ep.id === input.episodeId);
  if (!episode) return undefined;
  // 3. 0 命中才可补位（countChaptersAtSortOrder 单源）；>1 = sort_order 重复歧义（数据问题，
  //    自动建章救不了映射歧义，维持现行报错）。
  if (countChaptersAtSortOrder(input.novelChapters, episode.index) !== 0) return undefined;

  const chapterNo = String(episode.index + 1).padStart(2, '0');
  const titleSegment = sanitizeChapterStemSegment(input.title ?? '');
  const stem = titleSegment ? `第${chapterNo}章-${titleSegment}` : `第${chapterNo}章`;
  const title = titleSegment || `第${chapterNo}章`;

  // 4. R1.1d 落位守卫：模拟「现有章集 + 新章（order: episode.index）」过磁盘派生排序，
  //    新章落位位置须 === episode.index（否则不建，防 order 有洞/混排产错位章）。
  //    diskSim 构造 = novelChapters 的 (id, sort_order 作 explicitOrder 近似)——边界见上方注释块。
  const diskSim: ChapterOrderingEntry[] = (input.novelChapters ?? []).map((ch) => ({
    id: ch.id,
    fileName: `${ch.id}.md`,
    explicitOrder: typeof ch.sort_order === 'number' ? ch.sort_order : null,
  }));
  const newEntry: ChapterOrderingEntry = { id: stem, fileName: `${stem}.md`, explicitOrder: episode.index };
  if (!wouldChapterLandAtOrder(diskSim, newEntry, episode.index)) return undefined;

  return { stem, episodeIndex: episode.index, title };
}

/**
 * #107 R1.1 自动建章的文件内容（磁盘派生消费契约 chapterDiskDerivation 的对偶生产端）：
 *
 * - frontmatter `order: N`（登记载体——派生排序键；R3.4 后编辑器兼容 frontmatter）。
 * - `# 标题`（派生 title 源；无则 fallback 文件名 stem）。
 * - body 提供时（direct 车道）正文 = 采信稿全文；缺省（review 车道骨架）无正文——正文走候选
 *   →PatchReview 人审 → acceptChapterCandidateCore 落盘（review「写内容须人批」语义不破）。
 *
 * ⚠️ candidate.content 必须用**同形态完整内容**（含 frontmatter）——accept 落盘
 * (acceptChapterCandidateCore mdContent=candidate.content 原文直写) 会整体覆盖文件，body-only
 * 候选会把 frontmatter 连 order 一起抹掉 → 派生重排错位。
 */
export function autoCreatedChapterFileContent(plan: AutoCreateChapterPlan, body?: string): string {
  const header = `---\norder: ${plan.episodeIndex}\n---\n\n# ${plan.title}\n`;
  return body ? `${header}\n${body}` : header;
}

// ── preserveChapterFrontmatter：章文件覆写的 frontmatter 保序规则（#107 check 批补缝）──

/**
 * 章文件 frontmatter 块形状（与 ui `shared/utils/frontmatter.ts` / 派生消费端
 * `chapterDiskDerivation` 同形状：容忍 BOM / 尾随空白 / CRLF / EOF 收尾）。
 * 本模块自持正则（shared-contracts 是最底层包，不能 import ui util——形状由
 * chapter-integration.test.ts 锚定与 ui 侧测试对拍，防漂移）。
 */
const CHAPTER_FILE_FRONTMATTER_RE = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function leadingFrontmatterBlock(text: string): string | null {
  return text.match(CHAPTER_FILE_FRONTMATTER_RE)?.[0] ?? null;
}

/**
 * 章文件覆写保序规则（#107 invariant 补缝，check 批 2026-08-30）：
 *
 * #107 后 frontmatter `order:` 是**每章**的登记载体（磁盘派生排序键）——但既有三条
 * body-only 覆写路径会在重写已注册章时把 frontmatter 连 order 物理抹掉：
 *
 * 1. `acceptChapterCandidate`（standalone，shell direct 车道）——`candidate.content` = draft 正文
 *    （`buildChapterAccept` 产，无 frontmatter）整体覆盖 `sections[0].content_file`；
 * 2. `applyFieldPatches` chapter_candidate 分支（PatchReview 人审 accept 车道）——同上；
 * 3. ~~`chapter_write` handler 的 auto_revise splice / targeted-revision 落盘~~（body-only 正文；
 *    该路径已随链流程重排退役——09-13 W1a 环内收敛，规则保留防未来 body-only 覆写路径回归）。
 *
 * 抹掉的后果：混合态（部分章文件带 order、部分被抹）触发派生排序全局开关
 * `hasExplicitOrder` → 被抹章垫底 MAX_SAFE_INTEGER → sort_order 错位 → episode↔chapter
 * 映射断裂（后续 accept 写错章，CR-4.1-06 族）。修法 = 覆写前读旧文件：**旧文件有
 * frontmatter 且新内容自身无 frontmatter 时，原样回拼旧块**（逐字节保序含 CRLF/BOM）。
 *
 * 规则三态（全部显式）：
 * - 旧文件无 frontmatter（历史 body-only 章 / 新建）→ 新内容原样（零行为变化——
 *   既有全部测试夹具都是 body-only，本规则对它们是 no-op）；
 * - 新内容自带 frontmatter（#107 全形态候选 / chapter_write 全形态写入）→ 原样（不双拼）；
 * - 旧有新无 → 旧块回拼在前。捕获块 = 开 `---` 行至闭 `---` 行的**单个尾换行**（mirror ui
 *   `splitFrontmatter` 同一形状——其后空行属 body 不属块）；块收 EOF 无换行时补一个行分隔
 *   （mirror ui `restoreFrontmatter` 的同一规范化），空 body 原样返回。
 *
 * 与 R3.4 编辑器回拼红线同 invariant（「保存即丢 order」不得发生），这里是链侧/accept 侧
 * 的对偶补全。范式判据（ADR-3）：纯机械字符串拼接，非语义。
 */
export function preserveChapterFrontmatter(
  existingContent: string | null | undefined,
  newContent: string,
): string {
  const existingFm = existingContent ? leadingFrontmatterBlock(existingContent) : null;
  if (!existingFm) return newContent;
  if (leadingFrontmatterBlock(newContent)) return newContent;
  // mirror ui frontmatter.ts restoreFrontmatter：空 body 原样返回（不加行分隔）。
  if (newContent === '') return existingFm;
  return existingFm.endsWith('\n') ? existingFm + newContent : `${existingFm}\n${newContent}`;
}

// ── stripChapterFrontmatter：章文件正文剥离（链流程重排 W4 / R6 链外重提取）──

/**
 * 剥掉章文件开头的 frontmatter 块，返回正文（含其后的标题行/空行——按落盘原样，非语义重构）。
 *
 * 重提取（re-extract-chapter）从盘上 `chapters/<id>.md` 读正文喂 E 段：链上 `draft.initial.text` 是纯
 * 正文，frontmatter（order 登记载体）不是正文的一部分——用本函数把盘上文件还原到 E 段消费形态。
 * 无 frontmatter（历史 body-only 章）→ 原样返回（零行为变化）。与 preserveChapterFrontmatter 共用
 * 同一 frontmatter 块形状（CHAPTER_FILE_FRONTMATTER_RE，BOM/CRLF/尾随空白容忍）。
 *
 * CR-12③：**前置剥 BOM**——body-only 文件带 BOM 时 `leadingFrontmatterBlock` 对无块形态返 null，
 * BOM 会原样泄入「正文」（E 段 prompt / 字数 / 提取全带 U+FEFF 字符）。有 frontmatter 块时 BOM 随
 * 块剥（正则已容 BOM），body-only 时此处兜底剥首字符（mirror setting-md-edit bomStripped 同款）。
 *
 * 范式判据（ADR-3）：纯机械字符串剥离，非语义。
 */
export function stripChapterFrontmatter(content: string): string {
  const bomStripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const fm = leadingFrontmatterBlock(bomStripped);
  return fm ? bomStripped.slice(fm.length) : bomStripped;
}

// ── buildAcceptStoryDecisions：accept 登记 StoryDecision 构造单源（#107 R1.1c 提取）──

/**
 * accept 登记 StoryDecision 的输入 route 判定投影（buildChapterAccept 直读 route_decision
 * artifact；#107 补产路径读 summary.routeDecision——summarizeRunSnapshot 已投影 deviation）。
 * 字段 loose typing（unknown）：内部窄化，与提取前 buildChapterAccept 内联比较式逐字一致。
 */
export interface AcceptRouteDecisionLike {
  decision?: unknown;
  reason?: unknown;
  deviation?: unknown;
}

/**
 * route=accept 且正文偏离计划时登记的 decided StoryDecision（**单源构造器**，dogfood R2 #107
 * R1.1c 从 buildChapterAccept :429-457 内联提取）。
 *
 * 两个消费方必须同构（防双形态漂移）：
 * 1. `buildChapterAccept`（正常路径——onAccept 链内同步产 chapter_accept.storyDecisions）。
 * 2. #107 no-chapter 自动建章的入口层补产（agent write-chapter / shell persistChapterAcceptIfNeeded
 *    ——onAccept 已在链内同步调用过不可重入，入口层据 summary.routeDecision（含 deviation 投影）
 *    + 补产的 runId/nowISO 重建）。**不静默降级**（用户拍板）：deviation=true 必登记，与正常路径
 *    落 novel.story_decisions 的记录一字不差。
 *
 * 范式判据（ADR-3）：纯机械构造（读 LLM 判定的 deviation boolean 组装记录），不判「偏离好不好」。
 */
export function buildAcceptStoryDecisions(input: {
  routeDecision: AcceptRouteDecisionLike | undefined;
  episodeId: string;
  runId: string;
  nowISO: string;
}): StoryDecision[] | undefined {
  const route = input.routeDecision;
  if (!route || route.deviation !== true) return undefined;
  const routeReason =
    typeof route.reason === 'string' && route.reason.length > 0
      ? route.reason
      : 'route 判定正文偏离计划，按正文为真相接受';
  // 2.6 CR-Edge-4：source 按 route decision 值设（不再恒 'accept_as_truth'）--escalate_user
  // 路径（用户经裁决器建议后 PatchReview accept）登记 'escalate_accepted'，落盘保留 escalation
  // 上下文（可辨「这条偏离经用户裁决」）。escalate 候选只在用户 accept 时落盘（reject ->
  // 改稿重跑，decision 随候选丢弃不落地），故 build 时标注安全。
  const isEscalate = route.decision === 'escalate_user';
  return [
    {
      id: `accept-${input.runId}`,
      summary: isEscalate
        ? '正文偏离计划，经灰区裁决后接受为真相（escalate_accepted）'
        : '正文偏离计划，按正文为真相接受（accept_as_truth）',
      reason: routeReason,
      alternatives: [],
      risk: '后续章节的计划 / 状态须据此偏离校正（正文 = 真相，计划追正文）',
      status: 'decided',
      source: isEscalate ? 'escalate_accepted' : 'accept_as_truth',
      landingState: `已体现在 episode ${input.episodeId} 正文`,
      relatedEpisodeId: input.episodeId,
      createdAt: input.nowISO,
    },
  ];
}

// ── resolveEpisodeIdForChapter：chapterId → episodeId（正向链取反，Story 8.7 BMad CR-001）──

/**
 * 解析 chapterId 对应的 episode id（`resolveChapterIdForEpisode` 的反向）。
 *
 * 映射链取反转置：chapter.id → sort_order → `episode_outlines.filter(index===sort_order)` 唯一命中 →
 * id；再经正向 `resolveChapterIdForEpisode` 回代校验（**正反一致性**——双章共 sort_order 时正向本就
 * undefined，反向同判 undefined，两侧不会「一个能解析一个不能」）。任一步缺失/歧义（章不存在 /
 * sort_order 缺 / 多 episode 同 index / 正向回代不符）→ undefined（调用方 best-effort 跳过，不猜）。
 *
 * 使用方（shell mentionLedgerDegrade，Story 8.7 BMad CR-001 方案 A）：章正文落盘点（chapter_write
 * 工具 / write_file / 编辑器写盘 IPC）的 mention 账降档 hook——落盘点只知 chapterId（文件 stem）不知
 * episode，经本函数单源取反（与 chapterHandlers chapter_list 增强共用同一 canonical 链，防两处漂移）。
 *
 * 范式判据（ADR-3）：纯结构查询（数值相等 + ref 相等），非语义。
 */
export function resolveEpisodeIdForChapter(
  episodeOutlines: ReadonlyArray<ResolvableEpisode> | undefined,
  novelChapters: ReadonlyArray<ResolvableChapter> | undefined,
  chapterId: string,
): string | undefined {
  if (!episodeOutlines || !novelChapters) return undefined;
  const chapter = novelChapters.find((ch) => ch.id === chapterId);
  if (!chapter || typeof chapter.sort_order !== 'number') return undefined;
  // sort_order → episode（index 唯一命中；0/>1 均歧义 → undefined，mirror 正向 CR-4.1-06 防御）。
  const candidates = episodeOutlines.filter((ep) => ep.index === chapter.sort_order);
  if (candidates.length !== 1) return undefined;
  // 正向回代校验：sort_order 双章时正向解析 undefined/他章，反向不得单侧放行（镜像错位防线）。
  return resolveChapterIdForEpisode(episodeOutlines, novelChapters, candidates[0].id) === chapterId
    ? candidates[0].id
    : undefined;
}

// ── buildChapterAccept：链段 accept 分支产 chapter_accept artifact（不写盘）──

/**
 * buildChapterAccept 接受的 RunSnapshot 结构子集（agent RunSnapshot 满足；结构 typing 避免跨包 import）。
 *
 * artifacts 含 'draft.initial'（candidate 源）+ 'route_decision'（deviation 判定源）。Record<string, unknown>
 * → run.artifacts 直传，buildChapterAccept 防御性 narrow（mirror chainRunner.recordOf）。
 */
export interface ChapterAcceptSnapshot {
  runId: string;
  artifacts: Record<string, unknown>;
}

/** chapter_accept artifact（链段产出，入口层消费做持久化）。 */
export interface ChapterAcceptArtifact {
  /** 目标 chapter id（resolveChapterIdForEpisode 解析；链段不写盘，入口层按此 id 持久化）。 */
  chapterId: string;
  /** draft 产出 → chapter markdown + 元数据更新候选。 */
  candidate: ChapterCandidate;
  /** accept 登记的 StoryDecision（route 判正文偏离计划时，decided decision；无偏离 → 缺省）。 */
  storyDecisions?: StoryDecision[];
  /** 链段 runId（acceptChapterCandidate 按 runId 记 last_run_id）。 */
  runId: string;
}

/**
 * 审核归因三态（Story 8.4 Step 6 / A11，design §1.9）：Reader-Audit 消费写手调查简报（写作执行案）
 * 后，对「正文 vs 计划」类 finding 标注问题出在哪一层：
 * - `execution_gap`：执行案里安排了、正文没写出来（写手执行漏了，改本章正文可修）。
 * - `planning_blind`：执行案里就没安排（写手调查时漏了，需补调查补写）。
 * - `plan_level`：大纲/任务卡层就没安排（上游计划的缺口，非本章写手的执行问题，本章改稿修不了）。
 *
 * 值单源：agent reviewOutputSchema findings 的 attribution zod enum + chainRunner
 * extractEscalateFindings 机械透传均引本 const（三处同步纪律——枚举字面量不重复手写）。
 */
export const REVIEW_ATTRIBUTION_VALUES = ['execution_gap', 'planning_blind', 'plan_level'] as const;
export type ReviewAttribution = (typeof REVIEW_ATTRIBUTION_VALUES)[number];

/**
 * 灰区审核 finding（Story 4.6）：route=escalate_user 时从 Reader-Audit `review.latest.dimensions[].findings`
 * 抽取，附 RunSnapshotSummary 传给裁决器子 agent + 用户裁决。shape 同 agent reviewOutputSchema findings
 * （chapter-nodes.ts），但落 shared-contracts 供跨包（agent run.ts RunSnapshotSummary + ipc.ts
 * RunChapterChainSummary 两处平行 type 同步）。
 *
 * severity 只 'block'|'warn'（extractEscalateFindings drop info 噪声——info 非灰区不需裁决器/用户关注；
 * CR-Edge-7：type 反映抽取保证，非源 reviewOutputSchema 的 block|warn|info 全集）。quote/location/explanation
 * 必填（grounding 硬要求，R3 §1.2 ConStory-Checker evidence-grounded）。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：本 type 只承载 finding 数据（机械投影），不判「finding 多严重」
 * （归裁决器 LLM）。抽取（chainRunner summarizeRunSnapshot 过滤 block+warn）= 纯代码机械。
 */
export interface EscalateFinding {
  subClass?: string;
  severity: 'block' | 'warn';
  quote: string;
  location: string;
  explanation: string;
  /**
   * Story 8.4 Step 6（A11 审核对照归因）：三态见 REVIEW_ATTRIBUTION_VALUES。optional——无调查简报
   * （旧章/直写/自查降级路径）或与计划无关的 finding 不带。机械透传字段（归因判定产自 Reader-Audit
   * L2 语义，抽取只投影不判）。
   */
  attribution?: ReviewAttribution;
}

/**
 * buildChapterAccept 跳过（不产 chapter_accept）的原因（CR-4.1-08 区分失败模式）。
 *
 * 旧 buildChapterAccept 三种失败（无 draft 正文 / 章映射失败 / nowISO 缺）都返纯 `undefined`，入口层
 * 统一报「章未注册」——no-draft / no-nowiso 时该文案误导（draft-writer 没写正文 ≠ 章未注册）。
 * CR-4.1-08：返区分式 `{skipReason}`，入口层据 skipReason 出对应文案。
 */
export type ChapterAcceptSkipReason = 'no-draft' | 'no-chapter' | 'no-nowiso';

/** buildChapterAccept 跳过结果（区分失败模式，CR-4.1-08；不再返纯 undefined）。 */
export interface ChapterAcceptSkip {
  skipReason: ChapterAcceptSkipReason;
}

/** buildChapterAccept 返回：成功（ChapterAcceptArtifact，含 chapterId）或 跳过（ChapterAcceptSkip）。 */
export type ChapterAcceptResult = ChapterAcceptArtifact | ChapterAcceptSkip;

/** 安全取 record（过滤非对象/数组），mirror chainRunner.recordOf。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 链段 accept 分支（onAccept 回调）从 RunSnapshot + project 上下文产 chapter_accept artifact（design §3.5 /
 * §3.3）。**不写盘**（纯函数；持久化在入口层 IPC/leader）。
 *
 * 逻辑：
 * 1. nowISO 缺（CR-4.1-09）→ `{skipReason:'no-nowiso'}`（不产 invalid createdAt 违 `z.string().min(1)`；
 *    跳过 StoryDecision 登记）。
 * 2. 读 draft.initial {title, text, wordCount} → ChapterCandidate（title→title / text→content / wordCount→wordCount）。
 *    draft 缺 / 无 text → `{skipReason:'no-draft'}`（无产出可持久化）。
 * 3. 读 route_decision.deviation（LLM 判正文是否偏离计划）→ deviation=true 时建一条 decided StoryDecision
 *    （source:'accept_as_truth', relatedEpisodeId=episodeId, createdAt=nowISO）；无偏离 → 不建（story_decisions 缺省）。
 * 4. resolveChapterIdForEpisode 解析 chapterId（directChapterId 优先 → episode.index → sort_order 唯一命中）。
 *    映射失败 / 歧义 → `{skipReason:'no-chapter'}`（accept 阻断持久化，入口层返明确报错，非静默写错位置）。
 * 5. 返 ChapterAcceptArtifact `{chapterId, candidate, storyDecisions?, runId}`。
 *
 * CR-4.1-08：失败模式返 `{skipReason}` 区分式（非旧纯 undefined 合并误导）——入口层据 skipReason 出对应文案
 * （describeAcceptSkip）。CR-4.1-09：nowISO 缺前置 skip，与 CR-4.1-08 区分式协同。
 *
 * 范式判据：candidate 组装 + chapterId 映射 = 纯代码（机械）；deviation 判定 = LLM route（route_decision.deviation
 * 字段，route-agent.yaml 输出）；本处只机械读 boolean 决定是否登记 + 组装。不判「偏离好不好」（归 LLM route）。
 *
 * @param snapshot  链段 RunSnapshot（读 draft.initial + route_decision）
 * @param ctx.nowISO          ISO 时间戳（入口注入，StoryDecision.createdAt 用；缺 → no-nowiso skip）
 * @param ctx.episodeId       本章 episode id
 * @param ctx.episodeOutlines project.episode_outlines（chapterId 映射源）
 * @param ctx.novelChapters   project.novel.chapters（chapterId 映射目标）
 * @param ctx.directChapterId 用户直传 chapterId（优先）
 * @returns          ChapterAcceptArtifact（成功）或 ChapterAcceptSkip（skipReason 区分失败模式）
 */
export function buildChapterAccept(
  snapshot: ChapterAcceptSnapshot,
  ctx: {
    nowISO: string;
    episodeId: string;
    episodeOutlines?: ReadonlyArray<ResolvableEpisode>;
    novelChapters?: ReadonlyArray<ResolvableChapter>;
    directChapterId?: string;
  },
): ChapterAcceptResult {
  // CR-4.1-09：nowISO 缺 → no-nowiso skip（不产 invalid createdAt 违 z.string().min(1)；StoryDecision 不登记）。
  // 与 CR-4.1-08 区分式协同：跳过返 {skipReason}，入口层出对应文案（非旧纯 undefined 合并误导）。
  if (!ctx.nowISO) return { skipReason: 'no-nowiso' };

  // 1. draft.initial → candidate
  const draft = recordOf(snapshot.artifacts['draft.initial']);
  const text = typeof draft?.text === 'string' ? draft.text : undefined;
  if (!draft || !text) return { skipReason: 'no-draft' }; // 无正文产出，无可持久化
  const candidate: ChapterCandidate = { content: text };
  if (typeof draft.title === 'string') candidate.title = draft.title;
  if (typeof draft.wordCount === 'number') candidate.wordCount = draft.wordCount;

  // 2. route_decision.deviation → decided StoryDecision（#107 R1.1c 提取为 buildAcceptStoryDecisions
  //    单源——正常路径与 no-chapter 自动建章补产路径同构，防双形态漂移）。
  const route = recordOf(snapshot.artifacts['route_decision']);
  const storyDecisions = buildAcceptStoryDecisions({
    routeDecision: route,
    episodeId: ctx.episodeId,
    runId: snapshot.runId,
    nowISO: ctx.nowISO,
  });

  // 3. chapterId 解析（directChapterId 优先 → episode.index → sort_order 唯一命中）
  const chapterId = resolveChapterIdForEpisode(
    ctx.episodeOutlines,
    ctx.novelChapters,
    ctx.episodeId,
    ctx.directChapterId,
  );
  if (!chapterId) return { skipReason: 'no-chapter' }; // 映射失败/歧义 → accept 阻断持久化（入口层返明确报错）

  // 4. 返 chapter_accept artifact
  const artifact: ChapterAcceptArtifact = {
    chapterId,
    candidate,
    runId: snapshot.runId,
  };
  if (storyDecisions && storyDecisions.length > 0) artifact.storyDecisions = storyDecisions;
  return artifact;
}

/**
 * accept skipReason → 入口层文案（CR-4.1-08：区分 no-draft/no-chapter/no-nowiso 失败模式，非旧统一「章未注册」误导）。
 *
 * 范式判据（ADR-3 / creative-vs-mechanical）：纯机械文案映射（skipReason enum → 固定描述），非语义判断。
 * 落点 shared-contracts：write-chapter tool（agent）+ closureChainIpc（shell）两入口共用（DRY）。
 */
export function describeAcceptSkip(reason: ChapterAcceptSkipReason): string {
  switch (reason) {
    case 'no-draft':
      return 'draft 产出为空（draft-writer 未生成正文），无法持久化';
    case 'no-nowiso':
      return '时间戳缺失（nowISO 未注入），无法登记 StoryDecision';
    case 'no-chapter':
      // dogfood R2 #107 / R1.4：修后 no-chapter 会先走链侧自动建章（design §1.1 判定过 → 建
      // chapters/<stem>.md + 补产候选）；本文案仍在场 = 自动建未发生（多章同 sort_order 歧义 /
      // R1.1d 落位守卫未过 / 显式指定 chapterId / 建文件通道失败），文案如实指路手建。
      return '章未在 project.yaml 注册或映射歧义，且不满足链侧自动建章条件（多章同 sort_order / 落位守卫未过 / 显式指定了 chapterId）——请先在工作台建章（章节列表空态「新建第一章」或 chapters/ 目录新建 .md 文件）';
  }
}
