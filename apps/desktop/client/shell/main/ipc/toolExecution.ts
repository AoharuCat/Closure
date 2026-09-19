/**
 * Tool Execution Layer — unified entry point for all tool calls from the Agent.
 *
 * In dev mode: exposed as POST /tool/execute on the HTTP gateway.
 * In prod mode: invoked via WebSocket reverse channel.
 */
import { assertSafePath } from './pathGuard';
import { getLogger } from '../logger';

// Handlers
import { readFileHandler, writeFileHandler, listFilesHandler, searchHandler } from './toolHandlers/fileHandlers';
import { chapterListHandler, chapterReadHandler, chapterWriteHandler, rewritePassageHandler } from './toolHandlers/chapterHandlers';
import { outlineReadHandler, outlineUpdateHandler } from './toolHandlers/outlineHandlers';
import { sceneGraphReadHandler, sceneGraphUpdateHandler } from './toolHandlers/sceneGraphHandlers';
import { overviewUpdateHandler } from './toolHandlers/overviewHandlers';
import { genreContractUpdateHandler } from './toolHandlers/genreContractHandlers';
import { generateImageHandler, editImageHandler } from './toolHandlers/imageHandlers';
import { gitStatusHandler, gitLogHandler, gitCommitHandler, gitDiffHandler } from './toolHandlers/gitHandlers';
import { projectMetaHandler, memoryQueryHandler, memoryUpdateHandler, skillHandler, listStaleFieldsHandler, dismissStaleFieldsHandler } from './toolHandlers/projectHandlers';
import { queryStoryHandler, queryRelationsHandler } from './toolHandlers/closureHandlers';
import { queryCraftHandler } from './toolHandlers/closureCraftHandlers';
import {
  catalogEntriesHandler,
  getEntryHandler,
  queryMentionsHandler,
} from './toolHandlers/catalogHandlers';
import {
  degradeEpisodeMentionsHandler,
  recordEpisodeMentionsHandler,
} from './toolHandlers/mentionLedgerHandlers';
import {
  infoReleaseMapReadHandler,
  infoReleaseMapUpdateHandler,
} from './toolHandlers/infoReleaseHandlers';
import {
  emotionCurveReadHandler,
  emotionCurveUpdateHandler,
} from './toolHandlers/emotionCurveHandlers';
import {
  promiseLedgerUpdateHandler,
  queryPromiseHandler,
} from './toolHandlers/promiseLedgerHandlers';
import {
  arcLedgerUpdateHandler,
  queryArcHandler,
  queryArcSummaryHandler,
  recordArcAuditHandler,
} from './toolHandlers/arcLedgerHandlers';
import {
  amendWorldStateHandler,
  buildWorldSnapshotHandler,
  findWorldRefsHandler,
  materializeChapterSummaryHandler,
  queryChapterSummaryHandler,
  queryCognitionGraphHandler,
  queryCognitionHandler,
  queryWorldSliceHandler,
  queryWorldStateHandler,
  writeWorldEventsHandler,
} from './toolHandlers/worldStateHandlers';
import {
  feedbackLedgerReadHandler,
  feedbackLedgerWriteHandler,
} from './toolHandlers/feedbackLedgerHandlers';
import { wikiReadHandler, wikiSearchHandler } from './toolHandlers/wikiHandlers';
import { webSearchHandler } from './toolHandlers/searchHandlers';
import { renderPageHandler, webFetchHandler } from './toolHandlers/fetchHandlers';
import { parseDocumentHandler } from './toolHandlers/parseDocumentHandlers';
import { analyzeImageHandler } from './toolHandlers/analyzeImageHandlers';
import { saveCraftDocHandler } from './toolHandlers/craftCurationHandlers';
import { assetCardsUpdateHandler } from './toolHandlers/assetCardsHandlers';
import { settingMdUpdateHandler } from './toolHandlers/settingMdHandlers';
import { requestStyleInputHandler } from './toolHandlers/styleInputHandlers';
import { storySyncApplyHandler } from './toolHandlers/storySyncHandlers';
import { storyDecisionsUpdateHandler } from './toolHandlers/storyDecisionHandlers';
import {
  growthCurveUpdateHandler,
  pacingCurveUpdateHandler,
} from './toolHandlers/curveHandlers';
import { episodeOutlinesUpdateHandler } from './toolHandlers/episodeOutlinesHandlers';
import { creativeBriefUpdateHandler } from './toolHandlers/creativeBriefHandlers';
import { creativePreferencesUpdateHandler } from './toolHandlers/creativePreferencesHandlers';
import { authorProfileUpdateHandler } from './toolHandlers/authorProfileHandlers';

export type { ToolExecuteResponse, ToolHandlerContext, ToolHandler } from './toolHandlers/types';
import type { ToolHandler, ToolExecuteResponse } from './toolHandlers/types';

const logger = getLogger();

// ─── Types ───

export interface ToolExecuteRequest {
  toolId: string;
  params: Record<string, unknown>;
  projectDir: string;
  sessionId: string;
  abort: AbortSignal;
  requestId?: string;
}

// ─── Registry ───

const handlers = new Map<string, ToolHandler>();

function register(toolId: string, handler: ToolHandler) {
  handlers.set(toolId, handler);
}

// File operations
register('read_file', readFileHandler);
register('write_file', writeFileHandler);
register('list_files', listFilesHandler);
register('search', searchHandler);

// Chapter
register('chapter_list', chapterListHandler);
register('chapter_read', chapterReadHandler);
register('chapter_write', chapterWriteHandler);
register('rewrite_passage', rewritePassageHandler);

// Outline
register('outline_read', outlineReadHandler);
register('outline_update', outlineUpdateHandler);

// Scene-graph (Story 1.3: multi-line narrative structure)
register('scene_graph_read', sceneGraphReadHandler);
register('scene_graph_update', sceneGraphUpdateHandler);

// Overview
register('overview_update', overviewUpdateHandler);

// Story 2.5 GenreContract 创建期「定承诺」
register('genre_contract_update', genreContractUpdateHandler);
// Story 2.6：创作决策 ADR 登记（register/supersede/drop）。缺省产 field_patch envelope 人审；
// autoApply=true 直落 novel.story_decisions（applyFieldPatches story_decisions 分支单写路径）。
register('story_decisions_update', storyDecisionsUpdateHandler);

// Image
register('generate_image', generateImageHandler);
register('edit_image', editImageHandler);

// Git
register('git_status', gitStatusHandler);
register('git_log', gitLogHandler);
register('git_commit', gitCommitHandler);
register('git_diff', gitDiffHandler);

// Project / Memory / Skill
register('project_meta', projectMetaHandler);
register('memory_query', memoryQueryHandler);
register('memory_update', memoryUpdateHandler);
register('skill', skillHandler);

// Story 3.4（R1/C-A2）：涟漪消费端 leader tool——读 field_metadata.stale 候选集。
register('list_stale_fields', listStaleFieldsHandler);

// Story 3.4 Phase 4.2：涟漪消费端 leader tool——clearStale dismiss 通路。
// 作者 dismiss 涟漪报告时 leader 调此工具清对应字段 stale 标记（落盘 stale:false）。
// mirror list_stale_fields 注册模式（unified toolExecution channel）。
register('dismiss_stale_fields', dismissStaleFieldsHandler);

// Closure KB - hybrid retrieval (ADR-3 / VS1 R5). Reuses the unified channel;
// no dedicated IPC/preload surface (see closureHandlers.ts header comment).
register('query_story', queryStoryHandler);

// Story 6.4 D2：relation 图遍历召回臂（mirror query_story，通用工具）。图遍历召回结构关联条目
// （补 query_story 语义盲区）。unified toolExecution channel, no dedicated IPC/preload（mirror query_story）。
register('query_relations', queryRelationsHandler);

// Craft KB - global craft reference library hybrid retrieval (ADR-3 / Story 2.1).
// Mirrors query_story: unified toolExecution channel, no dedicated IPC/preload.
// Global scope - the handler does NOT resolve a projectId from projectDir.
register('query_craft', queryCraftHandler);

// Story 8.7 S6（R3/R1，design §4.1）：扫描层统一目录 + 出场账三只读工具（mirror query_story
// 经 unified toolExecution channel；projectId 从 projectDir 解析 5 位 registry id）。
// - catalog_entries：实体目录薄行分页（先过滤后翻页 + 显式 total 绝不静默截断 + mention 聚合）。
// - get_entry：单条目下钻全文（三级变焦的全文级；catalogHandlers）。
// - query_mentions：出场账双向查询（ledger / gap_stats 间隔统计视图——buildAppearanceGapStats
//   单源纯函数，handler 取数组装）。全 read 工具（classifyTool 默认 read，零 toolPolicy 登记——
//   mirror query_world_state 读工具零登记先例；无 envelope 无 B01 面）。读路径零持久化副作用。
register('catalog_entries', catalogEntriesHandler);
register('get_entry', getEntryHandler);
register('query_mentions', queryMentionsHandler);

// Story 6.6 world-state derived index (ADR-14 / ADR-3). Mirrors query_story via
// the unified toolExecution channel. projectId derived from projectDir in each
// handler (5-digit registry id). Read tools (query_*/find_*) + write tools
// (write_world_events=derived / amend_world_state=amendment).
register('query_world_state', queryWorldStateHandler);
register('query_world_slice', queryWorldSliceHandler);
register('find_world_refs', findWorldRefsHandler);
register('write_world_events', writeWorldEventsHandler);
register('amend_world_state', amendWorldStateHandler);

// Story 6.1 CognitionGraph query (ADR-3 / ADR-14 / conclusions §3.6). Per-character
// `knows_at_time_t` derived view — consumes 6.6 cognitive-axis patches via
// listWorldPatches + getCognitionAtTime/compileCognitionForScene (NO new closure_*
// table; reduce reused, not rewritten). Mirror query_world_* via unified channel.
register('query_cognition', queryCognitionHandler);
register('query_cognition_graph', queryCognitionGraphHandler);

// Story 8.1 checkpoint-backed snapshot + ChapterStateSummary（design §2/§3，百万字长程有界化）。
// build_world_snapshot：state 投影 checkpoint-backed（brief #6 ats 批量 / Reader-Audit at 单点）
// + cognition/presence shell 侧投影（免全集 IPC）；query_chapter_summary：读物化摘要（收窄 + cap 50）；
// materialize_chapter_summary：物化一章六字段摘要 + 机会式 checkpoint（链上 chapter-summary-node 触发，
// Step 4）。Mirror query_world_* via unified toolExecution channel（无专用 IPC/preload 面）。
register('build_world_snapshot', buildWorldSnapshotHandler);
register('query_chapter_summary', queryChapterSummaryHandler);
register('materialize_chapter_summary', materializeChapterSummaryHandler);

// Story 8.7 S8（design §2.2/§2.3）：mention 共现账链内写工具（mirror materialize_chapter_summary 定位
// ——链段节点经 registry 直调触发，非 LLM 主动调用面；projectId 从 projectDir 解析）。
// - record_episode_mentions：mention-ledger-node 每章调用——四通道汇账（申报/在场/粗筛/计划）+
//   synopsis 回填（组装核心 db/mentionLedgerMaterialize）。
// - degrade_episode_mentions：链内 targeted-revision 落盘后降档（保守档 + synopsis 标 stale，幂等）。
register('record_episode_mentions', recordEpisodeMentionsHandler);
register('degrade_episode_mentions', degradeEpisodeMentionsHandler);

// Story 6.1 InfoReleaseMap (ADR-3 / ADR-14 / conclusions §3.1). Author-intent
// target-track creative field (per-scene reveal/withhold/dramaticIrony plan).
// Mirror scene_graph_read / scene_graph_update: read returns curated field;
// update is a BOUNDED action enum projected via applyInfoReleaseActions →
// field_patch envelope (action:'set') for UI patch-review → fieldSyncBridge.
register('info_release_map_read', infoReleaseMapReadHandler);
register('info_release_map_update', infoReleaseMapUpdateHandler);

// Story 5.2 EmotionCurve (ADR-3 / conclusions §3.1 目标轨). Creative field
// (project.yaml emotion_curve) target-track emotion arc, Director per-scene 前向产生.
// Mirror info_release_map_*: read returns points (filterable by sceneId), update is a
// BOUNDED action enum (add_point/update_point/remove_point) projected via applyEmotionCurveActions
// → autoApply dual-mode (Director auto-author direct persist / field_patch envelope for UI patch-review).
register('emotion_curve_read', emotionCurveReadHandler);
register('emotion_curve_update', emotionCurveUpdateHandler);

// Story 6.5 Promise ledger (ADR-3 / ADR-14 / design §5 方案 C). Creative field
// (project.yaml promise_registry) spanning both tracks (debt + planned beats
// target-track / factual beats actual-track). Mirror info_release_map_*: read
// returns curated field (optional sceneId/episodeId filter on beats); update is
// a BOUNDED action enum (add_promise/add_beat/update_beat/remove_promise/
// remove_beat) projected via applyPromiseActions → field_patch envelope
// (action:'set') for UI patch-review → fieldSyncBridge. Emergence registration
// (promise-emergence-node) + Reader-Audit landing check wire up in Phase D.
register('query_promise', queryPromiseHandler);
register('promise_ledger_update', promiseLedgerUpdateHandler);

// Story 8.2 arc ledger（长程连贯 audit，design §2/§5）。arc_registry creative field（写手 LLM 写时
// 声明的弧节拍 advance/close，mirror promise_registry 归属——非 closure_* 派生表）+ closure_arc_summary
// DERIVED 弧审快照。Mirror promise_ledger_update：query_arc 读 beats（episodeId/arcRef 收窄 + 最近窗
// cap 200）；arc_ledger_update bounded action（add_beat，同 episodeId+arcRef+action 幂等覆盖）经
// applyArcLedgerActions 投影 → autoApply 双档（emergence 直落 / field_patch envelope 人审）；
// query_arc_summary 读物化弧审（每弧最新，project registry id 解析 mirror query_chapter_summary）。
// agent 侧 builtin（remoteToolProxy 三件）+ toolPolicy / agentDiffSlice WRITE_TOOLS 登记归 Step 3
// （B01 三处同步 checklist——本文件是第 1 处）。
register('query_arc', queryArcHandler);
register('arc_ledger_update', arcLedgerUpdateHandler);
register('query_arc_summary', queryArcSummaryHandler);
// record_arc_audit：arc-audit-agent 产物（ArcAuditResult）upsert closure_arc_summary DERIVED 表（关口
// 大审/停滞专注审收尾，write_chapter post-settle 程序化调用非 LLM 直接调——autoApply 语义，无人审：
// DERIVED 快照可 drop 重跑重建，mirror materialize_chapter_summary 链内写工具定位，不进 toolPolicy 门）。
register('record_arc_audit', recordArcAuditHandler);

// Story 7.4 cross-chapter feedback ledger (ADR-3 / design §2.2). Independent
// persistence layer (NOT project.yaml) relaying chain artifacts across chapter
// boundaries: feedback-ledger-node writes review.latest/emotion_verify_result/
// completeness_verify_result at chain tail; write_chapter chain-start reads the
// previous chapter's entries to fill Director feedback vars. Mirror query_world_*
// via unified toolExecution channel. projectId derived from projectDir (5-digit
// registry id). Enhancement layer — write/read failures never break the chain
// (mirror 6.6 world-state enhancement philosophy).
register('feedback_ledger_write', feedbackLedgerWriteHandler);
register('feedback_ledger_read', feedbackLedgerReadHandler);

// Story 3.6 WP3（R1 / design D8）：wiki 研究 read 工具——站点注册表（moegirl-cn 官方
// opensearch 前缀 + moegirl-uk 镜像 list=search 全文）双站搜索合并去重 + wikitext 读取
// （官方 rest.php 优先 → 镜像 api.php parse 降级 + 轻清洗 + 16K cap + provenance/license）。
// Mirror query_craft via unified toolExecution channel（无专用 IPC/preload 面）；网络全在
// shell 侧（netFetch 吃系统代理 + EngineGate per-host 节流），agent 侧纯 remoteToolProxy。
register('wiki_search', wikiSearchHandler);
register('wiki_read', wikiReadHandler);

// Story 3.6 WP4（R2 / design D9）：web_search 引擎链——零 key 默认链（localhost SearXNG
// 启动探测命中时插队 → cn.bing.com HTML → 百度 HTML（BAIDUID 引导加固）→ DDG html POST）
// 自动回退 + 可配升级层（SearXNG URLs / Tavily / 博查 / AnySearch，engineOrder 排序）。
// HTML adapter 选择器移植 openserp / SearXNG / ddgs 蓝本（调研 anysearch-and-serp-libs-survey）。
// 链执行器（searchChain）逐引擎 EngineGate 节流 + TTL 缓存 + 首命中返回 + 全败 graceful 汇总。
// Mirror wiki_* via unified toolExecution channel（无专用 IPC/preload 面）；classifyTool 默认
// 'read'（纯查询）。never-throws（R8）。
register('web_search', webSearchHandler);

// Story 3.6 WP5（R3/R12 / design D10）：web_fetch + render_page 研究 read 工具。
// web_fetch：SSRF 守卫（netGuard assertPublicHttpUrl，file://+私网/环回拦，allowlist=
// 已配 SearXNG + docParser 端点 hosts）→ netFetch → content-type
// dispatch（HTML→turndown MD 去脚本/样式/导航 / 文本·Markdown·JSON·XML 原文 / PDF→提示
// parse_document / 图片→提示 analyze_image / 其他→不支持提示）+ maxChars cap + 来源/检索
// 日期；重定向后 response.url 逐跳复验守卫（netGuard caller-duty 契约）。never-throws。
// render_page：隐藏 sandbox BrowserWindow 渲染态捕获（research/renderCapture.ts）——
// textContent 全文（折叠块 display:none 内容也全拿，D10 调研定论）+ 分段滚动截图
// （存 <project>/.orison/research-media/，>50 自动清最旧）；锁导航/禁下载/权限全拒。
// 视觉分析由 leader 组合 analyze_image（工具正交）。Mirror wiki_* via unified
// toolExecution channel（无专用 IPC/preload 面）；classifyTool 默认 'read'（纯查询）。
register('web_fetch', webFetchHandler);
register('render_page', renderPageHandler);

// Story 3.6 WP6（R10 / design D11）：parse_document 研究 read 工具——本地文档解析
// （PDF/DOCX/TXT/MD → Markdown）。端点优先：docParser sidecar（research/docParserConfig.ts，
// `doc-parser.yaml`）已配且 /health 探活 ok 时，PDF 先走薄协议双 adapter
// （research/docParserAdapters.ts：mineru /file_parse multipart backend=pipeline 取
// md_content / docling /v1/convert/source 取 document.md.content / custom /parse 简协议）；
// 失败/未配/探活失败降级内置（research/docParsing.ts：pdfjs 文本层 + 扫描件检测 +
// mammoth docx 本地优先 + txt/md 直读），端点失败记 note。扫描件（平均 <50 字符/页）
// 返回视觉路径提示（analyze_image 或配置端点）。filePath 项目内相对路径 +
// assertWithinProject 防任意文件读取（mirror imageHandlers）。EPUB 砍掉
// （implement.md 最后实现可砍）。never-throws（R8）；classifyTool 默认 'read'。
register('parse_document', parseDocumentHandler);

// Story 3.6 WP7（R11 / design D5）：analyze_image 研究 read 工具——单图视觉分析。
// imagePath（项目内相对路径，assertWithinProject 防任意文件读取，mirror parse_document）
// 或 imageUrl（SSRF 守卫 + netFetch 二进制下载 10MB cap + 重定向逐跳复验，mirror web_fetch）
// 二选一 → runVisionAnalysis（WP1 vision seam 三层分派内核）：visionModel 已配 → 直接视觉
// 分析返回文本；未配 → manual 导出协议（图存 <project>/.orison/research-media/ + 复制剪贴板
// + suggestedPrompt——leader 按 DEFAULT_CLOSURE_PROMPT Research 段转告协议原样转给用户手动
// 分析，结果贴回对话续跑；绝不编造图片内容）。declared mimeType 按扩展名/Content-Type，
// 内核魔数嗅探纠正（D3 字节严格匹配）。never-throws（R8）；classifyTool 默认 'read'。
register('analyze_image', analyzeImageHandler);

// Story 3.6 WP9（R5/R6 / design D13）：策展两工具——研究产出双向落地。
// save_craft_doc：leader/researcher 研究后策展入**全局** craft KB（~/.orison/craft-kb/research/
// <slug>.md，frontmatter id/craft_type/tags/source(+source_note)）→ 直接 reindexCraftDoc →
// query_craft 即刻可检回。严格白名单 slug（防 ../ 逃逸）+ 冲突 -2 后缀不覆盖 + never-throws。
// classifyTool='write'（toolPolicy WRITE_TOOLS——全局用户库写入是显式写动作，readonly/suggest
// 不可用，mirror write_file）。全局库无项目内约束（handleToolExecute 的 assertSafePath 校验的是
// projectDir），路径安全在 handler 内（白名单 slug + isSafePath(craft-kb 根) belt 检查）。
register('save_craft_doc', saveCraftDocHandler);

// asset_cards_update：设定卡策展——bounded action（add_card/update_card/remove_card，2.4 的 8 类
// typed 卡 schema）投影到现 asset_cards（保留既有卡）→ field_patch envelope（field:'asset_cards'，
// action:'set'）→ PatchReviewPanel 人审 → fieldSyncBridge 落盘 + assetCardsWatcher reindex →
// query_story 检回（落地公理闭环 AC4）。add 重复 id 友好报错；update 浅合并保 customFields(details)；
// remove 不存在 id 幂等跳过。classifyTool='diff'（toolPolicy DIFF_TOOLS，mirror scene_graph_update）。
register('asset_cards_update', assetCardsUpdateHandler);

// Story 2.2 WP-B（design §3）：setting_md_update——长文设定文档（settings/*.md）bounded span 编辑。
// create_file/replace_span/insert_after/remove_span/update_meta 复用 E7 锚原语（locateSelection/splice，
// shared-contracts passage-splice.ts，零新定位代码）。缺省（suggest 档）不写盘——产专用 setting_md_patch
// envelope（before/after + actions）→ UI 专用词级 diff 卡 → accept 走 closure:accept-setting-md 重放落盘；
// autoApply=true（auto 档 KD1）→ withProjectLock + 落盘 + 直接 reindexSettingMd（entry_id namespace
// ${projectId}:${settingId} 由 indexer 内部解析）。classifyTool='diff'（toolPolicy DIFF_TOOLS）。
register('setting_md_update', settingMdUpdateHandler);

// Story 2.2 WP-E（design §5.5.2）：story_sync_apply——正文→设定反哺 applier（write_chapter route 终态
// 调用，非 leader 日常工具，mirror write_world_events 链内写工具模式）。story-sync patches 经机械门
// （白名单/merge-only/promise_registry 拒/cap 8/版本锁）+ 投影（asset_cards → update_card/add_card bounded
// action 浅合并 + schema 再校验；其他 field → 对象 merge + per-field schema 校验）后双档落盘：
// autoApply=true（auto 档 + accept_as_truth 语义背书）→ withProjectLock + onFieldEdited(source:'agent',
// reason=章节出处) 直落（mirror emotionCurveHandlers autoApply）；缺省 → 产 per-field field_patch envelope
// （FULL 投影数据 action:'set'——PatchReview accept 经 syncField REPLACE 落盘，fragment envelope 会毁数据）
// → write_chapter metadata.storySyncPatches → UI PatchReview 人审。asset_cards 落盘后 assetCardsWatcher
// 自动 reindex（query_story 检回）。classifyTool='diff'（toolPolicy DIFF_TOOLS）。
register('story_sync_apply', storySyncApplyHandler);

// Story 8.5 R1/R2（design §2.1/§3.2）：角色弧生产线 + 集纲挂钩的独立设计轨写工具三件。
// growth_curve_update：bounded action（add_curve/update_curve/remove_curve by character_id 自然键，
// add 已存在 = partial merge 防 defaults 覆盖 B1）投影 full array（D2 array canonical，宽容读旧单条/
// Record 经 growthCurveFieldSchema 归一）→ autoApply 双档（auto=onFieldEdited source:'agent' 直落 /
// 缺省=field_patch envelope 走 PatchReview 人审）。pacing_curve_update：逐字段 mirror
// emotion_curve_update（add/update/remove_point by refId，pacing_curve 顶层维持单条）。
// episode_outlines_update：bounded action（add/update/remove_episode by id，8.5 前该 field 零生产
// 工具——单一写通道两驱动：episode-planner 主产 + leader 直改，mirror scene_graph_update）；
// phase_ref 存在性校验 warn 透传不拒（design §3.1，mirror Line.phase_ref 宽容先例——硬拒会挡
// LLM 先排章后补 phase 的合法顺序）。
// 三工具 classifyTool='diff'（toolPolicy DIFF_TOOLS + UI agentDiffSlice.WRITE_TOOLS 同 commit 登记，
// B01 三处同步 checklist——本文件是第 1 处）。
register('growth_curve_update', growthCurveUpdateHandler);
register('pacing_curve_update', pacingCurveUpdateHandler);
register('episode_outlines_update', episodeOutlinesUpdateHandler);

// Story 8.6（design D2/D3/D6 §3.1）：冷启动引导三写工具。
// creative_brief_update：partial merge bounded 字段级 set（genre/theme/tone/audience/length/
// structure_pattern/rawRequirement/taboos/userConstraints——**不含** genre_tags/commitments/
// world_constitution，那是 genre_contract_update 领地）→ creativeBriefSchema 全量校验 →
// autoApply 双档（auto=onFieldEdited source:'agent' 直落 / 缺省=field_patch envelope 人审；
// locked 拒→降级 envelope 提议不丢）。此前 rawRequirement（真灵感）等字段零 leader 写通道。
// creative_preferences_update：同族——四轴（outline_depth/arc_timing/world_depth/
// character_depth）+ note partial merge → creative_preferences（Step 1 已进 creativeFieldKeys）
// envelope 走既有 generic PatchReview 链零 UI 改动。
// author_profile_update：作者档案（~/.orison/author_profile.md，机器级文件非 creative field）
// append dated entry（永不整文件重写）；autoApply=true 直接追加 / 缺省=专用 author_profile_patch
// envelope（before/after + note）→ UI 专用卡片 → accept 走 author-profile:apply IPC 重新追加。
// 三工具 classifyTool='diff'（toolPolicy DIFF_TOOLS + UI agentDiffSlice.WRITE_TOOLS 登记——
// author_profile 走专用分流不进 WRITE_TOOLS——归 Step 3/5；B01 三处同步 checklist，本文件第 1 处）。
register('creative_brief_update', creativeBriefUpdateHandler);
register('creative_preferences_update', creativePreferencesUpdateHandler);
register('author_profile_update', authorProfileUpdateHandler);

// 风格卡片 MVP（08-28 C 路）：request_style_input——leader 请作者提供文风参考片段。
// 纯 UI 请求（notifyUI 轻事件 → renderer 弹风格片段对话框），读类零写，无 B01 面。
register('request_style_input', requestStyleInputHandler);

// ─── Execution ───

/**
 * Execute a tool by id. This is the single entry point for all tool calls.
 */
export async function handleToolExecute(req: ToolExecuteRequest): Promise<ToolExecuteResponse> {
  const { toolId, params, projectDir, sessionId, abort } = req;

  // Validate project directory is within allowed scope
  assertSafePath(projectDir);

  const handler = handlers.get(toolId);
  if (!handler) {
    throw new Error(`Unknown tool: ${toolId}`);
  }

  logger.info({ toolId, sessionId, projectDir }, 'tool:execute');

  throwIfAborted(abort);
  const result = await handler({ params, projectDir, sessionId, abort });
  throwIfAborted(abort);
  return result;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

/**
 * List all registered tool IDs (for Shell capability reporting).
 */
export function listRegisteredTools(): string[] {
  return [...handlers.keys()];
}
