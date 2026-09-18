import type { AgentContract } from '@orison/shared-contracts';

const CONTRACTS: AgentContract[] = [
  {
    id: 'intake-agent',
    role: '需求解析',
    goal: '将用户需求转化为结构化创作 brief',
    owns: ['creative_brief'],
    reads: [],
    must: ['输出结构化创作 brief'],
    mustNot: ['直接生成故事内容'],
    outputSchemaName: 'creativeBriefSchema',
    qualityGates: ['has_genre', 'has_tone'],
  },
  {
    id: 'asset-loader-agent',
    role: '资产加载',
    goal: '基于创作 brief 生成世设、8 类 typed 资产卡和人物关系图',
    owns: ['world_setting', 'asset_cards', 'relationship_graph'],
    reads: ['creative_brief'],
    // Story 2.4：契约对齐 asset_cards 8 类卡模型（ADR-4 双重表示——yaml prompt ↔ CONTRACTS[]
    // 必须手动同步）。must/qualityGates 镜像 prompts/asset-loader-agent.yaml。runtime 接通属 Epic 4。
    must: [
      '按 asset_cards 8 类卡模型（character/location/prop/organization/rule/visual_motif/lore/golden_finger）产出 typed 资产卡',
      '产出 world_setting（含 world_constitution 世界承诺）',
      '每张卡至少填 id/type/name + 该类关键 per-type 引导字段',
      // Story 2.3（design §2.2）：为每张卡标 tier（core/micro）--cross-scene 奠基性设定=core，
      // scene-specific 详述=micro。编译器 compileSettingPrefix 据此决定进稳定前缀 vs 仅目录。
      // 范式判据：tier 标注是语义判断归 LLM（写在 prompt 指令里），编译器只读 tier 做结构提取（纯代码）。
      '为每张卡标 tier（core/micro）--cross-scene 奠基性设定=core，scene-specific 详述=micro',
    ],
    mustNot: [
      '修改创作 brief',
      '输出 schema 外字段（styleGuide/references/worldRules/characterTemplates 等旧形态——入库静默丢弃）',
      '缺数据时静默编造与 brief 矛盾的设定'
    ],
    outputSchemaName: 'assetLoaderOutputSchema',
    qualityGates: ['has_world_setting', 'has_asset_cards', 'asset_cards_have_valid_type'],
  },
  {
    id: 'story-planner-agent',
    role: '故事规划',
    goal: '生成或修订总大纲与多线场景结构',
    owns: ['outline', 'scene_graph'],
    reads: ['creative_brief', 'world_setting', 'asset_cards', 'relationship_graph'],
    must: ['明确主题和核心冲突', '包含主要转折点', '产出真·多线 scene_graph（非 minimal 单线）'],
    mustNot: ['直接写章节正文', '修改世设'],
    outputSchemaName: 'outlineV2Schema',
    // dogfood R2（task 08-25-dogfood-round2）：三项 qualityGates 已接线运行时真验——agent 侧
    // outline_update 工具包装层（tool/outline-quality-gates.ts）对每次大纲新值逐项验，缺失 →
    // Warn 议题挂 tool result（chat 可见，LLM 当轮可补全）+ field_patch envelope metadata
    // （qualityGateIssues），不阻断人审落盘。
    qualityGates: ['has_central_conflict', 'has_major_turning_points', 'has_ending_direction'],
  },
  {
    id: 'episode-planner-agent',
    role: '集纲规划',
    goal: '按大纲卷/阶段切分集纲并挂钩成长曲线',
    // Story 8.5 owns 收窄：promise_registry 的实际写入 = leader 对话（promise_ledger_update 工具）+
    // promise-emergence-node 涌现自动落盘（链段节点，不进 CONTRACTS[]，mirror world-amender 子 agent 模式，
    // Story 6.5）——episode-planner 从未产 Promise，stale owns 修正。reads 增 scene_graph：排集纲需知
    // 多线场分布（story-planner 产 scene_graph）。
    owns: ['episode_outlines'],
    reads: ['outline', 'scene_graph', 'growth_curve', 'pacing_curve', 'emotion_curve', 'asset_cards', 'relationship_graph', 'world_setting'],
    // Story 8.5（ADR-4 双重表示——镜像 prompts/episode-planner-agent.yaml 修真，两处手动同步）：outputs.schema
    // 空引用 episodePlannerOutputSchema 修正为真实导出的 episodeOutlinesSchema（shared-contracts）；must/mustNot/
    // qualityGates 逐条镜像 yaml 契约元数据（phase 挂钩 / 卷 climax 落点 / character_progressions 对齐 growth_curve /
    // episode_outlines_update bounded actions 产出路径——工具本体 Step 5 注册）。
    must: [
      '每集包含目的、摘要、核心事件、角色进展、情绪节拍、节奏节拍、伏笔、回收和钩子',
      '按大纲 phases（卷/阶段）切分集纲，每集挂 phase_ref（引用 phases[].id）',
      '卷的 climax/hook 由该卷末集兑现（高潮是卷内积累的释放点）',
      'character_progressions 对齐 growth_curve：转折点所在的集写 from→to（与 turning_points.linked_episode_ids 对号）',
      '经 episode_outlines_update 工具产出 bounded actions（add_episode / update_episode / remove_episode）',
    ],
    mustNot: ['让集纲与总大纲转折冲突', '写正文', '修改总大纲或改写成长曲线（只读消费）'],
    outputSchemaName: 'episodeOutlinesSchema',
    qualityGates: ['each_episode_has_core_event', 'foreshadows_have_payoff_plan', 'no_conflict_with_outline'],
  },
  {
    id: 'draft-writer-agent',
    // Story 8.4（A2/A9 agent 化）：角色扩为「先调查后动笔」——动笔前用只读查询工具自查全书资料产调查简报，
    // 再写正文（ADR-17 节点柔性；4.5「写手单发无工具」取舍由 8.4 推翻，prd 拍板 2）。契约元数据镜像
    // prompts/draft-writer-agent.yaml（ADR-4 双重表示手动同步）。
    role: '初稿撰写',
    goal: '动笔前自查全书资料产出调查简报，再根据章节任务生成初稿',
    owns: [],
    // Story 6.5：foreshadow_registry → promise_registry（draft-writer 读本章 Promise 任务 brief #7）。
    // 自查期只读消费的资料面（旧章原文/摘要/认知/伏笔等）经只读查询工具，不走 creative field reads。
    reads: ['outline', 'episode_outlines', 'asset_cards', 'world_setting', 'growth_curve', 'promise_registry'],
    must: [
      '写作前自行查询需要的资料（一手材料，不信二手），查什么由自己判断',
      '调查简报的关键事实必带出处（第几章/哪张卡/哪个摘要）',
      '按章节目标输出正文',
    ],
    mustNot: ['修改大纲或集纲', '使用任何写入类工具（写手只读，状态反哺走任务卡编译注入）'],
    outputSchemaName: 'draftOutputSchema',
    qualityGates: ['meets_word_target', 'brief_sources_grounded'],
  },
  {
    id: 'continuity-memory-agent',
    role: '连续性记忆',
    goal: '从草稿中提取连续性记忆',
    owns: [],
    // Story 6.5：foreshadow_registry → promise_registry。
    reads: ['asset_cards', 'promise_registry'],
    must: ['提取角色状态和时间线'],
    mustNot: ['修改草稿内容'],
    outputSchemaName: 'continuityMemorySchema',
    qualityGates: ['has_character_state'],
  },
  {
    id: 'multi-review-agent',
    role: 'Reader-Audit 双层审核',
    goal: '一致性维（ConStory 19 子类语义矛盾）+ 叙事特征维（anti-slop）+ 承诺违背维（GenreContract，2.5）双层审核，产出 grounded verdict',
    owns: [],
    // Story 6.5：foreshadow_registry → promise_registry（Reader-Audit 消费 Promise 落地检查，Phase D2 接入）。
    // Story 2.6（CR-A08）：决策落地维消费 novel.story_decisions → decidedDecisions templateVar（assemble
    // 注入，非 creative-field contextBuilder 通道）——story_decisions 是 novel 段数据不进 reads（reads
    // 类型 = CreativeFieldKey 数组）；数据依赖在此注释 + must 决策落地维条目表达。
    // C1.2（R6）：叙事特征维消费 lint_report 静态命中作 L1 同族软信号 → lintReport templateVar（链段
    // lint-node 产 artifact，非 creative field，不进 reads——mirror route_decision / story_decisions 注记
    // 模式：reads 类型约束为 CreativeFieldKey，链段 artifact 依赖经注释 + must 条目表达；artifact 级
    // 读取在 Reader-Audit 节点机会主义消费，不在 READER_AUDIT_CONTRACT.requiredArtifactKeys——老链无
    // lint-node 不 blocked）。
    reads: ['creative_brief', 'world_setting', 'outline', 'episode_outlines', 'asset_cards', 'relationship_graph', 'growth_curve', 'pacing_curve', 'emotion_curve', 'promise_registry'],
    // Story 4.2（ADR-4 双重表示同步——镜像 prompts/multi-review-agent.yaml Reader-Audit rework）：
    // L1 纯代码 stylometry（computeL1SignalReport，soft signal）→ L2 LLM 双层语义裁判。范式判据（ADR-3）：
    // L2 做语义（矛盾/意象/agency），L1 做确定性统计（已落地，节点 DI 注入）。grounding 硬要求（每条 finding
    // 带 quote+location，R3 §1.2）+ 两约束（R6① 永不假 pass / R6② narrative-feature 永不 revise-to-writer）。
    // Story 2.5：加 contract 维（承诺违背）——genreContract artifact（assembleChapterChainArtifacts 注入
    // creative_brief.{commitments,genre_tags} + world_setting.world_constitution）经 review 节点 genreContract
    // templateVar 消费（mirror promise_registry 既有流）。reads 已含 creative_brief / world_setting 无需改。
    // 范式判据（design §4.1）：违背判断归 L2 LLM 语义裁判（砍旧硬 BLOCK 纯代码引擎假信心门）；白名单颠覆
    // execution 不报；severity=block 不强制 escalate（writer 能补写，mirror promise-landing）。
    must: [
      '一致性维按 ConStory 19 子类查语义矛盾 + plot hole（需 entity+因果+常识+ToM，归 LLM）',
      '叙事特征维参考 L1 软信号判骨架偏 AI/人类（意象陈腐/agency/冗余段）',
      '叙事特征维消费 lint_report 静态命中作 L1 软信号（C1.2 llmlint）——静态命中≠定罪，真阳/误报/修复方向由 L2 结合语境判；semantic 8 条规则（hollow-summary-paragraph/hidden-actor/mechanical-elevation-ending/over-explaining-reader/quotable-punchline/register-mismatch/monotone-rhythm/low-specificity）按 yaml 判定任务清单执行',
      '承诺违背维参考 genreContract 判正文是否违背用户定的核心承诺（commitments BLOCK）或世界规则（world_constitution WARN）——违背判断归 LLM 语义，非纯代码规则匹配；颠覆 execution 白名单不报',
      '决策落地维（2.6）参考 decidedDecisions 判 decided 决策是否体现在正文（Decision.unlanded，severity=warn，落地章未到不报；open/superseded/dropped 不进该维）',
      '每条 finding 带 grounding（quote 正文原句 + location 段/句+offset）',
      '永不假 pass / 静默 fail（parse 失败 fallback=escalate；L1 hotspot 逐条回应）',
      '叙事特征维问题 severity=block 走 escalate（discourse 人导演域，绝不 auto_revise 给 writer）',
      '故意惊喜白名单（briefIntent mustHide/hintOnly + gap_whitelist）不误报作者故意 gap',
    ],
    mustNot: [
      'L2 偷做 L1 该做的机械计算（如再算一遍 cliché 密度）',
      'narrative-feature 维问题触发 writer 自动改稿（违反 R6②）',
      '无 grounding 的发现（凭空说「节奏有问题」不引用正文原句）',
      '直接修改内容',
    ],
    outputSchemaName: 'reviewOutputSchema',
    qualityGates: ['has_verdict', 'findings_grounded'],
  },
  // Story 4.0（ADR-17 反馈路由）：route-agent 判 route_decision（auto_revise/accept_as_truth/escalate_user）。
  // ADR-4 双重表示同步——本 CONTRACTS[] 条目镜像 prompts/route-agent.yaml（system 三档判据 + 创作意图优先）。
  //
  // owns/reads 留空：route_decision 是链段临时 artifact（RunSnapshot.artifacts['route_decision']，非持久化
  // 创作字段）——同 draft-writer-agent / multi-review-agent 先例（owns:[]）。AgentContract.owns/reads 类型
  // 约束为 CreativeFieldKey（agentContractSchema），而 route 消费的是链段 artifact key（review.latest /
  // chapter_brief / draft.initial）非创作字段，故语义上 owns/reads 均 []。artifact 级 reads/owns 在节点
  // 契约 ROUTE_CONTRACT（nodes/chapter-nodes.ts，ReusableAgentNodeContract.requiredArtifactKeys /
  // producedArtifactKeys）+ STATE_KEY_MAP（registry.ts，Step 5 装配时加 'route-agent'→'route_decision'）。
  //
  // route 非规则（ADR-17 / ADR-3 假信心门）：不硬编码「某类 verdict→动作」（OOC bug-vs-feature 归 LLM）。
  // must/mustNot 镜像此约束——qualityGates ['has_decision'] 守门 decision 非空。
  {
    id: 'route-agent',
    role: '路由判决',
    goal: '判 route_decision：审核发现走自动改稿 / 接受正文 / 上发用户',
    owns: [],
    reads: [],
    must: [
      '基于审核 verdict + 创作意图（ChapterBrief）+ 正文判 route_decision',
      '按歧义度 + 创作意图判，不硬编码 verdict→action 映射',
    ],
    mustNot: [
      '硬编码「某类 verdict 一律上发 / 一律自动改」（假信心门，ADR-3）',
      '忽略 ChapterBrief 的创作意图（mustHide / doNotWrite / emotionTarget）',
    ],
    outputSchemaName: 'routeDecisionSchema',
    qualityGates: ['has_decision'],
  },
  // 风格卡片 MVP（task 08-28-style-card-mvp A 路）：文风分析派发子 agent（leader 侧
  // dispatch_style_analyzer 工具派发，prompts/style-analyzer-agent.yaml ADR-4 双重表示镜像）。
  // owns/reads 留空 mirror route-agent 先例——产物是自由 markdown 风格卡（14 节，经 setting_md_patch
  // settingId='style' 人审通道落 settings/style.md，非链段 state key / creative field）。
  // outputSchemaName 'styleCardMarkdown' 为自由 markdown 契约名（design 取舍记录：few-shot 本就是
  // 给 LLM 读的，不字段化——V2 TSD 迁移时再结构化），非 Zod schema 引用。
  {
    id: 'style-analyzer-agent',
    role: '风格分析',
    goal: '九遍扫描作者提交的文风片段，产出 14 节风格卡草案（宁缺毋滥）',
    owns: [],
    reads: [],
    must: [
      '每条定性观察三段式：引证「原文」→ 手法归纳 → 祈使句模仿指令（写手视角口吻），无引证不入卡',
      '证据不足的节整节省略，禁止编造引证（宁缺毋滥——最低卡 = 声音画像 + 节选）',
      '第⑬节节选为 800-2000 字连续原文段（最能代表声音），第⑭节附录完整片段',
      '片段正文不足 300 字时只返回「材料不足：<原因与建议>」一行，不产卡',
    ],
    mustNot: [
      '编造、拼贴或转述改写原文引证（引证必须逐字来自材料）',
      '为凑满 14 节而写没有证据的内容',
      '改写、续写片段本身或评判其文学水平（分析「怎么写的」，不评「写得好不好」）',
    ],
    outputSchemaName: 'styleCardMarkdown',
    qualityGates: ['quotes_verbatim', 'voice_portrait_present', 'excerpt_contiguous'],
  },
];

export function getAllAgentContracts(): AgentContract[] {
  return CONTRACTS;
}

export function getAgentContract(id: string): AgentContract | undefined {
  return CONTRACTS.find((c) => c.id === id);
}
