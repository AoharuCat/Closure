import { createHash } from 'node:crypto';

// ── Antigravity CLI 声明式 agent 内容源（09-19 CLI 内置工具白名单 W1，design §1.1）──
//
// 机制（agy 1.2.2 装机定谳；白名单研究报告
// `../09-19-dogfood-round4/research/custom-agent-tool-whitelist.md` + F8 纠正见下）：
//   声明式 agent 默认工具集为空（不写 `tools`），且整体替换默认 system prompt（57 工具
//   脚手架 → agent 正文）。⚠️ 纠正（2026-09-19 F8 真机实证）：空工具集**收窄但未清零**
//   模型侧内置工具面——挂 agent（agent=true、system prompt 已替换、input tokens 腰斩）
//   时内置工具仍可调用、可执行；「出现工具 step ⇒ agent 未加载」不成立（证据：task
//   09-19-agy-toolface-fix-batch research/f8-builtin-tool-stream-signal.md §4/§5）。
//   激活前提 = agent 文件真被加载——1.2.2 只有全局 `~/.gemini/config/agents/` 加载，
//   工作区 `.agents/agents/` 不发现（研究报告 §4）。frontmatter 只写已验证字段（R9）。
//
// 本模块 = 双 agent 内容单一来源：布局常量 + 注册表名单 + 桥 MCP server 名 + 正文常
// 量 + 渲染 + hash 尾标记。协议层管内容，fs 归 shell（W2 假宿模板落盘 / W3 真实全局
// 同意流）——边界保持。
//
// 🔑 自有认定 + 版本检测单源 = 尾标记 `<!-- closure-agent-content-v<版本>:<hash12> -->`
// （hash = frontmatter+正文 的 sha256 前 12 位；当前写入版本 v1）：形态完好（任意版本
// 号）= Closure 写的——版本前向兼容（CR-13）：旧装机文件的历史/未来版本标记仍走自有
// 认定 → 标记 hash ≠ 当前 renderAgentMarkdown 输出的 hash = 陈旧（启动对账重写——内
// 容版本身份比对，无需剥离重算；升级后落重写自愈路径，绝不误判外来冲突）；形态坏/
// 无标记 = 外来文件（冲突态，调用方绝不覆盖/不误删）。

// ═══ 布局常量节（隔离！）═══════════════════════════════════════════════════
//
// ✅ 装机探针已定谳（`../../../../../.trellis/tasks/09-19-cli-builtin-tool-whitelist/
// research/agy-nested-namespace-probe.md`，2026-09-19，agy 1.2.2）：
//   ① 嵌套目录 `agents/closure/text/agent.md` **不发现**（行为级四重负例）→ 按预案
//     回退扁平形态（prd R2 预案分支）；嵌套发现列入 R10 升级重验项。
//   ② `--agent` 激活 = frontmatter `name` 字段**大小写敏感精确匹配**，目录名不参与
//     （fakename/dirnomatch 判别实验）→ agentName 必须与 CLOSURE_*_AGENT frontmatter
//     name 同源同值（本节单一出口保证）。
//   ③ 同 frontmatter name 撞名 = 零警告静默竞速（路径级 foreign 检测罩不住）→ W3
//     状态面补 name 遮蔽扫描（对 `config/agents/*/agent.md` 一层扫描即可——嵌套既
//     不发现，无更深扫描面）。
// 消费方一律经导出符号取值，禁止字面量散落。

/** agy 全局 agent 发现根（相对用户/假宿 home；研究报告 §4 定谳——工作区路径不加载）。 */
export const AGY_GLOBAL_AGENTS_ROOT_SEGMENTS: readonly string[] = [
  '.gemini',
  'config',
  'agents',
];

/** 单个 agent 的落盘布局：`--agent` 激活值 + `~/.gemini/config/agents/` 下相对目录段。 */
export interface AgyAgentLayout {
  /** spawn `--agent` 激活值 = frontmatter `name`（大小写敏感精确匹配，探针定谳②）。 */
  agentName: string;
  /** agent.md 相对落盘目录段（…/<AGY_GLOBAL_AGENTS_ROOT_SEGMENTS>/<dirSegments>/agent.md）。 */
  dirSegments: readonly string[];
}

export const CLOSURE_TEXT_AGENT_LAYOUT: AgyAgentLayout = {
  agentName: 'closure-text',
  dirSegments: ['closure-text'],
};

export const CLOSURE_BRIDGE_AGENT_LAYOUT: AgyAgentLayout = {
  agentName: 'closure-bridge',
  dirSegments: ['closure-bridge'],
};

// ═══ 内置工具注册表（研究报告 §3.1 装机逐一验证名单，逐字取用）══════════════
//
// 本 task 的 agent **不写 `tools` 字段**（默认空工具集——**收窄但未清零**内置工具面，
// 见文件头 F8 纠正；「零错拼风险」指该字段本身不会写错名字）；名单常量为升级回归（R10）
// 与可选形态备用——任何写进 `tools` 的名字必须出自 AGY_BUILTIN_TOOL_REGISTRY（R7）。

/**
 * 声明式 agent `tools:` 可解析名单（44 个；单测与研究报告 §3.1 逐一相等锁死）。
 * ⚠️ 名单锚定 agy 1.2.2——升级后按 R10 回归清单重验增删。
 */
export const AGY_BUILTIN_TOOL_REGISTRY: readonly string[] = [
  'browser_move_mouse',
  'browser_press_key',
  'browser_refresh_page',
  'browser_resize_window',
  'browser_scroll',
  'browser_scroll_dom',
  'browser_select_option',
  'browser_subagent',
  'capture_browser_console_logs',
  'capture_browser_screenshot',
  'click_browser_pixel',
  'command_status',
  'define_subagent',
  'delete_knowledge',
  'execute_browser_javascript',
  'find_by_name',
  'finish',
  'generate_image',
  'grep_search',
  'invoke_subagent',
  'list_browser_pages',
  'list_dir',
  'list_permissions',
  'list_resources',
  'manage_inbox',
  'manage_subagents',
  'manage_task',
  'multi_replace_file_content',
  'notebook_edit',
  'notebook_execution',
  'open_browser_url',
  'read_browser_page',
  'read_resource',
  'read_url_content',
  'replace_file_content',
  'run_command',
  'schedule',
  'search_web',
  'sed_file',
  'send_command_input',
  'send_message',
  'view_file',
  'wait',
  'write_to_file',
];

/**
 * MCP 派发元工具名（agy 内置派发器——模型调用一切 MCP 工具的统一入口，参数为
 * `{ServerName, ToolName, Arguments}` 大写键）。本名单成员之一（「写了必炸」——经 MCP
 * 继承通道注入，与 tools 白名单正交，研究报告 §5）。桥侧另有消费：该名字的工具步是
 * 「模型仍在桥工具族」的证据形态（含参数退化的 ERROR 步——解析不出 ServerName/ToolName
 * 不等于内置工具步；见 bridgeTurn 的 isBuiltinToolStep）。
 */
export const AGY_MCP_DISPATCHER_TOOL_NAME = 'call_mcp_tool';

/**
 * 注册表外「写了必炸」名单（13 个：交互许可 ask_* / 部分浏览器 DOM 高层工具 / MCP
 * 派发元工具 / wait_5_seconds——列出即构造报错 exit 1，零 token）。备查与回归用：
 * `call_mcp_tool` 永不可列（经 MCP 继承通道注入，与 tools 白名单正交——研究报告 §5）。
 */
export const AGY_UNRESOLVABLE_TOOLS: readonly string[] = [
  'ask_custom_permission',
  'ask_permission',
  'ask_question',
  'browser_click_element',
  'browser_drag_pixel_to_pixel',
  'browser_get_dom',
  'browser_get_network_request',
  'browser_input',
  'browser_list_network_requests',
  'browser_mouse_down',
  'browser_mouse_up',
  AGY_MCP_DISPATCHER_TOOL_NAME,
  'wait_5_seconds',
];

// ═══ 共享正文块（双 agent 字面同源常量——改一处双车道同步，杜绝漂移）════════

/** 可露希尔人设（Closure 品牌锚：明日方舟 Closure 干员，罗德岛工程系统负责人）。 */
export const SHARED_PERSONA_BLOCK = [
  '你是 Closure（可露希尔），罗德岛的工程系统负责人，Closure 写作系统的常驻智能体。',
  '性格与口吻：专业干练、逻辑清晰，带一点工程师式的冷幽默；直接给出可用的结果，不用空话和客套铺垫。',
  '你是用户写作工作的协作方，尊重用户对创作方向的决定。',
].join('\n');

/**
 * 网文语境纪律（语境 = 中文商业向连载网文；零古典例——项目 memory 纪律「网文语境
 * 纪律」）。双 agent 共用：纯文本直出与桥面章节写作同属网文生产链。
 */
export const SHARED_WEBNOVEL_DISCIPLINE_BLOCK = [
  '语境纪律：全部工作以中文网络小说（商业向连载通俗小说）为语境。',
  '以当代网文读者的阅读体验为准：重视节奏与爽点、信息差控制、人物欲望驱动和章节末尾的钩子。',
  '不使用文言或古典文学式的表达与例证；涉及写作技法举例时一律取网文语境中的常见形态。',
].join('\n');

// ═══ 桥 MCP server 名（桥 agent 正文插值单源；bridgeTurn 转发导出——import 路径不变）═══
//
// 子4 D4 用户定谳 2026-09-12：写作域自然措辞，不冒充任何官方/第三方组件。W5 起单源落
// 本模块（桥 agent v2 正文的工具纪律段需要插值——CR-24「改名单点生效」纪律延展到
// system 位：桥指令与 agent 正文共用一个插值源，杜绝字面量双写漂移）。
export const BRIDGE_MCP_SERVER_NAME = 'novel-writing';

// ═══ agent 定义（R9 frontmatter 纪律：只写已验证字段 name/description/inheritMcp）═══

export interface AgyAgentDefinition {
  /** frontmatter `name` = `--agent` 激活值（取布局常量，禁止字面量散落）。 */
  name: string;
  /** frontmatter `description`（agy agent 列表可见）。 */
  description: string;
  /**
   * frontmatter `inheritMcp`——唯一允许值 `false`（研究报告 P7 实证：false = MCP 派发
   * 元工具对模型消失）。纯文本 agent 置 false（隔离用户真实 home 可能存在的全局 MCP
   * ——绝对零工具）；桥 agent **禁止**置 false（默认继承 = 桥命脉），即不写该字段。
   */
  inheritMcp?: false;
  /** system prompt 正文（frontmatter 后全部内容）。 */
  body: string;
}

/**
 * 纯文本车道 agent（蒸馏/拆书等 background LLM 调用，F7 事发地）：共享块 + 纯文本
 * 直出车道块（R1/R5 一步到位版）。逐 turn 任务与数据归用户消息（compose.ts 拼装），
 * 此处只立常驻姿态——R5 分工纪律。
 */
export const CLOSURE_TEXT_AGENT: AgyAgentDefinition = {
  name: CLOSURE_TEXT_AGENT_LAYOUT.agentName,
  // CR-11 文案纪律：本串会写进用户全局 `~/.gemini/config/agents/closure-text/agent.md`
  // 并在 `agy agents` 可见。旧文案「零工具，纯文本直出」断言的是已被证伪的工具面事实
  // （F8 真机：不写 `tools` 收窄但**未清零**内置工具面），改按「宁可不写，不写错」：
  // 只描述有实证支撑的机制（`--agent` 加载本文件、正文作为系统提示），工具面一字不写
  // ——「收窄工具面」这类推断同样不写。
  description: 'Closure 纯文本写作车道（蒸馏、拆书等后台写作调用）——以 Closure 写作人设与纯文本直出纪律作为系统提示。',
  inheritMcp: false,
  body: [
    SHARED_PERSONA_BLOCK,
    SHARED_WEBNOVEL_DISCIPLINE_BLOCK,
    [
      '运行方式：你没有配置任何工具，也不要尝试调用或模拟工具。',
      '一切需求以纯文本直接回答：忠实执行用户消息中的写作任务，输出任务要求的文本内容本身，不附加与任务无关的说明。',
    ].join('\n'),
  ].join('\n\n'),
};

/**
 * 桥车道 agent v2（W5：常驻纪律上移完成态；F16：通道分工补正）。🔒 无 inheritMcp（默认
 * 继承 = 桥命脉，P5/P6 实证桥与 tools 白名单正交）、无 tools（R9；列 `call_mcp_tool`
 * 反而构造报错）。
 * 正文 = 共享块 + 桥车道块（novel-writing 工具纪律 + 通道分工 + 推进表述 +
 * present_result 协议常驻段）——常驻纪律归 system、逐 turn 任务与数据归用户消息（R5
 * 分工），与 `BRIDGE_OUTPUT_DIRECTIVE` 瘦身同一波次原子落地（design 权衡 6：协议常驻段
 * 两处同在/同无的窗口期为零）。
 *
 * ⚠️ F16 补正（2026-09-19 真机实证）：旧句「面向用户的最终正文直接以纯文本写出」与同段
 * 「写章…一律使用桥工具族」互相拆台——模型把「写第一章」解成「把第一章正文写在对话里」，
 * 真机 `write_chapter` 零调用、写作页无章节可写（dogfood-round4 findings F16，用户拍板
 * 「应当调写章链」）。改为通道分工句：作品内容（章节正文、改稿结果）一律由对应桥工具产出
 * 并写进作品，纯文本只承担呈现性回复。该句与 `BRIDGE_OUTPUT_DIRECTIVE` **逐字同在**
 * （CR-1 已记录的双写例外延续——降级路径唯一防线，两侧同句共守，改字须两处同步）。
 *
 * 协议段与 `BRIDGE_SENDBACK_MESSAGE` / agent loop.ts 打回文案同义基线（协议措辞家族
 * 三站点，改文案三处同步）。
 */
export const CLOSURE_BRIDGE_AGENT: AgyAgentDefinition = {
  name: CLOSURE_BRIDGE_AGENT_LAYOUT.agentName,
  description: 'Closure 桥车道章节写作会话——写章与改稿的产物由桥工具产出写进作品，对话回复只用于讨论、说明与评审这类呈现性回复。',
  body: [
    SHARED_PERSONA_BLOCK,
    SHARED_WEBNOVEL_DISCIPLINE_BLOCK,
    [
      `运行方式：你在 Closure 的章节写作会话中工作，每轮用户消息携带具体任务，以用户消息为准、忠实执行。写作域需求（写章、改稿、读设定与资料、查故事档案、检索等）一律使用 ${BRIDGE_MCP_SERVER_NAME} 桥提供的工具族（按各工具说明调用）。`,
      '通道分工：章节正文、改稿结果这类作品内容一律由对应桥工具产出并写进作品；对话回复只用于讨论、说明、方案、评审意见、回答用户提问这类呈现性回复。',
      '推进表述：你的修改默认会先呈现给作者、由作者决定是否采纳——尚未采纳的，如实说「已提交、待作者确认」，不表述成已完成。',
      // 呈现纪律句的「呈现性回复文字」限定（09-20 R12 残留措辞，F16 同族）：旧承重词
      // 「正文」可被模型后向推导出「章节正文写在对话里」的旧授权（与上方通道分工句拆台）。
      // 措辞家族四处同步（agent index 侧两处 + agent 包侧两处——bridgeExecutor.ts
      // present_result 覆写 / present-result.ts 工具描述 / workflow.ts interaction
      // 能力段〔后两处 HTTP 车道可见，09-20 check 阶段统一〕），改文案四处同改。
      '呈现纪律：停下向用户呈现结果前，必须先调用 present_result 工具声明这次停是否在等用户确认意图（awaiting_intent_confirmation 参数）；呈现给用户看的呈现性回复文字（讨论/说明/评审等，不含章节正文/改稿产物）写在调用 present_result 的同一条消息里。',
    ].join('\n'),
  ].join('\n\n'),
};

// ═══ 渲染 + 尾标记（自有认定 + 版本检测单源）═══════════════════════════════

/** 尾标记版本串（标记格式变更 = 版本升级；升级时把旧版本号追加进 KNOWN_CONTENT_MARKER_VERSIONS）。 */
const CONTENT_MARKER_VERSION = 'closure-agent-content-v1';

/**
 * 本构建认知的尾标记版本谱系（当前写入版本 + 全部历史版本；现仅 v1）。CR-13 前向兼容
 * 消费契约：自有认定按泛化形态（任意版本号、形态完好即自有——下方 CONTENT_MARKER_RE），
 * 本集合是版本谱系登记 + 升级回归锚点（R10 清单重验项）——bump 写入版本时必须把旧版本
 * 追加进来，保证旧装机文件升级后落「自有·陈旧 → 重写自愈」路径，而非 foreign 冲突
 * （冲突态不覆盖 = 文件永不更新，机制自愈断链）。
 */
export const KNOWN_CONTENT_MARKER_VERSIONS: readonly string[] = ['v1'];

/**
 * 泛化尾标记（任意版本号 + 12 位 hex hash，捕获组 1 = hash）。版本号不进自有认定判据
 * ——形态完好 = Closure 写入（标记格式非公开契约，写入方只可能是 Closure 车道）；
 * hash 非 hex12 / 非标记形态一律不认定（保守：宁可误报冲突也绝不覆盖用户文件）。
 */
const CONTENT_MARKER_RE = /^<!-- closure-agent-content-v(?:\d+):([0-9a-f]{12}) -->$/;

/**
 * YAML 标量输出：布尔裸发；字符串常量均为人写安全形态直接裸发，其余（空串/含冒号
 * 井号/前导特殊符/尾随空白）兜底 JSON 双引号串（JSON 字符串字面量是合法 YAML 双引
 * 号标量）——防未来描述改动踩 YAML 语法。
 */
function yamlScalar(value: string | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // CR-7 fail-fast：标量值禁换行（\n / \r\n）——双引号跨行标量虽是 YAML 合法形态，解析
  // 语义微妙（折叠/转义规则），agy 对坏 frontmatter 静默丢弃 = agent 不加载（fallback
  // 默认 57 工具面）。常量皆静态，渲染期炸（CI/启动即红）远好过产物带坏 YAML 上机。
  if (/\r?\n/.test(value)) {
    const excerpt = value.length > 80 ? `${value.slice(0, 80)}…` : value;
    throw new Error(`agent frontmatter scalar must be single-line, got newline: ${JSON.stringify(excerpt)}`);
  }
  const plain =
    value !== '' &&
    !/[:#]/.test(value) &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/\s$/.test(value);
  return plain ? value : JSON.stringify(value);
}

/** 规范核心文档（frontmatter + 正文）——hash 覆盖面 = 全文除尾标记行外的全部内容。 */
function agentCoreDocument(def: AgyAgentDefinition): string {
  const fmLines = [
    `name: ${yamlScalar(def.name)}`,
    `description: ${yamlScalar(def.description)}`,
  ];
  if (def.inheritMcp !== undefined) {
    fmLines.push(`inheritMcp: ${yamlScalar(def.inheritMcp)}`);
  }
  return `---\n${fmLines.join('\n')}\n---\n${def.body.trim()}\n`;
}

/** 渲染 agent.md 全文：YAML frontmatter + 正文 + 尾标记行（hash12 覆盖 frontmatter+正文）。 */
export function renderAgentMarkdown(def: AgyAgentDefinition): string {
  const core = agentCoreDocument(def);
  const hash = createHash('sha256').update(core, 'utf8').digest('hex').slice(0, 12);
  return `${core}<!-- ${CONTENT_MARKER_VERSION}:${hash} -->\n`;
}

/**
 * 自有认定：文末非空行须恰为尾标记行（容文件尾空行差异；标记后另有内容 = 不认定，
 * 保守——宁可误报冲突也绝不覆盖/误删用户文件）。外来文件（无标记）→ false。
 */
export function isClosureAgentFile(text: string): boolean {
  return closureAgentContentHash(text) !== undefined;
}

/**
 * 提取尾标记 hash12（无标记 → undefined）。陈旧判定 = 此值 ≠ 当前 renderAgentMarkdown
 * 输出的尾标记 hash（内容版本身份比对——标记 hash 记录写入时的内容版本，无需剥离重算）。
 */
export function closureAgentContentHash(text: string): string | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue; // 容忍文件尾空行
    return CONTENT_MARKER_RE.exec(lines[i].trim())?.[1];
  }
  return undefined;
}
