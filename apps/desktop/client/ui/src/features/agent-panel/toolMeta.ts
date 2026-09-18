/**
 * Human-facing presentation for agent tool calls. Maps the raw tool id (what the
 * runtime emits) to a Material Symbols icon + an i18n key, and derives a short
 * one-line summary of *what* the call did from the tool-result metadata so a
 * collapsed card is legible without expanding it.
 *
 * Pure presentation — no store access, no side effects. Unknown tool ids fall
 * back to the raw id + a generic icon, so a new backend tool never renders blank.
 */

export type ToolPresentation = { icon: string; i18nKey: string };

const TOOL_META: Record<string, ToolPresentation> = {
  read_file: { icon: 'description', i18nKey: 'agent.tool.read_file' },
  write_file: { icon: 'edit_document', i18nKey: 'agent.tool.write_file' },
  list_files: { icon: 'folder_open', i18nKey: 'agent.tool.list_files' },
  search: { icon: 'search', i18nKey: 'agent.tool.search' },
  chapter_list: { icon: 'menu_book', i18nKey: 'agent.tool.chapter_list' },
  chapter_read: { icon: 'auto_stories', i18nKey: 'agent.tool.chapter_read' },
  chapter_write: { icon: 'edit_note', i18nKey: 'agent.tool.chapter_write' },
  write_chapter: { icon: 'edit_note', i18nKey: 'agent.tool.write_chapter' },
  rewrite_passage: { icon: 'format_quote', i18nKey: 'agent.tool.rewrite_passage' },
  // Story 3.5: batch leader tools (BatchGroup progress header + BatchReportCard
  // L1 rows surface these labels; before this they rendered as raw ids).
  start_batch: { icon: 'stacks', i18nKey: 'agent.tool.start_batch' },
  batch_status: { icon: 'monitoring', i18nKey: 'agent.tool.batch_status' },
  end_batch: { icon: 'flag', i18nKey: 'agent.tool.end_batch' },
  set_participation_gear: { icon: 'tune', i18nKey: 'agent.tool.set_participation_gear' },
  outline_read: { icon: 'account_tree', i18nKey: 'agent.tool.outline_read' },
  outline_update: { icon: 'account_tree', i18nKey: 'agent.tool.outline_update' },
  scene_graph_read: { icon: 'hub', i18nKey: 'agent.tool.scene_graph_read' },
  scene_graph_update: { icon: 'hub', i18nKey: 'agent.tool.scene_graph_update' },
  // Story 2.2 WP-B: long-form setting doc bounded span edit (SettingMdPatchCard header).
  setting_md_update: { icon: 'edit_note', i18nKey: 'agent.tool.setting_md_update' },
  // dogfood 2026-08-21：asset_cards_update 卡头此前无映射落裸 tool id（「asset_cards_update ·
  // 星际时代世界设定」）。资产卡 = 人物/金手指卡（Story 3.6 策展）。
  asset_cards_update: { icon: 'style', i18nKey: 'agent.tool.asset_cards_update' },
  // Story 8.6: cold-start guidance tools — creative brief/preferences updates
  // (generic field_patch → PatchReview) + the author-profile note card
  // (AuthorProfilePatchCard header).
  creative_brief_update: { icon: 'edit_note', i18nKey: 'agent.tool.creative_brief_update' },
  creative_preferences_update: { icon: 'tune', i18nKey: 'agent.tool.creative_preferences_update' },
  author_profile_update: { icon: 'history_edu', i18nKey: 'agent.tool.author_profile_update' },
  overview_update: { icon: 'dashboard', i18nKey: 'agent.tool.overview_update' },
  memory_query: { icon: 'psychology', i18nKey: 'agent.tool.memory_query' },
  memory_update: { icon: 'psychology', i18nKey: 'agent.tool.memory_update' },
  generate_image: { icon: 'image', i18nKey: 'agent.tool.generate_image' },
  edit_image: { icon: 'auto_fix_high', i18nKey: 'agent.tool.edit_image' },
  project_meta: { icon: 'info', i18nKey: 'agent.tool.project_meta' },
  git_status: { icon: 'commit', i18nKey: 'agent.tool.git_status' },
  git_commit: { icon: 'commit', i18nKey: 'agent.tool.git_commit' },
  git_log: { icon: 'history', i18nKey: 'agent.tool.git_log' },
  git_diff: { icon: 'difference', i18nKey: 'agent.tool.git_diff' },
  skill: { icon: 'extension', i18nKey: 'agent.tool.skill' },
  spawn_agent: { icon: 'smart_toy', i18nKey: 'agent.tool.spawn_agent' },
  // dogfood #38（2026-08-25）：无映射裸奔 tool id 全集补齐——此前约 50 个 id 落裸 id + build 图标。
  // 分组注释按域；全部走 zh/en 双键（agent.yaml tool 段）。
  // 创作字段写工具（field_patch / autoApply 双档族）：
  genre_contract_update: { icon: 'handshake', i18nKey: 'agent.tool.genre_contract_update' },
  story_decisions_update: { icon: 'fact_check', i18nKey: 'agent.tool.story_decisions_update' },
  growth_curve_update: { icon: 'trending_up', i18nKey: 'agent.tool.growth_curve_update' },
  pacing_curve_update: { icon: 'speed', i18nKey: 'agent.tool.pacing_curve_update' },
  episode_outlines_update: { icon: 'view_agenda', i18nKey: 'agent.tool.episode_outlines_update' },
  info_release_map_read: { icon: 'visibility', i18nKey: 'agent.tool.info_release_map_read' },
  info_release_map_update: { icon: 'visibility', i18nKey: 'agent.tool.info_release_map_update' },
  emotion_curve_read: { icon: 'monitor_heart', i18nKey: 'agent.tool.emotion_curve_read' },
  emotion_curve_update: { icon: 'monitor_heart', i18nKey: 'agent.tool.emotion_curve_update' },
  query_promise: { icon: 'checklist', i18nKey: 'agent.tool.query_promise' },
  promise_ledger_update: { icon: 'checklist', i18nKey: 'agent.tool.promise_ledger_update' },
  query_arc: { icon: 'insights', i18nKey: 'agent.tool.query_arc' },
  arc_ledger_update: { icon: 'insights', i18nKey: 'agent.tool.arc_ledger_update' },
  query_arc_summary: { icon: 'grading', i18nKey: 'agent.tool.query_arc_summary' },
  record_arc_audit: { icon: 'grading', i18nKey: 'agent.tool.record_arc_audit' },
  // 检索 / 查询族：
  query_story: { icon: 'travel_explore', i18nKey: 'agent.tool.query_story' },
  query_relations: { icon: 'share', i18nKey: 'agent.tool.query_relations' },
  query_craft: { icon: 'school', i18nKey: 'agent.tool.query_craft' },
  catalog_entries: { icon: 'list_alt', i18nKey: 'agent.tool.catalog_entries' },
  get_entry: { icon: 'article', i18nKey: 'agent.tool.get_entry' },
  query_mentions: { icon: 'person_search', i18nKey: 'agent.tool.query_mentions' },
  // 世界状态 / 认知族（6.6 / 8.1）：
  query_world_state: { icon: 'public', i18nKey: 'agent.tool.query_world_state' },
  query_world_slice: { icon: 'timeline', i18nKey: 'agent.tool.query_world_slice' },
  find_world_refs: { icon: 'link', i18nKey: 'agent.tool.find_world_refs' },
  write_world_events: { icon: 'edit_calendar', i18nKey: 'agent.tool.write_world_events' },
  amend_world_state: { icon: 'published_with_changes', i18nKey: 'agent.tool.amend_world_state' },
  query_cognition: { icon: 'psychology', i18nKey: 'agent.tool.query_cognition' },
  query_cognition_graph: { icon: 'bubble_chart', i18nKey: 'agent.tool.query_cognition_graph' },
  build_world_snapshot: { icon: 'layers', i18nKey: 'agent.tool.build_world_snapshot' },
  query_chapter_summary: { icon: 'summarize', i18nKey: 'agent.tool.query_chapter_summary' },
  materialize_chapter_summary: { icon: 'post_add', i18nKey: 'agent.tool.materialize_chapter_summary' },
  record_episode_mentions: { icon: 'how_to_reg', i18nKey: 'agent.tool.record_episode_mentions' },
  degrade_episode_mentions: { icon: 'trending_down', i18nKey: 'agent.tool.degrade_episode_mentions' },
  // 反馈 / 设定同步 / 涟漪族：
  feedback_ledger_write: { icon: 'forum', i18nKey: 'agent.tool.feedback_ledger_write' },
  feedback_ledger_read: { icon: 'forum', i18nKey: 'agent.tool.feedback_ledger_read' },
  story_sync_apply: { icon: 'sync_alt', i18nKey: 'agent.tool.story_sync_apply' },
  list_stale_fields: { icon: 'pending_actions', i18nKey: 'agent.tool.list_stale_fields' },
  dismiss_stale_fields: { icon: 'task_alt', i18nKey: 'agent.tool.dismiss_stale_fields' },
  diagnose_impacts: { icon: 'troubleshoot', i18nKey: 'agent.tool.diagnose_impacts' },
  // 研究工具族（3.6）：
  wiki_search: { icon: 'menu_book', i18nKey: 'agent.tool.wiki_search' },
  wiki_read: { icon: 'menu_book', i18nKey: 'agent.tool.wiki_read' },
  web_search: { icon: 'language', i18nKey: 'agent.tool.web_search' },
  web_fetch: { icon: 'cloud_download', i18nKey: 'agent.tool.web_fetch' },
  render_page: { icon: 'web_asset', i18nKey: 'agent.tool.render_page' },
  parse_document: { icon: 'upload_file', i18nKey: 'agent.tool.parse_document' },
  analyze_image: { icon: 'image_search', i18nKey: 'agent.tool.analyze_image' },
  save_craft_doc: { icon: 'bookmarks', i18nKey: 'agent.tool.save_craft_doc' },
  // 派发 / 收尾 / 技能资源族（agent 包 leader tools）：
  dispatch_story_planner: { icon: 'architecture', i18nKey: 'agent.tool.dispatch_story_planner' },
  dispatch_episode_planner: { icon: 'event_note', i18nKey: 'agent.tool.dispatch_episode_planner' },
  dispatch_researcher: { icon: 'manage_search', i18nKey: 'agent.tool.dispatch_researcher' },
  // 风格卡片 MVP（08-28）：派发族 + UI 请求工具。
  dispatch_style_analyzer: { icon: 'palette', i18nKey: 'agent.tool.dispatch_style_analyzer' },
  request_style_input: { icon: 'edit_note', i18nKey: 'agent.tool.request_style_input' },
  present_result: { icon: 'campaign', i18nKey: 'agent.tool.present_result' },
  skill_resource_list: { icon: 'topic', i18nKey: 'agent.tool.skill_resource_list' },
  skill_resource_read: { icon: 'topic', i18nKey: 'agent.tool.skill_resource_read' },
};

const FALLBACK: ToolPresentation = { icon: 'build', i18nKey: '' };

/** Resolve the icon + i18n key for a tool id (falls back gracefully). */
export function toolPresentation(toolId: string): ToolPresentation {
  return TOOL_META[toolId] ?? FALLBACK;
}

/** Friendly tool name: translated label, or the raw id when unmapped. */
export function toolLabel(toolId: string, t: (key: string) => string): string {
  const meta = TOOL_META[toolId];
  if (!meta) return toolId;
  const label = t(meta.i18nKey);
  // `t` returns the key itself when a translation is missing; guard against that.
  return label === meta.i18nKey ? toolId : label;
}

/**
 * dogfood R2 #29：子代理角色名词表（agent_role id → i18n 键）——「Sub Agent」只是指代，
 * 用户要求按**当前代理的具体名称**显示并随 locale 翻译（story-planner-agent → 故事规划师 /
 * Story Planner）。全集 = apps/desktop/agent/prompts/ 的 agent yaml 集；词表外角色
 * （如 skill 标签 story:d1、测试简写 researcher）回落原文 id（mirror toolLabel 词表外
 * 显原文先例）。新角色三处同步：prompts 加 yaml + 此表 + 两 locale agent.role.* 键。
 */
const ROLE_LABELS: Record<string, string> = {
  'story-planner-agent': 'agent.role.story-planner-agent',
  'episode-planner-agent': 'agent.role.episode-planner-agent',
  'researcher-agent': 'agent.role.researcher-agent',
  'style-analyzer-agent': 'agent.role.style-analyzer-agent',
  'draft-writer-agent': 'agent.role.draft-writer-agent',
  'multi-review-agent': 'agent.role.multi-review-agent',
  'revision-guard-agent': 'agent.role.revision-guard-agent',
  'revision-optimizer-agent': 'agent.role.revision-optimizer-agent',
  'adjudicator-agent': 'agent.role.adjudicator-agent',
  'arc-audit-agent': 'agent.role.arc-audit-agent',
  'arc-emergence-agent': 'agent.role.arc-emergence-agent',
  'promise-emergence-agent': 'agent.role.promise-emergence-agent',
  'asset-loader-agent': 'agent.role.asset-loader-agent',
  'chapter-task-agent': 'agent.role.chapter-task-agent',
  'completeness-verify-agent': 'agent.role.completeness-verify-agent',
  'continuity-memory-agent': 'agent.role.continuity-memory-agent',
  'director-agent': 'agent.role.director-agent',
  'event-extractor-cognitive': 'agent.role.event-extractor-cognitive',
  'event-extractor-emotional': 'agent.role.event-extractor-emotional',
  'event-extractor-factional': 'agent.role.event-extractor-factional',
  'event-extractor-physical': 'agent.role.event-extractor-physical',
  'event-extractor-relational': 'agent.role.event-extractor-relational',
  'intake-agent': 'agent.role.intake-agent',
  'retrieval-agent': 'agent.role.retrieval-agent',
  'ripple-diagnosis-agent': 'agent.role.ripple-diagnosis-agent',
  'route-agent': 'agent.role.route-agent',
  'world-amender-agent': 'agent.role.world-amender-agent',
};

/** Friendly agent-role name: translated label, or the raw role id when unmapped. */
export function roleLabel(role: string, t: (key: string) => string): string {
  const key = ROLE_LABELS[role];
  if (!key) return role;
  const label = t(key);
  return label === key ? role : label;
}

type ToolResultMeta = {
  fileName?: string;
  filePath?: string;
  chapterId?: string;
  field?: string;
  query?: string;
  paths?: string[];
  count?: number;
  /** write_chapter toolResult metadata.summary（RunSnapshotSummary，write-chapter.ts:1758 metadata = { summary }）。
   *  CR-002：BatchReportCard L1 行应消费此 summary 的 reviewVerdict/draftWordCount/routeDecision，
   *  而非仅靠 toolSummary 顶层 chapterId（旧 fixture 形态不能代表真实 metadata 结构）。 */
  summary?: unknown;
  /** chapter_accept 路径（write_chapter route=accept / escalate with draft）写 metadata.data.chapterId（CR-002）。 */
  data?: unknown;
} & Record<string, unknown>;

/** CR-002：write_chapter toolResult summary 形态守卫（state-management spec unknown seam）--mirror
 *  RunSnapshotSummary 最小可识别 shape：status 字符串 + errors 数组 + routeDecision 可选 + reviewVerdict 可选。 */
type ChapterRunSummaryLike = {
  reviewVerdict?: string;
  draftWordCount?: number;
  routeDecision?: { decision?: unknown };
};
function isChapterRunSummaryLike(v: unknown): v is ChapterRunSummaryLike {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.status === 'string' && Array.isArray(r.errors);
}

/**
 * A short, human-readable summary of the argument/target of a tool call, drawn
 * from the result metadata the runtime emits. Prefers a concrete target
 * (filename / chapter / field / query) when present, else falls back to a count
 * ("12") which most read/search/list tools provide. Returns undefined when no
 * meaningful detail is available (the card then shows just the tool name).
 *
 * CR-002：write_chapter 优先消费 metadata.summary（RunSnapshotSummary）的 reviewVerdict +
 * draftWordCount + routeDecision + chapterId（来自 metadata.data.chapterId 或 metadata.chapterId），
 * 形如「ch-001 · accept · 2800 字」。无 summary -> 降级到既有 toolSummary 投影（不编造）。
 */
export function toolSummary(result: { toolId?: string; toolName?: string; metadata?: unknown }): string | undefined {
  const meta = (result.metadata && typeof result.metadata === 'object' ? result.metadata : {}) as ToolResultMeta;
  const toolName = result.toolName ?? result.toolId;
  if (toolName === 'write_chapter') {
    // CR-002：先消费 RunSnapshotSummary（write-chapter.ts metadata.summary + metadata.data.chapterId）。
    const summary = isChapterRunSummaryLike(meta.summary) ? meta.summary : undefined;
    if (summary) {
      const dataObj = meta.data && typeof meta.data === 'object' && !Array.isArray(meta.data)
        ? (meta.data as { chapterId?: unknown })
        : undefined;
      const chapterId = typeof dataObj?.chapterId === 'string' ? dataObj.chapterId
        : typeof meta.chapterId === 'string' ? meta.chapterId
        : undefined;
      const verdict = summary.reviewVerdict ?? (typeof summary.routeDecision?.decision === 'string' ? summary.routeDecision.decision : undefined);
      const words = typeof summary.draftWordCount === 'number' ? summary.draftWordCount : undefined;
      const parts: string[] = [];
      if (chapterId) parts.push(chapterId);
      if (verdict) parts.push(verdict);
      if (words !== undefined) parts.push(`${words} 字`);
      if (parts.length > 0) return parts.join(' · ');
    }
    // 无 summary -> 降级到既有 toolSummary 投影（不编造）。
  }
  const basename = (p?: string) => (p ? p.split(/[\\/]/).pop() : undefined);

  // CR-08-16-202：通用 authored string summary 分支——setting_md_update / asset_cards_update(auto) 等
  // handler 产的单行中文摘要（metadata.summary 字符串）此前无消费者（BatchReportCard L1 行只显工具名）。
  // typeof 守卫天然排除 write_chapter 的对象形态 summary（上方分支已消费）。有界（60 字符）防长串刷行。
  const authoredSummary = typeof meta.summary === 'string' && meta.summary.length > 0
    ? (meta.summary.length > 60 ? `${meta.summary.slice(0, 60)}…` : meta.summary)
    : undefined;

  const target =
    authoredSummary ??
    basename(meta.fileName) ??
    basename(meta.filePath) ??
    meta.chapterId ??
    meta.field ??
    (typeof meta.query === 'string' ? `"${meta.query}"` : undefined);

  if (target) return target;
  if (Array.isArray(meta.paths) && meta.paths.length > 0) return basename(meta.paths[0]);
  if (typeof meta.count === 'number') return String(meta.count);
  return undefined;
}

/**
 * Parse a child-execution tag the runtime prepends to nested assistant/tool
 * content, e.g. `[skill:story:d2] ...` or `[subagent:writer] ...`. Returns the
 * stripped content plus the badge parts so the UI can render an indented,
 * labelled child step instead of leaking the raw tag into prose. Returns null
 * when the content carries no such tag.
 */
export function parseChildTag(content: string): {
  source: 'skill' | 'subagent';
  role: string;
  depth: number;
  rest: string;
} | null {
  const m = /^\[(skill|subagent):([^\]:]+)(?::d(\d+))?\]\s*/.exec(content);
  if (!m) return null;
  return {
    source: m[1] as 'skill' | 'subagent',
    role: m[2],
    depth: m[3] ? Number(m[3]) : 1,
    rest: content.slice(m[0].length),
  };
}
