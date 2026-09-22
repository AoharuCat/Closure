import { z } from 'zod';
import {
  assetCardActionSchema,
  arcLedgerUpdateRequestSchema,
  arcTimingAxisSchema,
  buildWorldSnapshotRequestSchema,
  catalogEntriesRequestSchema,
  characterDepthAxisSchema,
  closureStoryQuerySchema,
  creativeFieldKeySchema,
  degradeEpisodeMentionsRequestSchema,
  episodeActionSchema,
  feedbackLedgerReadRequestSchema,
  feedbackLedgerWriteRequestSchema,
  fieldPatchEntrySchema,
  emotionCurveActionSchema,
  getEntryRequestSchema,
  growthCurveActionSchema,
  infoReleaseActionSchema,
  majorTurningPointSchema,
  materializeChapterSummaryRequestSchema,
  outlineDepthAxisSchema,
  pacingCurveActionSchema,
  promiseActionSchema,
  queryArcRequestSchema,
  queryArcSummaryRequestSchema,
  queryChapterSummaryRequestSchema,
  queryMentionsRequestSchema,
  recordArcAuditRequestSchema,
  recordEpisodeMentionsRequestSchema,
  sceneGraphActionSchema,
  storyDecisionActionSchema,
  structurePatternSchema,
  formatCraftTypeVocab,
  settingMdActionSchema,
  worldDepthAxisSchema,
  worldPatchInputSchema,
  worldSliceSchema,
  worldSubjectSchema,
} from '@orison/shared-contracts';
import { registry } from './registry';
import { remoteToolProxy } from './remote';
import { outlineUpdateWithQualityGates } from './outline-quality-gates';
import { skillTool } from './skill';
import { skillResourceListTool, skillResourceReadTool } from './skill_resource';
import { spawnAgentTool } from './spawn_agent';
import { spawnAgentBgTool } from './spawn_agent_bg';
import { bgTaskCancelTool, bgTaskResultTool, bgTasksStatusTool } from './bg-task-tools';
import { writeChapterTool } from './write-chapter';
import { diagnoseImpactsTool } from './diagnose-impacts';
import { dispatchResearcherTool } from './dispatch-researcher';
import { dispatchEpisodePlannerTool, dispatchStoryPlannerTool } from './dispatch-planners';
import { dispatchStyleAnalyzerTool } from './dispatch-style-analyzer';
import { presentResultTool } from './present-result';
import { startBatchTool, batchStatusTool, endBatchTool, setParticipationGearTool } from './batch-tools';

/**
 * CR-craft-kb-013: the query_craft tool description injects the full
 * `formatCraftTypeVocab()` guide (value:gloss for all 8 classes + uncategorized)
 * so the LLM sees craft_type glosses and can pick / self-register a precise
 * type. This makes `formatCraftTypeVocab` a production consumer (it was zero-
 * consumer before, only referenced by its own unit test). Computed once at
 * module load; the vocab is a frozen constant so the string is stable.
 */
const QUERY_CRAFT_DESCRIPTION = [
  '检索全局 craft 参考库（爽点/金手指/题材playbook/桥段/节奏/力量/pattern/角色设计），返回相关 craft 文档供写作参考。',
  '混合检索：关键词 + 语义向量 + RRF + rerank。',
  formatCraftTypeVocab(),
  // E10.2b W4.2（R10 自由标签）：命中里的手艺卡块带「标签: #…」行（标签发现机制——用着
  // 用着就习得可用标签面）；tags 参数即用这些自由标签过滤（任一命中即召回，OR 语义）。
  '命中包含「手艺卡」块（经验蒸馏的条目级写作手艺：主张+操作要点+适用场景+反例+多来源讲法），块尾「标签: #…」行是该卡的自由标签——用 tags 参数按标签检索，任一命中即召回，可与 query/craft_type 组合。',
].join('\n');

export function registerBuiltinTools() {
  // File operations
  registry.register(remoteToolProxy({
    id: 'read_file',
    description: 'Read the contents of a file within the project directory.',
    parameters: z.object({
      filePath: z.string().describe('Relative path from project root'),
      offset: z.number().int().nonnegative().optional().describe('Line offset (0-indexed)'),
      limit: z.number().int().positive().optional().describe('Max lines to read'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'write_file',
    description: 'Write content to a file within the project directory. Creates directories as needed.',
    parameters: z.object({
      filePath: z.string().describe('Relative path from project root'),
      content: z.string().describe('File content to write'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'list_files',
    description: 'List files and directories in the project.',
    parameters: z.object({
      dirPath: z.string().optional().describe('Relative directory path (default: project root)'),
      recursive: z.boolean().optional().describe('Whether to list recursively'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'search',
    description: 'Search for text content across project files.',
    parameters: z.object({
      query: z.string().describe('Search query (regex supported)'),
      glob: z.string().optional().describe('File pattern filter (e.g. "*.md")'),
      maxResults: z.number().int().positive().optional().describe('Max results (default 50)'),
    }),
  }));

  // Story memory (local read/write via Shell)
  registry.register(remoteToolProxy({
    id: 'memory_query',
    description: 'Query the story memory (story-memory.yaml). Optionally filter by keyword.',
    parameters: z.object({
      query: z.string().optional().describe('Keyword to filter memory entries'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'memory_update',
    description: 'Update the story memory file with new content.',
    parameters: z.object({
      content: z.string().describe('Full YAML content for story-memory.yaml'),
    }),
  }));

  // Skills — local tool that drives the workflow runtime directly
  registry.register(skillTool);
  registry.register(skillResourceListTool);
  registry.register(skillResourceReadTool);

  // Subagents — spawn focused child sessions for specialized tasks
  registry.register(spawnAgentTool);

  // 09-21-subagent-bg-decouple W1（design §1.2）：后台子 agent 派发族（spawn_agent_bg 立返句柄 +
  // status/result/cancel 三配套）。mirror spawn_agent 的 local-tool-with-runtime 模式；classifyTool
  // 默认 'read'（编排/查询/取消记账，不产 patch 不进 WRITE/DIFF——mirror spawn_agent 零 toolPolicy 登记）。
  // 同步 spawn_agent 字节级零改动（D1：新工具而非加参）。
  registry.register(spawnAgentBgTool);
  registry.register(bgTasksStatusTool);
  registry.register(bgTaskResultTool);
  registry.register(bgTaskCancelTool);

  // Story 4.0: leader chapter-chain dispatch (local tool). Triggers the write-
  // chapter subgraph (brief-compiler → draft-writer → storySync → multi-review →
  // route + revision loop) via ctx.skillExecutor.runChapterChain. Mirrors
  // spawn_agent's local-tool-with-runtime pattern. PermissionService DEFAULT_RULES
  // `^write_` → 'ask' (user confirms before generation). Story 4.1 Step 5 wires
  // the leader interactive trigger (DEFAULT_CLOSURE_PROMPT write_chapter guidance +
  // ChapterListPanel「生成」button → sendAgentMessage → leader runLoop); E3 will
  // build the full workbench horizontal surface (校验议题进 chat / chat-fatigue).
  registry.register(writeChapterTool);

  // Story 3.4 Phase 2：涟漪语义诊断 leader tool（local tool，mirror writeChapterTool 注册方式）。
  // leader runLoop 调此 tool 诊断作者改动对下游的实际影响：L1 纯代码缩小候选场 + world-state 取数 →
  // L2 dispatchRippleDiagnosis（runAgentWithExplicitSystem 'ripple-diagnosis-agent'）→ ripple-impact findings。
  // classifyTool 默认 'read'（纯诊断查询无副作用）——readonly/suggest/auto 全可用。不进 CONTRACTS[]
  // （子 agent + tool，mirror retrieval/adjudicator/revision-optimizer）。
  registry.register(diagnoseImpactsTool);

  // Story 3.3 线 D：leader 收尾声明工具（plan/discuss 模式必用）。无副作用纯标记——leader 停下前调它
  // 声明「这次停是否等用户确认意图」，loop.ts break 分支校验未调→打回（R2 #16 起 UI 快捷按钮已删，
  // awaiting 参数继续声明停的性质，终局语义见 present-result.ts）。
  registry.register(presentResultTool);

  // ── Story 3.5：批量编排（chat-fatigue 防护）+ 参与档位 chat 入口（design §1 / §2.1 / §6）──
  //
  // leader 驱动批量（非独立 driver 进程）：start_batch 纯代码解析有序场列表 + L1 信号卡 + 落盘
  // .orison/batches.json；leader 按系统提示词批量协议段逐场判轻重（重点场 turn break 问 / 非重点调
  // 既有 write_chapter）；batch_status 与 project state 对账续跑（崩溃/咨询后「继续」）；end_batch 收口。
  // set_participation_gear = 档位三入口之一（chat 指令「切到掌舵档」）。
  //
  // 范式判据（ADR-3 / R7 红线）：场列表/信号汇编/记账/状态读写 = 纯代码（batch-planning/batch-signals/
  // batch-state）；判轻重/问什么/走向单/L0 文本 = leader LLM（prompt 批量协议段）。
  // classifyTool 默认 'read'（不在 WRITE_TOOLS/DIFF_TOOLS）→ readonly/suggest/auto 全可见；readonly /
  // discuss 权卫在 start_batch 工具内（批量产 patch 需写权）。metadata.batch/signals 供 UI BatchGroup/
  // BatchReportCard（Step 8）消费。
  registry.register(startBatchTool);
  registry.register(batchStatusTool);
  registry.register(endBatchTool);
  registry.register(setParticipationGearTool);

  // Image generation
  registry.register(remoteToolProxy({
    id: 'generate_image',
    description: 'Generate an image from a text prompt. Saves the result to the project assets directory.',
    parameters: z.object({
      prompt: z.string().describe('Image generation prompt'),
      size: z.string().optional().describe('Image size (e.g. "1024x1024", "1792x1024")'),
      quality: z.string().optional().describe('Quality level: "auto", "low", "medium", "high"'),
      n: z.number().int().positive().optional().describe('Number of images to generate (default 1)'),
      outputDir: z.string().optional().describe('Subdirectory under assets/images/ to save to'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'edit_image',
    description: 'Edit an existing image using a text prompt.',
    parameters: z.object({
      prompt: z.string().describe('Edit instruction'),
      imagePath: z.string().describe('Relative path to the source image'),
      size: z.string().optional().describe('Output size'),
      n: z.number().int().positive().optional().describe('Number of variations'),
      outputDir: z.string().optional().describe('Subdirectory under assets/images/ to save to'),
    }),
  }));

  // Novel structure
  registry.register(remoteToolProxy({
    id: 'chapter_list',
    description: 'List all chapters in the project.',
    parameters: z.object({}),
  }));

  registry.register(remoteToolProxy({
    id: 'chapter_read',
    description: 'Read the content of a specific chapter.',
    parameters: z.object({
      chapterId: z.string().describe('Chapter identifier (filename without .md)'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'chapter_write',
    description: 'Write or update a chapter.',
    parameters: z.object({
      chapterId: z.string().describe('Chapter identifier (filename without .md)'),
      content: z.string().describe('Full chapter content in Markdown'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'rewrite_passage',
    description: 'Rewrite a selected passage of text. Does NOT apply the change directly — produces a diff for user review.',
    parameters: z.object({
      chapterId: z.string().optional().describe('Chapter identifier if the passage is from a chapter'),
      filePath: z.string().optional().describe('File path if the passage is from a file'),
      originalText: z.string().describe('The exact original text to be replaced'),
      replacement: z.string().describe('The new text to replace the original'),
    }).refine(d => d.chapterId || d.filePath, {
      message: 'Either chapterId or filePath must be provided',
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'outline_read',
    description: 'Read the project outline (structured outline_v2 from project.yaml).',
    parameters: z.object({}),
  }));

  // dogfood R2（task 08-25-dogfood-round2）：outline_update 从裸 remoteToolProxy 换 quality-gate
  // 包装注册——id/description/parameters 逐字不变，execute 委托同一注入 ExecuteToolFn 后对本次
  // 大纲新值验 CONTRACTS qualityGates 三项（缺核心冲突/转折点/结局方向 → Warn 议题挂 tool result
  // + envelope metadata.qualityGateIssues，不阻断人审流）。详见 tool/outline-quality-gates.ts 头注。
  // CR-1（BMad CR 拍板 B 方案·schema 全量收紧）：shell handler 直通 action:'set'（整体替换语义）
  // 而此前 tool schema 全字段可选 → LLM 发部分载荷（如 phases-only）会真抹掉未提及字段。收紧：
  // 核心字段（phases / central_conflict / major_turning_points / ending_direction——与
  // shared-contracts outlineV2Schema 结构化必填位 + story-planner-agent.yaml §大纲要求一致）改必填
  //（major_turning_points 允许空数组——真无锚点时显式给 []，防的是「沉默漏发抹掉既有锚点」）；
  // 纯可选元数据项（story_type/writing_style/main_goal/constraints/characters/两 notes）保持可选。
  // 过 zod 即全量——shell handler 直通语义不动（不碰 shell）。
  registry.register(outlineUpdateWithQualityGates({
    id: 'outline_update',
    description: 'Propose an update to the project outline. Does NOT apply directly — produces a patch for user review in the outline panel. FULL-REPLACE semantics: the `outline` payload replaces the current outline wholesale on accept — omitted optional fields are cleared. For partial changes, call outline_read first, then send the merged COMPLETE outline. Core fields (phases / central_conflict / major_turning_points / ending_direction) are required.',
    parameters: z.object({
      outline: z.object({
        story_type: z.string().optional().describe('Story type / genre framing'),
        writing_style: z.string().optional(),
        main_goal: z.string().optional().describe('Protagonist primary goal / dramatic question'),
        phases: z.array(z.object({
          id: z.string().describe('Stable phase id (e.g. "phase-1")'),
          title: z.string(),
          goal: z.string().optional(),
          antagonist: z.string().optional(),
          climax: z.string().optional(),
          hook: z.string().optional(),
          estimated_chapters: z.number().int().nonnegative().optional(),
        })).describe('Ordered story phases / acts. REQUIRED — full-replace: include every phase you want to keep (empty array only if the outline truly has no phases)'),
        central_conflict: z.string().describe('REQUIRED — the through-line conflict (who wants what, who opposes it, what is at stake). Full-replace: never omit, echo the current value from outline_read if unchanged'),
        major_turning_points: z.array(majorTurningPointSchema).describe('REQUIRED — typed anchors: [{type: "core-anchor"|"secondary-anchor"|"fork-point", label, description?}]. Full-replace: include existing anchors you want to keep (may be empty array if genuinely none)'),
        ending_direction: z.string().describe('REQUIRED — where the story lands (one sentence). Full-replace: never omit, echo the current value from outline_read if unchanged'),
        constraints: z.array(z.string()).optional(),
        characters: z.string().optional(),
        // Story 8.5（design §7 D3）：假字段重命名（原 growth_curve/pacing_curve_text——与顶层结构化
        // creative field 同名不同物）。描述就地说明草稿语义与结构化通道的分工，防 LLM 把草稿当曲线写。
        arc_design_notes: z.string().optional().describe(
          '成长弧线草稿（自由笔记，随手梳理角色成长的想法，不是结构化数据）。结构化的角色成长弧——每角色的出发状态/创伤缺憾/想要与需要/转折点——不写这里，走 growth_curve_update 工具。'
        ),
        pacing_design_notes: z.string().optional().describe(
          '节奏草稿（自由笔记，随手记叙事张弛的想法，不是结构化数据）。结构化的节奏设计曲线——按集/章/场的强度点——不写这里，走 pacing_curve_update 工具。'
        ),
      }).describe('Structured outline (outline_v2). FULL outline — FULL-REPLACE semantics: this object replaces the current one wholesale on accept, omitted optional fields are cleared. Required core: phases / central_conflict / major_turning_points / ending_direction. For partial updates: outline_read first, then send the merged complete outline.'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'overview_update',
    description: 'Propose an update to the project overview / metadata (title, logline, synopsis, genre, theme, tone). Does NOT apply directly — produces a patch for user review on the Overview page.',
    parameters: z.object({
      name: z.string().optional().describe('Project / story title'),
      logline: z.string().optional().describe('One-sentence hook'),
      synopsis: z.string().optional().describe('Short synopsis / blurb'),
      genre: z.string().optional(),
      theme: z.string().optional(),
      tone: z.string().optional(),
    }),
  }));

  // Story 2.5 GenreContract 创建期「定承诺」——leader 查 query_craft playbook 后提议
  // 题材承诺（commitments）/ 世界规则种子（world_constitution）/ 题材标签（genre_tags）。
  // Mirror overview_update / outline_update：不直接落盘——产 field_patch 供用户在
  // PatchReviewPanel 审阅；接受后经 fieldSyncBridge 落盘 + version bump + stale 传播。
  // 范式判据（creative-vs-mechanical.md）：承诺建议 = LLM（leader 提议）；字段路由 /
  // patch 落盘 = 纯代码。design §2.1 / implement.md step 7。
  // Story 2.6 StoryDecision 创作决策 ADR 登记——leader 为作者登记重大创作分叉（角色弧走向/
  // 情节分叉/主题取舍/世界规则敲定）。Mirror genre_contract_update / setting_md_update：
  // 缺省产 field_patch envelope 人审；autoApply=true（auto 档）直落 novel.story_decisions。
  // 范式判据：决策内容（值不值得记 / summary / reason / alternatives / risk）= LLM；状态机守卫
  // （assertTransition / id 唯一 / user-source force 保护）+ patch 路由 = 纯代码（handler）。
  // 既有决策可在 project_config（project.yaml 全文注入）读到：id 引用 / 防重复登记。
  registry.register(remoteToolProxy({
    id: 'story_decisions_update',
    description: '登记/更新创作决策（StoryDecision ADR：open→decided→superseded/dropped）。重大创作分叉才记（角色弧走向/情节分叉/主题取舍/世界规则敲定），例行规划不记。decision 必填 id/summary/reason/risk（risk：登记前想清楚这条决策的风险）+ status（open 未决=brief #8 警告下章主笔 / decided 已决=Reader-Audit 验证落地）+ source（user=作者本人拍板[受保护：AI 改写须 force] / workbench=你的建议 / director=导演登记）。既有决策（id/状态）在 project_config 的 novel.story_decisions 可读：register 既有 id 可 open→decided 拍板或 open→open 更新；改方向走 supersede（旧决策留 ADR 链）；放弃走 drop。',
    parameters: z.object({
      actions: z.array(storyDecisionActionSchema).describe(
        '按序执行的动作列表：register（新登记或对既有 id 重登记：open→open 更新 / open→decided 拍板）/ supersede（改方向：旧→superseded 留链 + 新决策入列）/ drop（放弃，reason 必填留痕）。'
      ),
      autoApply: z.boolean().optional().describe(
        'true=auto 档直接落盘（须 session 全权模式）；缺省产 patch 人审。首次带 true 的调用会被系统拦下，要求你先重读当前数据自审确认；随后带 selfReviewConfirmed: true 重发同一调用才会执行。'
      ),
      selfReviewConfirmed: z.boolean().optional().describe(
        'true=你已按系统提示完成自审（重读当前数据，逐条核对过本次修改无误）。首次 autoApply 调用被拦后重发时传 true。'
      ),
      force: z.boolean().optional().describe(
        '改写/取代/放弃 source:user（作者拍板）的决策须显式 true（三层权威：用户决定硬）。'
      ),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'genre_contract_update',
    description: '提议题材承诺更新（GenreContract）。查 query_craft playbook 后提议核心承诺（commitments：HE/BE/CP/爽点底线/题材核心承诺）+ 世界规则种子（world_constitution：impossible list「绝不X」）+ 题材标签（genre_tags）。不直接落盘——产 field_patch 供用户审阅。',
    parameters: z.object({
      genre_tags: z.array(z.string().min(1)).optional().describe(
        '题材标签（替换 creative_brief.genre_tags）。自由填：题材方向/世界观/玩法/风格基调/叙事套路/角色处境/受众/篇幅等。'
      ),
      commitments: z.array(z.object({
        type: z.string().min(1).describe('承诺类别（自由值：HE/BE/CP/爽点底线/题材核心承诺…）'),
        content: z.string().min(1).describe('承诺内容'),
      })).optional().describe(
        '核心承诺列表（替换 creative_brief.commitments）。每条 = type+content。'
      ),
      world_constitution: z.array(z.string().min(1)).optional().describe(
        '世界规则种子（替换 world_setting.world_constitution，impossible list「绝不出现X」）。'
      ),
    }),
  }));

  // Scene-graph — multi-line narrative structure (Story 1.3). scene_graph is the
  // scene-grain下沉 of the outline (same causal tree; orthogonal to episode_outlines
  // 承载树 — Scene.episodeId links them, landed in 1.1). Read returns the curated
  // graph; update is a BOUNDED action enum (add/update/remove scene/edge/line), NOT
  // a full-replace like outline_update — multi-line graphs are large, bounded ops
  // are reviewable + reversible (design §1.2 / §3.8). Does NOT apply directly — the
  // shell projects actions onto the current graph and produces a patch for user
  // review; validation (CAUSAL DAG cycle / reachability / mesh mapping) runs on the
  // staged graph in the patch-review data channel (design §4).
  registry.register(remoteToolProxy({
    id: 'scene_graph_read',
    description: 'Read the project scene-graph (multi-line narrative structure from project.yaml: scenes, edges, lines, art_overrides).',
    parameters: z.object({}),
  }));

  registry.register(remoteToolProxy({
    id: 'scene_graph_update',
    description: 'Propose bounded edits to the scene-graph (add/update/remove scene/edge/line). Does NOT apply directly — produces a patch for user review; validation runs on the staged graph. Prefer this over rewriting the whole graph: bounded ops are reviewable and reversible. When adding/updating a scene, fill assetRefs (array of asset_card ids involved in this scene — characters/locations/props/organizations that appear) so ripple-impact diagnosis can trace which scenes are affected when a setting card changes.',
    parameters: z.object({
      actions: z.array(sceneGraphActionSchema).describe(
        'Ordered bounded edits. ops: add_scene/update_scene/remove_scene, add_edge/remove_edge, add_line/update_line/remove_line. ' +
        'add accepts partial (missing fields filled with defaults); update merges partial by id; remove filters by id. ' +
        'add_scene/update_scene may include assetRefs (asset_card id array) for ripple-impact tracing.'
      ),
    }),
  }));

  // Project
  registry.register(remoteToolProxy({
    id: 'project_meta',
    description: 'Read the project metadata (project.yaml).',
    parameters: z.object({}),
  }));

  // Story 3.4（R1/C-A2）：涟漪消费端 leader tool——读磁盘 project.yaml field_metadata，
  // 返回 stale===true 的 CreativeFieldKey[]（候选集）。leader 无此 tool 自查不到 stale 候选 →
  // 无法触发涟漪诊断。mirror project_meta / scene_graph_read 范式（remoteToolProxy 无参读磁盘，
  // unified toolExecution channel）。classifyTool 默认 'read'（readonly/suggest/auto 全可用）——
  // 纯查询无副作用。范式判据（ADR-3）：读 stale 标记 = 纯代码磁盘查询；诊断/执行归 LLM/既有工具。
  registry.register(remoteToolProxy({
    id: 'list_stale_fields',
    description: '列出当前项目所有标记为 stale（待重算）的创作字段（CreativeFieldKey[]）。作者改一处数据后下游被标 stale；leader 据此知候选集，派发涟漪诊断或建议重算。',
    parameters: z.object({}),
  }));

  // Story 3.4 Phase 4.2：clearStale dismiss 通路——作者 dismiss 涟漪报告（「这场实际不受影响」）
  // 时需清 stale 不编辑。leader 调此工具传要 dismiss 的字段集，shell handler 读 project.yaml →
  // clearStaleFields(currentStale, fields)（workflow-sync.ts 纯函数）→ 写回 field_metadata[field].stale=false →
  // saveProject 落盘。mirror list_stale_fields 注册 + projectHandlers.ts handler 范式。
  // classifyTool 默认 'read'（虽写盘，但写的是元数据 stale 标记非创作数据本身——mirror memory_update
  // / overview_update 哲学：bounded 落盘人审不走 PatchReview）。
  // 🔑 硬约束：stale 标记是机械元数据（true/false），不是创作内容——dismiss 不产 field_patch 走
  // PatchReview（创作数据 patch 才走人审）。dismiss 直接落盘元数据 = 纯代码（ADR-3）。
  registry.register(remoteToolProxy({
    id: 'dismiss_stale_fields',
    description: '清除（dismiss）指定创作字段的 stale 标记（落盘 field_metadata[field].stale=false）。作者说「这场实际不受影响」/「这个改动不需传播」时调此工具清 stale（避免下次诊断重复报）。入参 fields=要清除的 CreativeFieldKey 数组（如 ["scene_graph","emotion_curve"]）。直接落盘元数据，不产 patch 不走 PatchReview（stale 是机械标记非创作内容）。无法清除 locked 字段（需作者先解锁）。',
    parameters: z.object({
      fields: z.array(creativeFieldKeySchema).min(1).describe(
        '要 dismiss stale 标记的创作字段 key 数组（仅含 creativeFieldKeys enum 值：creative_brief/world_setting/outline/episode_outlines/growth_curve/pacing_curve/emotion_curve/asset_cards/relationship_graph/promise_registry/info_release_map/scene_graph）。',
      ),
    }),
  }));

  // Closure KB - hybrid retrieval over the derived index (ADR-3 / VS1 R5).
  // Read-only retrieval; classifyTool defaults it to 'read', so it is available
  // in readonly/suggest/auto sessions. Crosses to the shell via the unified
  // toolExecution channel (remoteToolProxy) - no dedicated IPC channel.
  //
  // Story 8.7 R4（S6 扩参）：status/visibility 预过滤参数 + parameters 切 shared schema 单源
  // （N5：builtin parameters = closureStoryQuerySchema 直用，handler 校验同一 schema 零漂移，
  // mirror buildWorldSnapshotRequestSchema 先例——describe 落 shared schema 随字段走）。
  //
  // Story 8.3（S4）：正文段落 + 章摘要进检索面——描述更新告知写手「找剧情不必逐章翻原文」
  // （说人话双规则：说作用不说实现；守门测试锚 builtin-catalog.test.ts）。
  registry.register(remoteToolProxy({
    id: 'query_story',
    description: '检索项目知识库找写作材料：设定卡（人物/地点/物品/规则）、长文设定文档、已写正文的段落片段、每章内容摘要。按意思相近或按关键词都能找；正文段落命中会附段级出处（第N章第a-b段），便于回原文前后文核对。找「之前写过什么」（如某人物上次哭、哪里写过当铺）用它而非逐章翻原文。可按条目类型与卡状态过滤（如只搜定稿在用的卡）。',
    parameters: closureStoryQuerySchema,
  }));

  // Story 6.4 D2：relation 图遍历召回臂（mirror query_story，通用工具 any agent 可调）。
  // 图遍历召回「结构关联但语义不相似」条目（补 query_story 语义盲区）。seed→N-hop 递归 CTE
  // （shell relationRetrieval.searchRelations）。classifyTool defaults 'read'（readonly/suggest/auto）。
  // Crosses to shell via unified toolExecution channel (remoteToolProxy) - no dedicated IPC; projectId
  // derived from projectDir in handler. 范式判据：递归 CTE 纯代码；消费者裁判归各 LLM。
  registry.register(remoteToolProxy({
    id: 'query_relations',
    description: '从给定条目（seed）出发，沿关系图召回结构关联条目（人物关系网/伏笔链/因果链）。图遍历召回「结构关联但语义不相似」的条目——补 query_story 语义检索盲区。如查角色 A 时召回其宿敌/盟友/师徒（这些语义不像 A 但结构强关联）。',
    parameters: z.object({
      seed_entry_id: z.string().min(1).describe('起点条目 id（通常是 query_story 命中的 entryId / assetCardId）'),
      depth: z.number().int().positive().optional().describe('图遍历深度（默认 2，最大 5；1=直接邻居）'),
      budget: z.number().int().positive().optional().describe('返回条目数上限（默认 20，最大 100）'),
      relation_type: z.string().optional().describe('关系类型过滤（alliance/rivalry/mentor/family/romance/secret/debt/organization/custom）；不填则全类型'),
      visibility: z.enum(['public', 'secret', 'one_sided']).optional().describe('读者视角过滤（只召回该可见性的关系）'),
    }),
  }));

  // ── Story 8.7 S6（R3/R1，design §4.1）：扫描层统一目录 + 出场账三只读工具 ──
  //
  // 「找完整」地基（LLM 不知道自己不知道，采样式检索必漏——目录给穷举入口）。三件 mirror
  // query_story：remoteToolProxy → 统一 toolExecution channel（无专用 IPC/preload 面）；
  // classifyTool 默认 'read'（readonly/suggest/auto 全可用，零 toolPolicy 登记——mirror
  // query_world_state 读工具零登记先例；无 envelope 无 B01 面）。projectId 从 projectDir
  // 解析（非 tool param）。读路径零持久化副作用（handler 纯读，agent-tools.md Convention）。
  //
  // parameters = shared-contracts request schema 单源（N5：catalogEntriesRequestSchema /
  // getEntryRequestSchema / queryMentionsRequestSchema 直用——per-field describe 落 shared
  // schema，mirror buildWorldSnapshotRequestSchema 先例）。
  //
  // 🔴 描述说人话双规则（agent-tools.md，本步最高风险项）：说作用不说实现（禁 产patch/落盘/
  // field_patch/PatchReview/mirror/Story 编号/文件路径行号）；特殊名词就地解释（「实体」「出场账」
  // 开篇一句话定义；present/mentioned/gap_stats 的含义随参数/描述就地讲清）。守门测试锚定
  // builtin-catalog.test.ts（实现词汇零命中断言）。
  registry.register(remoteToolProxy({
    id: 'catalog_entries',
    description: '翻阅本项目的实体目录——把知识库里的实体按清单逐行列出（人物、地点、道具、组织、规则等设定卡与设定文档），每行带 id、类型、名字、简述和出场统计（出场章数、最后出场章）。与 query_story 的分工：query_story 按意思搜「相关的」，本工具按目录翻「全部的」——想确认「项目里有哪些角色/设定」「有没有漏掉谁」时用它。可按类型（entry_type）或卡状态（status）过滤；结果分页返回并带总数，翻页用 offset（默认每页 20 条，最多 100 条）。看到想深入了解的条目，用 get_entry 传它的 id 查全文。',
    parameters: catalogEntriesRequestSchema,
  }));

  registry.register(remoteToolProxy({
    id: 'get_entry',
    description: '查看一个实体条目的完整档案：名字、类型、一段话简述、全文内容、卡状态、出场统计（出场章数、最后出场章）。条目 id 来自实体目录（catalog_entries 的行）或检索结果（query_story 的 entryId）。适合在目录里扫到某条后深入了解，或动笔前精确核对某个设定的完整内容。',
    parameters: getEntryRequestSchema,
  }));

  registry.register(remoteToolProxy({
    id: 'query_mentions',
    description: '查询出场账——记录「哪个实体在哪一章登场、哪一章只是被提到」的账本，随写作逐章累积。两个方向：给 entry_id 查这个人物的出场史（在哪些章登场/被提及）；给 episode_id 查这一章的名册（这章有谁登场、谁只被提到）。present=正式登场露面，mentioned=只在对话或叙述里被提到、本人没露面。view 填 gap_stats 时改为出场间隔统计：每个实体最后出现在哪一章、距故事当前进度隔了多久——用来发现很久没露面、可能被读者遗忘的角色。条目 id 可从实体目录（catalog_entries）或检索结果（query_story）拿到。',
    parameters: queryMentionsRequestSchema,
  }));

  // Craft KB - global craft reference library retrieval (ADR-3 / Story 2.1).
  // Mirrors query_story via remoteToolProxy (unified toolExecution channel, no
  // dedicated IPC). GLOBAL scope - no projectId (the craft KB is cross-project).
  // classifyTool defaults 'read' (readonly/suggest/auto available). craft_type is
  // an OPEN string (8-class taxonomy: 爽点/金手指/题材playbook/桥段/节奏/力量/
  // pattern/角色设计 + uncategorized catch-all; users can self-register new
  // classes via frontmatter - non-closed enum, mirror Story 1.9).
  registry.register(remoteToolProxy({
    id: 'query_craft',
    description: QUERY_CRAFT_DESCRIPTION,
    parameters: z.object({
      query: z.string().describe('自然语言查询，如「爽点设计」「金手指限制」「都市题材套路」；与 tags 同用时作精化，tags-only 浏览可留空'),
      craft_type: z.string().optional().describe(
        'craft 类型过滤（见描述中的 craft_type 词表，或自建新类）；不填则全类型',
      ),
      tags: z.array(z.string().min(1)).optional().describe(
        '自由标签过滤（手艺卡标签，任一命中即召回 OR 语义；可用标签看命中手艺卡块的「标签: #…」行，可传 # 前缀以外的裸标签值）',
      ),
      k: z.number().int().positive().optional().describe('返回文档数（默认 10）'),
    }),
  }));

  // ── Story 6.6 world-state derived index (ADR-14 / ADR-3) ──
  // 5 tools over the actual-track event-sourced state engine (prose → 5-axis
  // extractors → reduce → closure_world_state). Mirrors query_story via
  // remoteToolProxy (unified toolExecution channel; projectId derived from
  // projectDir in the shell handler, NOT a tool param). 3 read tools (query_* /
  // find_*) default classifyTool 'read' (readonly/suggest/auto available) —
  // Writer/leader/Reader-Audit query state. 2 write tools (write_world_events /
  // amend_world_state) are called by the extractor chain nodes (Phase C) and the
  // amendment agent; their permission model for chain-internal calls is wired in
  // Phase C (classification as 'read' here keeps them callable from the chain;
  // DEFAULT_RULES `^write_` still gates write_world_events at the permission
  // layer, amend_world_state defaults read — Phase C will resolve the chain-
  // internal permission story). source is FORCED by the handler (derived /
  // amendment), never trusted from the caller — patches omit `source`.
  // N5：worldPatchInputSchema 用 shared-contracts 单源（world-state.ts，去内联重定义避漂移）。handler 入参
  // 校验 + 此处 tool 描述共用同 schema（DRY，mirror query_story closureStoryQuerySchema 模式）。per-field
  // describe 走 shared schema 形态（tool-level description 已覆盖用法语义，足够 LLM 调用）。
  const worldSliceInputSchema = worldSliceSchema.omit({ projectId: true }).describe(
    '切面：一个 storyTime + 一组 patch 的容器（projectId 由 handler 解析，不传）',
  );
  const worldSubjectInputSchema = worldSubjectSchema.describe(
    '主体登记：首次出现时建（id+type 必填，name/sourceCardId 可选）',
  );

  // query_world_state：reduce 一个 subject 在某虚构时刻的状态（Writer 写下一章知已建立状态）。
  registry.register(remoteToolProxy({
    id: 'query_world_state',
    description: '查询某主体在给定虚构时刻（storyTime）的实际状态（从正文派生的事件溯源 reduce）。如「主角现在的 HP/位置/装备」「倒叙：主角 200 年时」。可选 attrs 只投影关心的属性。',
    parameters: z.object({
      subjectId: z.string().min(1).describe('要查的主体 id'),
      at: z.number().int().optional().describe('storyTime 截断点（仅叠加 storyTime <= at 的变更）；省略取最新状态'),
      attrs: z.array(z.string().min(1)).optional().describe('属性投影（顶层 key，如 ["hp","location"]）；省略返全状态'),
    }),
  }));

  // query_world_slice：列出切面（timeline），可按主体/类型/时间收窄。
  registry.register(remoteToolProxy({
    id: 'query_world_slice',
    description: '列出世界状态切面（事件 timeline）。可收窄：subjectIds（触及这些主体的切面）/ type（触及该类型主体的切面）/ at（storyTime <= at）。withPatches=true 附每切面的 patches。',
    parameters: z.object({
      subjectIds: z.array(z.string().min(1)).optional().describe('只列触及这些主体的切面'),
      type: z.string().optional().describe('只列触及该类型主体（如 character）的切面'),
      withPatches: z.boolean().optional().describe('是否附每切面的 patches（默认 false）'),
      at: z.number().int().optional().describe('storyTime 截断点；省略取全部'),
    }),
  }));

  // find_world_refs：反查指向某主体的引用（关系只存一边）。
  registry.register(remoteToolProxy({
    id: 'find_world_refs',
    description: '反查指向某主体的引用（关系只存一边，反查找谁引用我）。如「这把剑被谁装备」「凤凰阵营有谁」。返回引用方主体 + path + 故事时间。',
    parameters: z.object({
      subjectId: z.string().min(1).describe('被引用的目标主体 id'),
    }),
  }));

  // write_world_events：提取器派生 events 写入（source='derived' 由 handler 强制）。
  registry.register(remoteToolProxy({
    id: 'write_world_events',
    description: '提取器把从正文派生的事件（patches）写入世界状态（source=derived）。同 slice.id 重写时替换其 patches（稳定 slice.id 启用干净重提取）。subjects 登记首次出现的主体。',
    parameters: z.object({
      slice: worldSliceInputSchema,
      patches: z.array(worldPatchInputSchema).describe('该切面的状态变更（source 由系统注入，不传）'),
      subjects: z.array(worldSubjectInputSchema).default([]).describe('本切面涉及的主体登记（首次出现时建）'),
    }),
  }));

  // amend_world_state：修补 Agent 裁决后写覆盖层（source='amendment' 由 handler 强制）。
  registry.register(remoteToolProxy({
    id: 'amend_world_state',
    description: '修补 Agent 裁决「修补与正文一致」后写覆盖层（source=amendment，reduce 叠加在 derived 之上）。重提取时 amendment 清零（修补临时性，依附当时派生快照）。',
    parameters: z.object({
      slice: worldSliceInputSchema,
      patches: z.array(worldPatchInputSchema).describe('修补覆盖层 patches（source 由系统注入，不传）'),
      subjects: z.array(worldSubjectInputSchema).default([]).describe('本切面涉及的主体登记'),
    }),
  }));

  // ── Story 8.1 checkpoint-backed snapshot + ChapterStateSummary（design §2/§3，百万字长程有界化）──
  // 3 tools over the checkpoint-backed world-state reduce + per-episode materialized summary（二级派生缓存，
  // DERIVED 可 drop 重建，prose 仍是唯一真相源 ADR-1/14）。tool ID 精确匹配 Step 3 shell 注册
  // （toolExecution.ts register）——remoteToolProxy 按 id 路由，漏注册 = 工具调不通。
  //
  // B01 三处同步核对（agent-tools.md checklist——该 checklist 适用于「产 field_patch envelope 的写工具」）：
  // - build_world_snapshot / query_chapter_summary：读工具，classifyTool 默认 'read'（readonly/suggest/auto
  //   全可用）→ 不进 toolPolicy WRITE_TOOLS/DIFF_TOOLS / UI WRITE_TOOLS（mirror query_world_state /
  //   query_world_slice 读工具零登记先例）。无 envelope → 无 UI 门静默丢风险。
  // - materialize_chapter_summary：链内写工具（chapter-summary-node 调用，写 closure_chapter_summary +
  //   机会式 checkpoint 派生表，**无 field_patch envelope**）→ 不进 toolPolicy 门（chain node 直接
  //   registry.execute 不经 filterToolsForPolicy；mirror feedback_ledger_write / write_world_events 链内
  //   写工具定位——permission 由链段调用上下文保证）。skill-VM 路径 PermissionService DEFAULT_RULES 无
  //   匹配规则 → external/ask fallback（同 feedback_ledger_write 现状，非 skill 调用面）。
  // parameters = shared-contracts request schema 单源 import（N5：勿内联重定义避漂移；mirror
  // feedbackLedgerWriteRequestSchema 先例——per-field describe 留 shared schema JSDoc，tool-level
  // description 已覆盖用法语义）。
  registry.register(remoteToolProxy({
    id: 'build_world_snapshot',
    description: '查询章节级世界状态快照（checkpoint-backed reduce，免全量重放；纯读——不写库/checkpoint，缓存由物化路径维护）。ats 批量一次得多个 storyTime 截断点快照 / at 单点（互斥，二选一；都省略取最新）。projection 可选 cognition（各角色此刻认知）/ presence（在场性预筛信号）。要「某时刻全体角色/状态总览」（而非单 subject）用它，比逐个 query_world_state 省。',
    parameters: buildWorldSnapshotRequestSchema,
  }));

  registry.register(remoteToolProxy({
    id: 'query_chapter_summary',
    description: '查询已物化的章节状态摘要（ChapterStateSummary 六字段：角色终态/关系温度变化/伏笔状态变更/新引入实体/未解决承诺/下章回收清单）。三选一收窄：episodeIds 精确集 / fromIndex+toIndex 闭区间（单次上限 50 章）。查「到第 N 章为止发生了什么」用它而非重读正文或全量查状态（token 从全章降至定向摘要）。',
    parameters: queryChapterSummaryRequestSchema,
  }));

  registry.register(remoteToolProxy({
    id: 'materialize_chapter_summary',
    description: '物化一章的 ChapterStateSummary 到派生表（六字段汇编 + 机会式 checkpoint；同 episodeId 重调幂等 upsert 覆盖）。由写章链段 chapter-summary-node 每章自动调用，历史章节由 backfill 补建——一般无需手动调。',
    parameters: materializeChapterSummaryRequestSchema,
  }));

  // ── Story 8.7 S8：mention 共现账链内写工具（design §2.2/§2.3）──
  // Mirror materialize_chapter_summary 定位：链段节点（mention-ledger-node）经 registry 直调触发，
  // 非 LLM 主动调用面——chain node 直接 registry.execute 不经 filterToolsForPolicy
  // （permission 由链段调用上下文保证），无 field_patch envelope → 无 B01 面 / 无 UI WRITE_TOOLS 登记。
  // BMad CR-002（2026-08-19）：toolPolicy WRITE_TOOLS 显式收录（classifyTool='write'）——readonly/suggest
  // 档 LLM 直调被拦（record 是 per-episode 全量替换语义，误调即覆写真实账）；链内直调照旧不受影响。
  // 链流程重排 W1d：targeted-revision 降档包装退役——degrade 的直调方改挂 W4 re-extract-chapter。
  // parameters = shared-contracts request schema 单源 import（N5）。
  registry.register(remoteToolProxy({
    id: 'record_episode_mentions',
    description: '登记一章的出场记录到出场账：合并写手本章人物申报、世界状态的在场记录、正文里明写的名字、计划登场四个来源，为本章出现过的每个实体记一条（正式登场或仅被提及，取最高档）。同时把申报的一段话梗概写进该章摘要。同章重调会整体覆盖旧账。由写章链段每章自动调用——一般无需手动调。',
    parameters: recordEpisodeMentionsRequestSchema,
  }));

  registry.register(remoteToolProxy({
    id: 'degrade_episode_mentions',
    description: '把一章的出场账降为保守档：清除写手申报通道的记录（只保留机械来源），并把该章梗概标注为可能过时。用于章正文被修订、申报与正文不再对应的场景。由写章链段修订环节自动调用——一般无需手动调。',
    parameters: degradeEpisodeMentionsRequestSchema,
  }));

  // ── Story 6.1 CognitionGraph query + InfoReleaseMap（ADR-3 / ADR-14 / conclusions §3.1/§3.6）──
  // CognitionGraph = per-character `knows_at_time_t` 派生视图（实际轨，正文派生）。消费 6.6 认知轴
  // patches，复用 reduceSubject（不重写 reduce），**不建 closure_* 表**。Mirror query_world_* via
  // remoteToolProxy（统一 toolExecution channel；projectId 从 projectDir 解析，非 tool param）。
  // InfoReleaseMap = 作者意图目标轨 creative field（per-scene reveal/withhold/dramaticIrony 计划），
  // mirror scene_graph_read / scene_graph_update（bounded action → field_patch → UI patch-review）。
  // 下游消费：6.2 Reader-Audit 查 query_cognition 判 KNOWLEDGE_VIOLATION/FORGOTTEN_REVEAL + 读
  // info_release_map 白名单；6.3 Director 读 info_release_map 产 ManipulationDirective（接线归各 epic）。

  // query_cognition：查某角色 @ storyTime 的认知（CognitionGraph per-character 视图）。
  registry.register(remoteToolProxy({
    id: 'query_cognition',
    description: '查询某角色在给定虚构时刻（storyTime）的认知状态（从正文派生的事件溯源认知轴 reduce）。如「主角现在知道/相信/怀疑什么」「倒叙：主角 200 年时的认知」。返回 knows/believes/misunderstands/suspects 字典，value 可含 {objective, reader_perceived} 分层。',
    parameters: z.object({
      characterSubjectId: z.string().min(1).describe('角色主体 id（认知提取器产的 cognitive-axis subject，有卡用卡 id）'),
      at: z.number().int().optional().describe('storyTime 截断点（仅叠加 storyTime <= at 的认知变化）；省略取最新认知'),
    }),
  }));

  // query_cognition_graph：查某 storyTime 下所有角色的认知（CognitionGraph per-scene 物化视图）。
  registry.register(remoteToolProxy({
    id: 'query_cognition_graph',
    description: '查询某虚构时刻（storyTime）下所有角色的认知图（CognitionGraph per-scene 物化视图）。返回 { [characterSubjectId]: 认知字典 }。Reader-Audit 一致基底 / 摘要物化用。at 省略取最新（最大 storyTime）。',
    parameters: z.object({
      at: z.number().int().optional().describe('storyTime 截断点（该场所有角色此刻认知）；省略取最新'),
    }),
  }));

  // info_release_map_read：读 project.yaml 信息释放计划（目标轨 creative field），可按场景/章收窄。
  registry.register(remoteToolProxy({
    id: 'info_release_map_read',
    description: '读取项目的信息释放计划（info_release_map，作者意图侧前置计划：per-scene reveal/withhold/dramaticIrony + ManipulationDirective）。可按 sceneId/episodeId 收窄。Director 消费用（6.3 接线）。',
    parameters: z.object({
      sceneId: z.string().optional().describe('只返回挂该场景的条目（→ SceneNode.id）'),
      episodeId: z.string().optional().describe('只返回该 episode 的条目'),
    }),
  }));

  // info_release_map_update：bounded action 写 InfoReleaseMap 条目（mirror scene_graph_update）。
  registry.register(remoteToolProxy({
    id: 'info_release_map_update',
    description: '提议对信息释放计划（info_release_map）的 bounded 编辑（add_entry/update_entry/remove_entry）。不直接落盘——产 field_patch 供用户在 patch panel 审阅；接受后经 fieldSyncBridge 落盘 + version bump + stale 传播。',
    parameters: z.object({
      actions: z.array(infoReleaseActionSchema).describe(
        'Ordered bounded edits. ops: add_entry/update_entry (carrying full entry: id + sceneRef required) / remove_entry (carrying entryId). ' +
        'add/update by id 覆盖或追加；remove 幂等跳过。'
      ),
    }),
  }));

  // ── Story 6.5 Promise ledger（ADR-3 / ADR-14 / design §2 / §5 方案 C）──
  // promise_registry 是 creative field（project.yaml，mirror foreshadow_registry + InfoReleaseMap sibling），
  // 跨双轨（目标轨 debt + planned beats / 实际轨 factual beats）。涌现登记由实际轨驱动（promise-emergence-node：
  // 提取→纯代码 gap 检测→LLM 登记→经 promise_ledger_update 写 creative field）。非 closure_* 派生表。
  // Mirror info_release_map_* via remoteToolProxy（统一 toolExecution channel；projectId 从 projectDir 解析，非
  // tool param）。tool ID 须精确匹配 Phase C shell handler 注册（toolExecution.ts: register('query_promise', ...)
  // + register('promise_ledger_update', ...)）——remoteToolProxy 按 id 路由。
  // 下游消费：promise-emergence-node（登记 + 避重复登记）/ 4.4 cross-arc 完整性维 / leader。

  // query_promise：读 project.yaml promise_registry（promises + beats），可按 sceneId/episodeId 收窄。读工具。
  registry.register(remoteToolProxy({
    id: 'query_promise',
    description: '读取项目的读者债账本（promise_registry：从 perspective gap 涌现的 Promise 生命周期 plant→advance→setback→payoff + beats 挂场景）。可按 sceneId/episodeId 收窄（beats 携带 sceneRef/episodeId）。4.4 完整性维 / Promise 涌现节点（避重复登记）消费。',
    parameters: z.object({
      sceneId: z.string().optional().describe('只返回挂该场景的 beat 所属 Promise（→ SceneNode.id）'),
      episodeId: z.string().optional().describe('只返回该 episode 的 beat 所属 Promise'),
    }),
  }));

  // promise_ledger_update：bounded action 写 promise_registry（mirror info_release_map_update）。
  registry.register(remoteToolProxy({
    id: 'promise_ledger_update',
    description: '提议对读者债账本（promise_registry）的 bounded 编辑（add_promise/add_beat/update_beat/remove_promise/remove_beat）。不直接落盘——产 field_patch 供用户在 patch panel 审阅；接受后经 fieldSyncBridge 落盘 + version bump + stale 传播。Promise 涌现登记通常经 promise-emergence-node 自动调（每章提取后判 gap→登记），人/leader 也可手动调。',
    parameters: z.object({
      actions: z.array(promiseActionSchema).describe(
        'Ordered bounded edits. ops: add_promise (promise: id+title+summary 必填；firstBeat 可选通常 plant) / ' +
        'add_beat (beat: promiseId+sceneRef+kind；id 可缺系统按自然键生成) / update_beat (beatId+patch) / ' +
        'remove_promise (promiseId，级联删其 beats) / remove_beat (beatId)。beat 幂等：同 (promiseId, sceneRef) 覆盖。'
      ),
    }),
  }));

  // ── Story 8.2 arc registry（弧生命周期：写时声明 + 关口大审 + 停滞触发，design §1/§2）──
  // arc_registry 是 creative field（project.yaml，mirror promise_registry 归属——写手声明的弧节拍
  // advance/close，LLM-authored 叙事状态）。弧审快照（ArcAuditResult）住 closure_arc_summary DERIVED 表
  // （query_arc_summary 读）。Mirror promise_ledger_update 三件套 via remoteToolProxy（统一 toolExecution
  // channel；projectId 从 projectDir 解析，非 tool param）。tool ID 精确匹配 shell 注册（toolExecution.ts
  // register('query_arc'/'arc_ledger_update'/'query_arc_summary'/'record_arc_audit')）。
  // 下游消费：arc-emergence-node（登记 + 避重复）/ write_chapter post-settle（关口判定 + 停滞检测 + 大审
  // 派发）/ Director chain-start 反哺（fetchLatestArcAudit）/ 4.4 arcSnapshot。
  //
  // B01 三处同步核对（agent-tools.md checklist）：
  // - query_arc / query_arc_summary：读工具，classifyTool 默认 'read'（readonly/suggest/auto 全可用）→
  //   不进 toolPolicy WRITE_TOOLS/DIFF_TOOLS / UI WRITE_TOOLS（mirror query_promise / query_chapter_summary
  //   读工具零登记先例）。无 envelope → 无 UI 门静默丢风险。
  // - arc_ledger_update：**写工具**——缺省（autoApply 缺/false）产 field_patch envelope（field arc_registry）
  //   走 PatchReview 人审 → 三处同步第 2 处 toolPolicy.DIFF_TOOLS + 第 3 处 UI agentDiffSlice.WRITE_TOOLS
  //   已同 commit 登记（mirror story_decisions_update CR-B01 教训：漏第 3 处 = suggest 档 envelope 被工具
  //   结果循环顶部 toolId 门整条静默丢弃）。
  // - record_arc_audit：链内/入口层写工具（write_chapter post-settle 程序化 registry.execute，写
  //   closure_arc_summary DERIVED 表，**无 field_patch envelope**）→ 不进 toolPolicy 门（mirror
  //   materialize_chapter_summary 链内写工具定位——permission 由调用上下文保证）。

  // query_arc：读 project.yaml arc_registry（写手声明的弧节拍），可按 episodeId/arcRef 收窄 + 最近窗
  // cap 200 beats。读工具。
  registry.register(remoteToolProxy({
    id: 'query_arc',
    description: '读取项目的弧节拍账本（arc_registry：写手写时声明的卷弧/线弧/成长弧 advance/close 节拍，close 带 grounding）。可按 episodeId/arcRef 收窄（最近窗 200 beats）。弧涌现节点（避重复登记）/ 8.2 关口判定与停滞检测消费。',
    parameters: queryArcRequestSchema,
  }));

  // arc_ledger_update：bounded action 写 arc_registry（mirror promise_ledger_update）。
  registry.register(remoteToolProxy({
    id: 'arc_ledger_update',
    description: '提议对弧节拍账本（arc_registry）的 bounded 编辑（add_beat：episodeId+episodeIndex+arcRef+arcKind[volume|line|growth]+action[advance|close]，close 必带正文 grounding 原句）。缺省产 field_patch 供用户在 patch panel 审阅；arc-emergence 节点自动调时传 autoApply=true 直接落盘。幂等：同 (arcRef, episodeId, action) 覆盖。',
    parameters: arcLedgerUpdateRequestSchema,
  }));

  // query_arc_summary：读物化弧审快照（closure_arc_summary DERIVED——关口大审/停滞专注审产物），缺省每弧
  // 最新一行。读工具。
  registry.register(remoteToolProxy({
    id: 'query_arc_summary',
    description: '查询已物化的弧审快照（closure_arc_summary：卷弧闭合大审 / 停滞专注审的卷摘要 + findings，每弧最新）。可按 arcRef 收窄。Director 反哺（arcFeedback）/ 4.4 arcSnapshot / 停滞审防重消费。',
    parameters: queryArcSummaryRequestSchema,
  }));

  // record_arc_audit：arc-audit-agent 产物落 closure_arc_summary DERIVED 表（write_chapter post-settle
  // 程序化调用，非 LLM 直接调；autoApply 语义——DERIVED 快照可 drop 重建，无人审语义）。
  registry.register(remoteToolProxy({
    id: 'record_arc_audit',
    description: '把弧审结果（ArcAuditResult：arcSummary 卷摘要 + findings 六维）upsert 到 closure_arc_summary 派生表（同 arc_ref+audit_kind+to_episode_index 覆盖）。由 write_chapter 弧审收尾调用，一般无需手动调。',
    parameters: recordArcAuditRequestSchema,
  }));

  // ── Story 8.5 角色弧生产线（R1 弧设计写通道 + R2 集纲写通道，design §2.1/§3.2）──
  // 8.5 前生产端断线：growth_curve/pacing_curve/episode_outlines 全仓零生产工具。本三件 =
  // **独立设计轨写工具**（leader 对话 bounded action 写通道，非 story-sync
  // 管线——那是正文→设定反哺）。弧/集纲内容设计归 LLM 语义；投影/落盘归 shell handler 纯代码
  // （ADR-3）。tool ID 精确匹配 shell 注册（toolExecution.ts register('growth_curve_update'/
  // 'pacing_curve_update'/'episode_outlines_update')）。
  //
  // B01 三处同步核对（agent-tools.md checklist）：三件均**写工具**——缺省（autoApply 缺/false）产
  // field_patch envelope（field growth_curve/pacing_curve/episode_outlines）走 PatchReview 人审 →
  // 第 2 处 toolPolicy.DIFF_TOOLS + 第 3 处 UI agentDiffSlice.WRITE_TOOLS 已同 commit 登记（mirror
  // arc_ledger_update；漏第 3 处 = suggest 档 envelope 被工具结果循环顶部 toolId 门整条静默丢弃）。

  // growth_curve_update：编辑角色成长弧（每角色一条：出发状态/创伤缺憾/想要与需要/转折点/终点）。
  registry.register(remoteToolProxy({
    id: 'growth_curve_update',
    description: '编辑角色成长弧——为一个角色设计他如何变化：从什么状态出发（start_state）、带着什么创伤或缺憾（wound_or_lack）、想要什么（desire）、真正需要什么（need）、经历哪些转折点（turning_points）、最终变成什么样的人（end_state）。成长弧是一个角色由内而外的变化主线：每个角色在此有一总条成长弧，多个角色的弧并行发展、时间上相互重叠交织是常态（不必排队，不同角色的转变可以同章发生）。add_curve 为角色新建成长弧（该角色已有弧时只更新你给出的字段，其余保留）；update_curve 修改指定角色的弧；remove_curve 删除。转折点可经 linked_episode_ids 锚到集纲的某一集。',
    parameters: z.object({
      actions: z.array(growthCurveActionSchema).min(1).describe(
        '要执行的操作，按顺序生效。add_curve（curve：character_id 与 start_state 必填，其余字段可选——角色已有弧时只更新给出的字段） / update_curve（character_id + patch：要修改的字段，角色身份不可改） / remove_curve（character_id，不存在则忽略）。'
      ),
      autoApply: z.boolean().optional().describe(
        'true = 修改立即生效，不先请作者确认。仅当会话处于全权(auto)模式时才允许传 true；默认（不传或 false）你的修改会先呈现给作者，由作者决定是否采纳。首次带 true 的调用会被系统拦下，要求你先重读当前数据自审（逐条核对修改是否正确、是否遗漏既有内容）；随后带 selfReviewConfirmed: true 重发同一调用才会执行。'
      ),
      selfReviewConfirmed: z.boolean().optional().describe(
        'true=你已按系统提示完成自审（重读当前数据，逐条核对过本次修改无误）。首次 autoApply 调用被拦后重发时传 true。'
      ),
    }),
  }));

  // pacing_curve_update：编辑节奏设计曲线（每个 refId 一点的张弛设计，与情绪曲线同构）。
  registry.register(remoteToolProxy({
    id: 'pacing_curve_update',
    description: '编辑节奏设计曲线——为任意一集/一章/一场（refId）设定叙事张弛：intensity 紧张强度 0-10，可附 informationDensity 信息密度 / actionLevel 动作量 / recoveryLevel 喘息恢复 / note 备注。add_point 与 update_point 按 refId 设定或更新（同一处以最后一次为准），remove_point 删除。',
    parameters: z.object({
      actions: z.array(pacingCurveActionSchema).min(1).describe(
        '要执行的操作，按顺序生效。add_point / update_point（point：refId 与 intensity 0-10 必填，informationDensity/actionLevel/recoveryLevel/note 可选） / remove_point（refId）。'
      ),
      autoApply: z.boolean().optional().describe(
        'true = 修改立即生效，不先请作者确认。仅当会话处于全权(auto)模式时才允许传 true；默认（不传或 false）你的修改会先呈现给作者，由作者决定是否采纳。首次带 true 的调用会被系统拦下，要求你先重读当前数据自审（逐条核对修改是否正确、是否遗漏既有内容）；随后带 selfReviewConfirmed: true 重发同一调用才会执行。'
      ),
      selfReviewConfirmed: z.boolean().optional().describe(
        'true=你已按系统提示完成自审（重读当前数据，逐条核对过本次修改无误）。首次 autoApply 调用被拦后重发时传 true。'
      ),
    }),
  }));

  // emotion_curve_update：编辑情绪设计曲线（Story 5.2 工具，Director 为每场设定目标情绪）。
  // ⚠️ B01 追补（8.5 Step 5 latent finding）：5.2 只落了 shell handler（toolExecution.ts register），
  // agent 侧 builtin 注册三处同步全缺——runAgentWithExplicitSystem 的 allowedTools 经 registry.all().filter
  // 把未注册 id 静默滤掉（workflow.ts），Director auto 档从未见过此工具 → write-chapter「Director 已调
  // emotion_curve_update(autoApply=true) 持久化，不 surface」假定双输（既没落盘也没呈现），静默死路自 5.2 起。
  // director-agent.yaml L133-143 调用指令齐全，注册即激活。
  registry.register(remoteToolProxy({
    id: 'emotion_curve_update',
    description: '编辑情绪设计曲线——为每个场景（refId）设定这一场要让读者进入的目标情绪：sceneMood 场景氛围、sceneVad 情绪坐标、characters 在场角色的情绪状态、note 备注。add_point 与 update_point 按 refId 设定或更新（同一场景以最后一次为准），remove_point 删除。注意：章级的整体情绪目标不写进这条曲线，随你的回复内容输出即可。',
    parameters: z.object({
      actions: z.array(emotionCurveActionSchema).min(1).describe(
        '要执行的操作，按顺序生效。add_point / update_point（point：refId 必填，sceneMood/sceneVad/characters/note 可选） / remove_point（refId）。'
      ),
      autoApply: z.boolean().optional().describe(
        'true = 修改立即生效，不先请作者确认。仅当会话处于全权(auto)模式时才允许传 true；默认（不传或 false）你的修改会先呈现给作者，由作者决定是否采纳。首次带 true 的调用会被系统拦下，要求你先重读当前数据自审（逐条核对修改是否正确、是否遗漏既有内容）；随后带 selfReviewConfirmed: true 重发同一调用才会执行。'
      ),
      selfReviewConfirmed: z.boolean().optional().describe(
        'true=你已按系统提示完成自审（重读当前数据，逐条核对过本次修改无误）。首次 autoApply 调用被拦后重发时传 true。'
      ),
    }),
  }));

  // episode_outlines_update：编辑集纲（单一写通道两驱动——episode-planner 主产 + leader 直改）。
  registry.register(remoteToolProxy({
    id: 'episode_outlines_update',
    description: '编辑集纲。集纲是介于大纲与正文之间的一层规划：大纲把故事划成卷/阶段，集纲再把每卷细化成一集一集的剧情安排；一集大致对应一章的剧情单元，写正文时逐集展开成章。每集含：id、index、title、purpose 本集目的、summary 摘要、core_event 核心事件、character_progressions 角色进展（哪些角色在本集从什么状态走向什么状态，{characterId, from, to}，与成长曲线 turning_points.linked_episode_ids 对号）、emotional_beats 情绪节拍、pacing_beats 节奏节拍、foreshadowing 伏笔、payoffs 回收、hook 钩子、phase_ref 本集属于大纲哪一卷/阶段（引用大纲 phases 的 id；引用不存在的 id 会被保留并提示你修正）。add_episode 新增一集（须完整，id 重复会被拒绝——改既有集请用 update_episode）；update_episode 修改指定集（只更新给出的字段）；remove_episode 删除。',
    parameters: z.object({
      actions: z.array(episodeActionSchema).min(1).describe(
        '要执行的操作，按顺序生效。add_episode（episode：完整的一集，id、index、title 必填；同批重复 id 会被拒绝） / update_episode（episodeId + patch：要修改的字段，集身份 id 不可改；要脱离卷可显式传 null 清除 phase_ref） / remove_episode（episodeId，不存在则忽略；被删集仍有 scene_graph/promise_registry/growth_curve 引用时会随结果提示）。'
      ),
      autoApply: z.boolean().optional().describe(
        'true = 修改立即生效，不先请作者确认。仅当会话处于全权(auto)模式时才允许传 true；默认（不传或 false）你的修改会先呈现给作者，由作者决定是否采纳。首次带 true 的调用会被系统拦下，要求你先重读当前数据自审（逐条核对修改是否正确、是否遗漏既有内容）；随后带 selfReviewConfirmed: true 重发同一调用才会执行。'
      ),
      selfReviewConfirmed: z.boolean().optional().describe(
        'true=你已按系统提示完成自审（重读当前数据，逐条核对过本次修改无误）。首次 autoApply 调用被拦后重发时传 true。'
      ),
    }),
  }));

  // ── Story 8.6 冷启动创作流引导（R2 灵感入档 / R3 深度偏好 / R4 作者档案，design §3.1）──
  //
  // 8.6 前这些字段无任何 leader 写通道（研究 B §3：genre_contract_update 只覆盖题材承诺域）。
  // 本三件 = 引导落盘端（leader 对话用）：灵感/偏好/观察内容归 LLM 语义；merge/校验/落盘归 shell
  // handler 纯代码（ADR-3）。tool ID 精确匹配 shell 注册（toolExecution.ts register(
  // 'creative_brief_update'/'creative_preferences_update'/'author_profile_update')）——remoteToolProxy
  // 按 id 路由，漏注册 = 工具调不通。
  //
  // B01 三处同步核对（agent-tools.md checklist）：
  // - creative_brief_update / creative_preferences_update：缺省（autoApply 缺/false）产 field_patch
  //   envelope（field creative_brief / creative_preferences）走 PatchReview 人审 → 第 2 处
  //   toolPolicy.DIFF_TOOLS 本步已登记；第 3 处 UI agentDiffSlice.WRITE_TOOLS 归 Step 6 同步。
  // - author_profile_update：缺省产**专用** author_profile_patch envelope（机器级档案文件非 creative
  //   field，PatchReviewPanel 装不下，mirror setting_md_update 专用分流）→ UI 专用卡 + author-profile:apply
  //   IPC（Step 2 handler + accept IPC 已落，UI 卡归 Step 6）；**不进 UI WRITE_TOOLS**（专用分流，
  //   design §4 落点表明示）。
  // - autoApply 自审闸门（CR-001）：三件参数 schema 均带 autoApply + selfReviewConfirmed 双参数
  //   （漏 selfReviewConfirmed = zod strip 后闸门永拦死循环——8.5 教训红线）。
  // - 描述说人话双规则（agent-tools.md :89-109）：说作用不说实现 + 特殊名词就地解释——读者是
  //   写小说的 agent，读不到源码/文档/UI。

  // creative_brief_update：灵感入档 + 创作基调（冷启动第一问的落盘端）。
  registry.register(remoteToolProxy({
    id: 'creative_brief_update',
    description:
      '记录或更新这个项目的创作初衷：作者最初的一句话灵感（rawRequirement 保留作者原话，后续所有规划都会参考它）、题材（genre）、主题（theme，这个故事归根结底想讲什么）、基调（tone）、目标读者（audience）、篇幅（length）、故事结构骨架（structure_pattern，不确定就不填当自由起步）、绝不写的内容（taboos）、作者的特殊要求（userConstraints）。作者在对话里说出灵感、改口风、补禁忌时用它入档；只改你给出的字段，其余保留。题材承诺与世界规则种子不在此——那是 genre_contract_update 的领地。默认你的修改会先呈现给作者，由作者决定是否采纳；全权档可直接生效。',
    parameters: z.object({
      updates: z.object({
        genre: z.string().optional().describe('题材（如 都市异能 / 仙侠 / 无限流）'),
        theme: z.string().optional().describe('主题——这个故事归根结底想讲什么'),
        tone: z.string().optional().describe('基调（如 冷峻 / 热血 / 温柔治愈）'),
        audience: z.string().optional().describe('目标读者'),
        length: z.string().optional().describe('篇幅（如 百万字长篇 / 三十万中篇）'),
        structure_pattern: structurePatternSchema.optional().describe(
          '故事结构骨架：anchor-single 锚点单线 / lotus-converging 总分总莲花 / main-sub-dual 主副双线 / progressive-jigsaw 递进阶梯拼图 / parallel-weak 并列弱主线 / triple-interactive 三线交互 / blank 空白自由起步。不确定就不填。'
        ),
        rawRequirement: z.string().optional().describe('灵感原文——作者原话，逐字保留不作改写'),
        taboos: z.array(z.string()).optional().describe('绝不写的内容清单'),
        userConstraints: z.array(z.string()).optional().describe('作者的特殊要求清单'),
      }).describe('要改的字段——只给要改的，没给的一律保留原值'),
      autoApply: z.boolean().optional().describe(
        'true = 修改立即生效，不先请作者确认。仅当会话处于全权(auto)模式时才允许传 true；默认（不传或 false）你的修改会先呈现给作者，由作者决定是否采纳。首次带 true 的调用会被系统拦下，要求你先重读当前数据自审（逐条核对修改是否正确、是否遗漏既有内容）；随后带 selfReviewConfirmed: true 重发同一调用才会执行。'
      ),
      selfReviewConfirmed: z.boolean().optional().describe(
        'true=你已按系统提示完成自审（重读当前数据，逐条核对过本次修改无误）。首次 autoApply 调用被拦后重发时传 true。'
      ),
    }),
  }));

  // creative_preferences_update：作者工作方式偏好四轴 + 备注（冷启动问偏好的落盘端）。
  registry.register(remoteToolProxy({
    id: 'creative_preferences_update',
    description:
      '记录或更新这个项目的作者工作方式偏好——作者希望大纲铺多细、角色成长弧什么时候列、世界设定铺多厚、人物卡填多全。四轴彼此独立（世界设定深的作者可能大纲只要骨架，不要替作者拉齐）：outline_depth 大纲细度（skeleton 骨架——只定主线与阶段，细节写时再长 / volume 分卷——定卷级目标，章不预定 / chapter 逐章——写前把章排细）；arc_timing 成长弧时序（upfront 动笔前列完 / as_you_go 边写边列——写若干章人物立起来后再列）；world_depth 世界深度（shell 空壳后填——最小世界起步用到再补 / upfront 先铺——动笔前铺到能支撑故事）；character_depth 人物深度（framework 框架——核心欲望加身份框架，细节随写随长 / full 全填——动笔前把人物卡填全）。只记作者明确答过的轴，没答过的不要替他填（未问等于标准档）；note 可记作者的原话。默认你的修改会先呈现给作者，由作者决定是否采纳；全权档可直接生效。',
    parameters: z.object({
      updates: z.object({
        outline_depth: outlineDepthAxisSchema.optional().describe('大纲细度：skeleton 骨架 / volume 分卷 / chapter 逐章'),
        arc_timing: arcTimingAxisSchema.optional().describe('成长弧时序：upfront 动笔前列 / as_you_go 边写边列'),
        world_depth: worldDepthAxisSchema.optional().describe('世界深度：shell 空壳后填 / upfront 动笔前先铺'),
        character_depth: characterDepthAxisSchema.optional().describe('人物深度：framework 框架 / full 全填'),
        note: z.string().max(4000).optional().describe('作者关于工作方式的原话备注'),
      }).describe('问到的偏好轴——只给作者明确答过的，没答过的轴不填（未问等于标准档）'),
      autoApply: z.boolean().optional().describe(
        'true = 修改立即生效，不先请作者确认。仅当会话处于全权(auto)模式时才允许传 true；默认（不传或 false）你的修改会先呈现给作者，由作者决定是否采纳。首次带 true 的调用会被系统拦下，要求你先重读当前数据自审（逐条核对修改是否正确、是否遗漏既有内容）；随后带 selfReviewConfirmed: true 重发同一调用才会执行。'
      ),
      selfReviewConfirmed: z.boolean().optional().describe(
        'true=你已按系统提示完成自审（重读当前数据，逐条核对过本次修改无误）。首次 autoApply 调用被拦后重发时传 true。'
      ),
    }),
  }));

  // author_profile_update：作者档案观察笔记（跨项目沟通层，隔几次互动记一笔，append-only）。
  registry.register(remoteToolProxy({
    id: 'author_profile_update',
    description:
      '往作者档案里记一条关于这位作者的观察笔记——写作水平、习惯、沟通偏好（例如「偏好先看例子再听原理」「对网文术语不熟，需要就地解释」）。档案是跨项目的作者画像，只增不删，用来在后续对话中调整你的解释密度与问法；它不是创作素材，不要把本项目的人物设定、剧情灵感记进去。一条只记一个观察，保持短句。默认你的记录会先呈现给作者，由作者决定是否采纳；全权档可直接生效。',
    parameters: z.object({
      // CR-018（8.6 BMad CR）：note 长度上限 4000——与 shared-contracts IPC schema / shell handler
      // 校验同步（LLM 失控超长直进机器级档案文件）。
      note: z.string().min(1).max(4000).describe('要记的观察，一条一个观察的短句'),
      autoApply: z.boolean().optional().describe(
        'true = 修改立即生效，不先请作者确认。仅当会话处于全权(auto)模式时才允许传 true；默认（不传或 false）你的修改会先呈现给作者，由作者决定是否采纳。首次带 true 的调用会被系统拦下，要求你先重读当前数据自审（逐条核对修改是否正确、是否遗漏既有内容）；随后带 selfReviewConfirmed: true 重发同一调用才会执行。'
      ),
      selfReviewConfirmed: z.boolean().optional().describe(
        'true=你已按系统提示完成自审（重读当前数据，逐条核对过本次修改无误）。首次 autoApply 调用被拦后重发时传 true。'
      ),
    }),
  }));

  // ── Story 7.4 cross-chapter feedback ledger（ADR-3 / design §2.2）──
  // 独立持久层（非 project.yaml）中转链段 artifact 跨章：feedback-ledger-node（链尾）写 review.latest /
  // emotion_verify_result / completeness_verify_result；write_chapter chain-start 读上一章填 Director feedback
  // var（Step 2 接通激活 5.3/4.4/7.3 三段）。Mirror write_world_events / query_world_slice via remoteToolProxy
  // （统一 toolExecution channel；projectId 从 projectDir 解析，非 tool param）。classifyTool='read'（chain 内部
  // 节点调用非 LLM 直接调；permission 由 chain 节点调用上下文保证，mirror write_world_events 处理）。
  registry.register(remoteToolProxy({
    id: 'feedback_ledger_write',
    description: '把链段审核/验证 artifact 写入 cross-chapter 反馈账本（供下一章 Director chain-start 读）。同 episode 同 key 重跑覆盖。由 feedback-ledger-node（链尾节点）调用，非 LLM 直接调。',
    parameters: feedbackLedgerWriteRequestSchema,
  }));

  registry.register(remoteToolProxy({
    id: 'feedback_ledger_read',
    description: '读 cross-chapter 反馈账本（单 key 或单 episode 全 key）。write_chapter chain-start 读上一章三 artifact 填 Director feedback var。',
    parameters: feedbackLedgerReadRequestSchema,
  }));

  // Git
  registry.register(remoteToolProxy({
    id: 'git_status',
    description: 'Show the working tree status of the project git repository.',
    parameters: z.object({}),
  }));

  registry.register(remoteToolProxy({
    id: 'git_log',
    description: 'Show recent git commit history.',
    parameters: z.object({
      depth: z.number().int().positive().optional().describe('Number of commits to show (default 20)'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'git_commit',
    description: 'Stage all tracked and untracked changes, then create a git commit. WARNING: this commits everything in the working tree — use git_status first to verify what will be included.',
    parameters: z.object({
      message: z.string().describe('Commit message'),
      author: z.object({
        name: z.string(),
        email: z.string(),
      }).optional().describe('Commit author (defaults to Closure Agent)'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'git_diff',
    description: 'Show changed files in the working tree.',
    parameters: z.object({
      filepath: z.string().optional().describe('Specific file to check (default: all files)'),
    }),
  }));

  // ── Story 3.6 WP3（R1 / design D8）：wiki 研究 read 工具 ──
  // 站点注册表驱动（shell research/wikiSites.ts：moegirl-cn 官方 opensearch 前缀 +
  // moegirl-uk 镜像 list=search 全文）。Mirror query_craft：remoteToolProxy → 统一
  // toolExecution channel（无专用 IPC）；classifyTool 默认 'read'（readonly/suggest/auto
  // 全可用）；网络全在 shell handler（agent 纯编排零网络，spec/agent/agent-tools.md 注入
  // 边界）——netFetch 吃系统代理 + per-host 节流 + never-throws 友好降级。
  registry.register(remoteToolProxy({
    id: 'wiki_search',
    description: '搜索 wiki 站点（默认萌娘百科官方+镜像双站合并去重）。官方站是标题前缀搜索（可试更短前缀），镜像站是全文搜索；返回词条标题+URL+摘要。词条标题常含全角括号（如「阿米娅（明日方舟）」）——拿到准确标题后用 wiki_read 读全文。',
    parameters: z.object({
      query: z.string().min(1).describe('搜索词。官方站按标题前缀匹配，镜像站全文匹配'),
      site: z.string().optional().describe("站点 id：'moegirl-cn'（官方站，前缀搜索）/ 'moegirl-uk'（镜像站，全文搜索）/ 'auto'（默认，双站合并去重）"),
      limit: z.number().int().optional().describe('返回条数上限（默认 10，最大 10）'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'wiki_read',
    description: '读取 wiki 词条全文（默认官方站，失败自动降级镜像站）。返回轻清洗后的 wikitext（去引用脚注/注释/隐藏块，保留模板，16000 字符截断）+ 来源 URL + 许可 + 检索日期。标题须与 wiki_search 返回的一致——注意全角括号。',
    parameters: z.object({
      title: z.string().min(1).describe('词条标题（建议先用 wiki_search 拿准确标题；注意全角括号）'),
      site: z.string().optional().describe("站点 id（默认 'moegirl-cn' 官方站；读取失败自动降级镜像站）"),
    }),
  }));

  // ── Story 3.6 WP4（R2 / design D9）：web_search 引擎链 ──
  // 零 key 默认链开箱即用（localhost SearXNG 探测命中插队 → 必应 → 百度 → DDG 海外兜底），
  // 单引擎超时/反爬/无结果自动回退下一引擎；可配升级层（SearXNG/Tavily/博查/AnySearch）。
  // 结果每条标注来源引擎；全败时返回各引擎不可用原因。Mirror query_craft / wiki_search：
  // remoteToolProxy → 统一 toolExecution channel（无专用 IPC）；classifyTool 默认 'read'
  // （readonly/suggest/auto 全可用）；网络全在 shell handler（netFetch 吃系统代理 +
  // EngineGate per-host 节流 + TTL 缓存），agent 纯编排零网络。
  registry.register(remoteToolProxy({
    id: 'web_search',
    description: '网页搜索（多引擎链自动回退，零配置默认可用：本地 SearXNG 探测 → 必应 → 百度 → DuckDuckGo）。单引擎超时/反爬/无结果自动尝试下一引擎；可配升级层（SearXNG/Tavily/博查/AnySearch）。结果标注来源引擎；全部失败时返回各引擎不可用原因。适合查资料/事实核验/时效信息；查萌娘百科词条优先用 wiki_search。',
    parameters: z.object({
      query: z.string().min(1).describe('搜索词'),
      limit: z.number().int().positive().optional().describe('返回条数上限（默认 10，最大 10）'),
    }),
  }));

  // ── Story 3.6 WP5（R3/R12 / design D10）：web_fetch + render_page 研究 read 工具 ──
  // web_fetch：SSRF 守卫 + content-type dispatch（HTML→turndown MD / 文本原样 / PDF·图片
  // 友好提示改走 parse_document·analyze_image）+ cap + provenance。render_page：隐藏沙箱
  // 窗口渲染态捕获（textContent 全文 + 分段滚动截图）——视觉排版/CSS 叙事/JS 渲染页专用。
  // Mirror wiki_* / web_search：remoteToolProxy → 统一 toolExecution channel（无专用 IPC）；
  // classifyTool 默认 'read'（readonly/suggest/auto 全可用）；网络/窗口全在 shell handler，
  // agent 纯编排零网络（spec/agent/agent-tools.md 注入边界）。
  registry.register(remoteToolProxy({
    id: 'web_fetch',
    description: '抓取网页内容（任意公网 http/https URL）。按内容类型分发：HTML 转成干净的 Markdown（自动去脚本/样式/导航），纯文本/Markdown/JSON/XML 返回原文；PDF 会提示改用 parse_document、图片会提示改用 analyze_image。输出带来源 URL 与检索日期，默认截断 16000 字符。适合抓文章/资料页正文。',
    parameters: z.object({
      url: z.string().min(1).describe('要抓取的 http/https URL'),
      maxChars: z.number().int().positive().optional().describe('返回内容字符上限（默认 16000，最大 32000）'),
    }),
  }));

  registry.register(remoteToolProxy({
    id: 'render_page',
    description: '渲染态捕获网页（隐藏沙箱浏览器窗口加载后提取）。返回双通道：textContent 全文（含折叠块等隐藏文本）+ 分段滚动截图（存本地路径，可继续用 analyze_image 做视觉分析）。适用场景：视觉排版/CSS 叙事/JS 渲染页（如 SCP 基金会文档）；普通文本页用 web_fetch 更省。可选强制展开折叠块。耗时数秒，仅在 web_fetch 拿不到渲染后内容时使用。',
    parameters: z.object({
      url: z.string().min(1).describe('要渲染捕获的 http/https URL'),
      expandCollapsibles: z.boolean().optional().describe('是否注入 CSS 强制展开折叠块（默认 false）'),
      includeText: z.boolean().optional().describe('是否返回文本通道（默认 true）'),
    }),
  }));

  // ── Story 3.6 WP6（R10 / design D11）：parse_document 研究 read 工具 ──
  // 本地文档 → Markdown（PDF/DOCX/TXT/MD；EPUB 暂不支持）。PDF 端点优先（已配
  // MinerU/docling/custom 端点且探活 ok 时先走端点，OCR/版面质量更好），未配置或
  // 失败自动降级内置解析（PDF 文本层 / mammoth / 直读）并记备注；扫描件（无文本层）
  // 会提示改走 analyze_image 视觉路径或配置解析端点。Mirror wiki_* / web_fetch：
  // remoteToolProxy → 统一 toolExecution channel（无专用 IPC）；classifyTool 默认
  // 'read'（readonly/suggest/auto 全可用）；网络/FS 全在 shell handler，agent 纯编排
  // 零网络（spec/agent/agent-tools.md 注入边界）。filePath 限项目内相对路径（防任意
  // 文件读取）。
  registry.register(remoteToolProxy({
    id: 'parse_document',
    description: '解析项目内的本地文档为 Markdown（支持 PDF / DOCX / TXT / MD，filePath 传项目内相对路径）。PDF 优先走已配置的解析端点（MinerU/docling，OCR 与版面质量更好；可在设置「研究与视觉」配置），未配置或失败时自动降级内置文本层解析并记备注；疑似扫描件（无文本层）会提示改用 analyze_image 视觉识别或配置解析端点。输出默认截断 32000 字符（最大 64000），并标注解析来源。',
    parameters: z.object({
      filePath: z.string().min(1).describe('项目内文档相对路径（如 research/设定集.pdf、设定/角色卡.docx）'),
      maxChars: z.number().int().positive().optional().describe('返回内容字符上限（默认 32000，最大 64000）'),
    }),
  }));

  // ── Story 3.6 WP7（R11 / design D5）：analyze_image 研究 read 工具 ──
  // 单图视觉分析：imagePath（项目内相对路径）或 imageUrl（公网 http/https）二选一 + prompt
  // （写清要图做什么：OCR 识别文字 / 描述画面 / 提取设定信息等）。视觉模型已配置时直接后台
  // 分析返回文本；未配置时返回 manual 导出协议（图已存本地 + 复制剪贴板 + suggestedPrompt）——
  // 把协议原样转告用户手动分析，等结果贴回对话再继续，绝不自行编造图片内容。
  // Mirror wiki_* / parse_document：remoteToolProxy → 统一 toolExecution channel（无专用 IPC）；
  // classifyTool 默认 'read'（readonly/suggest/auto 全可用）；视觉调用全在 shell 侧 WP1 vision
  // seam（runVisionAnalysis 三层分派），agent 纯编排零网络（spec/agent/agent-tools.md 注入边界）。
  registry.register(remoteToolProxy({
    id: 'analyze_image',
    description: '分析一张图片（视觉识别：OCR 图中文字 / 描述画面内容 / 提取图中设定信息等，prompt 写清要看什么）。图片来源二选一：imagePath（项目内相对路径，如 .orison/research-media/ 截图）或 imageUrl（公网 http/https 图片地址）。已配置视觉模型时直接返回分析文本；未配置时返回手动模式协议——图片已保存到本地并复制进剪贴板，把协议里的提示词原样转告用户，请用户丢第三方识图应用后把结果贴回对话。',
    parameters: z.object({
      imagePath: z.string().min(1).optional().describe('项目内图片相对路径（如 .orison/research-media/1739...png、设定/参考图.jpg）'),
      imageUrl: z.string().min(1).optional().describe('公网图片 URL（http/https，10MB 下载上限）'),
      prompt: z.string().min(1).describe('分析指令，写清要图做什么：如「识别图中全部文字」「描述画面构图与氛围」「提取图中角色的能力设定」'),
    }).refine(d => Boolean(d.imagePath || d.imageUrl), {
      message: 'imagePath 或 imageUrl 必须提供其一',
    }),
  }));

  // ── Story 3.6 WP8（R4 / design D12）：researcher 深研究派发 leader tool（local tool）──
  // leader 深研究（多源/多跳/需综合）经此派发 researcher 子 agent（隔离上下文跑研究工具，蒸馏
  // 报告回传，不灌 leader 对话史）。挂载 = 路线 b（design D12 fallback，mirror 3.4 diagnose_impacts）：
  // shell createWorkflowRuntime() 空参无 externalSkillRoots（agentIpc.ts:69），.orison/agents/
  // 是项目级用户目录——无 app 级 agents root 可挂 → prompts/researcher-agent.yaml（ADR-4 单契约源）
  // + runAgentWithExplicitSystem allowedTools 白名单（研究只读工具，无写权限）。
  // 快查（单点事实）leader 直调 wiki_*/web_* 工具，不经此 tool（DEFAULT_CLOSURE_PROMPT Research 段）。
  registry.register(dispatchResearcherTool);

  // ── Story 8.6 R7（design D10/D11）：冷启动规划派发两工具（local tool）──
  // 「骨架共创 → 派发产草案 → 呈现人审」三段式（P2）的派发件：leader 与作者聊定骨架后经此把
  // 骨架交给后台规划子 agent（story-planner 产大纲+场景结构 / episode-planner 产集纲），子 agent
  // 经各自写工具产 patch 回流人审（档位过滤+闸门照走，零豁免）。mirror dispatch_researcher：
  // prompts/<role>.yaml（ADR-4 单契约源，spawn_agent 拿不到 yaml——研究 C 发现 1）+
  // runAgentWithExplicitSystem 白名单（story-planner = owns 两件 outline_update/scene_graph_update；
  // episode-planner = episode_outlines_update，不扩 scene_graph_update——挂锚归 leader 直改，GAP-1）。
  // classifyTool 默认 'read'（编排类不进 WRITE/DIFF——子 agent 写动作经各自 gated 工具过闸，
  // mirror write_chapter / dispatch_researcher）。
  registry.register(dispatchStoryPlannerTool);
  registry.register(dispatchEpisodePlannerTool);

  // ── 风格卡片 MVP（task 08-28-style-card-mvp A 路）：文风分析派发工具（local tool）──
  // 「作者贴片段 → 派发风格分析师产卡草案 → 作者人审采纳」的派发件（mirror dispatch-planners）。
  // 原文直传（D4 + 契约修订）：零参数——倒序取最近一条结构化风格片段提交（C 路标记行契约），
  // 机械提取载荷 verbatim——Leader 零转述；无提交 → 引导语让 leader 调 request_style_input
  // 规范收集。分析者无工具（allowedTools 空，mirror adjudicator 纯判断先例）；工具本体产专用
  // setting_md_patch envelope（settingId='style'）→ UI 按元数据 type 专用分流进既有
  // SettingMdPatchCard 人审（accept 重放 actions 落盘）——不 autoApply 直写。
  // classifyTool='diff'（toolPolicy DIFF_TOOLS，mirror setting_md_update 族：suggest 人审卡 /
  // readonly 拦）；无 autoApply 参数（autoApply 自审闸门天然不触发）。
  registry.register(dispatchStyleAnalyzerTool);

  // ── Story 3.6 WP9（R5/R6 / design D13）：策展两工具——研究产出双向落地（人审闭环核心 WP）──

  // save_craft_doc：研究结论策展入全局 craft KB（~/.orison/craft-kb/，跨项目参考库非项目数据）。
  // 写 research/<slug>.md（frontmatter id/craft_type/tags/source=URL+检索日期/source_note）→ shell
  // 直接 reindex → query_craft 即刻可检回。craft_type 开放 string（8 类词表先验非门禁，mirror
  // query_craft）。classifyTool='write'（toolPolicy WRITE_TOOLS——显式写用户库，readonly/suggest
  // 不可用 mirror write_file；skill-VM 路径 permission DEFAULT_RULES write/ask）。
  registry.register(remoteToolProxy({
    id: 'save_craft_doc',
    description: [
      '把研究结论/craft 知识策展保存进全局 craft 参考（~/.orison/craft-kb/，跨项目共享，query_craft 即刻可检回）。',
      'markdown 正文 + frontmatter（id/craft_type/tags/source 留 URL+检索日期 provenance）。适合存：值得复用的写作技法、题材调研结论、桥段/pattern 笔记、世界观素材。',
      formatCraftTypeVocab(),
    ].join('\n'),
    parameters: z.object({
      craft_type: z.string().min(1).describe(
        'craft 类型（见描述中的 craft_type 词表起步，也可自建更精确的值）',
      ),
      title: z.string().min(1).describe('文档标题（作文件名 slug 与索引名；建议清晰可检索）'),
      content: z.string().min(1).describe('markdown 正文（craft 内容本体；建议自带头部结构化摘要）'),
      tags: z.array(z.string().min(1)).optional().describe('正交标签（题材/组件关联，便于检索过滤）'),
      sourceUrl: z.string().min(1).optional().describe('来源 URL（wiki_read/web_fetch/web_search 拿到的出处；frontmatter source 留 provenance）'),
      sourceNote: z.string().min(1).optional().describe('来源备注（license/可信度/交叉验证情况等自由文本）'),
      filename: z.string().min(1).optional().describe('自定义文件名 slug（缺省从 title 派生；冲突自动加 -2 后缀不覆盖）'),
    }),
  }));

  // asset_cards_update：设定卡策展——研究产出（wiki/原作资料）落进本项目的 8 类 typed 设定卡。
  // bounded action（mirror scene_graph_update）→ field_patch 人审 → fieldSyncBridge 落盘 +
  // assetCardsWatcher reindex → query_story 检回。classifyTool='diff'（toolPolicy DIFF_TOOLS；
  // UI agentDiffSlice.WRITE_TOOLS 路由 → PatchReviewPanel）。批量重建归同1.2/拆书 E10（互补不重叠）。
  //
  // Story 2.2 WP-D（design §5.1）：autoApply 双档落盘（第 4 例，mirror emotion_curve_update /
  // setting_md_update DW-4）——auto 档（permissionMode==='auto'，KD1 复用档位不加旋钮）leader 传
  // autoApply=true → shell withProjectLock + onFieldEdited(source:'agent') 直接落盘（assetCardsWatcher
  // dir-watch 自动 reindex）；缺省/false → field_patch envelope 走 PatchReview 人审（3.6 行为不变）。
  registry.register(remoteToolProxy({
    id: 'asset_cards_update',
    description: '提议对项目设定卡（asset_cards，8 类 typed 卡：character/location/prop/organization/rule/visual_motif/lore/golden_finger）的 bounded 编辑（add_card/update_card/remove_card）。缺省不直接落盘——产 patch 供用户在 patch panel 审阅；接受后写入 project.yaml 并自动进 query_story 检索。全权(auto)档可传 autoApply=true 直接落盘（source=agent；locked 字段会被拒并自动降级回人审 patch）。add 需完整卡（id+type+name 必填，typed 引导字段可选）；update 浅合并 patch（未提供字段与 customFields(details) 保留）；remove 按 cardId 幂等。',
    parameters: z.object({
      // P16 (CR 2026-08-15): an EMPTY action list is a caller bug, not a
      // meaningful edit — rejected at the zod surface (the shell handler
      // mirrors the guard for lenient providers that bypass this schema).
      actions: z.array(assetCardActionSchema).min(1).describe(
        'Ordered bounded edits. ops: add_card (card: 完整 typed 卡，id+type+name 必填) / ' +
        'update_card (cardId + patch: 要改的字段浅合并，身份 id/type 不可改) / remove_card (cardId，不存在幂等跳过)。' +
        'add_card 重复 id 会被友好拒绝——改既有卡用 update_card。'
      ),
      autoApply: z.boolean().optional().describe(
        '直接落盘 + 重建索引（绕过人审，source=agent）。仅在会话 permissionMode 为 auto（全权）时传 true；缺省产 patch 走人审。首次带 true 的调用会被系统拦下，要求你先重读当前数据自审确认；随后带 selfReviewConfirmed: true 重发同一调用才会执行。'
      ),
      selfReviewConfirmed: z.boolean().optional().describe(
        'true=你已按系统提示完成自审（重读当前数据，逐条核对过本次修改无误）。首次 autoApply 调用被拦后重发时传 true。'
      ),
    }),
  }));

  // ── Story 2.2 WP-B（design §3）：setting_md_update——长文微观设定（settings/*.md）的 agent 写入路径 ──
  //
  // 2.3 建了 settings/*.md 存储 + 索引 + query_story 检回全链，但无 agent 写入工具（只有用户手编）。
  // bounded span 操作复用 E7 锚原语（locateSelection/splice 语义，shared-contracts passage-splice.ts，
  // 零新定位代码）：结构化字段 = bounded action、自由文本 = quote 锚 splice、全量替换仅限 create_file
  // （LLM 重写整篇长文 = 静默丢失，bounded span 让「改了什么/没改什么」在词级 diff 卡全程可见）。
  //
  // 双档落盘（mirror emotion_curve_update DW-4）：autoApply=true（permissionMode==='auto' 时 leader 才传，
  // KD1）→ shell 直接落盘 + reindex；缺省/false → 不写盘，产专用 setting_md_patch envelope
  // （before/after 全文 + actions）→ UI 专用词级 diff 卡 → accept 走 closure:accept-setting-md
  // IPC 重放 actions 落盘（非 DiffCard/passage 通路——passage accept 有「文件须在 tab 打开」前置，
  // Step 0 核实否决）。classifyTool='diff'（toolPolicy DIFF_TOOLS，mirror asset_cards_update）。
  registry.register(remoteToolProxy({
    id: 'setting_md_update',
    description: [
      '提议对项目长文设定文档（settings/<settingId>.md，markdown + frontmatter）的 bounded 段落级编辑。不直接落盘——产补丁供用户在对话卡片审阅（词级 diff）；接受后写入文件并自动进 query_story 检索。',
      '五个操作：create_file（仅新建整个文档：title+content）/ replace_span（anchor 锚定原文段 → replacement 替换）/ insert_after（锚定锚文本后插入——插新节就锚「## 标题」行）/ remove_span（删除锚定段）/ update_meta（改 frontmatter 的 type/tags/linked_entities）。',
      'quote 锚用法（关键）：quote 必须逐字引用当前文档原文（无模糊兜底，引用错一字即拒）；锚近唯一文本——优先标题行或整节首句；同文重复出现时给 prefix/suffix（前后约 20-50 字上下文）消歧，否则按 ambiguous 拒绝。不做全文替换——改既有文档一律用 span 操作。',
      '长文微观设定（体系详述/势力背景/地点氛围历史/详细世界规则）适合本文档；条目化设定走 asset_cards_update；题材承诺/世界规则种子走 genre_contract_update。',
    ].join('\n'),
    parameters: z.object({
      settingId: z.string().min(1).optional().describe(
        '目标文档 id（= 文件名 slug，如 magic-system）。span 操作与 update_meta 必填；create_file 可省（从 title 派生 slug，冲突自动加 -2 后缀）'
      ),
      actions: z.array(settingMdActionSchema).min(1).describe(
        '顺序应用的 bounded 编辑（逐 action 应用，任一失败整体拒绝不落盘）。锚定失败（找不到/多处命中）会整体拒绝并说明原因——重读原文修正 quote 后重试'
      ),
      autoApply: z.boolean().optional().describe(
        '直接落盘 + 重建索引（绕过人审）。仅在会话 permissionMode 为 auto（全权）时传 true；suggest 档缺省产补丁走人审。首次带 true 的调用会被系统拦下，要求你先重读当前数据自审确认；随后带 selfReviewConfirmed: true 重发同一调用才会执行。'
      ),
      selfReviewConfirmed: z.boolean().optional().describe(
        'true=你已按系统提示完成自审（重读当前数据，逐条核对过本次修改无误）。首次 autoApply 调用被拦后重发时传 true。'
      ),
    }),
  }));

  // ── Story 2.2 WP-E（design §5.5.2）：story_sync_apply——正文→设定反哺 applier（链段终态收尾）──
  //
  // write_chapter 在 route 终态（accept_as_truth / escalate）调此工具把 story-sync 提取的设定反哺 patches
  // 落盘或转 envelope 人审——**链段收尾工具非 leader 日常创作工具**（设定深化走 asset_cards_update /
  // setting_md_update，mirror write_world_events 链内写工具定位）。shell handler（storySyncHandlers）做
  // 机械门（creative-field 白名单 / merge-only / promise_registry 拒 CR-E7 / cap 8 / 版本锁）+ 投影
  // （asset_cards → update_card/add_card 浅合并 + schema 再校验；其他 field → 对象 merge + per-field
  // schema 校验）+ 双档落盘（autoApply=onFieldEdited(source:'agent') 直落 mirror emotionCurveHandlers；
  // 缺省 → per-field field_patch envelope（FULL 投影数据）供 PatchReview 人审）。classifyTool='diff'
  // （toolPolicy DIFF_TOOLS，readonly 对 LLM 拦截；write_chapter 直接 registry.execute 不受可见性过滤，
  // mirror writeWorldEvents 调用模式）。
  registry.register(remoteToolProxy({
    id: 'story_sync_apply',
    description: [
      '应用写章链段 story-sync 提取的设定反哺补丁（正文自由发挥的设定回收到知识库）。链段收尾由 write_chapter 调用，日常设定编辑请用 asset_cards_update / setting_md_update。',
      '机械门：只收 creative field merge 补丁（promise_registry 拒——读者债走 promise-emergence-node）；单次上限 8 条；版本过期补丁（字段在提取后被编辑过）会被丢弃。',
    ].join('\n'),
    parameters: z.object({
      runId: z.string().min(1).describe('链段 run id（patches 出处追踪）'),
      patches: z.array(fieldPatchEntrySchema).min(1).describe(
        'story-sync 提取的 merge 补丁（field ∈ creativeFieldKeys / action=merge / data 对象）'
      ),
      autoApply: z.boolean().optional().describe(
        '直接落盘（source=agent）。仅 permissionMode=auto 且 route 终态（accept_as_truth，或 escalate+放手采信——后者语义已转 accept）时由 write_chapter 传 true；缺省产 field_patch envelope 组走 PatchReview 人审。LLM 直接带 true 调用会被自审闸门拦下，重发自审确认（selfReviewConfirmed: true）后执行'
      ),
      selfReviewConfirmed: z.boolean().optional().describe(
        'true=你已按系统提示完成自审（重读当前数据，逐条核对过本次补丁无误）。首次 autoApply 调用被拦后重发时传 true。'
      ),
      chapterNote: z.string().optional().describe('章节出处注记（如「第 12 章 story-sync 提取」），落进 sync event reason / envelope note'),
    }),
  }));

  // ── 风格卡片 MVP（08-28 C 路）：request_style_input——请作者提供文风参考片段（UI 请求工具）──
  // 调用后界面弹出「风格片段」对话框；作者把想模仿的小说原文粘贴进去（可选附备注）提交，
  // 提交内容作为一条新的用户消息回到对话（标记行结构化，shared-contracts
  // buildStyleInputMessage 单源），leader 据此派发风格分析。纯 UI 请求零数据写入——
  // classifyTool 默认 'read'（三档可用零 toolPolicy 登记；无补丁无人审面，无三处同步）。
  registry.register(remoteToolProxy({
    id: 'request_style_input',
    description: [
      '请作者提供文风参考：调用后界面会弹出一个对话框，作者把想模仿的小说原文片段（至少 300 字）粘贴进去，可选附一句备注说明喜欢它哪方面；提交后内容会作为一条新的用户消息回到对话，你再基于它继续（如分析文风、建立风格卡）。',
      '适合时机：冷启动主动询问作者文风偏好，或作者要求建立/更换风格卡时。作者也可能取消或跳过——那时改用对话直接询问即可，不要自行编造片段。',
    ].join('\n'),
    parameters: z.object({
      // CR-025：超长 prompt **截断不硬拒**（与 shell 侧 styleInputHandlers 的 PROMPT_MAX_CHARS
      // 截断口径一致）——.max(300) 会让 leader 一段长提示语整次调用吃难解的 schema 错误。
      prompt: z.string().min(1).transform((v) => v.slice(0, 300)).optional().describe(
        '可选，显示在对话框顶部的提示语，告诉作者贴什么样的片段（如「贴一段你最想模仿的原文，最好是带场景和对话的完整段落」）。超过 300 字会被截断；不传则显示默认说明'
      ),
    }),
  }));
}
